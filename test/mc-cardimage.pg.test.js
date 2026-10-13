/* Catalog card image for grouped pages (2026-10-12) — the database half, in a REAL Postgres: Release A, B gate 1, D,
   the content-approval file, then supabase/mc_release_d2_card_image.sql twice, and checks:
     · the file applies twice, changes no row, and its check reads ok on every row (Rule 19 included);
     · a publication writes the approved card image (a live copy, or "none"); a draft or outside card image refuses the
       whole publication and changes nothing; an approval that names no card image leaves the column as it is;
     · rollback restores card_image with the rest of the row; nothing else can write it (no decision, the window, anon).
   Needs psql and a server; skipped when there is none. */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mcc_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres to test the card-image SQL against (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f), T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const q = sql => run(DB, sql);
const hdr = h => h ? `select set_config('request.headers', '${JSON.stringify(h)}', true);` : '';
const asRole = (role, sql, h) => `begin; set local role ${role}; ${hdr(h)} ${sql}; rollback;`;
const blocked = (sql, h, re) => { try { q(asRole('service_role', sql, h)); } catch (e) { assert.ok((re || /line_frozen/).test(e.message), e.message); return; } throw new Error('NOT blocked: ' + sql + ' ' + JSON.stringify(h || {})); };
const commit = (sql, h) => q(`begin; set local role service_role; ${hdr(h)} ${sql}; commit;`);
const svc = sql => q(`begin; set local role service_role; ${sql}; commit;`);
const WIN = id => ({ 'x-hcps-enrichment-window': String(id) });
const HOST = 'https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-content/';
const DRAFT = (w, f) => `${HOST}bemis/drafts/w${w}/${f}`;
const LIVE = f => `${HOST}bemis/live/${f}`;
const SNAP = `select md5(string_agg(t::text,'|' order by t::text)) from (
  select to_jsonb(p) t from product_skus p union all select to_jsonb(o) from product_overrides o union all select to_jsonb(c) from custom_products c
  union all select to_jsonb(m) from manufacturer_meta m union all select to_jsonb(pc) from product_content pc union all select to_jsonb(s) from product_content_sources s
  union all select to_jsonb(d) from mfr_decisions d) x`;
const CONTENT = ['card_image', 'name', 'tagline', 'description', 'features', 'clinical_applications', 'specs', 'billing_codes', 'sizing_table', 'sizing_note', 'warranty', 'documents', 'videos', 'source_url', 'category', 'subcategory', 'options', 'field_provenance'];
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, T('mc-guard.stub.sql')); file(DB, ROOTF('migrate-phase2-product-skus.sql')); file(DB, T('mc-guard.data.sql')); file(DB, T('mc-content.stub.sql'));
  /* the production columns the miniature leaves out */
  q(`alter table product_content add column if not exists reviewed_by text, add column if not exists clinical_applications jsonb not null default '[]'::jsonb,
     add column if not exists billing_codes jsonb not null default '[]'::jsonb, add column if not exists sizing_table jsonb, add column if not exists sizing_note text,
     add column if not exists documents jsonb not null default '[]'::jsonb, add column if not exists videos jsonb not null default '[]'::jsonb`);
  file(DB, SB('mc_phase1_foundation.sql')); file(DB, SB('mc_phase1_backfill.sql')); file(DB, SB('mc_phase2_freeze_guard.sql')); file(DB, SB('mc_phase6_append_only.sql'));
  file(DB, SB('mc_release_a_content_freeze.sql')); file(DB, SB('mc_release_b_draft_media.sql')); file(DB, SB('mc_release_d_publication.sql'));
  file(DB, SB('mc_release_d1_content_approval.sql'));
  t('the card-image file applies after the content-approval file, and applies again; its check reads ok on every row; no row changes', () => {
    const F = process.env.MC_D2_SQL || SB('mc_release_d2_card_image.sql'); file(DB, F); const out = file(DB, F);
    const rows = out.split('\n').filter(Boolean).map(l => l.split('|'));
    assert.ok(rows.length >= 9 + 4 * 28, 'check rows: ' + rows.length);
    assert.deepStrictEqual(rows.filter(r => r[r.length - 1] !== 't'), []);
    assert.strictEqual(q(`select count(*) from product_content where card_image is not null`), '0');
  });
  let win, before, beforeHeld;
  const approve = (hash, pages, after) => {
    const bef = `jsonb_build_object(${pages.map(k => `'${k}', (select to_jsonb(pc) from product_content pc where manufacturer='bemis' and page_key='${k}')`).join(',')})`;
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by,hcps_value) values ('bemis','publication','content_publication','Approve & Publish Bemis','Angelo',
       jsonb_build_object('plan_hash','${hash}','pages','${JSON.stringify(pages)}'::jsonb,'before',${bef},'after','${JSON.stringify(Object.fromEntries(pages.map(k => [k, after]))).replace(/'/g, "''")}'::jsonb))`);
    return q(`select max(id) from mfr_decisions where kind='content_publication'`);
  };
  const PHOTOS = { image: null, images_gallery: [], skus: [{ sku: '7YR05310TSS', size: 'Round' }, { sku: '7YE05310TSS', size: 'Elongated', image: LIVE('ready1/aaaa.jpg') }] };
  /* the President's selections: title edited, description kept as today (empty → the storefront shows today's copy), features taken
     from the proposal, specs kept, warranty edited, documents kept, subcategory taken, provenance recorded */
  const APPROVED = Object.assign({}, PHOTOS, { name: 'Assurance Raised Toilet Seat, 3"', tagline: null, description: null, features: ['Clean Shield', 'Never loosens'],
    clinical_applications: [], specs: [], billing_codes: [], sizing_table: [], sizing_note: null, warranty: 'Lifetime limited (edited by the President)', documents: [], videos: [],
    source_url: null, category: 'Bath Safety', subcategory: 'Toilet Seats', options: {},
    field_provenance: { description: { source: 'https://www.toiletseats.com/p/x' }, president_approval: { title: { choice: 'edit', decision: 9001 }, description: { choice: 'keep_current', decision: 9002 } } } });
  t('setup: a hidden Ready draft (proposed copy, draft photos) and a held draft under the Bemis window', () => {
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','enrichment_window','enrichment_window','Bemis product pages','Angelo')`);
    win = q(`select id from mfr_decisions where kind='enrichment_window' and manufacturer='bemis' and used_at is null`);
    commit(`insert into product_content(manufacturer,page_key,name,status,description,features,specs,warranty,documents,videos,source_url,subcategory,field_provenance,image,images_gallery,skus) values
      ('bemis','ready1','Assurance Raised Toilet Seat with Clean Shield','pending_review','Proposed copy from the manufacturer page','["Proposed feature 1","Proposed feature 2"]',
       '[{"label":"Weight capacity","value":"300 lb"}]','Proposed warranty','[{"url":"https://www.toiletseats.com/x.pdf","label":"Guide"}]','["https://youtu.be/x"]','https://www.toiletseats.com/p/x','Toilet Seats',
       '{"description":{"source":"https://www.toiletseats.com/p/x"}}',
       '${DRAFT(win, 'ready1/rehost/1-a.jpg')}','[{"url":"${DRAFT(win, 'ready1/rehost/1-a.jpg')}","primary":true}]',
       '[{"sku":"7YR05310TSS","size":"Round","name":"Proposed Round name","image":"${DRAFT(win, 'ready1/rehost/3-c.jpg')}"},{"sku":"7YE05310TSS","size":"Elongated","image":"${DRAFT(win, 'ready1/rehost/1-a.jpg')}"}]'),
      ('bemis','held1','Steadfast','pending_review','Held draft copy — never dealer-visible','[]','[]',null,'[]','[]',null,null,null,
       '${DRAFT(win, 'held1/rehost/1-s.jpg')}','[]','[{"sku":"7YE82350TC"}]')`, WIN(win));
    before = q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`);
    beforeHeld = q(`select to_jsonb(pc) from product_content pc where page_key='held1'`);
    assert.strictEqual(q(`select count(*) from product_content where manufacturer='bemis' and draft_window=${win}`), '2');
  });
  t('a draft or outside card image refuses the whole publication; nothing changes', () => {
    const snapRow = q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`);
    for (const bad of [DRAFT(win, 'ready1/rehost/3-c.jpg'), 'https://www.toiletseats.com/assets/R85320TSS-000-F.jpg', '/assets/products/bemis/7YR05310TSS.jpg']) {
      const d = approve('h-bad-' + bad.length, ['ready1'], Object.assign({}, APPROVED, { card_image: bad }));
      assert.throws(() => svc(`select mfr_content_publish(${d}, 'h-bad-${bad.length}', 'Angelo')`), /not a live copy/, bad);
    }
    assert.strictEqual(q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`), snapRow);
  });
  let dec;
  t('the approved card image is written with the publication (a live copy) and anon reads it; rollback restores it to nothing', () => {
    dec = approve('h-card', ['ready1'], Object.assign({}, APPROVED, { card_image: LIVE('ready1/cccc.jpg') }));
    svc(`select mfr_content_publish(${dec}, 'h-card', 'Angelo')`);
    assert.strictEqual(q(`select card_image from product_content where page_key='ready1'`), LIVE('ready1/cccc.jpg'));
    assert.strictEqual(q(`begin; set local role anon; select card_image from product_content where manufacturer='bemis'; rollback;`).split('\n').filter(Boolean).pop(), LIVE('ready1/cccc.jpg'));
    blocked(`update product_content set card_image='none' where manufacturer='bemis' and page_key='ready1'`);
    blocked(`update product_content set card_image='none' where manufacturer='bemis' and page_key='ready1'`, WIN(win));
    svc(`select mfr_content_publication_rollback(${dec}, 'Angelo')`);
    const row = JSON.parse(q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`)), bef = JSON.parse(before);
    for (const k of CONTENT.concat(['status', 'draft_window', 'image', 'images_gallery', 'skus'])) assert.deepStrictEqual(row[k], bef[k], k);
    assert.strictEqual(row.card_image, null);
  });
  t('"none" is a valid card image (no photo); an approval that names no card image leaves the column as it is', () => {
    const d = approve('h-none', ['ready1'], Object.assign({}, APPROVED, { card_image: 'none' }));
    svc(`select mfr_content_publish(${d}, 'h-none', 'Angelo')`);
    assert.strictEqual(q(`select card_image from product_content where page_key='ready1'`), 'none');
    svc(`select mfr_content_publication_rollback(${d}, 'Angelo')`);
    const plain = Object.assign({}, APPROVED); delete plain.card_image;
    const d2 = approve('h-plain', ['ready1'], plain);
    svc(`select mfr_content_publish(${d2}, 'h-plain', 'Angelo')`);
    assert.strictEqual(q(`select coalesce(card_image,'(null)') from product_content where page_key='ready1'`), '(null)');
    svc(`select mfr_content_publication_rollback(${d2}, 'Angelo')`);
  });
} finally {
  try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
}
console.log(`mc sql (card image): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

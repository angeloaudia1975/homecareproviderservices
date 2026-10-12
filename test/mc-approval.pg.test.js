/* Approve Content & Images (2026-10-12) — the database half, in a REAL Postgres. Builds the project in miniature (as
   test/mc-publication.pg.test.js does), applies Release A, B gate 1, Release D, then
   supabase/mc_release_d1_content_approval.sql twice, and checks:
     · the file applies twice, changes no row, and its check reads ok on every row (Rule 19 included);
     · the decision kind content_approval is accepted (append-only like every decision); an unknown kind still is not;
     · a publication now writes the APPROVED content (keep current = empty → the storefront shows today's copy; an edit
       → the edited text) together with the live photos, in the same single transaction, and nothing else on the row;
     · an approval recorded before today (no content keys) publishes exactly as Release D did — content untouched;
     · a refused publication (a page changed after the dry run, a draft photo) changes nothing, content included;
     · rollback restores the content fields too — the page is exactly its "before" row again;
     · nothing else can write a published page's content (no decision, the window, anon). Needs psql and a server. */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mca_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres to test the content-approval SQL against (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
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
const CONTENT = ['name', 'tagline', 'description', 'features', 'clinical_applications', 'specs', 'billing_codes', 'sizing_table', 'sizing_note', 'warranty', 'documents', 'videos', 'source_url', 'category', 'subcategory', 'options', 'field_provenance'];
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, T('mc-guard.stub.sql')); file(DB, ROOTF('migrate-phase2-product-skus.sql')); file(DB, T('mc-guard.data.sql')); file(DB, T('mc-content.stub.sql'));
  /* the production columns the miniature leaves out */
  q(`alter table product_content add column if not exists reviewed_by text, add column if not exists clinical_applications jsonb not null default '[]'::jsonb,
     add column if not exists billing_codes jsonb not null default '[]'::jsonb, add column if not exists sizing_table jsonb, add column if not exists sizing_note text,
     add column if not exists documents jsonb not null default '[]'::jsonb, add column if not exists videos jsonb not null default '[]'::jsonb`);
  file(DB, SB('mc_phase1_foundation.sql')); file(DB, SB('mc_phase1_backfill.sql')); file(DB, SB('mc_phase2_freeze_guard.sql')); file(DB, SB('mc_phase6_append_only.sql'));
  file(DB, SB('mc_release_a_content_freeze.sql')); file(DB, SB('mc_release_b_draft_media.sql')); file(DB, SB('mc_release_d_publication.sql'));
  t('the content-approval file applies after Release D, and applies again; its check reads ok on every row; no row changes', () => {
    const before = q(SNAP);
    const F = process.env.MC_D1_SQL || SB('mc_release_d1_content_approval.sql'); file(DB, F); const out = file(DB, F);
    const rows = out.split('\n').filter(Boolean).map(l => l.split('|'));
    assert.ok(rows.length >= 9 + 4 * 28, 'check rows: ' + rows.length);
    assert.deepStrictEqual(rows.filter(r => r[r.length - 1] !== 't'), []);
    assert.strictEqual(q(SNAP), before, 'no row changed');
  });
  t('content_approval is a decision kind (append-only: no edit, no delete); an unknown kind is still refused', () => {
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by,hcps_value) values ('bemis','page:ready1','content_approval','Content approval: Assist · description → keep current','Angelo','{"area":"description","choice":"keep_current"}'::jsonb)`);
    const id = q(`select max(id) from mfr_decisions where kind='content_approval'`);
    assert.throws(() => q(`update mfr_decisions set hcps_value='{"area":"description","choice":"use_proposed"}'::jsonb where id=${id}`), /append|not allowed|immutable|refused/i);
    assert.throws(() => q(`delete from mfr_decisions where id=${id}`), /append|not allowed|immutable|refused/i);
    assert.throws(() => q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','x','content_guess','x','x')`), /mfr_decisions_kind_check/);
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
  t('a refused publication changes nothing, content included (draft photo still named; page changed after the dry run)', () => {
    const snap = q(SNAP);
    const bad = JSON.parse(JSON.stringify(APPROVED)); bad.skus[0].image = DRAFT(win, 'ready1/rehost/3-c.jpg');
    const d1 = approve('h-bad', ['ready1'], bad); assert.throws(() => svc(`select mfr_content_publish(${d1}, 'h-bad', 'Angelo')`), /not a live copy/);
    const d2 = approve('h-chg', ['ready1'], APPROVED);
    commit(`update product_content set description='Edited after the dry run' where manufacturer='bemis' and page_key='ready1'`, WIN(win));
    assert.throws(() => svc(`select mfr_content_publish(${d2}, 'h-chg', 'Angelo')`), /changed after the dry run/);
    commit(`update product_content set description='Proposed copy from the manufacturer page' where manufacturer='bemis' and page_key='ready1'`, WIN(win));
    before = q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`);
    const row = JSON.parse(before);
    assert.deepStrictEqual([row.status, row.name, row.description, row.warranty], ['pending_review', 'Assurance Raised Toilet Seat with Clean Shield', 'Proposed copy from the manufacturer page', 'Proposed warranty']);
    assert.notStrictEqual(q(SNAP), snap, '(only the approval rows and the restored edit)');
  });
  let dec;
  t('the approved publication writes the APPROVED content with the live photos, atomically: kept areas empty (today\'s copy shows), edits as typed, proposals taken as chosen', () => {
    dec = approve('h-ok', ['ready1'], APPROVED);
    const r = JSON.parse(svc(`select mfr_content_publish(${dec}, 'h-ok', 'Angelo')`).split('\n').pop()); assert.deepStrictEqual([r.ok, r.published], [true, 1]);
    const row = JSON.parse(q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`));
    for (const k of CONTENT) assert.deepStrictEqual(row[k], APPROVED[k] === undefined ? null : APPROVED[k], k);
    assert.deepStrictEqual([row.status, row.disabled, row.draft_window, row.image], ['published', false, null, null]);
    assert.deepStrictEqual(row.skus, APPROVED.skus, 'the proposed option name is gone (kept as today), photos as approved');
    assert.ok(!/Proposed copy|Proposed warranty|Proposed feature|Weight capacity|youtu|x\.pdf/.test(JSON.stringify([row.description, row.warranty, row.features, row.specs, row.documents, row.videos])), 'nothing the President did not choose');
    assert.ok(!/\/drafts\//.test(JSON.stringify([row.image, row.images_gallery, row.skus])), 'no draft photo');
    assert.strictEqual(q(`select to_jsonb(pc) from product_content pc where page_key='held1'`), beforeHeld, 'the held draft is untouched');
    assert.strictEqual(q(`begin; set local role anon; select string_agg(page_key||':'||coalesce(description,'(today''s copy)'), ',') from product_content where manufacturer='bemis'; rollback;`).split('\n').filter(Boolean).pop(), "ready1:(today's copy)");
  });
  t('nothing else can write the published page\'s content: no decision, the window, a spent approval, anon', () => {
    blocked(`update product_content set description='x' where manufacturer='bemis' and page_key='ready1'`);
    blocked(`update product_content set features='["x"]' where manufacturer='bemis' and page_key='ready1'`, WIN(win));
    assert.throws(() => svc(`select mfr_content_publish(${dec}, 'h-ok', 'Angelo')`), /already spent/);
    assert.throws(() => q(`begin; set local role anon; select mfr_content_publish(${dec}, 'h-ok', 'x'); rollback;`), /permission denied/);
    assert.throws(() => q(`begin; set local role anon; select mfr_approved_content('{}'::jsonb); rollback;`), /permission denied/);
  });
  t('rollback restores the content fields too: the page is exactly its "before" row (hidden, proposed draft copy, draft photos, the window stamp)', () => {
    svc(`select mfr_content_publication_rollback(${dec}, 'Angelo')`);
    const row = JSON.parse(q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`)), bef = JSON.parse(before);
    for (const k of CONTENT.concat(['status', 'disabled', 'draft_window', 'image', 'images_gallery', 'skus', 'published_at', 'reviewed_by'])) assert.deepStrictEqual(row[k], bef[k], k);
    const strip = o => { const x = Object.assign({}, o); delete x.updated_at; return x; };
    assert.deepStrictEqual(strip(row), strip(bef), 'every column but the timestamp');
  });
  t('an approval recorded before today (photos only, no content keys) publishes exactly as Release D did: the content is left as it is', () => {
    const d = approve('h-v1', ['ready1'], { image: LIVE('ready1/aaaa.jpg'), images_gallery: [{ url: LIVE('ready1/aaaa.jpg'), primary: true }], skus: PHOTOS.skus });
    svc(`select mfr_content_publish(${d}, 'h-v1', 'Angelo')`);
    const row = JSON.parse(q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`)), bef = JSON.parse(before);
    for (const k of CONTENT) assert.deepStrictEqual(row[k], bef[k], k + ' untouched');
    assert.strictEqual(row.status, 'published');
    svc(`select mfr_content_publication_rollback(${d}, 'Angelo')`);
  });
} finally {
  try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
}
console.log(`mc sql (content approval): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

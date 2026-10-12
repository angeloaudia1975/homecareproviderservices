/* Manufacturer Center Release D — atomic, scoped publication, run in a REAL Postgres. Builds the project in miniature
   (as test/mc-draft-media.pg.test.js does), applies Release A and Release B gate 1, then
   supabase/mc_release_d_publication.sql twice, and checks:
     · the file applies twice, changes no row, and its check reads ok on every row (Rule 19 included);
     · the self-test reads as expected (Release B's attempts, plus adoption and publication-scope attempts);
     · mfr_content_publish publishes EXACTLY the approved pages in one transaction — refused for a wrong plan hash,
       a page changed after the dry run, a draft-folder or outside image, another line's approval, a spent approval;
       a held page is never touched; the published page carries no draft_window and only live images; anon reads it;
     · nothing else can publish or edit the published page (no decision, a window, another approval);
     · rollback restores the "before" rows exactly (hidden again, draft images, the window stamp) and is refused once a
       passing verification run has recorded the publication as the Gold Standard;
     · a closed window's hidden draft can be adopted by the line's next window; a live page and a hidden page no
       window built still cannot. Needs psql and a server; skipped when there is none. */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mcd_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres to test the Release D publication SQL against (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
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
  union all select to_jsonb(md) from product_media md union all select to_jsonb(l) from product_links l union all select to_jsonb(r) from product_related r
  union all select to_jsonb(d) from mfr_decisions d) x`;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, T('mc-guard.stub.sql')); file(DB, ROOTF('migrate-phase2-product-skus.sql')); file(DB, T('mc-guard.data.sql')); file(DB, T('mc-content.stub.sql'));
  file(DB, SB('mc_phase1_foundation.sql')); file(DB, SB('mc_phase1_backfill.sql')); file(DB, SB('mc_phase2_freeze_guard.sql')); file(DB, SB('mc_phase6_append_only.sql'));
  file(DB, SB('mc_release_a_content_freeze.sql')); file(DB, SB('mc_release_b_draft_media.sql'));
  q(`alter table product_content add column if not exists reviewed_by text`);
  t('Release D applies after Release B, and applies again; its check reads ok on every row; no row changes', () => {
    const before = q(SNAP);
    const DSQL = process.env.MC_D_SQL || SB('mc_release_d_publication.sql'); file(DB, DSQL); const out = file(DB, DSQL);
    const rows = out.split('\n').filter(Boolean).map(l => l.split('|'));
    assert.ok(rows.length >= 8 + 7 + 4 * 28, 'check rows: ' + rows.length);
    assert.deepStrictEqual(rows.filter(r => r[r.length - 1] !== 't'), []);
    assert.strictEqual(q(SNAP), before, 'no row changed');
  });
  t('the self-test (28 attempts per frozen line) reads as expected and changes nothing', () => {
    const b = q(SNAP); const res = JSON.parse(q('select public.mfr_content_guard_selftest()'));
    assert.strictEqual(res.length, 4 * 28);
    assert.deepStrictEqual(res.filter(r => r.result !== r.expect && r.result !== 'nothing to try'), []);
    for (const l of ['bemis', 'climbing-steps', 'ovation-medical', 'strongback-mobility']) {
      assert.strictEqual(res.find(r => r.line === l && /adopt a hidden draft/.test(r.attempt)).result, 'allowed', l + ' adoption');
      assert.strictEqual(res.find(r => r.line === l && /approval does not name/.test(r.attempt)).result, l === 'bemis' ? 'nothing to try' : 'blocked', l + ' publication scope (Bemis has no page here yet)');
    }
    assert.strictEqual(q(SNAP), b);
  });
  let win, before, dec;
  const approve = (hash, pages, after, extra) => {
    const bef = `jsonb_build_object(${pages.map(k => `'${k}', (select to_jsonb(pc) from product_content pc where manufacturer='bemis' and page_key='${k}')`).join(',')})`;
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by,hcps_value) values ('${(extra && extra.line) || 'bemis'}','publication','content_publication','Approve & Publish Bemis','Angelo',
       jsonb_build_object('plan_hash','${hash}','pages','${JSON.stringify(pages)}'::jsonb,'before',${bef},'after','${JSON.stringify(after)}'::jsonb))`);
    return q(`select max(id) from mfr_decisions where kind='content_publication'`);
  };
  const AFTER = { ready1: { image: LIVE('ready1/aaaa.jpg'), images_gallery: [{ url: LIVE('ready1/aaaa.jpg'), primary: true }, { url: LIVE('ready1/bbbb.jpg'), primary: false }],
    skus: [{ sku: '7YR05310TSS', size: 'Round', image: LIVE('ready1/cccc.jpg') }, { sku: '7YE05310TSS', size: 'Elongated', image: LIVE('ready1/aaaa.jpg') }] } };
  t('setup: two hidden drafts built under the Bemis window (one Ready, one held), with draft-folder photos', () => {
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','enrichment_window','enrichment_window','Bemis product pages','Angelo')`);
    win = q(`select id from mfr_decisions where kind='enrichment_window' and manufacturer='bemis' and used_at is null`);
    commit(`insert into product_content(manufacturer,page_key,name,status,description,image,images_gallery,skus) values
      ('bemis','ready1','Assurance','pending_review','Ready copy','${DRAFT(win, 'ready1/rehost/1-a.jpg')}','[{"url":"${DRAFT(win, 'ready1/rehost/1-a.jpg')}","primary":true},{"url":"${DRAFT(win, 'ready1/rehost/2-b.jpg')}","primary":false}]',
       '[{"sku":"7YR05310TSS","size":"Round","image":"${DRAFT(win, 'ready1/rehost/3-c.jpg')}"},{"sku":"7YE05310TSS","size":"Elongated","image":"${DRAFT(win, 'ready1/rehost/4-a.jpg')}"}]'),
      ('bemis','held1','Steadfast','pending_review','Held draft copy — never dealer-visible','${DRAFT(win, 'held1/rehost/1-s.jpg')}','[]','[{"sku":"7YE82350TC"}]')`, WIN(win));
    before = q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`);
    assert.strictEqual(q(`select count(*) from product_content where manufacturer='bemis' and draft_window=${win}`), '2');
  });
  t('refused, and nothing changes: a wrong plan hash; another line\'s approval; an image still in the draft folder; an outside image', () => {
    const snap = q(SNAP);
    dec = approve('hash-1', ['ready1'], AFTER);
    assert.throws(() => svc(`select mfr_content_publish(${dec}, 'hash-2', 'Angelo')`), /plan hash does not match/);
    const draftAfter = JSON.parse(JSON.stringify(AFTER)); draftAfter.ready1.skus[0].image = DRAFT(win, 'ready1/rehost/3-c.jpg');
    const d2 = approve('hash-d', ['ready1'], draftAfter); assert.throws(() => svc(`select mfr_content_publish(${d2}, 'hash-d', 'Angelo')`), /not a live copy/);
    const outAfter = JSON.parse(JSON.stringify(AFTER)); outAfter.ready1.image = 'https://www.toiletseats.com/assets/x.jpg';
    const d3 = approve('hash-o', ['ready1'], outAfter); assert.throws(() => svc(`select mfr_content_publish(${d3}, 'hash-o', 'Angelo')`), /not a live copy/);
    const d4 = approve('hash-x', ['ready1'], AFTER, { line: 'ovation-medical' }); assert.throws(() => svc(`select mfr_content_publish(${d4}, 'hash-x', 'Angelo')`), /no longer exists|changed after/);
    const snap2 = q(SNAP); assert.notStrictEqual(snap2, snap, '(only the approval rows were added)');
    assert.strictEqual(q(`select status||'/'||draft_window from product_content where page_key='ready1'`), 'pending_review/' + win);
  });
  t('a page changed after the dry run refuses the whole publication (the approval is then invalid)', () => {
    const d5 = approve('hash-5', ['ready1'], AFTER);
    commit(`update product_content set description='Edited after the dry run' where manufacturer='bemis' and page_key='ready1'`, WIN(win));
    assert.throws(() => svc(`select mfr_content_publish(${d5}, 'hash-5', 'Angelo')`), /changed after the dry run/);
    assert.strictEqual(q(`select used_at is null from mfr_decisions where id=${d5}`), 't', 'a refused publication spends nothing');
    commit(`update product_content set description='Ready copy' where manufacturer='bemis' and page_key='ready1'`, WIN(win));
    before = q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`);
  });
  t('the approved publication is applied exactly, atomically: the Ready page published with live images only; the held page untouched; the approval spent', () => {
    dec = approve('hash-ok', ['ready1'], AFTER);
    const r = JSON.parse(svc(`select mfr_content_publish(${dec}, 'hash-ok', 'Angelo')`).split('\n').pop());
    assert.deepStrictEqual([r.ok, r.published], [true, 1]);
    const row = JSON.parse(q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`));
    assert.deepStrictEqual([row.status, row.disabled, row.draft_window, row.image], ['published', false, null, AFTER.ready1.image]);
    assert.deepStrictEqual(row.images_gallery, AFTER.ready1.images_gallery); assert.deepStrictEqual(row.skus, AFTER.ready1.skus);
    assert.ok(!/\/drafts\//.test(JSON.stringify(row)), 'no draft-folder link on the published page');
    assert.strictEqual(row.description, 'Ready copy', 'content untouched');
    assert.strictEqual(q(`select status||'/'||draft_window from product_content where page_key='held1'`), 'pending_review/' + win, 'the held page is untouched');
    assert.strictEqual(q(`select used_at is not null from mfr_decisions where id=${dec}`), 't');
    assert.strictEqual(q(`begin; set local role anon; select string_agg(page_key, ',' order by page_key) from product_content where manufacturer='bemis'; rollback;`).split('\n').filter(Boolean).pop(), 'ready1', 'anon reads the published page only');
    assert.strictEqual(q(`select count(*) from product_content where draft_window is not null and status in ('published','active','discontinued')`), '0');
  });
  t('nothing else can publish or change it: a spent approval, no decision, the window, an approval that does not name the page', () => {
    assert.throws(() => svc(`select mfr_content_publish(${dec}, 'hash-ok', 'Angelo')`), /already spent/);
    blocked(`update product_content set description='x' where manufacturer='bemis' and page_key='ready1'`);
    blocked(`update product_content set description='x' where manufacturer='bemis' and page_key='ready1'`, WIN(win));
    blocked(`update product_content set status='published' where manufacturer='bemis' and page_key='held1'`);
    blocked(`update product_content set status='published' where manufacturer='bemis' and page_key='held1'`, WIN(win));
    blocked(`select set_config('hcps.content_publication', '${dec}:rollback', true); update product_content set status='published' where manufacturer='bemis' and page_key='held1'`);
    assert.throws(() => q(`begin; set local role anon; select mfr_content_publish(${dec}, 'hash-ok', 'x'); rollback;`), /permission denied/);
    assert.throws(() => q(`begin; set local role authenticated; select mfr_content_publication_rollback(${dec}, 'x'); rollback;`), /permission denied/);
  });
  t('rollback restores the approved "before" row exactly — hidden again, draft images, the window stamp — and anon reads nothing', () => {
    svc(`select mfr_content_publication_rollback(${dec}, 'Angelo')`);
    const row = JSON.parse(q(`select to_jsonb(pc) from product_content pc where page_key='ready1'`)), bef = JSON.parse(before);
    for (const k of ['status', 'disabled', 'draft_window', 'image', 'images_gallery', 'skus', 'published_at', 'description', 'name']) assert.deepStrictEqual(row[k], bef[k], k);
    assert.strictEqual(q(`begin; set local role anon; select count(*) from product_content where manufacturer='bemis'; rollback;`).split('\n').filter(Boolean).pop(), '0');
    assert.throws(() => svc(`select mfr_content_publish(${dec}, 'hash-ok', 'Angelo')`), /already spent/, 'a rolled-back approval is never reused: a new dry run is needed');
  });
  t('once a passing verification run records the publication as the Gold Standard, rollback is refused', () => {
    const d6 = approve('hash-6', ['ready1'], AFTER); svc(`select mfr_content_publish(${d6}, 'hash-6', 'Angelo')`);
    q(`insert into mfr_verification_runs(manufacturer,phase,result,checks,fingerprint,run_by) values ('bemis','post','pass','[{"id":"publication","pass":true,"detail":{"decision":${d6}}}]'::jsonb,'abc','Angelo')`);
    assert.throws(() => svc(`select mfr_content_publication_rollback(${d6}, 'Angelo')`), /Gold Standard/);
    assert.strictEqual(q(`select status from product_content where page_key='ready1'`), 'published');
  });
  t('a closed window\'s hidden draft is adopted by the line\'s next window (stays hidden, takes the new stamp); a live page and a hidden page no window built still are not', () => {
    q(`update mfr_decisions set used_at=now(), used_by='Angelo' where id=${win}`);
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','enrichment_window','enrichment_window','next window','Angelo')`);
    const w2 = q(`select id from mfr_decisions where kind='enrichment_window' and manufacturer='bemis' and used_at is null`);
    commit(`update product_content set description='Re-enriched from a new Bemis source' where manufacturer='bemis' and page_key='held1'`, WIN(w2));
    assert.strictEqual(q(`select status||'/'||draft_window from product_content where page_key='held1'`), 'pending_review/' + w2);
    blocked(`update product_content set status='published' where manufacturer='bemis' and page_key='held1'`, WIN(w2));
    blocked(`update product_content set description='x' where manufacturer='bemis' and page_key='ready1'`, WIN(w2));
    blocked(`update product_content set name='x' where manufacturer='ovation-medical' and page_key='old'`, WIN(w2));
  });
} finally {
  try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
}
console.log(`mc sql (Release D publication): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

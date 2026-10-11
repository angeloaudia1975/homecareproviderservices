/* Manufacturer Center Release B, gate 1 — draft media under an enrichment window, run in a REAL Postgres.
   Builds the project in miniature exactly as test/mc-content-freeze.pg.test.js does, applies Release A, then
   supabase/mc_release_b_draft_media.sql twice, and checks Angelo's five cases and everything around them:
     1. a draft image on a Bemis hidden draft page (a copy filed under the window) → allowed;
     2. changing the image on a live frozen page → blocked (with and without the window);
     3. the Bemis window used on another line → blocked;
     4. publishing a page or its image through the window → blocked (every visible status, even switched off);
     5. a closed / spent window → blocked;
   plus: product_media stays frozen with no exemption; outside links, catalog photos, another line's or another
   window's folder are refused; a window touches only the drafts it built; drafts stay invisible to the
   storefront's read rule; content_resolution is a decision kind; the self-test reads as expected and changes
   nothing; Rule 19. Needs psql and a server; skipped when there is none. */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mcb_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres to test the Release B draft-media SQL against (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f), T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const q = sql => run(DB, sql);
const hdr = h => h ? `select set_config('request.headers', '${JSON.stringify(h)}', true);` : '';
const asRole = (role, sql, h) => `begin; set local role ${role}; ${hdr(h)} ${sql}; rollback;`;
const blocked = (sql, h, re) => { try { q(asRole('service_role', sql, h)); } catch (e) { assert.ok((re || /line_frozen/).test(e.message), e.message); return; } throw new Error('NOT blocked: ' + sql + ' ' + JSON.stringify(h || {})); };
const allowed = (sql, h) => q(asRole('service_role', sql, h));
const commit = (sql, h) => q(`begin; set local role service_role; ${hdr(h)} ${sql}; commit;`);
const WIN = id => ({ 'x-hcps-enrichment-window': String(id) }), FIX = id => ({ 'x-hcps-regression-fix': String(id) });
const HOST = 'https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-content/';
const DRAFT = (slug, w, f) => `${HOST}${slug}/drafts/w${w}/${f || 'assurance/1700000000000-seat.jpg'}`;
const SNAP = `select md5(string_agg(t::text,'|' order by t::text)) from (
  select to_jsonb(p) t from product_skus p union all select to_jsonb(o) from product_overrides o union all select to_jsonb(c) from custom_products c
  union all select to_jsonb(m) from manufacturer_meta m union all select to_jsonb(pc) from product_content pc union all select to_jsonb(s) from product_content_sources s
  union all select to_jsonb(md) from product_media md union all select to_jsonb(l) from product_links l union all select to_jsonb(r) from product_related r
  union all select to_jsonb(d) from mfr_decisions d) x`;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, T('mc-guard.stub.sql')); file(DB, ROOTF('migrate-phase2-product-skus.sql')); file(DB, T('mc-guard.data.sql')); file(DB, T('mc-content.stub.sql'));
  file(DB, SB('mc_phase1_foundation.sql')); file(DB, SB('mc_phase1_backfill.sql')); file(DB, SB('mc_phase2_freeze_guard.sql')); file(DB, SB('mc_phase6_append_only.sql'));
  file(DB, SB('mc_release_a_content_freeze.sql'));
  let before;
  t('gate 1 applies after Release A, and applies again; its check reads ok on every row; no row changes', () => {
    before = q(SNAP);
    file(DB, SB('mc_release_b_draft_media.sql')); const out = file(DB, SB('mc_release_b_draft_media.sql'));
    const rows = out.split('\n').filter(Boolean).map(l => l.split('|'));
    assert.ok(rows.length >= 8 + 6 + 4 * 25, 'check rows: ' + rows.length);
    const bad = rows.filter(r => r[r.length - 1] !== 't'); assert.deepStrictEqual(bad, []);
    const snapNoCol = q(SNAP);
    assert.notStrictEqual(snapNoCol, '', 'snapshot readable');
    assert.strictEqual(q(`select count(*) from product_content where draft_window is not null`), '0', 'no existing page is stamped');
    assert.strictEqual(q(`select count(*) from pg_trigger where tgname='mfr_content_guard'`), '8');
  });
  t('the self-test changes nothing and reads as expected on every frozen line (25 attempts each)', () => {
    const b = q(SNAP); const res = JSON.parse(q('select public.mfr_content_guard_selftest()'));
    assert.strictEqual(res.length, 4 * 25);
    const off = res.filter(r => r.result !== r.expect && r.result !== 'nothing to try'); assert.deepStrictEqual(off, []);
    assert.deepStrictEqual(res.filter(r => r.result === 'allowed').map(r => r.line + ':' + r.attempt).sort(), ['bemis', 'climbing-steps', 'ovation-medical', 'strongback-mobility']
      .flatMap(l => [l + ':window: add a hidden draft page', l + ':window: draft image on its hidden draft page']).sort());
    assert.deepStrictEqual(res.filter(r => r.result === 'nothing to try').map(r => r.line + ':' + r.attempt).sort(),
      ['bemis:edit a live page', 'bemis:unpublish a live page', 'bemis:window: a hidden page this window did not build', 'bemis:window: change the image on a live page',
       'bemis:window: edit a live page', 'climbing-steps:window: a hidden page this window did not build', 'strongback-mobility:window: a hidden page this window did not build'],
      'Bemis has no live page yet; only Ovation has an older hidden page');
    assert.strictEqual(res.find(r => r.line === 'ovation-medical' && r.attempt === 'window: a hidden page this window did not build').result, 'blocked');
    assert.strictEqual(q(SNAP), b);
    assert.strictEqual(q(`select count(*) from mfr_decisions where kind='enrichment_window'`), '0', 'the windows it opened to test with are gone');
  });
  let win, win2, fix;
  t('setup: Bemis window open (one per line); content_resolution is a decision kind; junk kinds still refused', () => {
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by,hcps_value) values ('bemis','enrichment_window','enrichment_window','Bemis product pages','Angelo','{"scope":"content_drafts"}')`);
    win = q(`select id from mfr_decisions where kind='enrichment_window' and manufacturer='bemis' and used_at is null`);
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by,hcps_value) values ('bemis','page:assurance','content_resolution','keep one photo for both shapes','Angelo','{"issue":"needs_image","choice":"keep_one_photo"}')`);
    assert.throws(() => q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','x','resolution','bad kind','x')`), /mfr_decisions_kind_check/);
    assert.throws(() => q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','enrichment_window','enrichment_window','second','x')`), /mfr_decisions_one_open_window/);
  });
  t('CASE 1 — a draft image on a Bemis hidden draft page (a copy filed under this window) is allowed: primary, gallery, per-SKU, option swatch', () => {
    commit(`insert into product_content(manufacturer,page_key,name,status,skus) values ('bemis','assurance','Assurance Raised Seat','pending_review','[{"sku":"7YR05310TSS"},{"sku":"7YE05310TSS"}]')`, WIN(win));
    assert.strictEqual(q(`select draft_window from product_content where manufacturer='bemis' and page_key='assurance'`), win, 'the guard stamps the window on the draft');
    const u1 = DRAFT('bemis', win), u2 = DRAFT('bemis', win, 'assurance/rehost/1700000000001-elongated.jpg');
    commit(`update product_content set image='${u1}', images_gallery='[{"url":"${u1}","primary":true},{"url":"${u2}","primary":false}]',
            skus='[{"sku":"7YR05310TSS","image":"${u1}"},{"sku":"7YE05310TSS","image":"${u2}","images":["${u2}"]}]', options='{"Shape":[{"label":"Round","image":"${u1}"},{"label":"Elongated","image":"${u2}"}]}',
            description='From the Bemis Assurance page', status='approved' where manufacturer='bemis' and page_key='assurance'`, WIN(win));
    assert.strictEqual(q(`select image from product_content where page_key='assurance'`), u1);
    allowed(`update product_content set images_gallery='[]', image=null where manufacturer='bemis' and page_key='assurance'`, WIN(win));
    allowed(`delete from product_content where manufacturer='bemis' and page_key='assurance'`, WIN(win));
  });
  t('CASE 2 — changing the image on a live frozen page is blocked, with the window and without it, on every line', () => {
    for (const [pk, s] of [['fcom', 'climbing-steps'], ['gen2', 'ovation-medical'], ['sb', 'strongback-mobility']]) {
      blocked(`update product_content set image='${DRAFT(s, win)}' where page_key='${pk}'`);
      blocked(`update product_content set image='${DRAFT('bemis', win)}' where page_key='${pk}'`, WIN(win));
      blocked(`update product_content set images_gallery='[{"url":"${DRAFT('bemis', win)}","primary":true}]' where page_key='${pk}'`, WIN(win));
    }
    blocked(`update product_media set url='${DRAFT('ovation-medical', win)}' where manufacturer='ovation-medical'`, WIN(win));
  });
  t('CASE 3 — the Bemis window used on another line is blocked (drafts, images, sources), and another line\'s window opens nothing on Bemis', () => {
    for (const s of ['climbing-steps', 'ovation-medical', 'strongback-mobility']) {
      blocked(`insert into product_content(manufacturer,page_key,name,status) values ('${s}','draft','x','pending_review')`, WIN(win));
      blocked(`insert into product_content(manufacturer,page_key,name,status,image) values ('${s}','draft','x','pending_review','${DRAFT(s, win)}')`, WIN(win));
      blocked(`insert into product_content_sources(manufacturer,page_key,source) values ('${s}','x','website')`, WIN(win));
    }
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('ovation-medical','enrichment_window','enrichment_window','ovation test window','t')`);
    const ow = q(`select id from mfr_decisions where kind='enrichment_window' and manufacturer='ovation-medical' and used_at is null`);
    blocked(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','p','x','pending_review')`, WIN(ow));
    commit(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','own','x','pending_review')`, WIN(win));
    blocked(`update product_content set name='y' where manufacturer='bemis' and page_key='own'`, WIN(ow));
    blocked(`update product_content set manufacturer='ovation-medical' where manufacturer='bemis' and page_key='own'`, WIN(win));
    q(`update mfr_decisions set used_at=now(), used_by='t' where id=${ow}`);
  });
  t('CASE 4 — publishing a draft page or its image through the window is blocked: every visible status, even switched off', () => {
    const img = DRAFT('bemis', win);
    commit(`insert into product_content(manufacturer,page_key,name,status,image) values ('bemis','pub','x','approved','${img}')`, WIN(win));
    for (const st of ['published', 'active', 'discontinued']) {
      blocked(`update product_content set status='${st}' where manufacturer='bemis' and page_key='pub'`, WIN(win));
      blocked(`update product_content set status='${st}', disabled=true where manufacturer='bemis' and page_key='pub'`, WIN(win), /dealer-visible status/);
      blocked(`insert into product_content(manufacturer,page_key,name,status,image) values ('bemis','p2','x','${st}','${img}')`, WIN(win));
      blocked(`insert into product_content(manufacturer,page_key,name,status,disabled) values ('bemis','p2','x','${st}',true)`, WIN(win), /dealer-visible status/);
    }
    blocked(`update product_content set status='published' where manufacturer='bemis' and page_key='pub'`);
    blocked(`update product_content set disabled=false, status='active' where manufacturer='bemis' and page_key='pub'`, WIN(win));
    assert.strictEqual(q(`select status from product_content where page_key='pub'`), 'approved');
  });
  t('CASE 5 — a closed (spent) window is blocked; a new window cannot edit the old window\'s drafts', () => {
    q(`update mfr_decisions set used_at=now(), used_by='Angelo' where id=${win}`);
    blocked(`update product_content set image='${DRAFT('bemis', win, 'pub/1700000000009-new.jpg')}' where manufacturer='bemis' and page_key='pub'`, WIN(win));
    blocked(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','late','x','pending_review')`, WIN(win));
    blocked(`delete from product_content where manufacturer='bemis' and page_key='pub'`, WIN(win));
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','enrichment_window','enrichment_window','second window','Angelo')`);
    win2 = q(`select id from mfr_decisions where kind='enrichment_window' and manufacturer='bemis' and used_at is null`);
    blocked(`update product_content set name='y' where manufacturer='bemis' and page_key='pub'`, WIN(win2), /did not build|not built/);
    blocked(`update product_content set image='${DRAFT('bemis', win2, 'pub/1700000000010-new.jpg')}' where manufacturer='bemis' and page_key='pub'`, WIN(win2));
    allowed(`insert into product_content(manufacturer,page_key,name,status,image) values ('bemis','new2','x','pending_review','${DRAFT('bemis', win2)}')`, WIN(win2));
  });
  t('only copies filed under this window: outside links, the catalog\'s own photos, another line\'s or window\'s folder, a query string — refused', () => {
    const ins = u => `insert into product_content(manufacturer,page_key,name,status,image) values ('bemis','img','x','pending_review','${u}')`;
    for (const u of ['https://www.toiletseats.com/media/seat.jpg', '/assets/products/bemis/7YR05310TSS.jpg', '//cdn.example.com/a.jpg', 'http://x/a.jpg',
                     DRAFT('ovation-medical', win2), DRAFT('bemis', win), DRAFT('bemis', win2 + '0'), DRAFT('bemis', win2) + '?x=1',
                     HOST.replace('product-content', 'product-images') + 'bemis/drafts/w' + win2 + '/a.jpg', 'https://evil.example/storage/v1/object/public/product-content/bemis/drafts/w' + win2 + '/a.jpg'])
      blocked(ins(u), WIN(win2), /copy in HCPS storage/);
    blocked(`insert into product_content(manufacturer,page_key,name,status,images_gallery) values ('bemis','img','x','pending_review','[{"url":"https://m/x.jpg"}]')`, WIN(win2), /copy in HCPS storage/);
    blocked(`insert into product_content(manufacturer,page_key,name,status,skus) values ('bemis','img','x','pending_review','[{"sku":"7YR05310TSS","images":["https://m/x.jpg"]}]')`, WIN(win2), /copy in HCPS storage/);
    blocked(`insert into product_content(manufacturer,page_key,name,status,options) values ('bemis','img','x','pending_review','{"Color":[{"label":"Gray","image":"https://m/x.jpg"}]}')`, WIN(win2), /copy in HCPS storage/);
    allowed(`insert into product_content(manufacturer,page_key,name,status,options,source_url) values ('bemis','img','x','pending_review','{"Shape":["Round","Elongated"]}','https://www.toiletseats.com/assurance/')`, WIN(win2));
  });
  t('a window never sets draft_window to anything but itself, and touches no page it did not build (Ovation\'s older hidden page)', () => {
    commit(`insert into product_content(manufacturer,page_key,name,status,draft_window) values ('bemis','stamp','x','pending_review',999999)`, WIN(win2));
    assert.strictEqual(q(`select draft_window from product_content where page_key='stamp'`), win2);
    commit(`update product_content set draft_window=null, name='z' where page_key='stamp'`, WIN(win2));
    assert.strictEqual(q(`select draft_window from product_content where page_key='stamp'`), win2);
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('ovation-medical','enrichment_window','enrichment_window','ovation window 2','t')`);
    const ow = q(`select id from mfr_decisions where kind='enrichment_window' and manufacturer='ovation-medical' and used_at is null`);
    blocked(`update product_content set name='y' where page_key='old'`, WIN(ow), /did not build|not built/);
    blocked(`delete from product_content where page_key='old'`, WIN(ow));
    q(`update mfr_decisions set used_at=now(), used_by='t' where id=${ow}`);
  });
  t('still frozen under a window: product_media (no exemption), the catalog layer\'s images, links, related, line settings, everything commercial', () => {
    blocked(`insert into product_media(manufacturer,code,kind,url) values ('bemis','7YR05310TSS','image','${DRAFT('bemis', win2)}')`, WIN(win2));
    blocked(`update product_overrides set patch=patch||'{"image":"${DRAFT('bemis', win2)}"}' where manufacturer='bemis'`, WIN(win2));
    blocked(`update custom_products set image='${DRAFT('bemis', win2)}' where code='444DISPLAY'`, WIN(win2));
    blocked(`insert into product_links(manufacturer,code,url) values ('bemis','7YR05310TSS','https://x')`, WIN(win2));
    blocked(`insert into product_related(manufacturer,code,related_manufacturer,related_code) values ('bemis','7YR05310TSS','bemis','7YA05313GRY')`, WIN(win2));
    blocked(`update manufacturer_meta set logo_url='${DRAFT('bemis', win2)}' where slug='bemis'`, WIN(win2));
    blocked(`update product_skus set base_price=1 where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win2));
    blocked(`update product_skus set case_qty=1, uom='Each' where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win2));
    blocked(`update product_skus set msrp=1, map=1, tiers='[]' where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win2));
    blocked(`update product_skus set status='discontinued' where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win2));
    blocked(`update manufacturer_meta set freight_terms=freight_terms||'{"summary":"x"}' where slug='bemis'`, WIN(win2));
  });
  t('drafts stay invisible: the storefront\'s read rule returns no Bemis page at all; live pages carry no draft_window', () => {
    assert.ok(Number(q(`select count(*) from product_content where manufacturer='bemis'`)) >= 3);
    assert.strictEqual(q(`begin; set local role anon; select count(*) from product_content where manufacturer='bemis'; rollback;`).split('\n').filter(Boolean)[0], '0');
    assert.strictEqual(q(`select count(*) from product_content where draft_window is not null and status in ('published','active','discontinued')`), '0');
  });
  t('a regression_fix still opens any change on its line; an unfrozen line is untouched', () => {
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('ovation-medical','image','regression_fix','fix gallery','t')`);
    fix = q(`select id from mfr_decisions where reason='fix gallery'`);
    allowed(`update product_content set image='https://x/fixed.jpg' where page_key='gen2'`, FIX(fix));
    allowed(`update product_content set image='https://x/p.jpg', status='published' where page_key='p1'`);
    allowed(`insert into product_media(manufacturer,code,kind,url) values ('pedifix','P1','image','https://x/2.jpg')`, WIN(win2));
  });
  t('the guard binds the table owner too (hand-run SQL)', () => {
    assert.throws(() => q(`update product_content set image='x' where page_key='fcom'`), /line_frozen/);
    assert.throws(() => q(`${hdr(WIN(win2))} update product_content set image='x' where page_key='fcom'`), /line_frozen/);
  });
  t('Rule 19: anon / authenticated cannot execute the guard, its image rule or its self-test; product_content grants unchanged', () => {
    assert.strictEqual(q(`select bool_or(has_function_privilege(r, 'public.mfr_content_guard()', 'execute') or has_function_privilege(r, 'public.mfr_content_guard_selftest()', 'execute')
      or has_function_privilege(r, 'public.mfr_draft_media_problem(jsonb, text, bigint)', 'execute')) from unnest(array['anon','authenticated']) r`), 'f');
    assert.strictEqual(q(`select count(*) from pg_policies where tablename='product_content'`), '1');
  });
  t('a missing guard is reported NOT BLOCKED by the self-test (the draft-image rows too), and still nothing changes', () => {
    const b = q(SNAP);
    const out = q(`begin; drop trigger mfr_content_guard on product_content; select public.mfr_content_guard_selftest(); rollback;`).split('\n').filter(l => l.startsWith('['))[0];
    const res = JSON.parse(out);
    for (const a of ['window: draft image from outside HCPS storage', 'window: draft image filed under another window', 'window: publish a draft page with its image', 'window: a closed window', "window: another line's window used here"])
      assert.ok(res.some(r => r.result === 'NOT BLOCKED' && r.attempt === a), a + ': ' + JSON.stringify(res.filter(r => r.attempt === a)));
    assert.strictEqual(q(SNAP), b); assert.strictEqual(q(`select count(*) from pg_trigger where tgname='mfr_content_guard'`), '8');
  });
} finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} }
console.log(`mc sql (Release B gate 1 draft media): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

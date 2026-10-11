/* Manufacturer Center Release A — the content freeze and enrichment windows, run in a REAL Postgres.
   Builds the project in miniature (test/mc-guard.stub.sql, the real migrate-phase2-product-skus.sql,
   test/mc-guard.data.sql, test/mc-content.stub.sql), applies the Manufacturer Center SQL in order —
   mc_phase1_foundation.sql, mc_phase1_backfill.sql, mc_phase2_freeze_guard.sql, mc_phase6_append_only.sql —
   then supabase/mc_release_a_content_freeze.sql twice, and checks:
     · on a frozen line every content write is refused: pages, grouping, content, images and media, links,
       related products, catalog-layer names / categories / images, the line's logo, visibility, listing
       mode and categories, and publish / hidden state;
     · an unfrozen line, and bookkeeping that changes nothing a dealer sees, are untouched;
     · a regression_fix of that line opens any change; an enrichment window opens HIDDEN DRAFTS only —
       never a visible page, never publishing, never the catalog layer, media, links, related or line
       settings, never another line, never once closed — and never anything commercial;
     · drafts stay invisible to the storefront's read rule; one open window per line; a window is closed by
       stamping it once and can't be reopened or deleted;
     · the self-test leaves every row as it was and reports each attempt against what is expected;
     · Rule 19 from anon / authenticated.
   Needs psql and a server; skipped when there is none. */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mca_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres to test the Release A SQL against (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f), T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const q = sql => run(DB, sql);
const hdr = h => h ? `select set_config('request.headers', '${JSON.stringify(h)}', true);` : '';
const asRole = (role, sql, h) => `begin; set local role ${role}; ${hdr(h)} ${sql}; rollback;`;
const blocked = (sql, h, re) => { try { q(asRole('service_role', sql, h)); } catch (e) { assert.ok((re || /line_frozen/).test(e.message), e.message); return; } throw new Error('NOT blocked: ' + sql + ' ' + JSON.stringify(h || {})); };
const allowed = (sql, h) => q(asRole('service_role', sql, h));
const WIN = id => ({ 'x-hcps-enrichment-window': String(id) }), FIX = id => ({ 'x-hcps-regression-fix': String(id) });
const SNAP = `select md5(string_agg(t::text,'|' order by t::text)) from (
  select to_jsonb(p) t from product_skus p union all select to_jsonb(o) from product_overrides o union all select to_jsonb(c) from custom_products c
  union all select to_jsonb(m) from manufacturer_meta m union all select to_jsonb(pc) from product_content pc union all select to_jsonb(s) from product_content_sources s
  union all select to_jsonb(md) from product_media md union all select to_jsonb(l) from product_links l union all select to_jsonb(r) from product_related r
  union all select to_jsonb(d) from mfr_decisions d) x`;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, T('mc-guard.stub.sql')); file(DB, ROOTF('migrate-phase2-product-skus.sql')); file(DB, T('mc-guard.data.sql')); file(DB, T('mc-content.stub.sql'));
  file(DB, SB('mc_phase1_foundation.sql')); file(DB, SB('mc_phase1_backfill.sql')); file(DB, SB('mc_phase2_freeze_guard.sql')); file(DB, SB('mc_phase6_append_only.sql'));
  let before, checkOut;
  t('Release A applies, and applies again; its check reads ok on every row', () => {
    before = q(SNAP);
    file(DB, SB('mc_release_a_content_freeze.sql')); checkOut = file(DB, SB('mc_release_a_content_freeze.sql'));
    const rows = checkOut.split('\n').filter(Boolean).map(l => l.split('|'));
    assert.ok(rows.length >= 8 + 4 + 4 * 16, 'check rows: ' + rows.length);
    const bad = rows.filter(r => r[r.length - 1] !== 't'); assert.deepStrictEqual(bad, []);
    assert.strictEqual(q(SNAP), before, 'applying the file changed no row');
  });
  t('the self-test changes nothing and reads as expected: plain attempts blocked, a window draft allowed, the rest blocked', () => {
    const b = q(SNAP); const res = JSON.parse(q('select public.mfr_content_guard_selftest()'));
    assert.strictEqual(res.length, 4 * 16);
    const off = res.filter(r => r.result !== r.expect && r.result !== 'nothing to try'); assert.deepStrictEqual(off, []);
    assert.deepStrictEqual(res.filter(r => r.result === 'allowed').map(r => r.line).sort(), ['bemis', 'climbing-steps', 'ovation-medical', 'strongback-mobility']);
    assert.deepStrictEqual(res.filter(r => r.result === 'nothing to try').map(r => r.line + ':' + r.attempt).sort(),
      ['bemis:edit a live page', 'bemis:unpublish a live page', 'bemis:window: edit a live page'], 'Bemis has no live page yet');
    assert.strictEqual(q(SNAP), b);
    assert.strictEqual(q(`select count(*) from mfr_decisions where kind='enrichment_window'`), '0', 'the windows it opened to test with are gone');
  });
  t('frozen line: pages — add, edit, regroup, re-image, recategorize, publish, unpublish, hide, delete — all refused', () => {
    blocked(`insert into product_content(manufacturer,page_key,name) values ('bemis','new','x')`);
    blocked(`update product_content set description='changed' where page_key='fcom'`);
    blocked(`update product_content set skus='[{"sku":"FCOM-02"}]' where page_key='fcom'`);
    blocked(`update product_content set image='https://x/new.jpg', images_gallery='[{"url":"https://x/new.jpg","primary":true}]' where page_key='gen2'`);
    blocked(`update product_content set category='Mobility', subcategory='x' where page_key='sb'`);
    blocked(`update product_content set status='published' where page_key='old'`);
    blocked(`update product_content set status='hidden' where page_key='fcom'`);
    blocked(`update product_content set disabled=true where page_key='sb'`);
    blocked(`delete from product_content where page_key='old'`);
    blocked(`update product_content set manufacturer='pedifix' where page_key='fcom'`);
    blocked(`update product_content set manufacturer='bemis' where page_key='p1'`, null);
  });
  t('frozen line: sources, media, links, related products — all refused', () => {
    blocked(`insert into product_content_sources(manufacturer,page_key,source) values ('bemis','x','website')`);
    blocked(`insert into product_media(manufacturer,code,kind,url) values ('bemis','7YR05310TSS','image','https://x/i.jpg')`);
    blocked(`update product_media set sort=5 where manufacturer='ovation-medical'`);
    blocked(`delete from product_media where manufacturer='ovation-medical'`);
    blocked(`insert into product_links(manufacturer,code,url) values ('bemis','7YR05310TSS','https://x')`);
    blocked(`delete from product_links where manufacturer='climbing-steps'`);
    blocked(`insert into product_related(manufacturer,code,related_manufacturer,related_code) values ('ovation-medical','61000-210','pedifix','P1')`);
    blocked(`delete from product_related where manufacturer='strongback-mobility'`);
  });
  t('frozen line: catalog-layer names, images, categories, groups and descriptions — now refused (Phase 2 allowed them)', () => {
    blocked(`update product_overrides set patch=patch||'{"image":"b.jpg"}' where manufacturer='bemis'`);
    blocked(`update product_overrides set patch=patch||'{"name":"x"}' where manufacturer='bemis'`);
    blocked(`update product_overrides set patch=patch||'{"category":"x","group":"g"}' where manufacturer='bemis'`);
    blocked(`insert into product_overrides values ('bemis','7YE82350TC','{"name":"x"}',now())`);
    blocked(`update custom_products set name='Display kit' where code='444DISPLAY'`);
    blocked(`update custom_products set image='x.jpg', category='x', description='y' where code='444DISPLAY'`);
  });
  t('frozen line: logo, visibility, listing mode, category map and order — refused; bookkeeping and freezing still allowed', () => {
    blocked(`update manufacturer_meta set logo_url='x' where slug='bemis'`);
    blocked(`update manufacturer_meta set active=false where slug='ovation-medical'`);
    blocked(`update manufacturer_meta set enriched_only=true where slug='climbing-steps'`);
    blocked(`update manufacturer_meta set category_map='{}' where slug='strongback-mobility'`);
    blocked(`update manufacturer_meta set category_order='["x"]' where slug='bemis'`);
    blocked(`delete from manufacturer_meta where slug='bemis'`);
    allowed(`update manufacturer_meta set record_resync_at=now(), record_resync_error=null, updated_at=now() where slug='bemis'`);
    allowed(`update manufacturer_meta set frozen=true, frozen_at=now(), frozen_reason='t' where slug='pedifix'`);
  });
  t('a write that changes nothing but its timestamp is not a change; an unfrozen line is untouched', () => {
    allowed(`update product_content set updated_at=now() where page_key='fcom'`);
    allowed(`update product_overrides set updated_at=now() where manufacturer='bemis'`);
    allowed(`update product_content set description='edited', status='published' where page_key='p1'`);
    allowed(`insert into product_media(manufacturer,code,kind,url) values ('pedifix','P1','image','https://x/2.jpg')`);
    allowed(`update manufacturer_meta set category_map='{}', logo_url='y', active=false where slug='pedifix'`);
    allowed(`update custom_products set name='y', image='z' where code='P1'`);
  });
  let fix, win, other, spentFix;
  t('regression_fix: an unused fix of this line opens any content change; another line\'s, a spent one or junk does not', () => {
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('ovation-medical','image','regression_fix','fix gallery','t'),
       ('bemis','image','regression_fix','other line','t'),('ovation-medical','x','regression_fix','spent','t')`);
    q(`update mfr_decisions set used_at=now() where reason='spent'`);
    fix = q(`select id from mfr_decisions where reason='fix gallery'`); other = q(`select id from mfr_decisions where reason='other line'`); spentFix = q(`select id from mfr_decisions where reason='spent'`);
    allowed(`update product_content set image='https://x/fixed.jpg' where page_key='gen2'`, FIX(fix));
    allowed(`delete from product_media where manufacturer='ovation-medical'`, FIX(fix));
    allowed(`update manufacturer_meta set category_map='{}' where slug='ovation-medical'`, FIX(fix));
    for (const id of [other, spentFix, 'abc']) blocked(`update product_content set image='https://x/fixed.jpg' where page_key='gen2'`, FIX(id));
  });
  t('a window is its own decision kind; one open window per line', () => {
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by,hcps_value) values ('bemis','enrichment_window','enrichment_window','Bemis product pages','Angelo','{"scope":"content_drafts"}')`);
    win = q(`select id from mfr_decisions where kind='enrichment_window' and manufacturer='bemis'`);
    assert.throws(() => q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','enrichment_window','enrichment_window','second','x')`), /mfr_decisions_one_open_window/);
    assert.throws(() => q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','x','window','bad kind','x')`), /mfr_decisions_kind_check/);
  });
  t('enrichment window: hidden drafts on its own line — create, enrich, regroup, re-image, recategorize, approve, hide, delete', () => {
    allowed(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','assurance','Assurance Raised Seat','pending_review');
             update product_content set description='d', features='["a","b","c"]', specs='[{"label":"Rise","value":"3 in"}]', source_url='https://m/p',
               field_provenance='{"description":"website"}', skus='[{"sku":"7YR05310TSS"},{"sku":"7YE05310TSS"}]', options='{"Shape":["Round","Elongated"]}',
               image='https://hcps/s.jpg', images_gallery='[{"url":"https://hcps/s.jpg","primary":true}]', category='Bath Safety', subcategory='Toilet Seats', status='approved'
             where manufacturer='bemis' and page_key='assurance';
             update product_content set status='hidden' where manufacturer='bemis' and page_key='assurance';
             delete from product_content where manufacturer='bemis' and page_key='assurance'`, WIN(win));
    allowed(`insert into product_content(manufacturer,page_key,name,status,disabled) values ('bemis','d2','x','published',true)`, WIN(win));
    allowed(`insert into product_content_sources(manufacturer,page_key,source,name) values ('bemis','assurance','website','x')`, WIN(win));
  });
  t('enrichment window: never publishes, never touches a visible page, never moves a row between lines', () => {
    blocked(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','p','x','published')`, WIN(win), /hidden draft pages only/);
    blocked(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','p','x','pending_review'); update product_content set status='published' where manufacturer='bemis' and page_key='p'`, WIN(win), /hidden draft pages only/);
    blocked(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','p','x','active')`, WIN(win));
    blocked(`insert into product_content(manufacturer,page_key,name,status,disabled) values ('bemis','p','x','published',true); update product_content set disabled=false where manufacturer='bemis' and page_key='p'`, WIN(win));
    blocked(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','p','x','pending_review'); update product_content set manufacturer='pedifix' where manufacturer='bemis' and page_key='p'`, WIN(win));
  });
  t('enrichment window: never the catalog layer, media, links, related products or the line\'s settings', () => {
    blocked(`update product_overrides set patch=patch||'{"name":"x"}' where manufacturer='bemis'`, WIN(win));
    blocked(`update custom_products set name='x' where code='444DISPLAY'`, WIN(win));
    blocked(`insert into product_media(manufacturer,code,kind,url) values ('bemis','7YR05310TSS','image','https://x/i.jpg')`, WIN(win));
    blocked(`insert into product_links(manufacturer,code,url) values ('bemis','7YR05310TSS','https://x')`, WIN(win));
    blocked(`insert into product_related(manufacturer,code,related_manufacturer,related_code) values ('bemis','7YR05310TSS','bemis','7YA05313GRY')`, WIN(win));
    blocked(`update manufacturer_meta set category_map='{}' where slug='bemis'`, WIN(win));
    blocked(`update manufacturer_meta set enriched_only=true where slug='bemis'`, WIN(win));
  });
  t('enrichment window: never anything commercial — price, tiers, UOM/case qty, MSRP/MAP, status, freight', () => {
    blocked(`update product_skus set base_price=1 where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win));
    blocked(`update product_skus set tiers='[{"min_qty":2,"price":1}]' where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win));
    blocked(`update product_skus set uom='Each', case_qty=1 where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win));
    blocked(`update product_skus set msrp=1, map=1 where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win));
    blocked(`update product_skus set status='discontinued' where manufacturer='bemis' and code='7YR05310TSS'`, WIN(win));
    blocked(`update product_overrides set patch=patch||'{"base_price":1}' where manufacturer='bemis'`, WIN(win));
    blocked(`update manufacturer_meta set freight_terms=freight_terms||'{"summary":"x"}' where slug='bemis'`, WIN(win));
  });
  t('enrichment window: only its own line; Bemis\'s window opens nothing on Climbing Steps, Ovation or Strongback', () => {
    for (const s of ['climbing-steps', 'ovation-medical', 'strongback-mobility'])
      blocked(`insert into product_content(manufacturer,page_key,name,status) values ('${s}','draft','x','pending_review')`, WIN(win));
    blocked(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','p','x','pending_review')`, WIN(fix));
    blocked(`insert into product_content(manufacturer,page_key,name,status) values ('bemis','p','x','pending_review')`, WIN('abc'));
  });
  t('drafts stay invisible: the storefront\'s read rule never returns a hidden draft', () => {
    const vis = () => q(`begin; set local role anon; select count(*) from product_content where manufacturer='bemis'; rollback;`).split('\n').filter(Boolean)[0];
    q(`begin; ${hdr(WIN(win))} insert into product_content(manufacturer,page_key,name,status) values ('bemis','keep1','x','pending_review'),('bemis','keep2','x','approved'),('bemis','keep3','x','hidden'),('bemis','keep4','x','published'); commit;`.replace("('bemis','keep4','x','published')", "('bemis','keep4','x','rejected')"));
    assert.strictEqual(q(`select count(*) from product_content where manufacturer='bemis'`), '4');
    assert.strictEqual(vis(), '0', 'anon sees none of them');
  });
  t('closing a window: stamped once, then it opens nothing; it cannot be reopened or deleted; a new one can then be opened', () => {
    q(`update mfr_decisions set used_at=now(), used_by='Angelo' where id=${win}`);
    blocked(`update product_content set name='y' where manufacturer='bemis' and page_key='keep1'`, WIN(win));
    assert.throws(() => q(`update mfr_decisions set used_at=null where id=${win}`), /append|rewrit|never/i);
    assert.throws(() => q(`delete from mfr_decisions where id=${win}`), /append|rewrit|never/i);
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','enrichment_window','enrichment_window','second window','Angelo')`);
  });
  t('the guard binds the table owner too (hand-run SQL)', () => assert.throws(() => q(`update product_content set name='x' where page_key='fcom'`), /line_frozen/));
  t('Rule 19: anon / authenticated cannot execute the content guard or its self-test', () => {
    assert.strictEqual(q(`select bool_or(has_function_privilege(r, 'public.mfr_content_guard()', 'execute') or has_function_privilege(r, 'public.mfr_content_guard_selftest()', 'execute')) from unnest(array['anon','authenticated']) r`), 'f');
  });
  t('a missing content guard is reported NOT BLOCKED by the self-test, and still nothing changes', () => {
    const b = q(SNAP);
    const out = q(`begin; drop trigger mfr_content_guard on product_media; select public.mfr_content_guard_selftest(); rollback;`).split('\n').filter(l => l.startsWith('['))[0];
    const res = JSON.parse(out);
    assert.ok(res.some(r => r.result === 'NOT BLOCKED' && /gallery image/.test(r.attempt)), JSON.stringify(res.filter(r => r.result !== r.expect)));
    assert.strictEqual(q(SNAP), b); assert.strictEqual(q(`select count(*) from pg_trigger where tgname='mfr_content_guard'`), '8');
  });
} finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} }
console.log(`mc sql (Release A content freeze): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

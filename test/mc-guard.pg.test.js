/* Manufacturer Center Phases 1–2 — the SQL, run in a REAL Postgres:
     supabase/mc_phase1_foundation.sql   (tables, columns, bucket, Rule 19 grants)
     supabase/mc_phase1_backfill.sql     (sources, decisions, bases, freeze, freight trace)
     supabase/mc_phase2_freeze_guard.sql (the freeze guard trigger + its self-test)
   Builds a scratch database shaped like the project (test/mc-guard.stub.sql, the real
   migrate-phase2-product-skus.sql, test/mc-guard.data.sql), applies each file twice, then checks:
   what a frozen line refuses and allows, the regression_fix token, Rule 19 from the anon /
   authenticated roles, the constraints that keep dates and freight honest, and that the self-test
   leaves every row exactly as it was. Needs psql and a server; skipped when there is none. */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mc_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(f + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres to test the Manufacturer Center SQL against (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f), T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const q = sql => run(DB, sql);
const asRole = (role, sql, token) => `begin; set local role ${role}; ${token ? `select set_config('request.headers', '{"x-hcps-regression-fix":"${token}"}', true);` : ''} ${sql}; rollback;`;
const blocked = (sql, token) => { try { q(asRole('service_role', sql, token)); } catch (e) { assert.ok(/line_frozen/.test(e.message), e.message); return; } throw new Error('NOT blocked: ' + sql); };
const allowed = (sql, token) => q(asRole('service_role', sql, token));
const denied = (role, sql) => { try { q(asRole(role, sql)); } catch (e) { assert.ok(/permission denied/.test(e.message), e.message); return; } throw new Error(role + ' was allowed: ' + sql); };
const SNAP = `select md5(string_agg(t::text,'|' order by t::text)) from (select to_jsonb(p) t from product_skus p union all select to_jsonb(o) from product_overrides o
  union all select to_jsonb(c) from custom_products c union all select to_jsonb(m) from manufacturer_meta m) x`;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  file(DB, T('mc-guard.stub.sql')); file(DB, ROOTF('migrate-phase2-product-skus.sql')); file(DB, T('mc-guard.data.sql'));
  t('phase 1 foundation applies, and applies again', () => { file(DB, SB('mc_phase1_foundation.sql')); file(DB, SB('mc_phase1_foundation.sql')); });
  t('Rule 19: the three tables are RLS-on, no policies, nothing granted to anon/authenticated; bucket private', () => {
    assert.strictEqual(q(`select string_agg(relname||':'||relrowsecurity, ',' order by relname) from pg_class where relname in ('mfr_sources','mfr_decisions','mfr_verification_runs')`),
      'mfr_decisions:true,mfr_sources:true,mfr_verification_runs:true');
    assert.strictEqual(q(`select count(*) from pg_policy where polrelid in ('mfr_sources'::regclass,'mfr_decisions'::regclass,'mfr_verification_runs'::regclass)`), '0');
    assert.strictEqual(q(`select count(*) from information_schema.role_table_grants where table_name in ('mfr_sources','mfr_decisions','mfr_verification_runs') and grantee in ('anon','authenticated','PUBLIC')`), '0');
    assert.strictEqual(q(`select public from storage.buckets where id='mfr-sources'`), 'f');
    denied('anon', 'select count(*) from mfr_decisions'); denied('authenticated', 'select count(*) from mfr_sources');
    denied('anon', `insert into mfr_verification_runs(manufacturer,phase,result,checks) values ('x','release','pass','[]')`);
  });
  t('honest dates: a new source needs a received date; "stated" needs the manufacturer date; freight terms need a trace', () => {
    assert.throws(() => q(`insert into mfr_sources(manufacturer,kind,title) values ('x','other','t')`), /mfr_sources_received/);
    assert.throws(() => q(`insert into mfr_sources(manufacturer,kind,title,received_date,effective_date_status) values ('x','other','t','2026-10-10','stated')`), /mfr_sources_effective/);
    assert.throws(() => q(`update manufacturer_meta set freight_terms='{"groups":[]}' where slug='pedifix'`), /freight_traced/);
  });
  t('backfill applies, and applies again without duplicates', () => { file(DB, SB('mc_phase1_backfill.sql')); const n = q('select count(*) from mfr_decisions'); file(DB, SB('mc_phase1_backfill.sql')); assert.strictEqual(q('select count(*) from mfr_decisions'), n); });
  t('backfill: Bemis source received 2026-10-10, effective date pending; legacy sources carry no invented date', () => {
    assert.strictEqual(q(`select received_date||'|'||effective_date_status||'|'||legacy from mfr_sources where manufacturer='bemis' and kind='price_list'`), '2026-10-10|pending|false');
    assert.strictEqual(q(`select count(*) from mfr_sources where legacy and received_date is not null`), '0');
  });
  t('backfill: unit cost as Bemis wrote it, case qty parsed from "2/CS", bases match today\'s display', () => {
    assert.strictEqual(q(`select string_agg(code||'='||dealer_unit_cost, ',' order by code) from product_skus where manufacturer='bemis' and dealer_unit_cost is not null`), '7YE82350TC=54.99,7YR05310TSS=64.99');
    assert.strictEqual(q(`select string_agg(code||'='||coalesce(parsed_case_qty::text,'-'), ',' order by code) from price_imports`), '7YE82350TC=-,7YR05310TSS=2');
    assert.strictEqual(q(`select string_agg(manufacturer||':'||code||':'||coalesce(msrp_basis,'-')||'/'||coalesce(map_basis,'-'), ',' order by manufacturer, code) from product_skus where msrp_basis is not null or map_basis is not null`),
      'bemis:7YR05310TSS:each/each,ovation-medical:61000-210:order_unit/-,strongback-mobility:A1005:-/each');
  });
  t('backfill: four lines frozen with a reason; Bemis pages deferral points at its decision; freight traced', () => {
    assert.strictEqual(q(`select string_agg(slug, ',' order by slug) from manufacturer_meta where frozen and frozen_reason is not null`), 'bemis,climbing-steps,ovation-medical,strongback-mobility');
    assert.strictEqual(q(`select (deferrals->0->>'decision_id') = (select id::text from mfr_decisions where field='enrichment_pages') from manufacturer_meta where slug='bemis'`), 't');
    assert.strictEqual(q(`select count(*) from manufacturer_meta where frozen and (freight_terms->'trace') is null`), '0');
  });
  let before;
  t('phase 2 guard installs (twice) and its self-test changes nothing and reports every attempt blocked', () => {
    before = q(SNAP); file(DB, SB('mc_phase2_freeze_guard.sql')); file(DB, SB('mc_phase2_freeze_guard.sql'));
    const res = JSON.parse(q('select public.mfr_freeze_guard_selftest()'));
    assert.strictEqual(res.length, 20); assert.ok(res.every(r => r.result === 'blocked'), JSON.stringify(res.filter(r => r.result !== 'blocked')));
    assert.strictEqual(q(SNAP), before);
  });
  t('the backfill refuses to run once the guard exists', () => assert.throws(() => file(DB, SB('mc_phase1_backfill.sql')), /freeze guard is already installed/));
  t('frozen line: record price, UOM, insert, delete, line move are refused; a timestamp touch is not', () => {
    blocked(`update product_skus set base_price=1 where manufacturer='bemis' and code='7YR05310TSS'`);
    blocked(`update product_skus set uom='Each' where manufacturer='bemis' and code='7YR05310TSS'`);
    blocked(`insert into product_skus(manufacturer,code,base_price,status) values ('bemis','NEW1',5,'active')`);
    blocked(`delete from product_skus where manufacturer='bemis' and code='DO5300RD444'`);
    blocked(`insert into product_skus(manufacturer,code,base_price,status) values ('pedifix','P9',5,'active'); update product_skus set manufacturer='bemis' where code='P9'`);
    allowed(`update product_skus set updated_at=now(), updated_by='x' where manufacturer='bemis'`);
  });
  t('frozen line: override and added-product prices refused; images and names allowed', () => {
    allowed(`update product_overrides set patch=patch||'{"image":"b.jpg"}' where manufacturer='bemis'`);
    blocked(`update product_overrides set patch=patch||'{"base_price":1}' where manufacturer='bemis'`);
    blocked(`insert into product_overrides values ('bemis','7YE82350TC','{"active":false}',now())`);
    blocked(`delete from product_overrides where manufacturer='bemis'`);
    allowed(`update custom_products set name='Display kit' where code='444DISPLAY'`);
    blocked(`update custom_products set base_price=1 where code='444DISPLAY'`);
    blocked(`insert into custom_products(manufacturer,code,base_price) values ('bemis','N2',5)`);
  });
  t('frozen line: authority, unfreeze and freight terms refused; logo and parity bookkeeping allowed; freezing allowed', () => {
    blocked(`update manufacturer_meta set record_authoritative=false where slug='bemis'`);
    blocked(`update manufacturer_meta set frozen=false where slug='bemis'`);
    blocked(`update manufacturer_meta set freight_terms=freight_terms||'{"summary":"x"}' where slug='bemis'`);
    allowed(`update manufacturer_meta set logo_url='x', record_resync_at=now(), record_resync_error=null where slug='bemis'`);
    allowed(`update manufacturer_meta set frozen=true, frozen_at=now(), frozen_reason='t' where slug='pedifix'`);
  });
  t('unfrozen line: unaffected', () => { allowed(`update custom_products set base_price=6 where code='P1'`); allowed(`insert into product_skus(manufacturer,code,base_price,status) values ('pedifix','P1',5,'active')`); });
  t('regression_fix token: only an unused fix of this line opens it', () => {
    q(`insert into mfr_decisions(manufacturer,field,kind,reason,decided_by) values ('bemis','base_price','regression_fix','fix','t'),('bemis','x','interpretation','not a fix','t'),
       ('strongback-mobility','x','regression_fix','other line','t'),('bemis','y','regression_fix','spent','t')`);
    q(`update mfr_decisions set used_at=now() where reason='spent'`);
    const id = r => q(`select id from mfr_decisions where reason='${r}'`);
    allowed(`update product_skus set base_price=109.97 where manufacturer='bemis' and code='7YR05310TSS'`, id('fix'));
    allowed(`update manufacturer_meta set frozen=false where slug='bemis'`, id('fix'));
    for (const r of ['not a fix', 'other line', 'spent']) blocked(`update product_skus set base_price=1 where manufacturer='bemis' and code='7YR05310TSS'`, id(r));
    blocked(`update product_skus set base_price=1 where manufacturer='bemis' and code='7YR05310TSS'`, 'abc');
  });
  t('the guard binds the table owner too (hand-run SQL)', () => assert.throws(() => q(`update product_skus set base_price=1 where manufacturer='bemis' and code='7YR05310TSS'`), /line_frozen/));
  t('Rule 19: anon / authenticated cannot execute the guard or its self-test', () => {
    assert.strictEqual(q(`select bool_or(has_function_privilege(r, 'public.mfr_freeze_guard()', 'execute') or has_function_privilege(r, 'public.mfr_freeze_guard_selftest()', 'execute')) from unnest(array['anon','authenticated']) r`), 'f');
  });
  t('a missing guard is reported NOT BLOCKED by the self-test, and still nothing changes', () => {
    const b = q(SNAP);
    const res = JSON.parse(q(`begin; drop trigger mfr_freeze_guard on product_skus; select public.mfr_freeze_guard_selftest(); rollback;`.replace('rollback;', 'rollback;')) .split('\n').filter(Boolean).pop() || '[]');
    assert.ok(res.some(r => r.result === 'NOT BLOCKED'), JSON.stringify(res)); assert.strictEqual(q(SNAP), b);
    assert.strictEqual(q(`select count(*) from pg_trigger where tgname='mfr_freeze_guard'`), '4');
  });
} finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} }
console.log(`mc sql (foundation, backfill, freeze guard): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

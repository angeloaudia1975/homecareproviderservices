/* MI Phase D — supabase/mi_d_climbing_steps_activation.sql in a REAL Postgres, after mi_d_profile_activation.sql: only the
   Climbing Steps profile becomes active + auto-registering with the month-name file rule; nothing else changes; a second run
   and a non-owner run are refused; the stored rule matches the files the trial saw.
     PGTEST_PSQL=… PGHOST=… PGPORT=… PGUSER=postgres node test/mi-d-cs-activation.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_midcs_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => (f === 'mi_b_report_capture.sql' && process.env.MIB_SQL) ? process.env.MIB_SQL : path.join(__dirname, '..', 'supabase', f);
const T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split("\n").slice(0,3).join(" | ")); } }
const q = sql => run(DB, sql);
const ACT0 = path.join(__dirname, '..', 'supabase', 'mi_d_profile_activation.sql');
const ACT = path.join(__dirname, '..', 'supabase', 'mi_d_climbing_steps_activation.sql');
const RC = require('../netlify/functions/_report_capture.js');
const APPSET = `create table if not exists app_settings (key text primary key, value jsonb); alter table app_settings enable row level security;
  revoke all on app_settings from anon, authenticated; insert into app_settings (key, value) values ('phase2_flags', '{"mi_import_v2": true}') on conflict do nothing`;
const snap = () => q(`select string_agg(code || '|' || status || '|' || auto_register || '|' || auto_import || '|' || md5(rules::text), ',' order by code) from mfr_report_profiles`);
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
    T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
    SB('mi1b_report_register.sql')]) file(DB, f);
  q(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
     alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
     alter default privileges in schema public grant all on functions to anon, authenticated, service_role`);
  q(`alter table dealers add column if not exists is_test boolean default false, add column if not exists active boolean default true, add column if not exists account_class text`);
  q(APPSET);
  q(`create table if not exists dealer_aliases (alias_norm text primary key, raw_name text, dealer_id uuid references dealers(id), created_at timestamptz default now())`);
  q(`insert into manufacturers values ('ohio-medical','Ohio Medical'),('access4u','Access4U'),('airavant-bongorx','AirAvant / BongoRx'),('climbing-steps','Climbing Steps'),
     ('bemis','Bemis'),('complete-medical-supplies','Complete Medical Supplies'),('golden-technologies','Golden Technologies') on conflict do nothing`);
  file(DB, SB('mi1c_dealer_intel.sql'));
  file(DB, SB('mi_b_report_capture.sql'));
  file(DB, ACT0);
  const before = snap();
  const others = () => q(`select string_agg(code || '|' || status || '|' || auto_register || '|' || md5(rules::text), ',' order by code) from mfr_report_profiles where code <> 'climbing-steps:commission_statement:monthly'`);
  const othersBefore = others();
  t('a non-owner run is refused and writes nothing', () => {
    q(`do $$ begin if not exists (select 1 from pg_roles where rolname='midcs_other') then create role midcs_other; end if; end $$; grant usage on schema public to midcs_other; grant select, update on mfr_report_profiles to midcs_other`);
    const r = spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', 'set role midcs_other', '-f', ACT], { encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0); assert.ok(/mi_d_cs: run as the table owner|permission denied|mfr_capture_guard/.test(r.stderr), r.stderr);
    assert.strictEqual(snap(), before);
  });
  t('the reviewed run activates Climbing Steps only, registration only', () => {
    file(DB, ACT);
    assert.strictEqual(q(`select status || '|' || auto_register || '|' || auto_import from mfr_report_profiles where code='climbing-steps:commission_statement:monthly'`), 'active|true|false');
    assert.strictEqual(q(`select count(*) from mfr_report_profiles where status='active'`), '8');
    assert.strictEqual(others(), othersBefore);
  });
  t('only file_name changed; the stored rule (as the capture reads it) accepts the trial files and refuses others', () => {
    const r = JSON.parse(q(`select rules::text from mfr_report_profiles where code='climbing-steps:commission_statement:monthly'`));
    assert.deepStrictEqual(Object.assign({}, r, { file_name: 'x' }), { senders: { domains: ['climbingsteps.com'] }, formats: ['xls', 'xlsx'], file_name: 'x', body_only: true,
      period: { order: ['subject', 'file_name'] }, expected: { cadence: 'monthly', days: [4, 12] } });
    const re = new RegExp(r.file_name, 'i');
    for (const f of ['October 2025.xlsx', 'November 2025 Commision Report.xls', 'May 2026 Commision Report.xlsx', 'Angelo March Comms.xls', 'SalesRepCommissionSearchResults27.xlsb'])
      assert.ok(re.test(f), f);
    for (const f of ['B2B May Newsletter.pdf', 'October 2025 price list.xlsx', 'RMA941.pdf', 'MedtradePromo.pdf', 'W9 HPS 2024.pdf']) assert.ok(!re.test(f), f);
    assert.ok(RC._internal, 'capture module loads');
  });
  t('a second run is refused and writes nothing', () => {
    const s = snap(); assert.throws(() => file(DB, ACT), /expected the reviewed Climbing Steps draft profile/); assert.strictEqual(snap(), s);
  });
} catch (e) { fail++; console.log('  FAIL setup: ' + String(e.message || e).split('\n').slice(0, 3).join(' | ')); }
finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} }
console.log(`\nmi-d-cs-activation (Postgres): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

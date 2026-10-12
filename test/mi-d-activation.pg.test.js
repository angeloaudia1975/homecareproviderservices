/* MI Phase D — supabase/mi_d_profile_activation.sql run in a REAL Postgres (pg-safeupdate loaded) on the real chain up to
   MI-B: exactly the four reviewed draft profiles become active + auto-registering (Ohio: period through-month + SPIFF
   ignore rule); nothing else changes; a second run and a non-owner run are refused and write nothing; auto_import stays false.
     PGTEST_PSQL=… PGHOST=… PGPORT=… PGUSER=postgres node test/mi-d-activation.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mid_' + process.pid;
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
const ACT = path.join(__dirname, '..', 'supabase', 'mi_d_profile_activation.sql');
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
  const before = snap();
  const others = () => q(`select string_agg(code || '|' || status || '|' || auto_register || '|' || md5(rules::text), ',' order by code) from mfr_report_profiles where code not in ('bemis:commission_statement:rep705','airavant-bongorx:commission_statement:cash_basis','access4u:commission_statement:monthly','ohio-medical:commission_statement:through')`);
  const othersBefore = others();
  t('a non-owner run is refused and writes nothing', () => {
    q(`do $$ begin if not exists (select 1 from pg_roles where rolname='mid_other') then create role mid_other; end if; end $$; grant usage on schema public to mid_other; grant select, update on mfr_report_profiles to mid_other`);
    const r = spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', 'set role mid_other', '-f', ACT], { encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0); assert.ok(/mi_d: run as the table owner|permission denied|mfr_capture_guard/.test(r.stderr), r.stderr);
    assert.strictEqual(snap(), before);
  });
  t('the reviewed run activates exactly the four profiles, registration only', () => {
    const out = file(DB, ACT);
    const rows = q(`select code || '|' || status || '|' || auto_register || '|' || auto_import from mfr_report_profiles where status='active' order by code`).split('\n');
    assert.deepStrictEqual(rows, ['access4u:commission_statement:monthly|active|true|false', 'airavant-bongorx:commission_statement:cash_basis|active|true|false',
      'bemis:commission_statement:rep705|active|true|false', 'ohio-medical:commission_statement:through|active|true|false',
      'strongback-mobility:commission_statement:sr032|active|true|false', 'strongback-mobility:dealer_report:overview|active|true|false', 'strongback-mobility:sales_export:orders|active|true|false']);
    assert.ok(/ohio-medical/.test(out));
  });
  t('Ohio: period runs through the month (cumulative false), SPIFF ignored; the rest of its rules unchanged', () => {
    const r = JSON.parse(q(`select rules::text from mfr_report_profiles where code='ohio-medical:commission_statement:through'`));
    assert.strictEqual(r.period.cumulative, false); assert.strictEqual(r.ignore_file_name, '^ZOL SPIFF');
    assert.deepStrictEqual(r.period.order, ['subject']); assert.strictEqual(r.period.subject_year, 'from_received'); assert.deepStrictEqual(r.expected, { cadence: 'monthly', days: [21, 29] });
    assert.deepStrictEqual(r.content, { sheet_names_any: ['Current month payment', 'Sales-Commission Data'] });
  });
  t('every other profile is unchanged (Climbing Steps stays draft)', () => {
    assert.strictEqual(others(), othersBefore);
    assert.strictEqual(q(`select status || '|' || auto_register from mfr_report_profiles where code='climbing-steps:commission_statement:monthly'`), 'draft|false');
  });
  t('a second run is refused and writes nothing', () => {
    const s = snap(); assert.throws(() => file(DB, ACT), /expected the 4 reviewed draft profiles/); assert.strictEqual(snap(), s);
  });
  t('auto_import can never be set (table check)', () => {
    assert.throws(() => q(`begin; select set_config('hcps.capture_op','on',true); update mfr_report_profiles set auto_import = true where code='bemis:commission_statement:rep705'; commit;`), /check/i);
  });
} catch (e) { fail++; console.log('  FAIL setup: ' + String(e.message || e).split('\n').slice(0, 3).join(' | ')); }
finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} }
console.log(`\nmi-d-activation (Postgres): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

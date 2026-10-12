/* MI Phase D — supabase/mi_d_profile_activation_2.sql in a REAL Postgres, after mi_d_profile_activation.sql: only the
   Climbing Steps profile becomes active + auto-registering with the month-name file rule; nothing else changes; a second run
   and a non-owner run are refused; the stored rule matches the files the trial saw.
     PGTEST_PSQL=… PGHOST=… PGPORT=… PGUSER=postgres node test/mi-d-cs-activation.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_midp2_' + process.pid;
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
const ACT = path.join(__dirname, '..', 'supabase', 'mi_d_profile_activation_2.sql');
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
  file(DB, path.join(__dirname, '..', 'supabase', 'mi_d_climbing_steps_activation.sql'));
  const before = snap();
  const CODES = ['complete-medical-supplies:commission_statement:monthly', 'ovation-medical:commission_statement:summary'];
  const others = () => q(`select string_agg(code || '|' || status || '|' || auto_register || '|' || md5(rules::text), ',' order by code) from mfr_report_profiles where code not in ('${CODES.join("','")}')`);
  const othersBefore = others();
  t('a non-owner run is refused and writes nothing', () => {
    q(`do $$ begin if not exists (select 1 from pg_roles where rolname='midp2_other') then create role midp2_other; end if; end $$; grant usage on schema public to midp2_other; grant select, update on mfr_report_profiles to midp2_other`);
    const r = spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', 'set role midp2_other', '-f', ACT], { encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0); assert.ok(/mi_d2: run as the table owner|permission denied|mfr_capture_guard/.test(r.stderr), r.stderr);
    assert.strictEqual(snap(), before);
  });
  t('the reviewed run activates exactly the two profiles, registration only', () => {
    file(DB, ACT);
    assert.strictEqual(q(`select string_agg(status || '|' || auto_register || '|' || auto_import, ',' order by code) from mfr_report_profiles where code in ('${CODES.join("','")}')`), 'active|true|false,active|true|false');
    assert.strictEqual(q(`select count(*) from mfr_report_profiles where status='active'`), '10');
    assert.strictEqual(q(`select string_agg(manufacturer, ',' order by manufacturer) from mfr_report_profiles where status='draft'`), 'golden-technologies,pedifix');
    assert.strictEqual(others(), othersBefore);
  });
  t('the stored rules, as the capture reads them, register the statements and nothing else', () => {
    const prof = c => Object.assign({ id: 1, code: c, status: 'active', auto_register: true }, JSON.parse(q(`select json_build_object('manufacturer', manufacturer, 'kind', kind, 'rules', rules)::text from mfr_report_profiles where code='${c}'`)));
    const D = RC._internal.decide, INV = require('../netlify/functions/_report_inventory.js');
    const att = (name, fmt) => ({ name, format: fmt || 'xlsx', suggested: INV.shared.classifyName(name) === 'price_list' ? 'price_list' : (INV.shared.classifyName(name) || null) });
    const cm = [prof(CODES[0])], ov = [prof(CODES[1])];
    const mc = (s, at) => ({ from_address: 'anne@completemedical.com', subject: s, received_at: at || '2026-04-17T14:00:00Z' });
    const jan = D(att('Homecare Providers Jan 2026 Commission.xlsx'), mc('RE: Any updates on Jan and Feb Commission Reports'), cm, { slug: 'complete-medical-supplies' });
    const feb = D(att('Homecare Providers Feb 2026 Commission.xlsx'), mc('RE: Any updates on Jan and Feb Commission Reports'), cm, { slug: 'complete-medical-supplies' });
    assert.deepStrictEqual([jan.outcome, jan.period.start, feb.outcome, feb.period.start], ['register', '2026-01-01', 'register', '2026-02-01']);
    assert.strictEqual(D(att('Homecare Providers Oct 25 Commission.xls', 'xls'), mc('RE: Oct Commission Reports'), cm, { slug: 'complete-medical-supplies' }).period.start, '2025-10-01');
    for (const f of ['Homecare Providers flyer  Mail list as of April.xlsx', 'Acknowledgement Print.pdf', 'Quote Print.pdf', 'Past Invoice Print.pdf', 'July 2026 Sale Flyer - 16 Pages!.pdf'])
      assert.notStrictEqual(D(att(f, /pdf$/.test(f) ? 'pdf' : 'xlsx'), mc('RE: Complete Medical Order'), cm, { slug: 'complete-medical-supplies' }).outcome, 'register', f);
    const mo = (s, at) => ({ from_address: 'x@ovationmed.com', subject: s, received_at: at });
    const jun = D(att('2606 Independent Monthly Sales Summary - Homecare Providers.xlsx'), mo('2606 June Comm Summary', '2026-07-13T14:00:00Z'), ov, { slug: 'ovation-medical' });
    assert.deepStrictEqual([jun.outcome, jun.period.start], ['register', '2026-06-01']);
    const pl = D(att('2026 PriceList  Commission Rate IREP.xlsx'), mo('RE: Ovation Medical Item Numbers Seem Invalid', '2026-09-01T14:00:00Z'), ov, { slug: 'ovation-medical' });
    assert.deepStrictEqual([pl.outcome, pl.attention], ['classified', undefined], 'a price list is never a statement nor an exception');
  });
  t('a second run is refused and writes nothing', () => {
    const s = snap(); assert.throws(() => file(DB, ACT), /expected the 2 reviewed draft profiles/); assert.strictEqual(snap(), s);
  });
} catch (e) { fail++; console.log('  FAIL setup: ' + String(e.message || e).split('\n').slice(0, 3).join(' | ')); }
finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} }
console.log(`\nmi-d-p2-activation (Postgres): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

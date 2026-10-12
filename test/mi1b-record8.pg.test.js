/* MI-1b — the one-time record #8 period correction (supabase/mi1b_record8_period_correction.sql), run in a REAL
   Postgres on the production chain (MI-1a → Manufacturer Center → MI-1b → MI-1c → Phase B), with MI-1b installed AND the
   correction pasted with Windows line endings, as the SQL editor does. Proves: only record 8's period end + title move,
   every other column / record / financial row is identical, one 'period_corrected' event with both periods, the guard
   is the ORIGINAL afterwards (same prosrc, same definition) and still refuses a period change, a second run is refused
   and writes nothing, a record in any other state is refused and writes nothing, a non-owner is refused.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/var/tmp/pgmi PGPORT=55433 PGUSER=postgres node test/mi1b-record8.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f), T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
const FIX = process.env.REC8_SQL || SB('mi1b_record8_period_correction.sql');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec8-'));
const crlf = (src, name) => { const f = path.join(tmp, name); fs.writeFileSync(f, fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n')); return f; };
const FIX_CRLF = crlf(FIX, 'fix_crlf.sql'), MI1B_CRLF = crlf(SB('mi1b_report_register.sql'), 'mi1b_crlf.sql');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); } }
const J = o => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const SHA8 = '42509f6bfa59c0368697ae53c016f5fe2d01c4b68f3cdefbf002ec5e6a1d98dc';
const REC7 = 'f708ebaf0290bb736c7499b818655167c436c8867f16142cf122fd663bd790b5';
const APPSET = `create table if not exists app_settings (key text primary key, value jsonb); alter table app_settings enable row level security;
  revoke all on app_settings from anon, authenticated; insert into app_settings (key, value) values ('phase2_flags', '{"mi_import_v2": true, "mi_report_capture": true}') on conflict do nothing`;
const dbs = [];
function setup(tag) {
  const DB = `hcps_rec8_${tag}_${process.pid}`; dbs.push(DB);
  run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
  const q = sql => run(DB, sql), sr = sql => q(`begin; set local role service_role; ${sql}; commit;`);
  for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
    T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
    MI1B_CRLF]) file(DB, f);                                                                  // MI-1b pasted from Windows, as in production
  q(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
     alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
     alter default privileges in schema public grant all on functions to anon, authenticated, service_role`);
  q(`alter table dealers add column if not exists is_test boolean default false, add column if not exists active boolean default true, add column if not exists account_class text`);
  q(APPSET);
  q(`create table if not exists dealer_aliases (alias_norm text primary key, raw_name text, dealer_id uuid references dealers(id), created_at timestamptz default now())`);
  q(`insert into manufacturers values ('ohio-medical','Ohio Medical'),('access4u','Access4U'),('airavant-bongorx','AirAvant / BongoRx'),('climbing-steps','Climbing Steps'),
     ('bemis','Bemis'),('complete-medical-supplies','Complete Medical Supplies'),('golden-technologies','Golden Technologies') on conflict do nothing`);
  file(DB, SB('mi1c_dealer_intel.sql')); file(DB, SB('mi_b_report_capture.sql'));
  const reg = o => sr(`select public.hcps_mfr_report_register(${J(o)})`);
  // ids 1..6 are the catalog rows; 7 = the September dealer overview; 8 = the order CSV exactly as capture registered it.
  q(`select setval('mfr_sources_id_seq', 6)`);
  reg({ manufacturer: 'strongback-mobility', kind: 'dealer_report', title: 'Strongback — September 2026 Dealer Report', file_name: 'Strongback_Report_Overview_September_2026.pdf',
    file_sha256: REC7, storage_path: `reports/strongback-mobility/dealer_report/${REC7}.pdf`, file_size: 515614, content_type: 'application/pdf',
    received_date: '2026-10-11', prepared_date: '2026-10-08', report_period_start: '2026-09-01', report_period_end: '2026-09-30', actor: 'angelo@homecareproviderservices.us' });
  reg({ manufacturer: 'strongback-mobility', kind: 'sales_export', title: 'Strongback Mobility — order / sales export 2026-09 to 2026-10', file_name: 'Angelo Sep Orders.csv',
    file_sha256: SHA8, storage_path: `reports/strongback-mobility/sales_export/${SHA8}.csv`, file_size: 4155, content_type: 'text/csv', received_date: '2026-10-02',
    prepared_date: '', report_period_start: '2026-09-01', report_period_end: '2026-10-31', note: 'Captured automatically from Outlook', actor: 'system:report-capture' });
  return { DB, q, sr };
}
const FP = q => ({
  rec8: q(`select to_jsonb(s) - 'report_period_end' - 'title' from mfr_sources s where id = 8`),
  others: q(`select md5(string_agg(s::text, ';' order by id)) from mfr_sources s where id <> 8`),
  events: q(`select md5(string_agg(e::text, ';' order by id)) from mfr_source_events e`),
  nevents: q(`select count(*) from mfr_source_events`),
  ms: q(`select md5(string_agg(t::text, ';' order by t.id::text)) from monthly_sales t`),
  guard: q(`select md5(prosrc) from pg_proc where oid = 'public.hcps_mfr_report_guard()'::regprocedure`),
  guardDef: q(`select md5(pg_get_functiondef('public.hcps_mfr_report_guard()'::regprocedure))`),
  actions: q(`select pg_get_constraintdef(oid) from pg_constraint where conname = 'mfr_source_events_action_check'`),
  capture: q(`select md5(coalesce(string_agg(i::text, ';' order by id), '')) from mfr_report_items i`),
});

try {
  console.log('\n— the correction (pasted with Windows line endings) —');
  const A = setup('a');
  const before = FP(A.q);
  t('record 8 exists as capture registered it (id 8, Sep–Oct)', () => assert.strictEqual(A.q(`select id || ' ' || report_period_start || '..' || report_period_end from mfr_sources where file_sha256 = '${SHA8}'`), '8 2026-09-01..2026-10-31'));
  t('the installed MI-1b guard carries Windows line endings (as production)', () => assert.ok(A.q(`select position(chr(13) in prosrc) > 0 from pg_proc where proname = 'hcps_mfr_report_guard'`) === 't'));
  t('a non-owner (service_role) is refused and nothing changes', () => {
    assert.throws(() => run(A.DB, `set role service_role; ${fs.readFileSync(FIX, 'utf8').split('\nselect jsonb_pretty')[0]}`), /table owner|permission denied/);
    assert.deepStrictEqual(FP(A.q), before);
  });
  let out = '';
  t('the correction runs (owner) and prints its result', () => { out = file(A.DB, FIX_CRLF); assert.ok(/2026-09-01\.\.2026-09-30/.test(out), out.slice(0, 300)); });
  const after = FP(A.q);
  t('record 8: period 2026-09-01..2026-09-30, title "… 2026-09"', () =>
    assert.strictEqual(A.q(`select report_period_start || '..' || report_period_end || ' | ' || title from mfr_sources where id = 8`), '2026-09-01..2026-09-30 | Strongback Mobility — order / sales export 2026-09'));
  t('every other column of record 8 is identical (file, SHA-256, size, path, received date, status, creator, note…)', () => assert.strictEqual(after.rec8, before.rec8));
  t('every other record, the capture items and monthly_sales are identical', () => { assert.strictEqual(after.others, before.others); assert.strictEqual(after.capture, before.capture); assert.strictEqual(after.ms, before.ms); });
  t('the guard is the ORIGINAL again (same prosrc md5 and the same definition)', () => { assert.strictEqual(after.guard, before.guard); assert.strictEqual(after.guardDef, before.guardDef); });
  t('exactly one new event: period_corrected, with both periods and titles', () => {
    assert.strictEqual(+after.nevents, +before.nevents + 1);
    const e = JSON.parse(A.q(`select row_to_json(e) from mfr_source_events e where source_id = 8 order by id desc limit 1`));
    assert.strictEqual(e.action, 'period_corrected'); assert.ok(/owner:sql-editor/.test(e.actor)); assert.ok(e.reason.length > 20);
    assert.deepStrictEqual(e.detail.original_period, ['2026-09-01', '2026-10-31']); assert.deepStrictEqual(e.detail.corrected_period, ['2026-09-01', '2026-09-30']);
    assert.strictEqual(e.detail.original_title, 'Strongback Mobility — order / sales export 2026-09 to 2026-10'); assert.strictEqual(e.detail.file_sha256, SHA8);
    assert.strictEqual(A.q(`select string_agg(action, ',' order by id) from mfr_source_events where source_id = 8`), 'registered,period_corrected');
  });
  t('the action list only GAINED period_corrected', () => {
    for (const k of ['registered','accepted','rejected','superseded','published','withdrawn','batch_linked','period_corrected']) assert.ok(after.actions.includes(`'${k}'`), k);
    assert.ok(!before.actions.includes('period_corrected'));
  });
  t('the guard still refuses a period change on record 8 (even with the MI-1b marker) and any other record', () => {
    assert.throws(() => A.q(`begin; select set_config('hcps.mfr_report_op','on',true); update mfr_sources set report_period_end='2026-10-31' where id=8; commit;`), /never change/);
    assert.throws(() => A.q(`begin; select set_config('hcps.mfr_report_op','on',true); select set_config('hcps.mfr_record8_period_fix','${SHA8}',true); update mfr_sources set report_period_end='2026-10-31' where id=8; commit;`), /never change/);
    assert.throws(() => A.q(`begin; select set_config('hcps.mfr_report_op','on',true); update mfr_sources set report_period_end='2026-10-31' where id=7; commit;`), /never change/);
    assert.throws(() => A.q(`update mfr_sources set title='x' where id=8`), /mfr_report_guard/);
  });
  t('the events stay append-only', () => assert.throws(() => A.q(`delete from mfr_source_events where source_id=8`), /append-only/));
  t('a second run is refused and writes nothing', () => {
    const snap = FP(A.q);
    assert.throws(() => file(A.DB, FIX_CRLF), /not in the expected state/);
    assert.deepStrictEqual(FP(A.q), snap);
  });
  t('MI-1b still works afterwards: record 8 can be accepted through the function', () => {
    const r = JSON.parse(A.sr(`select public.hcps_mfr_report_decide(${J({ id: 8, decision: 'accepted', actor: 'angelo@homecareproviderservices.us', reason: 'ok' })})`));
    assert.strictEqual(r.ok, true);
  });

  console.log('\n— refused in any other state —');
  const B = setup('b');
  B.sr(`select public.hcps_mfr_report_decide(${J({ id: 8, decision: 'accepted', actor: 'angelo@homecareproviderservices.us', reason: 'ok' })})`);
  t('an ACCEPTED record 8 is refused; guard, events and rows unchanged', () => {
    const snap = FP(B.q); assert.throws(() => file(B.DB, FIX_CRLF), /not in the expected state/); assert.deepStrictEqual(FP(B.q), snap);
  });
  const C = setup('c');
  C.q(`begin; select set_config('hcps.mfr_report_op','on',true); insert into mfr_source_events (source_id, action, actor) values (8, 'accepted', 'x'); commit;`);
  t('record 8 with any event besides its registration is refused; nothing written', () => {
    const snap = FP(C.q); assert.throws(() => file(C.DB, FIX_CRLF), /events other than its registration/); assert.deepStrictEqual(FP(C.q), snap);
  });
  t('the same script pasted with Unix line endings also works (fresh copy)', () => {
    const D = setup('d'); const b = FP(D.q); file(D.DB, FIX); const a = FP(D.q);
    assert.strictEqual(a.guard, b.guard); assert.strictEqual(a.rec8, b.rec8); assert.strictEqual(+a.nevents, +b.nevents + 1);
  });
} finally {
  for (const d of dbs) { try { run('postgres', `drop database if exists ${d}`); } catch (e) { /* ignore */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

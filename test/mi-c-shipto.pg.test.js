/* Phase C — Ship-To corrections & verified mappings (supabase/mi_c_shipto.sql), run in a REAL Postgres (pg-safeupdate
   loaded when available) on the production chain: MI-1a → Manufacturer Center → MI-1b → MI-C (twice). Proves RULE 19,
   the guard (only the functions write; corrections / events append-only; mappings only retired, once; no delete or
   truncate even for the owner), versioning with a stale-version refusal, the mapping rules (file key only, one active per
   key, conflict needs replace, replace retires the old one), every refusal, and that nothing else changes.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/var/tmp/pgmi PGPORT=55433 PGUSER=postgres node test/mi-c-shipto.pg.test.js */
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mic_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => (f === 'mi_c_shipto.sql' && process.env.MIC_SQL) ? process.env.MIC_SQL : path.join(__dirname, '..', 'supabase', f);
const T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); } }
const q = sql => run(DB, sql);
const sr = sql => q(`begin; set local role service_role; ${sql}; commit;`);
const as = (role, sql) => q(`begin; set local role ${role}; ${sql}; commit;`);
const J = o => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const refused = (fn, re) => { try { fn(); } catch (e) { assert.ok(re.test(e.message), 'wrong refusal: ' + e.message.split('\n')[0]); return; } throw new Error('NOT refused'); };
const HQ = '00000000-0000-0000-0000-00000000000a', VIN = '00000000-0000-0000-0000-00000000000c', PRIN = '00000000-0000-0000-0000-00000000000d', TEST = '00000000-0000-0000-0000-00000000000e';
const SHA = c => c.repeat(64), FP = 'a'.repeat(32);
const ACT = 'staff:angelo@homecareproviderservices.us';
const correct = o => JSON.parse(sr(`select public.hcps_mfr_shipto_correct(${J(Object.assign({ source_id: 1, order_key: 'o:7191', order_fingerprint: FP,
  reported: { company: 'Williams Brothers Healthcare Pharmacy', ship_zip: '47670' }, dealer_id: PRIN, scope: 'branch', reason: 'ships to Princeton', actor: ACT,
  expected_version: 0 }, o))})`).split('\n').pop());
const OTHER_FP = `select md5(coalesce((select string_agg(t::text, ';' order by t.id) from monthly_sales t), '')) || md5(coalesce((select string_agg(t::text, ';' order by t.id) from dealers t), ''))
  || md5(coalesce((select string_agg(t::text, ';' order by t.id) from mfr_sources t), '')) || md5(coalesce((select string_agg(t::text, ';' order by t.id) from mfr_source_events t), ''))`;

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
run(DB, `alter database ${DB} set session_preload_libraries = 'safeupdate'`);   // as on Supabase's API (pg-safeupdate)
let SRC = 0, SRC_REJ = 0, SRC_DEALER = 0;
try {
  for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
    T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
    SB('mi1b_report_register.sql')]) file(DB, f);
  q(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
     alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
     alter default privileges in schema public grant all on functions to anon, authenticated, service_role`);
  q(`alter table dealers add column if not exists is_test boolean default false, add column if not exists address text`);
  q(`insert into dealers (id, business_name, parent_id, city, state, zip, address) values ('${PRIN}','Williams Brothers Princeton','${HQ}','Princeton','IN','47670','101 W Brumfield Ave'),
     ('${TEST}','TEST Sandbox Dealer',null,'Dayton','OH','45402','1 Test St')`);
  q(`update dealers set is_test = true where id = '${TEST}'`);
  const reg = o => JSON.parse(sr(`select public.hcps_mfr_report_register(${J(Object.assign({ manufacturer: 'strongback-mobility', kind: 'sales_export',
    title: 'Strongback orders', file_name: 'Angelo Sep Orders.csv', file_size: 4155, content_type: 'text/csv', received_date: '2026-10-02', prepared_date: '',
    report_period_start: '2026-09-01', report_period_end: '2026-09-30', actor: 'system:report-capture' }, o))})`)).id;
  SRC = reg({ file_sha256: SHA('1'), storage_path: `reports/strongback-mobility/sales_export/${SHA('1')}.csv` });
  SRC_REJ = reg({ file_sha256: SHA('2'), storage_path: `reports/strongback-mobility/sales_export/${SHA('2')}.csv`, file_name: 'other.csv' });
  sr(`select public.hcps_mfr_report_decide(${J({ id: SRC_REJ, decision: 'rejected', reason: 'wrong file', actor: 'angelo@x.us' })})`);
  SRC_DEALER = reg({ kind: 'dealer_report', file_sha256: SHA('3'), storage_path: `reports/strongback-mobility/dealer_report/${SHA('3')}.pdf`, file_name: 'r.pdf', content_type: 'application/pdf' });
  const before = q(OTHER_FP);

  console.log('\n— install —');
  t('installs, and installs again; every install check ok', () => {
    for (let i = 0; i < 2; i++) { const out = file(DB, SB('mi_c_shipto.sql')).trim().split('\n').filter(l => /^\d+\|/.test(l));
      assert.strictEqual(out.length, 9, out.join('\n')); for (const l of out) assert.ok(l.endsWith('|t'), 'check failed: ' + l); }
  });
  t('RULE 19: anon / authenticated read nothing and run nothing', () => {
    for (const r of ['anon', 'authenticated']) {
      for (const tb of ['mfr_shipto_corrections', 'mfr_shipto_mappings', 'mfr_shipto_events']) refused(() => as(r, `select count(*) from ${tb}`), /permission denied/);
      refused(() => as(r, `select public.hcps_mfr_shipto_correct('{}'::jsonb)`), /permission denied/);
      refused(() => as(r, `select public.hcps_mfr_shipto_retire('{}'::jsonb)`), /permission denied/);
    }
  });
  t('service_role may read but never write the tables directly', () => {
    assert.strictEqual(sr(`select count(*) from mfr_shipto_corrections`), '0');
    refused(() => sr(`insert into mfr_shipto_events (action, actor) values ('correction_saved','x')`), /permission denied/);
    refused(() => sr(`select public.hcps_mfr_shipto_guard()`), /permission denied/);
  });

  console.log('\n— save a correction —');
  let c1;
  t('a first correction saves as version 1 with an event; nothing outside Phase C changes', () => {
    c1 = correct({ source_id: SRC }); assert.strictEqual(c1.ok, true); assert.strictEqual(c1.version, 1); assert.strictEqual(c1.mapping, 'none');
    assert.strictEqual(q(`select action from mfr_shipto_events where correction_id = ${c1.correction_id}`), 'correction_saved');
    assert.strictEqual(q(OTHER_FP), before);
  });
  t('the stored correction keeps the reported values beside the choice', () =>
    assert.strictEqual(q(`select reported->>'ship_zip' || ' ' || dealer_id || ' ' || manufacturer from mfr_shipto_corrections where id = ${c1.correction_id}`), `47670 ${PRIN} strongback-mobility`));
  t('a stale save (version already moved) is refused', () => refused(() => correct({ source_id: SRC, expected_version: 0 }), /shipto_stale/));
  t('a later decision is version 2, superseding version 1 (version 1 kept)', () => {
    const c2 = correct({ source_id: SRC, expected_version: 1, dealer_id: HQ, scope: 'corporate', reason: 'confirmed drop-ship to corporate' });
    assert.strictEqual(c2.version, 2);
    assert.strictEqual(q(`select string_agg(version || ':' || scope || ':' || coalesce(supersedes_id::text,'-'), ',' order by version) from mfr_shipto_corrections where source_id = ${SRC} and order_key = 'o:7191'`),
      `1:branch:-,2:corporate:${c1.correction_id}`);
  });
  t('refusals: no reason, no actor, bad scope, missing expected version, unknown / TEST dealer, corporate on a branch, bad ZIP', () => {
    refused(() => correct({ source_id: SRC, order_key: 'o:1', reason: '' }), /shipto_reason_required/);
    refused(() => correct({ source_id: SRC, order_key: 'o:1', actor: 'angelo' }), /shipto_actor_required/);
    refused(() => correct({ source_id: SRC, order_key: 'o:1', scope: 'hq' }), /shipto_bad_scope/);
    refused(() => correct({ source_id: SRC, order_key: 'o:1', expected_version: '' }), /shipto_expected_version_required/);
    refused(() => correct({ source_id: SRC, order_key: 'o:1', dealer_id: '00000000-0000-0000-0000-0000000000ff' }), /shipto_unknown_dealer/);
    refused(() => correct({ source_id: SRC, order_key: 'o:1', dealer_id: TEST }), /shipto_test_dealer/);
    refused(() => correct({ source_id: SRC, order_key: 'o:1', dealer_id: PRIN, scope: 'corporate' }), /shipto_corporate_needs_hq/);
    refused(() => correct({ source_id: SRC, order_key: 'o:1', ship_zip: '4767' }), /shipto_bad_zip/);
  });
  t('refusals: a rejected report, a dealer report, an unknown report', () => {
    refused(() => correct({ source_id: SRC_REJ, order_key: 'o:1' }), /shipto_report_closed/);
    refused(() => correct({ source_id: SRC_DEALER, order_key: 'o:1' }), /shipto_not_a_report/);
    refused(() => correct({ source_id: 99999, order_key: 'o:1' }), /shipto_not_a_report/);
  });
  t('corrected ship-to details are stored as given (overlay)', () => {
    const c = correct({ source_id: SRC, order_key: 'o:7200', ship_name: 'WB Princeton', ship_address: '101 W Brumfield Ave', ship_city: 'Princeton', ship_state: 'IN', ship_zip: '47670-1234' });
    assert.strictEqual(q(`select concat_ws('|', ship_name, ship_address, ship_city, ship_state, ship_zip) from mfr_shipto_corrections where id = ${c.correction_id}`),
      'WB Princeton|101 W Brumfield Ave|Princeton|IN|47670-1234');
  });

  console.log('\n— verified mappings —');
  const KEY = 'addr:101 W BRUMFIELD AVE|47670';
  let m1;
  t('remember: needs a ship-to key from the file (no key → refused, nothing saved)', () => {
    const n = q(`select count(*) from mfr_shipto_corrections`);
    refused(() => correct({ source_id: SRC, order_key: 'o:7300', remember: true, mapping_account_ref: 'williamsbrothershealthcar', mapping_ship_key: '' }), /shipto_no_ship_key/);
    refused(() => correct({ source_id: SRC, order_key: 'o:7300', remember: true, mapping_ship_key: 'acct:williams' }), /shipto_no_ship_key/);
    assert.strictEqual(q(`select count(*) from mfr_shipto_corrections`), n);
  });
  t('remember: creates ONE active mapping (manufacturer + account + key) and logs it', () => {
    m1 = correct({ source_id: SRC, order_key: 'o:7301', remember: true, mapping_account_ref: ' WilliamsBrothersHealthcar ', mapping_ship_key: KEY });
    assert.strictEqual(m1.mapping, 'created');
    assert.strictEqual(q(`select manufacturer || '|' || account_ref || '|' || ship_key || '|' || dealer_id from mfr_shipto_mappings where id = ${m1.mapping_id}`),
      `strongback-mobility|williamsbrothershealthcar|${KEY}|${PRIN}`);
  });
  t('the same choice again reuses the mapping', () => {
    const r = correct({ source_id: SRC, order_key: 'o:7302', remember: true, mapping_account_ref: 'williamsbrothershealthcar', mapping_ship_key: KEY });
    assert.strictEqual(r.mapping, 'existing'); assert.strictEqual(r.mapping_id, m1.mapping_id);
  });
  t('a different branch for the same key is refused without replace (and saves nothing)', () => {
    const n = q(`select count(*) from mfr_shipto_corrections`);
    refused(() => correct({ source_id: SRC, order_key: 'o:7303', dealer_id: VIN, remember: true, mapping_account_ref: 'williamsbrothershealthcar', mapping_ship_key: KEY }), /shipto_mapping_conflict/);
    assert.strictEqual(q(`select count(*) from mfr_shipto_corrections`), n);
  });
  t('with replace: the old mapping is retired (kept), the new one is active, both logged', () => {
    const r = correct({ source_id: SRC, order_key: 'o:7303', dealer_id: VIN, remember: true, replace_mapping: true, mapping_account_ref: 'williamsbrothershealthcar', mapping_ship_key: KEY });
    assert.strictEqual(r.mapping, 'replaced');
    assert.strictEqual(q(`select count(*) filter (where retired_at is null) || '/' || count(*) from mfr_shipto_mappings where ship_key = '${KEY}'`), '1/2');
    assert.ok(/replaced by correction/.test(q(`select retire_reason from mfr_shipto_mappings where id = ${m1.mapping_id}`)));
    assert.strictEqual(q(`select count(*) from mfr_shipto_events where action in ('mapping_replaced','mapping_verified')`), '3');
  });
  t('retire: needs a reason; retires once; a second retire is refused', () => {
    const id = q(`select id from mfr_shipto_mappings where retired_at is null and ship_key = '${KEY}'`);
    refused(() => sr(`select public.hcps_mfr_shipto_retire(${J({ mapping_id: +id, reason: '', actor: ACT })})`), /shipto_reason_required/);
    sr(`select public.hcps_mfr_shipto_retire(${J({ mapping_id: +id, reason: 'branch closed', actor: ACT })})`);
    refused(() => sr(`select public.hcps_mfr_shipto_retire(${J({ mapping_id: +id, reason: 'again', actor: ACT })})`), /shipto_already_retired/);
    assert.strictEqual(q(`select count(*) from mfr_shipto_mappings where retired_at is null`), '0');
  });

  console.log('\n— the guard —');
  t('the owner cannot write the tables without the functions', () => {
    refused(() => q(`insert into mfr_shipto_events (action, actor) values ('correction_saved','x')`), /mfr_shipto_guard/);
    refused(() => q(`update mfr_shipto_mappings set dealer_id = '${HQ}' where true`), /mfr_shipto_guard/);
  });
  t('even with the marker: corrections and events are append-only; nothing is deleted or truncated', () => {
    refused(() => q(`begin; select set_config('hcps.shipto_op','on',true); update mfr_shipto_corrections set dealer_id = '${HQ}' where true; commit;`), /append-only/);
    refused(() => q(`begin; select set_config('hcps.shipto_op','on',true); update mfr_shipto_events set actor = 'x' where true; commit;`), /append-only/);
    refused(() => q(`begin; select set_config('hcps.shipto_op','on',true); delete from mfr_shipto_corrections where true; commit;`), /never deleted/);
    refused(() => q(`truncate mfr_shipto_events, mfr_shipto_mappings, mfr_shipto_corrections`), /not allowed/);
  });
  t('even with the marker: a mapping is never re-pointed or un-retired', () => {
    refused(() => q(`begin; select set_config('hcps.shipto_op','on',true); update mfr_shipto_mappings set dealer_id = '${HQ}' where true; commit;`), /only ever retired/);
    refused(() => q(`begin; select set_config('hcps.shipto_op','on',true); update mfr_shipto_mappings set retired_at = null, retired_by = null, retire_reason = null where true; commit;`), /only ever retired/);
  });
  t('service_role with a forged marker still cannot write', () =>
    refused(() => sr(`select set_config('hcps.shipto_op','on',true); insert into mfr_shipto_events (action, actor) values ('correction_saved','x')`), /permission denied/));
  t('nothing outside Phase C changed at any point (monthly_sales, dealers, register, register events)', () => assert.strictEqual(q(OTHER_FP), before));
  t('the rollback refuses while decisions exist, and writes nothing', () => {
    const n = q(`select count(*) from mfr_shipto_events`);
    assert.throws(() => file(DB, SB('mi_c_shipto_rollback.sql')), /mi_c_rollback/);
    assert.strictEqual(q(`select count(*) from mfr_shipto_events`), n);
  });
} finally {
  try { run('postgres', `drop database if exists ${DB}`); } catch (e) { /* ignore */ }
}
console.log(`\nmi-c-shipto (Postgres): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

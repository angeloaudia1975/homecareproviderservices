/* MI Phase E — supabase/mi_e_auto_import.sql in a REAL Postgres (pg-safeupdate loaded) on the real MI-1a + MI-1b chain:
   the install checks; a keep-quarantined disposition is the President's, made once, for exactly the rows he reviewed, and
   locks those rows permanently (no restore, edit, delete or truncate — the owner included) while other months behave as
   before; it may release ONE registered order export of the same month; import approvals are President-only, single-use,
   stamped once; the log is append-only; RULE 19 privileges; a second run of the migration is safe.
     PGTEST_PSQL=… PGHOST=… PGPORT=… PGUSER=postgres node test/mi-e-auto-import.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mie_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f);
const T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
const MIE = process.env.MIE_SQL || SB('mi_e_auto_import.sql');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); } }
const q = sql => run(DB, sql);
const as = (role, sql) => run(DB, `set role ${role}; ${sql}`);
const refused = (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error('refused for another reason: ' + e.message.split('\n')[0]); return; } throw new Error('expected a refusal'); };
const PRES = 'staff:angelo@hcps.us';
const fp = () => q(`select public.hcps_mfr_quarantine_fp('strongback-mobility', '2026-09-01')`);
const call = (fn, o) => q(`select public.${fn}('${JSON.stringify(o).replace(/'/g, "''")}'::jsonb)::text`);

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
try {
  for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
    T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
    SB('mi1b_report_register.sql')]) file(DB, f);
  q(`do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
       if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
       if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if; end $$`);
  q(`create table if not exists staff_users (email text primary key, role text, active boolean default true, name text);
     insert into staff_users values ('angelo@hcps.us','president',true,'Angelo'),('ad@hcps.us','admin',true,'Ad'),('old@hcps.us','president',false,'Old') on conflict do nothing`);
  // The quarantine table exactly as the September cleanup created it (its DDL, copied from the committed file).
  const cl = fs.readFileSync(SB('commission_sept2026_cleanup.sql'), 'utf8');
  const ddl = cl.slice(cl.indexOf('create table if not exists public.monthly_sales_quarantine'), cl.indexOf('-- The 7 rows, by id'));
  q(ddl);
  const row = (i, per) => `('${100 + i}','strongback-mobility','${per}','commission','Strongback Sept Commission Report 2026.csv','strongback_2026_09_blank_commission_rows','{}','{"invoice_no":null,"n":${i}}',md5('{"invoice_no":null,"n":${i}}'),'sql-editor')`;
  q(`insert into monthly_sales_quarantine (sales_row_id, manufacturer, period, source, source_file, reason, evidence, row_data, row_fp, quarantined_by) values
     ${[1, 2, 3, 4, 5, 6, 7].map(i => row(i, '2026-09-01')).join(',')}, ${row(8, '2026-07-01')}`);
  // Two registered order exports: September (the one to release) and July.
  const reg = (name, s, e) => call('hcps_mfr_report_register', { manufacturer: 'strongback-mobility', kind: 'sales_export', file_name: name, file_sha256: require('crypto').createHash('sha256').update(name).digest('hex'),
    storage_path: 'reports/strongback-mobility/sales_export/' + require('crypto').createHash('sha256').update(name).digest('hex') + '.csv', file_size: 100, content_type: 'text/csv',
    received_date: '2026-10-02', report_period_start: s, report_period_end: e, actor: 'system:report-capture' });
  const SEP = JSON.parse(reg('Angelo Sep Orders.csv', '2026-09-01', '2026-09-30')).id, JUL = JSON.parse(reg('July orders.csv', '2026-07-01', '2026-07-31')).id;
  const QBEFORE = q(`select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from monthly_sales_quarantine x`);
  const MS = () => q(`select count(*)||'/'||coalesce(sum(amount),0) from monthly_sales`);
  const msBefore = MS();

  t('install: every check ok; nothing written; the quarantine and monthly_sales untouched', () => {
    const out = file(DB, MIE).trim().split('\n').filter(l => /^\d+\|/.test(l));
    assert.strictEqual(out.length, 9, out.join('\n'));
    for (const l of out) assert.ok(/\|t$/.test(l), l);
    assert.strictEqual(q(`select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from monthly_sales_quarantine x`), QBEFORE); assert.strictEqual(MS(), msBefore);
  });
  t('a second run of the migration is safe (no error, nothing changes)', () => {
    const out = file(DB, MIE).trim().split('\n').filter(l => /^\d+\|/.test(l)); for (const l of out) assert.ok(/\|t$/.test(l), l);
  });
  t('RULE 19: anon / authenticated nothing; service_role may only read and call the five functions — never write directly', () => {
    for (const r of ['anon', 'authenticated']) refused(() => as(r, `select count(*) from mfr_quarantine_dispositions`), /permission denied/);
    refused(() => as('anon', `select public.hcps_mfr_quarantine_fp('x','2026-09-01')`), /permission denied/);
    assert.strictEqual(as('service_role', `select count(*) from mfr_import_approvals`), '0');
    refused(() => as('service_role', `insert into mfr_auto_import_log(source_id,outcome,actor) values (${SEP},'held','system:auto-import')`), /permission denied/);
    refused(() => as('service_role', `select public.hcps_mfr_mi_e_president('${PRES}')`), /permission denied/);
  });
  t('the owner cannot write the new tables directly either (guard)', () => {
    refused(() => q(`insert into mfr_quarantine_dispositions(manufacturer,period,disposition,quarantine_ids,quarantine_fp,reason,actor) values ('x','2026-09-01','keep_quarantined','{1}','${'0'.repeat(32)}','a long enough reason','${PRES}')`), /mfr_mi_e_guard/);
  });

  const dispose = (o) => call('hcps_mfr_quarantine_dispose', Object.assign({ manufacturer: 'strongback-mobility', period: '2026-09', quarantine_fp: fp(), release_source_id: SEP,
    reason: 'Blank rows from a mis-mapped commission import', actor: PRES }, o || {}));
  t('disposition: President only (an admin, an inactive President, a forged actor are refused)', () => {
    for (const a of ['staff:ad@hcps.us', 'staff:old@hcps.us', 'angelo@hcps.us', 'system:auto-import']) refused(() => dispose({ actor: a }), /mi_e_president_only/);
    assert.strictEqual(q(`select count(*) from mfr_quarantine_dispositions`), '0');
  });
  t('disposition: refused for rows other than the ones reviewed, a short reason, or a file that is not this month’s unimported export', () => {
    refused(() => dispose({ quarantine_fp: '0'.repeat(32) }), /mi_e_quarantine_changed/);
    refused(() => dispose({ reason: 'short' }), /mi_e_reason_required/);
    refused(() => dispose({ release_source_id: JUL }), /mi_e_bad_release/);
    const stmt = JSON.parse(call('hcps_mfr_report_register', { manufacturer: 'strongback-mobility', kind: 'commission_statement', file_name: '2026-09 SR032.pdf', file_sha256: 'c'.repeat(64),
      storage_path: 'reports/strongback-mobility/commission_statement/' + 'c'.repeat(64) + '.pdf', file_size: 100, content_type: 'application/pdf', received_date: '2026-10-07',
      report_period_start: '2026-09-01', report_period_end: '2026-09-30', actor: 'system:report-capture' })).id;
    refused(() => dispose({ release_source_id: stmt }), /mi_e_bad_release/);
    refused(() => dispose({ period: '2026-08' }), /mi_e_nothing_quarantined/);
    assert.strictEqual(q(`select count(*) from mfr_quarantine_dispositions`), '0');
  });
  t('disposition recorded once: 7 rows, their fingerprint, the released export; a second one is refused', () => {
    const r = JSON.parse(dispose()); assert.deepStrictEqual([r.kept_quarantined, r.release_source_id, r.quarantine_fp], [7, SEP, fp()]);
    refused(() => dispose(), /mi_e_already_disposed/);
    assert.strictEqual(q(`select cardinality(quarantine_ids)||'|'||release_source_id||'|'||actor from mfr_quarantine_dispositions`), `7|${SEP}|${PRES}`);
  });
  t('permanent: the disposed rows can never be restored, changed or deleted — the owner included; truncate refused', () => {
    refused(() => q(`update monthly_sales_quarantine set restored_at = now(), restored_by = 'x' where period = '2026-09-01'`), /mfr_quarantine_locked/);
    refused(() => q(`delete from monthly_sales_quarantine where period = '2026-09-01'`), /mfr_quarantine_locked/);
    refused(() => q(`truncate monthly_sales_quarantine`), /mfr_quarantine_locked/);
    assert.strictEqual(q(`select count(*) from monthly_sales_quarantine where period = '2026-09-01' and restored_at is null`), '7');
  });
  t('other months keep today’s behaviour (the July row can still be handled as before)', () => {
    q(`update monthly_sales_quarantine set evidence = '{"note":"ok"}' where period = '2026-07-01'`);
    assert.strictEqual(q(`select evidence->>'note' from monthly_sales_quarantine where period = '2026-07-01'`), 'ok');
  });
  t('dispositions and the log are append-only even for the owner with the marker set (defence in depth)', () => {
    refused(() => q(`select set_config('hcps.mi_e_op','on',false); update mfr_quarantine_dispositions set reason = 'changed reason here' where id > 0`), /append-only/);
  });
  t('dispositions are append-only (no update / delete, even with the marker as a non-owner)', () => {
    refused(() => q(`update mfr_quarantine_dispositions set reason = 'changed reason here' where id > 0`), /mfr_mi_e_guard/);
    refused(() => q(`delete from mfr_quarantine_dispositions where id > 0`), /mfr_mi_e_guard/);
  });

  const H = c => c.repeat(64);
  const approve = o => call('hcps_mfr_import_approve', Object.assign({ source_id: SEP, plan_hash: H('a'), items: ['quarantine_released'], totals: { amount: 2159 }, reason: 'September orders approved for import', actor: PRES }, o || {}));
  t('approval: President only, a reason, a 64-hex plan; one open approval per file unless replaced', () => {
    refused(() => approve({ actor: 'staff:ad@hcps.us' }), /mi_e_president_only/);
    refused(() => approve({ reason: 'ok' }), /mi_e_reason_required/);
    refused(() => approve({ plan_hash: 'abc' }), /mi_e_bad_request/);
    const a = JSON.parse(approve()); assert.ok(a.approval_id);
    refused(() => approve({ plan_hash: H('b') }), /mi_e_approval_pending/);
    const b = JSON.parse(approve({ plan_hash: H('b'), replace: true })); assert.strictEqual(b.superseded, a.approval_id);
    assert.strictEqual(q(`select used_outcome from mfr_import_approvals where id = ${a.approval_id}`), 'superseded');
  });
  t('approval use: only for its own plan, once; an approval row is never edited otherwise', () => {
    const id = q(`select id from mfr_import_approvals where used_at is null`);
    refused(() => call('hcps_mfr_import_use', { approval_id: id, plan_hash: H('a'), outcome: 'imported', actor: PRES }), /mi_e_plan_changed/);
    JSON.parse(call('hcps_mfr_import_use', { approval_id: id, plan_hash: H('b'), outcome: 'imported', batch_id: '11111111-2222-3333-4444-555555555555', actor: PRES }));
    refused(() => call('hcps_mfr_import_use', { approval_id: id, plan_hash: H('b'), outcome: 'imported', actor: PRES }), /mi_e_approval_used/);
    refused(() => q(`update mfr_import_approvals set reason = 'tampered reason text' where id = ${id}`), /mfr_mi_e_guard/);
  });
  t('the log is append-only; the auto actor or a staff actor only', () => {
    JSON.parse(call('hcps_mfr_auto_import_log', { source_id: SEP, outcome: 'needs_approval', plan_hash: H('b'), detail: { a: 1 }, actor: 'system:auto-import' }));
    refused(() => call('hcps_mfr_auto_import_log', { source_id: SEP, outcome: 'held', actor: 'someone' }), /check/);
    refused(() => q(`update mfr_auto_import_log set outcome = 'imported' where id > 0`), /mfr_mi_e_guard/);
    refused(() => q(`select set_config('hcps.mi_e_op','on',false); update mfr_auto_import_log set outcome = 'imported' where id > 0`), /append-only/);
    refused(() => q(`delete from mfr_auto_import_log where id > 0`), /mfr_mi_e_guard/);
  });
  t('nothing in Phase E wrote monthly_sales or changed the register', () => {
    assert.strictEqual(MS(), msBefore);
    assert.strictEqual(q(`select count(*) from mfr_sources where kind = 'sales_export' and (import_batch_id is not null or status <> 'received')`), '0');
  });
} catch (e) { fail++; console.log('  FAIL setup: ' + String(e.message || e).split('\n').slice(0, 3).join(' | ')); }
finally { try { run('postgres', `drop database if exists ${DB}`); } catch (e) {} }
console.log(`\nmi-e-auto-import (Postgres): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

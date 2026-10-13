/* MI Phase F — supabase/mi_f_commission_events.sql in a REAL Postgres on the MI-1a + MI-1b + Phase E chain: install checks;
   the evidence table is append-only (owner included) and written only by hcps_mfr_commission_event; President only;
   a payment needs evidence, a date and EITHER a statement OR an order; a review names a statement line and a decision;
   a correction supersedes once; RULE 19; nothing touches monthly_sales; a second run is safe.
     PGTEST_PSQL=… PGHOST=… PGPORT=… PGUSER=postgres node test/mi-f-commission-events.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_mif_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f);
const T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
const MIE = SB('mi_e_auto_import.sql'), MIF = process.env.MIF_SQL || SB('mi_f_commission_events.sql');
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

  file(DB, MIE);
  const regS = (name, per) => call('hcps_mfr_report_register', { manufacturer: 'strongback-mobility', kind: 'commission_statement', file_name: name,
    file_sha256: require('crypto').createHash('sha256').update(name).digest('hex'),
    storage_path: 'reports/strongback-mobility/commission_statement/' + require('crypto').createHash('sha256').update(name).digest('hex') + '.pdf', file_size: 100, content_type: 'application/pdf',
    received_date: '2026-10-07', report_period_start: per, report_period_end: per.slice(0, 8) + '30', actor: 'system:report-capture' });
  const SR = JSON.parse(regS('2026-09 SR032.pdf', '2026-09-01')).id;
  const ev = o => call('hcps_mfr_commission_event', Object.assign({ manufacturer: 'strongback-mobility', actor: PRES }, o));
  const PAY = { kind: 'payment', source_id: SR, amount: 336.33, paid_on: '2026-10-15', evidence: 'ACH deposit ref 12345', reason: 'Strongback paid the September statement in full' };

  t('install: every check ok; nothing written; monthly_sales untouched; a second run is safe', () => {
    for (let i = 0; i < 2; i++) { const out = file(DB, MIF).trim().split('\n').filter(l => /^\d+\|/.test(l));
      assert.strictEqual(out.length, 7, out.join('\n')); for (const l of out) assert.ok(/\|t$/.test(l), l); }
    assert.strictEqual(MS(), msBefore);
  });
  t('RULE 19: anon / authenticated nothing; service_role reads and calls the function only — never writes directly', () => {
    for (const r of ['anon', 'authenticated']) { refused(() => as(r, `select count(*) from mfr_commission_events`), /permission denied/);
      refused(() => as(r, `select public.hcps_mfr_commission_event('{}'::jsonb)`), /permission denied/); }
    assert.strictEqual(as('service_role', `select count(*) from mfr_commission_events`), '0');
    refused(() => as('service_role', `insert into mfr_commission_events(manufacturer,kind,reason,actor) values ('x','review','a long enough reason','${PRES}')`), /permission denied/);
  });
  t('President only — an admin, an inactive President or a non-staff actor is refused', () => {
    for (const a of ['staff:ad@hcps.us', 'staff:old@hcps.us', 'angelo@hcps.us', 'system:auto-import']) refused(() => ev(Object.assign({}, PAY, { actor: a })), /mi_f_president_only/);
    assert.strictEqual(q(`select count(*) from mfr_commission_events`), '0');
  });
  t('a payment needs an amount, a date, evidence and EITHER the statement OR one order', () => {
    refused(() => ev(Object.assign({}, PAY, { evidence: '' })), /mfr_commission_events_payment_ck/);
    refused(() => ev(Object.assign({}, PAY, { paid_on: '' })), /mfr_commission_events_payment_ck/);
    refused(() => ev(Object.assign({}, PAY, { amount: 0 })), /mfr_commission_events_payment_ck/);
    refused(() => ev(Object.assign({}, PAY, { order_number: '7060' })), /mfr_commission_events_payment_ck/);
    refused(() => ev(Object.assign({}, PAY, { source_id: '' })), /mfr_commission_events_payment_ck/);
    refused(() => ev(Object.assign({}, PAY, { reason: 'short' })), /reason/);
    const r = JSON.parse(ev(PAY)); assert.strictEqual(r.ok, true);
    const o = JSON.parse(ev({ kind: 'payment', order_number: '6698', amount: 39.6, paid_on: '2026-10-15', evidence: 'remittance line 2', reason: 'paid on its own remittance' })); assert.ok(o.event_id);
  });
  t('a payment or review must name a commission statement of the same manufacturer, still on the register', () => {
    const exp = JSON.parse(call('hcps_mfr_report_register', { manufacturer: 'strongback-mobility', kind: 'sales_export', file_name: 'x.csv', file_sha256: 'a'.repeat(64),
      storage_path: 'reports/strongback-mobility/sales_export/' + 'a'.repeat(64) + '.csv', file_size: 1, content_type: 'text/csv', received_date: '2026-10-02',
      report_period_start: '2026-09-01', report_period_end: '2026-09-30', actor: 'system:report-capture' })).id;
    refused(() => ev(Object.assign({}, PAY, { source_id: exp })), /mi_f_bad_source/);
    refused(() => ev(Object.assign({}, PAY, { manufacturer: 'bemis' })), /mi_f_bad_source/);
    refused(() => ev(Object.assign({}, PAY, { source_id: 999999 })), /mi_f_bad_source/);
  });
  t('a review names a statement line (statement + order) and a decision; it carries no money', () => {
    const base = { kind: 'review', source_id: SR, order_number: '7060', decision: 'investigate', reason: 'not in the YTD workbook — ask Strongback' };
    assert.ok(JSON.parse(ev(base)).event_id);
    assert.ok(JSON.parse(ev(Object.assign({}, base, { order_number: '6800', decision: 'matched_to:6801' }))).event_id);
    refused(() => ev(Object.assign({}, base, { decision: 'pay it' })), /mfr_commission_events_review_ck/);
    refused(() => ev(Object.assign({}, base, { decision: 'matched_to:' })), /mfr_commission_events_review_ck/);
    refused(() => ev(Object.assign({}, base, { amount: 10 })), /mfr_commission_events_review_ck/);
    refused(() => ev(Object.assign({}, base, { order_number: '' })), /mfr_commission_events_review_ck/);
  });
  t('a correction supersedes once, same kind and manufacturer only', () => {
    const first = q(`select min(id) from mfr_commission_events where kind='payment'`);
    assert.ok(JSON.parse(ev(Object.assign({}, PAY, { amount: 300, supersedes_id: first, reason: 'the deposit was 300, not 336.33' }))).event_id);
    refused(() => ev(Object.assign({}, PAY, { supersedes_id: first, reason: 'second correction of the same row' })), /already corrected/);
    const rv = q(`select min(id) from mfr_commission_events where kind='review'`);
    refused(() => ev(Object.assign({}, PAY, { supersedes_id: rv })), /mi_f_bad_supersede/);
  });
  t('append-only: no update, delete or truncate — the owner included', () => {
    refused(() => q(`update mfr_commission_events set amount = 1 where id > 0`), /append-only/);
    refused(() => q(`delete from mfr_commission_events where id > 0`), /append-only/);
    refused(() => q(`truncate mfr_commission_events`), /not allowed/);
    refused(() => q(`insert into mfr_commission_events(manufacturer,kind,reason,actor,source_id,order_number,decision) values ('strongback-mobility','review','a long enough reason','${PRES}',${SR},'1','investigate')`), /written only by/);
  });
  t('nothing in Phase F touched monthly_sales, the quarantine or the register', () => {
    assert.strictEqual(MS(), msBefore);
    assert.strictEqual(q(`select md5(string_agg(to_jsonb(x)::text, '|' order by id)) from monthly_sales_quarantine x`), QBEFORE);
  });
} finally {
  try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
}
console.log(`\nmi-f-commission-events (Postgres): ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

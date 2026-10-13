/* MI — automatic commission-statement processing (_commission_auto.js) against a REAL Postgres (pg-safeupdate loaded)
   with the real MI-1a + MI-1b + Phase E SQL, the real hcps_commission_file_apply, and the importer's OWN code
   (commissions-api internals) running unchanged behind the local Supabase stand-in (test/academy-pgrest.js).
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… node test/commission-auto.pg.test.js */
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const XLSX = require('xlsx');
const PSQL = process.env.PGTEST_PSQL || 'psql';
const DB = 'hcps_cauto_' + process.pid;
const run = (db, sql) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr || ('psql exit ' + r.status)); return r.stdout.trim(); };
const file = (db, f) => { const r = spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(path.basename(f) + ': ' + r.stderr); return r.stdout; };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres (' + String(e.message).split('\n')[0] + ')'); process.exit(0); }
const SB = f => path.join(__dirname, '..', 'supabase', f), T = f => path.join(__dirname, f), ROOTF = f => path.join(__dirname, '..', f);
let pass = 0, fail = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const q = sql => run(DB, sql);
const call = (fn, o) => q(`select public.${fn}('${JSON.stringify(o).replace(/'/g, "''")}'::jsonb)::text`);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
const { shim, BASE } = require('./academy-pgrest.js');
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
const api = shim({ db: DB, psql: PSQL });
global.fetch = api.fetch;
const CA = require(process.env.COMMISSION_AUTO_PATH || '../netlify/functions/_commission_auto.js');
const internal = require('../netlify/functions/commissions-api.js').internal;
const { flagOn } = require('../netlify/functions/_flags.js');

(async () => {
  try {
    for (const f of [T('mi1a/fixture.sql'), SB('mi1a_part0_snapshot.sql'), SB('mi1a_part1_schema.sql'), T('mc-guard.stub.sql'), ROOTF('migrate-phase2-product-skus.sql'),
      T('mc-guard.data.sql'), SB('mc_phase1_foundation.sql'), SB('mc_phase1_backfill.sql'), SB('mc_phase2_freeze_guard.sql'), SB('mc_phase6_append_only.sql'),
      SB('mi1b_report_register.sql')]) file(DB, f);
    q(`create table if not exists staff_users (email text primary key, role text, active boolean default true, name text);
       insert into staff_users values ('angelo@hcps.us','president',true,'Angelo') on conflict do nothing`);
    const cl = fs.readFileSync(SB('commission_sept2026_cleanup.sql'), 'utf8');
    q(cl.slice(cl.indexOf('create table if not exists public.monthly_sales_quarantine'), cl.indexOf('-- The 7 rows, by id')));
    file(DB, SB('mi_e_auto_import.sql'));
    q(`create table if not exists app_settings (key text primary key, value jsonb, updated_at timestamptz default now());
       alter table dealers add column if not exists address text;
       create table if not exists dealer_aliases (alias_norm text primary key, dealer_id uuid);
       create table if not exists dealer_manufacturers (dealer_id uuid, manufacturer text, account_ref text);
       insert into manufacturers values ('access4u','Access4u'),('golden-technologies','Golden Technologies') on conflict do nothing;
       insert into dealers(id,business_name,city,state,zip) values
         ('00000000-0000-0000-0000-0000000000d1','Mobility Plus','Alpharetta','GA','30009'),
         ('00000000-0000-0000-0000-0000000000d2','Med Mart','Nashville','TN','37211');
       insert into app_settings(key,value) values ('phase2_flags','{"mi_commission_v2":true}'),
         ('ctpl:golden-technologies','{"customer_name":"CustomerName","customer_ref":"CustomerNo","amount":"ExtendedPrice","commission":"CommissionAmount","order_date":"SOOrderDate","product_code":"Model","qty":"QTY","invoice_no":"CredInvoiceNo"}')`);
  } catch (e) { console.log('SETUP FAILED: ' + e.message); run('postgres', `drop database if exists ${DB}`); process.exit(1); }

  // ---- files ----------------------------------------------------------------------------------------------------
  const store = new Map();
  const csv = rows => Buffer.from(rows.map(r => r.join(',')).join('\n') + '\n');
  const golden = (lines, extra) => csv([['CustomerName', 'CustomerNo', 'Model', 'QTY', 'ExtendedPrice', 'CommissionAmount', 'SOOrderDate', 'CredInvoiceNo'], ...lines].concat(extra || []));
  const xlsx = aoa => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
  const a4u = (extraRow) => xlsx([['Transaction List by Client'], [],
    ['', 'Date', 'Transaction type', 'Num', 'Memo/Description', 'Amount', 'Net Sale', '%', 'Commission', 'Rep'],
    ['Mobility Plus'], ['', '09/03/2026', 'Payment', '1001', 'R-5001', '1000.00', '1000.00', '5', '50.00', 'AA'],
    ['', '09/04/2026', 'Invoice', 'R-5002', 'PO 77', '400.00', '', '5', '', 'AA'],
    ['Med Mart'], ['', '09/10/2026', 'Payment', '1002', 'R-4999', '200.00', '200.00', '5', '10.00', 'AA']].concat(extraRow ? [extraRow] : []));
  let nreg = 0;
  function register(mfr, name, bytes, ext, startEnd, kind) {
    const h = sha(bytes), p = `reports/${mfr}/${kind || 'commission_statement'}/${h}.${ext}`;
    store.set(p, bytes); nreg++;
    return JSON.parse(call('hcps_mfr_report_register', { manufacturer: mfr, kind: kind || 'commission_statement', file_name: name, file_sha256: h, storage_path: p,
      file_size: bytes.length, content_type: ext === 'pdf' ? 'application/pdf' : ext === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      received_date: '2026-10-12', report_period_start: startEnd[0], report_period_end: startEnd[1], actor: 'system:report-capture' })).id;
  }
  const sr032 = { 'sr': ['September 2026', 'Staff Member: Angelo Audia', 'Order Number Company Subtotal Commission Due', '6698 Medmart $440.00 $39.60', '7060 Williams Brothers $1,037.00 $93.33',
    'Total Orders: $1,477.00', 'Total Commission Due: $132.93'] };
  const rpcHooks = {};
  const rpcCalls = [];
  async function rpc(fn, p) {
    rpcCalls.push(fn + ':' + ((p && p.source_file) || ''));
    if (rpcHooks[fn]) { const forced = await rpcHooks[fn](p); if (forced) return forced; }
    const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p }) });
    const text = await r.text(); let body; try { body = JSON.parse(text); } catch (x) { body = { message: text }; }
    if (r.ok) return { ok: true, body };
    const msg = String((body && body.message) || text); const m = msg.match(/\b(mi1a_[a-z_]+|mi1b_[a-z_]+|mi_e_[a-z_]+)\b/);
    return { ok: false, code: m ? m[1] : 'database_error', message: msg };
  }
  const sbGet = async p => { const r = await fetch(`${BASE}/rest/v1/${p}`); if (!r.ok) throw new Error('get ' + r.status + ' ' + (await r.text())); return r.json(); };
  const sbGetAll = async (base, order) => sbGet(`${base}${base.includes('?') ? '&' : '?'}order=${order}`);
  const accountCalls = [];
  const deps = {
    sbGet, sbGetAll, sbGetOptional: sbGet, rpc,
    fetchObject: async p => { if (!store.has(p)) throw new Error('missing'); return store.get(p); },
    flagOn: n => flagOn(sbGet, n),
    ci: Object.assign({}, internal, { orgAccounts: { reconcileAccountRef: async (slug, id, ref) => { accountCalls.push([slug, id, ref]); return { status: 'set' }; } } }),
    extractLayout: async b => ({ pages: [{ lines: (sr032[b.toString()] || []).map(text => ({ text })) }] }),
  };
  const P = () => CA.make(deps).processAll({ budgetMs: 60000 });
  const MS = (m) => q(`select count(*)||'|'||trim_scale(coalesce(sum(amount),0))||'|'||trim_scale(coalesce(sum(commission),0)) from monthly_sales where manufacturer='${m}'`);
  const rec = id => JSON.parse(q(`select row_to_json(x)::text from (select status, import_batch_id from mfr_sources where id=${id}) x`));
  const lastLog = id => JSON.parse(q(`select row_to_json(x)::text from (select outcome, batch_id, detail, actor from mfr_auto_import_log where source_id=${id} order by id desc limit 1) x`) || 'null');
  const logCount = id => Number(q(`select count(*) from mfr_auto_import_log where source_id=${id}`));
  const result = (r, id) => r.results.find(x => x.source_id === id);

  // ---- tests ------------------------------------------------------------------------------------------------------
  let G1;
  t('clean Golden statement (saved template): accepted, applied by the guarded importer, batch linked, totals exact', async () => {
    G1 = register('golden-technologies', 'Golden Sept 2026.csv', golden([['Mobility Plus', 'C1', 'PR-118', '1', '1500.00', '75.00', '09/02/2026', 'I-1'], ['Med Mart', 'C2', 'PR-401', '2', '2000.00', '100.00', '09/15/2026', 'I-2']]), 'csv', ['2026-09-01', '2026-09-30']);
    const before = MS('golden-technologies');
    const r = await P(); const x = result(r, G1);
    assert.strictEqual(x.outcome, 'imported', JSON.stringify(lastLog(G1)));
    assert.strictEqual(MS('golden-technologies'), before.split('|')[0] * 1 + 2 + '|3500|175');
    const s = rec(G1); assert.strictEqual(s.status, 'accepted'); assert.ok(s.import_batch_id);
    assert.strictEqual(q(`select count(*) from monthly_sales where batch_id='${s.import_batch_id}' and source='commission' and source_file='Golden Sept 2026.csv' and dealer_id is not null`), '2');
    const l = lastLog(G1); assert.strictEqual(l.actor, 'system:auto-import'); assert.strictEqual(l.detail.final, true); assert.strictEqual(l.detail.code, 'imported');
    assert.strictEqual(accountCalls.length, 2);
  });
  t('a second run does nothing for a finished record (no write, no new log row)', async () => {
    const n = logCount(G1), ms = MS('golden-technologies'); rpcCalls.length = 0; await P();
    assert.strictEqual(logCount(G1), n); assert.strictEqual(MS('golden-technologies'), ms);
    assert.ok(!rpcCalls.some(c => /^hcps_commission_file_apply:Golden Sept 2026\.csv$/.test(c)), 'finished records are not looked at again: ' + rpcCalls.join(','));
  });
  t('same lines under another file name: "already in HCPS", nothing written, record accepted', async () => {
    const id = register('golden-technologies', 'Golden September statement (copy).csv',
      golden([['Mobility Plus', 'C1', 'PR-118', '1', '1500.00', '75.00', '09/02/2026', 'I-1'], ['Med Mart', 'C2', 'PR-401', '2', '2000.00', '100.00', '09/15/2026', 'I-2']], [['', '', '', '', '', '', '', '']]), 'csv', ['2026-09-01', '2026-09-30']);
    const ms = MS('golden-technologies'); const r = await P();
    assert.strictEqual(result(r, id).code, 'already_in_hcps'); assert.strictEqual(MS('golden-technologies'), ms);
    assert.strictEqual(rec(id).status, 'accepted'); assert.strictEqual(rec(id).import_batch_id, null); assert.deepStrictEqual(lastLog(id).detail.identical_to, ['Golden Sept 2026.csv']);
    rpcCalls.length = 0; const n = logCount(id); await P();
    assert.ok(!rpcCalls.includes('hcps_commission_file_apply:Golden September statement (copy).csv'), 'a finished no-write record is not processed again'); assert.strictEqual(logCount(id), n);
  });
  t('identical lines but ANOTHER problem (a cross-lane duplicate): never waived — needs Angelo', async () => {
    q(`insert into monthly_sales(manufacturer, period, amount, qty, commission, source, external_ref) values ('golden-technologies','2026-09-01',1500,1,0,'sales_report','x-sep')`);
    const id = register('golden-technologies', 'Golden Sept 2026 (third copy).csv',
      golden([['Mobility Plus', 'C1', 'PR-118', '1', '1500.00', '75.00', '09/02/2026', 'I-1'], ['Med Mart', 'C2', 'PR-401', '2', '2000.00', '100.00', '09/15/2026', 'I-2']], [['', '', '', '', '', '', '', ''], ['', '', '', '', '', '', '', '']]), 'csv', ['2026-09-01', '2026-09-30']);
    const ms = MS('golden-technologies'); const r = await P();
    assert.strictEqual(result(r, id).code, 'needs_decision'); assert.ok(lastLog(id).detail.problems.some(p => p.error === 'cross_lane_duplicate'));
    assert.strictEqual(rec(id).status, 'received'); assert.strictEqual(MS('golden-technologies').split('|')[0] * 1, ms.split('|')[0] * 1);
    q(`delete from monthly_sales where external_ref='x-sep'`);
  });
  let G3;
  t('different lines for a month already on file: needs Angelo\'s decision, nothing written; logged once per plan', async () => {
    G3 = register('golden-technologies', 'Golden Sept 2026 corrected.csv', golden([['Mobility Plus', 'C1', 'PR-118', '1', '1500.00', '80.00', '09/02/2026', 'I-1']]), 'csv', ['2026-09-01', '2026-09-30']);
    const ms = MS('golden-technologies'); const r = await P();
    assert.strictEqual(result(r, G3).outcome, 'needs_approval'); assert.strictEqual(result(r, G3).code, 'needs_decision');
    assert.strictEqual(MS('golden-technologies'), ms); assert.strictEqual(rec(G3).status, 'received');
    assert.ok(lastLog(G3).detail.problems.some(p => p.error === 'decision_required'));
    const n = logCount(G3); await P(); assert.strictEqual(logCount(G3), n, 'the same plan is not logged again');
  });
  let G4;
  t('an unmatched dealer holds the statement (nothing written); once the dealer is matched the next run imports it', async () => {
    G4 = register('golden-technologies', 'Golden Aug 2026.csv', golden([['Mobility Plus', 'C1', 'PR-118', '1', '900.00', '45.00', '08/05/2026', 'I-9'], ['Unknown Medical Shop', 'C9', 'PR-118', '1', '100.00', '5.00', '08/06/2026', 'I-10']]), 'csv', ['2026-08-01', '2026-08-31']);
    const ms = MS('golden-technologies'); let r = await P();
    assert.strictEqual(result(r, G4).code, 'dealers_need_review'); assert.strictEqual(MS('golden-technologies'), ms);
    assert.deepStrictEqual(lastLog(G4).detail.unmatched.map(u => u.name), ['Unknown Medical Shop']);
    q(`insert into dealer_aliases values ('UNKNOWN MEDICAL SHOP','00000000-0000-0000-0000-0000000000d2')`);
    r = await P(); assert.strictEqual(result(r, G4).outcome, 'imported'); assert.ok(rec(G4).import_batch_id);
  });
  t('no saved column mapping: exception, nothing read into monthly_sales', async () => {
    q(`insert into manufacturers values ('bemis','Bemis') on conflict do nothing`);
    const id = register('bemis', '705-2026-09.csv', csv([['Customer', 'Sales', 'Comm'], ['Med Mart', '10', '1']]), 'csv', ['2026-09-01', '2026-09-30']);
    const r = await P(); assert.strictEqual(result(r, id).code, 'no_template'); assert.strictEqual(MS('bemis'), '0|0|0');
  });
  t('incomplete statement (a blank commission): refused by the importer\'s own gate, nothing written', async () => {
    const id = register('golden-technologies', 'Golden Jul 2026.csv', golden([['Mobility Plus', 'C1', 'PR-118', '1', '900.00', '', '07/05/2026', 'I-20']]), 'csv', ['2026-07-01', '2026-07-31']);
    const ms = MS('golden-technologies'); const r = await P();
    assert.strictEqual(result(r, id).code, 'statement_incomplete'); assert.strictEqual(MS('golden-technologies'), ms);
  });
  t('a multi-month record and a PDF statement are exceptions (never guessed)', async () => {
    const a = register('golden-technologies', 'Golden Q2.csv', golden([['Mobility Plus', 'C1', 'X', '1', '1', '1', '04/01/2026', 'I-30']]), 'csv', ['2026-04-01', '2026-06-30']);
    const b = register('golden-technologies', 'Golden statement.pdf', Buffer.from('%PDF-golden'), 'pdf', ['2026-06-01', '2026-06-30']);
    const r = await P(); assert.strictEqual(result(r, a).code, 'multi_month_statement'); assert.strictEqual(result(r, b).code, 'pdf_statement');
  });
  t('Access4U grouped ledger: read by the page\'s own reader and imported (payments + open invoices)', async () => {
    const id = register('access4u', 'HomeCare September 2026 Commissions Report.xlsx', a4u(), 'xlsx', ['2026-09-01', '2026-09-30']);
    const r = await P(); assert.strictEqual(result(r, id).outcome, 'imported', JSON.stringify(lastLog(id).detail));
    assert.strictEqual(MS('access4u'), '3|1200|60');
    assert.strictEqual(q(`select count(*) from monthly_sales where manufacturer='access4u' and line_type='INVOICE' and billed_amount=400`), '1');
  });
  t('Strongback SR032: statement evidence only — accepted, NEVER posted to monthly_sales', async () => {
    const id = register('strongback-mobility', '2026-09 SR032.pdf', Buffer.from('sr'), 'pdf', ['2026-09-01', '2026-09-30']);
    const ms = MS('strongback-mobility'); const r = await P();
    assert.strictEqual(result(r, id).code, 'statement_evidence'); assert.strictEqual(MS('strongback-mobility'), ms);
    assert.strictEqual(rec(id).status, 'accepted'); assert.strictEqual(rec(id).import_batch_id, null); assert.strictEqual(lastLog(id).detail.total_due, 132.93);
  });
  t('Strongback SR032 whose lines do not add up: exception, not accepted', async () => {
    sr032.bad = ['August 2026', '6698 Medmart $440.00 $39.60', 'Total Orders: $500.00', 'Total Commission Due: $39.60'];
    const id = register('strongback-mobility', '2026-08 SR032.pdf', Buffer.from('bad'), 'pdf', ['2026-08-01', '2026-08-31']);
    const r = await P(); assert.strictEqual(result(r, id).code, 'statement_problems'); assert.strictEqual(rec(id).status, 'received');
  });
  t('a by-hand import of the same file name (after registration) is linked; nothing else written', async () => {
    const id = register('golden-technologies', 'Golden May 2026.csv', golden([['Med Mart', 'C2', 'PR-1', '1', '50.00', '2.50', '05/02/2026', 'I-40']]), 'csv', ['2026-05-01', '2026-05-31']);
    const months = [{ period: '2026-05-01', rows: [{ manufacturer: 'golden-technologies', period: '2026-05-01', customer_name: 'Med Mart', amount: 50, commission: 2.5, source: 'commission' }] }];
    const b = JSON.parse(call('hcps_commission_file_apply', { manufacturer: 'golden-technologies', source_file: 'Golden May 2026.csv', apply: true, actor: 'angelo@hcps.us', months, decisions: {} })).batch_id;
    const ms = MS('golden-technologies'); const r = await P();
    assert.strictEqual(result(r, id).code, 'linked_manual_import'); assert.strictEqual(rec(id).import_batch_id, b); assert.strictEqual(MS('golden-technologies'), ms);
  });
  t("two by-hand imports with the record's file name: which one belongs to it is a person's call (held, nothing linked)", async () => {
    const id = register('golden-technologies', 'Golden Apr 2026.csv', golden([['Med Mart', 'C2', 'PR-1', '1', '50.00', '2.50', '04/02/2026', 'I-45']]), 'csv', ['2026-04-01', '2026-04-30']);
    for (const per of ['2026-04-01', '2025-04-01']) call('hcps_commission_file_apply', { manufacturer: 'golden-technologies', source_file: 'Golden Apr 2026.csv', apply: true, actor: 'angelo@hcps.us',
      months: [{ period: per, rows: [{ manufacturer: 'golden-technologies', period: per, customer_name: 'Med Mart', amount: 51, commission: 2.55, source: 'commission' }] }], decisions: {} });
    const r = await P(); assert.strictEqual(result(r, id).code, 'several_manual_imports'); assert.strictEqual(rec(id).import_batch_id, null);
  });
  t('a paid / locked month needs approval (nothing written)', async () => {
    q(`insert into commission_period_locks(manufacturer, period, locked_by, note) values ('golden-technologies','2026-03-01','angelo','paid')`);
    const id = register('golden-technologies', 'Golden Mar 2026.csv', golden([['Med Mart', 'C2', 'PR-1', '1', '50.00', '2.50', '03/02/2026', 'I-50']]), 'csv', ['2026-03-01', '2026-03-31']);
    const ms = MS('golden-technologies'); const r = await P();
    assert.strictEqual(result(r, id).code, 'needs_decision'); assert.ok(lastLog(id).detail.problems.some(p => p.error === 'paid_period_change')); assert.strictEqual(MS('golden-technologies'), ms);
  });
  t('a cross-lane duplicate (same amount and qty already in the sales-report lane) needs approval', async () => {
    q(`insert into monthly_sales(manufacturer, period, amount, qty, commission, source, external_ref) values ('golden-technologies','2026-02-01',777,1,0,'sales_report','x-1')`);
    const id = register('golden-technologies', 'Golden Feb 2026.csv', golden([['Med Mart', 'C2', 'PR-1', '1', '777.00', '38.85', '02/02/2026', 'I-60']]), 'csv', ['2026-02-01', '2026-02-28']);
    const r = await P(); assert.ok(lastLog(id).detail.problems.some(p => p.error === 'cross_lane_duplicate'), JSON.stringify(result(r, id)));
  });
  t('the applied result must equal the dry run, else the batch is rolled back (monthly_sales unchanged)', async () => {
    const id = register('golden-technologies', 'Golden Jan 2026.csv', golden([['Med Mart', 'C2', 'PR-1', '1', '60.00', '3.00', '01/02/2026', 'I-70']]), 'csv', ['2026-01-01', '2026-01-31']);
    const ms = MS('golden-technologies');
    rpcHooks.hcps_commission_file_apply = async p => { if (!p.apply) return null; delete rpcHooks.hcps_commission_file_apply; const r = await rpc('hcps_commission_file_apply', p); r.body.will_write.commission = 99; return r; };
    const r = await P(); assert.strictEqual(result(r, id).outcome, 'rolled_back'); assert.strictEqual(MS('golden-technologies'), ms); assert.strictEqual(rec(id).import_batch_id, null);
    const n = logCount(id); const r2 = await P(); assert.ok(!result(r2, id), 'a rolled-back record is not retried automatically'); assert.strictEqual(logCount(id), n);
  });
  t('a refused link rolls the batch back too', async () => {
    const id = register('golden-technologies', 'Golden Dec 2025.csv', golden([['Med Mart', 'C2', 'PR-1', '1', '70.00', '3.50', '12/02/2025', 'I-80']]), 'csv', ['2025-12-01', '2025-12-31']);
    const ms = MS('golden-technologies');
    rpcHooks.hcps_mfr_report_link_batch = async () => { delete rpcHooks.hcps_mfr_report_link_batch; return { ok: false, code: 'mi1b_bad_link', message: 'mi1b_bad_link: test' }; };
    const r = await P(); assert.strictEqual(result(r, id).outcome, 'rolled_back'); assert.strictEqual(MS('golden-technologies'), ms);
  });
  t('a changed stored file is never read', async () => {
    const id = register('golden-technologies', 'Golden Nov 2025.csv', golden([['Med Mart', 'C2', 'PR-1', '1', '1', '1', '11/02/2025', 'I-90']]), 'csv', ['2025-11-01', '2025-11-30']);
    const p = JSON.parse(q(`select to_json(storage_path) from mfr_sources where id=${id}`)); store.set(p, Buffer.from('tampered'));
    const r = await P(); assert.strictEqual(result(r, id).code, 'file_changed');
  });
  t('switch off: the processor does nothing at all', async () => {
    q(`update app_settings set value='{"mi_commission_v2":false}' where key='phase2_flags'`);
    const n = Number(q(`select count(*) from mfr_auto_import_log`)); const r = await P();
    assert.strictEqual(r.skipped, 'switch_off'); assert.strictEqual(Number(q(`select count(*) from mfr_auto_import_log`)), n);
    q(`update app_settings set value='{"mi_commission_v2":true}' where key='phase2_flags'`);
  });

  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 4).join(' | ')); }
  }
  run('postgres', `drop database if exists ${DB}`);
  console.log(`\ncommission-auto (Postgres): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

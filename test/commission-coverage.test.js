/* Commission coverage + statement gate + learned-alias target (RULE, Angelo 2026-10-10).
   Part A runs the pure module (_commission_coverage.js) on cases taken from production (Strongback
   September blank rows, AirAvant "Invoice"-typed statement lines, GCE open invoices, Climbing Steps cash
   sale, sales-report estimates, a documented $0 statement). Part B runs the REAL commissions-api.js and
   sales-import-api.js on the in-memory PostgREST fake: the coverage grid, refusals before any write, and
   the alias rule.   node test/commission-coverage.test.js */
const assert = require('assert');
const path = require('path');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

// The module as the functions get it (a mutant in it applies here too).
function CCmod() { const w = createWorld(standardSeed()); load('_commission_coverage.js', w); return require(path.join(__dirname, '..', 'netlify', 'functions', '_commission_coverage.js')); }
const dnorm = n => String(n || '').toUpperCase().replace(/HEALTH ?CARE/g, 'HEALTHCARE').replace(/[.,'&/#-]/g, ' ').replace(/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi, ' ').replace(/\s+/g, ' ').trim();

const SB_SEPT = Array.from({ length: 7 }, (_, i) => ({ id: 'sb-sep-' + i, manufacturer: 'strongback-mobility', period: '2026-09-01', source: 'commission',
  amount: null, commission: null, billed_amount: null, line_type: null, customer_name: 'Harmon Medical Supply', source_file: 'Strongback Sept Commission Report 2026.csv' }));
const AIRAVANT = [{ id: 'aa-1', manufacturer: 'airavant-bongorx', period: '2026-06-01', source: 'commission', line_type: 'INVOICE', amount: 1290, commission: 193.5 }];
const GCE_OPEN = [{ id: 'g-1', manufacturer: 'ohio-medical', period: '2026-06-01', source: 'commission', line_type: 'INVOICE', amount: null, commission: null, billed_amount: 13260 }];
const GCE_BLANKPAY = [{ id: 'g-2', manufacturer: 'ohio-medical', period: '2026-04-01', source: 'commission', line_type: 'PAYMENT', amount: null, commission: null, billed_amount: null },
  { id: 'g-3', manufacturer: 'ohio-medical', period: '2026-04-01', source: 'commission', line_type: 'INVOICE', amount: null, commission: null, billed_amount: 500 }];
const CS_CASH = [{ id: 'c-1', manufacturer: 'climbing-steps', period: '2026-05-01', source: 'commission', line_type: 'CASH SALE', amount: 1466.5, commission: null }];
const SB_SR = [{ id: 's-1', manufacturer: 'strongback-mobility', period: '2026-07-01', source: 'sales_report', external_ref: 'strongback-mobility|v2|O:1|X|1', amount: 536, commission: 48.24 }];
const PF_SR = [{ id: 'p-1', manufacturer: 'pedifix', period: '2026-03-01', source: 'sales_report', external_ref: 'pedifix|1|X|0', amount: 100, commission: 9 }];
const ZERO = [{ id: 'z-1', manufacturer: 'bemis', period: '2026-02-01', source: 'commission', amount: 0, commission: 0 }];
const MIXED = [{ id: 'b-1', manufacturer: 'bemis', period: '2026-06-01', source: 'commission', amount: 120, commission: 10.8 },
  { id: 'b-2', manufacturer: 'bemis', period: '2026-06-01', source: 'commission', amount: null, commission: null }];
const LEGACY = [{ id: 'l-1', manufacturer: 'golden-technologies', period: '2025-01-01', source: null, external_ref: null, amount: 900, commission: 45 },
  { id: 'l-2', manufacturer: 'access4u', period: '2025-02-01', source: null, external_ref: 'access4u|9|x|0', amount: 900, commission: 45 }];

(async () => {
  /* ── A. The one definition ── */
  await t('Strongback September: 7 blank commission rows are NOT a received report (incomplete, with the reason)', async () => {
    const c = CCmod().coverage(SB_SEPT);
    assert.ok(!(c.received['strongback-mobility'] || []).includes('2026-09'));
    assert.ok(!(c.estimated['strongback-mobility'] || []).includes('2026-09'));
    const x = (c.incomplete['strongback-mobility'] || [])[0];
    assert.ok(x && x.period === '2026-09' && x.rows === 7 && /7 blank rows/.test(x.reason), JSON.stringify(c));
  });
  await t('a documented zero-dollar statement (explicit 0) counts as received; NULL never does', async () => {
    const M = CCmod();
    assert.deepStrictEqual(M.coverage(ZERO).received, { bemis: ['2026-02'] });
    for (const v of [null, undefined, '', ' ', '-', 'abc', NaN]) assert.strictEqual(M.isNum(v), false, 'isNum(' + JSON.stringify(v) + ')');
    for (const v of [0, '0', '0.00', '$1,200.50', -3, '-3.5']) assert.strictEqual(M.isNum(v), true, 'isNum(' + JSON.stringify(v) + ')');
  });
  await t('AirAvant statement lines typed "Invoice" with sale + commission are received statements', async () => {
    assert.deepStrictEqual(CCmod().coverage(AIRAVANT).received, { 'airavant-bongorx': ['2026-06'] });
  });
  await t('GCE open invoices only (billed, no commission yet) = not received, reason "open invoice"', async () => {
    const c = CCmod().coverage(GCE_OPEN);
    assert.deepStrictEqual(c.received, {}); assert.ok(/1 open invoice/.test(c.incomplete['ohio-medical'][0].reason));
  });
  await t('GCE blank payment rows + an open invoice = not received (both reasons named)', async () => {
    const x = CCmod().coverage(GCE_BLANKPAY).incomplete['ohio-medical'][0];
    assert.ok(/1 blank row/.test(x.reason) && /1 open invoice/.test(x.reason), x.reason);
  });
  await t('a sale with no commission figure (Climbing Steps cash sale) = not received', async () => {
    const c = CCmod().coverage(CS_CASH);
    assert.deepStrictEqual(c.received, {}); assert.ok(/sales but no commission/.test(c.incomplete['climbing-steps'][0].reason));
  });
  await t('a sales report alone is an ESTIMATE, never a received statement (Strongback 9%)', async () => {
    const c = CCmod().coverage(SB_SR);
    assert.deepStrictEqual(c.received, {}); assert.deepStrictEqual(c.estimated, { 'strongback-mobility': ['2026-07'] });
  });
  await t('PediFix sales report counts as its statement (RULE 14 list) — and only while it is on the list', async () => {
    const M = CCmod();
    assert.deepStrictEqual(M.coverage(PF_SR).received, { pedifix: ['2026-03'] });
    const off = M.coverage(PF_SR, { statement_sales_reports: [] });
    assert.deepStrictEqual(off.received, {}); assert.deepStrictEqual(off.estimated, { pedifix: ['2026-03'] });
  });
  await t('a month with valid statement lines stays received even if some rows are blank (history preserved)', async () => {
    assert.deepStrictEqual(CCmod().coverage(MIXED).received, { bemis: ['2026-06'] });
  });
  await t('legacy commission rows (no source, no external_ref) count; a no-source row WITH an external_ref is not commission-lane', async () => {
    const c = CCmod().coverage(LEGACY);
    assert.deepStrictEqual(c.received, { 'golden-technologies': ['2025-01'] });
    assert.ok(!c.received.access4u);
  });
  await t('received wins over estimate in the same month; a month is in exactly one bucket', async () => {
    const c = CCmod().coverage(SB_SR.concat([{ manufacturer: 'strongback-mobility', period: '2026-07-01', source: 'commission', amount: 536, commission: 48.24 }]));
    assert.deepStrictEqual(c.received, { 'strongback-mobility': ['2026-07'] }); assert.deepStrictEqual(c.estimated, {});
  });

  /* ── A2. The import gate ── */
  await t('gate: an order export with no amount / commission columns is refused, naming both columns', async () => {
    const v = CCmod().validateStatement(SB_SEPT, { mapped_fields: ['customer_name', 'product_code', 'ship_zip'] });
    assert.strictEqual(v.ok, false); assert.strictEqual(v.error, 'statement_incomplete');
    assert.deepStrictEqual(v.missing_mappings.sort(), ['amount', 'commission']);
    assert.ok(/Sales amount \(\$\) and Commission \(\$\)/.test(v.message) && /Nothing was written/.test(v.message), v.message);
  });
  await t('gate: unmapped columns are detected from the rows even when the browser sends no mapping', async () => {
    const v = CCmod().validateStatement(SB_SEPT, {});
    assert.strictEqual(v.ok, false); assert.deepStrictEqual(v.missing_mappings.sort(), ['amount', 'commission']);
  });
  await t('gate: ONE blank commission among valid lines refuses the whole file, with the row number; blanks are never 0', async () => {
    const rows = [{ customer_name: 'A', amount: 100, commission: 10 }, { customer_name: 'B', amount: 50, commission: '' }];
    const v = CCmod().validateStatement(rows, { mapped_fields: ['customer_name', 'amount', 'commission'] });
    assert.strictEqual(v.ok, false); assert.strictEqual(v.missing.commission, 1);
    assert.deepStrictEqual(v.examples[0], { row: 2, field: 'commission', customer: 'B', line_type: null });
    assert.strictEqual(rows[1].commission, '', 'the input is not rewritten');
  });
  await t('gate: explicit 0 commission passes (documented zero-dollar line)', async () => {
    assert.strictEqual(CCmod().validateStatement([{ amount: 0, commission: 0 }], { mapped_fields: ['amount', 'commission'] }).ok, true);
  });
  await t('gate: GCE ledger — open invoices need a billed amount, payments need sale + commission', async () => {
    const M = CCmod();
    assert.strictEqual(M.validateStatement([{ line_type: 'INVOICE', billed_amount: 500 }, { line_type: 'PAYMENT', amount: 400, commission: 20 }], { ledger: true }).ok, true);
    const v = M.validateStatement(GCE_BLANKPAY.concat([{ line_type: 'PAYMENT', amount: 1, commission: 1 }]), { ledger: true });
    assert.strictEqual(v.ok, false); assert.strictEqual(v.missing.amount, 1); assert.strictEqual(v.missing.commission, 1);
  });
  await t('gate: an open invoice with no billed amount is refused even beside a valid payment', async () => {
    const v = CCmod().validateStatement([{ line_type: 'INVOICE' }, { line_type: 'PAYMENT', amount: 400, commission: 20 }], { ledger: true });
    assert.strictEqual(v.ok, false); assert.strictEqual(v.missing.billed_amount, 1);
  });
  await t('gate: column-mapped file with amount/commission unmapped is named as such even when every row is an open invoice', async () => {
    const v = CCmod().validateStatement([{ line_type: 'Invoice', billed_amount: 10 }], { mapped_fields: ['customer_name', 'line_type'] });
    assert.strictEqual(v.ok, false); assert.deepStrictEqual(v.missing_mappings.sort(), ['amount', 'commission']);
  });
  await t('coverage: blank commission rows + a sales-report estimate in one month = incomplete (the blank load is named), not estimate', async () => {
    const c = CCmod().coverage(SB_SEPT.concat([{ manufacturer: 'strongback-mobility', period: '2026-09-01', source: 'sales_report', external_ref: 'x', amount: 2159, commission: 194.31 }]));
    assert.deepStrictEqual(c.estimated, {}); assert.strictEqual(c.incomplete['strongback-mobility'][0].period, '2026-09');
  });
  await t('gate: a file of open invoices only is not a commission statement', async () => {
    const v = CCmod().validateStatement(GCE_OPEN, { ledger: true });
    assert.strictEqual(v.ok, false); assert.ok(/No line in this file carries a commission figure/.test(v.message), v.message);
  });
  await t('gate: AirAvant "Invoice"-typed statement lines pass', async () => {
    assert.strictEqual(CCmod().validateStatement(AIRAVANT, { mapped_fields: ['customer_name', 'amount', 'commission', 'line_type'] }).ok, true);
  });

  /* ── A3. Learned alias target ── */
  const WB = [{ id: 'hq', business_name: 'Williams Brothers Washington HQ', city: 'Washington', parent_id: null },
    { id: 'pri', business_name: 'Williams Brothers Princeton', city: 'Princeton', parent_id: 'hq' },
    { id: 'vin', business_name: 'Williams Brothers Vincennes', city: 'Vincennes', parent_id: 'hq' },
    { id: 'solo', business_name: 'Harmon Medical Supply', city: 'Vincennes', parent_id: null }];
  await t('alias: a generic company name chosen on Princeton is saved on the company (HQ), not the branch', async () => {
    assert.deepStrictEqual(CCmod().aliasTarget(WB, 'pri', 'Williams Brothers Healthcare Pharmacy', dnorm), { dealer_id: 'hq', scope: 'company', moved_from: 'pri' });
  });
  await t('alias: a name that names the branch (its name or its city) stays on that branch; a standalone dealer is itself', async () => {
    const M = CCmod();
    assert.strictEqual(M.aliasTarget(WB, 'pri', 'Williams Brothers Princeton', dnorm).dealer_id, 'pri');
    assert.strictEqual(M.aliasTarget(WB, 'vin', 'WILLIAMS BROS - VINCENNES IN', dnorm).dealer_id, 'vin');
    assert.strictEqual(M.aliasTarget(WB, 'solo', 'Harmon Med', dnorm).dealer_id, 'solo');
  });

  /* ── B. The real endpoints ── */
  const PRES = { token: 'pres' };
  const WBD = [{ id: 'wb-hq', business_name: 'Williams Brothers Washington HQ', city: 'Washington', zip: '47501', parent_id: null },
    { id: 'wb-pri', business_name: 'Williams Brothers Princeton', city: 'Princeton', zip: '47670', parent_id: 'wb-hq' }];
  function boot(file, extra, opts) {
    const S = standardSeed(Object.assign({ dealers: WBD, dealer_manufacturers: [], dealer_aliases: [] }, extra || {}));
    S.missingTables = ['mi1a_enrollment']; if (opts && opts.failRead) S.failRead = opts.failRead;
    const w = createWorld(S); return { w, m: load(file, w) };
  }
  const salesWrites = w => w.writes.filter(x => x.table === 'monthly_sales');
  const sept = [{ customer_name: 'Williams Brothers Healthcare Pharmacy', product_code: 'Brochure Trifold', qty: 25, ship_zip: '47670', order_date: '2026-09-12' }];

  await t('endpoint: config marks Strongback Sept not received, a sales report as estimate, a real statement as received', async () => {
    const { m } = boot('commissions-api.js', { monthly_sales: SB_SEPT.concat(SB_SR, AIRAVANT) });
    const r = await call(m, { action: 'config' }, PRES);
    assert.strictEqual(r.status, 200);
    assert.ok(!(r.body.received['strongback-mobility'] || []).includes('2026-09'), JSON.stringify(r.body.received));
    assert.strictEqual(r.body.incomplete['strongback-mobility'][0].period, '2026-09');
    assert.deepStrictEqual(r.body.estimated['strongback-mobility'], ['2026-07']);
    assert.deepStrictEqual(r.body.received['airavant-bongorx'], ['2026-06']);
  });
  await t('endpoint: config with an unreadable monthly_sales says so and shows nothing as received', async () => {
    const { m } = boot('commissions-api.js', { monthly_sales: AIRAVANT }, { failRead: tb => tb === 'monthly_sales' ? 500 : 0 });
    const r = await call(m, { action: 'config' }, PRES);
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.received, {}); assert.ok(r.body.coverage_error);
  });
  await t('endpoint: the September order export is refused at analyze AND import — nothing written, columns named', async () => {
    for (const action of ['analyze', 'import']) {
      const { w, m } = boot('commissions-api.js');
      const r = await call(m, { action, manufacturer: 'strongback-mobility', period: '2026-09', source_file: 'Strongback Sept Commission Report 2026.csv',
        rows: sept, mapped_fields: ['customer_name', 'product_code', 'qty', 'ship_zip', 'order_date'] }, PRES);
      assert.strictEqual(r.status, 422, action + ' ' + JSON.stringify(r.body)); assert.strictEqual(r.body.error, 'statement_incomplete');
      assert.deepStrictEqual(r.body.missing_mappings.sort(), ['amount', 'commission']);
      assert.strictEqual(salesWrites(w).length, 0, action + ' wrote nothing');
    }
  });
  await t('endpoint: the browser\'s column mapping is honoured (unmapped amount/commission named even for an open-invoice-only file)', async () => {
    const { w, m } = boot('commissions-api.js');
    const r = await call(m, { action: 'analyze', manufacturer: 'bemis', period: '2026-09', source_file: 'x.csv',
      rows: [{ customer_name: 'Retail Medical Solutions', line_type: 'Invoice', billed_amount: 10 }], mapped_fields: ['customer_name', 'line_type', 'billed_amount'] }, PRES);
    assert.strictEqual(r.status, 422); assert.deepStrictEqual(r.body.missing_mappings.sort(), ['amount', 'commission']);
    assert.strictEqual(salesWrites(w).length, 0);
  });
  await t('endpoint: multi-month import with one blank line in one month writes NO month', async () => {
    const { w, m } = boot('commissions-api.js');
    const rows = [{ customer_name: 'Retail Medical Solutions', amount: 100, commission: 10, order_date: '2026-07-02' },
      { customer_name: 'Retail Medical Solutions', amount: 80, commission: null, order_date: '2026-08-02' }];
    const r = await call(m, { action: 'import', manufacturer: 'pedifix', period: 'auto', multi_month: true, source_file: 'q.csv', rows }, PRES);
    assert.strictEqual(r.status, 422); assert.strictEqual(salesWrites(w).length, 0);
  });
  await t('endpoint: a complete statement still imports exactly as before', async () => {
    const { w, m } = boot('commissions-api.js');
    const r = await call(m, { action: 'import', manufacturer: 'pedifix', period: '2026-08', source_file: 'f.csv',
      rows: [{ customer_name: 'Retail Medical Solutions', amount: 100, commission: 10 }], mapped_fields: ['customer_name', 'amount', 'commission'] }, PRES);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.ok(salesWrites(w).some(x => x.kind === 'insert'));
  });
  await t('endpoint: learn_match saves a generic name on the company (HQ) and refuses to overwrite a different dealer silently', async () => {
    const { w, m } = boot('commissions-api.js');
    let r = await call(m, { action: 'learn_match', manufacturer: 'strongback-mobility', name: 'Williams Brothers Healthcare Pharmacy', dealer_id: 'wb-pri' }, PRES);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.alias.dealer_id, 'wb-hq'); assert.strictEqual(r.body.alias.moved_from, 'wb-pri');
    assert.strictEqual(w.db.dealer_aliases.find(a => a.alias_norm === dnorm('Williams Brothers Healthcare Pharmacy')).dealer_id, 'wb-hq');
    r = await call(m, { action: 'learn_match', manufacturer: 'strongback-mobility', name: 'Williams Brothers Healthcare Pharmacy', dealer_id: 'd-greg' }, PRES);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'alias_conflict');
    assert.strictEqual(w.db.dealer_aliases.find(a => a.alias_norm === dnorm('Williams Brothers Healthcare Pharmacy')).dealer_id, 'wb-hq');
    r = await call(m, { action: 'learn_match', manufacturer: 'strongback-mobility', name: 'Williams Brothers Healthcare Pharmacy', dealer_id: 'd-greg', replace: true }, PRES);
    assert.strictEqual(r.status, 200); assert.strictEqual(w.db.dealer_aliases.find(a => a.alias_norm === dnorm('Williams Brothers Healthcare Pharmacy')).dealer_id, 'd-greg');
  });
  await t('endpoint: the post-import resolver also saves on the company and never overwrites another dealer silently', async () => {
    const { w, m } = boot('commissions-api.js', { dealer_aliases: [{ alias_norm: dnorm('Wyatts Pharmacy'), raw_name: 'Wyatts Pharmacy', dealer_id: 'd-ang' }] });
    const r = await call(m, { action: 'resolve', manufacturer: 'strongback-mobility', mappings: [
      { name: 'Williams Brothers Healthcare Pharmacy', dealer_id: 'wb-pri' }, { name: 'Wyatts Pharmacy', dealer_id: 'd-greg' }] }, PRES);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(w.db.dealer_aliases.find(a => a.alias_norm === dnorm('Williams Brothers Healthcare Pharmacy')).dealer_id, 'wb-hq');
    assert.strictEqual(w.db.dealer_aliases.find(a => a.alias_norm === dnorm('Wyatts Pharmacy')).dealer_id, 'd-ang');
    assert.strictEqual(r.body.alias_conflicts.length, 1);
  });
  await t('endpoint: Sales Report Import "Assign" also saves a generic name on the company', async () => {
    const { w, m } = boot('sales-import-api.js');
    const r = await call(m, { action: 'add_alias', company: 'Williams Brothers Healthcare Pharmacy', dealer_id: 'wb-pri' }, PRES);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.dealer_id, 'wb-hq');
    assert.strictEqual(w.db.dealer_aliases[0].dealer_id, 'wb-hq');
  });
  await t('endpoint: with the alias on the company, a Princeton-ZIP line still lands on Princeton (ZIP picks the branch)', async () => {
    const { w, m } = boot('commissions-api.js', { dealer_aliases: [{ alias_norm: dnorm('Williams Brothers Healthcare Pharmacy'), raw_name: 'x', dealer_id: 'wb-hq' }] });
    const r = await call(m, { action: 'import', manufacturer: 'strongback-mobility', period: '2026-09', source_file: 'stmt.csv',
      rows: [{ customer_name: 'Williams Brothers Healthcare Pharmacy', amount: 50, commission: 4.5, ship_zip: '47670' }] }, PRES);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(w.db.monthly_sales.find(x => x.source_file === 'stmt.csv').dealer_id, 'wb-pri');
  });

  /* ── C. The page ── */
  const fs = require('fs');
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'import-commissions.html'), 'utf8');
  await t('page: sales amount and commission are required mappings and the grid shows the three states', async () => {
    assert.ok(/\{k:"amount",label:"Sales amount \(\$\)",req:true\}/.test(page) && /\{k:"commission",label:"Commission \(\$\)",req:true\}/.test(page));
    assert.ok(/const cls=on\?"on":ix\?"inc":e\?"est"/.test(page));
    assert.ok(/mapped_fields:v\.mapped_fields/.test(page) && /refusalHtml\(r\)/.test(page));
  });
  done('commission-coverage');
})();

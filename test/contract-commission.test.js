// Contractual commission tracking (Angelo, 2026-10-12 22:00 CT — CLAUDE.md §18). Pure engine tests: SR032 parsing,
// eligibility, earned / reported due / paid, review of unmatched statement lines, payments, no double counting.
// Synthetic data only (company names are placeholders); the real files are checked live, read-only.
const assert = require('assert');
const CT = require(process.env.CT_MODULE || '../netlify/functions/_contract_commission.js');
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e).split('\n').slice(0, 8).join('\n  ')); } }

// The September 2026 SR032 layout, as text lines (values from the statement on file, companies replaced).
const SEPT = ['STRONGBACK', 'mobility', 'September 2026', 'Order', 'Number Company Order Subtotal Commission Due',
  '7060 Dealer A Pharmacy $1037 $93.33', '6698 Dealer B Retail $440 $39.60', '6737 Dealer B Retail $1320 $118.80',
  '6800 Dealer C Alpharetta $940 $84.60', 'Staff Member: Angelo Audia', 'Total Orders: $3737', 'Total Commission Due: $336.33'];

const SALE = (o, amount, date, extra) => Object.assign({ order: String(o), order_key: CT.orderKey(o), date, company: 'Co ' + o, lines: 1, amount,
  status: 'Shipped', sources: [{ kind: 'export', source_id: 8, file_name: 'x.csv', lines: [2] }] }, extra || {});
const HIST = (o, amount, date, extra) => Object.assign({ order: String(o), order_key: CT.orderKey(o), date, company: 'Co ' + o, dealer_id: 'd' + o, lines: 1,
  amount, ledger_commission: Math.round(amount * 9) / 100, status: null, sources: [{ kind: 'hcps_sales', rows: [1] }] }, extra || {});
const STMT = (id, period, lines, received) => ({ source_id: id, file_name: period + ' SR032.pdf', period, received_date: received || '2026-10-07', parsed: CT.parseSr032(lines) });
const run = o => CT.reconcile(Object.assign({ slug: 'strongback-mobility', today: '2026-10-12', history: [], exports: [], statements: [], events: [] }, o));

(async () => {
  await t('only Strongback has a contract; every other manufacturer is untouched', async () => {
    assert.strictEqual(CT.contractFor('strongback-mobility').rate, 0.09);
    assert.strictEqual(CT.contractFor('strongback-mobility').label, 'Earned — Contract Rate 9%');
    for (const s of ['ovation-medical', 'bemis', 'abm-respiratory-care', 'pedifix', 'golden-technologies']) assert.strictEqual(CT.contractFor(s), null);
    assert.throws(() => CT.reconcile({ slug: 'bemis', today: '2026-10-12' }), /no_contract/);
  });
  await t('SR032: the September layout reads as 4 lines that add up to both printed totals', async () => {
    const p = CT.parseSr032(SEPT);
    assert.strictEqual(p.ok, true, p.problems.join(' ')); assert.strictEqual(p.month, '2026-09'); assert.strictEqual(p.staff, 'Angelo Audia');
    assert.deepStrictEqual(p.rows.map(r => [r.order, r.subtotal, r.due]), [['7060', 1037, 93.33], ['6698', 440, 39.6], ['6737', 1320, 118.8], ['6800', 940, 84.6]]);
    assert.strictEqual(p.total_orders, 3737); assert.strictEqual(p.total_due, 336.33);
  });
  await t('SR032: totals that do not add up refuse the statement (nothing guessed)', async () => {
    const p = CT.parseSr032(SEPT.map(l => l === 'Total Commission Due: $336.33' ? 'Total Commission Due: $346.33' : l));
    assert.strictEqual(p.ok, false); assert.ok(p.problems.some(x => /add up to \$336\.33/.test(x)));
    const q = CT.parseSr032(SEPT.filter(l => !/^Total Orders/.test(l))); assert.strictEqual(q.ok, false);
    const r = CT.parseSr032(SEPT.concat(['7101 Dealer D $12 abc'])); assert.strictEqual(r.ok, false); assert.ok(r.problems.some(x => /could not be read/.test(x)));
    assert.strictEqual(CT.parseSr032([]).ok, false);
  });
  await t('SR032: credits in brackets or with a minus sign, a wrapped company name, money parsing', async () => {
    const p = CT.parseSr032(['October 2026', '7300 Dealer E $500 $45.00', '7301 Dealer F with a very', 'long name', '7302 Dealer G ($100) ($9.00)',
      'Total Orders: $400', 'Total Commission Due: $36.00']);
    assert.strictEqual(p.ok, false, 'an order line without its amounts is refused, never skipped'); assert.ok(p.problems.some(x => /7301/.test(x)));
    const q = CT.parseSr032(['October 2026', '7300 Dealer E $500 $45.00', '7301 Dealer F with a very $200 $18.00', 'long name LLC', '7302 Dealer G -$100 -$9.00',
      'Total Orders: $600', 'Total Commission Due: $54.00']);
    assert.strictEqual(q.ok, true, q.problems.join(' ')); assert.strictEqual(q.rows[1].company, 'Dealer F with a very long name LLC'); assert.strictEqual(q.rows[2].due, -9);
    assert.strictEqual(CT.money('$1,037'), 1037); assert.strictEqual(CT.money('($9.00)'), -9); assert.strictEqual(CT.money('abc'), null); assert.strictEqual(CT.money(''), null);
  });
  await t('earned = 9% of the eligible sale; labelled Earned — Contract Rate 9%; HCPS sales without a status are marked, not hidden', async () => {
    const r = run({ history: [HIST(6698, 440, '2026-06-10')], exports: [SALE(7139, 1067, '2026-09-04'), SALE(7174, 546, '2026-09-15')] });
    const o = id => r.orders.find(x => x.order === String(id));
    assert.strictEqual(o(7139).earned, 96.03); assert.strictEqual(o(7174).earned, 49.14); assert.strictEqual(o(6698).earned, 39.6);
    assert.strictEqual(o(6698).eligibility, 'eligible_unverified_status'); assert.ok(o(6698).labels.includes('status_not_in_record'));
    assert.strictEqual(r.summary.contract, 'Earned — Contract Rate 9%'); assert.strictEqual(r.summary.earned, 184.77);
    assert.strictEqual(r.summary.eligible_sales, 2053);
  });
  await t('an order that is not a completed sale is not eligible until verified; a cancelled / refunded order earns nothing', async () => {
    const r = run({ exports: [SALE(1, 100, '2026-09-01', { status: 'Pending' }), SALE(2, 200, '2026-09-01', { status: 'Awaiting Fulfillment' }),
      SALE(3, 300, '2026-09-01', { status: 'Cancelled' }), SALE(4, 400, '2026-09-01', { status: 'Refunded' }), SALE(5, 500, '2026-09-01', { status: 'Completed' })] });
    const o = id => r.orders.find(x => x.order === String(id));
    assert.strictEqual(o(1).earned, 0); assert.strictEqual(o(1).eligibility, 'pending_status'); assert.ok(o(1).labels.includes('status_not_verified'));
    assert.strictEqual(o(2).earned, 0); assert.strictEqual(o(3).eligibility, 'reversed'); assert.strictEqual(o(4).earned, 0);
    assert.strictEqual(o(5).earned, 45); assert.strictEqual(r.summary.earned, 45); assert.strictEqual(r.summary.not_eligible_orders, 4);
  });
  await t('credits and reversal lines reduce the eligible sale (lines are summed as the import sums them)', async () => {
    const rows = [{ id: 1, source: 'sales_report', invoice_no: '9', order_date: '2026-08-01', amount: 300, commission: 27, dealer_id: 'd' },
      { id: 2, source: 'sales_report', invoice_no: '9', order_date: '2026-08-20', amount: -100, commission: -9, dealer_id: 'd' },
      { id: 3, source: 'commission', invoice_no: '9', amount: 999, commission: 99 }];
    const h = CT.salesFromHistory(rows);
    assert.strictEqual(h.length, 1); assert.strictEqual(h[0].amount, 200); assert.strictEqual(h[0].ledger_commission, 18); assert.strictEqual(h[0].date, '2026-08-01');
    const r = run({ history: h }); assert.strictEqual(r.orders[0].earned, 18); assert.strictEqual(r.orders[0].flags.length, 0);
  });
  await t('export reader: created date is the sale date — never the payment-due date; dealer "Fully Paid" is kept as information only', async () => {
    const headers = ['Number', 'Status', 'Subtotal', 'Discount', 'Payment Due Date', 'Fully Paid', 'Created Date', 'Line Item Quantity', 'Line Item Sku', 'Line Item Wholesale Price', 'Company Name', 'Fully Shipped'];
    const raw = [['7139', 'Shipped', '1067.00', '0', '10/04/2026', 'no', '2026-09-04', '1', 'A', '541.00', 'Co', 'yes'], ['7139', 'Shipped', '1067.00', '0', '10/04/2026', 'no', '2026-09-04', '1', 'B', '526.00', 'Co', 'yes'],
      ['7191', 'Shipped', '0.00', '0', '10/18/2026', 'yes', '2026-09-18', '25', 'Brochure', '0.00', 'Co2', 'yes']];
    const parsed = { headers, rows: raw.map((r, i) => ({ line: i + 2, raw: r, order_number: r[0], date: r[6], company: r[10], qty: r[7], unit_price: r[9] })) };
    const amountOf = row => Math.round(Number(row.qty) * Number(row.unit_price) * 100) / 100;
    const s = CT.salesFromExport(parsed, { id: 8, file_name: 'x.csv' }, amountOf);
    const a = s.find(x => x.order === '7139');
    assert.strictEqual(a.date, '2026-09-04'); assert.strictEqual(a.amount, 1067); assert.strictEqual(a.lines, 2); assert.strictEqual(a.status, 'Shipped');
    assert.strictEqual(a.dealer_paid, 'no'); assert.strictEqual(a.subtotal, 1067);
    const r = run({ exports: s }); assert.strictEqual(r.orders.find(x => x.order === '7139').earned, 96.03); assert.strictEqual(r.orders.find(x => x.order === '7191').earned, 0);
    assert.ok(!r.orders.find(x => x.order === '7139').flags.some(f => f.code === 'subtotal_differs'));
  });
  await t('statement lines match sales by order number → reported due; earned and reported due are never added together', async () => {
    const r = run({ history: [HIST(7060, 1037, '2026-08-20'), HIST(6698, 440, '2026-06-10'), HIST(6737, 1320, '2026-07-01'), HIST(6800, 940, '2026-07-15')],
      statements: [STMT(9, '2026-09', SEPT)] });
    assert.strictEqual(r.summary.earned, 336.33); assert.strictEqual(r.summary.reported_due, 336.33); assert.strictEqual(r.summary.paid, 0);
    assert.strictEqual(r.summary.outstanding, 336.33, 'outstanding = earned − paid, not earned + reported');
    assert.strictEqual(r.review.length, 0); assert.strictEqual(r.statements[0].matched, 4);
    for (const o of r.orders) { assert.strictEqual(o.stage, 'reported_due'); assert.ok(o.labels.includes('payment_unverified')); }
    assert.ok(/never added together/.test(r.summary.note));
  });
  await t('an SR032 order with no matching sale goes to REVIEW — it never becomes a sale or earned commission', async () => {
    const r = run({ history: [HIST(7060, 1037, '2026-08-20')], statements: [STMT(9, '2026-09', SEPT)] });
    assert.strictEqual(r.orders.length, 1, 'no sale is created from a statement');
    assert.strictEqual(r.review.length, 3); assert.ok(r.review.every(x => x.reason === 'no_matching_sale'));
    assert.strictEqual(r.summary.earned, 93.33); assert.strictEqual(r.summary.reported_due, 93.33); assert.strictEqual(r.summary.review_due, 243);
  });
  await t('the same order listed again with the same amount on a later statement is noted, not counted twice', async () => {
    const oct = ['October 2026', '7060 Dealer A Pharmacy $1037 $93.33', 'Total Orders: $1037', 'Total Commission Due: $93.33'];
    const r = run({ history: [HIST(7060, 1037, '2026-08-20')], statements: [STMT(9, '2026-09', SEPT), STMT(12, '2026-10', oct, '2026-11-05')] });
    const o = r.orders[0]; assert.strictEqual(o.reported_due, 93.33); assert.ok(o.flags.some(f => f.code === 'listed_again'));
  });
  await t('a statement that does not add up is reported as a problem and contributes nothing', async () => {
    const bad = STMT(9, '2026-09', SEPT.map(l => l.replace('$84.60', '$84.70')));
    const r = run({ history: [HIST(6800, 940, '2026-07-15')], statements: [bad] });
    assert.strictEqual(r.summary.reported_due, 0); assert.strictEqual(r.problems.length, 1); assert.strictEqual(r.statements[0].ok, false);
  });
  await t('statement amounts that differ from 9% of the sale, or report a non-eligible order, are flagged', async () => {
    const lines = ['September 2026', '7060 Dealer A $1037 $90.00', '7061 Dealer B $100 $9.00', 'Total Orders: $1137', 'Total Commission Due: $99.00'];
    const r = run({ history: [HIST(7060, 1037, '2026-08-20')], exports: [SALE(7061, 100, '2026-09-01', { status: 'Pending' })], statements: [STMT(9, '2026-09', lines)] });
    assert.ok(r.orders.find(o => o.order === '7060').flags.some(f => f.code === 'due_differs_from_earned'));
    assert.ok(r.orders.find(o => o.order === '7061').flags.some(f => f.code === 'reported_not_eligible'));
  });
  await t('HCPS and the export both have an order: counted once, HCPS figure used, a difference flagged', async () => {
    const r = run({ history: [HIST(7139, 1000, '2026-09-04')], exports: [SALE(7139, 1067, '2026-09-04')] });
    assert.strictEqual(r.orders.length, 1); assert.strictEqual(r.orders[0].earned, 90); assert.ok(r.orders[0].flags.some(f => f.code === 'amount_differs'));
    assert.strictEqual(r.orders[0].sources.length, 2);
  });
  await t('payments: SR032 "due" is not paid; a full statement payment pays its lines; a partial one stays unallocated; order payments apply', async () => {
    const H = [HIST(7060, 1037, '2026-08-20'), HIST(6698, 440, '2026-06-10'), HIST(6737, 1320, '2026-07-01'), HIST(6800, 940, '2026-07-15')];
    const full = run({ history: H, statements: [STMT(9, '2026-09', SEPT)], events: [{ id: 1, kind: 'payment', source_id: 9, amount: 336.33, evidence: 'ACH 10/15', actor: 'staff:a@b', created_at: 'x' }] });
    assert.strictEqual(full.summary.paid, 336.33); assert.strictEqual(full.summary.outstanding, 0); assert.ok(full.orders.every(o => o.stage === 'paid' && !o.labels.includes('payment_unverified')));
    assert.strictEqual(full.statements[0].payment_state, 'paid_in_full');
    const part = run({ history: H, statements: [STMT(9, '2026-09', SEPT)], events: [{ id: 1, kind: 'payment', source_id: 9, amount: 200, evidence: 'cheque 1001', actor: 'x', created_at: 'x' }] });
    assert.strictEqual(part.summary.paid, 0); assert.strictEqual(part.summary.unallocated_payments, 200); assert.strictEqual(part.statements[0].payment_state, 'partial');
    const ord = run({ history: H, statements: [STMT(9, '2026-09', SEPT)], events: [{ id: 1, kind: 'payment', order: '6698', amount: 39.6, evidence: 'remit', actor: 'x', created_at: 'x' },
      { id: 2, kind: 'payment', order: '9999', amount: 5, evidence: 'remit', actor: 'x', created_at: 'x' }] });
    assert.strictEqual(ord.summary.paid, 39.6); assert.strictEqual(ord.orders.find(o => o.order === '6698').stage, 'paid'); assert.strictEqual(ord.unallocated.length, 1);
    const sup = run({ history: H, statements: [STMT(9, '2026-09', SEPT)], events: [{ id: 1, kind: 'payment', order: '6698', amount: 39.6, evidence: 'r', actor: 'x', created_at: 'x' },
      { id: 2, kind: 'payment', order: '6698', amount: 30, evidence: 'corrected', supersedes_id: 1, actor: 'x', created_at: 'x' }] });
    assert.strictEqual(sup.summary.paid, 30, 'a correction supersedes, never adds');
  });
  await t('review decisions: matched_to ties an unmatched line to a sale (once); not_ours / investigate keep it out of earned', async () => {
    const r = run({ history: [HIST(7061, 1037, '2026-08-20')], statements: [STMT(9, '2026-09', SEPT)],
      events: [{ id: 5, kind: 'review', source_id: 9, order: '7060', decision: 'matched_to:7061', reason: 'typo on statement', actor: 'staff:a@b', created_at: 'x' },
        { id: 6, kind: 'review', source_id: 9, order: '6698', decision: 'not_ours', reason: 'another rep', actor: 'staff:a@b', created_at: 'x' }] });
    const o = r.orders.find(x => x.order === '7061'); assert.strictEqual(o.reported_due, 93.33); assert.ok(o.flags.some(f => f.code === 'matched_by_review'));
    assert.strictEqual(r.review.length, 3); assert.strictEqual(r.summary.review_lines, 2, 'not_ours is decided; the other two remain open');
    assert.strictEqual(r.summary.earned, 93.33);
  });
  await t('potentially overdue: earned but never reported after 90 days; reported but no payment evidence 45 days after the statement arrived', async () => {
    const r = run({ today: '2026-12-01', history: [HIST(1, 100, '2026-07-01'), HIST(7060, 1037, '2026-08-20')], statements: [STMT(9, '2026-09', SEPT, '2026-10-07')] });
    assert.ok(r.orders.find(o => o.order === '1').labels.includes('potentially_overdue_unreported'));
    assert.ok(r.orders.find(o => o.order === '7060').labels.includes('potentially_overdue_unpaid'));
    const n = run({ today: '2026-10-12', history: [HIST(1, 100, '2026-09-20')] }); assert.ok(!n.orders[0].labels.length || !n.orders[0].labels.some(l => l.startsWith('potentially')));
  });
  await t('drilldown by dealer / month / reporting month / manufacturer keeps the four columns apart', async () => {
    const r = run({ history: [HIST(7060, 1037, '2026-08-20'), HIST(6698, 440, '2026-06-10')], exports: [SALE(7139, 1067, '2026-09-04')], statements: [STMT(9, '2026-09', SEPT)] });
    const m = CT.groupBy(r, 'month'); assert.deepStrictEqual(m.map(x => x.key), ['2026-09', '2026-08', '2026-06']);
    const rep = CT.groupBy(r, 'reporting_month'); assert.ok(rep.some(x => x.key === 'not reported yet' && x.earned === 96.03));
    const mf = CT.groupBy(r, 'manufacturer'); assert.strictEqual(mf.length, 1); assert.strictEqual(mf[0].earned, r.summary.earned); assert.strictEqual(mf[0].reported_due, r.summary.reported_due);
    const d = CT.groupBy(r, 'dealer'); assert.strictEqual(d.reduce((s, x) => s + x.orders, 0), 3);
  });
  await t('coverage helper: a month is contract-earned only when EVERY line carries exactly 9%', async () => {
    assert.strictEqual(CT.monthIsContractEarned('strongback-mobility', [{ source: 'sales_report', amount: 536, commission: 48.24 }, { source: 'sales_report', amount: 0, commission: 0 }]), true);
    assert.strictEqual(CT.monthIsContractEarned('strongback-mobility', [{ source: 'sales_report', amount: 536, commission: 53.6 }]), false);
    assert.strictEqual(CT.monthIsContractEarned('strongback-mobility', []), false);
    assert.strictEqual(CT.monthIsContractEarned('bemis', [{ source: 'sales_report', amount: 100, commission: 9 }]), false);
  });
  console.log(`contract-commission: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

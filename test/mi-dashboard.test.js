/* Phase D — Manufacturer Intelligence dashboard (netlify/functions/_mi_dashboard.js). Pure.
   Missing only when a profile expects the report and its due date has passed; the reconciliation covers the previous
   month and is ready on the 15th; a report arriving after its due date is LATE and still counted as received.
     node test/mi-dashboard.test.js */
const assert = require('assert');
const D = require('../netlify/functions/_mi_dashboard.js');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }

const P = (id, slug, kind, status, expected, extra) => ({ id, code: `${slug}:${kind}`, manufacturer: slug, kind, status, rules: Object.assign({ expected }, extra || {}) });
const profiles = [
  P(1, 'strongback-mobility', 'commission_statement', 'active', { cadence: 'monthly', days: [2, 7] }),
  P(2, 'strongback-mobility', 'sales_export', 'active', { cadence: 'on_request' }),
  P(3, 'bemis', 'commission_statement', 'draft', { cadence: 'monthly', days: [17, 17] }),
  P(4, 'ohio-medical', 'commission_statement', 'draft', { cadence: 'monthly', days: [21, 29] }, { period: { cumulative: true } }),
  P(5, 'golden-technologies', 'commission_statement', 'draft', { cadence: 'irregular' }),
];
const sources = [
  { id: 9, manufacturer: 'strongback-mobility', kind: 'commission_statement', status: 'received', received_date: '2026-10-07', report_period_start: '2026-09-01', report_period_end: '2026-09-30', import_batch_id: null },
  { id: 8, manufacturer: 'strongback-mobility', kind: 'sales_export', status: 'received', received_date: '2026-10-02', report_period_start: '2026-09-01', report_period_end: '2026-09-30', import_batch_id: null },
  { id: 3, manufacturer: 'strongback-mobility', kind: 'commission_statement', status: 'superseded', received_date: '2026-09-02', report_period_start: '2026-08-01', report_period_end: '2026-08-31' },
];
const items = [
  { id: 1, manufacturer: 'bemis', kind: 'commission_statement', state: 'classified', period_start: '2026-08-01', period_end: '2026-08-31', profile_id: 3 },
  { id: 2, manufacturer: 'golden-technologies', state: 'exception', attention: 'cloud_attachment', resolved_at: null },
  { id: 3, manufacturer: 'golden-technologies', state: 'exception', attention: 'cloud_attachment', resolved_at: '2026-10-11' },
];
const coverage = { 'ohio-medical': { '2026-09': { status: 'received' } } };
const run = today => D.build({ today, months: 4, profiles, sources, items, coverage, manufacturers: [{ slug: 'bemis', name: 'Bemis' }], shipto: { held: 0, needs_review: 3 } });
const cellOf = (r, slug, kind, m) => r.grid.find(g => g.slug === slug).kinds.find(k => k.kind === kind).months.find(x => x.month === m);

t('months: the last n months ending this month', () => assert.deepStrictEqual(run('2026-10-12').months, ['2026-07', '2026-08', '2026-09', '2026-10']));
t('registered, captured by a draft profile, in HCPS only, missing, not due, not expected', () => {
  const r = run('2026-10-20');
  assert.strictEqual(cellOf(r, 'strongback-mobility', 'commission_statement', '2026-09').status, 'registered');
  assert.strictEqual(cellOf(r, 'strongback-mobility', 'commission_statement', '2026-08').status, 'missing', 'a superseded record does not count');
  assert.strictEqual(cellOf(r, 'bemis', 'commission_statement', '2026-08').status, 'captured_draft');
  assert.strictEqual(cellOf(r, 'bemis', 'commission_statement', '2026-09').status, 'missing', 'due Oct 17, today Oct 20');
  assert.strictEqual(cellOf(r, 'ohio-medical', 'commission_statement', '2026-09').status, 'in_hcps_only');
  assert.strictEqual(cellOf(r, 'strongback-mobility', 'commission_statement', '2026-10').status, 'not_due');
  assert.strictEqual(cellOf(r, 'strongback-mobility', 'sales_export', '2026-08').status, 'not_expected', 'on request is never missing');
  assert.strictEqual(cellOf(r, 'golden-technologies', 'commission_statement', '2026-08').status, 'not_expected', 'irregular is never missing');
});
t('due dates: next month by the last expected day; a cumulative "through <Month>" report is due in its own month', () => {
  assert.strictEqual(D.dueDate(profiles[0], '2026-09'), '2026-10-07'); assert.strictEqual(D.dueDate(profiles[2], '2026-09'), '2026-10-17');
  assert.strictEqual(D.dueDate(profiles[3], '2026-09'), '2026-09-28'); assert.strictEqual(D.dueDate({ rules: {} }, '2026-12'), '2027-01-15');
});
t('reconciliation: previous month, ready on the 15th; not before', () => {
  const a = run('2026-10-14'), b = run('2026-10-15');
  assert.deepStrictEqual([a.reconciliation.month, a.reconciliation.ready, b.reconciliation.ready, b.reconciliation.ready_on], ['2026-09', false, true, '2026-10-15']);
  const rows = Object.fromEntries(b.reconciliation.rows.map(x => [x.slug, x.status]));
  assert.deepStrictEqual(rows, { bemis: 'not_due', 'ohio-medical': 'in_hcps_only', 'strongback-mobility': 'registered' }, 'golden (irregular) is not listed');
});
t('a report received after its due date is LATE and still received', () => {
  const late = sources.concat([{ id: 20, manufacturer: 'bemis', kind: 'commission_statement', status: 'received', received_date: '2026-10-25', report_period_start: '2026-09-01', report_period_end: '2026-09-30' }]);
  const r = D.build({ today: '2026-10-26', months: 3, profiles, sources: late, items, coverage, manufacturers: [], shipto: {} });
  const row = r.reconciliation.rows.find(x => x.slug === 'bemis'); assert.deepStrictEqual([row.status, row.late], ['registered', true]); assert.strictEqual(r.reconciliation.late, 1);
});
t('pending work: open capture exceptions only, awaiting acceptance / import, Ship-To, drafts', () => {
  const p = run('2026-10-12').pending;
  assert.deepStrictEqual([p.capture_exceptions, p.reports_awaiting_acceptance, p.reports_awaiting_import, p.shipto_orders_needing_review, p.draft_profiles, p.captured_by_draft_profiles], [1, 2, 2, 3, 3, 1]);
});

console.log(`\nmi-dashboard: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

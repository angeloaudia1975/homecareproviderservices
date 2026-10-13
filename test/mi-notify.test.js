/* MI notifications (_mi_notify.js): one activity email per hour only when something happened, never a duplicate, a
   failed send retried with the same content, the daily digest once a day, the reconciliation on the 15th.
     node test/mi-notify.test.js */
const assert = require('assert');
const N = require('../netlify/functions/_mi_notify.js');
let pass = 0, fail = 0; const tests = [];
const t = (n, f) => tests.push([n, f]);

function world(o) {
  const w = Object.assign({ logs: [], srcs: [], items: [], state: null, mails: [], sendOk: true,
    mfrs: [{ slug: 'access4u', name: 'Access4u' }, { slug: 'strongback-mobility', name: 'Strongback Mobility' }],
    dash: { reconciliation: { month: '2026-09', summary: { received: 3, received_late: 1, overdue: 1, not_due: 0, imported: 1, open_exceptions: 0 },
      rows: [{ slug: 'access4u', name: 'Access4u', status: 'registered', imported: true }, { slug: 'climbing-steps', name: 'Climbing Steps', status: 'missing', days_overdue: 2 }] } } }, o || {});
  const pick = p => p.startsWith('mfr_auto_import_log') ? w.logs : p.startsWith('mfr_sources') ? w.srcs : p.startsWith('mfr_report_items') ? w.items : p.startsWith('manufacturers') ? w.mfrs : [];
  w.deps = { sbGet: async p => p.startsWith('app_settings') ? (w.state ? [{ value: JSON.parse(JSON.stringify(w.state)) }] : []) : pick(p), sbGetAll: async p => pick(p),
    saveState: async v => { w.state = JSON.parse(JSON.stringify(v)); }, sendMail: async m => { if (!w.sendOk) return false; w.mails.push(m); return true; },
    dashboard: async () => w.dash, now: () => w.now || new Date('2026-10-13T17:50:00Z') };
  return w;
}
const run = w => N.make(w.deps).run();
const src = (id, extra) => Object.assign({ id, manufacturer: 'access4u', kind: 'commission_statement', file_name: 'f' + id + '.xlsx', status: 'received', received_date: '2026-10-12', report_period_start: '2026-09-01', created_at: '2026-10-13T16:00:00Z' }, extra || {});
const log = (id, source_id, outcome, detail, created_at) => ({ id, source_id, outcome, detail: detail || {}, created_at: created_at || '2026-10-13T17:40:00Z' });

t('first run: reports the last 24 hours (not all history) and then sets the watermark', async () => {
  const w = world({ srcs: [src(1, { created_at: '2026-09-01T00:00:00Z' }), src(2)], logs: [log(1, 1, 'imported', {}, '2026-09-01T00:00:00Z'), log(2, 2, 'imported', { lane: 'commission', code: 'imported', message: 'Imported automatically: 3 line(s).' })] });
  const r = await run(w);
  assert.deepStrictEqual(r.sent.slice(0, 1), ['activity']); const m = w.mails[0];
  assert.ok(/1 applied/.test(m.subject) && /1 arrived/.test(m.subject), m.subject);
  assert.ok(/f2\.xlsx/.test(m.html) && !/f1\.xlsx/.test(m.html));
  assert.strictEqual(w.state.last_log_id, 2); assert.strictEqual(w.state.last_source_id, 2);
});
t('nothing new: no activity email; a later new event: exactly one email with only that event', async () => {
  const w = world({ srcs: [src(2)], logs: [log(2, 2, 'imported')], state: { last_log_id: 2, last_source_id: 2, cap_keys: [], digest_day: '2026-10-13', recon_month: '2026-10' } });
  let r = await run(w); assert.deepStrictEqual(r.sent, []); assert.strictEqual(w.mails.length, 0);
  w.logs.push(log(3, 2, 'needs_approval', { lane: 'commission', code: 'needs_decision', message: 'The importer needs your decision.' }));
  r = await run(w); assert.deepStrictEqual(r.sent, ['activity']); assert.ok(/1 need you/.test(w.mails[0].subject)); assert.ok(/Commission Report Import/.test(w.mails[0].html));
  r = await run(w); assert.strictEqual(w.mails.length, 1, 'never sent twice');
});
t('a failed send moves nothing: the next run sends the same events', async () => {
  const w = world({ srcs: [src(2)], logs: [log(2, 2, 'imported'), log(3, 2, 'rolled_back', { lane: 'commission', code: 'result_differs', message: 'Rolled back.' })], state: { last_log_id: 2, last_source_id: 2, cap_keys: [], digest_day: '2026-10-13', recon_month: '2026-10' }, sendOk: false });
  let r = await run(w); assert.strictEqual(r.ok, false); assert.strictEqual(w.state.last_log_id, 2);
  w.sendOk = true; r = await run(w); assert.ok(/1 failed/.test(w.mails[0].subject)); assert.strictEqual(w.state.last_log_id, 3);
});
t('capture exceptions are reported once each (by item and reason)', async () => {
  const w = world({ items: [{ id: 9, manufacturer: null, attention: 'unidentified_sender', file_name: 'x.pdf' }], state: { last_log_id: 0, last_source_id: 0, cap_keys: [], digest_day: '2026-10-13', recon_month: '2026-10' } });
  await run(w); assert.strictEqual(w.mails.length, 1); assert.ok(/Needs attention/.test(w.mails[0].html));
  await run(w); assert.strictEqual(w.mails.length, 1);
});
t('daily digest: once a day from 07:00 Chicago, sent even when all is clear, lists what still waits', async () => {
  const w = world({ srcs: [src(5)], logs: [log(7, 5, 'needs_approval', { lane: 'commission', code: 'needs_decision', message: 'Decision needed.' })], state: { last_log_id: 7, last_source_id: 5, cap_keys: [], digest_day: '2026-10-12', recon_month: '2026-10' } });
  w.now = new Date('2026-10-13T11:50:00Z');    // 06:50 CDT: too early
  let r = await run(w); assert.deepStrictEqual(r.sent, []);
  w.now = new Date('2026-10-13T12:50:00Z');    // 07:50 CDT
  r = await run(w); assert.deepStrictEqual(r.sent, ['digest']); assert.ok(/1 need you/.test(w.mails[0].subject)); assert.ok(/Decision needed/.test(w.mails[0].html));
  r = await run(w); assert.strictEqual(w.mails.length, 1);
  const c = world({ state: { last_log_id: 0, last_source_id: 0, cap_keys: [], digest_day: '2026-10-12', recon_month: '2026-10' }, now: new Date('2026-10-13T12:50:00Z') });
  await run(c); assert.ok(/all clear/.test(c.mails[0].subject));
});
t('an imported record no longer appears as waiting in the digest', async () => {
  const w = world({ srcs: [src(5, { import_batch_id: 'b1' })], logs: [log(7, 5, 'needs_approval', { lane: 'commission', code: 'needs_decision' })], state: { last_log_id: 7, last_source_id: 5, cap_keys: [], digest_day: '2026-10-12', recon_month: '2026-10' }, now: new Date('2026-10-13T12:50:00Z') });
  await run(w); assert.ok(/all clear/.test(w.mails[0].subject));
});
t('monthly reconciliation: only from the 15th, once per month, with every expected manufacturer', async () => {
  const w = world({ state: { last_log_id: 0, last_source_id: 0, cap_keys: [], digest_day: '2026-10-14', recon_month: '2026-09' }, now: new Date('2026-10-14T13:50:00Z') });
  let r = await run(w); assert.ok(!r.sent.includes('reconciliation'));
  w.now = new Date('2026-10-15T12:50:00Z'); r = await run(w);
  assert.ok(r.sent.includes('reconciliation')); const m = w.mails.find(x => /reconciliation/.test(x.subject));
  assert.ok(/Climbing Steps/.test(m.html) && /2 d overdue/.test(m.html) && /Access4u/.test(m.html));
  w.now = new Date('2026-10-16T12:50:00Z'); const n = w.mails.length; r = await run(w); assert.ok(!r.sent.includes('reconciliation')); assert.strictEqual(w.mails.length, n + 1, 'only the next digest');
});
t('classification: applied / needs you / failed, by lane', () => {
  assert.strictEqual(N.classify({ outcome: 'refused', detail: { code: 'already_in_hcps' } }).group, 'applied');
  assert.strictEqual(N.classify({ outcome: 'refused', detail: { code: 'statement_evidence' } }).group, 'applied');
  assert.strictEqual(N.classify({ outcome: 'imported', detail: { lane: 'intel', code: 'intel_published' } }).group, 'applied');
  assert.strictEqual(N.classify({ outcome: 'held', detail: { code: 'no_template' } }).group, 'action');
  assert.strictEqual(N.classify({ outcome: 'needs_approval', detail: {} }).group, 'action');
  assert.strictEqual(N.classify({ outcome: 'refused', detail: { code: 'mi1a_commission_file_refused' } }).group, 'failed');
  assert.strictEqual(N.classify({ outcome: 'error', detail: {} }).group, 'failed');
});
t('every link points at the HCPS site', async () => {
  const w = world({ srcs: [src(2)], logs: [log(3, 2, 'held', { lane: 'intel', code: 'parse_errors', message: 'x' })], state: { last_log_id: 2, last_source_id: 2, cap_keys: [], digest_day: '2026-10-13', recon_month: '2026-10' } });
  await run(w); const hrefs = [...w.mails[0].html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(hrefs.length >= 3 && hrefs.every(h => h.startsWith('https://www.homecareproviderservices.org/admin/')), hrefs.join(' '));
});

(async () => {
  for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + String(e.message).split('\n')[0]); } }
  console.log(`\nmi-notify: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

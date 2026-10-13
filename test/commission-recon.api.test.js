/* Contractual commission reconciliation through the Report History API (mfr-reports-api.js: commission_recon,
   commission_event), loaded unmodified against a fake Supabase (auth, PostgREST, storage, RPC). The statement is a REAL
   PDF built here and read by the same server-side PDF reader MI-1c uses; the export is a real CSV read by _report_rows.
   Proves: management only; read-only (no write of any kind); SHA-256 re-checked; earned / reported due / paid kept apart;
   the September shape (export orders ≠ statement orders); posting preview never posts statements; the evidence store is
   optional ("not installed" until Phase F SQL runs); commission_event is the President's and goes only to the RPC. */
const assert = require('assert');
const crypto = require('crypto');
const { load, call } = require('./phase0-mock');
const BASE = 'https://db.test';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// A minimal one-page PDF whose text lines are `lines` (Helvetica, one line per 16 pt).
function makePdf(lines) {
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = lines.map((l, i) => `BT /F1 11 Tf 50 ${760 - i * 16} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const SR = makePdf(['September 2026', 'Order Number Company Order Subtotal Commission Due', '7060 Dealer A Pharmacy $1037 $93.33', '6698 Dealer B Retail $440 $39.60',
  '6737 Dealer B Retail $1320 $118.80', '6800 Dealer C Alpharetta $940 $84.60', 'Staff Member: Angelo Audia', 'Total Orders: $3737', 'Total Commission Due: $336.33']);
const CSV = Buffer.from(['Number,Status,Subtotal,Discount,Payment Due Date,Fully Paid,Created Date,Line Item Quantity,Line Item Name,Line Item Sku,Line Item Wholesale Price,Company Name,Shipping Zip Code',
  '7139,Shipped,1067.00,0,10/04/2026,no,2026-09-04,1,Chair,1010,541.00,Dealer H,47591', '7139,Shipped,1067.00,0,10/04/2026,no,2026-09-04,1,Chair,1007,526.00,Dealer H,47591',
  '7174,Shipped,546.00,0,10/15/2026,no,2026-09-15,1,Chair,1007,546.00,Dealer L,30101', '7191,Shipped,0.00,0,10/18/2026,yes,2026-09-18,25,Brochure,BR,0.00,Dealer W,47670',
  '7240,Pending,300.00,0,10/30/2026,no,2026-09-28,1,Chair,1017,300.00,Dealer P,30044'].join('\n'));
const HIST = [[1, '7060', '2026-08-20', 1037], [2, '6698', '2026-06-10', 440], [3, '6737', '2026-07-01', 1320], [4, '6800', '2026-07-15', 940], [5, '5804', '2026-05-02', 320]]
  .map(([id, inv, d, a]) => ({ id, invoice_no: inv, order_date: d, period: d.slice(0, 8) + '01', amount: a, commission: Math.round(a * 9) / 100, dealer_id: 'd' + inv, customer_name: 'Co ' + inv, source: 'sales_report' }));
const SOURCES = [
  { id: 8, kind: 'sales_export', file_name: 'Angelo Sep Orders.csv', file_sha256: sha(CSV), storage_path: 'reports/strongback-mobility/sales_export/' + sha(CSV) + '.csv', received_date: '2026-10-02', report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'received', import_batch_id: null },
  { id: 9, kind: 'commission_statement', file_name: '2026-09 SR032.pdf', file_sha256: sha(SR), storage_path: 'reports/strongback-mobility/commission_statement/' + sha(SR) + '.pdf', received_date: '2026-10-07', report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'received', import_batch_id: null }];

function world(o) {
  o = o || {};
  const st = { calls: [], rpcs: [] };
  const res = (status, body, raw) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) });
  st.fetch = async (url, opts) => {
    opts = opts || {}; const u = String(url), m = (opts.method || 'GET').toUpperCase(); st.calls.push({ u, m, body: opts.body });
    if (u.startsWith(BASE + '/auth/v1/user')) { const tok = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
      const em = { pres: 'angelo@hcps.us', admin: 'ad@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us' }[tok]; return em ? res(200, { email: em }) : res(401, {}); }
    if (u.startsWith(BASE + '/rest/v1/staff_users')) { const em = decodeURIComponent(u.match(/email=eq\.([^&]+)/)[1]);
      const s = { 'angelo@hcps.us': 'president', 'ad@hcps.us': 'admin', 'greg@hcps.us': 'rep', 'lori@hcps.us': 'relations' }[em]; return res(200, s ? [{ email: em, role: s }] : []); }
    if (o.failRead && m === 'GET' && o.failRead(u)) return res(500, { message: 'forced' });
    if (u.startsWith(BASE + '/storage/v1/object/mfr-sources/')) { const p = u.split('/mfr-sources/')[1];
      if (/\.csv$/.test(p)) return res(200, '', o.tamper ? Buffer.concat([CSV, Buffer.from('x')]) : CSV); if (/\.pdf$/.test(p)) return res(200, '', SR); return res(404, {}); }
    if (u.startsWith(BASE + '/rest/v1/monthly_sales')) { if (/offset=([1-9])/.test(u)) return res(200, []);
      if (/source=eq\.sales_report/.test(u)) return res(200, HIST); return res(200, o.laneRows || []); }
    if (u.startsWith(BASE + '/rest/v1/mfr_sources')) { if (/offset=([1-9])/.test(u)) return res(200, []); return res(200, SOURCES); }
    if (u.startsWith(BASE + '/rest/v1/mfr_commission_events')) return o.events ? res(200, o.events) : res(404, { code: 'PGRST205', message: 'not found' });
    if (u.startsWith(BASE + '/rest/v1/dealers')) return res(200, HIST.map(h => ({ id: h.dealer_id, business_name: 'Dealer ' + h.invoice_no })));
    if (u.startsWith(BASE + '/rest/v1/rpc/')) { const fn = u.split('/rpc/')[1]; const p = JSON.parse(opts.body).p; st.rpcs.push({ fn, p });
      if (o.rpc) { const r = o.rpc(fn, p); if (r) return res(r.status, r.body); } return res(200, { ok: true, event_id: 1, kind: p.kind }); }
    return res(404, { message: 'unexpected ' + m + ' ' + u });
  };
  return st;
}
const boot = o => { const w = world(o); return { w, m: load('mfr-reports-api.js', w) }; };
const writes = w => w.calls.filter(c => c.m !== 'GET' && !/\/auth\/v1\//.test(c.u));
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); } }

(async () => {
  await t('management only: no sign-in 401, rep / Relations 403, nothing read', async () => {
    for (const [tok, code] of [[null, 401], ['greg', 403], ['lori', 403]]) { const { w, m } = boot();
      const r = await call(m, { action: 'commission_recon' }, tok ? { token: tok } : {}); assert.strictEqual(r.status, code);
      assert.ok(!w.calls.some(c => /monthly_sales|storage/.test(c.u))); }
  });
  let R;
  await t('read-only: President and Admin get the reconciliation; not one write of any kind', async () => {
    for (const tok of ['pres', 'admin']) { const { w, m } = boot(); const r = await call(m, { action: 'commission_recon' }, { token: tok });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300)); assert.strictEqual(r.body.read_only, true); assert.deepStrictEqual(writes(w), []); R = r.body; }
  });
  await t('the real PDF is read: 4 statement lines, totals agree, all four match HCPS sales', async () => {
    const S = R.statements[0]; assert.strictEqual(S.ok, true, JSON.stringify(S.problems)); assert.strictEqual(S.lines, 4); assert.strictEqual(S.matched, 4); assert.strictEqual(S.total_due, 336.33);
    assert.strictEqual(R.review.length, 0); assert.deepStrictEqual(R.problems, []);
  });
  await t('September shape: export orders (created in Sept) and statement orders (earlier sales) are different orders, each counted once', async () => {
    const o = id => R.orders.find(x => x.order === id);
    assert.strictEqual(o('7139').earned, 96.03); assert.strictEqual(o('7139').reported_due, 0); assert.strictEqual(o('7139').stage, 'earned');
    assert.strictEqual(o('7174').earned, 49.14); assert.strictEqual(o('7191').earned, 0);
    assert.strictEqual(o('7240').earned, 0); assert.strictEqual(o('7240').eligibility, 'pending_status');
    assert.strictEqual(o('7060').earned, 93.33); assert.strictEqual(o('7060').reported_due, 93.33); assert.strictEqual(o('7060').stage, 'reported_due');
    assert.strictEqual(o('5804').earned, 28.8); assert.ok(o('5804').labels.includes('earlier_statements_not_on_file') && !o('5804').labels.some(l => l.startsWith('potentially')));
  });
  await t('totals: earned · reported due · paid · outstanding side by side, never added together', async () => {
    const s = R.summary;
    assert.strictEqual(s.earned, 510.3);
    assert.strictEqual(s.reported_due, 336.33); assert.strictEqual(s.paid, 0); assert.strictEqual(s.outstanding, s.earned);
    assert.strictEqual(s.earned_not_reported, Math.round((96.03 + 49.14 + 28.8) * 100) / 100);
    assert.strictEqual(s.payment_unverified, 4, 'SR032 "due" is not a payment');
  });
  await t('drilldown groups by dealer, month, reporting month and manufacturer', async () => {
    assert.ok(R.groups.month.some(g => g.key === '2026-09')); assert.ok(R.groups.reporting_month.some(g => g.key === '2026-09' && g.reported_due === 336.33));
    assert.strictEqual(R.groups.manufacturer[0].earned, R.summary.earned); assert.ok(R.groups.dealer.length >= 5);
  });
  await t('posting preview: the not-yet-imported export only (eligible orders), statements never posted, no ledger write', async () => {
    const P = R.posting_preview; assert.strictEqual(P.statements_posted, false); assert.ok(/stay out of monthly_sales/.test(P.statements_note));
    const x = P.exports[0]; assert.strictEqual(x.source_id, 8); assert.strictEqual(x.orders, 4); assert.strictEqual(x.amount, 1913); assert.strictEqual(x.earned, 145.17);
    assert.deepStrictEqual(x.not_eligible.map(n => n.order), ['7240']); assert.strictEqual(P.commission_lane_rows, 0); assert.strictEqual(P.commission_lane_warning, null);
  });
  await t('a commission-lane row already in monthly_sales is called out as a possible second copy', async () => {
    const { m } = boot({ laneRows: [{ id: 99, period: '2026-08-01', amount: 100, commission: 9 }] }); const r = await call(m, { action: 'commission_recon' }, { token: 'pres' });
    assert.strictEqual(r.body.posting_preview.commission_lane_rows, 1); assert.ok(/second copy/.test(r.body.posting_preview.commission_lane_warning));
  });
  await t('the evidence store is optional: "not installed" until Phase F; with events, payments are applied', async () => {
    assert.strictEqual(R.evidence_store, 'not_installed');
    const { m } = boot({ events: [{ id: 1, kind: 'payment', source_id: 9, amount: 336.33, paid_on: '2026-10-15', evidence: 'ACH', reason: 'paid in full', actor: 'staff:angelo@hcps.us', created_at: 'x' }] });
    const r = await call(m, { action: 'commission_recon' }, { token: 'pres' }); assert.strictEqual(r.body.evidence_store, 'installed');
    assert.strictEqual(r.body.summary.paid, 336.33); assert.strictEqual(r.body.summary.payment_unverified, 0);
  });
  await t('a tampered stored file is not read (SHA-256), and the problem is reported', async () => {
    const { m } = boot({ tamper: true }); const r = await call(m, { action: 'commission_recon' }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.ok(r.body.problems.some(p => /SHA-256/.test(p))); assert.ok(!r.body.orders.some(o => o.order === '7139'));
  });
  await t('an unreadable table is a 503, never an empty reconciliation; a manufacturer without a contract is 422', async () => {
    const { m } = boot({ failRead: u => /monthly_sales/.test(u) }); const r = await call(m, { action: 'commission_recon' }, { token: 'pres' }); assert.strictEqual(r.status, 503);
    const b = boot(); const x = await call(b.m, { action: 'commission_recon', manufacturer: 'bemis' }, { token: 'pres' }); assert.strictEqual(x.status, 422);
  });
  await t('commission_event: President only; the actor is the sign-in; only the RPC is written; "not installed" is a 503', async () => {
    const a = boot(); const r = await call(a.m, { action: 'commission_event', kind: 'payment', source_id: 9, amount: 336.33, paid_on: '2026-10-15', evidence: 'ACH', reason: 'paid in full', actor: 'staff:someone@x' }, { token: 'admin' });
    assert.strictEqual(r.status, 403); assert.deepStrictEqual(writes(a.w), []);
    const b = boot(); const ok = await call(b.m, { action: 'commission_event', kind: 'payment', source_id: 9, amount: 336.33, paid_on: '2026-10-15', evidence: 'ACH 1', reason: 'paid in full', actor: 'staff:someone@x' }, { token: 'pres' });
    assert.strictEqual(ok.status, 200); assert.strictEqual(b.w.rpcs.length, 1); assert.strictEqual(b.w.rpcs[0].fn, 'hcps_mfr_commission_event'); assert.strictEqual(b.w.rpcs[0].p.actor, 'staff:angelo@hcps.us');
    assert.strictEqual(writes(b.w).length, 1);
    const c = boot({ rpc: () => ({ status: 404, body: { code: 'PGRST202' } }) }); const ni = await call(c.m, { action: 'commission_event', kind: 'review', source_id: 9, order_number: '1', decision: 'investigate', reason: 'check with Strongback' }, { token: 'pres' });
    assert.strictEqual(ni.status, 503); assert.strictEqual(ni.body.error, 'not_installed');
    const d = boot({ rpc: () => ({ status: 400, body: { message: 'new row violates check constraint "mfr_commission_events_payment_ck"' } }) });
    const bad = await call(d.m, { action: 'commission_event', kind: 'payment', source_id: 9, amount: 1, reason: 'no evidence given here' }, { token: 'pres' });
    assert.strictEqual(bad.status, 422); assert.strictEqual(bad.body.error, 'mfr_commission_events_payment_ck');
  });
  console.log(`\ncommission-recon api: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

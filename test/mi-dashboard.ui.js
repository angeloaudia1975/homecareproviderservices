/* Phase D — Manufacturer Intelligence dashboard page (src/admin/mi-dashboard.html/.js) in Chromium at 360 / 390 / 768 /
   1280: pending counts (incl. Ship-To from the queue), reconciliation, arrivals grid; no horizontal page scroll; no page
   error; read-only (only the dashboard and queue actions are called). Needs Playwright (PLAYWRIGHT=… module path). */
const http = require('http'), path = require('path'), fs = require('fs');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const D = require('../netlify/functions/_mi_dashboard.js');
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const P = (id, slug, kind, status, expected) => ({ id, code: `${slug}:${kind}`, manufacturer: slug, kind, status, rules: { expected } });
const data = D.build({ today: '2026-10-20', capture_start: '2026-09-01', months: 6, manufacturers: [{ slug: 'strongback-mobility', name: 'Strongback Mobility' }, { slug: 'bemis', name: 'Bemis' }, { slug: 'complete-medical-supplies', name: 'Complete Medical Supplies (a long manufacturer name)' }],
  profiles: [P(1, 'strongback-mobility', 'commission_statement', 'active', { cadence: 'monthly', days: [2, 7] }), P(2, 'strongback-mobility', 'sales_export', 'active', { cadence: 'on_request' }),
    P(3, 'strongback-mobility', 'dealer_report', 'active', { cadence: 'monthly', days: [6, 12] }), P(4, 'bemis', 'commission_statement', 'draft', { cadence: 'monthly', days: [17, 17] }),
    P(5, 'complete-medical-supplies', 'commission_statement', 'draft', { cadence: 'irregular' })],
  sources: [{ id: 9, manufacturer: 'strongback-mobility', kind: 'commission_statement', status: 'received', received_date: '2026-10-07', report_period_start: '2026-09-01', report_period_end: '2026-09-30' },
    { id: 7, manufacturer: 'strongback-mobility', kind: 'dealer_report', status: 'received', received_date: '2026-10-11', report_period_start: '2026-09-01', report_period_end: '2026-09-30' }],
  items: [{ manufacturer: 'bemis', kind: 'commission_statement', state: 'classified', period_start: '2026-08-01', period_end: '2026-08-31', profile_id: 4 }], coverage: {}, shipto: {} });
const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/.netlify/functions/')) {
    let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}'); calls.push([u.pathname, b.action]);
    let out = {};
    if (u.pathname.endsWith('mfr-reports-api') && b.action === 'dashboard') out = Object.assign({ ok: true, read_only: true }, data);
    if (u.pathname.endsWith('shipto-review-api') && b.action === 'queue') out = { ok: true, held: 1, reports: [{ counts: { needs_review: 3 } }] };
    if (u.pathname.endsWith('shipto-review-api') && b.action === 'quarantine_review') out = { ok: true, read_only: true, period: '2026-09',
      quarantined: [{ quarantine_id: 1, source: 'commission', source_file: 'Strongback Sept Commission Report 2026.csv', reason: 'blank amount and commission',
        original: { customer_name: 'Harmon Medical Supply (a long dealer name that must wrap on a narrow phone)', dealer: 'Harmon Medical Supply', amount: null, commission: null },
        matches: [{ source_id: 8, order_number: '7139', amount: 1067, basis: 'customer' }] }],
      totals: { rows: 7, with_amount: 0, with_commission: 0 }, registered_reports: [{ id: 8, title: 'Strongback — order export 2026-09', status: 'received', imported: false }],
      in_monthly_sales: { rows: 0 }, choices: [{ key: 'keep_quarantined', text: 'Keep the 7 rows quarantined.' }, { key: 'restore', text: 'Restore (not recommended).' }] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); return;
  }
  const f = path.join(ADMIN, path.basename(u.pathname));
  if (u.pathname.startsWith('/admin/') && fs.existsSync(f)) { res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : (f.endsWith('.js') ? 'text/javascript' : 'text/html') }); res.end(fs.readFileSync(f)); return; }
  res.writeHead(404); res.end('');
});
const fails = []; const check = (c, w) => { if (!c) { fails.push(w); console.log('FAIL ' + w); } else console.log('ok   ' + w); };
(async () => {
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const errors = [];
  for (const w of [1280, 768, 390, 360]) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'angelo@homecareproviderservices.us', role: 'president', name: 'Angelo' })); } catch (e) {} });
    await page.goto(base + '/admin/mi-dashboard.html'); await page.waitForSelector('.cal');
    const txt = await page.locator('#body').textContent();
    check(/Monthly reconciliation — September 2026/.test(txt) && /Ready/.test(txt), `${w}px: reconciliation for September, ready`);
    check(/Missing/.test(txt) && /Captured \(draft profile\)/.test(txt), `${w}px: missing and captured-by-draft months shown`);
    const sh = await page.locator('.kpi', { hasText: 'Ship-To: orders needing review' }).locator('.v').textContent(); check(sh.trim() === '3', `${w}px: Ship-To count from the queue (${sh})`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 0, `${w}px: no horizontal page scroll (${over}px)`);
    check(/quarantined September 2026 Strongback rows/.test(txt) && /Your choices/.test(txt) && /order 7139/.test(txt), `${w}px: quarantine review card shown (read only)`);
    check(/Expected/.test(txt) && /Arrived/.test(txt), `${w}px: reconciliation shows expected window and arrival`);
    check(/Not received — overdue/.test(txt) && /not received · 3 days late/.test(txt) && /Needs attention/.test(txt), `${w}px: overdue report counted in days; summary and attention column`);
    await page.close();
  }
  check(calls.every(([p, a]) => (p.endsWith('mfr-reports-api') && a === 'dashboard') || (p.endsWith('shipto-review-api') && (a === 'queue' || a === 'quarantine_review')) || !/mfr-reports|shipto/.test(p)), 'read-only: only dashboard + queue are called');
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
  console.log(`\nmi-dashboard-ui: ${fails.length ? 'FAILED ' + fails.length : 'all checks passed'}`);
  process.exit(fails.length ? 1 : 0);
})();

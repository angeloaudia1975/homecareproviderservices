/* Commission Reconciliation page (src/admin/commission-recon.html/.js) in Chromium at 1280 / 768 / 390 / 360: the four
   stages side by side, drilldowns, filters, order detail, review list, statements, posting preview; no horizontal page
   scroll; no page error; read-only for an Admin (no write buttons); the President's payment form sends exactly one
   commission_event. Needs Playwright (PLAYWRIGHT=… module path). */
const http = require('http'), path = require('path'), fs = require('fs');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const CT = require('../netlify/functions/_contract_commission.js');
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const SEPT = ['September 2026', '7060 Dealer A Pharmacy $1037 $93.33', '6698 Dealer B Retail $440 $39.60', '6737 Dealer B Retail $1320 $118.80', '9999 Unknown Co $940 $84.60',
  'Total Orders: $3737', 'Total Commission Due: $336.33'];
const H = (o, a, d) => ({ order: o, order_key: o, date: d, company: 'Dealer ' + o + ' with a long name that must wrap on a phone', dealer_id: 'd' + o, lines: 1, amount: a, ledger_commission: Math.round(a * 9) / 100, status: null, sources: [{ kind: 'hcps_sales', rows: [1] }] });
const X = (o, a, d, st) => ({ order: o, order_key: o, date: d, company: 'Dealer ' + o, lines: 1, amount: a, status: st || 'Shipped', dealer_paid: 'no', sources: [{ kind: 'export', source_id: 8, file_name: 'Angelo Sep Orders.csv', lines: [2] }] });
function data(installed) {
  const rec = CT.reconcile({ slug: 'strongback-mobility', today: '2026-10-12', history: [H('7060', 1037, '2026-08-20'), H('6698', 440, '2026-06-10'), H('6737', 1320, '2026-07-01'), H('5804', 320, '2026-05-02')],
    exports: [X('7139', 1067, '2026-09-04'), X('7174', 546, '2026-09-15'), X('7240', 300, '2026-09-28', 'Pending')],
    statements: [{ source_id: 9, file_name: '2026-09 SR032.pdf', period: '2026-09', received_date: '2026-10-07', parsed: CT.parseSr032(SEPT) }], events: [] });
  rec.problems = []; rec.evidence_store = installed ? 'installed' : 'not_installed';
  rec.groups = { dealer: CT.groupBy(rec, 'dealer'), month: CT.groupBy(rec, 'month'), reporting_month: CT.groupBy(rec, 'reporting_month'), manufacturer: CT.groupBy(rec, 'manufacturer') };
  rec.posting_preview = { exports: [{ source_id: 8, file_name: 'Angelo Sep Orders.csv', period: '2026-09', orders: 3, lines: 3, amount: 1913, earned: 145.17, not_eligible: [{ order: '7240', why: 'Status "Pending"' }], already_in_hcps: 0 }],
    statements_posted: false, statements_note: 'SR032 statements stay out of monthly_sales: the same commission is already there as earned on the sale.', commission_lane_rows: 0, commission_lane_warning: null };
  return Object.assign({ ok: true, read_only: true, manufacturer: 'strongback-mobility' }, rec);
}
const calls = []; let INSTALLED = true;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/.netlify/functions/')) {
    let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}'); calls.push([u.pathname, b.action, b]);
    let out = {};
    if (b.action === 'commission_recon') out = data(INSTALLED);
    if (b.action === 'commission_event') out = { ok: true, event_id: 1, kind: b.kind };
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
  const open = async (w, role) => { const page = await browser.newPage({ viewport: { width: w, height: 900 } }); page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(r => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'x@hcps.us', role: r, name: 'X' })); } catch (e) {} }, role);
    await page.goto(base + '/admin/commission-recon.html'); await page.waitForSelector('.kpis'); return page; };
  for (const w of [1280, 768, 390, 360]) {
    const page = await open(w, 'president');
    const txt = await page.locator('#body').textContent();
    check(/Earned — Contract Rate 9%/.test(txt) && /Reported due \(SR032\)/.test(txt) && /Paid \(with evidence\)/.test(txt) && /Outstanding/.test(txt), `${w}px: four stages shown`);
    check(/never added together/.test(txt) && !/Estimated/.test(txt), `${w}px: "never added together"; nothing called an estimate`);
    check(/Needs review/.test(txt) && /9999/.test(txt), `${w}px: the unmatched statement line is in review`);
    check(/Posting preview — nothing is posted/.test(txt) && /stay out of monthly_sales/.test(txt), `${w}px: posting preview, statements not posted`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(over <= 0, `${w}px: no horizontal page scroll (${over}px)`);
    await page.click('[data-f="not_reported"]'); let t2 = await page.locator('tbody').first().textContent();
    check(/7139/.test(t2) && /5804/.test(t2) && !/7060/.test(t2), `${w}px: filter "earned, not reported yet"`);
    await page.click('[data-f="all"]'); await page.click('tr.row[data-o="7060"]'); t2 = await page.locator('tr.det').textContent();
    check(/SR032|Statement lines/.test(t2) && /no payment evidence recorded/.test(t2), `${w}px: order detail opens with statement line and payment state`);
    await page.click('[data-g="reporting_month"]'); t2 = await page.locator('#body').textContent(); check(/not reported yet/.test(t2) && /Sep 2026/.test(t2), `${w}px: drilldown by reporting month`);
    await page.click('[data-g="dealer"]'); await page.click('[data-g="month"]'); await page.click('[data-g="manufacturer"]'); t2 = await page.locator('#body').textContent();
    check(/strongback-mobility/.test(t2), `${w}px: drilldown by manufacturer`);
    const over2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); check(over2 <= 0, `${w}px: still no horizontal scroll after drilldowns (${over2}px)`);
    if (w === 390) {
      const n0 = calls.length; await page.click('[data-pay="0"]'); await page.fill('#pa', '336.33'); await page.fill('#pd', '2026-10-15'); await page.fill('#pe', 'ACH ref 1'); await page.fill('#pr', 'Strongback paid September in full');
      const box = await page.locator('#pgo').boundingBox(); check(box && box.height >= 44, '390px: payment button ≥ 44px tall');
      await page.click('#pgo'); await page.waitForTimeout(200);
      const ev = calls.slice(n0).filter(c => c[1] === 'commission_event'); check(ev.length === 1 && ev[0][2].kind === 'payment' && ev[0][2].source_id === 9 && ev[0][2].amount === '336.33', '390px: exactly one payment event, for statement #9');
    }
    await page.close();
  }
  { const page = await open(1280, 'admin'); const txt = await page.locator('#body').textContent();
    check(await page.locator('[data-pay],[data-rv]').count() === 0 && /Needs review/.test(txt), 'Admin: same view, no write buttons'); await page.close(); }
  INSTALLED = false;
  { const page = await open(1280, 'president'); const txt = await page.locator('#body').textContent();
    check(await page.locator('[data-pay],[data-rv]').count() === 0 && /mi_f_commission_events\.sql/.test(txt), 'store not installed: no write buttons, says what is needed'); await page.close(); }
  const other = calls.filter(c => /mfr-reports-api/.test(c[0]) && !['commission_recon', 'commission_event'].includes(c[1]));
  check(other.length === 0, 'Report History API: only the reconciliation and the President\'s event were called ' + JSON.stringify(other.map(c => c[0] + ':' + c[1])));
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : '\ncommission-recon ui: all passed'); process.exit(fails.length ? 1 : 0);
})();

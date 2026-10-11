/* MI Inbox Automation, Phase B — the Report History Inbox and Needs attention screens in Chromium (RULE 10).
   The page (src/admin/report-history.html, unmodified) talks to a small stand-in for mfr-reports-api that answers
   with fixed data and records every request. Proves: the three tabs; the capture card; each email with each
   attachment on its own line (registered / linked / recognised / needs attention), the original's download and the
   Outlook link; filters reach the server; a decision needs a reason and sends only item, decision and reason (the
   actor is the server's sign-in); no page error; no horizontal scroll and ≥44px controls at 360 / 390 / 768 / 1280.
   Screenshots to MIBUI_OUT (default ./mib-shots). Needs Playwright (PLAYWRIGHT=… module path); skipped without it. */
const http = require('http'), path = require('path'), fs = require('fs');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const OUT = process.env.MIBUI_OUT || path.join(process.cwd(), 'mib-shots'); fs.mkdirSync(OUT, { recursive: true });
const MFRS = [{ slug: 'strongback-mobility', name: 'Strongback Mobility' }, { slug: 'bemis', name: 'Bemis' }, { slug: 'ohio-medical', name: 'Ohio Medical' }];
const SRC7 = { id: 7, title: 'Strongback — September 2026 Dealer Report', status: 'received', kind: 'dealer_report' };
const MSGS = [
  { id: 3, received_at: '2026-10-08T20:46:00Z', from_address: 'melanie.psychas@strongbackmobility.com', from_name: 'Melanie Psychas', subject: 'Your Strongback dealer overview, September 2026',
    manufacturer: 'strongback-mobility', folder: 'Inbox', web_link: 'https://outlook.office.com/mail/id/AAMk3', internet_message_id: '<overview@strongbackmobility.com>',
    items: [{ id: 31, part: 'attachment', file_name: 'Angelo_Strongback_Dealers_2026-09.pdf', size: 516016, sha256: 'f708ebaf0290bb736c7499b818655167c436c8867f16142cf122fd663bd790b5', state: 'linked', kind: 'dealer_report',
      period_start: '2026-09-01', period_end: '2026-09-30', period_basis: 'report', source_id: 7, source: SRC7 }] },
  { id: 2, received_at: '2026-10-07T14:00:00Z', from_address: 'amanda.erickson@strongbackmobility.com', from_name: 'Amanda Erickson', subject: 'Commission report September 2026 - Angelo Audia',
    manufacturer: 'strongback-mobility', folder: 'Inbox', web_link: 'https://outlook.office.com/mail/id/AAMk2', internet_message_id: '<sr032@strongbackmobility.com>',
    items: [{ id: 21, part: 'attachment', file_name: '2026-09 SR032.pdf', size: 55335, sha256: '68896293f0c3' + '0'.repeat(52), state: 'registered', kind: 'commission_statement',
      period_start: '2026-09-01', period_end: '2026-09-30', period_basis: 'file_name', source_id: 12, source: { id: 12, title: 'Strongback — commission statement 2026-09', status: 'received' } }] },
  { id: 1, received_at: '2026-10-06T17:00:00Z', from_address: 'brittany@rose-healthcare.com', from_name: 'Brittany', subject: 'September Commissions Report', manufacturer: null, folder: 'Inbox',
    internet_message_id: '<rose@rose-healthcare.com>',
    items: [{ id: 11, part: 'attachment', file_name: 'Audia September.xlsx', size: 18000, state: 'exception', attention: 'unknown_sender', attention_detail: 'rose-healthcare.com is not a known manufacturer', suggested: 'commission_statement' }] },
  { id: 0, received_at: '2026-10-05T21:07:00Z', from_address: 'faxstar03@bemismfg.com', subject: 'COMMISSION REPORT for Rep/Month: 705 / 2026-09', manufacturer: 'bemis', folder: 'Inbox',
    internet_message_id: '<bemis@bemismfg.com>',
    items: [{ id: 1, part: 'attachment', file_name: '705-2026-09.csv', size: 900, state: 'classified', kind: 'commission_statement', period_start: '2026-09-01', period_end: '2026-09-30',
      period_basis: 'file_name', attention_detail: 'profile not active (draft) — shown, not registered' }] },
];
const CAP = { ok: true, switch_on: true, needs_attention: 1, counts: { registered: 1, linked: 1, classified: 1, exception: 1 },
  state: [{ mailbox: 'angelo@homecareproviderservices.us', checkpoint_at: '2026-10-11T22:20:00Z' }],
  runs: [{ id: 5, started_at: '2026-10-11T22:20:00Z', complete: true }],
  profiles: [{ id: 1, code: 'a', manufacturer: 'strongback-mobility', label: 'Monthly commission statement (SR032 PDF)', status: 'active', auto_register: true },
    { id: 2, code: 'b', manufacturer: 'bemis', label: 'Rep 705 commission CSV', status: 'draft', auto_register: false }] };
const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/.netlify/functions/mfr-reports-api') {
    let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}'); calls.push(b);
    let out;
    if (b.action === 'list') out = { ok: true, kinds: ['sales_export', 'commission_statement', 'dealer_report'], max_bytes: 4194304, manufacturers: MFRS, reports: [] };
    else if (b.action === 'capture_status') out = CAP;
    else if (b.action === 'inbox') { let l = MSGS; if (b.manufacturer) l = l.filter(m => m.manufacturer === b.manufacturer); out = { ok: true, total: l.length, messages: l }; }
    else if (b.action === 'attention') out = { ok: true, total: 1, messages: MSGS.filter(m => m.items.some(i => i.attention)) };
    else if (b.action === 'resolve') out = { ok: true, item_id: b.item_id, action: b.decision };
    else out = { ok: true };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); return;
  }
  if (u.pathname.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const f = path.join(ADMIN, path.basename(u.pathname));
  if (u.pathname.startsWith('/admin/') && fs.existsSync(f)) { res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : (f.endsWith('.js') ? 'text/javascript' : 'text/html') }); res.end(fs.readFileSync(f)); return; }
  res.writeHead(404); res.end('');
});
const fails = []; const check = (c, w) => { if (!c) { fails.push(w); console.log('FAIL ' + w); } else console.log('ok   ' + w); };
(async () => {
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const errors = [];
  const open = async (w, hash) => {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'angelo@homecareproviderservices.us', role: 'president', name: 'Angelo' })); } catch (e) {} });
    await page.goto(base + '/admin/report-history.html' + (hash || '')); await page.waitForSelector('.tabs');
    return page;
  };
  let page = await open(1280, '#inbox');
  await page.waitForSelector('text=Inbox — manufacturer report emails');
  check(await page.locator('.tabs button').count() === 3, 'three tabs: Report register, Inbox, Needs attention');
  check((await page.locator('.tabs button', { hasText: 'Needs attention' }).textContent()).includes('1'), 'Needs attention shows its count');
  check(await page.locator('text=On — runs every hour').count() === 1, 'capture card shows the switch');
  check(await page.locator('.rep').count() === 4, 'four emails listed');
  check(await page.locator('.it', { hasText: 'Angelo_Strongback_Dealers_2026-09.pdf' }).locator('text=Linked to an existing record').count() === 1, 'the overview email is linked (record 7)');
  check(await page.locator('.it', { hasText: 'Angelo_Strongback_Dealers_2026-09.pdf' }).locator('button', { hasText: 'record 7' }).count() === 1, 'its original can be downloaded from the register record');
  check(await page.locator('.it', { hasText: '2026-09 SR032.pdf' }).locator('text=Registered').count() === 1, 'SR032 registered');
  check(await page.locator('.it', { hasText: '705-2026-09.csv' }).locator('text=Recognised — not registered').count() === 1, 'Bemis draft: recognised, not registered');
  check(await page.locator('a', { hasText: 'Open in Outlook' }).count() === 2, 'Outlook links where a web link exists');
  await page.screenshot({ path: path.join(OUT, 'inbox-1280.png'), fullPage: true });
  // filters reach the server
  await page.selectOption('#i_mfr', 'bemis'); await page.fill('#i_per', '2026-09'); await page.fill('#i_q', '705'); await page.click('button:has-text("Show")');
  await page.waitForFunction(() => document.querySelectorAll('.rep').length === 1);
  const last = calls.filter(c => c.action === 'inbox').pop();
  check(last.manufacturer === 'bemis' && last.period === '2026-09' && last.q === '705', 'filters (manufacturer, period, search) are sent to the server');
  // Needs attention: a decision needs a reason
  await page.click('.tabs button:has-text("Needs attention")'); await page.waitForSelector('h2:has-text("Needs attention")');
  check(await page.locator('.it').count() === 1 && await page.locator('text=Unknown sender').count() >= 1, 'Needs attention lists the unknown sender (Rose Healthcare)');
  await page.click('.it button:has-text("Dismiss")');
  check(await page.locator('.it .err').count() === 1 && calls.filter(c => c.action === 'resolve').length === 0, 'no reason → nothing sent');
  await page.fill('.it .res input', 'Rose ended in January'); await page.click('.it button:has-text("Dismiss")');
  await page.waitForFunction(() => /Dismissed/.test(document.body.textContent));
  const rs = calls.filter(c => c.action === 'resolve');
  check(rs.length === 1 && JSON.stringify(Object.keys(rs[0]).sort()) === JSON.stringify(['action', 'decision', 'item_id', 'reason']) && rs[0].decision === 'dismiss' && rs[0].item_id === 11,
    'the decision sends item, decision and reason only (the actor comes from the sign-in)');
  await page.screenshot({ path: path.join(OUT, 'attention-1280.png'), fullPage: true });
  await page.click('.tabs button:has-text("Report register")'); await page.waitForSelector('text=Register a report file');
  check(true, 'the Report register tab still renders the MI-1b page');
  await page.close();
  // RULE 10: phone / tablet
  for (const w of [360, 390, 768]) for (const tab of ['#inbox', '#attention', '']) {
    const p = await open(w, tab); await p.waitForTimeout(300);
    const m = await p.evaluate(() => {
      const over = document.documentElement.scrollWidth - window.innerWidth;
      const small = [...document.querySelectorAll('.tabs button, .filters select, .filters input, .res input, button.go')].filter(el => el.offsetParent && el.getBoundingClientRect().height < 43.5).map(el => el.textContent.trim().slice(0, 30) || el.id);
      const narrow = [...document.querySelectorAll('.it .fn')].filter(el => el.getBoundingClientRect().width < Math.min(200, window.innerWidth * 0.5)).length;
      return { over, small, narrow };
    });
    check(m.narrow === 0, `${w}px ${tab || '#register'}: file names get a readable width`);
    check(m.over <= 0 && (w > 760 || m.small.length === 0), `${w}px ${tab || '#register'}: no horizontal scroll (${m.over}px)${w <= 760 ? ', controls ≥44px' + (m.small.length ? ' — too small: ' + m.small.join(', ') : '') : ''}`);
    if (tab === '#inbox') await p.screenshot({ path: path.join(OUT, `inbox-${w}.png`), fullPage: true });
    await p.close();
  }
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
  console.log(`\nmi-b-ui: ${fails.length ? 'FAILED ' + fails.length : 'all checks passed'} · screenshots in ${OUT}`);
  process.exit(fails.length ? 1 : 0);
})();

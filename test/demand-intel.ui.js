/* C3-07 Stage 8 — the Demand Intelligence page (src/admin/demand-intel.html, unmodified) in Chromium (RULE 10). A stand-in
   demand-intel-api answers with the REAL _demand.js report built from synthetic counts. Proves: figures render and are escaped;
   the period selector reloads; "interest, not sales" wording present; before the SQL a plain note; an error shows a message;
   no page error; no horizontal scroll; 16 px select on phones; at 390 / 768 / 1280. Also the Dealer 360 page source carries the
   storefront demand card wired to the dealer action and the Command Center card hides itself while viewing another rep.
   Needs Playwright (PLAYWRIGHT=… module path); skipped without it. */
const http = require('http'), path = require('path'), fs = require('fs');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const DM = require(path.join(__dirname, '..', 'netlify', 'functions', '_demand.js'));
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const D = new Map([['a', { name: 'Acme <b>Medical</b>', city: 'Dayton', state: 'OH', root: 'a' }], ['b', { name: 'Bravo', city: 'Nashville', state: 'TN', root: 'b' }]]);
const counts = [{ dealer_id: 'a', manufacturer: 'bemis', code: 'B1', category: 'Bath Safety', views: 30, inquiries: 2 }, { dealer_id: 'b', manufacturer: 'strongback', code: 'S1', category: 'Wheelchairs', views: 8, inquiries: 3 }];
const REPORT = Object.assign({ ok: true, installed: true, days: 30, since: '2026-10-08' }, DM.build({ counts, dealers: D, names: { bemis: { B1: 'Raised <script>seat</script>' } }, mfrName: { bemis: 'Bemis', strongback: 'Strongback' }, scopeIds: null, bought: new Map(), network: new Map() }));
let MODE = 'ok'; const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/.netlify/functions/demand-intel-api') {
    let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}'); calls.push(b);
    const out = MODE === 'off' ? { ok: true, installed: false, days: b.days } : MODE === 'err' ? { ok: false, error: 'Demand figures could not be loaded just now — please try again.' } : Object.assign({}, REPORT, { days: b.days });
    res.writeHead(MODE === 'err' ? 503 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); return;
  }
  if (u.pathname.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const f = path.join(ADMIN, path.basename(u.pathname));
  if (u.pathname.startsWith('/admin/') && fs.existsSync(f)) { res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : (f.endsWith('.js') ? 'text/javascript' : 'text/html') }); res.end(fs.readFileSync(f)); return; }
  res.writeHead(404); res.end('');
});
const fails = []; const check = (c, w) => { if (!c) { fails.push(w); console.log('FAIL ' + w); } else console.log('ok   ' + w); };
(async () => {
  await new Promise((r) => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    for (const [w, h, label] of [[390, 844, 'phone'], [768, 1024, 'tablet'], [1280, 900, 'desktop']]) {
      MODE = 'ok'; const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 1024 }); const page = await ctx.newPage(); const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'angelo@homecareproviderservices.us', role: 'president', name: 'Angelo' })); } catch (e) {} });
      await page.goto(base + '/admin/demand-intel.html'); await page.waitForSelector('.dmk');
      const r = await page.evaluate(() => ({ text: document.body.textContent, script: !!document.querySelector('#body script, #body b b'), over: document.documentElement.scrollWidth - innerWidth,
        sel: parseFloat(getComputedStyle(document.getElementById('dmd')).fontSize), selH: document.getElementById('dmd').getBoundingClientRect().height }));
      check(/Raised <script>seat<\/script>/.test(r.text) && /Acme <b>Medical<\/b>/.test(r.text) && !r.script, label + ': names shown as text (escaped)');
      check(/Interest is not a sale/.test(r.text) && /Product views/.test(r.text) && /Requests per 100 views/.test(r.text), label + ': interest wording, never sales');
      check(r.over <= 1, label + ': no horizontal scroll (' + r.over + ')');
      check(w >= 860 || r.sel >= 16, label + ': 16 px select on phones'); check(r.selH >= 43.5, label + ': 44 px select');
      calls.length = 0; await page.selectOption('#dmd', '90'); await page.waitForTimeout(300);
      check(calls.some((c) => c.action === 'overview' && c.days === 90), label + ': the period reloads');
      MODE = 'off'; await page.reload(); await page.waitForSelector('.dmnote'); check(/aren't switched on yet/.test(await page.textContent('#body')), label + ': before the SQL, a plain note');
      MODE = 'err'; await page.reload(); await page.waitForSelector('.dmnote'); check(/could not be loaded/.test(await page.textContent('#body')), label + ': an error shows a message');
      check(!errors.length, label + ': no page error ' + errors.join(' | '));
      await ctx.close();
    }
    const d360 = fs.readFileSync(path.join(ADMIN, 'dealer.html'), 'utf8'), cc = fs.readFileSync(path.join(ADMIN, 'command-center-rep.html'), 'utf8');
    check(/loadAcademy360\(\); loadDemand360\(\);/.test(d360) && /action:"dealer",dealer_id:want,days:90/.test(d360) && /\$\{demandCard\}/.test(d360), 'Dealer 360: storefront demand card wired to the dealer action');
    check(/if\(j\.header&&j\.header\.viewing_other\)\{ box\.innerHTML=""; return; \}/.test(cc), 'Command Center: card hidden while viewing another rep');
  } finally { await browser.close(); server.close(); }
  console.log(`\ndemand-intel ui: ${fails.length ? fails.length + ' failed' : 'all passed'}`); process.exit(fails.length ? 1 : 0);
})();

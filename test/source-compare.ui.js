/* Manufacturer Center → "Compare a reviewed price list" in Chromium at 1280 / 768 / 390 / 360: load an importer
   line.json, compare (stub server running the REAL _source_compare.js over synthetic products), the states and changed
   field names show, filters work, no figure from the file or the catalog is on screen, no horizontal scroll, controls
   >= 44 px, no page error. Needs Playwright. */
const http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const SC = require('../netlify/functions/_source_compare.js');
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const products = [{ code: 'A1', base_price: 101.11 }, { code: 'A2', base_price: 303.33 }, { code: 'GONE', base_price: 505.55 }];
const LINE = { manufacturer: 'acme', source: { file: 'Acme 2026.xlsx', sha256: 'b'.repeat(64), received_date: null, effective_date_status: 'not_stated' },
  rows: [{ code: 'A1', dealer_price: 101.11, locator: 'p1 r1' }, { code: 'A2', dealer_price: 313.37, locator: 'p1 r2' }, { code: 'NEW', dealer_price: 77.07 }] };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')), 'line.json'); fs.writeFileSync(file, JSON.stringify(LINE));
const FIG = ['101.11', '303.33', '505.55', '313.37', '77.07'];
const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/.netlify/functions/')) { let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}');
    if (u.pathname.endsWith('/catalog-api')) calls.push(b.action);
    const send = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (b.action === 'mc_overview') return send({ ok: true, lines: [{ slug: 'acme', name: 'Acme', deferrals: [] }, { slug: 'other', name: 'Other', deferrals: [] }] });
    if (b.action === 'mc_pipeline') return send({ ok: true, generated: '2026-10-27T12:00:00Z', lines: [], steps: [] });
    if (b.action === 'source_compare') return send(Object.assign({ generated: 'x' }, SC.compareSource({ slug: b.manufacturer, line: b.line, products, identity: 'c'.repeat(64), authority: 'layers' })));
    return send({ ok: true }); }
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
    const pg = await browser.newPage({ viewport: { width: w, height: 900 }, hasTouch: w < 800, isMobile: w < 800 });
    pg.on('pageerror', e => errors.push(e.message));
    await pg.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'angelo@homecareproviderservices.us', role: 'president', name: 'Angelo' })); } catch (e) {} });
    await pg.goto(base + '/admin/manufacturer-center.html'); await pg.waitForSelector('#sc-file', { timeout: 15000 });
    check(await pg.$eval('#sc-go', b => b.disabled), `${w}px: Compare disabled until a line.json is chosen`);
    await pg.setInputFiles('#sc-file', file);
    await pg.waitForFunction(() => !document.querySelector('#sc-go').disabled);
    check(await pg.$eval('#sc-line', s => s.value) === 'acme', `${w}px: the line is picked from the file`);
    await pg.click('#sc-go'); await pg.waitForSelector('.sc-row');
    const r = await pg.evaluate(() => ({ text: document.querySelector('#srccmp').innerText, rows: document.querySelectorAll('.sc-row').length,
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small: [...document.querySelectorAll('#srccmp button, #srccmp select, #srccmp input')].filter(e => { const b = e.getBoundingClientRect(); return b.height > 0 && b.height < 44; }).length }));
    check(r.rows === 4 && /Changed/i.test(r.text) && /dealer_price/.test(r.text) && /Added/i.test(r.text) && /Not on source/i.test(r.text) && /Unchanged/i.test(r.text), `${w}px: states and changed field names shown (${r.rows} rows)`);
    check(!FIG.some(f => r.text.includes(f)) && !/\$\s*\d/.test(r.text), `${w}px: no price on screen`);
    check(r.over <= 1, `${w}px: no horizontal scroll (${r.over})`);
    check(r.small === 0, `${w}px: controls >= 44 px (${r.small})`);
    await pg.click('.sc-f[data-s="changed"]');
    check(await pg.evaluate(() => document.querySelectorAll('.sc-row').length) === 1, `${w}px: the Changed filter narrows the list`);
    await pg.close();
  }
  await browser.close(); server.close();
  check(!errors.length, 'no page error' + (errors.length ? ': ' + errors[0] : ''));
  check(calls.filter(a => a === 'source_compare').length === 4 && calls.every(a => ['mc_overview', 'mc_pipeline', 'source_compare'].includes(a)), 'read-only calls only (' + [...new Set(calls)].join(', ') + ')');
  console.log(`\nsource compare page: ${fails.length ? fails.length + ' failed' : 'all passed'}`); process.exit(fails.length ? 1 : 0);
})();

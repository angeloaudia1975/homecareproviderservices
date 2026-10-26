/* Catalog Exceptions page (src/admin/catalog-exceptions.html/.js) in Chromium at 1280 / 768 / 390 / 360: tiles and line
   cards render from the real classifier, the category filter and line detail work, touch targets are >= 44 px, no
   horizontal page scroll, no page error, no price on screen, read-only (only catalog_exceptions is called), and an
   unreadable queue shows an error instead of an empty list. Synthetic data only. Needs Playwright. */
const http = require('http'), path = require('path'), fs = require('fs');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const CE = require('../netlify/functions/_catalog_exceptions.js');
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const pg = (m, key, status, codes, x) => Object.assign({ manufacturer: m, page_key: key, status, disabled: false, skus: codes.map(c => ({ sku: c })),
  description: 'A long enough description that easily passes the eighty character minimum for a product page.', features: ['a', 'b', 'c'], image: 'x.jpg', images_gallery: [] }, x || {});
const Q = CE.exceptionsQueue({
  manufacturers: [{ slug: 'acme-medical-supply-with-a-very-long-name', name: 'Acme Medical Supply With A Very Long Manufacturer Name', hasData: true, freight: {} },
    { slug: 'frozenco', name: 'Frozen Co', hasData: true, freight: {} }],
  catalogs: { 'acme-medical-supply-with-a-very-long-name': Array.from({ length: 40 }, (_, k) => ({ code: 'AC-' + k + '-LONGPARTNUMBER', image: k % 3 ? 'a.jpg' : '' })),
    frozenco: [{ code: 'F1', image: 'f.jpg' }] },
  skus: Array.from({ length: 40 }, (_, k) => ({ manufacturer: 'acme-medical-supply-with-a-very-long-name', code: 'AC-' + k + '-LONGPARTNUMBER', status: k === 39 ? 'retired' : 'active', uom: k % 4 ? 'Each' : (k % 8 ? 'Case' : ''), priced: k % 5 !== 0 }))
    .concat([{ manufacturer: 'frozenco', code: 'F1', status: 'active', uom: 'Each', priced: true }]),
  pages: [pg('acme-medical-supply-with-a-very-long-name', 'p1', 'published', ['AC-1-LONGPARTNUMBER', 'AC-39-LONGPARTNUMBER']), pg('acme-medical-supply-with-a-very-long-name', 'p2', 'published', ['AC-2-LONGPARTNUMBER'], { description: 'short', image: '' }), pg('frozenco', 'pf', 'published', ['F1'])],
  meta: [{ slug: 'frozenco', frozen: true, record_authoritative: true }], lines: {}, sources: {}, measured: { master: true, pages: true, runs: true } });
let mode = 'ok'; const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/.netlify/functions/')) {
    let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}'); calls.push([u.pathname, b.action]);
    if (mode === 'down') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'exceptions_unreadable', message: 'product_skus: HTTP 500' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Object.assign({ ok: true, generated: '2026-10-26T16:00:00Z' }, Q))); return;
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
    const page = await browser.newPage({ viewport: { width: w, height: 900 }, hasTouch: w < 800, isMobile: w < 800 });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'angelo@homecareproviderservices.us', role: 'president', name: 'Angelo' })); } catch (e) {} });
    await page.goto(base + '/admin/catalog-exceptions.html'); await page.waitForSelector('.tile', { timeout: 15000 });
    const r = await page.evaluate(() => ({ tiles: document.querySelectorAll('.tile').length, lines: document.querySelectorAll('.ln').length,
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth, panel: (document.querySelector('#panel') || {}).innerText || '',
      small: [...document.querySelectorAll('.tile,.ln,button.sec,.bar input,.acts a')].filter(e => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 44).length,
      dollars: /\$\s*\d/.test(document.body.innerText) }));
    check(r.tiles === 8 && r.lines === 2, `${w}px: 8 category tiles and 2 lines (${r.tiles}/${r.lines})`);
    check(r.over <= 1, `${w}px: no horizontal page scroll (${r.over})`);
    check(r.small === 0, `${w}px: every control >= 44 px tall (${r.small} smaller)`);
    check(/active sku without price/i.test(r.panel), `${w}px: the line with blockers opens first, with its pricing blocker`);
    check(!r.dollars, `${w}px: no price on screen`);
    await page.click('.tile[data-cat="units"]');
    const u = await page.evaluate(() => ({ on: !!document.querySelector('.tile.on[data-cat="units"]'), lines: document.querySelectorAll('.ln').length, panel: document.querySelector('#panel').innerText }));
    check(u.on && u.lines === 1 && /sku without unit/i.test(u.panel) && !/active sku without price/i.test(u.panel), `${w}px: the Units filter narrows lines and the detail`);
    await page.click('.ln[data-line="frozenco"]').catch(() => {});
    await page.click('#clr'); await page.click('.ln[data-line="frozenco"]');
    const fz = await page.evaluate(() => ({ note: /frozen/i.test(document.querySelector('#panel').innerText), links: document.querySelectorAll('#panel .acts a').length }));
    check(fz.note && fz.links === 0, `${w}px: a frozen line is read-only (note shown, no fix links)`);
    await page.close();
  }
  mode = 'down';
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await page.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); } catch (e) {} });
  await page.goto(base + '/admin/catalog-exceptions.html'); await page.waitForSelector('.err', { timeout: 15000 });
  check(/could not be read/i.test(await page.innerText('#body')) && !(await page.$('.tile')), 'an unreadable queue shows an error, never an empty list');
  await browser.close(); server.close();
  check(!errors.length, 'no page error' + (errors.length ? ': ' + errors[0] : ''));
  const cat = calls.filter(c => c[0].endsWith('/catalog-api'));
  check(cat.length > 0 && cat.every(c => c[1] === 'catalog_exceptions'), 'read-only: every catalog-api call is catalog_exceptions (' + [...new Set(calls.map(c => c[0].split('/').pop() + ':' + c[1]))].join(', ') + ')');
  console.log(`\ncatalog exceptions page: ${fails.length ? fails.length + ' failed' : 'all passed'}`); process.exit(fails.length ? 1 : 0);
})();

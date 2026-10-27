/* Manufacturer Center pipeline status in Chromium at 1280 / 768 / 390 / 360: the seven steps render per line from the
   real model (_mc_pipeline.js over _catalog_exceptions.js), filters work, every step links to its tool, the blocked
   reasons show, controls >= 44 px, no horizontal page scroll, no price, no page error. Synthetic data. Needs Playwright. */
const http = require('http'), path = require('path'), fs = require('fs');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const CE = require('../netlify/functions/_catalog_exceptions.js'), PL = require('../netlify/functions/_mc_pipeline.js');
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const page = (m, key, codes) => ({ manufacturer: m, page_key: key, status: 'published', disabled: false, skus: codes.map(c => ({ sku: c })),
  description: 'A long enough description that easily passes the eighty character minimum for a product page here.', features: ['a', 'b', 'c'], image: 'x.jpg', images_gallery: [] });
const q = CE.exceptionsQueue({ manufacturers: [{ slug: 'gold-standard-line', name: 'Gold Standard Line', hasData: true, freight: {} }, { slug: 'access-for-you-with-a-long-name', name: 'Access For You With A Long Manufacturer Name', hasData: true, freight: {} }, { slug: 'abm', name: 'ABM', hasData: false }],
  catalogs: { 'gold-standard-line': [{ code: 'G1', image: 'g.jpg' }], 'access-for-you-with-a-long-name': [{ code: 'SR3', image: 'r.png' }, { code: 'SR3', image: 'r.png' }, { code: 'MRS2x36', image: '' }] },
  skus: [{ manufacturer: 'gold-standard-line', code: 'G1', status: 'active', uom: 'Each', priced: true }], pages: [page('gold-standard-line', 'pg', ['G1'])],
  meta: [{ slug: 'gold-standard-line', frozen: true, record_authoritative: true }], lines: { 'gold-standard-line': { gold_standard: { id: 20 } } },
  sources: { 'gold-standard-line': { id: 1, legacy: true } }, measured: { master: true, pages: true, runs: true } });
const P = Object.assign({ ok: true, generated: '2026-10-26T20:00:00Z' }, PL.pipeline({ queue: q, sources: [{ id: 1, manufacturer: 'gold-standard-line', kind: 'price_list', status: 'accepted', legacy: true }], decisions: [] }));
const OV = { ok: true, lines: q.lines.map(l => ({ slug: l.slug, name: l.name, frozen: l.frozen, authoritative: l.frozen, deferrals: [], decisions: 0, sources: 0 })) };
const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/.netlify/functions/')) { let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}'); if (u.pathname.endsWith('/catalog-api')) calls.push(b.action);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b.action === 'mc_pipeline' ? P : b.action === 'mc_overview' ? OV : { ok: true })); return; }
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
    await pg.goto(base + '/admin/manufacturer-center.html'); await pg.waitForSelector('.pl-row', { timeout: 15000 });
    const r = await pg.evaluate(() => ({ rows: document.querySelectorAll('.pl-row').length, steps: [...document.querySelectorAll('.pl-row')].map(x => x.querySelectorAll('.pl-step').length),
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small: [...document.querySelectorAll('.pl-step a,.pl-filters .btn')].filter(e => e.getBoundingClientRect().height < 44).length,
      hrefs: [...document.querySelectorAll('.pl-step a')].map(a => a.getAttribute('href')),
      text: document.querySelector('#pipe').innerText, dollars: /\$\s*\d/.test(document.querySelector('#pipe').innerText) }));
    check(r.rows === 3 && r.steps.every(n => n === 7), `${w}px: 3 lines × 7 steps (${r.rows} / ${r.steps})`);
    check(r.over <= 1, `${w}px: no horizontal page scroll (${r.over})`);
    check(r.small === 0, `${w}px: step links and filters >= 44 px (${r.small} smaller)`);
    check(r.hrefs.every(h => /^\/admin\/(manufacturer-center|catalog-exceptions)\.html#line=/.test(h)), `${w}px: every step links to its tool`);
    check(/Publication blocked until resolved/i.test(r.text) && /Published · frozen/i.test(r.text) && /Order verification not on record/i.test(r.text), `${w}px: blocked reasons, frozen published state and honest order verification shown`);
    check(!r.dollars, `${w}px: no price`);
    await pg.click('.pl-f[data-f="published"]');
    check(await pg.evaluate(() => document.querySelectorAll('.pl-row').length) === 1, `${w}px: the Published filter narrows to the frozen line`);
    await pg.click('.pl-f[data-f="all"]');
    await pg.close();
  }
  await browser.close(); server.close();
  check(!errors.length, 'no page error' + (errors.length ? ': ' + errors[0] : ''));
  check(calls.includes('mc_pipeline') && calls.every(a => ['mc_overview', 'mc_pipeline'].includes(a)), 'read-only: only mc_overview and mc_pipeline were called (' + [...new Set(calls)].join(', ') + ')');
  console.log(`\nmc pipeline page: ${fails.length ? fails.length + ' failed' : 'all passed'}`); process.exit(fails.length ? 1 : 0);
})();

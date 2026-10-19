/* Training Academy landing page (/training-academy/ + the three concept previews): renders from the built _site at
   desktop / tablet / iPhone / Android widths — no horizontal scroll, no broken images, no page errors, axe clean
   (WCAG A/AA), one h1, every link resolves to a built page or an allowed destination, noindex only on the previews.
     npm run build && PLAYWRIGHT_MODULE=… AXE=… node test/training-academy.browser.js   (SHOTS=dir for screenshots) */
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const SITE = path.join(__dirname, '..', '_site'), SHOTS = process.env.SHOTS || null;
const AXE = process.env.AXE ? fs.readFileSync(process.env.AXE, 'utf8') : null;
const PAGES = ['/training-academy/', '/training-academy/concept-a/', '/training-academy/concept-b/', '/training-academy/concept-c/'];
const SIZES = { desktop: { width: 1366, height: 900 }, tablet: { width: 820, height: 1180 }, iphone: { width: 390, height: 844 }, android: { width: 360, height: 780 } };
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json' };
const fileFor = u => { let p = decodeURIComponent(new URL(u, 'http://x').pathname); let f = path.join(SITE, p); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); return f; };
const srv = http.createServer((req, res) => { const f = fileFor(req.url); if (!f.startsWith(SITE) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); } res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const B = `http://127.0.0.1:${srv.address().port}`;
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  for (const pg of PAGES) for (const [sz, vp] of Object.entries(SIZES)) {
    const ctx = await b.newContext({ reducedMotion: 'reduce', viewport: vp, isMobile: sz === 'iphone' || sz === 'android', hasTouch: sz !== 'desktop' }); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const bad = []; p.on('response', r => { const u = r.url(); if (u.startsWith(B) && r.status() >= 400 && !/favicon/.test(u)) bad.push(r.status() + ' ' + u.replace(B, '')); });
    await p.goto(B + pg, { waitUntil: 'networkidle' });
    await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); } window.scrollTo(0, 0); });
    await p.waitForTimeout(400);
    const tag = `${pg} @${sz}`;
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, h1: document.querySelectorAll('h1').length,
      broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0 && getComputedStyle(i).visibility !== 'hidden').map(i => i.getAttribute('src')),
      noalt: [...document.querySelectorAll('img:not([alt])')].map(i => i.getAttribute('src')),
      robots: (document.querySelector('meta[name=robots]') || {}).content || '', canon: (document.querySelector('link[rel=canonical]') || {}).href || '',
      title: document.title, links: [...document.querySelectorAll('main a[href]')].map(a => a.getAttribute('href')) }));
    ok(m.sw <= m.w + 1, `${tag}: horizontal scroll ${m.sw}>${m.w}`);
    ok(m.h1 === 1, `${tag}: ${m.h1} h1`);
    ok(!m.broken.length, `${tag}: broken images ${m.broken}`); ok(!m.noalt.length, `${tag}: img without alt ${m.noalt}`);
    ok(!bad.length, `${tag}: failed requests ${bad}`); ok(!errs.length, `${tag}: page errors ${errs}`);
    if (pg === '/training-academy/') { ok(!/noindex/.test(m.robots), `${tag}: main page must be indexable`); ok(m.canon === 'https://www.homecareproviderservices.org/training-academy/', `${tag}: canonical ${m.canon}`); ok(/HCPS Training & Certification Academy/.test(m.title), `${tag}: title ${m.title}`); }
    else ok(/noindex/.test(m.robots), `${tag}: preview must be noindex`);
    for (const h of m.links) {
      if (/^#/.test(h)) { ok(await p.$(h) !== null, `${tag}: anchor ${h} missing`); continue; }
      if (/^\/(academy\/|academy\/verify\/)/.test(h)) continue;   // the live Academy app (Netlify functions + its own pages)
      if (/^https?:/.test(h)) continue;
      ok(fs.existsSync(fileFor(h.split('#')[0].split('?')[0])), `${tag}: link ${h} has no built page`);
    }
    const text = await p.evaluate(() => document.querySelector('main').innerText);
    ok(/not issued or endorsed by Golden Technologies/.test(text), `${tag}: HCPS-not-Golden disclosure missing`);
    ok(/11 modules/.test(text) && /17 lessons/.test(text) && /80%/.test(text) && /12 month/i.test(text) && /25-question|25 question/.test(text), `${tag}: course facts`);
    ok(/coming soon/i.test(text) && !/buy now|add to cart|checkout/i.test(text), `${tag}: payments must read as coming soon only`);
    if (AXE && (sz === 'desktop' || sz === 'iphone')) {
      await p.addScriptTag({ content: AXE });
      const r = await p.evaluate(async () => (await axe.run(document.querySelector('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map(v => v.id + ':' + v.nodes.length));
      ok(!r.length, `${tag}: axe ${r.join(', ')}`);
    }
    if (SHOTS && (sz === 'desktop' || sz === 'iphone')) await p.screenshot({ path: path.join(SHOTS, `${pg.replace(/\//g, '_') || 'root'}${sz}.png`), fullPage: true });
    await ctx.close();
  }
  // keyboard: the first focusable control in main is reachable and visibly focused
  { const ctx = await b.newContext({ viewport: SIZES.desktop }); const p = await ctx.newPage(); await p.goto(B + '/training-academy/');
    await p.focus('main a.ta-btn'); const o = await p.evaluate(() => getComputedStyle(document.activeElement).outlineStyle); ok(o && o !== 'none', 'keyboard focus ring on the primary button'); await ctx.close(); }
  await b.close(); srv.close();
  console.log(`training-academy browser: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e); process.exit(1); });

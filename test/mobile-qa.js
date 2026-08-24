#!/usr/bin/env node
/**
 * HCPS Mobile QA matrix — reusable responsive/touch regression check.
 * Enforces RULE 10 in CLAUDE.md: every page must work on desktop, tablet, iPhone, Android.
 *
 * What it checks, for every page in PAGES at every viewport in VIEWPORTS:
 *   1. No horizontal overflow (document scrollWidth must not exceed the viewport).
 *   2. Mobile nav correctness: hamburger hidden on desktop / shown on mobile,
 *      the panel opens, and a dropdown accordion expands (mobile widths only).
 *
 * Usage:
 *   npm run build              # produce _site/
 *   npx playwright install chromium   # first time only
 *   node test/mobile-qa.js
 *
 * Exit code 0 = all green (shippable). Exit code 1 = at least one failure.
 * Add a page: push a [name, urlPath] pair to PAGES. Add a device: push to VIEWPORTS.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '_site');
if (!fs.existsSync(ROOT)) {
  console.error('No _site/ found. Run `npm run build` first.');
  process.exit(1);
}

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('playwright not installed. Run `npm i` then `npx playwright install chromium`.'); process.exit(1); }

// ---- The matrix ----------------------------------------------------------
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900, mobile: false },
  { name: 'tablet',  width: 768,  height: 1024, mobile: true  }, // iPad portrait
  { name: 'iphone',  width: 390,  height: 844,  mobile: true  }, // iPhone 14/15 (Safari)
  { name: 'android', width: 360,  height: 800,  mobile: true  }, // common Android (Chrome)
];
const PAGES = [
  ['home',              '/'],
  ['manufacturers',     '/manufacturers/'],
  ['manufacturer',      '/manufacturers/golden-technologies/'],
  ['dealer-hub',        '/dealer-hub/'],
  ['dealer-services',   '/dealer-services/'],
  ['resources',         '/resources/'],
  ['consulting',        '/consulting/'],
  ['contact',           '/contact/'],
  ['become-a-dealer',   '/become-a-dealer/'],
];

const MIME = { '.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp',
  '.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
      } else { res.writeHead(404); res.end('nf'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  const failures = [];
  let checks = 0;

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    for (const [name, url] of PAGES) {
      let resp;
      try { resp = await page.goto(base + url, { waitUntil: 'networkidle', timeout: 15000 }); }
      catch (e) { failures.push(`${vp.name}/${name}: navigation failed (${e.message})`); continue; }
      if (!resp || resp.status() >= 400) { failures.push(`${vp.name}/${name}: HTTP ${resp && resp.status()}`); continue; }
      await page.waitForTimeout(150);

      // 1) overflow
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      checks++;
      if (o.sw - o.iw > 2) failures.push(`${vp.name}/${name}: horizontal overflow (scrollWidth ${o.sw} > ${o.iw})`);

      // 1b) no stray full-screen scrim/overlay covering the page on load
      const scrim = await page.evaluate(() => {
        const vw = window.innerWidth, vh = window.innerHeight, area = vw * vh;
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el);
          if ((cs.position !== 'fixed' && cs.position !== 'absolute') || cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (parseFloat(cs.opacity) === 0 || cs.pointerEvents === 'none') continue;
          const bg = cs.backgroundColor;
          const m = bg && bg.match(/rgba?\(([^)]+)\)/);
          if (!m) continue;
          const parts = m[1].split(',').map(s => parseFloat(s));
          const alpha = parts.length === 4 ? parts[3] : 1;
          if (alpha < 0.05) continue; // effectively transparent
          const r = el.getBoundingClientRect();
          // Only the on-screen intersection counts — an off-canvas panel (translated
          // out of view) is large but doesn't actually cover the viewport.
          const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
          const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          if (ix * iy >= area * 0.85 && parseInt(cs.zIndex || '0', 10) >= 10) {
            return { cls: el.className && el.className.toString().slice(0, 40), z: cs.zIndex, bg };
          }
        }
        return null;
      });
      checks++;
      if (scrim) failures.push(`${vp.name}/${name}: stray overlay dimming the page on load (.${scrim.cls}, z=${scrim.z}, bg=${scrim.bg})`);

      // 2) nav correctness (run once per viewport, on home)
      if (name === 'home') {
        const tglShown = await page.evaluate(() => {
          const t = document.querySelector('.nav-toggle'); return t ? getComputedStyle(t).display !== 'none' : null;
        });
        checks++;
        if (vp.mobile && tglShown !== true) failures.push(`${vp.name}: hamburger should be visible but isn't`);
        if (!vp.mobile && tglShown !== false) failures.push(`${vp.name}: hamburger should be hidden on desktop but isn't`);

        if (vp.mobile) {
          await page.click('.nav-toggle').catch(() => {});
          await page.waitForTimeout(350);
          const open = await page.evaluate(() => document.querySelector('header.mainnav').classList.contains('nav-open'));
          checks++;
          if (!open) failures.push(`${vp.name}: menu panel did not open`);
          const caret = await page.$('.dropdown .dd-caret');
          if (caret) {
            await caret.click().catch(() => {});
            await page.waitForTimeout(250);
            const ddOpen = await page.evaluate(() => !!document.querySelector('.dropdown.open'));
            checks++;
            if (!ddOpen) failures.push(`${vp.name}: dropdown accordion did not expand`);
          }
        }
      }
    }
    await ctx.close();
  }

  await browser.close();
  srv.close();

  console.log(`\nHCPS Mobile QA — ${VIEWPORTS.length} viewports × ${PAGES.length} pages, ${checks} checks`);
  if (failures.length === 0) {
    console.log('✅ ALL GREEN — no horizontal overflow, nav works across desktop/tablet/iPhone/Android.\n');
    process.exit(0);
  } else {
    console.log(`❌ ${failures.length} issue(s):`);
    failures.forEach(f => console.log('   • ' + f));
    console.log('');
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });

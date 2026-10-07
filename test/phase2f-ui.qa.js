/* Phase 2F-1 — browser QA for the Zoho sync page: recorded sync failures show on the "Sync failures · 24h"
   tile and in the activity feed. Real page (src/admin/zoho-sync.html) + real handlers on the fake database and
   fake Zoho (phase0-mock.js).
   Run:  PW_CHROMIUM=/path/to/chromium node test/phase2f-ui.qa.js   (screenshots: <tmp>/hcps-phase2f-qa) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createWorld, load, standardSeed } = require('./phase0-mock');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }
  catch (e2) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); } }

const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-phase2f-qa'); fs.mkdirSync(SHOTS, { recursive: true });
const ENV = { ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'zcs-b81d44e0aa', ZOHO_WEBHOOK_SECRET: 'whsec-7f3a9c2e51' };
function world() {
  const S = standardSeed({
    app_settings: [{ key: 'zoho_auth', value: { refresh_token: 'rt', api_domain: 'https://www.zohoapis.com' } }, { key: 'zoho_push_hashes', value: {} }],
    dealer_contacts: [{ id: 'c1', dealer_id: 'd-greg', name: 'Rita Owner', email: 'rita@glasgow.test' }],
    opportunities: [], zoho_sync_queue: [], zoho_sync_log: [],
  });
  S.zoho = { modules: { Accounts: [] }, batchFail: { Contacts: 400 } };
  return createWorld(S);
}
const PROFILES = {
  greg: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/command-center-rep.html' },
  pres: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' },
  lori: { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', rep_name: 'Lori Hunt', landing: '/admin/command-center-rep.html' },
};
function serve(w) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop();
      let raw = ''; for await (const c of req) raw += c;
      calls.push({ name, body: raw, method: req.method });
      const file = path.join(__dirname, '..', 'netlify', 'functions', name + '.js');
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('{}'); return; }
      try {
        const mod = load(name + '.js', w, Object.assign({ ANTHROPIC_API_KEY: 'k' }, ENV));
        const headers = {}; for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
        const r = await mod.handler({ httpMethod: req.method, headers, body: raw, queryStringParameters: Object.fromEntries(u.searchParams) });
        res.writeHead(r.statusCode || 200, Object.assign({ 'content-type': 'application/json' }, r.headers || {})); res.end(r.body || '');
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) })); }
      return;
    }
    let p = u.pathname.startsWith('/admin/') ? path.join(ADMIN, u.pathname.slice(7)) : null;
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(''); return; }
    const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webmanifest': 'application/json' }[path.extname(p)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(fs.readFileSync(p));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, calls })));
}
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
const DESKTOP = { viewport: { width: 1366, height: 900 } };
async function ctxFor(browser, who, device, ws) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([tok, prof, wsOn]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); if (wsOn) sessionStorage.setItem('hcps_workspace', 'mine'); } catch (e) {} }, [who, JSON.stringify(PROFILES[who]), !!ws]);
  return ctx;
}
async function noHScroll(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w + 1, `${label}: horizontal scroll (${o.sw} > ${o.w})`);
}
let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }
(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world(); const { srv, port } = await serve(w); const B = `http://127.0.0.1:${port}`;
  // One autosync run against a Zoho that refuses the contacts batch: 3 records → 3 failure rows.
  await load('zoho-autosync.js', w, ENV).handler({});
  await step('President (desktop + phone): the failures show on the tile and in the feed; no page errors', async () => {
    for (const device of [DESKTOP, PHONE]) {
      const c = await ctxFor(browser, 'pres', device); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(`${B}/admin/zoho-sync.html`); await p.waitForSelector('.tile', { timeout: 20000 });
      const tiles = await p.$$eval('.tile', ts => ts.map(t => t.innerText.replace(/\s+/g, ' ').trim()));
      const ft = tiles.find(x => /Sync failures · 24h/i.test(x)); assert.ok(ft && /\b3\b/.test(ft), tiles.join(' | '));
      const feed = await p.textContent('table.rev'); assert.ok(/fail/.test(feed) && /BATCH_REJECTED/.test(feed), 'failures not in the feed');
      assert.ok(!/whsec-|zcs-/.test(await p.content()), 'a secret on the page');
      const sw = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert.ok(sw <= 1, 'horizontal scroll ' + sw);
      await p.screenshot({ path: path.join(SHOTS, 'zoho-sync-' + (device === PHONE ? 'phone' : 'desktop') + '.png'), fullPage: true });
      assert.deepStrictEqual(errs, []); await c.close();
    }
  });
  await browser.close(); srv.close();
  console.log(`\nPhase 2F-1 UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

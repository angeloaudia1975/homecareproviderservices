/* Phase 2 add-on — browser QA for the account class on Dealer 360 (Edit company info, President/Admin).

   The real page (src/admin/dealer.html); every /.netlify/functions call answered by the REAL handler
   against the fake database in phase0-mock.js (same harness as phase2-ui.qa.js).
   Run:  PW_CHROMIUM=/path/to/chromium node test/phase2-account-class-ui.qa.js   (screenshots: <tmp>/hcps-account-class-qa) */
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
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-account-class-qa'); fs.mkdirSync(SHOTS, { recursive: true });

function world(opts) {
  opts = opts || {};
  const S = standardSeed({
    dealer_contacts: [], dealer_tasks: [], opportunities: [], dealer_notes: [], dealer_activity: [], dealer_visit_reports: [], manufacturers: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { adhoc_visit: true, morning_brief: true } }],
  });
  for (const d of S.tables.dealers) { d.updated_at = '2026-01-01T00:00:00Z'; if (!opts.noColumn) d.account_class = null; }
  if (opts.noColumn) S.columns = { dealers: ['id', 'business_name', 'rep_email', 'rep_name', 'parent_id', 'state', 'updated_at', 'email', 'is_test', 'hcps_account', 'status', 'contact_name', 'phone', 'address', 'city', 'zip', 'notes', 'website', 'email_verified', 'golden_url', 'golden_status', 'active', 'ovation_access'] };
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
        const mod = load(name + '.js', w, { ANTHROPIC_API_KEY: 'k' });
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
async function ctxFor(browser, who, device) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([tok, prof]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); } catch (e) {} }, [who, JSON.stringify(PROFILES[who])]);
  return ctx;
}
async function noHScroll(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w + 1, `${label}: horizontal scroll (${o.sw} > ${o.w})`);
}
let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }
const editBtn = p => p.$('#hdrCard button[onclick="editCompany()"]');

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world(); const { srv, port, calls } = await serve(w); const B = `http://127.0.0.1:${port}`;

  await step('President (phone): Edit company info has the account class; choosing Vendor saves ONLY the class', async () => {
    const c = await ctxFor(browser, 'pres', PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.dismiss());
    await p.goto(`${B}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#hdrCard', { timeout: 20000 });
    assert.ok(!/Class:/.test(await p.textContent('#hdrCard')), 'a class chip on an unclassified dealer');
    await (await editBtn(p)).click(); await p.waitForSelector('#e_class');
    const opts = await p.$$eval('#e_class option', os => os.map(o => o.value + '|' + o.textContent));
    assert.deepStrictEqual(opts.map(o => o.split('|')[0]), ['', 'dealer', 'prospect', 'manufacturer', 'vendor', 'service_provider', 'internal', 'other', 'not_relevant']);
    assert.ok(/no Morning Brief signals/.test(opts[4]) && !/no Morning Brief/.test(opts[1]) && !/no Morning Brief/.test(opts[7]), opts.join(' / '));
    assert.strictEqual(await p.$eval('#e_class', s => s.value), '', 'existing records must start blank');
    await noHScroll(p, 'editor phone'); await p.screenshot({ path: path.join(SHOTS, 'class-1-editor.png'), fullPage: true });
    const before = JSON.stringify(Object.assign({}, w.db.dealers.find(d => d.id === 'd-greg'), { account_class: 0, account_class_set_by: 0, account_class_set_at: 0 }));
    const n0 = calls.length;
    await p.selectOption('#e_class', 'vendor'); await p.click('button[onclick="saveCompany()"]');
    await p.waitForFunction(() => /Class:/.test((document.querySelector('#hdrCard') || {}).textContent || ''), null, { timeout: 15000 });
    const t = await p.textContent('#hdrCard'); assert.ok(/Class: Vendor \/ supplier/.test(t) && /no brief signals/.test(t), t.slice(0, 300));
    const posts = calls.slice(n0).filter(x => x.name === 'dealers-api' && x.method === 'POST').map(x => JSON.parse(x.body).action);
    assert.deepStrictEqual(posts, ['set_account_class'], 'other writes happened: ' + posts.join(','));
    const d = w.db.dealers.find(x => x.id === 'd-greg');
    assert.strictEqual(d.account_class, 'vendor'); assert.strictEqual(d.account_class_set_by, 'angelo@hcps.us');
    assert.strictEqual(JSON.stringify(Object.assign({}, d, { account_class: 0, account_class_set_by: 0, account_class_set_at: 0 })), before, 'another column changed');
    await p.screenshot({ path: path.join(SHOTS, 'class-2-saved.png'), fullPage: true });
    // Back to blank.
    await (await editBtn(p)).click(); await p.waitForSelector('#e_class'); assert.strictEqual(await p.$eval('#e_class', s => s.value), 'vendor');
    await p.selectOption('#e_class', ''); await p.click('button[onclick="saveCompany()"]');
    await p.waitForFunction(() => !/Class:/.test((document.querySelector('#hdrCard') || {}).textContent || ''), null, { timeout: 15000 });
    assert.strictEqual(w.db.dealers.find(x => x.id === 'd-greg').account_class, null);
    assert.deepStrictEqual(errs, []); await c.close();
  });

  await step('Greg and Lori: no Edit company info, no class shown, the dealer opens exactly as before', async () => {
    w.db.dealers.find(x => x.id === 'd-greg').account_class = 'not_relevant';
    for (const who of ['greg', 'lori']) {
      const c = await ctxFor(browser, who, PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(`${B}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#hdrCard', { timeout: 20000 });
      assert.strictEqual(await editBtn(p), null, who + ' has Edit company info');
      assert.ok(!/Class:/.test(await p.textContent('#hdrCard')), who + ' sees the class');
      assert.ok(/Glasgow Prescription Center/.test(await p.textContent('#hdrCard')));
      await p.screenshot({ path: path.join(SHOTS, `class-3-${who}.png`), fullPage: true });
      assert.deepStrictEqual(errs, []); await c.close();
    }
    w.db.dealers.find(x => x.id === 'd-greg').account_class = null;
  });

  await step('before the SQL runs: the editor has no class field and saving company info works as before', async () => {
    const w2 = world({ noColumn: true }); const s2 = await serve(w2); const B2 = `http://127.0.0.1:${s2.port}`;
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B2}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#hdrCard', { timeout: 20000 });
    await (await editBtn(p)).click(); await p.waitForSelector('#e_name');
    assert.strictEqual(await p.$('#e_class'), null, 'class field shown before the migration');
    await p.fill('#e_phone', '270-555-0100'); await p.click('button[onclick="saveCompany()"]');
    await p.waitForFunction(() => /270-555-0100/.test((document.querySelector('#hdrCard') || {}).textContent || ''), null, { timeout: 15000 });
    assert.deepStrictEqual(errs, []); await c.close(); s2.srv.close();
  });

  await browser.close(); srv.close();
  console.log(`\nAccount class UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

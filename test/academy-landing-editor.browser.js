/* Website editor → Training Academy tab: loads src/_data/academyLanding.json through admin-api, renders every
   section (design picker, hero, why, courses, dashboard, how it works, pricing, certificate note, CTA, Dealer Services
   card), edits the headline, and publishes valid JSON with every other field unchanged. admin-api is stubbed (no GitHub).
     PLAYWRIGHT_MODULE=… node test/academy-landing-editor.browser.js */
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.join(__dirname, '..'), ADMIN = path.join(ROOT, 'src', 'admin');
const DATA = fs.readFileSync(path.join(ROOT, 'src/_data/academyLanding.json'), 'utf8');
const puts = [];
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/.netlify/functions/admin-api') {
    let raw = ''; for await (const c of req) raw += c; const b = JSON.parse(raw || '{}'); res.writeHead(200, { 'content-type': 'application/json' });
    if (b.action === 'login_staff') return res.end(JSON.stringify({ token: 'ed-tok', github: true }));
    if (b.action === 'get') return res.end(JSON.stringify(b.path === 'src/_data/academyLanding.json' ? { content: DATA, sha: 'sha1' } : { content: null, sha: null }));
    if (b.action === 'put') { puts.push(b); return res.end(JSON.stringify({ ok: true, sha: 'sha2' })); }
    if (b.action === 'list') return res.end('[]');
    return res.end('{}');
  }
  if (u.pathname.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  let f = u.pathname.startsWith('/admin/') ? path.join(ADMIN, u.pathname.slice(7)) : path.join(ROOT, 'src', u.pathname);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(''); }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
let pass = 0, fail = 0; const t = async (n, fn) => { try { await fn(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + (e && e.message)); } };
(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const B = `http://127.0.0.1:${srv.address().port}`;
  const b = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'staff-tok'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'angelo@hcps.us', role: 'president' })); } catch (e) {} });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await t('the Training Academy tab is in the editor and opens the page content', async () => {
    await p.goto(B + '/admin/website.html#academyLanding'); await p.waitForSelector('.tab[data-view="academyLanding"]', { timeout: 15000 });
    await p.click('.tab[data-view="academyLanding"]'); await p.waitForFunction(() => /Training Academy/.test((document.querySelector('#view h2') || {}).textContent || ''), null, { timeout: 15000 });
    await p.waitForFunction(() => document.querySelectorAll('#view input, #view textarea, #view select').length > 40, null, { timeout: 15000 });
    const txt = await p.textContent('#view');
    for (const s of ['Page design', 'Hero', 'Why the Academy', 'Featured courses', 'Dealership training dashboard', 'How it works', 'Pricing & eligibility', 'Certificate disclosure', 'Bottom call-to-action', 'Card on the Dealer Services page'])
      assert.ok(txt.includes(s), 'section missing: ' + s);
    const vals = await p.$$eval('#view input, #view textarea', els => els.map(e => e.value));
    assert.ok(vals.includes('Build Product Knowledge. Strengthen Your Team. Certify With Confidence.'), 'headline loaded');
    assert.ok(vals.includes('Golden Lift Chair Sales Certification'), 'course loaded');
  });
  await t('editing the headline and publishing writes valid JSON to src/_data/academyLanding.json; nothing else changes', async () => {
    const h = await p.$$('#view input');
    let target = null; for (const el of h) if ((await el.inputValue()) === 'Build Product Knowledge. Strengthen Your Team. Certify With Confidence.') { target = el; break; }
    assert.ok(target, 'headline input'); await target.fill('Train Your Team. Certify With Confidence.'); await target.dispatchEvent('input'); await target.dispatchEvent('change');
    const save = await p.$('button:has-text("Publish"), button:has-text("Save")'); assert.ok(save, 'publish button'); await save.click();
    await p.waitForFunction(() => /Published/.test((document.querySelector('#toast') || {}).textContent || ''), null, { timeout: 10000 });
    assert.strictEqual(puts.length, 1); assert.strictEqual(puts[0].path, 'src/_data/academyLanding.json');
    const out = JSON.parse(puts[0].content), before = JSON.parse(DATA);
    assert.strictEqual(out.hero.headline, 'Train Your Team. Certify With Confidence.');
    out.hero.headline = before.hero.headline; assert.deepStrictEqual(out, before, 'another field changed');
  });
  await t('no page errors', async () => assert.deepStrictEqual(errs, []));
  await b.close(); srv.close(); console.log(`academy-landing editor: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e); process.exit(1); });

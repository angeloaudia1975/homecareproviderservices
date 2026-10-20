/* HCPS Academy Phase 2 / F1 — browser QA for /academy/start/ (free sign-up; built page from _site). The Academy APIs are
   stubbed in the browser; nothing reaches Supabase or an email provider. Phone + desktop: no sideways scroll, free wording,
   no card field, the register → code → enroll_free sequence with the Academy header, the email kept out of the URL,
   server messages shown as text, and the not-open state.
     PLAYWRIGHT_MODULE=/home/claude/.npm-global/lib/node_modules/playwright node test/academy-start.browser.js   (after npm run build) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ROOT = path.join(__dirname, '..', '_site');
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
if (!fs.existsSync(path.join(ROOT, 'academy', 'start', 'index.html'))) { console.log('SKIP: run npm run build first'); process.exit(0); }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'" });
  fs.createReadStream(f).pipe(res);
});
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); } }
const CATALOG = { enabled: true, courses: [{ slug: 'golden-lift-chair-sales-certification', title: 'HCPS Lift Chair Sales & Product Knowledge Certification', note: null }] };

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASEURL = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  async function open(width, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: { width, height: 900 } }); const page = await ctx.newPage();
    const posts = []; const errors = [];
    page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
    await page.route('**/.netlify/functions/academy-free**', async route => {
      const req = route.request();
      if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.catalog || CATALOG) });
      posts.push({ url: 'free', headers: req.headers(), body: JSON.parse(req.postData() || '{}') });
      const a = opts.register || { status: 200, body: { ok: true, message: 'sent' } };
      return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    });
    await page.route('**/.netlify/functions/academy-api**', async route => {
      const req = route.request(); const body = JSON.parse(req.postData() || '{}');
      posts.push({ url: 'api', headers: req.headers(), body });
      if (body.action === 'verify_code') return route.fulfill({ status: opts.badCode ? 400 : 200, contentType: 'application/json', body: JSON.stringify(opts.badCode ? { error: 'wrong_code', message: 'That code is not right.' } : { ok: true }) });
      if (body.action === 'enroll_free') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enrollment_id: 'e1', existing: false }) });
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    await page.goto(BASEURL + '/academy/start/' + (opts.qs || ''));
    await page.waitForTimeout(250);
    return { ctx, page, posts, errors };
  }
  try {
    for (const w of [360, 390, 768, 1280]) {
      await t(`layout ${w}px: free wording, no card field, no sideways scroll, 16px inputs, no script errors`, async () => {
        const { ctx, page, errors } = await open(w);
        const text = await page.textContent('main');
        assert.match(text, /Free during launch/); assert.match(text, /No credit card required/); assert.match(text, /paid enrollment may be introduced in the future/);
        assert.ok(!/\$\s?\d|normally|discount|card number/i.test(text), 'no price or card wording');
        assert.match(text, /not issued, sponsored or endorsed by Golden Technologies/);
        assert.strictEqual(await page.isVisible('#sf'), true); assert.strictEqual(await page.isVisible('#cf'), false);
        assert.match(await page.textContent('#sc'), /HCPS Lift Chair Sales & Product Knowledge Certification — Free/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
        const fs16 = await page.evaluate(() => getComputedStyle(document.getElementById('se')).fontSize); assert.ok(parseFloat(fs16) >= 16, fs16);
        assert.deepStrictEqual(errors, []); await ctx.close();
      });
    }
    await t('sign-up → code → enroll: Academy header on every POST, nothing extra sent, the email never in the URL, then the Academy', async () => {
      const { ctx, page, posts } = await open(390);
      await page.fill('#sn', 'Pat Outside'); await page.fill('#so', 'Outside Mobility'); await page.fill('#se', 'Pat@Outside.example');
      await page.click('#sgo'); await page.waitForSelector('#cf:not([hidden])');
      assert.match(await page.textContent('#csent'), /pat@outside\.example/);
      assert.ok(!page.url().includes('outside.example'), 'no email in the URL');
      await page.fill('#cc', '123456');
      await Promise.all([page.waitForURL(/\/academy\/$/), page.click('#cgo')]);
      assert.deepStrictEqual(posts.slice(0, 3).map(p => p.url + ':' + p.body.action), ['free:register', 'api:verify_code', 'api:enroll_free']);
      assert.ok(posts.every(p => p.headers['x-academy-request'] === '1'));
      assert.deepStrictEqual(Object.keys(posts[0].body).sort(), ['action', 'company', 'course_slug', 'email', 'full_name']);
      assert.strictEqual(posts[0].body.email, 'pat@outside.example');
      assert.deepStrictEqual(posts[2].body, { action: 'enroll_free', course_slug: 'golden-lift-chair-sales-certification' });
      await ctx.close();
    });
    await t('a reload keeps the code step (sessionStorage), "different email" goes back; a wrong code stays on the page', async () => {
      const { ctx, page, posts } = await open(1280, { badCode: true });
      await page.fill('#sn', 'Pat'); await page.fill('#so', 'Co Inc'); await page.fill('#se', 'p@x.example'); await page.click('#sgo');
      await page.waitForSelector('#cf:not([hidden])'); await page.reload(); await page.waitForTimeout(250);
      assert.strictEqual(await page.isVisible('#cf'), true);
      await page.fill('#cc', '000000'); await page.click('#cgo'); await page.waitForTimeout(200);
      assert.match(await page.textContent('#sstate'), /not right/); assert.ok(!posts.some(p => p.body.action === 'enroll_free'));
      await page.click('#cback'); assert.strictEqual(await page.isVisible('#sf'), true);
      await ctx.close();
    });
    await t('server refusals are shown as text (a hostile message never runs); validation before any request', async () => {
      const { ctx, page, posts } = await open(390, { register: { status: 409, body: { error: 'partner360', message: '<img src=x onerror="window.__x=1">Open Training from Partner 360' } } });
      await page.click('#sgo'); await page.waitForTimeout(100); assert.strictEqual(posts.length, 0); assert.match(await page.textContent('#sstate'), /Please choose a course/);
      await page.fill('#sn', 'Pat'); await page.fill('#so', 'Co Inc'); await page.fill('#se', 'p@x.example'); await page.click('#sgo'); await page.waitForTimeout(200);
      assert.match(await page.textContent('#sstate'), /<img src=x/); assert.strictEqual(await page.evaluate(() => window.__x), undefined);
      assert.strictEqual(await page.$('#sstate img'), null); assert.strictEqual(await page.isVisible('#cf'), false);
      await ctx.close();
    });
    await t('not open / no free course: a clear message and no form', async () => {
      const a = await open(390, { catalog: { enabled: false, courses: [] } });
      assert.match(await a.page.textContent('#sstate'), /not open yet/); assert.strictEqual(await a.page.isVisible('#sf'), false); await a.ctx.close();
      const b = await open(390, { catalog: { enabled: true, courses: [] } });
      assert.match(await b.page.textContent('#sstate'), /No free courses/); await b.ctx.close();
    });
  } finally {
    await browser.close(); srv.close();
    console.log(`\nacademy-start browser: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();

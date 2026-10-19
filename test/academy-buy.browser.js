/* HCPS Academy Phase 2 / M8 — browser QA for /academy/buy/ (built page from _site). The checkout API is stubbed in the
   browser; nothing reaches Stripe or Supabase. Phone + desktop: no sideways scroll, TEST-mode notice, prices from the
   server catalog, the request carries the Academy header and never a price, the page goes only to checkout.stripe.com,
   server messages are shown as text (a hostile message never executes), and the off / cancelled / paid states.
     PLAYWRIGHT_MODULE=/opt/node-tools/node_modules/playwright node test/academy-buy.browser.js   (after npm run build) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ROOT = path.join(__dirname, '..', '_site');
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
if (!fs.existsSync(path.join(ROOT, 'academy', 'buy', 'index.html'))) { console.log('SKIP: run npm run build first'); process.exit(0); }
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
const CATALOG = { enabled: true, test_mode: true, courses: [{ slug: 'dealer-sales-basics', title: 'Dealer Sales Basics', price_cents: 1999, currency: 'usd' }] };

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASEURL = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  async function open(width, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: { width, height: 900 } }); const page = await ctx.newPage();
    const posts = []; const errors = [];
    page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/.netlify/functions/academy-checkout**', async route => {
      const req = route.request();
      if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.catalog || CATALOG) });
      posts.push({ headers: req.headers(), body: JSON.parse(req.postData() || '{}') });
      return route.fulfill({ status: opts.status || 200, contentType: 'application/json', body: JSON.stringify(opts.answer || { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }) });
    });
    await page.route('https://checkout.stripe.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>stripe stub</h1>' }));
    await page.goto(BASEURL + '/academy/buy/' + (opts.qs || ''));
    await page.waitForTimeout(250);
    return { ctx, page, posts, errors };
  }
  try {
    for (const w of [360, 390, 768, 1280]) {
      await t(`layout ${w}px: TEST-mode notice, server price, no sideways scroll, no script errors`, async () => {
        const { ctx, page, errors } = await open(w);
        assert.match(await page.textContent('#bmode'), /TEST MODE/);
        assert.strictEqual(await page.isVisible('#bf'), true);
        assert.match(await page.textContent('#bc'), /Dealer Sales Basics — \$19\.99/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
        const fs16 = await page.evaluate(() => getComputedStyle(document.getElementById('be')).fontSize); assert.ok(parseFloat(fs16) >= 16, 'inputs are 16px+ (no iOS zoom): ' + fs16);
        assert.deepStrictEqual(errors, []); await ctx.close();
      });
    }
    await t('submit: Academy header, no price in the request, then the Stripe page', async () => {
      const { ctx, page, posts } = await open(390);
      await page.fill('#bn', 'Pat Buyer'); await page.fill('#bo', 'Outside Mobility'); await page.fill('#be', 'pat@outside.example');
      await Promise.all([page.waitForURL(/checkout\.stripe\.com/), page.click('#bgo')]);
      assert.strictEqual(posts.length, 1); assert.strictEqual(posts[0].headers['x-academy-request'], '1');
      assert.deepStrictEqual(Object.keys(posts[0].body).sort(), ['action', 'company', 'course_slug', 'email', 'full_name']);
      await ctx.close();
    });
    await t('a non-Stripe address from the server is never followed; a hostile message is shown as text', async () => {
      const { ctx, page } = await open(1280, { answer: { ok: true, url: 'https://evil.example/<img src=x onerror=window.__x=1>' } });
      await page.fill('#bn', 'Pat'); await page.fill('#bo', 'Co Inc'); await page.fill('#be', 'p@x.example'); await page.click('#bgo'); await page.waitForTimeout(200);
      assert.match(page.url(), /\/academy\/buy\//); assert.strictEqual(await page.evaluate(() => window.__x), undefined);
      await ctx.close();
      const b = await open(1280, { status: 409, answer: { error: 'included', message: '<img src=x onerror="window.__x=1">Included free' } });
      await b.page.fill('#bn', 'Pat'); await b.page.fill('#bo', 'Co Inc'); await b.page.fill('#be', 'p@x.example'); await b.page.click('#bgo'); await b.page.waitForTimeout(200);
      assert.match(await b.page.textContent('#bstate'), /<img src=x/); assert.strictEqual(await b.page.evaluate(() => window.__x), undefined);
      assert.strictEqual(await b.page.$('#bstate img'), null); await b.ctx.close();
    });
    await t('validation: missing fields are caught before any request', async () => {
      const { ctx, page, posts } = await open(390); await page.click('#bgo'); await page.waitForTimeout(100);
      assert.strictEqual(posts.length, 0); assert.match(await page.textContent('#bstate'), /Please choose a course/); await ctx.close();
    });
    await t('off / cancelled / paid states', async () => {
      const off = await open(390, { catalog: { enabled: false, test_mode: true, courses: [] } });
      assert.strictEqual(await off.page.isVisible('#bf'), false); assert.match(await off.page.textContent('#bstate'), /not open yet/); await off.ctx.close();
      const c = await open(390, { qs: '?cancelled=1' }); assert.match(await c.page.textContent('#bstate'), /Nothing was charged/); await c.ctx.close();
      const p = await open(390, { qs: '?paid=1&session_id=cs_test_abc' }); assert.match(await p.page.textContent('#bstate'), /sign in to the HCPS Academy/); await p.ctx.close();
    });
  } finally {
    await browser.close(); srv.close();
    console.log(`\nacademy-buy.browser: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();

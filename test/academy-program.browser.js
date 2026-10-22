/* HCPS Academy #32 — browser QA for the learner program page (/academy/#program?c=…), built page from _site, with the
   real /academy/* Content Security Policy. academy-api is stubbed; nothing reaches YouTube or Google. Phone + desktop:
   the card opens the page, the official video is the privacy-enhanced embed (no autoplay) with a fallback link, the quiz is
   the manufacturer's form in a new tab, "I submitted the quiz" waits for "I watched", steps POST only what they say,
   server text is text, upload hidden while uploads are off.
     PLAYWRIGHT_MODULE=/home/claude/.npm-global/lib/node_modules/playwright node test/academy-program.browser.js  (after npm run build) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.join(__dirname, '..', '_site');
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
if (!fs.existsSync(path.join(ROOT, 'assets', 'academy', 'program-page.js'))) { console.log('SKIP: run npm run build first'); process.exit(0); }
const CSP = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8').match(/for = "\/academy\/\*"[\s\S]*?Content-Security-Policy = "([^"]+)"/)[1];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'content-security-policy': CSP }); fs.createReadStream(f).pipe(res);
});
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); } }
const ID = '00000000-0000-4000-8000-0000000000aa', XSS = '<img src=x onerror="window.__x=1">';
(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASEURL = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  async function open(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } }); const page = await ctx.newPage();
    const posts = [], errors = []; let status = null;
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/.netlify/functions/academy-api**', async route => {
      const b = JSON.parse(route.request().postData() || '{}'); posts.push(b);
      const send = (j, st) => route.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(j) });
      const prog = () => ({ id: ID, title: 'Golden Lift Chair Technical Service Certification', manufacturer: 'Golden Technologies', quiz_url: 'https://forms.gle/BsZRxeTDWitwRGfr5',
        video: { embed: 'https://www.youtube-nocookie.com/embed/VApekZEFn8c', title: 'Golden Technologies: Lift Chair Technical Service Certification', watch_url: 'https://www.youtube.com/watch?v=VApekZEFn8c' },
        overview: 'Overview ' + XSS, quiz_note: 'Golden requires a perfect score.', manufacturer_page_url: 'https://goldentech.com/lift-chair-certification/',
        credential: status ? { status, label: status === 'training_completed' ? 'Training watched (your report)' : 'Quiz submitted (your report)' } : null });
      if (b.action === 'me') return send({ learner: { id: 'l1', full_name: 'Lee' }, memberships: [{ dealer: 'HQ Medical' }] });
      if (b.action === 'my_courses') return send({ courses: [], exams_open: true });
      if (b.action === 'free_courses') return send({ ok: true, courses: [] });
      if (b.action === 'manufacturer_programs') return send({ ok: true, programs: [prog()] });
      if (b.action === 'program') return send({ ok: true, program: prog(), tracking: true, uploads_open: false });
      if (b.action === 'program_step') { if (b.step === 'quiz_submitted' && status !== 'training_completed') return send({ error: 'watch_first', message: 'Watch the training video first.' }, 409);
        status = b.step === 'watched' ? 'training_completed' : 'exam_reported'; return send({ ok: true, status, label: 'Recorded' }); }
      return send({}, 404);
    });
    await page.goto(BASEURL + '/academy/'); await page.waitForTimeout(300);
    return { ctx, page, posts, errors };
  }
  try {
    for (const w of [390, 1280]) await t(`${w}px: card → program page; video then Golden's quiz; steps recorded in order; no CSP errors`, async () => {
      const { ctx, page, posts, errors } = await open(w);
      assert.match(await page.textContent('#view'), /Golden Technologies technical certifications/);
      await page.click('text=Start the training'); await page.waitForSelector('.ac-pg-steps');
      assert.match(page.url(), /#program\?c=/);
      const f = await page.$eval('.ac-video iframe', x => x.getAttribute('src')); assert.strictEqual(f, 'https://www.youtube-nocookie.com/embed/VApekZEFn8c?rel=0');
      assert.deepStrictEqual(await page.$eval('a.ac-pg-quiz', a => [a.getAttribute('href'), a.target, a.rel]), ['https://forms.gle/BsZRxeTDWitwRGfr5', '_blank', 'noopener noreferrer']);
      assert.strictEqual(await page.$eval('button:has-text("I submitted the quiz")', b => b.disabled), true, 'quiz report waits for the video report');
      assert.match(await page.textContent('#view'), /forward it to HCPS at info@homecareproviderservices\.us/);
      assert.strictEqual(await page.$('input[type=file]'), null, 'no upload while uploads are off');
      await page.click('text=I watched the whole video'); await page.waitForSelector('text=You reported that you watched the video');
      await page.click('text=I submitted the quiz'); await page.waitForSelector('text=You reported that you submitted the quiz');
      assert.deepStrictEqual(posts.filter(p => p.action === 'program_step').map(p => p.step), ['watched', 'quiz_submitted']);
      assert.strictEqual(await page.evaluate(() => window.__x), undefined); assert.strictEqual(await page.$('.ac-pg-overview img'), null);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
      assert.deepStrictEqual(errors, []); await ctx.close();
    });
  } finally {
    await browser.close(); srv.close();
    console.log(`\nacademy program browser: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();

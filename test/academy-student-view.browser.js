/* HCPS Academy — browser QA for the Command Center Student view (/admin/academy-student.html, built page from _site).
   academy-admin-api is stubbed in the browser (a real learner-mode lesson payload is built from Sample A by the real
   payload builder); nothing reaches Supabase. Desktop and phone: no sideways scroll, the learner course card, a lesson in
   the learner player WITHOUT the staff badge, staff warnings only in the staff ribbon, the sample exam (no key in what
   the page receives), the result with the staff answer review, server text placed as text, nothing saved but this tab.
     PLAYWRIGHT_MODULE=/home/claude/.npm-global/lib/node_modules/playwright node test/academy-student-view.browser.js  (after npm run build) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const LESSON = require('../netlify/functions/_academy_lesson.js');
const { SAMPLES, MANUFACTURERS } = require('../netlify/functions/_academy_samples.js');

const ROOT = path.join(__dirname, '..', '_site');
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
if (!fs.existsSync(path.join(ROOT, 'admin', 'academy-student.html'))) { console.log('SKIP: run npm run build first'); process.exit(0); }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); } }
const V = '00000000-0000-4000-8000-000000000011', L1 = '00000000-0000-4000-8000-000000000021', L2 = '00000000-0000-4000-8000-000000000022';
const XSS = '<img src=x onerror="window.__x=1">';
const s = SAMPLES.A;
const lessonA = LESSON.buildLesson({ mode: 'learner', course: s.course, module: s.module, lesson: s.lesson, outline: s.outline, facts: s.facts, media: [], questions: s.questions, manufacturers: MANUFACTURERS, version: { status: 'draft' } });
const Q = [1, 2, 3].map(i => ({ id: '00000000-0000-4000-8000-00000000003' + i, kind: 'single', prompt: 'Question ' + i + (i === 3 ? ' ' + XSS : ''), choices: [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }] }));
const COURSE = { ok: true, course: { id: 'c1', slug: 'golden-lift-chair-sales-certification', title: 'HCPS Lift Chair Sales & Product Knowledge Certification', is_test: false },
  version: { id: V, version: 2, status: 'draft', pass_mark: 80, exam_questions: 3, time_limit_minutes: 45, cooldown_minutes: 60, daily_limit: 3 },
  modules: [{ id: 'm1', position: 1, title: 'Welcome', lessons: [{ id: L1, position: 1, title: 'Comfort Zones', est_minutes: 12 }] },
            { id: 'm2', position: 2, title: 'Fitting', lessons: [{ id: L2, position: 1, title: 'Fit the chair', est_minutes: 10 }] }],
  exam: { usable: 3, held_unverified: 1, ready: true, problem: null }, disclosure: 'Issued by Home Care Provider Services (HCPS). Not issued, sponsored or endorsed by Golden Technologies.' };

(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const BASEURL = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  async function open(width, qs) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } }); const page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.setItem('hcps_staff_token', 'test-token'); localStorage.setItem('hcps_staff_expires', String(Date.now() + 3600e3)); });
    const calls = [], errors = [], received = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/.netlify/functions/academy-admin-api', async route => {
      const b = JSON.parse(route.request().postData() || '{}'); calls.push(b);
      const send = j => { received.push(JSON.stringify(j)); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) }); };
      if (b.action === 'whoami') return send({ enabled: true, may: { administer: true, publish: true } });
      if (b.action === 'student_catalog') return send({ ok: true, courses: [{ id: 'c1', title: COURSE.course.title, versions: [{ id: V, version: 2, status: 'draft' }, { id: '00000000-0000-4000-8000-000000000012', version: 1, status: 'published' }] }] });
      if (b.action === 'student_course') return send(COURSE);
      if (b.action === 'student_lesson') return send({ ok: true, lesson: lessonA, staff_warnings: ['Picture placeholder on screen 4 ' + XSS], prev_lesson_id: b.lesson_id === L2 ? L1 : null, next_lesson_id: b.lesson_id === L1 ? L2 : null });
      if (b.action === 'student_exam_draw') return send({ ok: true, pass_mark: 80, time_limit_minutes: 45, questions: Q });
      if (b.action === 'student_exam_grade') return send({ ok: true, recorded: false, score: 66, passed: false, pass_mark: 80, right: 2, total: 3, study_topics: ['comfort-zones'],
        staff_review: [{ id: Q[0].id, prompt: 'Question 1', answered: true, correct: true, explanation: 'Because.' }, { id: Q[1].id, prompt: 'Question 2', answered: true, correct: true, explanation: '' }, { id: Q[2].id, prompt: 'Question 3', answered: false, correct: false, explanation: XSS }] });
      if (b.action === 'preview_check') return send({ ok: true, correct: true, explanation: 'Right.' });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.goto(BASEURL + '/admin/academy-student.html' + (qs == null ? '?version=' + V : qs)); await page.waitForTimeout(300);
    return { ctx, page, calls, errors, received };
  }
  try {
    for (const w of [390, 1280]) {
      await t(`${w}px: course card as a learner sees it, staff note about the draft, no sideways scroll`, async () => {
        const { ctx, page, errors } = await open(w);
        assert.match(await page.textContent('#view'), /HCPS Lift Chair Sales & Product Knowledge Certification/);
        assert.match(await page.textContent('#view'), /0 of 2 lessons complete/);
        assert.match(await page.textContent('#sv-notes'), /status "draft": learners cannot see it/);
        assert.match(await page.inputValue('#sv-course'), new RegExp(V));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
        assert.deepStrictEqual(errors, []); await ctx.close();
      });
    }
    await t('lesson: the learner player with NO staff badge; warnings only in the staff ribbon, as text; Next lesson; progress shown on the card', async () => {
      const { ctx, page, calls } = await open(1280);
      await page.click('#view button.ac-btn.pri'); await page.waitForSelector('#view .hl-bar');
      assert.ok(!(await page.textContent('#view')).includes('Staff preview'), 'no staff badge inside the player');
      assert.match(await page.textContent('#sv-notes'), /<img src=x/); assert.strictEqual(await page.$('#sv-notes img'), null);
      assert.ok(calls.some(c => c.action === 'student_lesson' && c.lesson_id === L1 && c.version_id === V));
      await page.click('text=Next lesson'); await page.waitForTimeout(200);
      assert.ok(calls.some(c => c.action === 'student_lesson' && c.lesson_id === L2));
      await page.click('text=← My courses'); assert.match(await page.textContent('#view'), /1.1 Comfort ZonesStarted/);
      await page.click('#sv-reset'); assert.match(await page.textContent('#view'), /0 of 2 lessons complete/);
      assert.strictEqual(await page.evaluate(() => window.__x), undefined);
      await ctx.close();
    });
    await t('exam: rules page with the staff facts, sample attempt, submit, result with the staff answer review; nothing posted but draw / grade', async () => {
      const { ctx, page, calls, received } = await open(390);
      await page.click('text=Final exam');
      assert.match(await page.textContent('#view'), /3 questions · 80% to pass/);
      assert.match(await page.textContent('#sv-notes'), /1 more held back because a product fact they use is not verified/);
      await page.click('#view button:has-text("Start the exam")'); await page.waitForSelector('fieldset.ac-q');
      assert.match(await page.textContent('.ac-clock'), /left/);
      await page.click('label.ac-choice >> nth=0'); await page.click('text=Next');
      await page.click('label.ac-choice >> nth=1'); await page.click('text=Next');
      assert.match(await page.textContent('legend'), /<img src=x/); assert.strictEqual(await page.$('legend img'), null);
      await page.click('text=Review and submit'); assert.match(await page.textContent('#view'), /You answered 2 of 3/);
      await page.click('text=Submit my answers'); await page.waitForSelector('.ac-score');
      assert.match(await page.textContent('#view'), /Not passed this time/); assert.match(await page.textContent('#view'), /66%/); assert.match(await page.textContent('#view'), /Comfort zones/);
      assert.match(await page.textContent('#sv-notes'), /2 of 3 correct\. Not recorded/);
      const g = calls.find(c => c.action === 'student_exam_grade');
      assert.deepStrictEqual(g.question_ids, Q.map(q => q.id)); assert.deepStrictEqual(g.answers, { [Q[0].id]: 'a', [Q[1].id]: 'b' });
      assert.ok(!received.some(r => /answer_key/.test(r) && /student_exam_draw|"questions"/.test(r) && !/staff_review/.test(r)), 'the drawn exam carried no answer key');
      assert.ok(calls.every(c => /^(whoami|student_|preview_check)/.test(c.action)), 'only read actions');
      assert.strictEqual(await page.evaluate(() => window.__x), undefined);
      await ctx.close();
    });
    await t('no version chosen: the picker lists drafts and published versions and explains what to do', async () => {
      const { ctx, page } = await open(1280, '');
      assert.match(await page.textContent('#view'), /Choose a course version/);
      const opts = await page.$$eval('#sv-course option', o => o.map(x => x.textContent));
      assert.ok(opts.some(x => /v2 \(draft\)/.test(x)) && opts.some(x => /v1 \(published\)/.test(x)), opts.join(' | '));
      await ctx.close();
    });
  } finally {
    await browser.close(); srv.close();
    console.log(`\nacademy student view browser: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();

/* HCPS Academy A2D Stage 2 — the lesson player in a real browser (Chromium), against the REAL academy-admin-api.js.
   A local server serves the preview page, the shared player (/assets/academy/*) and the admin chrome from the repo, and
   answers the admin API by running the real function in the Phase 0 harness (in-memory database). Supabase Storage,
   YouTube and everything else outside this machine are answered or blocked by the browser itself. Nothing is saved.
     PLAYWRIGHT_MODULE=/opt/node-tools/node_modules/playwright AXE=/path/to/axe-core/axe.min.js SHOTS=/tmp/shots \
       node test/academy-lesson.browser.js
   Checks, for Samples A and B and a course lesson from the database, at 1440, 1024, 820, 390 and 360px:
     no sideways scroll; every control at least 44px; no text under 12px; desktop module list vs phone "All modules"
     panel and bottom bar; every screen reachable and passed; the completion flow (explorers, scenario, server-checked
     knowledge check) and "nothing was saved"; keyboard: tabs by arrow keys, Escape closes the panel, visible focus on
     every control; the comparison's differences-only toggle and fixed feature column; video loads only on tap; a
     missing or broken picture becomes a labelled placeholder (zero broken images); no answer key anywhere in the page or
     the API responses; a HOSTILE lesson (HTML/script in every text) runs nothing and injects nothing; axe-core finds no
     WCAG 2.2 A/AA violation; the in-page phone width (container queries) matches a real phone viewport. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { createWorld, load, BASE } = require('./phase0-mock.js');
const { SAMPLES } = require('../netlify/functions/_academy_samples.js');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const ROOT = path.join(__dirname, '..', 'src');
const SHOTS = process.env.SHOTS || null;
const AXE = process.env.AXE || null;
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G = 'golden-technologies';
/* academy-lesson.mutants.js --browser: one renderer protection undone, in memory, as this server sends the file. */
const MUTANT = process.env.LESSON_MUTANT ? JSON.parse(process.env.LESSON_MUTANT) : null;
const QUICK = process.env.LESSON_MUTANT_ONLY === '1';
if (MUTANT) { const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'academy', MUTANT.css ? 'lesson-player.css' : 'lesson-player.js'), 'utf8');
  if (!src.includes(MUTANT.from)) { console.log('MUTANT ANCHOR NOT FOUND'); process.exit(1); } }
const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1"><script>window.__xss=1</script><svg onload="window.__xss=1">`;

/* A real 400x300 PNG, so a picture that loads really loads. */
function png(w, hgt) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * hgt); for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 22; raw[o + 1] = 129; raw[o + 2] = 194; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(400, 300);

function dbLesson(hostile) {
  const T = s => hostile ? XSS + s : s;
  const L = u(31), V = u(11), M = u(21), C = u(1);
  const blocks = [
    { kind: 'objectives', items: [T('Point to each part of the hand control'), T('Explain what each button does')] },
    { kind: 'text', heading: T('The AutoDrive control'), body: T('Read **this** first.') + '\n\n- ' + T('one') + '\n- two' },
    { kind: 'explorer', style: 'hotspots', title: T('Hand control parts'), media_id: u(81), items: [
      { title: T('Rise'), body: T('Raises the chair.'), x: 30, y: 20 }, { title: 'Recline', body: 'Reclines the chair.', x: 70, y: 20 }, { title: 'Presets', body: 'ZG, HOME, TV.', x: 50, y: 70 }] },
    { kind: 'image', media_id: u(82), caption: T('A picture whose file is gone') },
    { kind: 'image', media_id: u(81), caption: 'The control, decorative copy' },
    { kind: 'video', media_id: u(83), caption: T('AutoDrive video') },
    { kind: 'document', media_id: u(84), title: T('Owner manual') },
    { kind: 'quote', text: T('words'), manufacturer_slug: G, source_label: T('Golden page'), source_url: hostile ? 'javascript:window.__xss=1' : 'https://goldentech.com/', source_date: '2026-10-10' },
    { kind: 'steps', title: T('Steps'), items: [T('First'), 'Second'], source_label: T('Golden manual') },
    { kind: 'fact', manufacturer_slug: G, model_code: 'PR511', field: 'weight_capacity', label: T('Capacity') },
    { kind: 'scenario', prompt: T('A customer asks…'), choices: [{ id: 'a', text: T('One'), feedback: T('No.'), best: false }, { id: 'b', text: 'Two', feedback: 'Yes.', best: true }, { id: 'c', text: 'Three', feedback: 'No.', best: false }] },
    { kind: 'check', question_ids: [u(41), u(42)] },
    { kind: 'takeaways', items: [T('a'), 'b', 'c'] },
  ];
  return {
    tokens: { pres: 'angelo@hcps.us', greg: 'greg@hcps.us' },
    tables: {
      staff_users: [{ email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', active: true }, { email: 'greg@hcps.us', name: 'Greg', role: 'rep', active: true }],
      dealers: [], dealer_directory: [], manufacturers: [{ slug: G, name: hostile ? T('Golden') : 'Golden Technologies' }],
      app_settings: [{ key: 'phase2_flags', value: { academy_admin: true } }],
      academy_courses: [{ id: C, slug: 'golden-lift-chairs', title: T('Golden Lift Chair Sales Certification'), course_type: 'hcps_certification', issuer: 'hcps', manufacturer_slug: G, status: 'draft', created_at: '2026-10-01T00:00:00Z' }],
      academy_course_versions: [{ id: V, course_id: C, version: 1, status: 'draft', pass_mark: 80, exam_questions: 25, validity_months: 12, created_at: '2026-10-01T00:00:00Z' }],
      academy_modules: [{ id: M, version_id: V, position: 5, title: T('AutoDrive and hand controls'), objectives: [] }],
      academy_lessons: [{ id: L, module_id: M, position: 2, title: T('Reading the hand control'), est_minutes: 11, blocks }],
      academy_questions: [
        { id: u(41), version_id: V, module_id: M, kind: 'single', use: 'practice', status: 'active', prompt: T('Which button raises the chair?'), choices: [{ id: 'a', text: T('Rise') }, { id: 'b', text: 'TV' }], answer_key: 'a', explanation: T('Rise raises it.') + ' EXPLANATION-SENTINEL', objective_tags: ['x'] },
        { id: u(42), version_id: V, module_id: M, kind: 'multi', use: 'practice', status: 'active', prompt: 'Which are presets?', choices: [{ id: 'a', text: 'ZG' }, { id: 'b', text: 'TV' }, { id: 'c', text: 'Rise' }], answer_key: ['a', 'b'], explanation: 'ZG and TV. EXPLANATION-SENTINEL', objective_tags: ['x'] },
        { id: u(43), version_id: V, module_id: M, kind: 'single', use: 'exam', status: 'active', prompt: 'EXAM-PROMPT-SENTINEL', choices: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], answer_key: 'a', explanation: 'EXAM-EXPLANATION-SENTINEL', objective_tags: ['x'] }],
      academy_media: [
        { id: u(81), kind: 'image', storage_path: 'media/academy/control.png', rights: 'hcps_owned', alt_text: T('The AutoDrive hand control seen from the front') },
        { id: u(82), kind: 'image', storage_path: 'media/academy/missing.png', rights: 'hcps_owned', alt_text: T('A picture that will not load') },
        { id: u(83), kind: 'video', external_url: 'https://www.youtube-nocookie.com/embed/abcdefgh12', rights: 'link_only', manufacturer_slug: G, alt_text: T('AutoDrive video') },
        { id: u(84), kind: 'link', external_url: 'https://goldentech.com/manual', rights: 'link_only', manufacturer_slug: G, alt_text: 'Manual' }],
      product_facts: [{ id: u(91), manufacturer_slug: G, model_code: 'PR511', field: 'weight_capacity', value: hostile ? XSS : 400, unit: 'lb', field_class: 'display', status: 'verified',
        source_url: hostile ? 'javascript:window.__xss=1' : 'https://goldentech.com/', source_label: T('Golden sell sheet'), verified_on: '2026-10-10', verified_by: 'staff:x', note: null, valid_to: null }],
      academy_events: [],
    },
    LESSON_ID: L,
  };
}

function server(world, log) {
  let mod = null;
  const ensure = () => {
    if (mod) return mod;
    mod = load('academy-admin-api.js', world, {});
    const base = global.fetch;
    global.fetch = async (url, o) => {
      const s = String(url);
      if (s.startsWith(BASE + '/storage/v1/object/sign/')) { const p = s.slice((BASE + '/storage/v1/object/sign/').length); return { ok: true, status: 200, json: async () => ({ signedURL: '/object/sign/' + p + '?token=t' }), text: async () => '' }; }
      return base(url, o);
    };
    return mod;
  };
  return http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString('utf8');
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/.netlify/functions/academy-admin-api') {
      const out = await ensure().handler({ httpMethod: req.method, headers: req.headers, body, queryStringParameters: {} });
      log.push(out.body); res.writeHead(out.statusCode, out.headers); return res.end(out.body);
    }
    if (p.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"favorites":[],"count":0}'); }
    const file = path.resolve(ROOT, '.' + p);
    if (file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.png') ? 'image/png' : 'text/html' });
      let data = fs.readFileSync(file);
      if (MUTANT && p === (MUTANT.css ? '/assets/academy/lesson-player.css' : '/assets/academy/lesson-player.js')) data = Buffer.from(String(data).split(MUTANT.from).join(MUTANT.to));
      return res.end(data);
    }
    res.writeHead(404); res.end('');
  });
}
async function withSite(seed, fn) {
  const world = createWorld(seed); const log = [];
  const srv = server(world, log); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn({ origin, world, log }); } finally { srv.close(); }
}
async function page(browser, origin, width, token) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 780 : 900 }, deviceScaleFactor: width < 500 ? 2 : 1, isMobile: width < 500, hasTouch: width < 500 });
  await ctx.addInitScript(tok => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: tok + '@hcps.us', name: tok, role: tok === 'pres' ? 'president' : 'rep' })); } catch (e) {} }, token || 'pres');
  await ctx.route(r => !/^http:\/\/127\.0\.0\.1[:/]/.test(String(r)), route => {
    const s = route.request().url();
    if (s.startsWith(BASE + '/storage/v1/object/sign/academy-private/media/academy/control.png')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (s.startsWith(BASE + '/storage/')) return route.fulfill({ status: 404, body: '' });
    if (s.startsWith('https://www.youtube-nocookie.com/embed/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>video</title><p>video frame</p>' });
    return route.abort();
  });
  const pg = await ctx.newPage(); const errors = [];
  pg.on('pageerror', e => errors.push(String(e))); pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  pg.errors = errors; return pg;
}
const shot = async (pg, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true });
  await pg.addStyleTag({ content: '#ac-head,#ac-head *{position:static!important}' });   // the sticky Connect 360 masthead would be painted mid-page in a full-page image
  await pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
const open = async (pg, origin, q) => { await pg.goto(origin + '/admin/academy-preview.html?' + q); await pg.waitForSelector('.hl-screen'); };

/* Layout and readability of what is on screen now: no sideways scroll, controls >= 44px, text >= 12px. */
async function measure(pg) {
  return pg.evaluate(() => {
    const W = document.documentElement.clientWidth, out = { over: [], small: [], tiny: [] };
    const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.closest('[hidden]'); };
    document.querySelectorAll('#app *').forEach(e => {
      if (!vis(e)) return;
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox === 'auto' || ox === 'scroll') return; }   // inside its own scrolling box (the comparison table)
      const r = e.getBoundingClientRect(); if (r.right > W + 1) out.over.push(e.tagName + '.' + e.className + ' ' + Math.round(r.right) + '>' + W);
    });
    document.querySelectorAll('.hl button, .hl [role="tab"], .hl .hl-doc, .hl .hl-choice, .hl summary').forEach(e => {
      if (!vis(e)) return; const r = e.getBoundingClientRect();
      if (e.matches('summary') ? r.height < 24 : (r.height < 43.5 || r.width < 43.5)) out.small.push((e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    const walker = document.createTreeWalker(document.querySelector('.hl'), NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const n = walker.currentNode; if (!n.textContent.trim()) continue; const e = n.parentElement; if (!vis(e) || e.closest('.hl-sr')) continue;
      const fs = parseFloat(getComputedStyle(e).fontSize); if (fs < 12) out.tiny.push(e.tagName + ' ' + fs + 'px "' + n.textContent.trim().slice(0, 20) + '"'); }
    out.docScroll = document.scrollingElement.scrollWidth > window.innerWidth + 1;
    return out;
  });
}
/* Walks every screen: answers what must be answered, checks layout on each, then completes the lesson. */
async function walk(pg, label, width) {
  const total = await pg.$$eval('.hl-screen:not(.hl-tail)', s => s.length);
  for (let i = 0; i < total; i++) {
    assert.strictEqual(await pg.textContent('.hl-pos'), `${i + 1} of ${total}`, label);
    const sec = `.hl-screen:not([hidden]):not(.hl-tail)`;
    const kind = await pg.$eval(sec, s => [...s.classList].find(c => c.startsWith('hl-k-')).slice(5));
    if (kind === 'explorer') { const b = await pg.$(`${sec} [role="tab"][aria-selected="false"], ${sec} .hl-card, ${sec} .hl-picker .hl-pill`); await b.click(); await pg.waitForSelector(`${sec} .hl-detail h3, ${sec} .hl-tabpanel h3`); }
    if (kind === 'scenario') { await pg.click(`${sec} .hl-choice >> nth=0`); assert.ok((await pg.textContent(`${sec} .hl-feedback`)).length > 10); }
    if (kind === 'check') {
      const n = Number((await pg.textContent(`${sec} .hl-qinfo`)).match(/of (\d+)/)[1]);
      for (let q = 0; q < n; q++) {
        if (await pg.$(`${sec} .hl-check`)) { await pg.click(`${sec} .hl-check >> nth=0`); await pg.click(`${sec} .hl-qbox .hl-primary`); }
        else await pg.click(`${sec} .hl-choice >> nth=0`);
        await pg.waitForFunction(s => /^(Correct|Not quite)\./.test(document.querySelector(s + ' .hl-feedback').textContent), sec);
        if (q < n - 1) await pg.click(`${sec} button:has-text("Next question")`);
      }
      assert.ok(/of \d+ correct so far/.test(await pg.textContent(`${sec} .hl-qscore`)));
    }
    await pg.waitForTimeout(760);   // "shown on screen for a moment"
    const m = await measure(pg);
    assert.deepStrictEqual(m.over, [], `${label} ${width} screen ${i + 1} (${kind}) wider than the screen`);
    assert.strictEqual(m.docScroll, false, `${label} ${width} screen ${i + 1}: the page scrolls sideways`);
    assert.deepStrictEqual(m.small, [], `${label} ${width} screen ${i + 1} (${kind}) control under 44px`);
    assert.deepStrictEqual(m.tiny, [], `${label} ${width} screen ${i + 1} (${kind}) text under 12px`);
    if (i === 0 || kind === 'comparison' || kind === 'check' || kind === 'explorer') await shot(pg, `${label}-${width}-${String(i + 1).padStart(2, '0')}-${kind}`);
    if (i < total - 1) await pg.click('.hl-next');
  }
  assert.strictEqual(await pg.textContent('.hl-progress-label'), '100%', label + ' progress');
  assert.strictEqual(await pg.isEnabled('.hl-complete-btn'), true, label + ' completion unlocked');
  await pg.click('.hl-complete-btn');
  assert.ok((await pg.textContent('.hl-complete-msg')).includes('nothing was saved'));
  await shot(pg, `${label}-${width}-end`);
}

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.stack || e).toString().split('\n').slice(0, 6).join('\n  ')); } }
const WIDTHS = QUICK ? [1440, 390] : [1440, 1024, 820, 390, 360];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  try {
    for (const k of QUICK ? ['A'] : ['A', 'B']) {
      await t(`Sample ${k}: every screen at 1440 / 1024 / 820 / 390 / 360 — no sideways scroll, 44px controls, 12px text, every screen passed, lesson completes, nothing saved, no answer key`, async () => withSite(dbLesson(false), async ({ origin, log }) => {
        for (const width of WIDTHS) {
          const pg = await page(browser, origin, width);
          await open(pg, origin, 'sample=' + k);
          const phone = width < 900;
          assert.strictEqual(await pg.isVisible('.hl-outline'), !phone, 'module list beside the lesson on desktop only');
          assert.strictEqual(await pg.isVisible('.hl-modules-btn'), phone, '"All modules" on phones');
          await walk(pg, 'sample' + k, width);
          const html = await pg.content();
          for (const q of SAMPLES[k].questions) assert.ok(!html.includes('answer_key'));
          assert.deepStrictEqual(pg.errors, []); await pg.context().close();
        }
        for (const body of log) { assert.ok(!/answer_key/.test(body)); }
        const previews = log.filter(b => /"lesson":/.test(b));
        for (const q of SAMPLES[k].questions) for (const b of previews) assert.ok(!b.includes(q.explanation), 'explanation only after an answer');
      }));
    }
    await t('course lesson from the database: hotspots, a missing picture as a labelled placeholder, a decorative picture, video only on tap, link document, fact with source and date; zero broken images', async () => withSite(dbLesson(false), async ({ origin }) => {
      for (const width of [1440, 390]) {
        const pg = await page(browser, origin, width);
        await open(pg, origin, 'lesson=' + u(31)); await pg.click('.hl-viewtoggle button:has-text("Whole lesson")');
        for (const im of await pg.$$('.hl img')) { await im.scrollIntoViewIfNeeded().catch(() => {}); }   // pictures load lazily, as on a phone
        await pg.waitForSelector('.hl-k-image .hl-ph');
        await pg.waitForFunction(() => [...document.images].filter(i => i.closest('.hl')).every(i => i.complete));
        const imgs = await pg.$$eval('.hl img', a => a.map(i => ({ ok: i.naturalWidth > 0, alt: i.alt, hidden: i.getAttribute('aria-hidden') })));
        assert.ok(imgs.length >= 2 && imgs.every(i => i.ok), 'every picture on the page loaded: ' + JSON.stringify(imgs));
        const ph = await pg.$$eval('.hl-k-image .hl-ph', a => a.map(x => x.getAttribute('aria-label')));
        assert.deepStrictEqual(ph, ['Picture: A picture that will not load'], 'the broken file became a labelled placeholder');
        assert.strictEqual(await pg.$$eval('.hl-dot', d => d.length), 3);
        await pg.click('.hl-dot >> nth=1'); assert.strictEqual(await pg.textContent('.hl-k-explorer .hl-detail h3'), 'Recline');
        assert.strictEqual(await pg.$('.hl-k-video iframe'), null, 'nothing loads before the tap');
        await pg.click('.hl-play'); await pg.waitForSelector('.hl-k-video iframe');
        assert.ok((await pg.getAttribute('.hl-k-video iframe', 'src')).startsWith('https://www.youtube-nocookie.com/embed/'));
        assert.strictEqual(await pg.getAttribute('.hl-k-document a.hl-doc', 'href'), 'https://goldentech.com/manual');
        assert.strictEqual(await pg.getAttribute('.hl-k-document a.hl-doc', 'rel'), 'noopener noreferrer');
        const fact = await pg.textContent('.hl-k-fact .hl-fact');
        assert.ok(/400 lb/.test(fact) && /Golden sell sheet/.test(fact) && /verified 10 Oct 2026/.test(fact), fact);
        assert.ok(!(await pg.content()).includes('EXAM-PROMPT-SENTINEL') && !(await pg.content()).includes('EXPLANATION-SENTINEL'));
        await shot(pg, `db-${width}-whole`);
        const m = await measure(pg); assert.deepStrictEqual(m.over, []); assert.deepStrictEqual(m.small, []); assert.deepStrictEqual(m.tiny, []);
        assert.deepStrictEqual(pg.errors, []); await pg.context().close();
      }
    }));
    await t('keyboard: Tab reaches every control with a visible focus ring; tabs move with arrow keys; "All modules" opens, Escape closes and returns focus', async () => withSite(dbLesson(false), async ({ origin }) => {
      const pg = await page(browser, origin, 390);
      await open(pg, origin, 'sample=A&width=phone');
      await pg.focus('.hl-modules-btn'); await pg.keyboard.press('Enter');
      assert.strictEqual(await pg.isVisible('.hl-panel'), true); assert.strictEqual(await pg.getAttribute('.hl-modules-btn', 'aria-expanded'), 'true');
      assert.strictEqual(await pg.evaluate(() => document.activeElement.textContent), 'Close');
      await shot(pg, 'phone-modules-panel');
      await pg.keyboard.press('Escape'); assert.strictEqual(await pg.isVisible('.hl-panel'), false);
      assert.ok(await pg.evaluate(() => document.activeElement.classList.contains('hl-modules-btn')));
      for (let i = 0; i < 5; i++) await pg.click('.hl-next');   // screen 6: the "Which system" tabs
      await pg.waitForSelector('.hl-screen:not([hidden]) [role="tab"]');
      await pg.focus('.hl-screen:not([hidden]) [role="tab"][aria-selected="true"]');
      await pg.keyboard.press('ArrowRight');
      assert.strictEqual(await pg.evaluate(() => document.activeElement.textContent), '2-Zone MaxiComfort');
      assert.strictEqual(await pg.getAttribute('.hl-screen:not([hidden]) [role="tab"] >> nth=1', 'aria-selected'), 'true');
      await pg.keyboard.press('End'); assert.strictEqual(await pg.evaluate(() => document.activeElement.textContent), '5-Zone Twilight');
      // Tab through the whole page: every control is reachable and shows a ring of at least 2px
      await pg.click('.hl-viewtoggle button:has-text("Whole lesson")');
      await pg.evaluate(() => document.activeElement.blur());
      const seen = new Set(); let noRing = [];
      for (let i = 0; i < 160; i++) {
        await pg.keyboard.press('Tab');
        const f = await pg.evaluate(() => { const e = document.activeElement; if (!e || !e.closest('.hl')) return null; const s = getComputedStyle(e);
          return { k: e.tagName + '|' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30), ring: parseFloat(s.outlineWidth) >= 2 && s.outlineStyle !== 'none' }; });
        if (!f) continue; seen.add(f.k); if (!f.ring) noRing.push(f.k);
      }
      assert.deepStrictEqual(noRing, [], 'focus ring missing on: ' + noRing.join(', '));
      for (const want of ['BUTTON|Show differences only', 'BUTTON|Next question']) assert.ok([...seen].some(x => x.startsWith(want)), 'reachable by keyboard: ' + want);
      assert.deepStrictEqual(pg.errors, []); await pg.context().close();
    }));
    await t('comparison: "Show differences only" hides rows that are the same for every model; the feature column stays put while models scroll on a phone', async () => withSite(dbLesson(false), async ({ origin }) => {
      const pg = await page(browser, origin, 390);
      await open(pg, origin, 'sample=B');
      for (let i = 0; i < 4; i++) await pg.click('.hl-next');
      const sec = '.hl-screen:not([hidden])';
      assert.strictEqual(await pg.$$eval(`${sec} tbody tr:not([hidden])`, r => r.length), 12);
      await pg.click(`${sec} button:has-text("Show differences only")`);
      const shown = await pg.$$eval(`${sec} tbody tr:not([hidden]) th`, r => r.map(x => x.textContent));
      assert.ok(!shown.includes('Power lumbar') && shown.includes('Twilight tilt') && shown.length === 11, shown.join('|'));
      assert.strictEqual(await pg.getAttribute(`${sec} button[aria-pressed]`, 'aria-pressed'), 'true');
      const before = await pg.$eval(`${sec} tbody th`, e => e.getBoundingClientRect().left);
      await pg.$eval(`${sec} .hl-table-wrap`, w => { w.scrollLeft = 260; });
      const after = await pg.$eval(`${sec} tbody th`, e => e.getBoundingClientRect().left);
      const cellMoved = await pg.$eval(`${sec} tbody td`, e => e.getBoundingClientRect().left);
      assert.ok(Math.abs(before - after) < 1 && cellMoved < before + 150, `feature column fixed (${before} -> ${after}), cells scroll (${cellMoved})`);
      const amber = await pg.$$eval(`${sec} td.hl-awaiting .hl-flag`, f => f.map(x => x.textContent));
      assert.ok(amber.length === 4 && amber.every(x => x.startsWith('Awaiting Golden')), amber.join('|'));
      await shot(pg, 'phone-comparison-scrolled');
      assert.deepStrictEqual(pg.errors, []); await pg.context().close();
    }));
    await t('the in-page phone width (container queries) gives the same phone layout as a real phone viewport', async () => withSite(dbLesson(false), async ({ origin }) => {
      const pg = await page(browser, origin, 1440);
      await open(pg, origin, 'sample=A&width=phone');
      assert.strictEqual(await pg.isVisible('.hl-outline'), false); assert.strictEqual(await pg.isVisible('.hl-modules-btn'), true);
      assert.strictEqual(await pg.$eval('.hl-bar', b => getComputedStyle(b).position), 'sticky');
      await shot(pg, 'desktop-preview-at-phone-width');
      await pg.click('#widths button:has-text("Desktop")');
      await pg.waitForSelector('.hl-outline', { state: 'visible' });   // the frame widens with a short transition
      assert.strictEqual(await pg.isVisible('.hl-modules-btn'), false);
      assert.deepStrictEqual(pg.errors, []); await pg.context().close();
    }));
    await t('completion waits for every knowledge-check question: one answer is not enough; the message says what is left', async () => withSite(dbLesson(false), async ({ origin }) => {
      const pg = await page(browser, origin, 1440);
      await open(pg, origin, 'sample=A'); await pg.click('.hl-viewtoggle button:has-text("Whole lesson")');
      for (const s of await pg.$$('.hl-screen')) { await s.scrollIntoViewIfNeeded(); await pg.waitForTimeout(780); }
      for (const ex of await pg.$$('.hl-k-explorer')) { const b = await ex.$('[role="tab"][aria-selected="false"], .hl-card'); await b.click(); }
      await pg.click('.hl-k-scenario .hl-choice >> nth=2');
      await pg.click('.hl-k-check .hl-choice >> nth=0'); await pg.waitForFunction(() => /^(Correct|Not quite)/.test(document.querySelector('.hl-k-check .hl-feedback').textContent));
      await pg.waitForTimeout(300);
      assert.strictEqual(await pg.isEnabled('.hl-complete-btn'), false, 'locked after one of four answers');
      assert.ok((await pg.textContent('.hl-complete-msg')).includes('the knowledge check'));
      for (let q = 1; q < 4; q++) { await pg.click('.hl-k-check button:has-text("Next question")'); await pg.click('.hl-k-check .hl-choice >> nth=2');
        await pg.waitForFunction(n => (document.querySelector('.hl-k-check .hl-qscore').textContent.match(/of (\d+) correct/) || [])[1] == n, q + 1); }
      await pg.waitForFunction(() => !document.querySelector('.hl-complete-btn').disabled);
      assert.strictEqual(await pg.textContent('.hl-progress-label'), '100%');
      assert.deepStrictEqual(pg.errors, []); await pg.context().close();
    }));
    await t('the player checks links itself, even if a payload skipped the server: javascript:, data: and plain-http links and an unapproved video host are never used', async () => withSite(dbLesson(false), async ({ origin }) => {
      const pg = await page(browser, origin, 1440);
      await open(pg, origin, 'sample=A');
      await pg.evaluate(() => {
        const bad = 'javascript:window.__xss=1';
        window.HCPSLessonPlayer.mount(document.querySelector('#player'), { mode: 'preview', course: { title: 'x', manufacturer: 'Golden' }, module: {}, lesson: { title: 'Direct payload' }, outline: [],
          blocks: [
            { kind: 'quote', text: 'q', manufacturer: 'Golden', source_label: 'Quote source', source_url: bad, source_date: '2026-10-10' },
            { kind: 'fact', model_code: 'PR1', label: 'f', fact: { text: '1', status: 'verified', source_label: 'Fact source', source_url: 'data:text/html,<script>window.__xss=1</script>', verified_on: '2026-10-10' } },
            { kind: 'document', title: 'Doc', document: { href: bad, hosted_by: 'source' } },
            { kind: 'video', video: { embed: 'https://evil.example.com/embed/abcdefgh12', title: 'v' } },
            { kind: 'image', image: { src: bad, alt: 'An image with an unsafe address' } },
            { kind: 'steps', title: 's', items: ['a', 'b'], source_label: 'x', document: { href: 'http://plain.example.com/x' } },
            { kind: 'takeaways', items: ['a', 'b', 'c'] }],
          sources: [{ label: 'Listed source', url: bad, dates: [] }, { label: 'Plain http', url: 'http://plain.example.com/', dates: [] }], open_items: [] }, {});
      });
      await pg.click('.hl-viewtoggle button:has-text("Whole lesson")');
      assert.strictEqual(await pg.$$eval('.hl a', a => a.filter(x => !/^https:/.test(x.getAttribute('href') || '')).length), 0, 'a non-https link was drawn');
      assert.strictEqual(await pg.$$eval('.hl img', a => a.length), 0, 'an unsafe picture address was used');
      assert.strictEqual(await pg.$$eval('.hl iframe, .hl .hl-play', a => a.length), 0, 'an unapproved video was offered');
      for (const label of ['Quote source', 'Fact source', 'Listed source']) assert.ok((await pg.textContent('.hl')).includes(label), 'the label stays as text');
      assert.strictEqual(await pg.evaluate(() => window.__xss), undefined);
      assert.deepStrictEqual(pg.errors, []); await pg.context().close();
    }));
    await t('HOSTILE lesson: HTML and script in every text, fact, name and link — nothing runs, nothing is injected, the unsafe links are dropped', async () => withSite(dbLesson(true), async ({ origin }) => {
      for (const width of [1440, 390]) {
        const pg = await page(browser, origin, width);
        await open(pg, origin, 'lesson=' + u(31)); await pg.click('.hl-viewtoggle button:has-text("Whole lesson")');
        await pg.click('.hl-k-scenario .hl-choice >> nth=0');
        await pg.click('.hl-k-check .hl-choice >> nth=0'); await pg.waitForFunction(() => /^(Correct|Not quite)/.test(document.querySelector('.hl-k-check .hl-feedback').textContent));
        await pg.waitForTimeout(400);
        assert.strictEqual(await pg.evaluate(() => window.__xss), undefined, 'a script ran');
        assert.strictEqual(await pg.$$eval('.hl img[src="x"], .hl script, .hl svg', a => a.length), 0, 'an element was injected');
        assert.strictEqual(await pg.$$eval('.hl a[href^="javascript"]', a => a.length), 0);
        assert.ok((await pg.textContent('.hl-title')).includes('<script>'), 'the text is shown as text');
        await shot(pg, `hostile-${width}`);
        assert.deepStrictEqual(pg.errors, []); await pg.context().close();
      }
    }));
    if (!QUICK) await t('access: a rep sees "administrators only" and no lesson; with the switch off nothing loads', async () => {
      await withSite(dbLesson(false), async ({ origin, log }) => {
        const pg = await page(browser, origin, 1024, 'greg');
        await pg.goto(origin + '/admin/academy-preview.html?sample=A'); await pg.waitForSelector('#msg .note');
        assert.ok((await pg.textContent('#msg')).includes('administrators')); assert.strictEqual(await pg.$('.hl-screen'), null);
        assert.ok(!log.some(b => /"lesson":/.test(b))); await pg.context().close();
      });
      const off = dbLesson(false); off.tables.app_settings = [{ key: 'phase2_flags', value: { academy_admin: false } }];
      await withSite(off, async ({ origin }) => {
        const pg = await page(browser, origin, 1024);
        await pg.goto(origin + '/admin/academy-preview.html?sample=A'); await pg.waitForSelector('#msg .note');
        assert.ok((await pg.textContent('#msg')).includes('switched off')); assert.strictEqual(await pg.$('.hl-screen'), null); await pg.context().close();
      });
    });
    if (!QUICK) await t('accessibility (axe-core, WCAG 2.2 A and AA): no violations in Samples A and B and the course lesson, desktop and phone, whole lesson and with answers shown', async () => {
      assert.ok(AXE && fs.existsSync(AXE), 'set AXE to axe-core/axe.min.js (4.10.x)');
      await withSite(dbLesson(false), async ({ origin }) => {
        for (const q of ['sample=A', 'sample=B', 'lesson=' + u(31)]) for (const width of [1440, 390]) {
          const pg = await page(browser, origin, width);
          await open(pg, origin, q); await pg.click('.hl-viewtoggle button:has-text("Whole lesson")');
          await pg.click('.hl-k-scenario .hl-choice >> nth=1');
          await pg.click('.hl-k-check .hl-choice >> nth=0'); await pg.waitForFunction(() => /^(Correct|Not quite)/.test(document.querySelector('.hl-k-check .hl-feedback').textContent));
          const cards = await pg.$('.hl-card'); if (cards) await cards.click();
          await pg.addScriptTag({ path: AXE });
          const res = await pg.evaluate(async () => {
            const r = await window.axe.run(document.querySelector('.hl'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
            return r.violations.map(v => v.id + ': ' + v.nodes.length + ' (' + v.nodes.slice(0, 2).map(n => n.target.join(' ')).join('; ') + ')');
          });
          assert.deepStrictEqual(res, [], `${q} at ${width}`);
          await pg.context().close();
        }
      });
    });
  } finally { await browser.close(); }
  console.log(`\nacademy lesson browser: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();

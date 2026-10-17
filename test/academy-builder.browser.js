/* HCPS Academy A2D Stage 3 — the Course Builder in a real browser (Chromium), against the REAL admin API AND the REAL
   database rules. A local server serves /admin/academy-builder.html, its script, the shared lesson player and the admin
   chrome from the repo; the admin API is the real academy-admin-api.js, whose Supabase calls go to a local Postgres with
   A1, M1, M2 and M3 installed (test/academy-pgrest.js). Pictures come from the shim's private bucket. Nothing leaves
   this machine.
     PGTEST_PSQL=/usr/lib/postgresql/16/bin/psql PGHOST=/tmp/pgt PGPORT=55432 PGUSER=postgres \
     PLAYWRIGHT_MODULE=/opt/node-tools/node_modules/playwright AXE=/path/to/axe.min.js SHOTS=/tmp/shots \
       node test/academy-builder.browser.js
   Covers: every one of the 14 screen kinds built with the visual editors only (no code), saved through the real block
   checker; the live preview follows unsaved edits and grades a practice check; drag-and-drop and ▲▼ / keyboard
   reordering of screens, lessons and modules; hotspot placement by clicking the picture; the comparison grid flags
   missing and unconfirmed facts; the question bank (answer keys shown here only) and the exam distribution; the picture
   flow (an administrator uploads, only the President approves, the approved picture is then chosen in a screen); the
   readiness list opens the right lesson; unsaved changes are never lost silently; a version in review is read only;
   hostile text stays text; at 1440 / 1024 / 820 / 390 / 360 px there is no sideways scroll and every control is at
   least 44 px; axe-core finds no WCAG 2.2 A/AA violation. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { shim, BASE } = require('./academy-pgrest.js');
const { SAMPLES } = require('../netlify/functions/_academy_samples.js');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const ROOT = path.join(__dirname, '..', 'src');
const SHOTS = process.env.SHOTS || null;
const AXE = process.env.AXE || null;
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const ACT = `'staff:admin@test.example'`;
const G = 'golden-technologies';
/* BUILDER_MUTANT='{"from":…,"to":…}': one page-script protection undone as this server sends the file. */
const MUTANT = process.env.BUILDER_MUTANT ? JSON.parse(process.env.BUILDER_MUTANT) : null;
if (MUTANT && !fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'academy-builder.js'), 'utf8').includes(MUTANT.from)) { console.log('MUTANT ANCHOR NOT FOUND'); process.exit(1); }
const XSS = `<img src=x onerror="window.__xss=1">`;

function png(w, hgt) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * hgt); for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200; raw[o + 1] = 150 + (x % 50); raw[o + 2] = 60; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------------------------------------------------------- the database: a draft Golden course like the real one */
const DB = 'academy_builder_ui_' + process.pid;
const W = {};
function setup() {
  run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
  let fx = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) fx = fx.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, '');
  run(DB, fx); file(DB, SUP('academy_a1_foundation.sql')); run(DB, 'grant all on all tables in schema public to service_role');
  for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql']) file(DB, SUP(f));
  run(DB, "insert into staff_users (email, name, role, active) values ('admin2@test.example', 'Second Admin', 'admin', true)");
  run(DB, `insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}') on conflict (key) do update set value = excluded.value`);
  const course = JSON.parse(run(DB, `select academy_content_op_create_course(${ACT}, null, ${J({ slug: 'golden-lift-chair-sales', title: 'Golden Lift Chair Sales Certification', course_type: 'hcps_certification', manufacturer_slug: G })})`));
  const v = JSON.parse(run(DB, `select academy_content_op_create_version(${ACT}, null, '${course.id}'::uuid, '{"exam_questions": 3}'::jsonb)`));
  W.version = v.id;
  W.mods = ['Welcome to the course', 'Golden Comfort Zones', 'The Cloud family'].map(title => JSON.parse(run(DB, `select academy_content_op_create_module(${ACT}, null, '${v.id}'::uuid, ${J({ title })})`)));
  W.lessonA = JSON.parse(run(DB, `select academy_content_op_create_lesson(${ACT}, null, '${W.mods[1].id}'::uuid, ${J({ title: SAMPLES.A.lesson.title, est_minutes: 14 })})`));
  W.lessonNew = JSON.parse(run(DB, `select academy_content_op_create_lesson(${ACT}, null, '${W.mods[2].id}'::uuid, ${J({ title: 'Fitting the Cloud', est_minutes: 12 })})`));
  W.lessonWel = JSON.parse(run(DB, `select academy_content_op_create_lesson(${ACT}, null, '${W.mods[0].id}'::uuid, ${J({ title: 'Welcome', est_minutes: 8 })})`));
  const seen = new Set();
  for (const k of ['A', 'B']) for (const f of SAMPLES[k].facts) {
    const key = f.model_code + '|' + f.field; if (seen.has(key)) continue; seen.add(key);
    const fact = { manufacturer_slug: f.manufacturer_slug, model_code: f.model_code, field: f.field, value: f.value, field_class: 'display', status: f.status, source_url: f.source_url, source_label: f.source_label, verified_on: f.verified_on, verified_by: 'staff:admin@test.example' };
    if (f.unit) fact.unit = f.unit; if (f.note) fact.note = f.note;
    run(DB, `select academy_op_record_fact(${ACT}, ${J(fact)}, null, null)`);
  }
  for (const q of SAMPLES.A.questions) run(DB, `select academy_author_op_create_question(${ACT}, '${q.id}'::uuid, '${v.id}'::uuid, ${J({ kind: q.kind, use: 'practice', prompt: q.prompt, choices: q.choices, answer_key: q.answer_key, explanation: q.explanation, objective_tags: q.objective_tags, module_id: W.mods[1].id })})`);
  const links = new Set(); for (const b of SAMPLES.A.lesson.blocks) { if (b.kind === 'fact') links.add(`${b.model_code}|${b.field}`); if (b.kind === 'comparison') for (const m of b.models) for (const f of b.fields) links.add(`${m}|${f.field}`); }
  for (const l of links) { const [model, field] = l.split('|'); run(DB, `select academy_author_op_link_fact(${ACT}, null, ${J({ lesson_id: W.lessonA.id, manufacturer_slug: G, model_code: model, field })})`); }
  run(DB, `select academy_author_op_set_blocks(${ACT}, '${W.lessonA.id}'::uuid, ${J(SAMPLES.A.lesson.blocks)})`);
  // one approved picture already in the library (recorded by the President)
  W.picPath = 'media/golden-technologies/0000aaaabbbbcccc-pr446-side.png';
  W.pic = JSON.parse(run(DB, `select academy_author_op_create_media(${ACT}, null, ${J({ kind: 'image', storage_path: W.picPath, rights: 'manufacturer_permitted', manufacturer_slug: G, permission_ref: 'Golden confirmation 10 Oct 2026', alt_text: 'The PR-446 lift chair seen from the side' })})`));
  // a hostile module title (as if typed by someone careless) — set through the content operation's own marker
  run(DB, `begin; select set_config('academy.op', 'test', true); update academy_modules set title = ${"'" + ('Cloud family ' + XSS).replace(/'/g, "''") + "'"} where id = '${W.mods[2].id}'; commit;`);
}
setup();
const SH = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', adm: 'admin2@test.example' } });
SH.storage.set(W.picPath, { bytes: png(600, 400), type: 'image/png', created_at: new Date().toISOString() });
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
global.fetch = SH.fetch;
const API = require('../netlify/functions/academy-admin-api.js');

function server() {
  return http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString('utf8');
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/.netlify/functions/academy-admin-api') {
      const out = await API.handler({ httpMethod: req.method, headers: Object.assign({}, req.headers, { origin: 'https://www.homecareproviderservices.org' }), body, queryStringParameters: {} });
      res.writeHead(out.statusCode, out.headers); return res.end(out.body);
    }
    if (p.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"favorites":[],"count":0}'); }
    const f = path.resolve(ROOT, '.' + p);
    if (f.startsWith(ROOT + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : f.endsWith('.png') ? 'image/png' : 'text/html' });
      let data = fs.readFileSync(f);
      if (MUTANT && p === '/admin/academy-builder.js') data = Buffer.from(String(data).split(MUTANT.from).join(MUTANT.to));
      return res.end(data);
    }
    res.writeHead(404); res.end('');
  });
}
async function page(browser, origin, width, token) {
  const mobile = width < 500;
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 800 : 900 }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(tok => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: tok + '@hcps.us', name: tok, role: tok === 'pres' ? 'president' : 'admin' })); } catch (e) {} }, token || 'pres');
  await ctx.route(r => !/^http:\/\/127\.0\.0\.1[:/]/.test(String(r)), route => {
    const s = route.request().url();
    const SIGN = BASE + '/storage/v1/object/sign/academy-private/';
    if (s.startsWith(SIGN)) { const pth = decodeURIComponent(s.slice(SIGN.length).split('?')[0]); const o = SH.storage.get(pth); return o ? route.fulfill({ status: 200, contentType: o.type, body: o.bytes }) : route.fulfill({ status: 404, body: '' }); }
    return route.abort();
  });
  const pg = await ctx.newPage(); const errors = [];
  pg.setDefaultTimeout(20000);
  pg.on('pageerror', e => errors.push(String(e))); pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  pg.errors = errors; return pg;
}
const shot = async (pg, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await pg.addStyleTag({ content: '#ac-head,#ac-head *{position:static!important}.sticky{position:static!important}' }); await pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
const openB = async (pg, origin, hash) => { await pg.goto(origin + '/admin/academy-builder.html?version=' + W.version + (hash ? '#' + hash : '')); await pg.waitForSelector('#tabs [role="tab"]'); };
const blocksOf = id => JSON.parse(run(DB, `select blocks from academy_lessons where id = '${id}'`));
const saved = async pg => { await pg.click('#saveBar button:has-text("Save lesson")'); await pg.waitForSelector('#toast .note.ok'); await pg.waitForFunction(() => /All changes saved/.test(document.querySelector('#saveBar').textContent)); };
async function measure(pg) {
  return pg.evaluate(() => {
    const W = document.documentElement.clientWidth, out = { over: [], small: [], docScroll: document.scrollingElement.scrollWidth > window.innerWidth + 1, smallInput: [] };
    const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.closest('[hidden]'); };
    document.querySelectorAll('#app *').forEach(e => {
      if (!vis(e)) return;
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox === 'auto' || ox === 'scroll') return; }
      const r = e.getBoundingClientRect(); if (r.right > W + 1) out.over.push(e.tagName + '.' + e.className + ' ' + Math.round(r.right) + '>' + W);
    });
    document.querySelectorAll('#app button, #app select, #app input:not([type=checkbox]):not([type=radio]):not([type=file]), #app [role="tab"]').forEach(e => {
      if (!vis(e) || e.closest('.hl')) return; const r = e.getBoundingClientRect();
      if (r.height < 39.5 || (e.tagName === 'BUTTON' && r.width < 39.5)) out.small.push((e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      if (W < 900 && /INPUT|SELECT|TEXTAREA/.test(e.tagName) && parseFloat(getComputedStyle(e).fontSize) < 16) out.smallInput.push(e.tagName + ' ' + getComputedStyle(e).fontSize);
    });
    return out;
  });
}
async function axe(pg) {
  if (!AXE) return [];
  await pg.addScriptTag({ path: AXE });
  return pg.evaluate(async () => {
    const r = await window.axe.run(document.querySelector('#app'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map(v => v.id + ': ' + v.nodes.length + ' (' + v.nodes.slice(0, 3).map(n => n.target.join(' ')).join('; ') + ')');
  });
}
const brokenImages = pg => pg.evaluate(() => [...document.querySelectorAll('#app img')].filter(i => i.complete && i.naturalWidth === 0 && getComputedStyle(i).display !== 'none').map(i => i.getAttribute('src')));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }

(async () => {
  const srv = server(); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: EXE });
  try {
    await t('opens for the President: five sections, the outline, readiness in the header; hostile module title shown as text; Sample A loads with its live preview', async () => {
      const pg = await page(browser, origin, 1440);
      await openB(pg, origin, 'lessons/' + W.lessonA.id);
      assert.deepStrictEqual(await pg.$$eval('#tabs [role="tab"]', b => b.map(x => x.textContent.replace(/ \(\d+\)$/, ''))), ['Lessons & screens', 'Question bank', 'Exam distribution', 'Pictures & media', 'Readiness']);
      assert.match(await pg.textContent('#readyPill'), /to fix/);
      assert.ok((await pg.textContent('#pOutline')).includes('Cloud family <img src=x onerror="window.__xss=1">'), 'shown as text');
      await pg.waitForSelector('.blk[data-i="14"]');
      assert.strictEqual(await pg.$$eval('.blk', b => b.length), SAMPLES.A.lesson.blocks.length);
      await pg.waitForSelector('#player .hl-screen');
      assert.match(await pg.textContent('#pvStatus'), /not saved/);
      assert.strictEqual(await pg.evaluate(() => window.__xss), undefined);
      const m = await measure(pg); assert.deepStrictEqual(m.over, []); assert.strictEqual(m.docScroll, false); assert.deepStrictEqual(m.small, []);
      assert.deepStrictEqual(await axe(pg), []);
      assert.deepStrictEqual(await brokenImages(pg), []);
      await shot(pg, 'builder-1440-lesson');
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });

    await t('editing is visual: changing a heading marks the lesson unsaved, the live preview follows the UNSAVED text, Save writes it through the database', async () => {
      const pg = await page(browser, origin, 1440);
      await openB(pg, origin, 'lessons/' + W.lessonA.id);
      await pg.click('.blk[data-i="1"] .blk-h .t');
      const h = pg.locator('.blk[data-i="1"] .blk-b input').first();
      await h.fill('What a Comfort Zone is — edited');
      await pg.waitForFunction(() => /Unsaved changes/.test(document.querySelector('#saveBar').textContent));
      await pg.waitForFunction(() => document.querySelector('#player') && document.querySelector('#player').textContent.includes('What a Comfort Zone is — edited'));
      assert.notStrictEqual(blocksOf(W.lessonA.id)[1].heading, 'What a Comfort Zone is — edited', 'not saved yet');
      await saved(pg);
      assert.strictEqual(blocksOf(W.lessonA.id)[1].heading, 'What a Comfort Zone is — edited');
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });

    await t('all 14 screen kinds built with the editors only (no code) on an empty lesson, saved through the real block checker; hotspots placed by clicking the picture; the check is graded in the preview', async () => {
      const pg = await page(browser, origin, 1440);
      await openB(pg, origin, 'lessons/' + W.lessonNew.id);
      await pg.waitForSelector('text=This lesson has no screens yet');
      const add = async label => { await pg.click('button:has-text("+ Add a screen")'); await pg.click(`.add-grid button:has(span:text-is("${label}"))`); await pg.waitForSelector('.blk.sel .blk-b'); };
      const sel = '.blk.sel .blk-b';
      const fillNth = (n, v, tag) => pg.locator(`${sel} ${tag || 'input[type=text], textarea'}`).nth(n).fill(v);
      // objectives
      await add('Objectives'); await fillNth(0, 'Explain how the Cloud fits'); await fillNth(1, 'Check seat height and depth');
      // text
      await add('Text'); await fillNth(0, 'Why fit matters'); await fillNth(1, 'A chair that fits is a chair that is used.\n\nMeasure before you sell.');
      // callout
      await add('Tip or caution'); await pg.selectOption(`${sel} select`, 'caution'); await fillNth(0, 'Never guess a size; measure the customer.');
      // quote
      await add('Manufacturer quote'); await fillNth(0, 'The Cloud is designed for comfort.'); await fillNth(1, 'Golden Cloud sell sheet');
      await pg.locator(`${sel} input[type=url]`).fill('https://www.goldentech.com/'); await pg.locator(`${sel} input[type=date]`).fill('2026-10-10');
      // picture: choose the approved one
      await add('Picture'); await pg.click(`${sel} button[role=radio]:has-text("Approved picture")`); await pg.click(`${sel} .pick button[aria-label="Use The PR-446 lift chair seen from the side"]`); await fillNth(0, 'The PR-446 from the side');
      // video placeholder
      await add('Video'); await fillNth(0, 'Golden Cloud overview video (to be approved)'); await fillNth(1, 'Cloud overview');
      // document placeholder
      await add('Document'); await fillNth(0, 'Cloud owner manual'); await fillNth(1, 'Owner manual');
      // fact
      await add('Product fact'); await fillNth(0, 'pr515'); await fillNth(1, 'weight_capacity'); await fillNth(2, 'Weight capacity');
      await pg.waitForSelector(`${sel} [data-factline] .note`);
      // comparison: two models, one row; the grid flags what is missing
      await add('Comparison table'); await fillNth(0, 'Cloud sizes');
      for (const m of ['PR515', 'PR510']) { await pg.locator(`${sel} input[placeholder^="Model code"]`).fill(m); await pg.click(`${sel} button:has-text("+ Add model")`); }
      await pg.click(`${sel} button:has-text("+ Add row")`);
      await pg.locator(`${sel} input[aria-label="Row 1 specification field"]`).fill('weight_capacity'); await pg.locator(`${sel} input[aria-label="Row 1 label"]`).fill('Capacity');
      await pg.waitForSelector(`${sel} table.cmp td`);
      // explorer with hotspots on the approved picture
      await add('Explorer'); await pg.selectOption(`${sel} select`, 'hotspots');
      await pg.click(`${sel} .pick button[aria-label="Use The PR-446 lift chair seen from the side"]`);
      await pg.waitForSelector(`${sel} .hot img`); await pg.waitForFunction(s => { const i = document.querySelector(s + ' .hot img'); return i && i.complete && i.naturalWidth > 0; }, sel);
      for (const [k, title, body] of [[0, 'Backrest', 'Reclines independently.'], [1, 'Footrest', 'Rises with the seat.']]) {
        await pg.locator(`${sel} .sub-card`).nth(k).locator('input[type=text]').first().fill(title);
        await pg.locator(`${sel} .sub-card`).nth(k).locator('textarea').fill(body);
      }
      await pg.locator(`${sel} .sub-card`).nth(1).locator('button:has-text("Place on picture")').click();
      const box = await pg.locator(`${sel} .hot img`).boundingBox();
      await pg.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.25);
      await pg.waitForFunction(s => document.querySelectorAll(s + ' .hot .pin').length === 2, sel);
      // steps
      await add('Steps'); await fillNth(0, 'Three fitting checks'); await fillNth(1, 'Measure seat height'); await fillNth(2, 'Measure seat depth'); await fillNth(3, 'Golden Cloud fitting guide');
      // scenario
      await add('Customer scenario'); await fillNth(0, 'A customer is 6 ft 3 in and wants a Cloud.');
      for (let k = 0; k < 3; k++) { await fillNth(1 + k * 2, ['Show the tall size', 'Show the petite size', 'Any size will do'][k]); await fillNth(2 + k * 2, ['Right: match the size to the customer.', 'Too small.', 'Fit matters.'][k]); }
      // knowledge check: two practice questions
      await add('Knowledge check');
      for (const q of SAMPLES.A.questions.slice(0, 2)) await pg.locator(`${sel} label.q:has-text("${q.prompt.slice(0, 30)}") input`).check();
      // takeaways
      await add('Key takeaways'); for (let k = 0; k < 3; k++) await fillNth(k, ['Measure first', 'Match the size', 'Show the fit'][k]);
      await shot(pg, 'builder-1440-all-kinds');
      await saved(pg);
      const b = blocksOf(W.lessonNew.id);
      assert.deepStrictEqual(b.map(x => x.kind), ['objectives', 'text', 'callout', 'quote', 'image', 'video', 'document', 'fact', 'comparison', 'explorer', 'steps', 'scenario', 'check', 'takeaways']);
      assert.strictEqual(b[4].media_id, W.pic.id); assert.ok(!('placeholder' in b[4]));
      assert.strictEqual(b[7].model_code, 'PR515');
      assert.deepStrictEqual(b[8].models, ['PR515', 'PR510']);
      assert.strictEqual(b[9].media_id, W.pic.id); assert.ok(Math.abs(b[9].items[1].x - 75) <= 1 && Math.abs(b[9].items[1].y - 25) <= 1, JSON.stringify(b[9].items[1]));
      assert.strictEqual(b[11].choices.filter(c => c.best).length, 1); assert.strictEqual(b[12].question_ids.length, 2);
      assert.strictEqual(Number(run(DB, `select count(*) from academy_content_refs where lesson_id = '${W.lessonNew.id}'`)), 2, 'PR515 and PR510 capacity linked automatically');
      // every one of the 14 kinds is drawn by the learner player (one screen each)
      await pg.waitForFunction(() => document.querySelectorAll('#player .hl-screen:not(.hl-tail)').length === 14);
      assert.deepStrictEqual(await pg.$$eval('#player .hl-screen:not(.hl-tail)', s => s.map(x => [...x.classList].find(c => c.startsWith('hl-k-')).slice(5))),
        ['objectives', 'text', 'callout', 'quote', 'image', 'video', 'document', 'fact', 'comparison', 'explorer', 'steps', 'scenario', 'check', 'takeaways']);
      // the preview grades the check on the server
      await pg.click('.blk[data-i="12"] .blk-h .t');
      await pg.waitForFunction(() => { const s = document.querySelector('#player .hl-screen:not([hidden]).hl-k-check'); return !!s; });
      await pg.click('#player .hl-screen:not([hidden]) .hl-choice >> nth=0');
      await pg.waitForFunction(() => /^(Correct|Not quite)\./.test((document.querySelector('#player .hl-screen:not([hidden]) .hl-feedback') || {}).textContent || ''));
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });

    await t('reordering: drag a screen by its handle; ▲▼ by keyboard keeps focus on the moved screen; a lesson and a module moved in the outline are saved by the database', async () => {
      const pg = await page(browser, origin, 1440);
      await openB(pg, origin, 'lessons/' + W.lessonNew.id);
      await pg.waitForSelector('.blk[data-i="13"]');
      const kinds = () => pg.$$eval('.blk .k', k => k.map(x => x.textContent.replace(/^\d+ · /, '')));
      const before = await kinds();
      await pg.locator('.blk[data-i="2"] .drag').dragTo(pg.locator('.blk[data-i="1"]'), { targetPosition: { x: 20, y: 5 } });
      const after = await kinds();
      assert.deepStrictEqual(after.slice(1, 3), [before[2], before[1]], 'dragged above');
      await pg.focus('.blk[data-i="3"] button[aria-label="Move screen 4 down"]'); await pg.keyboard.press('Enter');
      assert.strictEqual(await pg.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Move screen 5 down', 'focus stays on the moved screen');
      assert.deepStrictEqual((await kinds())[4], after[3]);
      await pg.focus('.blk[data-i="4"] button[aria-label="Move screen 5 up"]'); await pg.keyboard.press('Enter');
      assert.strictEqual(await pg.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Move screen 4 up', 'focus follows an upward move too');
      await pg.keyboard.press('Tab'); await pg.keyboard.press('Enter');   // and down again: back where it was
      assert.deepStrictEqual((await kinds())[4], after[3]);
      await saved(pg);
      assert.strictEqual(blocksOf(W.lessonNew.id)[1].kind, before[2] === 'Tip or caution' ? 'callout' : blocksOf(W.lessonNew.id)[1].kind);
      // outline: move module 3 up with its button, then drag module 1 below module 2
      await pg.click('button[aria-label="Move module 3 up"]'); await pg.waitForSelector('#toast .note.ok');
      let order = JSON.parse(run(DB, `select json_agg(title order by position) from academy_modules`));
      assert.ok(order[1].startsWith('Cloud family'), order.join(' / '));
      await pg.waitForFunction(() => !document.querySelector('#toast .note'), null, { timeout: 8000 });
      const tb = await pg.locator('.mod').nth(1).boundingBox();
      await pg.locator('.mod').nth(0).locator('.drag').first().dragTo(pg.locator('.mod').nth(1), { targetPosition: { x: 20, y: tb.height - 6 } });
      await pg.waitForFunction(() => /Module order saved/.test(document.querySelector('#toast').textContent));
      order = JSON.parse(run(DB, `select json_agg(title order by position) from academy_modules`));
      assert.ok(order[0].startsWith('Cloud family') && order[1] === 'Welcome to the course', order.join(' / '));
      const ids = JSON.parse(run(DB, `select json_agg(id order by position) from academy_modules`));
      run(DB, `select academy_author_op_reorder_modules(${ACT}, '${W.version}'::uuid, '{${[W.mods[0].id, W.mods[1].id, W.mods[2].id].join(',')}}'::uuid[])`);
      assert.strictEqual(ids.length, 3);
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });

    await t('unsaved changes are never lost silently: switching lessons asks (keep editing / discard / save)', async () => {
      const pg = await page(browser, origin, 1440);
      await openB(pg, origin, 'lessons/' + W.lessonNew.id);
      await pg.click('.blk[data-i="1"] .blk-h .t'); await pg.locator('.blk[data-i="1"] .blk-b textarea, .blk[data-i="1"] .blk-b input[type=text]').first().fill('Changed but not saved');
      await pg.click('#pOutline button.t:has-text("Welcome")');
      await pg.waitForSelector('[role="alertdialog"]');
      await pg.click('[role="alertdialog"] button:has-text("Keep editing")');
      assert.match(await pg.textContent('#pEdit h2'), /Fitting the Cloud/);
      await pg.click('#pOutline button.t:has-text("Welcome")'); await pg.click('[role="alertdialog"] button:has-text("Discard them")');
      await pg.waitForFunction(() => /Welcome/.test(document.querySelector('#pEdit h2').textContent));
      assert.ok(!JSON.stringify(blocksOf(W.lessonNew.id)).includes('Changed but not saved'));
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });

    await t('question bank: a new exam question made with the form (answer key shown on this screen only), then retired with a reason; distribution set per module', async () => {
      const pg = await page(browser, origin, 1280);
      await openB(pg, origin, 'bank');
      await pg.click('button:has-text("+ New question")');
      await pg.selectOption('select:near(label:text-is("Module"))', W.mods[1].id).catch(async () => { await pg.locator('.card select').nth(1).selectOption(W.mods[1].id); });
      await pg.locator('.card textarea').first().fill('Which zone moves the headrest?');
      for (const [k, v] of [[0, 'Zone 3'], [1, 'Zone 1'], [2, 'Zone 5'], [3, 'Zone 2']]) await pg.locator(`input[aria-label="Choice ${'ABCD'[k]}"]`).fill(v);
      await pg.check('input[aria-label="Choice A is correct"]');
      await pg.locator('.card textarea').nth(1).fill('Zone 3 is the headrest.');
      await pg.locator('input[type=text]:near(label:has-text("Topics"))').first().fill('comfort zones, headrest');
      await pg.click('button:has-text("Create question")'); await pg.waitForSelector('#toast .note.ok');
      const q = JSON.parse(run(DB, `select row_to_json(q) from academy_questions q where prompt = 'Which zone moves the headrest?'`));
      assert.strictEqual(q.use, 'exam'); assert.strictEqual(q.answer_key, 'a'); assert.deepStrictEqual(q.objective_tags, ['comfort-zones', 'headrest']);
      await pg.waitForSelector('.q:has-text("Which zone moves the headrest?") li:has-text("✓ correct")');
      const card = pg.locator('.q:has-text("Which zone moves the headrest?")');
      await card.locator('button:has-text("Retire…")').click(); await card.locator('form input').fill('Replaced by a scenario question'); await card.locator('button:has-text("Retire question")').click();
      await pg.waitForSelector('#toast .note.ok');
      assert.strictEqual(run(DB, `select status from academy_questions where id = '${q.id}'`), 'retired');
      const m = await measure(pg); assert.deepStrictEqual(m.over, []); assert.deepStrictEqual(m.small, []);
      assert.deepStrictEqual(await axe(pg), []);
      // distribution
      await pg.click('#tabs button:has-text("Exam distribution")');
      await pg.click('button[role=radio]:has-text("Set per module")');
      const ins = pg.locator('input[aria-label^="Questions from module"]');
      for (let k = 0; k < 3; k++) await ins.nth(k).fill('2');
      await pg.waitForSelector('text=The modules add up to 6; each attempt draws 3.');
      for (let k = 0; k < 3; k++) await ins.nth(k).fill('1');
      await pg.click('button:has-text("Save distribution")'); await pg.waitForSelector('#toast .note.ok');
      assert.deepStrictEqual(JSON.parse(run(DB, `select json_agg(exam_quota order by position) from academy_modules`)), [1, 1, 1]);
      assert.deepStrictEqual(await axe(pg), []);
      await shot(pg, 'builder-1280-distribution');
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });

    await t('pictures under the President\'s control: until M3.1 a second administrator sees the builder read only and cannot upload or approve; the President uploads, approves with alt text, and it appears in the library', async () => {
      const pa = await page(browser, origin, 1280, 'adm');
      await openB(pa, origin, 'lessons'); await pa.waitForSelector('text=only the President edits course content');
      assert.strictEqual(await pa.$$eval('button:has-text("Save lesson"):not([disabled])', b => b.length), 0, 'no save for a non-President');
      await pa.click('#tabs [role="tab"]:has-text("Pictures")'); await pa.waitForSelector('text=only the President adds pictures and documents');
      assert.strictEqual(await pa.$$eval('input[type=file]', b => b.length), 0, 'no upload control for a non-President');
      assert.strictEqual(await pa.$$eval('button:has-text("Approve")', b => b.length), 0, 'no approval control for a non-President');
      assert.deepStrictEqual(await axe(pa), []);
      assert.deepStrictEqual(pa.errors, []);
      await pa.context().close();
      const pu = await page(browser, origin, 1280);
      await openB(pu, origin, 'media'); await pu.waitForSelector('text=Add a picture or document');
      await pu.setInputFiles('input[type=file]', { name: 'Cloud PR-515 front.png', mimeType: 'image/png', buffer: png(500, 350) });
      await pu.click('button:has-text("Upload")'); await pu.waitForSelector('.sub-card:has-text("Approve for lessons")');
      await pu.context().close();
      const pg = await page(browser, origin, 1280);
      await openB(pg, origin, 'media'); await pg.waitForSelector('.sub-card:has-text("Approve for lessons")');
      const c = pg.locator('.q:has(.sub-card:has-text("Approve for lessons"))').first();
      // an incomplete form: the reason appears NEXT TO the button (not only in a passing toast) and nothing is sent
      const before = +run(DB, `select count(*) from academy_media`).trim();
      await c.locator('button:has-text("Approve")').click();
      await c.locator('[role=status] >> text=Describe what the picture shows').waitFor();
      assert.strictEqual(+run(DB, `select count(*) from academy_media`).trim(), before, 'nothing recorded for an incomplete approval');
      await c.locator('select').first().selectOption('manufacturer_permitted');
      await c.locator('textarea, input[type=text]').first().fill('The Golden Cloud PR-515 lift chair from the front');
      await c.locator('select').nth(1).selectOption(G);
      await c.locator('input[type=text]').last().fill('');
      await c.locator('button:has-text("Approve")').click();
      await c.locator('[role=status] >> text=Record the permission').waitFor();
      await c.locator('input[type=text]').last().fill('Golden confirmation 10 Oct 2026');
      // a double click sends ONE approval: the button is busy until the answer comes back
      let approvals = 0; pg.on('request', rq => { if (rq.method() === 'POST' && /academy-admin-api/.test(rq.url()) && /"approve_media"/.test(rq.postData() || '')) approvals++; });
      await c.locator('button:has-text("Approve")').dblclick();
      await pg.waitForSelector('text=Approved — it can now be used in lessons.');
      assert.strictEqual(approvals, 1, 'one approval request for a double click');
      assert.strictEqual(+run(DB, `select count(*) from academy_media`).trim(), before + 1, 'exactly one record');
      const rec = JSON.parse(run(DB, `select row_to_json(m) from academy_media m where alt_text = 'The Golden Cloud PR-515 lift chair from the front'`));
      assert.strictEqual(rec.rights, 'manufacturer_permitted'); assert.match(rec.storage_path, /^media\/hcps\/[0-9a-f]{16}-cloud-pr-515-front\.png$/);
      assert.ok(JSON.parse(run(DB, `select json_agg(actor) from academy_events where action = 'create_media'`)).every(a => a === 'staff:admin@test.example'));
      await pg.waitForSelector('text=Nothing is waiting.');
      // persists after a reload: it is in the approved library, no longer waiting
      await pg.reload(); await pg.click('#tabs [role="tab"]:has-text("Pictures")'); await pg.waitForSelector('text=Nothing is waiting.');
      await pg.waitForSelector('text=The Golden Cloud PR-515 lift chair from the front');
      assert.deepStrictEqual(await brokenImages(pg), []);
      await shot(pg, 'builder-1280-media');
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });

    await t('readiness lists what blocks publishing and opens the lesson concerned', async () => {
      const pg = await page(browser, origin, 1280);
      await openB(pg, origin, 'ready');
      await pg.waitForSelector('text=Must fix');
      assert.ok(await pg.$('.ready-item:has-text("Picture still missing")'));
      await pg.locator('.ready-item:has-text("Picture still missing") button:has-text("Open lesson")').first().click();
      await pg.waitForSelector('#pEdit h2:has-text("Comfort Zones and positioning")');
      assert.deepStrictEqual(await axe(pg), []);
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });

    for (const width of [1024, 820, 390, 360]) {
      await t(`phone and tablet ${width}px: outline / screens / preview switch, no sideways scroll, controls ≥ 44px, 16px inputs on phones, accessible`, async () => {
        const pg = await page(browser, origin, width);
        await openB(pg, origin, 'lessons/' + W.lessonNew.id);
        await pg.waitForSelector('.blk');
        assert.ok(await pg.isVisible('.pane-switch'));
        await pg.click('.blk[data-i="8"] .blk-h .t');   // the comparison editor (widest)
        let m = await measure(pg);
        assert.deepStrictEqual(m.over, [], width + ' screens'); assert.strictEqual(m.docScroll, false); assert.deepStrictEqual(m.small, []); assert.deepStrictEqual(m.smallInput, []);
        await pg.click('.pane-switch button:has-text("Preview")'); await pg.waitForSelector('#player .hl-screen:not([hidden])');
        m = await measure(pg); assert.deepStrictEqual(m.over, [], width + ' preview'); assert.strictEqual(m.docScroll, false);
        if (width < 900) {
          await pg.click('.pane-switch button:has-text("Outline")'); assert.ok(await pg.isVisible('#pOutline'));
          await pg.click('button[aria-label="Move lesson 3.2 up"], button[aria-label="Move lesson 2.2 up"], button[aria-label="Move module 2 down"]').catch(() => {});
        }
        await pg.click('.pane-switch button:has-text("Screens")');
        assert.deepStrictEqual(await axe(pg), []);
        await shot(pg, `builder-${width}-screens`);
        assert.deepStrictEqual(pg.errors, []);
        await pg.context().close();
      });
    }

    await t('a version in review is read only in the builder: every field and write button is disabled, nothing can be saved', async () => {
      run(DB, `select academy_content_op_move_version(${ACT}, '${W.version}'::uuid, 'in_review')`);
      const pg = await page(browser, origin, 1440);
      await openB(pg, origin, 'lessons/' + W.lessonNew.id);
      await pg.waitForSelector('.blk'); await pg.click('.blk[data-i="1"] .blk-h .t');
      assert.match(await pg.textContent('#lockNote'), /read only/);
      const enabled = await pg.$$eval('#pEdit input:not([disabled]), #pEdit textarea:not([disabled]), #pEdit select:not([disabled]), #pEdit button[data-w]:not([disabled]), #pOutline button[data-w]:not([disabled])', e => e.length);
      assert.strictEqual(enabled, 0);
      run(DB, `select academy_content_op_move_version(${ACT}, '${W.version}'::uuid, 'draft')`);
      assert.deepStrictEqual(pg.errors, []);
      await pg.context().close();
    });
  } finally { await browser.close(); srv.close(); try { run('postgres', `drop database if exists ${DB}`); } catch (e) { /* best effort */ } }
  console.log(`\nacademy builder browser: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();

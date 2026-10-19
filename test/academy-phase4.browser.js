/* HCPS Academy — Phase 4: the whole learner journey in a real browser (Chromium) against the REAL learner API, the REAL
   admin API, the REAL public verification and the REAL database rules (A1, M1–M7 on a local Postgres), served with the
   SAME /academy/* security headers as netlify.toml (strict CSP, no inline script).
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… PLAYWRIGHT_MODULE=…/playwright AXE=…/axe.min.js SHOTS=/tmp/shots \
       node test/academy-phase4.browser.js
   Journey: a Partner 360 dealer user enters through the handoff (iPhone width) → the Training Manager enrolls him
   (Android width) → he works through every lesson (practice check graded on the server, Mark lesson complete) → the
   exam opens only then → a failed attempt shows the cooldown → after the cooldown a second attempt: autosave, a lost
   connection, a reload that resumes the same attempt and clock → pass → HCPS certificate → print view → public
   verification → the Training Manager sees passed + certificate (no score) → the President sees it in the Command
   Center API. Key screens at 360 / 390 / 768 / 1280, axe at 1280, no CSP violation, no script error, no sideways
   scroll, ≥44 px targets. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { shim, BASE } = require('./academy-pgrest.js');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PSQL = process.env.PGTEST_PSQL || 'psql';
const SUP = f => path.join(__dirname, '..', 'supabase', f);
const SRC = path.join(__dirname, '..', 'src');
const SHOTS = process.env.SHOTS || null, AXE = process.env.AXE || null;
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const psql = (db, args) => spawnSync(PSQL, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db].concat(args), { encoding: 'utf8' });
const run = (db, sql) => { const r = psql(db, ['-c', sql]); if (r.error || r.status !== 0) throw new Error((r.error && r.error.message) || r.stderr); return r.stdout.trim(); };
const file = (db, f) => { const r = psql(db, ['-f', f]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
try { run('postgres', 'select 1'); } catch (e) { console.log('SKIP: no Postgres'); process.exit(0); }
const NO_SAFEUPDATE = process.env.PGTEST_NO_SAFEUPDATE === '1';
const J = v => `$j$${JSON.stringify(v)}$j$::jsonb`;
const PRES = `'staff:admin@test.example'`;
const HQ = '00000000-0000-0000-0000-0000000000a1', NORTH = '00000000-0000-0000-0000-0000000000a2';
const DUID = '00000000-0000-0000-0000-00000000dddd';
const CSP = (fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8').match(/for = "\/academy\/\*"[\s\S]*?Content-Security-Policy = "([^"]+)"/) || [])[1];
if (!CSP) { console.log('FAIL: the /academy/* CSP was not found in netlify.toml'); process.exit(1); }

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n       ')); } }

/* ------------------------------------------------------------------ database */
const DB = 'academy_ph4_ui_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
let fx = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) fx = fx.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, '');
run(DB, fx);
run(DB, `alter table public.dealers add column is_test boolean not null default false;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
         insert into auth.users (id, email) values ('${DUID}', 'buyer@hqmed.example');
         insert into public.dealer_users values ('${DUID}', 'buyer@hqmed.example', '${HQ}', 'approved');`);
file(DB, SUP('academy_a1_foundation.sql')); run(DB, 'grant all on all tables in schema public to service_role');
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql', 'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql', 'academy_a2e_m6_exam_attempts.sql', 'academy_a2f_m7_certificates.sql']) file(DB, SUP(f));
run(DB, `insert into app_settings (key, value) values ('phase2_flags', ${J({ academy_admin: true, academy_learner: true, academy_open: true, academy_invites: true, academy_handoff: true, academy_exams: true, academy_certificates: true })}) on conflict (key) do update set value = excluded.value`);
const id = q => JSON.parse(run(DB, q)).id;
const C = id(`select academy_content_op_create_course(${PRES}, null, ${J({ slug: 'golden-lift-chair-sales', title: 'Golden Lift Chair Sales Certification', course_type: 'hcps_certification', manufacturer_slug: 'golden-technologies' })})`);
const V = id(`select academy_content_op_create_version(${PRES}, null, '${C}', '{"exam_questions":1}')`);
const M1 = id(`select academy_content_op_create_module(${PRES}, null, '${V}', ${J({ title: 'Welcome to the course' })})`);
id(`select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M1, kind: 'single', use: 'exam', prompt: 'Exam?', choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], answer_key: 'a', explanation: 'x', objective_tags: ['t'] })})`);
const P1 = id(`select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M1, kind: 'single', use: 'practice', prompt: 'Who issues the HCPS certificate?', choices: [{ id: 'a', text: 'HCPS' }, { id: 'b', text: 'Golden' }], answer_key: 'a', explanation: 'HCPS issues it; it is not a Golden credential.', objective_tags: ['t'] })})`);
const P2 = id(`select academy_author_op_create_question(${PRES}, null, '${V}', ${J({ module_id: M1, kind: 'single', use: 'practice', prompt: 'How long is it valid?', choices: [{ id: 'a', text: '12 months' }, { id: 'b', text: 'Forever' }], answer_key: 'a', explanation: '12 months.', objective_tags: ['t'] })})`);
const L1 = id(`select academy_content_op_create_lesson(${PRES}, null, '${M1}', ${J({ title: 'Welcome and how certification works', est_minutes: 8 })})`);
const L2 = id(`select academy_content_op_create_lesson(${PRES}, null, '${M1}', ${J({ title: 'Who Golden is', est_minutes: 10 })})`);
run(DB, `select academy_author_op_set_blocks(${PRES}, '${L1}', ${J([{ kind: 'text', heading: 'Welcome', body: 'Welcome to the Golden Lift Chair Sales Certification.' }, { kind: 'check', question_ids: [P1, P2] }, { kind: 'text', heading: 'Next', body: 'Next you will meet Golden.' }])})`);
run(DB, `select academy_author_op_set_blocks(${PRES}, '${L2}', ${J([{ kind: 'text', heading: 'Golden', body: 'Golden Technologies makes lift chairs.' }])})`);
run(DB, `select academy_content_op_move_version(${PRES}, '${V}', 'in_review')`); run(DB, `select academy_publish_op_publish_version(${PRES}, '${V}', null)`);
run(DB, `select academy_access_op_invite(${PRES}, '${HQ}', 'tm@hqmed.example', 'Terry Manager', 'training_manager')`);

/* ------------------------------------------------------------------ server */
const mails = [];
const S = shim({ db: DB, psql: PSQL, tokens: { pres: 'admin@test.example', buyer: { id: DUID, email: 'buyer@hqmed.example' } },
  passthrough: async (url, o) => { if (String(url) === 'https://api.resend.com/emails') { mails.push(JSON.parse(o.body)); return new Response('{}', { status: 200 }); } if (String(url).endsWith('/.netlify/functions/academy-mail-background')) { await require('../netlify/functions/academy-mail-background.js').handler({ httpMethod: 'POST', body: o.body }); return new Response(null, { status: 202 }); } return new Response('{}', { status: 599 }); } });
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = process.env.ACADEMY_SIGNIN_FLOOR_MS || '40'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-api.js');
const VERIFY = require('../netlify/functions/academy-verify.js');
const HAND = require('../netlify/functions/academy-handoff.js');
const ADMIN = require('../netlify/functions/academy-admin-api.js');
const A = require('../netlify/functions/_academy.js');
let ORIGIN = null;
A.SITE_ORIGINS.push('http://127.0.0.1:0');   // replaced below with the real port
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }   // the live site has its own
  if (u.pathname.startsWith('/.netlify/functions/academy-api')) {
    let body = ''; for await (const c of req) body += c;
    const out = await API.handler({ httpMethod: req.method, headers: req.headers, body, queryStringParameters: Object.fromEntries(u.searchParams) });
    if (process.env.DEBUG && /save_progress/.test(body)) console.log('DEBUG', body, out.statusCode, out.body);
    const h = Object.assign({}, out.headers); if (out.multiValueHeaders && out.multiValueHeaders['set-cookie']) h['set-cookie'] = out.multiValueHeaders['set-cookie'];
    res.writeHead(out.statusCode, h); res.end(out.body); return;
  }
  if (u.pathname.startsWith('/.netlify/functions/academy-verify')) {
    const out = await VERIFY.handler({ httpMethod: req.method, headers: req.headers, body: '', queryStringParameters: Object.fromEntries(u.searchParams) });
    res.writeHead(out.statusCode, out.headers); res.end(out.body); return;
  }
  let f = null;
  if (u.pathname === '/academy/' || u.pathname === '/academy/index.html') f = path.join(SRC, 'academy', 'index.html');
  else if (u.pathname === '/academy/verify/') f = path.join(SRC, 'academy', 'verify', 'index.html');
  else if (u.pathname === '/academy/verify/verify.js') f = path.join(SRC, 'academy', 'verify', 'verify.js');
  else if (/^\/academy\/[a-z.-]+\.(js|css)$/.test(u.pathname)) f = path.join(SRC, u.pathname);
  else if (/^\/assets\/academy\/[a-z.-]+\.(js|css)$/.test(u.pathname)) f = path.join(SRC, u.pathname);
  if (!f || !fs.existsSync(f)) { res.writeHead(404); res.end('no'); return; }
  const headers = { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' };
  if (u.pathname.startsWith('/academy/')) Object.assign(headers, { 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  res.writeHead(200, headers); res.end(fs.readFileSync(f));
});

async function page(browser, width, opts) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, bypassCSP: !!(opts && opts.bypassCSP) });
  const pg = await ctx.newPage(); pg.errors = [];
  pg.on('pageerror', e => pg.errors.push(String(e)));
  // a 401 is the normal answer before sign-in (the browser logs it); anything else is a real error
  pg.on('console', m => { if ((m.type() === 'error' && !/status of 401/.test(m.text())) || /Content Security Policy/i.test(m.text())) pg.errors.push(m.text()); });
  return pg;
}
const noSideScroll = pg => pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const smallTargets = pg => pg.evaluate(() => [...document.querySelectorAll('button, a[href], input, select')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height && r.height < 44 && r.right > 0 && !e.closest('.hl') && !e.closest('.ac-choice'); }).map(e => e.outerHTML.slice(0, 80)));
async function axe(pg) {
  if (!AXE) return [];
  await pg.addScriptTag({ path: AXE });
  return pg.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map(v => v.id + ': ' + v.nodes.slice(0, 3).map(n => n.target.join(' ')).join('; ')); });
}
const shot = async (pg, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
const codeFor = to => { const m = mails.filter(x => x.to[0] === to).pop(); return m ? m.subject.slice(0, 6) : null; };
async function signIn(pg, email) {
  await pg.goto(ORIGIN + '/academy/'); await pg.waitForSelector('#em');
  await pg.fill('#em', email); await pg.click('button[type=submit]'); await pg.waitForSelector('#cd');
  await pg.fill('#cd', codeFor(email)); await pg.click('button[type=submit]');
}



run(DB, `select academy_access_op_invite(${PRES}, '${HQ}', 'tm@hqmed.example', 'Terry Manager', 'training_manager')`);
const clean = pg => pg.errors.filter(e => !/favicon|status of 40[0349]|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(e));   // the offline step is deliberate
const check = async (pg, name, ax) => {
  assert.ok(await noSideScroll(pg), name + ': sideways scroll'); assert.deepStrictEqual(await smallTargets(pg), [], name + ': small targets');
  if (ax) assert.deepStrictEqual(await axe(pg), [], name + ': axe'); await shot(pg, name);
};
async function walkLesson(pg) {   // every screen shown for a moment, each practice question answered, then Mark lesson complete
  await pg.waitForSelector('.hl');
  for (let i = 0; i < 8; i++) {
    await pg.waitForTimeout(900);
    const scr = pg.locator('.hl-screen:visible');
    if (await scr.locator('.hl-qbox').count()) {
      for (let q = 0; q < 4; q++) {
        for (const ans of ['HCPS', '12 months']) { const c = scr.locator(`.hl-choice:text-is("${ans}")`); if (await c.count()) { await c.click(); await pg.waitForTimeout(500); } }
        const nq = scr.locator('button:text-is("Next question")'); if (!(await nq.count()) || await nq.isDisabled()) break; await nq.click(); await pg.waitForTimeout(300);
      }
    }
    if ((await pg.textContent('.hl-next')).trim() === 'Finish') break;
    await pg.click('.hl-next');
  }
  await pg.waitForSelector('.hl-complete-btn:not([disabled])', { timeout: 8000 });
  await pg.click('.hl-complete-btn'); await pg.waitForSelector('text=Lesson complete.'); await pg.waitForTimeout(800);
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  ORIGIN = 'http://127.0.0.1:' + server.address().port; A.SITE_ORIGINS.pop(); A.SITE_ORIGINS.push(ORIGIN);
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  let buyer = null, BID = null, ENR = null, CERT = null;
  try {
    await t('1 · Partner 360 handoff (iPhone 390): the dealer user lands signed in; the code leaves the address bar at once', async () => {
      const m = await HAND.handler({ httpMethod: 'POST', headers: { origin: 'https://hcpsonlineordering.netlify.app', authorization: 'Bearer buyer' }, body: '{"action":"mint"}' });
      const code = JSON.parse(m.body).url.split('#handoff=')[1];
      buyer = await page(browser, 390); await buyer.goto(ORIGIN + '/academy/#handoff=' + code); await buyer.waitForSelector('text=No courses yet');
      assert.strictEqual(new URL(buyer.url()).hash, ''); BID = run(DB, `select id from academy_learners where email = 'buyer@hqmed.example'`);
      await check(buyer, 'p4-390-no-courses');
    });
    await t('2 · The Training Manager (Android 360) signs in with an emailed code and enrolls him from My team', async () => {
      const tm = await page(browser, 360); await signIn(tm, 'tm@hqmed.example'); await tm.waitForSelector('text=Hello, Terry Manager');
      await tm.click('nav >> text=My team'); await tm.waitForSelector('.ac-person:has-text("buyer@hqmed.example")');
      await tm.click('.ac-person:has-text("buyer@hqmed.example") >> text=Enroll in a course');
      await tm.click('.ac-person:has-text("buyer@hqmed.example") >> button:text-is("Enroll")'); await tm.waitForSelector('text=Enrolled.');
      await check(tm, 'p4-360-team-enrolled'); assert.deepStrictEqual(clean(tm), []); await tm.close();
      ENR = run(DB, `select id from academy_enrollments where learner_id = '${BID}'`);
    });
    await t('3 · The exam stays closed until every lesson is complete; he completes both lessons (practice check graded on the server)', async () => {
      await buyer.reload(); await buyer.waitForSelector('text=Golden Lift Chair Sales Certification');
      await buyer.click('.ac-course >> button:text-is("Final exam")'); await buyer.waitForSelector('text=/Finish every lesson first: 0 of 2/');
      assert.strictEqual(await buyer.locator('button:has-text("Start the exam")').count(), 0);
      await buyer.click('text=Back to my courses'); await buyer.click('.ac-course >> text=Start'); await walkLesson(buyer);
      await buyer.click('text=Next lesson'); await walkLesson(buyer);
      assert.strictEqual(run(DB, `select count(*) from academy_progress where enrollment_id = '${ENR}' and status = 'completed'`), '2');
      await buyer.click('text=← My courses'); await buyer.waitForSelector('text=2 of 2 lessons complete'); await check(buyer, 'p4-390-lessons-done');
    });
    await t('4 · A failed first attempt: graded, topics shown, then the cooldown — no second start', async () => {
      await buyer.click('.ac-course >> button:text-is("Final exam")'); await buyer.waitForSelector('button:has-text("Start the exam")'); await check(buyer, 'p4-390-exam-rules');
      await buyer.click('text=Start the exam'); await buyer.click('text=/Start now/'); await buyer.waitForSelector('text=Question 1 of 1');
      await buyer.click('.ac-choice:has-text("B")'); await buyer.waitForSelector('text=Saved');
      await buyer.click('text=Review and submit'); await buyer.click('text=Submit my answers'); await buyer.waitForSelector('text=Not passed this time');
      await buyer.click('text=Back to the exam page'); await buyer.waitForSelector('text=Take a short break before your next attempt.');
      assert.strictEqual(await buyer.locator('button:has-text("Start the exam")').count(), 0);
      await check(buyer, 'p4-390-cooldown');
    });
    await t('5 · After the cooldown: autosave, a lost connection and a reload resume the SAME attempt and clock; pass → HCPS certificate', async () => {
      // test only: move the first attempt 2 hours back (attempts are immutable to everyone else)
      run(DB, `begin; set local session_replication_role = replica; update academy_attempts set started_at = started_at - interval '2 hours', expires_at = expires_at - interval '2 hours', submitted_at = submitted_at - interval '2 hours', graded_at = graded_at - interval '2 hours' where enrollment_id = '${ENR}'; commit;`);
      await buyer.reload(); await buyer.waitForSelector('button:has-text("Start the exam")');
      await buyer.click('text=Start the exam'); await buyer.click('text=/Start now/'); await buyer.waitForSelector('text=Question 1 of 1');
      const deadline = run(DB, `select expires_at from academy_attempts where enrollment_id = '${ENR}' and submitted_at is null`);
      await buyer.context().setOffline(true); await buyer.click('.ac-choice:has-text("A")'); await buyer.waitForSelector('text=/offline|Connection lost/');
      await shot(buyer, 'p4-390-offline');
      await buyer.context().setOffline(false); await buyer.waitForSelector('text=Saved', { timeout: 15000 });
      await buyer.reload(); await buyer.waitForSelector('text=Question 1 of 1');
      assert.ok(await buyer.isChecked('.ac-choice:has-text("A") input'), 'the saved answer came back');
      assert.strictEqual(run(DB, `select expires_at from academy_attempts where enrollment_id = '${ENR}' and submitted_at is null`), deadline, 'the clock did not restart');
      await buyer.click('text=Review and submit'); await buyer.click('text=Submit my answers'); await buyer.waitForSelector('text=You passed');
      await buyer.waitForSelector('text=/you have earned your HCPS certificate for Golden Lift Chair Sales Certification \\(HCPS-/');
      CERT = run(DB, `select cert_number from academy_certificates where learner_id = '${BID}'`); assert.match(CERT, /^HCPS-/);
      await check(buyer, 'p4-390-passed');
    });
    await t('6 · The certificate: view, print layout, and public verification of its number', async () => {
      await buyer.click('text=View your certificate'); await buyer.waitForSelector('.ac-cert');
      const t1 = await buyer.textContent('.ac-cert');
      for (const s of [CERT, 'HQ Medical', 'Golden Lift Chair Sales Certification', 'not issued or endorsed by Golden Technologies']) assert.ok(t1.includes(s), s);
      await check(buyer, 'p4-390-certificate');
      await buyer.emulateMedia({ media: 'print' }); assert.strictEqual(await buyer.evaluate(() => getComputedStyle(document.querySelector('.ac-top')).display), 'none');
      await buyer.emulateMedia({ media: 'screen' });
      const v = await page(browser, 390); await v.goto(ORIGIN + '/academy/verify/#' + CERT); await v.waitForSelector('#vr >> text=Valid');
      assert.ok((await v.textContent('#vr')).includes('HQ Medical')); assert.deepStrictEqual(clean(v), []); await v.close();
      assert.deepStrictEqual(clean(buyer), []);
    });
    await t('7 · The Training Manager sees lessons 2/2, exam passed after 2 attempts and the certificate — never a score', async () => {
      run(DB, `delete from academy_login_codes where true`);
      const tm = await page(browser, 390); await signIn(tm, 'tm@hqmed.example'); await tm.waitForSelector('text=Hello, Terry Manager');
      await tm.click('nav >> text=My team'); await tm.waitForSelector('text=' + CERT);
      const txt = await tm.textContent('.ac-person:has-text("buyer@hqmed.example")');
      assert.ok(/2\/2 lessons · exam passed · HCPS certificate HCPS-[A-Z0-9-]+ valid until/.test(txt), txt);
      assert.ok(!/\d+%/.test(await tm.textContent('#view')), 'no score'); await check(tm, 'p4-390-team-certified'); await tm.close();
    });
    await t('8 · The President (Command Center API): the certificate is listed and counted; the activity trail holds the issue', async () => {
      const r = await ADMIN.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer pres', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list_certificates' }) });
      const b = JSON.parse(r.body); assert.strictEqual(r.statusCode, 200, r.body);
      assert.ok(b.certificates.some(c => c.cert_number === CERT && c.display_status === 'valid')); assert.strictEqual(b.summary.valid, 1);
      assert.strictEqual(run(DB, `select count(*) from academy_events where action = 'issue_certificate'`), '1');
    });
    await t('9 · Every key screen at 360 / 768 / 1280 (axe at 1280): courses, exam page, certificate, verification', async () => {
      for (const w of [360, 768, 1280]) {
        run(DB, `delete from academy_login_codes where true`);
        const m = await HAND.handler({ httpMethod: 'POST', headers: { origin: 'https://hcpsonlineordering.netlify.app', authorization: 'Bearer buyer' }, body: '{"action":"mint"}' });
        const pg = await page(browser, w, { bypassCSP: w === 1280 }); await pg.goto(ORIGIN + '/academy/#handoff=' + JSON.parse(m.body).url.split('#handoff=')[1]);
        await pg.waitForSelector('text=Golden Lift Chair Sales Certification'); await check(pg, `p4-${w}-courses`, w === 1280);
        await pg.click('.ac-course >> button:text-is("Final exam")'); await pg.waitForSelector('.ac-attempts'); await check(pg, `p4-${w}-exam`, w === 1280);
        await pg.click('nav >> text=My certificates'); await pg.click('text=View and print'); await pg.waitForSelector('.ac-cert'); await check(pg, `p4-${w}-cert`, w === 1280);
        await pg.goto(ORIGIN + '/academy/verify/#' + CERT); await pg.waitForSelector('#vr >> text=Valid'); await check(pg, `p4-${w}-verify`, w === 1280);
        assert.deepStrictEqual(clean(pg), [], 'errors at ' + w); await pg.close();
      }
    });
  } catch (e) { fail++; console.log('  FAIL setup\n       ' + String(e && e.stack || e)); }
  finally {
    await browser.close(); server.close();
    try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
    console.log(`\nacademy-phase4.browser: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();

/* HCPS Academy A2B — the learner pages in a real browser (Chromium) against the REAL learner API and the REAL database
   rules (A1, M1–M4, M5 on a local Postgres via test/academy-pgrest.js). The server sends /academy/* with the SAME
   security headers as netlify.toml (strict CSP: no inline script). Emails are captured locally; nothing leaves this
   machine.
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… PLAYWRIGHT_MODULE=…/playwright AXE=…/axe.min.js SHOTS=/tmp/shots \
       node test/academy-learner.browser.js
   Covers: email-code sign-in on a phone; my courses; a lesson in the shared player with practice checks graded on the
   server, progress saved and resumed after a reload; the Training Manager team page (invite, enroll); the Partner 360
   handoff link (the code leaves the address bar at once); sign-out; no CSP violation, no script error, no sideways
   scroll at 360 / 390 / 768 / 1280, touch targets ≥ 44 px, axe-core WCAG 2.2 A/AA clean. */
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
const DB = 'academy_learner_ui_' + process.pid;
run('postgres', `drop database if exists ${DB}`); run('postgres', `create database ${DB}`);
let fx = fs.readFileSync(path.join(__dirname, 'academy', 'fixture.sql'), 'utf8'); if (NO_SAFEUPDATE) fx = fx.replace(/^do \$\$ begin execute format\('alter database %I set session_preload_libraries.*$/m, '');
run(DB, fx);
run(DB, `alter table public.dealers add column is_test boolean not null default false;
         create table public.dealer_users (uid uuid primary key, email text, dealer_id uuid references public.dealers(id), status text);
         insert into auth.users (id, email) values ('${DUID}', 'buyer@hqmed.example');
         insert into public.dealer_users values ('${DUID}', 'buyer@hqmed.example', '${HQ}', 'approved');`);
file(DB, SUP('academy_a1_foundation.sql')); run(DB, 'grant all on all tables in schema public to service_role');
for (const f of ['academy_a2a_m1_audited_ops.sql', 'academy_a2c_m2_content_ops.sql', 'academy_a2d_m3_author_ops.sql', 'academy_a2d_m3_1_save_lesson.sql', 'academy_c2_m4_publish_ops.sql', 'academy_a2b_m5_learner_access.sql']) file(DB, SUP(f));
run(DB, `insert into app_settings (key, value) values ('phase2_flags', ${J({ academy_admin: true, academy_learner: true, academy_invites: true, academy_handoff: true })}) on conflict (key) do update set value = excluded.value`);
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
const S = shim({ db: DB, psql: PSQL, tokens: { buyer: { id: DUID, email: 'buyer@hqmed.example' } },
  passthrough: async (url, o) => { if (String(url) === 'https://api.resend.com/emails') { mails.push(JSON.parse(o.body)); return new Response('{}', { status: 200 }); } if (String(url).endsWith('/.netlify/functions/academy-mail-background')) { await require('../netlify/functions/academy-mail-background.js').handler({ httpMethod: 'POST', body: o.body }); return new Response(null, { status: 202 }); } return new Response('{}', { status: 599 }); } });
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = process.env.ACADEMY_SIGNIN_FLOOR_MS || '40'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-api.js');
const HAND = require('../netlify/functions/academy-handoff.js');
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
  let f = null;
  if (u.pathname === '/academy/' || u.pathname === '/academy/index.html') f = path.join(SRC, 'academy', 'index.html');
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
const smallTargets = pg => pg.evaluate(() => [...document.querySelectorAll('button, a[href], input, select')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height && r.height < 44 && r.right > 0 && !e.closest('.hl'); }).map(e => e.outerHTML.slice(0, 80)));
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

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  ORIGIN = 'http://127.0.0.1:' + server.address().port; A.SITE_ORIGINS.pop(); A.SITE_ORIGINS.push(ORIGIN);
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  try {
    let pat = null;
    await t('Phone 390: the Training Manager signs in with an emailed code (no password); strict CSP, no errors, no sideways scroll, ≥44 px targets', async () => {
      const pg = await page(browser, 390);
      await pg.goto(ORIGIN + '/academy/'); await pg.waitForSelector('#em'); await shot(pg, 'learner-390-signin');
      assert.ok(await noSideScroll(pg)); assert.deepStrictEqual(await smallTargets(pg), []);
      await pg.fill('#em', 'nobody@example.com'); await pg.click('button[type=submit]'); await pg.waitForSelector('#cd');
      assert.ok((await pg.textContent('#view')).includes('If this address can use the HCPS Academy'), 'the same answer for an unknown address');
      await signIn(pg, 'tm@hqmed.example'); await pg.waitForSelector('text=Hello, Terry Manager');
      assert.ok(await pg.isVisible('text=My team')); await shot(pg, 'learner-390-courses-empty');
      const cookies = await pg.context().cookies(); const c = cookies.find(x => x.name === '__Host-hcps_academy');
      assert.ok(c && c.httpOnly && c.secure && c.sameSite === 'Strict', JSON.stringify(c));
      assert.strictEqual(await pg.evaluate(() => document.cookie), '', 'page script cannot read the session');
      assert.deepStrictEqual(pg.errors, []);
      // My team: invite an employee of the branch, then she signs in, then she is enrolled
      await pg.click('text=My team'); await pg.waitForSelector('#iem');
      await pg.fill('#iem', 'pat@north.example'); await pg.fill('#inm', 'Pat Learner'); await pg.selectOption('#ids', NORTH);
      await pg.click('text=Send invitation'); await pg.waitForSelector('text=Invitation sent.');
      assert.ok(await noSideScroll(pg)); assert.deepStrictEqual(await smallTargets(pg), []); await shot(pg, 'learner-390-team');
      assert.deepStrictEqual(pg.errors, []);
      pat = pg;
    });
    await t('Phone 360: the invited employee signs in; the Training Manager enrolls her; she opens the course, answers a practice check (graded by the server) and her progress is saved and resumed after a reload', async () => {
      const pg = await page(browser, 360);
      await signIn(pg, 'pat@north.example'); await pg.waitForSelector('text=No courses yet');
      assert.ok(!(await pg.isVisible('text=My team')), 'no Training Manager tools');
      await pat.reload(); await pat.click('text=My team'); await pat.waitForSelector('text=Pat Learner');
      await pat.click('.ac-person:has-text("Pat Learner") >> text=Enroll in a course'); await pat.click('.ac-person:has-text("Pat Learner") >> button:text-is("Enroll")');
      await pat.waitForSelector('text=Enrolled.');
      await pg.reload(); await pg.waitForSelector('text=Golden Lift Chair Sales Certification');
      assert.ok(await noSideScroll(pg)); assert.deepStrictEqual(await smallTargets(pg), []); await shot(pg, 'learner-360-courses');
      await pg.click('text=Start'); await pg.waitForSelector('.hl');
      const html = await pg.content(); assert.ok(!/answer_key|Exam\?/.test(html), 'no answer key and no exam question on the page');
      await pg.waitForTimeout(1000);   // a screen counts as read after it has been on screen for a moment (0.7 s)
      await pg.click('.hl-next'); await pg.waitForSelector('text=Who issues the HCPS certificate?');
      await pg.click('.hl-choice:text-is("HCPS")'); await pg.waitForSelector('text=HCPS issues it; it is not a Golden credential.');
      await pg.waitForTimeout(1500);
      const saved = Number(run(DB, `select coalesce(max(resume_block), -1) from academy_progress`));
      assert.ok(saved >= 1, 'the screen she reached is saved (resume ' + saved + ')');
      await pg.reload(); await pg.waitForSelector('.hl');
      await pg.waitForSelector('text=Who issues the HCPS certificate?');   // resumed on the screen she had reached, not the first
      assert.ok(await noSideScroll(pg)); await shot(pg, 'learner-360-lesson');
      assert.deepStrictEqual(pg.errors.filter(e => !/favicon/.test(e)), []);
      await pg.close();
    });
    await t('Desktop 1280 / tablet 768: courses and team render without sideways scroll; axe-core finds no WCAG 2.2 A/AA violation', async () => {
      for (const w of [1280, 768]) {
        const pg = await page(browser, w, { bypassCSP: true });   // bypassCSP only so axe can be injected
        await signIn(pg, 'tm@hqmed.example'); await pg.waitForSelector('text=Hello, Terry Manager');
        assert.ok(await noSideScroll(pg), 'courses ' + w); assert.deepStrictEqual(await axe(pg), [], 'axe courses ' + w);
        await pg.click('text=My team'); await pg.waitForSelector('text=Pat Learner');
        assert.ok(await noSideScroll(pg), 'team ' + w); assert.deepStrictEqual(await axe(pg), [], 'axe team ' + w);
        await shot(pg, `learner-${w}-team`); await pg.close();
      }
      const sp = await page(browser, 390, { bypassCSP: true }); await sp.goto(ORIGIN + '/academy/'); await sp.waitForSelector('#em');
      assert.deepStrictEqual(await axe(sp), [], 'axe sign-in'); await sp.close();
    });
    await t('Partner 360 handoff: the link signs the dealer user in, the code is removed from the address bar at once, and the same link never works twice', async () => {
      const m = await HAND.handler({ httpMethod: 'POST', headers: { origin: 'https://hcpsonlineordering.netlify.app', authorization: 'Bearer buyer' }, body: '{"action":"mint"}' });
      const url = JSON.parse(m.body).url; const code = url.split('#handoff=')[1];
      const pg = await page(browser, 390);
      await pg.goto(ORIGIN + '/academy/#handoff=' + code); await pg.waitForSelector('text=Hello, buyer');
      assert.strictEqual(new URL(pg.url()).hash, '', 'no code left in the address');
      const pg2 = await page(browser, 390); await pg2.goto(ORIGIN + '/academy/#handoff=' + code);
      await pg2.waitForSelector('text=expired or was already used'); await pg2.close();
      await pg.click('text=Sign out'); await pg.waitForSelector('text=You are signed out.');
      await pg.reload(); await pg.waitForSelector('#em');   // the session is gone, not just hidden
      assert.deepStrictEqual(pg.errors, []); await pg.close();
    });
  } finally {
    await browser.close(); server.close();
    try { run('postgres', `drop database if exists ${DB}`); } catch (e) { /* ignore */ }
    console.log(`\nacademy learner browser: ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
  }
})();

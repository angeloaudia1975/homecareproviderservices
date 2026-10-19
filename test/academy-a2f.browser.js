/* HCPS Academy A2F — HCPS certificates in a real browser (Chromium) against the REAL learner API, the REAL public
   verification function and the REAL database rules (A1, M1–M7 on a local Postgres via test/academy-pgrest.js), served
   with the SAME /academy/* security headers as netlify.toml (strict CSP, no inline script).
     PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… PLAYWRIGHT_MODULE=…/playwright AXE=…/axe.min.js SHOTS=/tmp/shots \
       node test/academy-a2f.browser.js
   Covers: My certificates and the printable certificate (HCPS issuer, the Golden disclosure, number, dates, verify
   address) at 360 / 390 / 768 / 1280 and in print media; the course card's certificate line; the Training Manager's
   view (number, validity, no score); the public verification page (valid, revoked, unknown, wrong format, a number in
   the address); no CSP violation, no script error, no sideways scroll, ≥44 px targets, axe-core WCAG 2.2 A/AA clean. */
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
const DB = 'academy_a2f_ui_' + process.pid;
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
const S = shim({ db: DB, psql: PSQL, tokens: { buyer: { id: DUID, email: 'buyer@hqmed.example' } },
  passthrough: async (url, o) => { if (String(url) === 'https://api.resend.com/emails') { mails.push(JSON.parse(o.body)); return new Response('{}', { status: 200 }); } if (String(url).endsWith('/.netlify/functions/academy-mail-background')) { await require('../netlify/functions/academy-mail-background.js').handler({ httpMethod: 'POST', body: o.body }); return new Response(null, { status: 202 }); } return new Response('{}', { status: 599 }); } });
process.env.SUPABASE_URL = BASE; process.env.SUPABASE_SERVICE_ROLE = 'svc-test-key';
process.env.ACADEMY_SESSION_SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz-0123';
process.env.RESEND_API_KEY = 're_test'; process.env.ACADEMY_SIGNIN_FLOOR_MS = process.env.ACADEMY_SIGNIN_FLOOR_MS || '40'; process.env.ACADEMY_MAIL_FROM = 'HCPS Academy <academy@test.example>';
global.fetch = S.fetch;
const API = require('../netlify/functions/academy-api.js');
const VERIFY = require('../netlify/functions/academy-verify.js');
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


// the people and the passed exams, made through the REAL operations (no browser needed for these)
const lid = email => run(DB, `select id from academy_learners where email = '${email}'`);
function learnerWithPass(email, name, dealer) {
  run(DB, `select academy_access_op_invite(${PRES}, '${dealer}', '${email}', '${name}', 'learner')`);
  const hx = v => require('crypto').createHash('sha256').update(v).digest('hex');
  run(DB, `select academy_access_op_request_code('${email}', '${hx('c' + email)}', '${hx('ip')}')`); run(DB, `select academy_access_op_verify_code('${email}', '${hx('c' + email)}', '${hx('ip')}')`);
  const L = lid(email), E = JSON.parse(run(DB, `select academy_enroll_op_enroll(${PRES}, '${L}', '${V}', null)`)).id;
  for (const l of [L1, L2]) run(DB, `select academy_progress_op_save('learner:${L}', '${E}', '${l}', 'completed', 0)`);
  const a = JSON.parse(run(DB, `select academy_exam_op_start('learner:${L}', '${E}')`)).attempt_id;
  const q = JSON.parse(run(DB, `select academy_exam_op_view('learner:${L}', '${a}')`)).questions[0].id;
  run(DB, `select academy_exam_op_submit('learner:${L}', '${a}', ${J({ [q]: 'a' })})`);
  return JSON.parse(run(DB, `select academy_cert_op_claim('learner:${L}', '${a}')`)).certificate;
}
const PAT = learnerWithPass('pat@north.example', 'Pat Learner', NORTH);
const REV = learnerWithPass('rev@hqmed.example', 'Rae Revoked', HQ);
run(DB, `select academy_cert_op_revoke(${PRES}, '${REV.id}', 'Issued in error')`);
run(DB, `delete from academy_login_codes where true`);   // test only: the browser sign-ins start fresh

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  ORIGIN = 'http://127.0.0.1:' + server.address().port; A.SITE_ORIGINS.pop(); A.SITE_ORIGINS.push(ORIGIN);
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  const clean = pg => pg.errors.filter(e => !/favicon|status of 40[04]/.test(e));
  try {
    await t('My certificates and the printable certificate at 360 / 390 / 768 / 1280: HCPS issuer, Golden disclosure, number, dates, verify address; no errors, no sideways scroll, ≥44 px', async () => {
      for (const w of [360, 390, 768, 1280]) {
        run(DB, `delete from academy_login_codes where true`);
        const pg = await page(browser, w); await signIn(pg, 'pat@north.example'); await pg.waitForSelector('text=Golden Lift Chair Sales Certification');
        assert.ok(await pg.isVisible('.ac-course >> text=/Valid until/'), 'the course card shows the certificate');
        await pg.click('nav >> text=My certificates'); await pg.waitForSelector('text=View and print');
        assert.ok((await pg.textContent('#view')).includes('not issued or endorsed by Golden Technologies'));
        assert.ok(await noSideScroll(pg)); assert.deepStrictEqual(await smallTargets(pg), []); await shot(pg, `cert-${w}-list`);
        await pg.click('text=View and print'); await pg.waitForSelector('.ac-cert');
        const txt = await pg.textContent('.ac-cert');
        for (const s of ['Certificate of Completion', 'Pat Learner', 'HQ Medical North', 'Golden Lift Chair Sales Certification', PAT.cert_number, '/academy/verify/#' + PAT.cert_number, 'Home Care Provider Services', 'not issued or endorsed by Golden Technologies'])
          assert.ok(txt.includes(s), s);
        assert.ok(!/\d+%/.test(txt), 'no score on the certificate');
        assert.ok(await noSideScroll(pg)); assert.deepStrictEqual(await smallTargets(pg), []); await shot(pg, `cert-${w}-certificate`);
        assert.deepStrictEqual(clean(pg), []); await pg.close();
      }
    });
    await t('Print media: one landscape page with only the certificate (no header, buttons or footer); axe clean on screen', async () => {
      run(DB, `delete from academy_login_codes where true`);
      const pg = await page(browser, 1280, { bypassCSP: true }); await signIn(pg, 'pat@north.example'); await pg.waitForSelector('text=Golden Lift Chair Sales Certification');
      await pg.evaluate(id => { location.hash = 'certificate?c=' + id; }, PAT.id); await pg.waitForSelector('.ac-cert');
      assert.deepStrictEqual(await axe(pg), [], 'axe certificate');
      await pg.emulateMedia({ media: 'print' });
      const hidden = await pg.evaluate(() => ['.ac-top', '.ac-foot', '.ac-noprint'].map(s => getComputedStyle(document.querySelector(s)).display));
      assert.deepStrictEqual(hidden, ['none', 'none', 'none']);
      if (SHOTS) await pg.pdf({ path: path.join(SHOTS, 'cert-print.pdf'), landscape: true, printBackground: true });
      const pdf = await pg.pdf({ landscape: true }); const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      assert.strictEqual(pages, 1, 'one printed page');
      await pg.close();
    });
    await t('Training Manager (390): the team line shows the HCPS certificate number and validity, never a score', async () => {
      run(DB, `select academy_access_op_invite(${PRES}, '${HQ}', 'tm@hqmed.example', 'Terry Manager', 'training_manager')`);
      run(DB, `delete from academy_login_codes where true`);
      const pg = await page(browser, 390); await signIn(pg, 'tm@hqmed.example'); await pg.waitForSelector('text=My team');
      await pg.click('nav >> text=My team'); await pg.waitForSelector('text=' + PAT.cert_number);
      const v = await pg.textContent('#view');
      assert.ok(v.includes('HCPS certificate ' + PAT.cert_number + ' valid until')); assert.ok(v.includes(REV.cert_number + ' revoked'));
      assert.ok(!/\d+%/.test(v)); assert.ok(await noSideScroll(pg)); await shot(pg, 'cert-390-team');
      assert.deepStrictEqual(clean(pg), []); await pg.close();
    });
    await t('Public verification page (390 + axe 1280): valid, revoked (no reason), unknown, wrong format, a number in the address; no sign-in, no errors', async () => {
      for (const w of [390, 1280]) {
        const pg = await page(browser, w, { bypassCSP: w === 1280 });
        await pg.goto(ORIGIN + '/academy/verify/#' + PAT.cert_number); await pg.waitForSelector('.ac-cert-facts');
        let v = await pg.textContent('#vr');
        for (const s of ['Valid', 'Pat Learner', 'HQ Medical North', 'Golden Lift Chair Sales Certification', 'Home Care Provider Services', 'not issued or endorsed by Golden']) assert.ok(v.includes(s), s);
        assert.ok(!/@/.test(v));
        if (w === 1280) assert.deepStrictEqual(await axe(pg), [], 'axe verify');
        assert.ok(await noSideScroll(pg)); assert.deepStrictEqual(await smallTargets(pg), []); await shot(pg, `verify-${w}-valid`);
        await pg.fill('#vn', REV.cert_number.toLowerCase().replace(/-/g, ' ')); await pg.click('#vf button'); await pg.waitForSelector('#vr >> text=Revoked');
        v = await pg.textContent('#vr'); assert.ok(!/error/i.test(v), 'no reason shown'); await shot(pg, `verify-${w}-revoked`);
        await pg.fill('#vn', 'HCPS-ZZZZ-ZZZZ'); await pg.click('#vf button'); await pg.waitForSelector('text=No HCPS certificate has that number.');
        await pg.fill('#vn', 'hello'); await pg.click('#vf button'); await pg.waitForSelector('text=A certificate number looks like HCPS-ABCD-2345.');
        assert.deepStrictEqual(clean(pg), []); await pg.close();
      }
    });
  } catch (e) { fail++; console.log('  FAIL setup\n       ' + String(e && e.stack || e)); }
  finally {
    await browser.close(); server.close();
    try { run('postgres', `drop database if exists ${DB}`); } catch (e) {}
    console.log(`\nacademy-a2f.browser: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();

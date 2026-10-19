/* Dealer 360 › HCPS Academy card — browser QA (switch academy_dealer360): shown with progress / exam / certificate status
   for President, rep and Relations; hidden when switched off; never a score; no horizontal scroll at phone width.

   The real page (src/admin/dealer.html); every /.netlify/functions call answered by the REAL handler
   against the fake database in phase0-mock.js (same harness as phase2-ui.qa.js).
   Run:  PW_CHROMIUM=/path/to/chromium node test/phase2-account-class-ui.qa.js   (screenshots: <tmp>/hcps-academy-d360-qa) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createWorld, load, standardSeed } = require('./phase0-mock');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }
  catch (e2) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); } }

const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-academy-d360-qa'); fs.mkdirSync(SHOTS, { recursive: true });

function world(opts) {
  opts = opts || {};
  const DAY = 86400000, iso = ms => new Date(Date.now() + ms).toISOString();
  const S = standardSeed({
    dealer_contacts: [], dealer_tasks: [], opportunities: [], dealer_notes: [], dealer_activity: [], dealer_visit_reports: [], manufacturers: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { academy_dealer360: opts.off ? false : true } }],
  academy_learners: [{ id: 'L1', full_name: 'Terry Manager', email: 'tm@glasgow.test', status: 'active' }, { id: 'L2', full_name: 'Pat Learner', email: 'pat@glasgow.test', status: 'active' },
    { id: 'L3', full_name: 'Branch Person', email: 'b@glasgow.test', status: 'active' }, { id: 'L4', full_name: 'Gone Employee', email: 'gone@glasgow.test', status: 'active' },
    { id: 'L9', full_name: 'Other Dealer Person', email: 'x@other.test', status: 'active' }],
  academy_memberships: [
    { id: 'M1', learner_id: 'L1', dealer_id: 'd-greg', role: 'training_manager', access_type: 'training_only', status: 'active', started_at: '2026-10-01' },
    { id: 'M2', learner_id: 'L2', dealer_id: 'd-greg', role: 'learner', access_type: 'training_only', status: 'active', started_at: '2026-10-02' },
    { id: 'M3', learner_id: 'L3', dealer_id: 'd-greg-branch', role: 'learner', access_type: 'training_only', status: 'active', started_at: '2026-10-02' },
    { id: 'M4', learner_id: 'L4', dealer_id: 'd-greg', role: 'learner', access_type: 'training_only', status: 'ended', started_at: '2026-01-01', ended_at: '2026-09-01' },
    { id: 'M9', learner_id: 'L9', dealer_id: 'd-ang', role: 'learner', access_type: 'training_only', status: 'active', started_at: '2026-10-02' }],
  academy_invites: [{ id: 'I1', dealer_id: 'd-greg', email: 'new@glasgow.test', status: 'pending', expires_at: iso(5 * DAY) }, { id: 'I2', dealer_id: 'd-greg', email: 'old@glasgow.test', status: 'pending', expires_at: iso(-DAY) },
    { id: 'I3', dealer_id: 'd-greg', email: 'tm@glasgow.test', status: 'accepted', expires_at: iso(5 * DAY) }],
  academy_courses: [{ id: 'C1', title: 'Golden Lift Chair Sales Certification', slug: 'golden-lift-chair-sales-certification' }, { id: 'CT', title: 'Test course', slug: 'test-course' }],
  academy_course_versions: [{ id: 'V1', course_id: 'C1', version: 1 }, { id: 'VT', course_id: 'CT', version: 1 }],
  academy_modules: [{ id: 'MO1', version_id: 'V1' }, { id: 'MO2', version_id: 'V1' }],
  academy_lessons: [{ id: 'LE1', module_id: 'MO1' }, { id: 'LE2', module_id: 'MO1' }, { id: 'LE3', module_id: 'MO2' }],
  academy_enrollments: [
    { id: 'E1', learner_id: 'L1', version_id: 'V1', membership_id: 'M1', status: 'completed' },
    { id: 'E2', learner_id: 'L2', version_id: 'V1', membership_id: 'M2', status: 'in_progress' },
    { id: 'E3', learner_id: 'L3', version_id: 'V1', membership_id: 'M3', status: 'in_progress' },
    { id: 'E4', learner_id: 'L4', version_id: 'V1', membership_id: 'M4', status: 'completed' },
    { id: 'ET', learner_id: 'L2', version_id: 'VT', membership_id: 'M2', status: 'completed' },
    { id: 'E9', learner_id: 'L9', version_id: 'V1', membership_id: 'M9', status: 'completed' }],
  academy_progress: [{ enrollment_id: 'E1', lesson_id: 'LE1', status: 'completed' }, { enrollment_id: 'E1', lesson_id: 'LE2', status: 'completed' }, { enrollment_id: 'E1', lesson_id: 'LE3', status: 'completed' },
    { enrollment_id: 'E2', lesson_id: 'LE1', status: 'completed' }, { enrollment_id: 'E2', lesson_id: 'LE2', status: 'viewed' }],
  academy_attempts: [{ enrollment_id: 'E1', passed: false, score: 52, submitted_at: '2026-10-05T10:00:00Z' }, { enrollment_id: 'E1', passed: true, score: 92, submitted_at: '2026-10-05T12:00:00Z' },
    { enrollment_id: 'E2', passed: false, score: 40, submitted_at: '2026-10-06T10:00:00Z' }, { enrollment_id: 'E2', passed: null, score: null, submitted_at: null },
    { enrollment_id: 'E4', passed: true, score: 88, submitted_at: '2026-02-01T10:00:00Z' }, { enrollment_id: 'ET', passed: true, score: 100, submitted_at: '2026-10-01T10:00:00Z' }],
  academy_certificates: [{ id: 'X1', enrollment_id: 'E1', cert_number: 'HCPS-AAAA-BBBB', issued_at: '2026-10-05', expires_at: iso(30 * DAY), status: 'valid', revoked_reason: 'SECRET-REASON' },
    { id: 'X4', enrollment_id: 'E4', cert_number: 'HCPS-CCCC-DDDD', issued_at: '2025-02-01', expires_at: iso(-3 * DAY), status: 'valid' }],
  });
  for (const d of S.tables.dealers) { d.updated_at = '2026-01-01T00:00:00Z'; if (!opts.noColumn) d.account_class = null; }
  if (opts.noColumn) S.columns = { dealers: ['id', 'business_name', 'rep_email', 'rep_name', 'parent_id', 'state', 'updated_at', 'email', 'is_test', 'hcps_account', 'status', 'contact_name', 'phone', 'address', 'city', 'zip', 'notes', 'website', 'email_verified', 'golden_url', 'golden_status', 'active', 'ovation_access'] };
  return createWorld(S);
}
const PROFILES = {
  greg: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/command-center-rep.html' },
  pres: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' },
  lori: { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', rep_name: 'Lori Hunt', landing: '/admin/command-center-rep.html' },
};
function serve(w) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop();
      let raw = ''; for await (const c of req) raw += c;
      calls.push({ name, body: raw, method: req.method });
      const file = path.join(__dirname, '..', 'netlify', 'functions', name + '.js');
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('{}'); return; }
      try {
        const mod = load(name + '.js', w, { ANTHROPIC_API_KEY: 'k' });
        const headers = {}; for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
        const r = await mod.handler({ httpMethod: req.method, headers, body: raw, queryStringParameters: Object.fromEntries(u.searchParams) });
        res.writeHead(r.statusCode || 200, Object.assign({ 'content-type': 'application/json' }, r.headers || {})); res.end(r.body || '');
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e.message || e) })); }
      return;
    }
    let p = u.pathname.startsWith('/admin/') ? path.join(ADMIN, u.pathname.slice(7)) : null;
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(''); return; }
    const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webmanifest': 'application/json' }[path.extname(p)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(fs.readFileSync(p));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, calls })));
}
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
const DESKTOP = { viewport: { width: 1366, height: 900 } };
async function ctxFor(browser, who, device) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([tok, prof]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); } catch (e) {} }, [who, JSON.stringify(PROFILES[who])]);
  return ctx;
}
async function noHScroll(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w + 1, `${label}: horizontal scroll (${o.sw} > ${o.w})`);
}
let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world(); const { srv, port } = await serve(w); const B = `http://127.0.0.1:${port}`;
  for (const [who, dev, label] of [['pres', PHONE, 'phone'], ['pres', DESKTOP, 'desktop'], ['greg', PHONE, 'phone'], ['lori', DESKTOP, 'desktop']]) {
    await step(`${who} (${label}): the HCPS Academy card shows people, progress, exam status and certificates — never a score`, async () => {
      const c = await ctxFor(browser, who, dev); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.dismiss());
      await p.goto(`${B}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#academyCard', { state: 'visible', timeout: 20000 });
      await p.waitForFunction(() => /Terry Manager/.test((document.querySelector('#academy360') || {}).textContent || ''), null, { timeout: 15000 });
      const t = await p.textContent('#academyCard');
      assert.ok(/HCPS Academy/.test(t) && /Training Manager/.test(t) && /3\/3 lessons/.test(t) && /Exam passed/.test(t), t.slice(0, 400));
      assert.ok(/HCPS certificate HCPS-AAAA-BBBB · valid until/.test(t), 'certificate line'); assert.ok(/expiring within 60 days/.test(t), 'expiring chip');
      assert.ok(/Exam not passed yet \(1 attempt\)/.test(t), 'attempt count'); assert.ok(/access ended/.test(t) && /expired/.test(t), 'ended + expired');
      assert.ok(/Glasgow North/.test(t), 'branch person labelled with the branch');
      assert.ok(!/score|92|52|@/.test(t.replace(/scores are not shown/, '')), 'no score or email: ' + t);
      await noHScroll(p, who + ' ' + label);
      await (await p.$('#academyCard')).screenshot({ path: path.join(SHOTS, `academy-${who}-${label}.png`) });
      assert.deepStrictEqual(errs, []); await c.close();
    });
  }
  await step('switched off: the card stays hidden and the rest of Dealer 360 opens as before', async () => {
    const w2 = world({ off: true }); const s2 = await serve(w2); const B2 = `http://127.0.0.1:${s2.port}`;
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B2}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#hdrCard', { timeout: 20000 }); await p.waitForTimeout(1500);
    assert.strictEqual(await p.isVisible('#academyCard'), false);
    assert.ok(/Glasgow Prescription Center/.test(await p.textContent('#hdrCard')));
    assert.deepStrictEqual(errs, []); await c.close(); s2.srv.close();
  });
  await browser.close(); srv.close();
  console.log(`\nAcademy Dealer 360 UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

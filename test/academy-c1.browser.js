/* HCPS Academy A2C Part C1 — browser QA for /admin/academy.html, against the REAL academy-admin-api.js handler.
   A local server serves the admin page and its scripts from src/admin and answers the admin API by running the real
   function in the Phase 0 harness (in-memory database; the audited operations are answered by a stand-in that makes the
   same change). Nothing reaches Supabase. Needs Playwright + the pre-installed Chromium:
     PLAYWRIGHT_MODULE=/path/to/node_modules/playwright SHOTS=/tmp/shots node test/academy-c1.browser.js
   Checks: every tab renders for the President, an admin, and the switched-off and non-admin states; desktop and phone
   widths with no sideways scroll; publish is offered to the President only; a full create-course -> version -> module ->
   lesson flow through the page; and a HOSTILE pass where every text value in the database is an HTML/script payload —
   nothing may execute and no injected element may appear. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createWorld, load, BASE } = require('./phase0-mock.js');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const SRC = path.join(__dirname, '..', 'src', 'admin');
const SHOTS = process.env.SHOTS || null;
const EXE = process.env.CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1"><script>window.__xss=(window.__xss||0)+1</script>"'><svg onload="window.__xss=1">`;

function demo(hostile) {
  const T = s => hostile ? XSS + s : s;
  const HQ = u(101), BR = u(102), RMS = u(103);
  return {
    tokens: { pres: 'angelo@hcps.us', admin: 'ann@hcps.us', greg: 'greg@hcps.us' },
    tables: {
      staff_users: [{ email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', active: true }, { email: 'ann@hcps.us', name: 'Ann Admin', role: 'admin', active: true },
                    { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', active: true }],
      dealers: [{ id: HQ, business_name: T('Glasgow Prescription Center'), parent_id: null }, { id: BR, business_name: T('Glasgow North'), parent_id: HQ }, { id: RMS, business_name: T('Retail Medical Solutions'), parent_id: null }],
      manufacturers: [{ slug: 'golden-technologies', name: T('Golden Technologies') }, { slug: 'pride-mobility', name: 'Pride Mobility' }, { slug: 'drive-medical', name: 'Drive Medical' }],
      app_settings: [{ key: 'phase2_flags', value: { academy_admin: true } }],
      academy_courses: [
        { id: u(1), slug: 'golden-lift-chair-specialist', title: T('Golden Lift Chair Specialist'), course_type: 'hcps_certification', issuer: 'hcps', manufacturer_slug: 'golden-technologies', category: T('Lift chairs'), external_url: null, status: 'draft', created_at: '2026-10-01T10:00:00Z' },
        { id: u(2), slug: 'golden-certified-pro', title: T('Golden Certified Pro'), course_type: 'manufacturer_program', issuer: 'manufacturer', manufacturer_slug: 'golden-technologies', category: null, external_url: hostile ? 'javascript:window.__xss=1' : 'https://www.goldentech.com/', status: 'draft', created_at: '2026-10-01T10:00:00Z' },
        { id: u(3), slug: 'test-sandbox', title: T('Sandbox'), course_type: 'training', issuer: 'none', manufacturer_slug: null, category: null, external_url: null, status: 'draft', created_at: '2026-10-01T10:00:00Z' },
      ],
      academy_course_versions: [
        { id: u(11), course_id: u(1), version: 1, status: 'published', pass_mark: 80, exam_questions: 25, validity_months: 12, published_at: '2026-10-05T15:00:00Z', published_by: 'staff:angelo@hcps.us', created_at: '2026-10-01T10:00:00Z' },
        { id: u(12), course_id: u(1), version: 2, status: 'draft', pass_mark: 80, exam_questions: 25, validity_months: 12, published_at: null, published_by: null, created_at: '2026-10-08T10:00:00Z' },
      ],
      academy_modules: [
        { id: u(21), version_id: u(12), position: 1, title: T('Lift chair anatomy'), objectives: [T('Name the main parts'), 'Explain the lift mechanism'] },
        { id: u(22), version_id: u(12), position: 2, title: T('Fitting the customer'), objectives: [] },
        { id: u(23), version_id: u(11), position: 1, title: T('Published module'), objectives: [] },
      ],
      academy_lessons: [
        { id: u(31), module_id: u(21), position: 1, title: T('Motors and actuators'), est_minutes: 8, blocks: [] },
        { id: u(32), module_id: u(21), position: 2, title: T('Hand controls'), est_minutes: 6, blocks: [] },
        { id: u(33), module_id: u(22), position: 1, title: T('Seat height and depth'), est_minutes: 10, blocks: [] },
      ],
      academy_questions: [{ id: u(41), version_id: u(12), kind: 'single', use: 'exam', prompt: 'SECRET-PROMPT', choices: ['a', 'b'], answer_key: 'SECRET-KEY', explanation: 'x', status: 'active' }],
      academy_learners: [
        { id: u(51), auth_user_id: u(61), full_name: T('Tina Manager'), email: 'tina@glasgowrx.test', status: 'active', created_at: '2026-10-02T00:00:00Z' },
        { id: u(52), auth_user_id: u(62), full_name: T('Bob Branch'), email: 'bob@glasgownorth.test', status: 'active', created_at: '2026-10-02T00:00:00Z' },
        { id: u(53), auth_user_id: u(63), full_name: T('Rita Retail'), email: 'rita@rms.test', status: 'active', created_at: '2026-10-03T00:00:00Z' },
      ],
      academy_memberships: [
        { id: u(71), learner_id: u(51), dealer_id: HQ, role: 'training_manager', access_type: 'dealer_user', status: 'active' },
        { id: u(72), learner_id: u(52), dealer_id: BR, role: 'learner', access_type: 'training_only', status: 'active' },
        { id: u(73), learner_id: u(53), dealer_id: RMS, role: 'learner', access_type: 'dealer_user', status: 'active' },
      ],
      academy_enrollments: [{ id: u(81), learner_id: u(51), version_id: u(11), status: 'completed' }, { id: u(82), learner_id: u(52), version_id: u(11), status: 'in_progress' }],
      academy_certificates: [{ id: u(91), cert_number: 'HCPS-7K2D-Q9XA', learner_id: u(51), enrollment_id: u(81), version_id: u(11), attempt_id: u(92), learner_name: T('Tina Manager'), dealer_name: T('Glasgow Prescription Center'), issued_at: '2026-10-06T00:00:00Z', expires_at: '2027-10-06T00:00:00Z', status: 'valid' }],
      academy_external_certs: [
        { id: u(93), learner_id: u(52), course_id: u(2), manufacturer_slug: 'golden-technologies', status: 'certificate_uploaded', upload_media_id: u(94), note: hostile ? XSS : null, created_at: '2026-10-07T00:00:00Z' },
        { id: u(95), learner_id: u(53), course_id: u(2), manufacturer_slug: 'golden-technologies', status: 'verified', evidence_type: 'manufacturer_confirmation', evidence_ref: T('Golden email, 7 Oct'), verified_by: 'staff:ann@hcps.us', verified_at: '2026-10-08T00:00:00Z', created_at: '2026-10-05T00:00:00Z' },
      ],
      product_facts: [
        { id: u(201), manufacturer_slug: 'golden-technologies', model_code: 'PR-401', field: 'weight_capacity', value: hostile ? XSS : 375, unit: 'lb', field_class: 'approval_required', status: 'verified', source_url: hostile ? 'javascript:window.__xss=1' : 'https://www.goldentech.com/', source_label: T('Golden PR-401 sell sheet'), verified_on: '2026-09-15', verified_by: 'staff:angelo@hcps.us', note: hostile ? XSS : null, valid_from: '2026-09-15T00:00:00Z', valid_to: null, replaced_by: null },
        { id: u(202), manufacturer_slug: 'golden-technologies', model_code: 'PR-401', field: 'colors', value: ['Burgundy', 'Brisa Fudge'], unit: null, field_class: 'display', status: 'awaiting_manufacturer', source_url: 'https://www.goldentech.com/', source_label: 'Golden website', verified_on: '2026-09-15', verified_by: 'staff:ann@hcps.us', note: null, valid_from: '2026-09-15T00:00:00Z', valid_to: null, replaced_by: null },
      ],
      academy_events: [
        { id: 1, at: '2026-10-05T15:00:00Z', actor_type: 'staff', actor: 'staff:angelo@hcps.us', entity: 'academy_course_versions', entity_id: u(11), action: 'publish_version', before: { status: 'draft' }, after: { status: 'published', note: hostile ? XSS : 'v1' } },
        { id: 2, at: '2026-10-08T09:00:00Z', actor_type: 'staff', actor: hostile ? XSS : 'staff:ann@hcps.us', entity: 'academy_external_certs', entity_id: u(95), action: 'external_cert_verified', before: null, after: { status: 'verified' } },
        { id: 3, at: '2026-10-08T10:00:00Z', actor_type: 'learner', actor: 'learner:' + u(52), entity: 'academy_attempts', entity_id: u(92), action: 'submit_attempt', before: null, after: { answers: { q: 'SECRET-ANSWER' }, score: 88 } },
      ],
    },
  };
}

function server(world, opsLog) {
  let mod = null;
  const ensure = () => {
    if (mod) return mod;
    mod = load('academy-admin-api.js', world, {});
    const base = global.fetch;
    global.fetch = async (url, opts) => {
      const s = String(url);
      if (s.startsWith(BASE + '/rest/v1/rpc/academy_op_')) {   // stand-in for the audited operations: same visible change
        const name = s.slice((BASE + '/rest/v1/rpc/academy_op_').length), a = JSON.parse(opts.body); opsLog.push({ name, args: a });
        const db = world.db; let row = { ok: true };
        if (name === 'publish_version') { for (const v of db.academy_course_versions) if (v.course_id === (db.academy_course_versions.find(x => x.id === a.p_version_id) || {}).course_id && v.status === 'published') v.status = 'retired';
          row = Object.assign(db.academy_course_versions.find(x => x.id === a.p_version_id), { status: 'published', published_at: new Date().toISOString(), published_by: a.p_actor }); }
        db.academy_events.push({ id: db.academy_events.length + 100, at: new Date().toISOString(), actor_type: 'staff', actor: a.p_actor, entity: 'op', entity_id: null, action: name, before: null, after: null });
        return { ok: true, status: 200, text: async () => JSON.stringify(row) };
      }
      return base(url, opts);
    };
    return mod;
  };
  return http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString('utf8');
    const p = req.url.split('?')[0];
    if (p === '/.netlify/functions/academy-admin-api') {
      const out = await ensure().handler({ httpMethod: req.method, headers: req.headers, body, queryStringParameters: {} });
      res.writeHead(out.statusCode, out.headers); return res.end(out.body);
    }
    if (p.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"favorites":[],"count":0}'); }
    const file = p.startsWith('/admin/') ? path.join(SRC, path.basename(p)) : null;
    if (file && fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); res.end('');
  });
}

async function withSite(seed, fn) {
  const world = createWorld(seed); const ops = [];
  const srv = server(world, ops); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn({ origin, world, ops }); } finally { srv.close(); }
}
async function page(browser, origin, token, width) {
  const ctx = await browser.newContext({ viewport: { width: width || 1280, height: 900 }, deviceScaleFactor: width && width < 500 ? 2 : 1 });
  await ctx.addInitScript(([tok, role]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: tok + '@hcps.us', name: tok, role })); } catch (e) {} },
                          [token, token === 'pres' ? 'president' : token === 'admin' ? 'admin' : 'rep']);
  const pg = await ctx.newPage(); const errors = [];
  pg.on('pageerror', e => errors.push(String(e))); pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  pg.errors = errors; return pg;
}
const shot = async (pg, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
// The Academy page's own content never runs off a phone screen. (The shared Connect 360 masthead overflows a 390px screen
// on every admin page — e.g. ai-style-guide.html — a pre-existing finding outside C1, so the masthead is measured apart.)
const noSideScroll = async pg => {
  const over = await pg.evaluate(() => { const W = window.innerWidth, out = [];
    document.querySelectorAll('#app *, #mbox *').forEach(e => { const r = e.getBoundingClientRect(); if (r.width && r.right > W + 1 && !e.closest('details:not([open])')) out.push(e.tagName + '.' + e.className + '#' + e.id + ' ' + Math.round(r.right)); });
    return out.slice(0, 6); });
  assert.deepStrictEqual(over, [], 'Academy content wider than the phone: ' + over.join(', '));
};
const TABS = ['overview', 'courses', 'people', 'facts', 'creds', 'activity'];
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.stack || e)); } }

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  try {
    await t('President: every tab renders (desktop + phone), no script errors, no sideways scroll on phone', async () => withSite(demo(false), async ({ origin }) => {
      for (const width of [1280, 390]) {
        const pg = await page(browser, origin, 'pres', width);
        await pg.goto(origin + '/admin/academy.html'); await pg.waitForSelector('#tabs .tab');
        for (const tab of TABS) {
          await pg.click(`#tabs .tab[data-t="${tab}"]`); await pg.waitForFunction(() => !document.querySelector('#view').textContent.includes('Loading…'));
          assert.ok(!(await pg.textContent('#view')).match(/Something went wrong|could not read/i), tab);
          if (width < 500) await noSideScroll(pg);
          await shot(pg, `${width < 500 ? 'phone' : 'desktop'}-${tab}`);
        }
        const all = await pg.content(); for (const s of ['SECRET-KEY', 'SECRET-PROMPT', 'SECRET-ANSWER']) assert.ok(!all.includes(s), s);
        assert.deepStrictEqual(pg.errors, []); await pg.context().close();
      }
    }));
    await t('version screen: the President sees Publish; an admin does not (and is told why)', async () => withSite(demo(false), async ({ origin }) => {
      for (const [tok, expect] of [['pres', true], ['admin', false]]) {
        const pg = await page(browser, origin, tok);
        await pg.goto(origin + '/admin/academy.html#courses'); await pg.waitForSelector('tr.click');
        await pg.click('tr.click >> text=Golden Lift Chair Specialist'); await pg.waitForSelector('#newv');
        await pg.click('tr.click >> text=v2'); await pg.waitForSelector('#addm');
        assert.strictEqual(await pg.$('#pub') != null, expect, tok);
        if (!expect) assert.ok((await pg.textContent('#view')).includes('Publishing is reserved for the President'));
        await shot(pg, `desktop-version-${tok}`);
        await pg.click('#back'); await pg.click('tr.click >> text=v1'); await pg.waitForSelector('.note');
        assert.strictEqual(await pg.$('#addm'), null, 'a published version offers no editing'); assert.strictEqual(await pg.$('#retire') != null, expect);
        assert.deepStrictEqual(pg.errors, []); await pg.context().close();
      }
    }));
    await t('flow through the page: new course -> draft version -> module -> lesson -> publish (President), all recorded', async () => withSite(demo(false), async ({ origin, world, ops }) => {
      const pg = await page(browser, origin, 'pres');
      await pg.goto(origin + '/admin/academy.html#courses'); await pg.waitForSelector('#newc');
      await pg.click('#newc'); await pg.fill('#ctitle', 'Pride Scooter Basics'); await pg.selectOption('#ctype', 'training'); await pg.selectOption('#cmfr', 'pride-mobility');
      await shot(pg, 'desktop-new-course'); await pg.click('#msave'); await pg.waitForSelector('#newv');
      const c = world.db.academy_courses.find(x => x.slug === 'pride-scooter-basics'); assert.ok(c); assert.strictEqual(c.issuer, 'none');
      await pg.click('#newv'); await pg.fill('#vpass', '75'); await pg.click('#msave'); await pg.waitForSelector('#addm');
      await pg.click('#addm'); await pg.fill('#mt', 'Scooter controls'); await pg.fill('#mo', 'Use the tiller\nSet the speed'); await pg.click('#msave');
      await pg.waitForSelector('[data-al]'); await pg.click('[data-al]'); await pg.fill('#lt', 'Tiller and throttle'); await pg.fill('#lm', '7'); await pg.click('#msave');
      await pg.waitForSelector('text=Tiller and throttle'); await shot(pg, 'desktop-draft-built');
      await pg.click('#pub'); await pg.click('#msave'); assert.ok((await pg.textContent('#mmsg')).includes('Type PUBLISH'));
      await pg.fill('#pubconf', 'PUBLISH'); await pg.click('#msave'); await pg.waitForSelector('text=can never change');
      assert.deepStrictEqual(ops.map(o => [o.name, o.args.p_actor]), [['publish_version', 'staff:angelo@hcps.us']]);
      const acts = world.db.academy_events.filter(e => e.id === undefined || typeof e.id === 'string').map(e => [e.action, e.actor]);
      assert.deepStrictEqual(acts, [['create_course', 'staff:angelo@hcps.us'], ['create_version', 'staff:angelo@hcps.us'], ['create_module', 'staff:angelo@hcps.us'], ['create_lesson', 'staff:angelo@hcps.us']]);
      assert.deepStrictEqual(pg.errors, []); await pg.context().close();
    }));
    await t('switched OFF: the page shows the notice and no data; a rep sees "administrators only"', async () => {
      const off = demo(false); off.tables.app_settings[0].value = {};
      await withSite(off, async ({ origin }) => {
        const pg = await page(browser, origin, 'pres'); await pg.goto(origin + '/admin/academy.html'); await pg.waitForSelector('#off h2');
        assert.ok((await pg.textContent('#off')).includes('switched off')); assert.ok(!(await pg.isVisible('#main')));
        assert.ok((await pg.textContent('#switchbar')).includes('admin: OFF')); await shot(pg, 'desktop-switched-off');
        const ph = await page(browser, origin, 'pres', 390); await ph.goto(origin + '/admin/academy.html'); await ph.waitForSelector('#off h2'); await noSideScroll(ph); await shot(ph, 'phone-switched-off');
        await pg.context().close(); await ph.context().close();
      });
      await withSite(demo(false), async ({ origin }) => {
        const pg = await page(browser, origin, 'greg'); await pg.goto(origin + '/admin/academy.html'); await pg.waitForSelector('#off h2');
        assert.ok((await pg.textContent('#off')).includes('HCPS administrators only')); await shot(pg, 'desktop-rep-refused'); await pg.context().close();
      });
    });
    await t('HOSTILE data: every screen and dialog renders payloads as text — nothing executes, nothing is injected', async () => withSite(demo(true), async ({ origin }) => {
      for (const width of [1280, 390]) {
        const pg = await page(browser, origin, 'pres', width);
        await pg.goto(origin + '/admin/academy.html'); await pg.waitForSelector('#tabs .tab');
        const badLinks = [];
        const links = async () => { for (const h of await pg.$$eval('a[href]', as => as.map(a => a.getAttribute('href')))) if (/^\s*javascript:/i.test(h)) badLinks.push(h); };
        const visit = async () => {
          for (const tab of TABS) {
            await pg.click(`#tabs .tab[data-t="${tab}"]`); await pg.waitForFunction(() => !document.querySelector('#view').textContent.includes('Loading…'));
            if (tab === 'people') { await pg.click('#pl'); await pg.waitForSelector('[data-tm]'); }
            if (tab === 'facts') { await pg.click('[data-hist]'); await pg.waitForSelector('#mclose'); await pg.click('#mclose'); await pg.click('[data-rep]'); await pg.click('#mcancel'); }
            if (tab === 'creds') { await pg.click('[data-rv]'); await pg.click('#mcancel'); }
            if (tab === 'activity') await pg.$$eval('details', ds => ds.forEach(d => { d.open = true; }));
            await links();
          }
          await pg.click('#tabs .tab[data-t="courses"]'); await pg.waitForSelector('tr.click');
          await pg.click('tr.click:has-text("Certified Pro")'); await pg.waitForSelector('#editc'); await links(); await pg.click('#editc'); await pg.click('#mcancel');
          await pg.click('#back'); await pg.waitForSelector('tr.click'); await pg.click('tr.click:has-text("Lift Chair")'); await pg.waitForSelector('#newv');
          await pg.click('tr.click >> text=v2'); await pg.waitForSelector('[data-em]'); await pg.click('[data-em]'); await pg.click('#mcancel');
        };
        await visit(); await pg.waitForTimeout(300);
        assert.strictEqual(await pg.evaluate(() => window.__xss), undefined, 'a payload executed');
        assert.strictEqual(await pg.$$eval('img[src="x"], svg[onload], #view script', els => els.length), 0, 'an injected element appeared');
        assert.deepStrictEqual(badLinks, [], 'a javascript: link was rendered');
        if (width < 500) await noSideScroll(pg);
        await shot(pg, `${width < 500 ? 'phone' : 'desktop'}-hostile`);
        assert.deepStrictEqual(pg.errors, []); await pg.context().close();
      }
    }));
  } finally { await browser.close(); }
  console.log(`\nacademy-c1 browser: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();

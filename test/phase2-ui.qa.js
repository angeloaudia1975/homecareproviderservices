/* Phase 2A — browser QA for unplanned visits: Dealer 360 "Start visit" → the field app's visit mode
   for one dealer, no route → Start / End / Review / Approve → back; resume; a second visit; offline;
   the switch off; My Sales Workspace limited to his own book.

   Same harness as phase1-ui.qa.js: the real pages in src/admin, every /.netlify/functions call
   answered by the REAL handler against the fake database in phase0-mock.js.
   Run:  PW_CHROMIUM=/path/to/chromium node test/phase2-ui.qa.js   (screenshots: <tmp>/hcps-phase2-qa) */
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
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-phase2-qa'); fs.mkdirSync(SHOTS, { recursive: true });
const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), IN3 = dayStr(3);

const AI_VISIT = {
  meeting_summary: 'Met Bryant. Reviewed lift chairs; he wants PR519 pricing.',
  products_discussed: ['PR519 lift chair'], dealer_interests: ['Lift chairs'], dealer_concerns: [], objections: [], competitors: [],
  pricing_requests: ['PR519 pricing'], samples_requested: [], literature_requested: [], training_requested: [],
  attendees: [{ name: 'Bryant Smith', title: 'Pharmacist' }],
  rep_commitments: [{ text: 'Send PR519 pricing', due_date: IN3 }], dealer_commitments: [],
  follow_ups: [{ title: 'Send PR519 pricing', due_date: IN3, priority: 'high', from: 'rep_commitment' }],
  opportunities: [], suggested_next_action: { text: '', due_date: '' }, interest_slugs: [], poor_fit_slugs: [] };

function world(opts) {
  opts = opts || {};
  const S = standardSeed({
    rep_routes: [{ id: 'r-g', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', name: 'KY loop', scheduled_date: TODAY,
      stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center' }] }],
    dealer_visit_reports: [], dealer_tasks: [], opportunities: [], dealer_notes: [], dealer_visits: [], dealer_visit_participants: [], dealer_activity: [],
    dealer_contacts: [{ id: 'c-bryant', dealer_id: 'd-greg', name: 'Bryant Smith', email: 'bryant@glasgow.test', title: 'Pharmacist', phone: '270-111' }],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }].concat(opts.flagOff ? [] : [{ key: 'phase2_flags', value: { adhoc_visit: true } }]),
  });
  S.unique = { dealer_tasks: [['origin_type', 'origin_id', 'origin_key']], opportunities: [['origin_type', 'origin_id', 'origin_key']],
    dealer_visits: [['visit_report_id']], dealer_visit_participants: [['visit_report_id', 'name_key']], dealer_contacts: [['dealer_id', 'email']],
    dealer_visit_reports: [['route_id', 'dealer_id'], ['visit_key']] };
  S.uniquePartial = { dealer_visit_reports: [{ cols: ['dealer_id', 'rep_email'], lower: ['rep_email'], where: r => r.route_id == null && r.completed_at == null }] };
  S.ai = body => /MEETING RECAP/.test(JSON.stringify(body)) ? { subject: 'Following up', body: 'Hi Bryant,\n\nThanks for your time.' } : AI_VISIT;
  return createWorld(S);
}
const PROFILES = {
  greg: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/rep-home.html' },
  pres: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' },
};
function serve(w) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop();
      let raw = ''; for await (const c of req) raw += c;
      calls.push({ name, body: raw, ws: req.headers['x-hcps-workspace'] || null });
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
async function ctxFor(browser, who, device, ws) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([tok, prof, wsOn]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); if (wsOn) sessionStorage.setItem('hcps_workspace', 'mine'); } catch (e) {} }, [who, JSON.stringify(PROFILES[who]), !!ws]);
  return ctx;
}
async function noHScroll(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w + 1, `${label}: horizontal scroll (${o.sw} > ${o.w})`);
}
const offRoute = (w, did) => w.db.dealer_visit_reports.filter(r => r.route_id == null && r.dealer_id === did);

let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world();
  const { srv, port, calls } = await serve(w);
  const B = `http://127.0.0.1:${port}`;

  const ctx = await ctxFor(browser, 'greg', PHONE); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.dismiss());

  await step('Dealer 360 (phone): Visits & meetings offers ▶ Start visit — no route needed', async () => {
    await page.goto(`${B}/admin/dealer.html?id=d-greg`); await page.waitForSelector('#vm-start', { timeout: 20000 });
    assert.ok(/Start visit/.test(await page.textContent('#vm-start')));
    assert.strictEqual(await page.getAttribute('#vm-start', 'href'), '/admin/scheduled-routes.html?dealer=d-greg');
    const h = await page.$eval('#vm-start', e => e.getBoundingClientRect().height); assert.ok(h >= 44, 'touch target ' + h);
    await noHScroll(page, 'Dealer 360 phone'); await page.$eval('#visitsCard', e => e.scrollIntoView()); await page.screenshot({ path: path.join(SHOTS, 'd360-start.png') });
  });
  await step('field app, dealer mode: one stop, Unplanned visit header, way back to Dealer 360, no heads-up', async () => {
    await page.click('#vm-start'); await page.waitForSelector('#stop_0 .btn.go.xl', { timeout: 20000 });
    const t = await page.textContent('#app');
    assert.ok(/Unplanned visit/.test(t) && /Glasgow Prescription Center/.test(t), t.slice(0, 300));
    assert.ok(await page.$('a[href="/admin/dealer.html?id=d-greg"]'), 'no way back to Dealer 360');
    assert.strictEqual(await page.$('button:has-text("Heads-up")'), null, 'heads-up offered off a route');
    assert.strictEqual(await page.$$eval('.stop', x => x.length), 1);
    assert.strictEqual(offRoute(w, 'd-greg').length, 0, 'opening the page started a visit');
    await noHScroll(page, 'dealer mode'); await page.screenshot({ path: path.join(SHOTS, 'field-adhoc-1.png'), fullPage: true });
  });
  await step('Start (double tap) → one visit, with this phone\'s key; the timer runs', async () => {
    await page.evaluate(() => { const b = document.querySelector('#stop_0 .btn.go.xl'); b.click(); try { b.click(); } catch (e) {} });
    await page.waitForSelector('#vn_0'); await page.waitForTimeout(800);
    const rows = offRoute(w, 'd-greg'); assert.strictEqual(rows.length, 1, 'rows: ' + rows.length);
    const key = await page.evaluate(() => DAY.route.visit_key);
    assert.ok(/^[A-Za-z0-9_-]{6,64}$/.test(key), key); assert.strictEqual(rows[0].visit_key, key); assert.strictEqual(rows[0].origin, 'adhoc');
    await page.fill('#vn_0', 'Met Bryant about lift chairs. Send PR519 pricing.');
    const t1 = await page.textContent('#stop_0 .vtimer b'); await page.waitForTimeout(1300); assert.notStrictEqual(t1, await page.textContent('#stop_0 .vtimer b'));
    await page.screenshot({ path: path.join(SHOTS, 'field-adhoc-2-onsite.png'), fullPage: true });
  });
  await step('Back on Dealer 360 the button resumes: ⏱ Resume my visit → the same visit, notes still there', async () => {
    await page.goto(`${B}/admin/dealer.html?id=d-greg`); await page.waitForSelector('#vm-start', { timeout: 20000 });
    assert.ok(/Resume my visit/.test(await page.textContent('#vm-start')));
    assert.ok(/On site now/.test(await page.textContent('#visits')));
    await page.click('#vm-start'); await page.waitForSelector('#vn_0', { timeout: 20000 });
    assert.ok(/Send PR519 pricing/.test(await page.inputValue('#vn_0')), 'notes lost on resume');
    assert.strictEqual(offRoute(w, 'd-greg').length, 1);
  });
  await step('End → review → approve (follow-up only, no deal) → saved to this dealer', async () => {
    await page.click('#stop_0 .vmode .btn.go.xl'); await page.waitForSelector('#rv_fu .rv-card', { timeout: 15000 });
    await noHScroll(page, 'review'); await page.screenshot({ path: path.join(SHOTS, 'field-adhoc-3-review.png'), fullPage: true });
    await page.click('#rv_body > .btn.go.xl'); await page.waitForSelector('.rv-done', { timeout: 15000 });
    const r = offRoute(w, 'd-greg')[0]; assert.ok(r.approved_at && r.completed_at && r.ended_at, JSON.stringify(r));
    assert.strictEqual(w.db.dealer_tasks.filter(t => t.origin_id === r.id).length, 1); assert.strictEqual(w.db.opportunities.length, 0);
    assert.strictEqual(w.db.dealer_notes.length, 1); assert.strictEqual(w.db.dealer_visits.length, 1);
    await page.click('.rv-done .btn.xl:not(.go)'); await page.waitForSelector('#rvwrap', { state: 'detached' });
    assert.ok(/visited/i.test(await page.textContent('#stop_0 .nm')));
    assert.ok(await page.$('button:has-text("Start another visit here")'));
    await page.screenshot({ path: path.join(SHOTS, 'field-adhoc-4-done.png'), fullPage: true });
  });
  await step('Dealer 360 lists the visit; Start visit is offered again (not Resume)', async () => {
    await page.goto(`${B}/admin/dealer.html?id=d-greg`); await page.waitForSelector('#visits .vm[data-id]', { timeout: 20000 });
    assert.ok(/Start visit/.test(await page.textContent('#vm-start')));
    assert.ok(/Met Bryant/.test(await page.textContent('#visits')));
  });
  await step('A replayed approval of the finished visit changes nothing; "Start another visit here" opens a NEW visit', async () => {
    const before = JSON.stringify([w.db.dealer_visit_reports.length, w.db.dealer_tasks.length, w.db.dealer_notes.length]);
    const last = calls.filter(c => c.name === 'routes-api' && /"visit_approve"/.test(c.body)).pop();
    await page.goto(`${B}/admin/scheduled-routes.html?dealer=d-greg`); await page.waitForSelector('button:has-text("Start another visit here")', { timeout: 20000 });
    await page.evaluate(b => { enqueue(JSON.parse(b)); return flushOutbox(); }, last.body);
    assert.strictEqual(JSON.stringify([w.db.dealer_visit_reports.length, w.db.dealer_tasks.length, w.db.dealer_notes.length]), before, 'the replay duplicated records');
    const k1 = await page.evaluate(() => DAY.route.visit_key);
    await page.click('button:has-text("Start another visit here")'); await page.waitForSelector('#stop_0 .btn.go.xl');
    const k2 = await page.evaluate(() => DAY.route.visit_key); assert.notStrictEqual(k1, k2);
    await page.click('#stop_0 .btn.go.xl'); await page.waitForSelector('#vn_0'); await page.waitForTimeout(500);
    assert.strictEqual(offRoute(w, 'd-greg').length, 2); assert.ok(offRoute(w, 'd-greg').some(r => r.visit_key === k2 && !r.completed_at));
  });
  await step('Offline: open the visit, go offline, Start / End / approve by hand → syncs once on reconnect', async () => {
    await page.goto(`${B}/admin/scheduled-routes.html?dealer=d-greg-branch`); await page.waitForSelector('#stop_0 .btn.go.xl', { timeout: 20000 });
    await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.click('#stop_0 .btn.go.xl'); await page.waitForSelector('#vn_0');
    await page.fill('#vn_0', 'Quick stop, left catalogs.');
    await page.click('#stop_0 .vmode .btn.go.xl'); await page.waitForSelector('#rv_body .rvnote');
    await page.click('#rv_body button:has-text("Add a follow-up")'); await page.fill('#rv_fu .rv-card:last-child .rv-t', 'Call about the catalog');
    await page.click('#rv_body > .btn.go.xl'); await page.waitForSelector('.rv-done');
    const queued = await page.evaluate(() => outbox().map(x => x.body.action + ':' + (x.body.visit_key ? 'key' : 'nokey')));
    assert.ok(queued.length >= 3 && queued.every(q => /:key$/.test(q)), 'queued: ' + queued.join(','));
    assert.strictEqual(offRoute(w, 'd-greg-branch').length, 0);
    await page.screenshot({ path: path.join(SHOTS, 'field-adhoc-5-offline.png'), fullPage: true });
    await page.click('.rv-done .btn.xl:not(.go)');
    await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => outbox().length === 0, null, { timeout: 15000 }); await page.waitForTimeout(800);
    const rows = offRoute(w, 'd-greg-branch'); assert.strictEqual(rows.length, 1, 'rows ' + rows.length);
    assert.ok(rows[0].approved_at && rows[0].visit_key); assert.strictEqual(w.db.dealer_tasks.filter(t => t.origin_id === rows[0].id).length, 1);
    assert.ok(/visited/i.test(await page.textContent('#stop_0 .nm')), 'after reconnect the visit does not show as done');
  });
  await step('field: no JavaScript errors', async () => { assert.deepStrictEqual(errors, []); });
  await ctx.close();

  await step('A dealer outside his book: the field app says so and links back; nothing is written', async () => {
    const c = await ctxFor(browser, 'greg', PHONE); const p = await c.newPage();
    await p.goto(`${B}/admin/scheduled-routes.html?dealer=d-ang`); await p.waitForSelector('.msg');
    await p.waitForFunction(() => /Not your dealer/.test(document.body.innerText), null, { timeout: 15000 });
    assert.ok(await p.$('a[href="/admin/dealer.html?id=d-ang"]'));
    assert.strictEqual(offRoute(w, 'd-ang').length, 0); await c.close();
  });

  await step('My Sales Workspace: Start visit on his own dealer; a dealer outside his book is refused', async () => {
    const c = await ctxFor(browser, 'pres', PHONE, true); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B}/admin/dealer.html?id=d-ang`); await p.waitForSelector('#vm-start', { timeout: 20000 });
    await p.click('#vm-start'); await p.waitForSelector('#stop_0 .btn.go.xl', { timeout: 20000 });
    assert.ok(await p.isVisible('#wsstrip'), 'workspace strip missing in the field app');
    await p.click('#stop_0 .btn.go.xl'); await p.waitForSelector('#vn_0'); await p.waitForTimeout(500);
    assert.strictEqual(offRoute(w, 'd-ang').length, 1);
    assert.ok(calls.filter(x => x.name === 'routes-api' && /visit_checkin/.test(x.body)).pop().ws === 'mine', 'the workspace header was not sent');
    await p.goto(`${B}/admin/scheduled-routes.html?dealer=d-greg`);
    await p.waitForFunction(() => /Not your dealer/.test(document.body.innerText), null, { timeout: 15000 });
    await p.screenshot({ path: path.join(SHOTS, 'ws-adhoc-refused.png'), fullPage: true });
    assert.deepStrictEqual(errs.filter(e => !/analytics|Failed to fetch/.test(e)), []); await c.close();
  });

  await step('Switch off: no Start visit on Dealer 360; the field app says it isn\'t turned on', async () => {
    const w2 = world({ flagOff: true }); const s2 = await serve(w2); const B2 = `http://127.0.0.1:${s2.port}`;
    const c = await ctxFor(browser, 'greg', DESKTOP); const p = await c.newPage();
    await p.goto(`${B2}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#visits .vm-sec', { timeout: 20000 });
    assert.strictEqual(await p.$('#vm-start'), null, 'Start visit shown with the switch off');
    await p.goto(`${B2}/admin/scheduled-routes.html?dealer=d-greg`);
    await p.waitForFunction(() => /aren't turned on yet/.test(document.body.innerText), null, { timeout: 15000 });
    assert.strictEqual(w2.db.dealer_visit_reports.length, 0);
    await p.goto(`${B2}/admin/scheduled-routes.html?route=r-g`); await p.waitForSelector('#stop_0 .btn.go.xl', { timeout: 20000 });   // routes untouched
    await c.close(); s2.srv.close();
  });

  await browser.close(); srv.close();
  console.log(`\nPhase 2A UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

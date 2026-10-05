/* Phase 2D — browser QA for the Relationship Timeline on Dealer 360 (Tasks & timeline card).

   The real page (src/admin/dealer.html); every /.netlify/functions call answered by the REAL handler
   against the fake database in phase0-mock.js (same harness as phase2-ui.qa.js).
   Run:  PW_CHROMIUM=/path/to/chromium node test/phase2-timeline-ui.qa.js   (screenshots: <tmp>/hcps-phase2d-qa) */
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
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-phase2d-qa'); fs.mkdirSync(SHOTS, { recursive: true });
const H = 3600e3, DAY = 86400e3, NOW = Date.now();
const at = ms => new Date(NOW - ms).toISOString();

function world(opts) {
  opts = opts || {};
  const D = 'd-greg';
  const S = standardSeed({
    dealer_visit_reports: [{ id: 'v1', dealer_id: D, rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: at(2 * DAY), completed_at: at(2 * DAY - H), approved_at: at(2 * DAY - H), duration_min: 45,
      visit_note_id: 'n-v1', followup_status: 'pending', summary: { meeting_summary: 'Met Rita and Bob about PR519 lift chairs. They want pricing for two units and a demo next month; the owner is also asking about scooters for the second store.' } }],
    dealer_visit_participants: [{ visit_report_id: 'v1', name_snapshot: 'Rita Owner' }, { visit_report_id: 'v1', name_snapshot: 'Bob Buyer' }],
    dealer_tasks: [{ id: 'tv1', dealer_id: D, title: 'Send PR519 pricing', status: 'open', origin_type: 'visit_report', origin_id: 'v1', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us', created_at: at(2 * DAY - H) }],
    opportunities: [{ id: 'o1', dealer_id: D, title: '2 x PR519', stage: 'identified', status: 'open', value: 1798, origin_type: 'visit_report', origin_id: 'v1', owner_rep: 'Greg Campbell', created_at: at(2 * DAY - H) }],
    dealer_notes: [{ id: 'n-v1', dealer_id: D, kind: 'visit', body: 'Visit note', author_name: 'Greg Campbell', created_at: at(2 * DAY - H + 600e3) },
      ...Array.from({ length: opts.manyNotes || 0 }, (_, i) => ({ id: 'mn' + i, dealer_id: D, kind: 'note', body: 'Older note ' + i, author_name: 'Lori Hunt', created_at: at((3 + i) * DAY) }))],
    dealer_activity: [
      { id: 'a-v1', dealer_id: D, kind: 'visit', subject: 'Visit', ref_type: 'visit_report', ref_id: 'v1', created_at: at(2 * DAY) },
      { id: 'a-sys', dealer_id: D, kind: 'system', subject: 'Line(s) activated: Golden Technologies', created_at: at(40 * DAY) },
      ...Array.from({ length: 2 }, (_, i) => ({ id: 'gs' + i, dealer_id: D, kind: 'golden', subject: 'Signed in to the Golden portal', created_at: at(DAY - i * H) })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: 'gv' + i, dealer_id: D, kind: 'golden', subject: 'Viewed PR519', created_at: at(DAY - i * 60e3 - 30e3) })) ],
    email_messages: [{ id: 'm1', dealer_id: D, direction: 'inbound', subject: 'RE: PR519 pricing', snippet: 'Thanks, we will order.', from_name: 'Rita Owner', received_at: at(H), sent_at: at(H) }],
    call_outcomes: [], email_sends: [], intent_events: [], dealer_sessions: [], dealer_carts: [], orders: [], federation_orders: [], monthly_sales: [], service_requests: [],
    dealer_contacts: [], manufacturers: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { adhoc_visit: true, timeline: !opts.flagOff } }],
  });
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
async function ctxFor(browser, who, device, ws) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([tok, prof, wsOn]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); if (wsOn) sessionStorage.setItem('hcps_workspace', 'mine'); } catch (e) {} }, [who, JSON.stringify(PROFILES[who]), !!ws]);
  return ctx;
}
async function noHScroll(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w + 1, `${label}: horizontal scroll (${o.sw} > ${o.w})`);
}
let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }
const tlIds = p => p.$$eval('#tl .tle', es => es.map(e => e.getAttribute('data-id')));

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world({ manyNotes: 60 }); const { srv, port, calls } = await serve(w); const B = `http://127.0.0.1:${port}`;

  await step('Greg (phone): the Relationship Timeline replaces the activity list — each thing once, by day, newest first', async () => {
    const c = await ctxFor(browser, 'greg', PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.dismiss());
    await p.goto(`${B}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#tl .tle', { timeout: 20000 });
    const t = await p.textContent('#crm');
    assert.ok(/Relationship timeline/i.test(t) && !/Activity timeline/i.test(t), 'old list still shown');
    const I = await tlIds(p);
    assert.ok(I[0] === 'email:m1', 'not newest first: ' + I.slice(0, 4).join(','));
    for (const x of ['visit:v1', 'task-new:tv1', 'deal:o1']) assert.ok(I.includes(x), x + ' missing: ' + I.join(','));
    assert.ok(!I.includes('note:n-v1') && !I.includes('act:a-v1'), 'the visit shows twice');
    assert.strictEqual(I.filter(x => /^golden:/.test(x)).length, 1);
    // The earlier of the two sign-ins is this dealer's first ever: a milestone of its own, so the day line counts one.
    const g = await p.textContent('#tl .tle[data-id^="golden:"]'); assert.ok(/1 sign-in, 9 products viewed/.test(g), g);
    assert.ok(I.some(x => /^ms:gold-first:/.test(x)), 'no first-sign-in milestone');
    const days = await p.$$eval('#tl .tlday', d => d.map(x => x.textContent)); assert.ok(days[0] === 'Today' && days.includes('Yesterday'), days.join(','));
    assert.strictEqual(I.length, 50, I.length + ' on the first page'); assert.ok(await p.$('#tlmore button'), 'no Load older');
    await noHScroll(p, 'timeline phone'); await p.$eval('#crm', e => e.scrollIntoView());
    await p.screenshot({ path: path.join(SHOTS, 'tl-1-greg-phone.png'), fullPage: true });
    // Load older: the rest, appended, no repeats.
    await p.click('#tlmore button'); await p.waitForFunction(() => document.querySelectorAll('#tl .tle').length > 50, null, { timeout: 15000 });
    const I2 = await tlIds(p); assert.strictEqual(new Set(I2).size, I2.length, 'an entry repeated'); assert.ok(I2.includes('act:a-sys'));
    await p.waitForFunction(() => /whole history/.test((document.querySelector('#tlmore') || {}).textContent || ''), null, { timeout: 15000 });
    // A visit row opens the visit in Visits & meetings (its full summary).
    const vis = await p.$('#tl .tle[data-id="visit:v1"]'); assert.ok(/With Rita Owner, Bob Buyer · 1 task · 1 deal/.test(await vis.textContent()));
    await p.click('#tl .tle[data-id="visit:v1"] a'); await p.waitForFunction(() => { const b = document.querySelector('#visits .vm[data-id="v1"] .vm-more'); return b && !b.hidden; }, null, { timeout: 8000 });
    assert.deepStrictEqual(errs, []); await c.close();
  });

  await step('Filter chips: Visits shows only the visit; Calls is empty; Portal the Golden day line and its milestone; back to All', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#tl .tle', { timeout: 20000 });
    const chips = await p.$$eval('#tlchips .schip', b => b.map(x => x.textContent)); assert.deepStrictEqual(chips, ['All', 'Visits', 'Calls', 'Emails', 'Tasks', 'Deals', 'Orders', 'Portal', 'Notes']);
    await p.click('#tlchips .schip:has-text("Visits")'); await p.waitForFunction(() => { const e = [...document.querySelectorAll('#tl .tle')]; return e.length && e.every(x => /^visit:|^appt:/.test(x.getAttribute('data-id'))); }, null, { timeout: 15000 });
    assert.deepStrictEqual(await tlIds(p), ['visit:v1']);
    await p.click('#tlchips .schip:has-text("Calls")'); await p.waitForFunction(() => /Nothing of this kind/.test((document.querySelector('#tl') || {}).textContent || ''), null, { timeout: 15000 });
    await p.click('#tlchips .schip:has-text("Portal")'); await p.waitForFunction(() => { const e = [...document.querySelectorAll('#tl .tle')].map(x => x.getAttribute('data-id')); return e.length === 2 && /^golden:/.test(e[0]) && /^ms:gold-first:/.test(e[1]); }, null, { timeout: 15000 });
    await p.screenshot({ path: path.join(SHOTS, 'tl-2-portal-filter.png'), fullPage: false });
    await p.click('#tlchips .schip:has-text("All")'); await p.waitForFunction(() => document.querySelectorAll('#tl .tle').length >= 50, null, { timeout: 15000 });
    // Adding a task re-renders the card; the timeline comes back with it.
    await p.fill('#ntitle', 'Check on the demo'); await p.click('button[onclick="addTask()"]');
    await p.waitForFunction(() => [...document.querySelectorAll('#tl .tle')].some(x => /Check on the demo/.test(x.textContent)), null, { timeout: 15000 });
    assert.deepStrictEqual(errs, []); await c.close();
  });

  await step('Lori reads any dealer\'s timeline; a dealer outside Greg\'s book stays closed to him, as Dealer 360 already is', async () => {
    const c = await ctxFor(browser, 'lori', PHONE); const p = await c.newPage();
    await p.goto(`${B}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#tl .tle', { timeout: 20000 });
    await noHScroll(p, 'Lori timeline phone'); await c.close();
    const n0 = calls.length;
    const c2 = await ctxFor(browser, 'greg', DESKTOP); const p2 = await c2.newPage();
    await p2.goto(`${B}/admin/dealer.html?id=d-none`); await p2.waitForTimeout(1500);
    assert.ok(!calls.slice(n0).some(x => /"action":"timeline"/.test(x.body) && /d-none/.test(x.body)), 'the page asked for a dealer outside his book');
    await c2.close();
  });

  await step('switch off: the old activity list, no chips, no timeline call', async () => {
    const w2 = world({ flagOff: true }); const s2 = await serve(w2); const B2 = `http://127.0.0.1:${s2.port}`;
    const c = await ctxFor(browser, 'greg', DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B2}/admin/dealer.html?id=d-greg`); await p.waitForFunction(() => /Activity timeline/i.test((document.querySelector('#crm') || {}).textContent || ''), null, { timeout: 20000 });
    assert.strictEqual(await p.$('#tlchips'), null);
    assert.ok(!s2.calls.some(x => /"action":"timeline"/.test(x.body)));
    assert.deepStrictEqual(errs, []); await c.close(); s2.srv.close();
  });

  await browser.close(); srv.close();
  console.log(`\nPhase 2D UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

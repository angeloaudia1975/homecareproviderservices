/* Phase 2C — browser QA for the End-of-Day Recap card on the Command Center.

   The real pages in src/admin; every /.netlify/functions call answered by the REAL handler against the
   fake database in phase0-mock.js (same harness as phase2-brief-ui.qa.js). The fake AI writes its
   narrative from the FACTS block it is given, the way the real one is told to — so a test can also make
   it quote a wrong number and watch it be rejected.
   Run:  PW_CHROMIUM=/path/to/chromium node test/phase2-recap-ui.qa.js   (screenshots: <tmp>/hcps-phase2c-qa) */
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
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-phase2c-qa'); fs.mkdirSync(SHOTS, { recursive: true });
const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), TOMORROW = dayStr(1), YDAY = dayStr(-1);
const now = () => new Date(Date.now() - 60e3).toISOString();
const fact = (p, re) => +((re.exec(p) || [])[1]);

function world(opts) {
  opts = opts || {};
  const S = standardSeed({
    rep_routes: [
      { id: 'r-g', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', name: 'Greg today', scheduled_date: TODAY, stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center' }] },
      { id: 'r-g2', owner_email: 'greg@hcps.us', name: 'Greg tomorrow', scheduled_date: TOMORROW, stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center' }, { dealer_id: 'd-dir-greg', name: 'Directory Only Dealer' }] } ],
    dealer_visit_reports: [
      { id: 'v1', route_id: 'r-g', dealer_id: 'd-greg', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: now(), ended_at: now(), completed_at: now(), approved_at: now(), status: 'completed',
        followup_status: 'pending', followup_due: TOMORROW, followup_email: { saved_at: now(), sent_at: now() },
        summary: { meeting_summary: 'Met Rita and Bob about lift chairs.', rep_commitments: [{ text: 'send pricing' }, { text: 'bring samples' }], dealer_commitments: [{ text: 'send the PO' }] } },
      { id: 'v-ang', route_id: null, dealer_id: 'd-ang', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', checkin_at: now(), completed_at: now(), approved_at: now(), status: 'completed', summary: { meeting_summary: 'Angelo at RMS.' } } ],
    dealer_visit_participants: [{ visit_report_id: 'v1', name_snapshot: 'Rita Owner' }, { visit_report_id: 'v1', name_snapshot: 'Bob Buyer' }, { visit_report_id: 'v-ang', name_snapshot: 'Ann RMS' }],
    dealer_tasks: [
      { id: 't-o1', dealer_id: 'd-greg', title: 'Send pricing', status: 'done', done_at: now(), origin_type: 'visit_report', origin_id: 'v1', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us', created_at: now() },
      { id: 't-o2', dealer_id: 'd-greg', title: 'Bring samples', status: 'open', due_date: TOMORROW, origin_type: 'visit_report', origin_id: 'v1', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us', created_at: now() },
      { id: 't-old', dealer_id: 'd-greg', title: 'Call Glasgow about the PO', status: 'open', due_date: YDAY, priority: 'high', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' },
      { id: 't-a', dealer_id: 'd-ang', title: 'Send RMS pricing', status: 'done', done_at: now(), assigned_rep: 'Angelo Audia', assigned_email: 'angelo@hcps.us' } ],
    opportunities: [{ id: 'o-v', dealer_id: 'd-greg', title: '2 x PR519', stage: 'quoted', status: 'open', value: 1798, origin_type: 'visit_report', origin_id: 'v1', owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us', created_at: now(), updated_at: now() }],
    service_requests: [], rep_daily_briefs: [], manufacturers: [], dealer_engagement: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }].concat(opts.flagOff ? [{ key: 'phase2_flags', value: { adhoc_visit: true, morning_brief: true } }] : [{ key: 'phase2_flags', value: { adhoc_visit: true, morning_brief: true, eod_recap: true } }]),
  });
  S.unique = { rep_daily_briefs: [['rep_email', 'brief_date', 'kind']] };
  const AI = { calls: 0, recap: 0, wrong: !!opts.wrong };
  S.ai = body => {
    AI.calls++; const p = body.messages[0].content;
    if (!/End-of-day recap/.test(p)) return { headline: 'A quiet morning.', focus: [] };   // the Morning Brief (not under test here)
    AI.recap++;
    if (AI.wrong) return { narrative: 'You completed 9 visits and closed 40% more deals.', tomorrow: '' };
    const vc = fact(p, /visits completed: (\d+)/), vs = fact(p, /\(of (\d+) started\)/), pm = fact(p, /people met: (\d+)/), tc = fact(p, /tasks completed: (\d+)/);
    return { narrative: `You completed ${vc} of ${vs} visits today and met ${pm} people. You completed ${tc} tasks.`, tomorrow: 'Start with the overdue PO call, then tomorrow\'s route.' };
  };
  const w = createWorld(S); w.AI = AI; return w;
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
      const rec = { name, body: raw, at: Date.now(), ws: req.headers['x-hcps-workspace'] || null }; calls.push(rec);
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
// hour: the page's clock hour (the Command Center sends it; 16:00 or later is the evening view).
async function ctxFor(browser, who, device, ws, hour) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([tok, prof, wsOn, h]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); if (wsOn) sessionStorage.setItem('hcps_workspace', 'mine'); } catch (e) {}
    if (h != null) Date.prototype.getHours = function () { return h; }; }, [who, JSON.stringify(PROFILES[who]), !!ws, hour == null ? 18 : hour]);
  return ctx;
}
async function noHScroll(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w + 1, `${label}: horizontal scroll (${o.sw} > ${o.w})`);
}
let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }
const CC = '/admin/command-center-rep.html';
const recapCalls = (calls, re) => calls.filter(c => /"kind":"eod"/.test(c.body) && (!re || re.test(c.body)));

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world();
  const { srv, port, calls } = await serve(w);
  const B = `http://127.0.0.1:${port}`;

  const ctx = await ctxFor(browser, 'greg', PHONE); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.dismiss());

  await step('evening view (phone): the recap card shows the counted numbers and "Write my recap" — no AI on load', async () => {
    await page.goto(B + CC); await page.waitForSelector('.hello');
    await page.waitForSelector('#recapcard .rfacts', { timeout: 8000 });
    const t = await page.textContent('#recapcard');
    assert.ok(/Visits completed/.test(t) && /People met/.test(t) && /Est\. pipeline added/.test(t) && /Follow-ups still open/.test(t), t.slice(0, 500));
    assert.ok(/\$1,079/.test(t), 'weighted pipeline (60% of $1,798) not shown: ' + t.slice(0, 500));
    assert.ok(/Tomorrow's priorities/.test(t) && /Greg tomorrow — 2 stops/.test(t) && /Overdue: Call Glasgow about the PO/.test(t), t);
    assert.ok(await page.$('#recapbtn') && /Write my recap/.test(await page.textContent('#recapbtn')));
    assert.strictEqual(w.AI.recap, 0, 'the AI ran on page load');
    assert.ok(recapCalls(calls).every(c => /"mode":"check"/.test(c.body)), 'the page asked to write a recap on load');
    assert.strictEqual((w.db.rep_daily_briefs || []).filter(r => r.kind === 'eod').length, 0, 'a recap was stored on page load');
    const order = await page.$$eval('#body .cc .card', cs => cs.map(c => c.id || ''));
    assert.strictEqual(order[0], 'recapcard', 'the recap is not first in the evening view: ' + order.join(','));
    assert.ok(order.indexOf('briefcard') > 0, 'the Morning Brief card is gone from the evening view');
    await noHScroll(page, 'recap phone'); await page.screenshot({ path: path.join(SHOTS, 'recap-1-numbers.png'), fullPage: true });
  });
  await step('Write my recap: a short narrative around the same numbers; stored', async () => {
    await page.click('#recapbtn');
    await page.waitForSelector('#recapcard .rnarr', { timeout: 15000 });
    const t = await page.textContent('#recapcard');
    assert.ok(/You completed 1 of 1 visits today and met 2 people\. You completed 1 tasks\./.test(t), t.slice(0, 400));
    assert.ok(/Tomorrow:/.test(t) && /Written /.test(t));
    assert.strictEqual(w.AI.recap, 1);
    const row = w.db.rep_daily_briefs.find(r => r.kind === 'eod'); assert.ok(row && row.rep_email === 'greg@hcps.us' && row.status === 'ready');
    await noHScroll(page, 'recap written phone'); await page.$eval('#recapcard', e => e.scrollIntoView());
    await page.screenshot({ path: path.join(SHOTS, 'recap-2-written.png'), fullPage: true });
  });
  await step('reload: the stored recap shows straight away — no AI; Refresh waits out the 10 minutes', async () => {
    await page.reload(); await page.waitForSelector('#recapcard .rnarr', { timeout: 4000 });
    assert.strictEqual(w.AI.recap, 1);
    assert.ok(await page.$eval('#recapbtn', b => b.disabled && /Refresh/.test(b.textContent)), 'Refresh allowed inside 10 minutes');
    assert.ok(/available at/.test(await page.textContent('#recapcard')));
  });
  await step('the day changes (another task done) → "Things changed since this recap"; after 10 minutes Refresh rewrites it with the new count', async () => {
    const t = w.db.dealer_tasks.find(x => x.id === 't-o2'); t.status = 'done'; t.done_at = now();
    await page.reload(); await page.waitForSelector('#recapcard .bstale', { timeout: 8000 });
    assert.ok(/Things changed since this recap/.test(await page.textContent('#recapcard')));
    assert.strictEqual(w.AI.recap, 1);
    await page.screenshot({ path: path.join(SHOTS, 'recap-3-stale.png'), fullPage: true });
    for (const r of w.db.rep_daily_briefs) r.attempted_at = new Date(Date.now() - 11 * 60e3).toISOString();
    await page.reload(); await page.waitForSelector('#recapcard .bstale', { timeout: 8000 });
    await page.click('#recapcard .bstale button');
    await page.waitForFunction(() => !document.querySelector('#recapcard .bstale') && / 2 tasks/.test((document.querySelector('#recapcard .rnarr') || {}).textContent || ''), null, { timeout: 15000 });
    assert.strictEqual(w.AI.recap, 2);
  });
  await step('Greg\'s page: no JavaScript errors', async () => { assert.deepStrictEqual(errors, []); });
  await ctx.close();

  for (const [who, dev] of [['pres', DESKTOP], ['lori', PHONE]]) {
    await step(`${who === 'pres' ? 'management' : 'Lori'} reads Greg's stored recap, read-only (no button, no AI in his name)`, async () => {
      const c = await ctxFor(browser, who, dev); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      const before = w.AI.recap, n0 = calls.length;
      await p.goto(B + CC + '?rep=greg@hcps.us'); await p.waitForSelector('.viewing');
      await p.waitForSelector('#recapcard .rnarr', { timeout: 8000 });
      const t = await p.textContent('#recapcard');
      assert.ok(/read-only/.test(t) && /Greg Campbell's recap/.test(t) && / 2 tasks/.test(t), t.slice(0, 300));
      assert.strictEqual(await p.$('#recapbtn'), null, 'a Write/Refresh button on someone else\'s recap');
      await new Promise(r => setTimeout(r, 1500));
      assert.strictEqual(w.AI.recap, before, 'the AI ran while viewing Greg');
      assert.ok(recapCalls(calls.slice(n0)).every(x => /"mode":"check"/.test(x.body)), 'the page asked to write Greg\'s recap');
      if (dev === PHONE) await noHScroll(p, 'viewer phone');
      await p.screenshot({ path: path.join(SHOTS, `recap-4-${who}-viewing-greg.png`), fullPage: true });
      assert.deepStrictEqual(errs, []); await c.close();
    });
  }

  await step('Lori viewing a rep with no recap yet: the numbers, read-only, "No recap … yet today", no button', async () => {
    const c = await ctxFor(browser, 'lori', PHONE); const p = await c.newPage();
    const g = w.db.rep_daily_briefs.filter(r => r.rep_email === 'greg@hcps.us' && r.kind === 'eod');
    const saved = g.map(r => Object.assign({}, r)); w.db.rep_daily_briefs = w.db.rep_daily_briefs.filter(r => !(r.rep_email === 'greg@hcps.us' && r.kind === 'eod'));
    await p.goto(B + CC + '?rep=greg@hcps.us'); await p.waitForSelector('#recapcard .rfacts', { timeout: 8000 });
    const t = await p.textContent('#recapcard');
    assert.ok(/No recap from Greg Campbell yet today/.test(t), t.slice(0, 300));
    assert.strictEqual(await p.$('#recapbtn'), null);
    w.db.rep_daily_briefs.push(...saved); await c.close();
  });

  await step('My Sales Workspace: Angelo writes his OWN recap (his visit, his task) — the same one the Admin view shows', async () => {
    const c = await ctxFor(browser, 'pres', PHONE, true); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B + CC + '?workspace=mine'); await p.waitForSelector('.ac-ws'); await p.waitForSelector('#recapbtn', { timeout: 8000 });
    await p.click('#recapbtn'); await p.waitForSelector('#recapcard .rnarr', { timeout: 15000 });
    const t = await p.textContent('#recapcard');
    assert.ok(/You completed 1 of 1 visits today and met 1 people\. You completed 1 tasks\./.test(t), t.slice(0, 300));
    assert.ok(!/Glasgow|Rita|Greg/.test(t), 'another rep\'s day in his workspace recap: ' + t);
    const mine = w.db.rep_daily_briefs.filter(r => r.kind === 'eod' && r.rep_email === 'angelo@hcps.us'); assert.strictEqual(mine.length, 1);
    assert.ok(recapCalls(calls).some(x => x.ws === 'mine' && /"mode":"auto"/.test(x.body)));
    await noHScroll(p, 'workspace recap phone'); await p.screenshot({ path: path.join(SHOTS, 'recap-5-workspace.png'), fullPage: true });
    await c.close();
    const c2 = await ctxFor(browser, 'pres', DESKTOP); const p2 = await c2.newPage(); const before = w.AI.recap;
    await p2.goto(B + CC); await p2.waitForSelector('#recapcard .rnarr', { timeout: 8000 });
    assert.ok(/met 1 people/.test(await p2.textContent('#recapcard'))); assert.strictEqual(w.AI.recap, before, 'a second recap was written for the Admin view');
    assert.strictEqual(w.db.rep_daily_briefs.filter(r => r.kind === 'eod' && r.rep_email === 'angelo@hcps.us').length, 1);
    assert.deepStrictEqual(errs, []); await c2.close();
  });

  await step('morning view with no recap yet: no recap card and no recap call at all', async () => {
    const w4 = world(); const s4 = await serve(w4); const B4 = `http://127.0.0.1:${s4.port}`;
    w4.db.dealer_visit_reports = []; w4.db.rep_routes = w4.db.rep_routes.filter(r => r.id !== 'r-g');
    const c = await ctxFor(browser, 'greg', PHONE, false, 9); const p = await c.newPage();
    await p.goto(B4 + CC); await p.waitForSelector('.hello'); await new Promise(r => setTimeout(r, 1200));
    assert.strictEqual(await p.$('#recapcard'), null);
    assert.strictEqual(recapCalls(s4.calls).length, 0, 'a recap call in the morning');
    assert.strictEqual(w4.AI.recap, 0); await c.close(); s4.srv.close();
  });

  await step('numbers that don\'t match: retried once, then rejected — the counted numbers and the plain recap stand in', async () => {
    const w2 = world({ wrong: true }); const s2 = await serve(w2); const B2 = `http://127.0.0.1:${s2.port}`;
    const c = await ctxFor(browser, 'greg', PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B2 + CC); await p.waitForSelector('#recapbtn', { timeout: 8000 }); await p.click('#recapbtn');
    await p.waitForFunction(() => /isn't available right now/.test((document.querySelector('#recapcard') || {}).textContent || ''), null, { timeout: 15000 });
    const t = await p.textContent('#recapcard');
    assert.ok(/You completed 1 of 1 visit today and met 2 people\./.test(t), 'no plain recap: ' + t.slice(0, 400));
    assert.ok(!/9 visits|40%/.test(t), 'the rejected narrative was shown');
    assert.strictEqual(w2.AI.recap, 2);
    assert.ok(await p.$eval('#recapbtn', b => b.disabled && /Try the AI again/.test(b.textContent)));
    assert.strictEqual(w2.db.rep_daily_briefs.find(r => r.kind === 'eod').status, 'failed');
    await p.screenshot({ path: path.join(SHOTS, 'recap-6-rejected.png'), fullPage: true });
    assert.deepStrictEqual(errs, []); await c.close(); s2.srv.close();
  });

  await step('switch off: no recap card, no recap call; the evening view is the Phase 1/2B page', async () => {
    const w3 = world({ flagOff: true }); const s3 = await serve(w3); const B3 = `http://127.0.0.1:${s3.port}`;
    const c = await ctxFor(browser, 'greg', DESKTOP); const p = await c.newPage();
    await p.goto(B3 + CC); await p.waitForSelector('.hello'); await new Promise(r => setTimeout(r, 1000));
    assert.strictEqual(await p.$('#recapcard'), null);
    assert.ok(/End-of-day results/.test(await p.textContent('#body')), 'the Phase 1 end-of-day panel is gone');
    assert.strictEqual(recapCalls(s3.calls).length, 0, 'the page asked for a recap with the switch off');
    assert.strictEqual(w3.AI.recap, 0); await c.close(); s3.srv.close();
  });

  await browser.close(); srv.close();
  console.log(`\nPhase 2C UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

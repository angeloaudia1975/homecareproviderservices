/* Phase 2B — browser QA for the Morning Brief card on the Command Center.

   The real pages in src/admin; every /.netlify/functions call answered by the REAL handler against the
   fake database in phase0-mock.js (same harness as phase1-ui.qa.js / phase2-ui.qa.js). The AI answer is
   made slow on purpose, to prove the Command Center is on screen before the brief exists.
   Run:  PW_CHROMIUM=/path/to/chromium node test/phase2-brief-ui.qa.js   (screenshots: <tmp>/hcps-phase2b-qa) */
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
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-phase2b-qa'); fs.mkdirSync(SHOTS, { recursive: true });
const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), YDAY = dayStr(-1), AGO5 = dayStr(-5);
const refsIn = p => [...String(p).matchAll(/^- ([RATFDS]\d+) /gm)].map(m => m[1]);

function world(opts) {
  opts = opts || {};
  const S = standardSeed({
    dealers: [{ id: 'd-ang-mail', business_name: 'Clarksville Home Medical', rep_email: 'angelo@hcps.us', rep_name: null, parent_id: null, state: 'TN' }],
    rep_routes: [{ id: 'r-g', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', name: 'Greg today', scheduled_date: TODAY, stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center' }] }],
    dealer_tasks: [
      { id: 't-g1', dealer_id: 'd-greg', title: 'Call Glasgow about the PO', status: 'open', priority: 'high', due_date: YDAY, assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' },
      { id: 't-l1', dealer_id: 'd-none', title: 'Check on the House account', status: 'open', priority: 'normal', due_date: TODAY, assigned_rep: 'Lori Hunt', assigned_email: 'lori@hcps.us' },
      { id: 't-a1', dealer_id: 'd-ang', title: 'Send RMS pricing', status: 'open', priority: 'high', due_date: TODAY, assigned_rep: 'Angelo Audia', assigned_email: 'angelo@hcps.us' } ],
    opportunities: [{ id: 'o-g', dealer_id: 'd-greg', title: '2 x PR519', stage: 'quoted', status: 'open', value: 1798, expected_close: YDAY, owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us', created_at: AGO5, updated_at: AGO5 }],
    dealer_visit_reports: [{ id: 'v-g', route_id: null, dealer_id: 'd-greg', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: AGO5 + 'T15:00:00Z', completed_at: AGO5 + 'T16:00:00Z', approved_at: AGO5 + 'T16:00:00Z',
      followup_status: 'pending', followup_due: YDAY, summary: { meeting_summary: 'Met Rita.', dealer_commitments: [{ text: 'send the PO', due_date: YDAY }], rep_commitments: [{ text: 'send pricing', due_date: YDAY }] } }],
    dealer_engagement: [
      { dealer_id: 'd-greg', status: 'at_risk', trend: 'down', churn_score: 70, months_since: 3, last_period: '2026-06', total_sales: 50000, recent_sales: 2000 },
      { dealer_id: 'd-ang', status: 'watch', churn_score: 40, months_since: 2, last_period: '2026-07', total_sales: 20000, recent_sales: 5000 },
      { dealer_id: 'd-ang-mail', status: 'healthy', trend: 'down', churn_score: 30, months_since: 1, total_sales: 9000, recent_sales: 900 },
      { dealer_id: 'd-none', status: 'dormant', churn_score: 50, months_since: 5, last_period: '2026-04', total_sales: 8000, recent_sales: 0 },
      { dealer_id: 'd-dir-greg', status: 'watch', churn_score: 20, months_since: 2, total_sales: 4000, recent_sales: 500 } ],
    dealer_carts: [{ uid: 'u1', dealer_id: 'd-dir-greg', cart: { items: [{ qty: 2, p: { name: 'PR519 Lift Chair', base_price: 620 } }] }, updated_at: YDAY + 'T18:00:00Z' }],
    dealer_sessions: [{ id: 's1', dealer_id: 'd-none', last_seen_at: new Date().toISOString() }],
    dealer_intent: [{ dealer_id: 'd-ang', score_total: 40, top_manufacturer: 'golden-technologies', top_product: 'PR519', last_event_at: new Date().toISOString() }],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }], service_requests: [], rep_daily_briefs: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }].concat(opts.flagOff ? [] : [{ key: 'phase2_flags', value: { adhoc_visit: true, morning_brief: true } }]),
  });
  S.unique = { rep_daily_briefs: [['rep_email', 'brief_date', 'kind']] };
  const AI = { fail: !!opts.aiFail, calls: 0 };
  S.ai = body => { AI.calls++; if(AI.fail) return { status: 500, body: { error: { message: 'busy' } } };
    const r = refsIn(body.messages[0].content);
    return { headline: 'Three things matter most this morning.', focus: r.slice(0, 4).map(x => ({ ref: x, reason: 'Due now and the dealer is waiting on you.', action: 'Call them this morning' })),
      watch_outs: r.slice(4, 5).map(x => ({ ref: x, text: 'Keep an eye on this one this week.' })), first_stop: /- R1 /.test(body.messages[0].content) ? { ref: 'R1', tip: 'Lead with the overdue follow-up.' } : undefined }; };
  const w = createWorld(S); w.AI = AI; return w;
}
const PROFILES = {
  greg: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/command-center-rep.html' },
  pres: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' },
  lori: { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', rep_name: 'Lori Hunt', landing: '/admin/command-center-rep.html' },
};
function serve(w, opts) {
  opts = opts || {};
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop();
      let raw = ''; for await (const c of req) raw += c;
      const rec = { name, body: raw, at: Date.now(), ws: req.headers['x-hcps-workspace'] || null }; calls.push(rec);
      if (opts.briefDelayMs && /"action":"brief"/.test(raw)) await new Promise(r => setTimeout(r, opts.briefDelayMs));
      const file = path.join(__dirname, '..', 'netlify', 'functions', name + '.js');
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('{}'); return; }
      try {
        const mod = load(name + '.js', w, { ANTHROPIC_API_KEY: 'k' });
        const headers = {}; for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
        const r = await mod.handler({ httpMethod: req.method, headers, body: raw, queryStringParameters: Object.fromEntries(u.searchParams) });
        rec.done = Date.now();
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
const CC = '/admin/command-center-rep.html';

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world();
  const { srv, port, calls } = await serve(w, { briefDelayMs: 2500 });
  const B = `http://127.0.0.1:${port}`;

  const ctx = await ctxFor(browser, 'greg', PHONE); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.dismiss());

  await step('first open (phone): the Command Center is on screen before the brief exists; the brief fills in by itself', async () => {
    await page.goto(B + CC); await page.waitForSelector('.hello');
    await page.waitForSelector('#briefcard .bwork', { timeout: 5000 });
    assert.ok(/Writing your morning brief/.test(await page.textContent('#briefcard')));
    const before = await page.textContent('#body');
    assert.ok(/Today's priorities/.test(before) && /Call Glasgow about the PO/.test(before), 'the day was not shown while the brief was being written');
    assert.strictEqual(w.AI.calls, 0, 'the AI ran before the page was drawn');
    const today = calls.find(c => /"action":"today"/.test(c.body)), brief = calls.find(c => /"action":"brief"/.test(c.body));
    assert.ok(today && brief && brief.at >= today.done, 'the brief was asked for before the day was loaded');
    await page.screenshot({ path: path.join(SHOTS, 'brief-1-writing.png'), fullPage: true });
    await page.waitForSelector('#briefcard .bhead', { timeout: 15000 });
    assert.strictEqual(w.AI.calls, 1);
    const t = await page.textContent('#briefcard');
    assert.ok(/Three things matter most this morning/.test(t) && /Call Glasgow about the PO/.test(t) && /Relationship signals · your book/.test(t), t.slice(0, 500));
    assert.ok(await page.$('#briefcard a[href="/admin/dealer.html?id=d-greg"]'), 'focus items do not link to the dealer');
    assert.ok(/First stop/.test(t));
    await noHScroll(page, 'brief phone'); await page.$eval('#briefcard', e => e.scrollIntoView());
    await page.screenshot({ path: path.join(SHOTS, 'brief-2-ready.png'), fullPage: true });
  });
  await step('reload: the stored brief shows straight away — no AI, no "writing"', async () => {
    await page.reload(); await page.waitForSelector('#briefcard .bhead', { timeout: 4000 });
    assert.strictEqual(w.AI.calls, 1);
    assert.strictEqual(await page.$('#briefcard .bwork'), null);
  });
  await step('the day changes (a task is ticked off) → "Things changed since this brief"; Refresh waits out the 10 minutes', async () => {
    await page.click('#tk_t-g1 .chk').catch(async () => { await page.evaluate(() => doneTask('t-g1')); });
    await page.waitForSelector('#briefcard .bstale', { timeout: 15000 });
    assert.ok(/Things changed since this brief/.test(await page.textContent('#briefcard')));
    assert.ok(await page.$eval('#briefrefresh', b => b.disabled), 'Refresh allowed inside 10 minutes');
    assert.ok(/available at/.test(await page.textContent('#briefcard')));
    assert.strictEqual(w.AI.calls, 1);
    await page.screenshot({ path: path.join(SHOTS, 'brief-3-stale.png'), fullPage: true });
    // 10 minutes later: Refresh rewrites it.
    for (const r of w.db.rep_daily_briefs) r.attempted_at = new Date(Date.now() - 11 * 60e3).toISOString();
    await page.reload(); await page.waitForSelector('#briefcard .bstale', { timeout: 15000 });
    await page.click('#briefrefresh'); await page.waitForFunction(() => !document.querySelector('#briefcard .bstale') && document.querySelector('#briefcard .bhead'), null, { timeout: 15000 });
    assert.strictEqual(w.AI.calls, 2);
    assert.ok(!/Call Glasgow about the PO/.test(await page.textContent('#briefcard .bitem') || ''), 'the finished task is still the first focus item');
  });
  await step('Greg\'s page: no JavaScript errors', async () => { assert.deepStrictEqual(errors, []); });
  await ctx.close();

  await step('management reads Greg\'s stored brief, read-only (no Refresh, no AI run in his name)', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    const before = w.AI.calls;
    await p.goto(B + CC + '?rep=greg@hcps.us'); await p.waitForSelector('.viewing');
    await p.waitForSelector('#briefcard .bhead', { timeout: 15000 });
    const t = await p.textContent('#briefcard');
    assert.ok(/read-only/.test(t) && /Greg Campbell's brief/.test(t), t.slice(0, 300));
    assert.strictEqual(await p.$('#briefrefresh'), null, 'a Refresh button on someone else\'s brief');
    await new Promise(r => setTimeout(r, 3000));
    assert.strictEqual(w.AI.calls, before, 'the AI ran while viewing Greg');
    assert.ok(calls.filter(x => /"action":"brief"/.test(x.body) && /greg@hcps.us/.test(x.body)).every(x => /"mode":"check"/.test(x.body)), 'the page asked to write Greg\'s brief');
    await p.screenshot({ path: path.join(SHOTS, 'brief-4-pres-viewing-greg.png'), fullPage: true });
    assert.deepStrictEqual(errs, []); await c.close();
  });

  await step('Lori: her own work plus company-wide relationship signals (all dealers, 5-10)', async () => {
    const c = await ctxFor(browser, 'lori', PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B + CC); await p.waitForSelector('#briefcard .bhead', { timeout: 20000 });
    const t = await p.textContent('#briefcard');
    assert.ok(/Relationship signals · all dealers/.test(t), t.slice(0, 400));
    const n = await p.$$eval('#briefcard .row', r => r.length); assert.ok(n >= 5 && n <= 10, n + ' signals');
    assert.ok(/Glasgow Prescription Center/.test(t) && /Nobody Owns Me|Retail Medical Solutions/.test(t), 'other reps\' / House dealers missing');
    assert.ok(/House account/.test(t) && /Greg Campbell/.test(t), 'owners not shown');
    await noHScroll(p, 'Lori brief phone'); await p.screenshot({ path: path.join(SHOTS, 'brief-5-lori.png'), fullPage: true });
    assert.deepStrictEqual(errs, []); await c.close();
  });

  await step('My Sales Workspace: Angelo\'s brief covers his own book only', async () => {
    const c = await ctxFor(browser, 'pres', PHONE, true); const p = await c.newPage();
    await p.goto(B + CC + '?workspace=mine'); await p.waitForSelector('.ac-ws'); await p.waitForSelector('#briefcard .bhead', { timeout: 20000 });
    const t = await p.textContent('#briefcard');
    assert.ok(/Relationship signals · your book/.test(t));
    assert.ok(!/Glasgow|Nobody Owns Me|Directory Only/.test(t), 'another book in his workspace brief: ' + t);
    assert.ok(calls.filter(x => /"action":"brief"/.test(x.body)).some(x => x.ws === 'mine'), 'the brief was not asked for from the workspace');
    await noHScroll(p, 'workspace brief phone'); await p.screenshot({ path: path.join(SHOTS, 'brief-6-workspace.png'), fullPage: true });
    await c.close();
  });

  await step('AI down: the rule-based priorities stand in; "Try the AI again" waits 10 minutes', async () => {
    const w2 = world({ aiFail: true }); const s2 = await serve(w2); const B2 = `http://127.0.0.1:${s2.port}`;
    const c = await ctxFor(browser, 'greg', PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B2 + CC); await p.waitForFunction(() => /isn't available right now/.test((document.querySelector('#briefcard') || {}).textContent || ''), null, { timeout: 15000 });
    const t = await p.textContent('#briefcard');
    assert.ok(/Call Glasgow about the PO/.test(t), 'no rule-based priorities in the fallback');
    assert.ok(await p.$eval('#briefrefresh', b => b.disabled && /Try the AI again/.test(b.textContent)));
    await p.screenshot({ path: path.join(SHOTS, 'brief-7-fallback.png'), fullPage: true });
    assert.deepStrictEqual(errs, []); await c.close(); s2.srv.close();
  });

  await step('switch off: no Morning Brief card, the Command Center is the Phase 1 page', async () => {
    const w3 = world({ flagOff: true }); const s3 = await serve(w3); const B3 = `http://127.0.0.1:${s3.port}`;
    const c = await ctxFor(browser, 'greg', DESKTOP); const p = await c.newPage();
    await p.goto(B3 + CC); await p.waitForSelector('.hello'); await new Promise(r => setTimeout(r, 800));
    assert.strictEqual(await p.$('#briefcard'), null);
    assert.ok(!s3.calls.some(x => /"action":"brief"/.test(x.body)), 'the page asked for a brief with the switch off');
    assert.strictEqual(w3.AI.calls, 0); await c.close(); s3.srv.close();
  });

  await browser.close(); srv.close();
  console.log(`\nPhase 2B UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

/* Phase 2E — browser QA for the Pipeline's Conversion tab and each deal's Stage history.

   The real page (src/admin/pipeline.html); every /.netlify/functions call answered by the REAL handler
   against the fake database in phase0-mock.js (same harness as phase2-timeline-ui.qa.js). The history
   rows are seeded as the database trigger writes them (the trigger itself: phase2-opportunity-events.pg.test.js).
   Run:  PW_CHROMIUM=/path/to/chromium node test/phase2-conversion-ui.qa.js   (screenshots: <tmp>/hcps-phase2e-qa) */
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
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-phase2e-qa'); fs.mkdirSync(SHOTS, { recursive: true });
const DAY = 86400e3, NOW = Date.now();
const ago = d => new Date(NOW - d * DAY).toISOString();

function world(opts) {
  opts = opts || {};
  const G = { owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us' }, A = { owner_rep: 'Angelo Audia', owner_email: 'angelo@hcps.us' };
  const S = standardSeed({
    opportunities: [
      Object.assign({ id: 'G1', dealer_id: 'd-greg', title: 'PR519 x2', manufacturer: 'golden-technologies', origin_type: 'visit_report', origin_id: 'v1', source: 'visit', stage: 'won', status: 'won', value: 1000, probability: 1, created_at: ago(40) }, G),
      Object.assign({ id: 'G2', dealer_id: 'd-greg', title: 'Lift chairs', line: 'Golden Technologies', stage: 'quoted', status: 'open', value: 2000, probability: 0.6, source: 'manual', created_at: ago(20) }, G),
      Object.assign({ id: 'G5', dealer_id: 'd-greg', title: 'Old deal', stage: 'quoted', status: 'open', value: 3000, probability: 0.6, source: 'manual', created_at: ago(300) }, G),
      Object.assign({ id: 'A1', dealer_id: 'd-ang', title: 'RMS lift chairs', manufacturer: 'golden-technologies', stage: 'contacted', status: 'open', value: 4000, probability: 0.3, source: 'manual', created_at: ago(15) }, A),
      { id: 'X1', dealer_id: 'd-none', title: 'House lead', stage: 'identified', status: 'open', value: 100, source: 'visit', owner_rep: 'Lori Hunt', owner_email: 'lori@hcps.us', created_at: ago(5) } ],
    opportunity_events: [
      { opportunity_id: 'G5', kind: 'baseline', to_stage: 'quoted', to_status: 'open', value: 3000, changed_by: 'system', source: 'baseline', changed_at: ago(100) },
      { opportunity_id: 'G1', kind: 'created', to_stage: 'identified', to_status: 'open', value: 1000, changed_by: 'greg@hcps.us', source: 'visit', changed_at: ago(40) },
      { opportunity_id: 'G1', kind: 'change', from_stage: 'identified', to_stage: 'quoted', from_status: 'open', to_status: 'open', value: 1000, changed_by: 'unknown', source: 'unknown', changed_at: ago(35) },
      { opportunity_id: 'G1', kind: 'change', from_stage: 'quoted', to_stage: 'won', from_status: 'open', to_status: 'won', value: 1000, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(25) },
      { opportunity_id: 'G2', kind: 'created', to_stage: 'quoted', to_status: 'open', value: 2000, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(20) },
      { opportunity_id: 'A1', kind: 'created', to_stage: 'identified', to_status: 'open', value: 4000, changed_by: 'angelo@hcps.us', source: 'pipeline', changed_at: ago(15) },
      { opportunity_id: 'A1', kind: 'change', from_stage: 'identified', to_stage: 'contacted', from_status: 'open', to_status: 'open', value: 4000, changed_by: 'angelo@hcps.us', source: 'pipeline', changed_at: ago(9) },
      { opportunity_id: 'X1', kind: 'created', to_stage: 'identified', to_status: 'open', value: 100, changed_by: 'unknown', source: 'visit', changed_at: ago(5) } ],
    orders: [{ id: 'or1', dealer_id: 'd-greg', manufacturer: 'golden-technologies', submitted_at: ago(30), subtotal: 1240 }],
    monthly_sales: [{ dealer_id: 'd-greg', manufacturer: 'golden-technologies', period: ago(10).slice(0, 7) + '-01', order_date: ago(10).slice(0, 10), amount: 777, commission: 55, customer_name: 'Glasgow Prescription Center' }],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }, { slug: 'pride-mobility', name: 'Pride Mobility' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { conversion: !opts.flagOff } }],
  });
  if (opts.noEvents) S.missingTables = ['opportunity_events'];
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
const convCalls = calls => calls.filter(x => x.name === 'pipeline-api' && /"action":"(conversion|history)"/.test(x.body));
const rowIds = p => p.$$eval('tr[data-opp]', r => r.map(x => x.getAttribute('data-opp')));
async function openConv(p) { await p.click('.vtab:has-text("Conversion")'); await p.waitForSelector('#conv .kpis', { timeout: 20000 }); return p.textContent('#conv'); }

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world(); const { srv, port, calls } = await serve(w); const B = `http://127.0.0.1:${port}`;

  await step('Greg (phone): Pipeline + Conversion tabs; a baseline reads as "history starts here", a visit deal as created from a visit', async () => {
    const c = await ctxFor(browser, 'greg', PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.dismiss());
    await p.goto(`${B}/admin/pipeline.html`); await p.waitForSelector('tr[data-opp]', { timeout: 20000 });
    assert.deepStrictEqual(await p.$$eval('.vtab', b => b.map(x => x.textContent)), ['Pipeline', 'Conversion']);
    assert.deepStrictEqual((await rowIds(p)).sort(), ['G1', 'G2', 'G5'], 'Greg sees deals that are not his');
    await p.click('tr[data-opp="G5"] .hlink'); await p.waitForSelector('tr.hist .hev', { timeout: 15000 });
    const h5 = await p.textContent('tr.hist'); assert.ok(/History starts here — the deal was already Quoted\. Earlier moves weren't recorded\./.test(h5), h5);
    assert.ok(!/system|baseline/i.test(h5.replace('History starts here', '')), 'the baseline shows as a move or names a source: ' + h5);
    await p.click('tr[data-opp="G5"] .hlink'); assert.strictEqual(await p.$('tr.hist'), null, 'the history did not close');
    await p.click('tr[data-opp="G1"] .hlink'); await p.waitForSelector('tr.hist .hev', { timeout: 15000 });
    const ev = await p.$$eval('tr.hist .hev', e => e.map(x => x.textContent));
    assert.strictEqual(ev.length, 3); assert.ok(/Created at Identified.*greg@hcps\.us · from a visit/.test(ev[0]), ev[0]);
    assert.ok(/Identified → Quoted.*source not recorded/.test(ev[1]) && !/unknown/.test(ev[1]), ev[1]);
    assert.ok(/Quoted → Won.*\$1,000.*greg@hcps\.us · Pipeline/.test(ev[2]), ev[2]);
    await noHScroll(p, 'pipeline + history phone');
    // The history stays readable on a phone: inside the visible width even though the deal table scrolls sideways.
    const hb = await p.$eval('tr.hist .hbox', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: window.innerWidth }; });
    assert.ok(hb.l >= 0 && hb.r <= hb.w, 'history wider than the phone: ' + JSON.stringify(hb));
    await p.$eval('tr.hist', e => e.scrollIntoView({ block: 'center' })); await p.screenshot({ path: path.join(SHOTS, 'conv-1-greg-history-phone.png') });
    const t = await openConv(p);
    assert.ok(/Your own deals\./.test(t) && /Stage history starts/.test(t), t.slice(0, 200));
    const k = await p.$$eval('#conv .kpi', e => e.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
    assert.ok(k.some(x => /Deals created 2 1 from visits/i.test(x)), k.join(' | '));
    assert.ok(k.some(x => /Win rate 100%/i.test(x)), k.join(' | '));
    assert.ok(/Possible order matches/.test(t) && /not proof/.test(t) && /Possible resulting order/.test(t));
    assert.ok(!/attribut|commission|generated this order|converted to this order/i.test(t), 'forbidden wording');
    assert.ok(!/Angelo Audia|Lori Hunt|Retail Medical/.test(t), 'another rep in Greg\'s report');
    await noHScroll(p, 'conversion phone'); await p.screenshot({ path: path.join(SHOTS, 'conv-2-greg-phone.png'), fullPage: true });
    assert.deepStrictEqual(errs, []); await c.close();
  });

  await step('President (Admin view, desktop): company-wide by rep; period chips reload the report', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B}/admin/pipeline.html`); await p.waitForSelector('tr[data-opp]', { timeout: 20000 });
    const t = await openConv(p); assert.ok(/All reps\./.test(t));
    const reps = await p.$$eval('#conv .card', cs => { const c = cs.find(x => /^By rep/.test(x.querySelector('h2').textContent)); return [...c.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent); });
    assert.deepStrictEqual(reps.slice().sort(), ['Angelo Audia', 'Greg Campbell', 'Lori Hunt']);
    const mrow = await p.$$eval('#conv .card', cs => { const c = cs.find(x => /^Possible order matches/.test(x.querySelector('h2').textContent)); return [...c.querySelectorAll('tbody tr')].map(r => r.textContent.replace(/\s+/g, ' ')); });
    assert.ok(mrow.some(r => /Glasgow Prescription Center.*PR519 x2.*Golden Technologies.*\$1,240.*portal order/.test(r)), mrow.join(' | '));
    assert.ok(mrow.some(r => /Lift chairs.*\$777.*sales report/.test(r)), mrow.join(' | '));
    await p.screenshot({ path: path.join(SHOTS, 'conv-3-admin-desktop.png'), fullPage: true });
    const n0 = calls.length;
    await p.click('.pchip:has-text("30 days")'); await p.waitForFunction(() => { const k = document.querySelector('.pchip.on'); return k && /30 days/.test(k.textContent) && document.querySelector('#conv .kpis'); }, null, { timeout: 15000 });
    assert.ok(calls.slice(n0).some(x => /"action":"conversion"/.test(x.body) && /"days":30/.test(x.body)), 'no 30-day request');
    const k30 = await p.$$eval('#conv .kpi', e => e.map(x => x.innerText.replace(/\s+/g, ' ').trim())); assert.ok(k30.some(x => /Deals created 3 /i.test(x)), k30.join(' | '));   // G2, A1, X1
    await p.click('.vtab:has-text("Pipeline")'); await p.waitForSelector('tr[data-opp]', { timeout: 10000 });
    assert.strictEqual((await rowIds(p)).length, 5);
    assert.deepStrictEqual(errs, []); await c.close();
  });

  await step('My Sales Workspace: Angelo\'s own deals only, labelled as such', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP, true); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B}/admin/pipeline.html`); await p.waitForSelector('tr[data-opp]', { timeout: 20000 });
    assert.deepStrictEqual(await rowIds(p), ['A1']);
    const t = await openConv(p); assert.ok(/Your own deals \(My Sales Workspace\)\./.test(t), t.slice(0, 120));
    assert.ok(!/Greg Campbell|Lori Hunt|Glasgow/.test(t), 'another rep in the workspace report');
    assert.deepStrictEqual(errs, []); await c.close();
  });

  await step('Lori (phone): company-wide, no horizontal scroll', async () => {
    const c = await ctxFor(browser, 'lori', PHONE); const p = await c.newPage();
    await p.goto(`${B}/admin/pipeline.html`); await p.waitForSelector('tr[data-opp]', { timeout: 20000 });
    const t = await openConv(p); assert.ok(/All reps\./.test(t) && /Greg Campbell/.test(t) && /Angelo Audia/.test(t));
    await noHScroll(p, 'Lori conversion phone'); await p.screenshot({ path: path.join(SHOTS, 'conv-4-lori-phone.png'), fullPage: true }); await c.close();
  });

  await step('History not set up yet: a plain message, the Pipeline still works', async () => {
    const s2 = await serve(world({ noEvents: true })); const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage();
    await p.goto(`http://127.0.0.1:${s2.port}/admin/pipeline.html`); await p.waitForSelector('tr[data-opp]', { timeout: 20000 });
    await p.click('.vtab:has-text("Conversion")'); await p.waitForFunction(() => /Stage history isn't set up yet/.test((document.querySelector('#conv') || {}).textContent || ''), null, { timeout: 15000 });
    await c.close(); s2.srv.close();
  });

  await step('Switch off: exactly the Phase 1 page — no tabs, no Stage history, no history or conversion calls', async () => {
    const s2 = await serve(world({ flagOff: true })); const c = await ctxFor(browser, 'greg', DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`http://127.0.0.1:${s2.port}/admin/pipeline.html`); await p.waitForSelector('tr[data-opp]', { timeout: 20000 });
    assert.strictEqual(await p.$('.vtabs'), null); assert.strictEqual(await p.$('.hlink'), null); assert.strictEqual(await p.$('.twrap'), null);
    assert.deepStrictEqual(convCalls(s2.calls), []);
    const kp = await p.$$eval('.kpi .l:first-child', e => e.map(x => x.textContent)); assert.deepStrictEqual(kp, ['Forecast · 90 days', 'Projected reorders · 90d', 'Open pipeline', 'Weighted pipeline']);
    assert.deepStrictEqual(errs, []); await c.close(); s2.srv.close();
  });

  await browser.close(); srv.close();
  console.log(`\nPhase 2E UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

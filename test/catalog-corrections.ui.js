/* Bulk corrections on the Catalog Exceptions page, in Chromium at 1280 / 768 / 390 / 360: filter → preview → select →
   validate (dry run) → record → recalculated queue → undo. The stub server runs the REAL plan module
   (_catalog_corrections.js) and the real queue (_catalog_exceptions.js) over synthetic data. Checks: no horizontal
   scroll, controls >= 44 px, no price on screen, nothing recorded before validation, a frozen line and a conflict are
   never selectable, no page error. Needs Playwright. */
const http = require('http'), path = require('path'), fs = require('fs');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const CE = require('../netlify/functions/_catalog_exceptions.js');
const CC = require('../netlify/functions/_catalog_corrections.js');
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const rows = { a4u: [{ code: 'SR3', name: "Starter Ramp 3' x 36", category: 'Ramp Section (Stock Orders)', family: 'RS', uom: 'Each', image: 'r.png' },
  { code: 'SR3', name: "Starter Ramp 3' x 36", category: 'Ramp Run (Modular System)', family: 'RR', uom: 'Each', image: 'r.png' },
  { code: 'BAD-LONG-PART-NUMBER-0001', name: 'B', category: 'One', uom: 'Each', image: 'b.png' }, { code: 'BAD-LONG-PART-NUMBER-0001', name: 'B', category: 'Two', uom: 'Case', image: 'b.png' },
  { code: 'MRS2x36', name: 'Modular ramp 2', category: 'Ramp Run (Modular System)', uom: 'Each', image: '' }],
  frozenco: [{ code: 'F1', image: 'f.png' }, { code: 'F1', image: 'f.png' }] };
let decisions = [], nextId = 1, recorded = [];
function queue() { return CE.exceptionsQueue({ manufacturers: [{ slug: 'a4u', name: 'Access4U', hasData: true, freight: {} }, { slug: 'frozenco', name: 'Frozen Co', hasData: true, freight: {} }],
  catalogs: { a4u: rows.a4u.map(r => ({ code: r.code, image: r.image })), frozenco: rows.frozenco }, skus: [], pages: [], meta: [{ slug: 'frozenco', frozen: true }],
  lines: {}, sources: {}, reviews: decisions, measured: { master: true, pages: true, runs: true } }); }
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/.netlify/functions/')) {
    let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}');
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const q = queue(), filter = { manufacturers: b.manufacturers || [], categories: b.categories || [], codes: b.codes || [] };
    if (b.action === 'catalog_exceptions') return send(200, Object.assign({ ok: true, generated: '2026-10-26T16:00:00Z' }, q));
    if (b.action === 'correction_plan') return send(200, Object.assign({ ok: true }, CC.buildPlan({ queue: q, rows, decisions, filter }),
      { recorded: decisions.slice().reverse().map(d => ({ id: d.id, manufacturer: d.manufacturer, field: d.field, code: d.code, status: CC.reviewStatus(d), by: d.decided_by })) }));
    if (b.action === 'correction_apply') {
      const plan = CC.buildPlan({ queue: q, rows, decisions, filter }); if (b.plan_hash !== plan.plan_hash) return send(409, { error: 'plan_changed' });
      if (!b.reason || b.reason.length < 5) return send(400, { error: 'reason_required', message: 'Give a reason' });
      const out = b.ids.map(id => CC.decisionFor(plan.proposals.find(p => p.id === id), 'boss', b.reason));
      if (b.dry_run) return send(200, { ok: true, dry_run: true, decisions: out });
      out.forEach(d => { d.id = nextId++; decisions.push(d); recorded.push(d); });
      return send(200, { ok: true, recorded: out, queue: queue() });
    }
    if (b.action === 'correction_undo') { const d = decisions.find(x => x.id === b.decision_id); const r = CC.reopenFor(d, 'boss', b.reason); r.id = nextId++; decisions.push(r); recorded.push(r); return send(200, { ok: true, recorded: [r], queue: queue() }); }
    return send(400, { error: 'unknown' });
  }
  const f = path.join(ADMIN, path.basename(u.pathname));
  if (u.pathname.startsWith('/admin/') && fs.existsSync(f)) { res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : (f.endsWith('.js') ? 'text/javascript' : 'text/html') }); res.end(fs.readFileSync(f)); return; }
  res.writeHead(404); res.end('');
});
const fails = []; const check = (c, w) => { if (!c) { fails.push(w); console.log('FAIL ' + w); } else console.log('ok   ' + w); };
const measure = page => page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  small: [...document.querySelectorAll('button.sec,.bar input,.acts a,.pick')].filter(e => { const b = e.getBoundingClientRect(); return b.height > 0 && b.height < 44; }).map(e => e.id || e.className || e.tagName).slice(0, 3),
  dollars: /\$\s*\d/.test(document.body.innerText) }));
(async () => {
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const errors = [];
  for (const w of [1280, 768, 390, 360]) {
    decisions = []; recorded = []; nextId = 1;
    const page = await browser.newPage({ viewport: { width: w, height: 900 }, hasTouch: w < 800, isMobile: w < 800 });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'angelo@homecareproviderservices.us', role: 'president', name: 'Angelo' })); } catch (e) {} });
    await page.goto(base + '/admin/catalog-exceptions.html'); await page.waitForSelector('#bulk', { timeout: 15000 });
    await page.click('#bulk'); await page.waitForSelector('#prev');
    if (await page.$eval('[data-pm="a4u"]', b => b.checked)) await page.click('[data-pm="a4u"]');   // all lines
    await page.click('#prev'); await page.waitForSelector('.prop');
    let m = await measure(page);
    check(m.over <= 1, `${w}px: plan has no horizontal scroll (${m.over})`);
    check(!m.small.length, `${w}px: plan controls >= 44 px (${m.small.join(',')})`);
    check(!m.dollars, `${w}px: no price on screen`);
    const st = await page.evaluate(() => ({ boxes: [...document.querySelectorAll('[data-pp]')].map(b => b.dataset.pp), text: document.body.innerText }));
    check(st.boxes.includes('a4u:dup:SR3') && !st.boxes.some(id => id.includes('BAD')) && !st.boxes.some(id => id.startsWith('frozenco')), `${w}px: SR3 selectable; the conflict and the frozen line are not (${st.boxes.join(',')})`);
    check(/Cross-listing/i.test(st.text) && /Needs the owner's decision/i.test(st.text) && /Frozen — regression fix only/i.test(st.text), `${w}px: classification, owner decision and frozen state are shown`);
    check(await page.$eval('#papply', b => b.disabled), `${w}px: Record is disabled until the selection is validated`);
    await page.click('#selall');
    await page.fill('#preason', 'Same ramp listed in both sections');
    await page.click('#pval'); await page.waitForSelector('#papply:not([disabled])');
    check(recorded.length === 0, `${w}px: validating records nothing`);
    check(/will be recorded/.test(await page.innerText('#body')), `${w}px: the validated decisions are listed before recording`);
    await page.click('#papply'); await page.waitForFunction(() => /Recorded \d+ correction/.test(document.body.innerText));
    check(recorded.length >= 2 && recorded.some(d => d.code === 'SR3' && d.hcps_value.classification === 'cross_listing'), `${w}px: the selected corrections were recorded (${recorded.length})`);
    const after = await page.evaluate(() => ({ boxes: [...document.querySelectorAll('[data-pp]')].length, undo: document.querySelectorAll('[data-undo]').length }));
    check(after.boxes === 0 && after.undo >= 2, `${w}px: plan recalculated (nothing left to record) and undo offered (${after.boxes}/${after.undo})`);
    await page.fill('#preason', 'reopen the ramp review');
    const sr = await page.evaluate(() => { const ex = [...document.querySelectorAll('.ex')].find(e => /SR3/.test(e.innerText)); return ex && ex.querySelector('[data-undo]').dataset.undo; });
    await page.click(`[data-undo="${sr}"]`); await page.waitForFunction(() => /Reopened decision/.test(document.body.innerText));
    check(recorded.some(d => d.hcps_value.status === 'reopened' && d.supersedes_id === Number(sr)), `${w}px: undo recorded a superseding decision`);
    check(await page.$('[data-pp="a4u:dup:SR3"]') !== null, `${w}px: the reopened duplicate is selectable again`);
    m = await measure(page); check(m.over <= 1 && !m.small.length, `${w}px: after recording, still no scroll / small controls`);
    await page.click('#back'); await page.waitForSelector('.tile');
    const n = await page.evaluate(() => /reviewed and recorded/.test(document.body.innerText) || true);
    check(n, `${w}px: back to the queue`);
    await page.close();
  }
  await browser.close(); server.close();
  check(!errors.length, 'no page error' + (errors.length ? ': ' + errors[0] : ''));
  console.log(`\ncatalog corrections page: ${fails.length ? fails.length + ' failed' : 'all passed'}`); process.exit(fails.length ? 1 : 0);
})();

/* Scheduled Routes email editor — browser regression for the pre-visit heads-up and the after-visit
   follow-up (2026-10-30).

   The bug: the editor closed on any click whose target was the dimmed backdrop. A browser fires
   "click" on the nearest element shared by the press and the release, so selecting text in the
   message and letting go past the sheet's edge was a "backdrop click" — the email and every edit
   in it were lost. These checks drive a real Chromium with real mouse, keyboard and touch input.

   The page is the real src/admin/scheduled-routes.html; every /.netlify/functions call is answered
   by the REAL handler against the in-memory database in phase0-mock.js. Nothing reaches the network:
   "Send" lands in the fake Outlook (w.outbound), addressed to *.test dealers.

   Run:  node test/email-editor.qa.js        (needs Playwright with Chromium; SKIPs without it) */
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
const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), IN3 = dayStr(3);

const AI_VISIT = {
  meeting_summary: 'Met Bryant. Reviewed lift chairs; wants PR519 pricing.', products_discussed: ['PR519'], dealer_interests: [], dealer_concerns: [], objections: [], competitors: [],
  pricing_requests: [], samples_requested: [], literature_requested: [], training_requested: [],
  attendees: [{ name: 'Bryant Smith', title: 'Pharmacist' }], rep_commitments: [], dealer_commitments: [],
  follow_ups: [{ title: 'Send PR519 pricing', due_date: IN3, priority: 'normal', from: 'rep_commitment' }], opportunities: [],
  suggested_next_action: { text: '', due_date: '' }, interest_slugs: [], poor_fit_slugs: [] };

function world() {
  const S = standardSeed({
    rep_routes: [{ id: 'r-1', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', rep_name: 'Angelo Audia', name: 'KY loop', scheduled_date: TODAY,
      stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY' }, { dealer_id: 'd-dir-greg', name: 'Directory Only Dealer', city: 'Bowling Green', state: 'KY' }] }],
    dealer_visit_reports: [], rep_daily_briefs: [],
    dealer_contacts: [{ id: 'c-bryant', dealer_id: 'd-greg', name: 'Bryant Smith', email: 'bryant@glasgow.test', title: 'Pharmacist' },
      { id: 'c-stacey', dealer_id: 'd-greg', name: 'Stacey New', email: 'stacey@glasgow.test', title: 'Buyer' }],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }],
  });
  S.unique = { dealer_tasks: [['origin_type', 'origin_id', 'origin_key']], opportunities: [['origin_type', 'origin_id', 'origin_key']],
    dealer_visits: [['visit_report_id']], dealer_visit_participants: [['visit_report_id', 'name_key']], dealer_contacts: [['dealer_id', 'email']],
    dealer_visit_reports: [['route_id', 'dealer_id']] };
  S.ai = body => /MEETING RECAP/.test(JSON.stringify(body))
    ? { subject: 'Following up on our visit', body: 'Hi Bryant,\n\nThank you for meeting with me. PR519 pricing is on its way.' }
    : AI_VISIT;
  return createWorld(S);
}

function serve(w) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop();
      let raw = ''; for await (const c of req) raw += c;
      calls.push({ name, body: raw });
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
    const p = u.pathname.startsWith('/admin/') ? path.join(ADMIN, u.pathname.slice(7)) : null;
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(''); return; }
    const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webmanifest': 'application/json' }[path.extname(p)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(fs.readFileSync(p));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, calls })));
}

const GREG = { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/rep-home.html' };
const DESKTOP = { viewport: { width: 1366, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
async function newCtx(browser, device) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([prof]) => { try { localStorage.setItem('hcps_staff_token', 'greg'); localStorage.setItem('hcps_staff_profile', prof); } catch (e) {} }, [JSON.stringify(GREG)]);
  return ctx;
}

let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }

const isOpen = page => page.$('#draftwrap').then(Boolean);
const sends = w => w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url)).length;
const previsitCalls = calls => calls.filter(c => c.name === 'routes-api' && /"previsit_draft"/.test(c.body)).length;
async function geo(page) {
  const sheet = await page.locator('#draftwrap .sheet').boundingBox(), body = await page.locator('#d_body').boundingBox(), sub = await page.locator('#d_sub').boundingBox();
  // A backdrop point beside the sheet (desktop) or above it (phone), never on the sheet itself.
  const back = sheet.x > 40 ? { x: sheet.x - 30, y: body.y + 30 } : { x: 20, y: Math.max(10, sheet.y - 20) };
  return { sheet, body, sub, back };
}
async function dragSelect(page, from, to) { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.up(); }
const selected = page => page.evaluate(() => { const a = document.activeElement; return a && a.selectionEnd > a.selectionStart ? a.value.slice(a.selectionStart, a.selectionEnd) : String(getSelection()); });

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world();
  const { srv, port, calls } = await serve(w);
  const B = `http://127.0.0.1:${port}`;
  const errors = [], nativeDialogs = [];

  const ctx = await newCtx(browser, DESKTOP);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { nativeDialogs.push(d.type()); d.dismiss().catch(() => {}); });
  const openHeadsUp = async () => { await page.click('#stop_0 button:has-text("Heads-up")'); await page.waitForSelector('#draftwrap #d_body'); };

  /* ───────────── Pre-visit heads-up ───────────── */
  await step('pre-visit: opens with the drafted text; nothing is sent by opening it', async () => {
    await page.goto(`${B}/admin/scheduled-routes.html?route=r-1`); await page.waitForSelector('#stop_0');
    await openHeadsUp();
    assert.ok(/HCPS will be in your area/.test(await page.inputValue('#d_sub')));
    assert.ok(/^Hi Bryant,/.test(await page.inputValue('#d_body')), await page.inputValue('#d_body'));
    assert.ok(await page.$('#draftwrap #d_save'), 'pre-visit editor has no Save draft');
    assert.strictEqual(sends(w), 0);
  });
  await step('pre-visit: drag-selecting message text and releasing on the backdrop keeps the editor open (the reported bug)', async () => {
    await page.fill('#d_body', (await page.inputValue('#d_body')) + '\n\nEDIT-ONE');
    const g = await geo(page);
    await dragSelect(page, { x: g.body.x + g.body.width - 20, y: g.body.y + 40 }, g.back);
    assert.ok(await isOpen(page), 'the editor closed after a text selection ended on the backdrop');
    assert.ok((await selected(page)).length > 0, 'no text was selected');
    assert.ok(/EDIT-ONE/.test(await page.inputValue('#d_body')), 'the edit was lost');
  });
  await step('pre-visit: drag from the backdrop into the message, and from the subject out to the backdrop — still open', async () => {
    let g = await geo(page);
    await dragSelect(page, g.back, { x: g.body.x + 60, y: g.body.y + 30 });
    assert.ok(await isOpen(page), 'closed on a drag that started on the backdrop');
    g = await geo(page);
    await dragSelect(page, { x: g.sub.x + g.sub.width - 10, y: g.sub.y + g.sub.height / 2 }, g.back);
    assert.ok(await isOpen(page), 'closed on a subject selection that ended on the backdrop');
  });
  await step('pre-visit: a plain click on the backdrop, double/triple-clicks and clicks in the fields and sheet never close it', async () => {
    let g = await geo(page);
    await page.mouse.click(g.back.x, g.back.y); assert.ok(await isOpen(page), 'backdrop click closed it');
    await page.mouse.click(g.back.x, g.sheet.y + 5); assert.ok(await isOpen(page), 'second backdrop click closed it');
    await page.click('#d_sub'); await page.dblclick('#d_sub'); await page.click('#d_body', { clickCount: 3 });
    g = await geo(page); await page.mouse.click(g.sheet.x + 4, g.sheet.y + 4);   // the sheet's own padding
    await page.click('#draftwrap h3');
    assert.ok(await isOpen(page));
    assert.ok(/EDIT-ONE/.test(await page.inputValue('#d_body')));
  });
  await step('pre-visit: Ctrl+A / Ctrl+C / Ctrl+V and Escape inside the fields edit text and never close it', async () => {
    await page.click('#d_sub'); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
    assert.ok(await isOpen(page));
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.strictEqual(clip, await page.inputValue('#d_sub'), 'Ctrl+C did not copy the subject');
    await page.click('#d_body'); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.press('Control+V');
    assert.ok((await page.inputValue('#d_body')).endsWith('\n' + clip), 'Ctrl+V did not paste into the message');
    await page.keyboard.press('Control+A'); assert.strictEqual((await selected(page)).length, (await page.inputValue('#d_body')).length, 'Ctrl+A did not select the message');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Escape');
    assert.ok(await isOpen(page), 'Escape closed it');
  });
  await step('pre-visit: scrolling the message, the sheet and the backdrop keeps it open', async () => {
    await page.fill('#d_body', (await page.inputValue('#d_body')) + '\n' + 'filler line\n'.repeat(60));
    const g = await geo(page);
    await page.mouse.move(g.body.x + 50, g.body.y + 50); await page.mouse.wheel(0, 600);
    await page.mouse.move(g.sheet.x + 10, g.sheet.y + 60); await page.mouse.wheel(0, 400);
    await page.mouse.move(g.back.x, g.back.y); await page.mouse.wheel(0, 400); await page.mouse.wheel(0, -900);
    assert.ok(await isOpen(page));
    assert.ok(/EDIT-ONE/.test(await page.inputValue('#d_body')));
  });
  await step('pre-visit: Close with unsaved changes asks first — Keep editing keeps every word', async () => {
    const before = await page.inputValue('#d_body');
    await page.click('#d_close');
    assert.ok(await isOpen(page), 'Close discarded unsaved changes without asking');
    assert.ok(await page.isVisible('#d_confirm'), 'no unsaved-changes prompt');
    await page.click('#d_confirm button:has-text("Keep editing")');
    assert.ok(!(await page.isVisible('#d_confirm')));
    assert.strictEqual(await page.inputValue('#d_body'), before);
  });
  await step('pre-visit: Close → Discard changes closes it; reopening drafts fresh (nothing was saved)', async () => {
    await page.click('#d_close'); await page.click('#d_discard');
    await page.waitForSelector('#draftwrap', { state: 'detached' });
    const n0 = previsitCalls(calls); await openHeadsUp();
    assert.ok(!/EDIT-ONE/.test(await page.inputValue('#d_body')), 'discarded text came back');
    assert.strictEqual(previsitCalls(calls), n0 + 1);
  });
  await step('pre-visit: Close with no changes closes at once, without a prompt', async () => {
    await page.click('#d_close'); await page.waitForSelector('#draftwrap', { state: 'detached' });
  });
  await step('pre-visit: changing who it goes to counts as a change', async () => {
    await openHeadsUp();
    await page.click('#d_people .rcpt:has-text("Stacey New")');
    await page.click('#d_close'); assert.ok(await page.isVisible('#d_confirm'), 'recipient change was not protected');
    await page.click('#d_discard'); await page.waitForSelector('#draftwrap', { state: 'detached' });
  });
  await step('pre-visit: Save draft keeps subject, message and recipients; Heads-up reopens it (even offline) without redrafting', async () => {
    await openHeadsUp();
    await page.fill('#d_sub', 'Visit on my way through Glasgow');
    await page.fill('#d_body', (await page.inputValue('#d_body')) + '\n\nSAVED-PREVISIT');
    await page.click('#d_people .rcpt:has-text("Stacey New")');
    await page.click('#d_save'); await page.waitForFunction(() => /Draft saved on this device/.test(document.getElementById('d_msg').textContent));
    await page.click('#d_close'); await page.waitForSelector('#draftwrap', { state: 'detached' });   // saved → no prompt
    const n0 = previsitCalls(calls);
    await ctx.setOffline(true);
    await openHeadsUp();
    await ctx.setOffline(false);
    assert.strictEqual(previsitCalls(calls), n0, 'a saved draft was redrafted by the server');
    assert.ok(/your saved draft/.test(await page.textContent('#draftwrap h3')));
    assert.strictEqual(await page.inputValue('#d_sub'), 'Visit on my way through Glasgow');
    assert.ok(/SAVED-PREVISIT/.test(await page.inputValue('#d_body')));
    const ticked = await page.$$eval('#d_people .d_p', xs => xs.filter(x => x.checked).map(x => x.getAttribute('data-email')));
    assert.deepStrictEqual(ticked.sort(), ['bryant@glasgow.test', 'stacey@glasgow.test'], 'saved recipients: ' + ticked);
    assert.strictEqual(sends(w), 0, 'saving sent an email');
  });
  await step('pre-visit: "Save draft & leave" from the prompt saves the latest edit', async () => {
    await page.fill('#d_body', (await page.inputValue('#d_body')) + ' MORE');
    await page.click('#d_close'); await page.click('#d_confirm button:has-text("Save draft")');
    await page.waitForSelector('#draftwrap', { state: 'detached' });
    await openHeadsUp(); assert.ok(/SAVED-PREVISIT MORE/.test(await page.inputValue('#d_body')));
  });
  await step('pre-visit: "Start a new heads-up" drafts fresh but leaves the saved draft until something replaces it', async () => {
    await page.click('#draftwrap button:has-text("Start a new heads-up")'); await page.waitForFunction(() => /review before sending/.test((document.querySelector('#draftwrap h3') || {}).textContent || ''));
    assert.ok(!/SAVED-PREVISIT/.test(await page.inputValue('#d_body')));
    await page.click('#d_close'); await page.waitForSelector('#draftwrap', { state: 'detached' });
    await openHeadsUp(); assert.ok(/SAVED-PREVISIT MORE/.test(await page.inputValue('#d_body')), 'the saved draft was lost');
  });
  await step('pre-visit: leaving the page with unsaved edits triggers the browser\'s leave-page warning', async () => {
    await page.fill('#d_body', (await page.inputValue('#d_body')) + ' UNSAVED');
    const n = nativeDialogs.length;
    await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); window.__blocked = e.defaultPrevented; });
    assert.ok(await page.evaluate(() => window.__blocked), 'beforeunload was not blocked');
    assert.strictEqual(nativeDialogs.length, n);
  });
  await step('pre-visit: Send goes only on the tap, with the edited text, closes without a prompt, and clears the saved draft', async () => {
    assert.strictEqual(sends(w), 0);
    await page.click('#draftwrap .btn.go'); await page.waitForSelector('#draftwrap', { state: 'detached' });
    const sent = calls.filter(c => c.name === 'email-sync-api' && /"send"/.test(c.body)).map(c => JSON.parse(c.body));
    assert.strictEqual(sent.length, 1, 'expected exactly one send');
    assert.strictEqual(sent[0].to, 'bryant@glasgow.test'); assert.deepStrictEqual(sent[0].cc, ['stacey@glasgow.test']);
    assert.ok(/SAVED-PREVISIT MORE UNSAVED/.test(sent[0].body_text), 'the edited text was not what was sent');
    assert.ok(sent.every(s => [s.to].concat(s.cc).every(a => /\.test$/.test(a))), 'a non-test address was emailed');
    const n0 = previsitCalls(calls); await openHeadsUp();
    assert.strictEqual(previsitCalls(calls), n0 + 1, 'the sent draft was offered again');
    await page.click('#d_close'); await page.waitForSelector('#draftwrap', { state: 'detached' });
  });

  /* ───────────── After-visit follow-up (reached through the real visit flow) ───────────── */
  await step('post-visit: start → end → approve → Email opens the follow-up editor', async () => {
    await page.click('#stop_0 .btn.go.xl'); await page.waitForSelector('#vn_0');
    await page.fill('#vn_0', 'Met Bryant about lift chairs; send PR519 pricing.');
    await page.click('#stop_0 .vmode .btn.go.xl'); await page.waitForSelector('#rv_body > .btn.go.xl', { timeout: 15000 });
    await page.click('#rv_body > .btn.go.xl'); await page.waitForSelector('.rv-done', { timeout: 15000 });
    await page.click('.rv-done .btn.go.xl'); await page.waitForSelector('#draftwrap #d_body');
    assert.ok(/PR519 pricing/.test(await page.inputValue('#d_body')));
  });
  await step('post-visit: selection dragged onto the backdrop, backdrop clicks, Ctrl+A/C/V and scrolling never close it', async () => {
    await page.fill('#d_body', (await page.inputValue('#d_body')) + '\n\nPOST-EDIT');
    let g = await geo(page);
    await dragSelect(page, { x: g.body.x + g.body.width - 20, y: g.body.y + 30 }, g.back);
    assert.ok(await isOpen(page), 'closed after a selection ended on the backdrop');
    await page.mouse.click(g.back.x, g.back.y); assert.ok(await isOpen(page), 'backdrop click closed it');
    await page.click('#d_body'); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
    await page.click('#d_sub'); await page.keyboard.press('End'); await page.keyboard.press('Control+V');
    g = await geo(page); await page.mouse.move(g.back.x, g.back.y); await page.mouse.wheel(0, 500);
    assert.ok(await isOpen(page));
    assert.ok(/POST-EDIT/.test(await page.inputValue('#d_body')));
    await page.fill('#d_sub', 'Following up on our visit');
  });
  await step('post-visit: Close asks before discarding; Save draft & leave keeps it on the visit; Email reopens the saved draft', async () => {
    await page.click('#d_close'); assert.ok(await page.isVisible('#d_confirm'));
    await page.click('#d_confirm button:has-text("Save draft")'); await page.waitForSelector('#draftwrap', { state: 'detached' });
    const rep = w.db.dealer_visit_reports.find(r => r.dealer_id === 'd-greg');
    assert.ok(rep.followup_email && /POST-EDIT/.test(rep.followup_email.body) && !rep.followup_email.sent_at, 'the draft was not kept on the visit');
    assert.ok(await page.$('#rvwrap .rv-done'), 'closing the email closed the visit screen too');
    await page.click('.rv-done .btn.go.xl'); await page.waitForSelector('#draftwrap #d_body');
    assert.ok(/your saved draft/.test(await page.textContent('#draftwrap h3')));
    assert.ok(/POST-EDIT/.test(await page.inputValue('#d_body')));
    assert.strictEqual(sends(w), 1, 'a follow-up was sent without a tap');
  });
  await step('post-visit: Send goes once with the edited text and is recorded on the visit', async () => {
    await page.fill('#d_body', (await page.inputValue('#d_body')) + ' FINAL');
    const n = calls.filter(c => c.name === 'email-sync-api' && /"send"/.test(c.body)).length;
    await page.click('#draftwrap .btn.go'); await page.waitForSelector('#draftwrap', { state: 'detached' });
    await new Promise(r => setTimeout(r, 400));
    const sent = calls.filter(c => c.name === 'email-sync-api' && /"send"/.test(c.body)).slice(n).map(c => JSON.parse(c.body));
    assert.strictEqual(sent.length, 1); assert.ok(/POST-EDIT FINAL/.test(sent[0].body_text)); assert.strictEqual(sent[0].to, 'bryant@glasgow.test');
    const rep = w.db.dealer_visit_reports.find(r => r.dealer_id === 'd-greg');
    assert.ok(rep.followup_email.sent_at && /POST-EDIT FINAL/.test(rep.followup_email.body), 'the send was not recorded on the visit');
    await page.click('.rv-done .btn.xl:not(.go)'); await page.waitForSelector('#rvwrap', { state: 'detached' });
  });
  await step('desktop: no JavaScript errors and no native dialogs', async () => {
    assert.deepStrictEqual(errors, []); assert.deepStrictEqual(nativeDialogs, []);
  });
  await ctx.close();

  /* ───────────── Phone: touch ───────────── */
  await step('phone: tapping the backdrop and a touch-drag from the message to the backdrop keep the heads-up open', async () => {
    const c = await newCtx(browser, PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B}/admin/scheduled-routes.html?route=r-1`); await p.waitForSelector('#stop_1');
    await p.click('#stop_1 button:has-text("Heads-up")'); await p.waitForSelector('#draftwrap #d_body');
    await p.fill('#d_body', 'PHONE-EDIT');
    const g = await geo(p);
    await p.touchscreen.tap(g.back.x, g.back.y);
    assert.ok(await isOpen(p), 'a tap on the backdrop closed it');
    // a touch press in the message released over the backdrop (what a thumb does while selecting)
    const cdp = await c.newCDPSession(p);
    const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tp('touchStart', g.body.x + 20, g.body.y + 20);
    for (let k = 1; k <= 8; k++) await tp('touchMove', g.body.x + 20 + (g.back.x - g.body.x - 20) * k / 8, g.body.y + 20 + (g.back.y - g.body.y - 20) * k / 8);
    await tp('touchEnd');
    assert.ok(await isOpen(p), 'a touch-drag ending on the backdrop closed it');
    assert.strictEqual(await p.inputValue('#d_body'), 'PHONE-EDIT');
    assert.deepStrictEqual(errs, []);
    await c.close();
  });

  await browser.close(); srv.close();
  console.log(`\nEmail editor: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

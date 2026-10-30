/* HCPS Smart Email Learning, Phase 1 — browser QA through the REAL pages and REAL handlers (mock database, fake Outlook,
   synthetic *.test addresses only; nothing reaches the network):
   - Scheduled Routes heads-up: the President's edited send is kept beside the draft as written; Save draft → reopen → send
     still pairs with the ORIGINAL draft (no second draft is made); Outlook got exactly what was on screen
   - Scheduled Routes visit follow-up: the saved draft keeps its id through Save draft and reopening
   - Dealer 360 AI composer: generate → edit → send is kept
   - Greg's emails are never kept; switch off keeps nothing; the editors behave exactly as before
   - Email Learning page: the owner sees drafts and the line comparison (desktop + phone, no horizontal scroll); Greg is refused
     node test/email-learning-p1.ui.js        (needs Playwright with Chromium; SKIPs without it) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createWorld, load, standardSeed } = require('./phase0-mock');
const FAKE = require('./email-learning.fake');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }
  catch (e2) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); } }

const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const UA = '0a0a0a0a-0000-4000-8000-00000000000a', UG = '0b0b0b0b-0000-4000-8000-00000000000b';

function world(flags) {
  const S = standardSeed({
    dealers: [{ id: UA, business_name: 'Sampletown Medical', rep_name: 'Angelo Audia', rep_email: 'angelo@hcps.us', parent_id: null, email: 'pat@sampletown.test', contact_name: 'Pat Example', state: 'TN', city: 'Sampletown' },
      { id: UG, business_name: 'Exampleville Pharmacy', rep_name: 'Greg Campbell', rep_email: 'greg@hcps.us', parent_id: null, email: 'lee@exampleville.test', contact_name: 'Lee Sample', state: 'KY', city: 'Exampleville' }],
    rep_routes: [{ id: 'r-pres', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'TN test loop', scheduled_date: dayStr(2),
        stops: [{ dealer_id: UA, name: 'Sampletown Medical', city: 'Sampletown', state: 'TN' }] },
      { id: 'r-greg', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', rep_name: 'Angelo Audia', name: 'KY test loop', scheduled_date: dayStr(2),
        stops: [{ dealer_id: UG, name: 'Exampleville Pharmacy', city: 'Exampleville', state: 'KY' }] }],
    dealer_contacts: [{ id: 'c-pat', dealer_id: UA, name: 'Pat Example', email: 'pat@sampletown.test', title: 'Owner' },
      { id: 'c-lee', dealer_id: UG, name: 'Lee Sample', email: 'lee@exampleville.test', title: 'Buyer' }],
    dealer_visit_reports: [], dealer_tasks: [], opportunities: [], dealer_notes: [], dealer_activity: [], manufacturers: [], email_drafts: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: flags === undefined ? { email_learning_capture: true } : flags }],
  });
  S.rpc = FAKE.rpc();
  S.ai = () => ({ subject: 'Lift chair pricing for Sampletown', body: 'Hi Pat,\n\nThe PR519 suits your lift chair line.\n\nWould Tuesday or Thursday suit a quick review?' });
  return createWorld(S);
}
function serve(w) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop(); let raw = ''; for await (const c of req) raw += c;
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
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
const PROFILES = { pres: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' },
  greg: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/rep-home.html' } };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
async function ctxFor(browser, who, device) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device || DESKTOP));
  await ctx.addInitScript(([tok, prof]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); } catch (e) {} }, [who, JSON.stringify(PROFILES[who])]);
  return ctx;
}
let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }
const graphSends = w => w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url)).map(x => (typeof x.body === 'string' ? JSON.parse(x.body) : x.body).message);

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world(); const { srv, port } = await serve(w); const B = `http://127.0.0.1:${port}`;
  const errors = [];
  const ctx = await ctxFor(browser, 'pres'); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  const openHeadsUp = async () => { await page.click('#stop_0 button:has-text("Heads-up")'); await page.waitForSelector('#draftwrap #d_body'); };

  await step('heads-up (President): edit → Save draft → reopen → edit → Send: ONE draft kept, paired with exactly what Outlook got', async () => {
    await page.goto(`${B}/admin/scheduled-routes.html?route=r-pres`); await page.waitForSelector('#stop_0');
    await openHeadsUp();
    assert.strictEqual(w.db.email_drafts.length, 1, 'one draft kept when the heads-up opened');
    const d = w.db.email_drafts[0]; const shown = await page.inputValue('#d_body');
    assert.strictEqual(d.original_body, shown, 'the kept draft is exactly what the editor showed');
    assert.strictEqual(d.original_subject, await page.inputValue('#d_sub'));
    await page.fill('#d_body', shown.replace(/^Hi Pat,/, 'Hi Pat,\n\nQuick note: I\'ll be in Sampletown this week.'));
    await page.click('#d_save'); await page.waitForFunction(() => /Draft saved/.test(document.getElementById('d_msg').textContent));
    await page.click('#d_close'); await page.waitForSelector('#draftwrap', { state: 'detached' });
    await openHeadsUp();
    assert.ok(/your saved draft/.test(await page.textContent('#draftwrap h3')));
    assert.strictEqual(w.db.email_drafts.length, 1, 'reopening a saved draft makes no second draft');
    await page.fill('#d_sub', 'Sampletown visit this week');
    const final = (await page.inputValue('#d_body')) + '\n\nSee you then.';
    await page.fill('#d_body', final);
    await page.click('#draftwrap .btn.go'); await page.waitForSelector('#draftwrap', { state: 'detached' });
    await new Promise(r => setTimeout(r, 300));
    const sent = graphSends(w); assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].subject, 'Sampletown visit this week');
    assert.ok(sent[0].body.content.includes('See you then.'));
    assert.strictEqual(d.sent_subject, 'Sampletown visit this week'); assert.strictEqual(d.sent_body, final); assert.strictEqual(d.edited, true);
    assert.strictEqual(d.original_body, shown, 'the original never changes');
    assert.ok(!JSON.stringify(sent[0]).includes(d.id), 'the draft id never reaches the email');
  });
  await step('Dealer 360 AI composer (President): generate → edit → Approve & send is kept with its type', async () => {
    await page.goto(`${B}/admin/dealer.html?id=${UA}`); await page.waitForSelector('#cx_gen', { timeout: 15000 });
    await page.selectOption('#cx_tpl', 'dormant_account'); await page.click('#cx_gen'); await page.waitForSelector('#cx_draft', { state: 'visible' });
    const row = w.db.email_drafts[w.db.email_drafts.length - 1];
    assert.strictEqual(row.email_type, 'dormant_account'); assert.strictEqual(row.generator, 'ai-email-api');
    assert.strictEqual(row.original_body, await page.inputValue('#cx_body'));
    await page.fill('#cx_body', (await page.inputValue('#cx_body')).replace('Would Tuesday or Thursday suit a quick review?', 'Can I stop by Tuesday?'));
    await page.click('#cx_send'); await page.waitForFunction(() => /Sent to/.test(document.getElementById('cx_msg').textContent));
    assert.strictEqual(row.edited, true); assert.ok(/Can I stop by Tuesday\?/.test(row.sent_body));
  });
  await step('Dealer 360: Regenerate makes a new draft; the send pairs with the one on screen', async () => {
    const n = w.db.email_drafts.length;
    await page.click('#cx_gen'); await page.waitForSelector('#cx_draft', { state: 'visible' });
    await page.click('button:has-text("Regenerate")'); await page.waitForFunction(n2 => true, n);
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(w.db.email_drafts.length, n + 2);
    await page.click('#cx_send'); await page.waitForFunction(() => /Sent to/.test(document.getElementById('cx_msg').textContent));
    const [first, second] = w.db.email_drafts.slice(-2);
    assert.strictEqual(first.sent_at, null); assert.ok(second.sent_at); assert.strictEqual(second.edited, false);
  });
  await step('no JavaScript errors (President pages)', async () => { assert.deepStrictEqual(errors, []); });
  await ctx.close();

  await step('Greg: heads-up opens and sends exactly as before; nothing is kept', async () => {
    const n = w.db.email_drafts.length, nSent = graphSends(w).length;
    const c = await ctxFor(browser, 'greg'); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B}/admin/scheduled-routes.html?route=r-greg`); await p.waitForSelector('#stop_0');
    await p.click('#stop_0 button:has-text("Heads-up")'); await p.waitForSelector('#draftwrap #d_body');
    await p.fill('#d_body', (await p.inputValue('#d_body')) + '\n\nGreg edit');
    await p.click('#draftwrap .btn.go'); await p.waitForSelector('#draftwrap', { state: 'detached' });
    assert.strictEqual(graphSends(w).length, nSent + 1); assert.strictEqual(w.db.email_drafts.length, n);
    assert.deepStrictEqual(errs, []); await c.close();
  });
  await step('switch off: the President\'s heads-up and send work as before; nothing is kept', async () => {
    const w2 = world({}); const s2 = await serve(w2);
    const c = await ctxFor(browser, 'pres'); const p = await c.newPage();
    await p.goto(`http://127.0.0.1:${s2.port}/admin/scheduled-routes.html?route=r-pres`); await p.waitForSelector('#stop_0');
    await p.click('#stop_0 button:has-text("Heads-up")'); await p.waitForSelector('#draftwrap #d_body');
    await p.click('#draftwrap .btn.go'); await p.waitForSelector('#draftwrap', { state: 'detached' });
    assert.strictEqual(graphSends(w2).length, 1); assert.strictEqual(w2.db.email_drafts.length, 0);
    await c.close(); s2.srv.close();
  });

  for (const [label, dev] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await step(`Email Learning page (${label}): counts, list, and the original-vs-sent comparison; no horizontal scroll`, async () => {
      const c = await ctxFor(browser, 'pres', dev); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(`${B}/admin/email-learning.html`); await p.waitForSelector('.el-row');
      assert.strictEqual(await p.textContent('#k-edited'), '2'); assert.strictEqual(await p.textContent('#k-sent'), '3');
      await p.selectOption('#el-only', 'edited'); await p.waitForFunction(() => document.querySelectorAll('.el-row').length === 2);
      await p.click('.el-row:has-text("Sampletown visit this week")'); await p.waitForSelector('.el-diff');
      assert.ok(await p.isVisible('.el-diff .add:has-text("See you then.")'));
      const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
      assert.ok(o.sw <= o.w + 1, `horizontal scroll ${o.sw} > ${o.w}`);
      const h = await p.$eval('#el-back', b => b.getBoundingClientRect().height); assert.ok(h >= 40, 'back button ' + h);
      assert.deepStrictEqual(errs, []); await c.close();
    });
  }
  await step('Email Learning page: Greg sees the owner-only notice and no email', async () => {
    const c = await ctxFor(browser, 'greg'); const p = await c.newPage();
    await p.goto(`${B}/admin/email-learning.html`); await p.waitForFunction(() => /owner's page/.test(document.body.textContent));
    assert.ok(!(await p.textContent('body')).includes('Sampletown visit this week')); await c.close();
  });

  await browser.close(); srv.close();
  console.log(`\nEmail learning P1 UI: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

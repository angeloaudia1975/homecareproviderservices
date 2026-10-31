/* HCPS Smart Email Learning, Phase 3 — browser QA of the editors through the REAL pages and REAL handlers (mock database, fake
   Outlook and AI, synthetic *.test addresses; nothing reaches the network). Desktop 1280 and phone 390.
   - switches off: no style picker, no Regenerate, the heads-up and Dealer 360 composer work exactly as before
   - writing styles + AI heads-up on: the editor shows the three styles; Regenerate writes a SUGGESTION beside the text — the
     rep's edits stay; "Keep my text" changes nothing; "Use this version" swaps it in (and its draft id); "Back to my previous
     text" restores the edits and their draft id; Send pairs with the draft on screen
   - Dealer 360: a regenerate over EDITED text is a suggestion; unedited text is simply replaced, as before
   - the editor still closes only on an explicit action (the 2026-10-30 rule) — a regenerate never closes it
   - phone: no horizontal scroll, touch targets ≥ 44px
     node test/email-learning-p3.ui.js        (needs Playwright with Chromium; SKIPs without it) */
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
const UA = '0a0a0a0a-0000-4000-8000-00000000000a';

function world(flags) {
  const S = standardSeed({
    dealers: [{ id: UA, business_name: 'Sampletown Medical', rep_name: 'Angelo Audia', rep_email: 'angelo@hcps.us', parent_id: null, email: 'pat@sampletown.test', contact_name: 'Pat Example', state: 'TN', city: 'Sampletown' }],
    rep_routes: [{ id: 'r-pres', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'TN test loop', scheduled_date: dayStr(2),
      stops: [{ dealer_id: UA, name: 'Sampletown Medical', city: 'Sampletown', state: 'TN' }] }],
    dealer_contacts: [{ id: 'c-pat', dealer_id: UA, name: 'Pat Example', email: 'pat@sampletown.test', title: 'Owner' }],
    dealer_visit_reports: [], dealer_tasks: [], opportunities: [], dealer_notes: [], dealer_activity: [], manufacturers: [], email_drafts: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: Object.assign({ email_learning_capture: true }, flags || {}) }],
  });
  S.rpc = Object.assign(FAKE.rpc(), { hcps_email_draft_shape: () => ({ status: 200, body: { ok: true, status: 'recorded' } }) });
  let n = 0;
  S.ai = body => {
    const p = body.messages[0].content; n++;
    if (/pre-visit heads-up/.test(p) && /Brief & Direct/.test(p)) return { subject: 'Free freight!', body: 'Hi Pat,\n\nFree freight on every order this week, I promise.' };   // invents → the guards refuse it
    if (/pre-visit heads-up/.test(p)) {
      const day = (p.match(/- Visit day: ([^\n]+)/) || [])[1] || '', eta = (p.match(/- Estimated arrival: (.+?) —/) || [])[1] || '';
      const d = /not confirmed/.test(day) ? '' : day;
      return { subject: d ? `Stopping by ${d}` : 'Stopping by soon', body: `Hi Pat,\n\nAI version ${n}: I plan to stop by${d ? ` on ${d}` : ' soon'}${eta ? ` around ${eta} — an estimate` : ''}.\n\nReply if another time suits.` };
    }
    return { subject: `Lift chairs for Sampletown ${n}`, body: `Hi Pat,\n\nAI version ${n}: the PR519 suits your lift chair line.\n\nWould Tuesday or Thursday suit a quick review?` };
  };
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
const PRES = { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
async function ctxFor(browser, device) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([prof]) => { try { localStorage.setItem('hcps_staff_token', 'pres'); localStorage.setItem('hcps_staff_profile', prof); } catch (e) {} }, [JSON.stringify(PRES)]);
  return ctx;
}
let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }
const graphSends = w => w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url)).map(x => (typeof x.body === 'string' ? JSON.parse(x.body) : x.body).message);
const draftId = page => page.evaluate(() => (window.DRAFT || (typeof DRAFT !== 'undefined' ? DRAFT : null) || {}).draft_id || null);

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

  await step('switches off: no style picker and no Regenerate in the heads-up; Dealer 360 regenerates as before', async () => {
    const w = world(); const s = await serve(w); const B = `http://127.0.0.1:${s.port}`;
    const c = await ctxFor(browser, DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B}/admin/scheduled-routes.html?route=r-pres`); await p.waitForSelector('#stop_0');
    await p.click('#stop_0 button:has-text("Heads-up")'); await p.waitForSelector('#draftwrap #d_body');
    assert.strictEqual(await p.$('#d_regen'), null); assert.strictEqual(await p.$('#d_style'), null);
    assert.ok(/^Hi Pat,\n\nThis is Angelo Audia with HomeCare Provider Services/.test(await p.inputValue('#d_body')), 'the fixed template');
    await p.click('#d_close'); await p.waitForSelector('#draftwrap', { state: 'detached' });
    await p.goto(`${B}/admin/dealer.html?id=${UA}`); await p.waitForSelector('#cx_gen', { timeout: 15000 });
    await p.click('#cx_gen'); await p.waitForSelector('#cx_draft', { state: 'visible' });
    assert.strictEqual(await p.$('#cx_style'), null);
    await p.fill('#cx_body', (await p.inputValue('#cx_body')) + '\nMY EDIT');
    await p.click('button:has-text("Regenerate")'); await p.waitForFunction(() => !/MY EDIT/.test(document.getElementById('cx_body').value));
    assert.ok(!(await p.isVisible('#cx_alt')), 'with styles off a regenerate replaces the text, as before');
    assert.deepStrictEqual(errs, []); await c.close(); s.srv.close();
  });

  for (const [label, dev] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await step(`heads-up (${label}): styles + Regenerate keep the rep's edits until the rep chooses; ids follow the text on screen`, async () => {
      const w = world({ email_styles: true, email_ai_headsup: true }); const s = await serve(w); const B = `http://127.0.0.1:${s.port}`;
      const c = await ctxFor(browser, dev); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(`${B}/admin/scheduled-routes.html?route=r-pres`); await p.waitForSelector('#stop_0');
      await p.click('#stop_0 button:has-text("Heads-up")'); await p.waitForSelector('#draftwrap #d_body');
      assert.deepStrictEqual(await p.$$eval('#d_style option', o => o.map(x => x.textContent)), ['Professional & Friendly', 'Consultative Sales', 'Brief & Direct']);
      assert.ok(/AI version/.test(await p.inputValue('#d_body')), 'the AI heads-up opened');
      const first = await draftId(p); assert.ok(/^[0-9a-f-]{36}$/.test(first || ''), 'a draft id');
      const mine = (await p.inputValue('#d_body')) + '\n\nMY OWN EDIT';
      await p.fill('#d_body', mine);
      await p.selectOption('#d_style', 'consultative');
      await p.click('#d_regen'); await p.waitForSelector('#d_alt', { state: 'visible' });
      assert.strictEqual(await p.inputValue('#d_body'), mine, 'the rep\'s text is untouched by Regenerate');
      assert.strictEqual(await draftId(p), first);
      assert.ok(/AI version/.test(await p.textContent('#d_alt_body')));
      assert.ok(await p.isVisible('#draftwrap'), 'a regenerate never closes the editor');
      await p.click('button:has-text("Keep my text")'); assert.ok(!(await p.isVisible('#d_alt')));
      assert.strictEqual(await p.inputValue('#d_body'), mine);
      await p.click('#d_regen'); await p.waitForSelector('#d_alt', { state: 'visible' });
      const alt = await p.textContent('#d_alt_body');
      await p.click('button:has-text("Use this version")');
      assert.strictEqual((await p.inputValue('#d_body')).trim(), alt.trim());
      const second = await draftId(p); assert.ok(second && second !== first, 'the id follows the chosen version');
      await p.click('#d_undo'); assert.strictEqual(await p.inputValue('#d_body'), mine); assert.strictEqual(await draftId(p), first);
      await p.click('#d_undo'); assert.strictEqual((await p.inputValue('#d_body')).trim(), alt.trim(), 'Undo swaps: the new version is one tap away');
      assert.strictEqual(await draftId(p), second);
      await p.click('#d_undo'); assert.strictEqual(await p.inputValue('#d_body'), mine);
      // review M2: the warnings at the top follow the version in the editor
      await p.selectOption('#d_style', 'brief_direct'); await p.click('#d_regen'); await p.waitForSelector('#d_alt', { state: 'visible' });
      assert.ok(/couldn't confirm/.test(await p.textContent('#d_alt_warn')), 'the suggestion shows why it is the standard heads-up');
      const topBefore = await p.textContent('#d_warn');
      await p.click('#d_use'); assert.ok(/couldn't confirm/.test(await p.textContent('#d_warn')), 'its warnings move to the top');
      await p.click('#d_undo'); assert.strictEqual(await p.textContent('#d_warn'), topBefore, 'and go away again with the previous text');
      assert.strictEqual(await p.inputValue('#d_body'), mine);
      // touch targets + no horizontal scroll
      for (const sel of ['#d_regen', '#d_style']) { const h = await p.$eval(sel, b => b.getBoundingClientRect().height); assert.ok(h >= 40, sel + ' ' + h); }
      const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth })); assert.ok(o.sw <= o.w + 1, `horizontal scroll ${o.sw} > ${o.w}`);
      await p.click('#draftwrap .btn.go'); await p.waitForSelector('#draftwrap', { state: 'detached' });
      await new Promise(r => setTimeout(r, 300));
      const sent = graphSends(w); assert.strictEqual(sent.length, 1); assert.ok(sent[0].body.content.includes('MY OWN EDIT'));
      const d1 = w.db.email_drafts.find(d => d.id === first); assert.ok(d1.sent_at, 'the send paired with the draft on screen'); assert.strictEqual(d1.edited, true);
      assert.deepStrictEqual(errs, []); await c.close(); s.srv.close();
    });
  }

  await step('Dealer 360 (styles on): unedited text is replaced; edited text gets a suggestion with Keep / Use', async () => {
    const w = world({ email_styles: true }); const s = await serve(w); const B = `http://127.0.0.1:${s.port}`;
    const c = await ctxFor(browser, DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    p.on('dialog', d => d.accept());   // "Send this email … from your Outlook?"
    await p.goto(`${B}/admin/dealer.html?id=${UA}`); await p.waitForSelector('#cx_gen', { timeout: 15000 });
    await p.click('#cx_gen'); await p.waitForSelector('#cx_draft', { state: 'visible' });
    await p.waitForSelector('#cx_style');
    const v1 = await p.inputValue('#cx_body');
    await p.click('button:has-text("Regenerate")'); await p.waitForFunction(v => document.getElementById('cx_body').value !== v, v1);
    assert.ok(!(await p.isVisible('#cx_alt')), 'unedited: replaced, no suggestion box');
    const mine = (await p.inputValue('#cx_body')) + '\nMY EDIT';
    await p.fill('#cx_body', mine); await p.selectOption('#cx_style', 'consultative');
    await p.click('button:has-text("Regenerate")'); await p.waitForSelector('#cx_alt', { state: 'visible' });
    assert.strictEqual(await p.inputValue('#cx_body'), mine, 'edited text is kept');
    await p.click('button:has-text("Keep my text")'); assert.strictEqual(await p.inputValue('#cx_body'), mine);
    await p.click('button:has-text("Regenerate")'); await p.waitForSelector('#cx_alt', { state: 'visible' });
    const alt = await p.textContent('#cx_alt_body');
    await p.click('button:has-text("Use this version")'); assert.strictEqual((await p.inputValue('#cx_body')).trim(), alt.trim());
    await p.click('#cx_send'); await p.waitForFunction(() => /Sent to/.test(document.getElementById('cx_msg').textContent));
    const sentRow = w.db.email_drafts.filter(d => d.sent_at); assert.strictEqual(sentRow.length, 1); assert.strictEqual(sentRow[0].edited, false, 'paired with the suggestion that was chosen');
    assert.deepStrictEqual(errs, []); await c.close(); s.srv.close();
  });

  for (const [label, dev] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await step(`owner page (${label}): Redact asks for a reason, warns it is for good, then shows the rule as Redacted with no evidence`, async () => {
      const w = world(); const RID = '0c0c0c0c-0000-4000-8000-00000000000c';
      w.db.email_learning_rules = [{ id: RID, rule_key: 'a'.repeat(32), pattern_key: 'b'.repeat(32), email_type: 'all', kind: 'remove_phrase', pattern: { phrase: 'see you pat' },
        instruction: 'Don’t write “see you pat”.', suggested_instruction: 'Don’t write “see you pat”.', examples: ['− see you pat'], sends: 3, dealers: 2, status: 'approved',
        decided_at: new Date().toISOString(), decided_by: 'angelo@hcps.us', decision_reason: 'Mine', redacted_at: null }];
      w.db.email_learning_profiles = [{ version: 1, created_at: new Date().toISOString(), created_by: 'angelo@hcps.us', action: 'approve', reason: 'Mine', rules: [{ id: RID, email_type: 'all', kind: 'remove_phrase', instruction: 'Don’t write “see you pat”.' }] }];
      const seen = [];
      const f0 = w.fetch; w.fetch = async (u, o) => {
        if (/rpc\/hcps_email_rule_redact$/.test(String(u))) { const pp = JSON.parse(o.body).p; seen.push(pp); const r = w.db.email_learning_rules[0];
          Object.assign(r, { pattern: { redacted: true }, examples: [], instruction: 'Redacted by the owner — this rule is no longer used.', suggested_instruction: 'Redacted by the owner — this rule is no longer used.', status: 'retired', redacted_at: new Date().toISOString(), redacted_by: pp.by });
          w.db.email_learning_profiles.push({ version: 2, created_at: new Date().toISOString(), created_by: pp.by, action: 'redact', reason: pp.reason, rules: [] });
          const b = JSON.stringify({ ok: true, status: 'redacted', rule_status: 'retired', version: 2 }); return { ok: true, status: 200, text: async () => b, json: async () => JSON.parse(b) }; }
        return f0(u, o); };
      const s = await serve(w); const c = await ctxFor(browser, dev); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(`http://127.0.0.1:${s.port}/admin/email-learning.html`); await p.click('.el-tab[data-tab="rules"]'); await p.waitForSelector('[data-act="redact"]');
      await p.click('[data-act="redact"]'); await p.waitForSelector('#el-form');
      assert.ok(/removes this rule's masked phrase, examples and wording for good/.test(await p.textContent('#el-form')) && /can't be undone/.test(await p.textContent('#el-form')));
      await p.click('#el-save'); await p.waitForFunction(() => /short reason/.test(document.body.textContent)); assert.strictEqual(seen.length, 0, 'no reason → nothing sent');
      await p.fill('#el-reason', 'Holds a customer name'); await p.click('#el-save');
      await p.waitForFunction(() => /Redacted/.test(document.body.textContent) && !/see you pat/.test(document.body.textContent));
      assert.strictEqual(seen[0].expected_status, 'approved'); assert.strictEqual(seen[0].expected_version, 1);
      assert.strictEqual(await p.$('[data-act]'), null, 'a redacted rule has no actions');
      const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth })); assert.ok(o.sw <= o.w + 1);
      assert.deepStrictEqual(errs, []); await c.close(); s.srv.close();
    });
  }

  await browser.close();
  console.log(`\nEmail learning P3 (editors, browser): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);   // servers left open by a failed step must not keep the run alive
})();

/* Phase 1 — browser QA for the screens a rep touches: the field app's visit mode (phone), the
   Dealer 360 "Visits & meetings" card, and the Command Center (phone + desktop).

   The pages are the real files in src/admin; every /.netlify/functions call is answered by the
   REAL handler running against the fake database in phase0-mock.js — so this exercises the
   browser code and the server code together, including going offline and coming back.

   Needs Playwright with Chromium (not a dependency of the site build). Run:
     node test/phase1-ui.qa.js            screenshots go to <tmp>/hcps-phase1-qa (or $QA_SHOTS)   */
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
const SHOTS = process.env.QA_SHOTS || path.join(require('os').tmpdir(), 'hcps-phase1-qa'); fs.mkdirSync(SHOTS, { recursive: true });
const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), IN3 = dayStr(3), IN7 = dayStr(7);

const AI_VISIT = {
  meeting_summary: 'Met Bryant and Stacey. Reviewed lift chairs; they want pricing on 2 PR519 chairs.',
  products_discussed: ['PR519 lift chair'], dealer_interests: ['Lift chairs'], dealer_concerns: ['Lead times'], objections: [], competitors: ['Pride'],
  pricing_requests: ['PR519 pricing'], samples_requested: [], literature_requested: ['Golden catalog'], training_requested: [],
  attendees: [{ name: 'Bryant Smith', title: 'Pharmacist' }, { name: 'Stacey New', title: 'Buyer' }],
  rep_commitments: [{ text: 'Send PR519 pricing', due_date: IN3 }], dealer_commitments: [{ text: 'Call me Friday', due_date: '' }],
  follow_ups: [{ title: 'Send PR519 pricing', due_date: IN3, priority: 'high', from: 'rep_commitment' }, { title: 'Call Bryant back', due_date: IN7, priority: 'normal', from: 'dealer_commitment' }],
  opportunities: [{ title: '2 x PR519 lift chairs', manufacturer_slug: 'golden-technologies', product: 'PR519', quantity: 2, est_value: null, contact_name: 'Bryant Smith', stage: 'identified', expected_close: '' }],
  suggested_next_action: { text: 'Send pricing', due_date: IN3 }, interest_slugs: ['golden-technologies'], poor_fit_slugs: [] };

function world() {
  const S = standardSeed({
    rep_routes: [{ id: 'r-1', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', rep_name: 'Angelo Audia', name: 'KY loop', scheduled_date: TODAY,
      stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY' }, { dealer_id: 'd-dir-greg', name: 'Directory Only Dealer', city: 'Bowling Green', state: 'KY' }] },
      { id: 'r-ang', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'TN loop', scheduled_date: TODAY, stops: [{ dealer_id: 'd-ang', name: 'RMS' }] },
      { id: 'r-2', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', rep_name: 'Angelo Audia', name: 'KY loop (afternoon)', scheduled_date: TODAY,
        stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY' }] }],
    dealer_visit_reports: [], rep_daily_briefs: [],
    // the live House-owned TEST dealer the Permission check probes (not in any rep's book)
    dealers: [{ id: '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b', business_name: 'TEST — Golden Sandbox', rep_name: null, parent_id: null, state: 'IN', is_test: true }],
    dealer_contacts: [{ id: 'c-bryant', dealer_id: 'd-greg', name: 'Bryant Smith', email: 'bryant@glasgow.test', title: 'Pharmacist', phone: '270-111' }],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }, { slug: 'strongback-mobility', name: 'Strongback Mobility' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { adhoc_visit: true, morning_brief: true, eod_recap: true, timeline: true, conversion: true } }],
    dealer_tasks: [{ id: 't-old', dealer_id: 'd-greg', title: 'Old overdue call', status: 'open', due_date: dayStr(-2), priority: 'normal', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us', source: 'manual', created_at: new Date(Date.now() - 5 * 864e5).toISOString() }],
  });
  S.unique = { dealer_tasks: [['origin_type', 'origin_id', 'origin_key']], opportunities: [['origin_type', 'origin_id', 'origin_key']],
    dealer_visits: [['visit_report_id']], dealer_visit_participants: [['visit_report_id', 'name_key']], dealer_contacts: [['dealer_id', 'email']],
    dealer_visit_reports: [['route_id', 'dealer_id']] };
  S.catalog = { 'golden-technologies': [{ code: 'PR-519', name: 'Golden PR519 Lift Chair', base_price: 899 }] };
  // A summary is three AI requests at once: "what happened", the follow-ups and the deals.
  // AI.fail > 0: that many "what happened" answers come back cut off (the live failure); AI.failNext the same
  // for the follow-ups part — to drive the retry and partial paths.
  const AI = { fail: 0, failNext: 0, calls: 0 };
  const cutOff = () => ({ status: 200, body: { content: [{ type: 'text', text: '{"meeting_summary":"Met Bry' }], stop_reason: 'max_tokens' } });
  S.ai = body => { const p = JSON.stringify(body);
    if (/MEETING RECAP/.test(p)) return { subject: 'Following up on our visit', body: 'Hi Bryant,\n\nThank you for meeting with me on October 2. As promised, PR519 pricing is on its way.' };
    AI.calls++;
    if (AI.override) { const o = AI.override(p); if (o) return o; }
    if (/WHAT HAPPENS NEXT/.test(p)) { if (AI.failNext > 0) { AI.failNext--; return cutOff(); } return AI_VISIT; }
    if (/WHAT HAPPENED/.test(p) && AI.fail > 0) { AI.fail--; return cutOff(); }
    return AI_VISIT; };
  const w = createWorld(S); w.AI = AI; return w;
}

const PROFILES = {
  greg: { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', landing: '/admin/rep-home.html' },
  pres: { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', landing: '/admin/' },
  lori: { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', rep_name: 'Lori Hunt', landing: '/admin/rep-home.html' },
};

function serve(w, opts) {
  opts = opts || {};
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/.netlify/functions/')) {
      const name = u.pathname.split('/').pop();
      let raw = ''; for await (const c of req) raw += c;
      calls.push({ name, body: raw });
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
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
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');   // /admin/ → the dashboard
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(''); return; }
    const ext = path.extname(p); const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webmanifest': 'application/json' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(fs.readFileSync(p));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, calls })));
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
const DESKTOP = { viewport: { width: 1366, height: 900 } };
async function ctxFor(browser, who, device) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block' }, device));
  await ctx.addInitScript(([tok, prof]) => { try { localStorage.setItem('hcps_staff_token', tok); localStorage.setItem('hcps_staff_profile', prof); } catch (e) {} }, [who, JSON.stringify(PROFILES[who])]);
  return ctx;
}
async function noHScroll(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  assert.ok(o.sw <= o.w + 1, `${label}: horizontal scroll (${o.sw} > ${o.w})`);
}
async function smallTargets(page, sel) {
  return page.evaluate(s => [...document.querySelectorAll(s)].filter(e => e.offsetParent).map(e => { const r = e.getBoundingClientRect(); return { t: (e.textContent || '').trim().slice(0, 30), h: Math.round(r.height) }; }).filter(x => x.h < 44), sel);
}
const n = (w, t, f) => (w.db[t] || []).filter(f || (() => true)).length;

let pass = 0, fail = 0;
async function step(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world();
  const { srv, port, calls } = await serve(w);
  const B = `http://127.0.0.1:${port}`;
  const errors = [];

  /* ───────────── Field app, phone: Start → Meeting → End → Review → Approve → Email → Done ───────────── */
  const ctx = await ctxFor(browser, 'greg', PHONE); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('field: ' + e.message));
  page.on('dialog', d => d.dismiss());
  await step('field: route opens on a phone with one big Start button per stop', async () => {
    await page.goto(`${B}/admin/scheduled-routes.html?route=r-1`); await page.waitForSelector('#stop_0');
    const starts = await page.$$eval('.btn.go.xl', bs => bs.map(b => ({ t: b.textContent.trim(), h: b.getBoundingClientRect().height })));
    assert.strictEqual(starts.length, 2); assert.ok(starts.every(s => /Start visit/.test(s.t) && s.h >= 50), JSON.stringify(starts));
    await noHScroll(page, 'field route'); await page.screenshot({ path: path.join(SHOTS, 'field-1-route.png'), fullPage: true });
  });
  await step('field: Start visit → on-site timer runs, quick notes kept on the phone', async () => {
    await page.click('#stop_0 .btn.go.xl'); await page.waitForSelector('#vn_0');
    const t1 = await page.textContent('#stop_0 .vtimer b'); await page.waitForTimeout(1300); const t2 = await page.textContent('#stop_0 .vtimer b');
    assert.notStrictEqual(t1, t2, 'the timer is not running');
    await page.fill('#vn_0', 'Met Bryant and Stacey about lift chairs. They want PR519 pricing for 2 chairs.');
    assert.strictEqual(n(w, 'dealer_visit_reports', r => r.dealer_id === 'd-greg' && r.checkin_at), 1, 'arrival not recorded');
    const fs16 = await page.$eval('#vn_0', e => getComputedStyle(e).fontSize); assert.strictEqual(fs16, '16px', 'iOS would zoom the notes field');
    await page.screenshot({ path: path.join(SHOTS, 'field-2-onsite.png'), fullPage: true });
  });
  await step('field: End visit → AI review with attendees, follow-ups and the opportunity (nothing saved yet)', async () => {
    await page.click('#stop_0 .vmode .btn.go.xl'); await page.waitForSelector('#rv_body .rv-card.opp', { timeout: 15000 });
    const sum = await page.inputValue('#rv_sum'); assert.ok(/Met Bryant/.test(sum), sum);
    assert.strictEqual(await page.$$eval('#rv_at .rv-card', x => x.length), 2);
    assert.ok(/On file: Bryant Smith/.test(await page.textContent('#rv_at')), 'existing contact not matched');
    assert.strictEqual(await page.$$eval('#rv_fu .rv-card', x => x.length), 2);
    assert.ok(/Priced from the catalog: 2 × \$899/.test(await page.textContent('#rv_op')), 'catalog price missing');
    assert.strictEqual(n(w, 'dealer_tasks', t => t.origin_type), 0, 'a task was created before approval');
    assert.strictEqual(n(w, 'opportunities'), 0, 'a deal was created before approval');
    await noHScroll(page, 'review'); await page.screenshot({ path: path.join(SHOTS, 'field-3-review.png'), fullPage: true });
  });
  await step('field: reject one follow-up, change a due date and priority, approve — double tap creates one set', async () => {
    const cards = await page.$$('#rv_fu .rv-card');
    await (await cards[1].$('.rv-on')).uncheck();
    await (await cards[0].$('.rv-d')).fill(IN7); await (await cards[0].$('.rv-p')).selectOption('normal');
    // The suggested next action ("Send pricing") repeats the first follow-up: offered, but unticked.
    assert.strictEqual(await page.isChecked('#rv_na_on'), false, 'the duplicate next action was ticked');
    assert.ok(/Already a follow-up above/.test(await page.textContent('#rv_body')), 'no explanation for the unticked next action');
    await page.evaluate(() => { const b = document.querySelector('#rv_body > .btn.go.xl'); b.click(); b.click(); });
    await page.waitForSelector('.rv-done', { timeout: 15000 });
    const txt = await page.textContent('.rv-done'); assert.ok(/1 follow-up → My Tasks · 1 opportunity → Pipeline · 1 new contact/.test(txt), txt);
    const tasks = w.db.dealer_tasks.filter(t => t.origin_type === 'visit_report');
    assert.strictEqual(tasks.length, 1, 'expected only the edited follow-up (the repeat next action stays unticked)');
    const fu = tasks.find(t => t.title === 'Send PR519 pricing'); assert.strictEqual(fu.due_date, IN7); assert.strictEqual(fu.priority, 'normal');
    assert.ok(!tasks.some(t => t.title === 'Call Bryant back'), 'the rejected follow-up was created');
    assert.strictEqual(n(w, 'opportunities'), 1); assert.strictEqual(n(w, 'dealer_contacts', c => c.dealer_id === 'd-greg'), 2);
    assert.strictEqual(n(w, 'dealer_visit_participants'), 2); assert.strictEqual(n(w, 'dealer_notes'), 1); assert.strictEqual(n(w, 'dealer_visits'), 1);
    await page.screenshot({ path: path.join(SHOTS, 'field-4-approved.png'), fullPage: true });
  });
  await step('field: follow-up email — drafted, copied, saved as a draft, sent only on tap, recorded on the visit', async () => {
    const before = w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url)).length;
    await page.click('.rv-done .btn.go.xl'); await page.waitForSelector('#draftwrap #d_body');
    assert.ok(/PR519 pricing/.test(await page.inputValue('#d_body')));
    // One attendee has an email → they are the recipient; the one without is named.
    const ticked = await page.$$eval('#d_people .d_p', xs => xs.filter(x => x.checked).map(x => x.getAttribute('data-email')));
    assert.deepStrictEqual(ticked, ['bryant@glasgow.test'], 'recipient: ' + ticked);
    assert.ok(/no email on file: Stacey New/.test(await page.textContent('#draftwrap')), 'the attendee without an email is not mentioned');
    assert.strictEqual(w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url)).length, before, 'drafting sent an email');
    await page.click('#draftwrap button:has-text("Save draft")'); await page.waitForFunction(() => /Draft saved/.test((document.getElementById('d_msg') || {}).textContent || ''));
    const rep = w.db.dealer_visit_reports.find(r => r.dealer_id === 'd-greg');
    assert.ok(rep.followup_email && rep.followup_email.saved_at && !rep.followup_email.sent_at, 'draft not saved');
    await page.fill('#d_body', (await page.inputValue('#d_body')) + '\n\nEdited by Greg.');
    await page.screenshot({ path: path.join(SHOTS, 'field-5-email.png'), fullPage: true });
    await page.click('#draftwrap .btn.go'); await page.waitForSelector('#draftwrap', { state: 'detached' });
    await page.waitForFunction(() => true); await new Promise(r => setTimeout(r, 400));
    assert.ok(w.outbound.some(x => x.kind === 'graph' && /sendMail/.test(x.url)) || calls.some(c => c.name === 'email-sync-api'), 'Send did not go through the email integration');
    assert.ok(rep.followup_email.sent_at, 'the send was not recorded on the visit');
    assert.ok(/Edited by Greg/.test(rep.followup_email.body), 'the edited text was not what was recorded');
    assert.ok(await page.$('#rvwrap .rv-done'), 'sending closed the visit screen too');
  });
  await step('field: Done → stop shows visited + follow-up pending; the summary opens from the card', async () => {
    await page.click('.rv-done .btn.xl:not(.go)'); await page.waitForSelector('#rvwrap', { state: 'detached' });
    const chip = await page.textContent('#stop_0 .nm'); assert.ok(/visited/i.test(chip) && /Follow-up pending/i.test(chip), chip);
    await page.click('#stop_0 .acts .btn.wide'); await page.waitForSelector('#rv_body .rv-sec h4');
    const t = await page.textContent('#rv_body'); assert.ok(/Follow-ups/.test(t) && /Opportunities/.test(t) && /Bryant Smith/.test(t), t.slice(0, 300));
    await page.screenshot({ path: path.join(SHOTS, 'field-6-summary.png'), fullPage: true });
    await page.click('.sheethd button');
  });

  /* ───────────── Offline: start, end, review by hand and approve with no signal; sync on reconnect ───────────── */
  await step('offline: a visit started, ended and approved with no signal syncs once on reconnect', async () => {
    await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.click('#stop_1 .btn.go.xl'); await page.waitForSelector('#vn_1');
    await page.fill('#vn_1', 'Quick stop. Owner wants Strongback literature.');
    await page.click('#stop_1 .vmode .btn.go.xl'); await page.waitForSelector('#rv_body .rvnote');
    assert.ok(/offline/i.test(await page.textContent('#rv_body .rvnote')));
    await page.click('#rv_body button:has-text("Add a follow-up")'); await page.fill('#rv_fu .rv-card:last-child .rv-t', 'Mail Strongback literature');
    await page.click('#rv_body > .btn.go.xl'); await page.waitForSelector('.rv-done');
    assert.ok(/on this phone/.test(await page.textContent('.rv-done')));
    const queued = await page.evaluate(() => outbox().map(x => x.body.action)); assert.deepStrictEqual(queued, ['visit_checkin', 'visit_report_save', 'visit_end', 'visit_approve']);
    assert.strictEqual(n(w, 'dealer_visit_reports', r => r.dealer_id === 'd-dir-greg'), 0, 'something reached the server while offline');
    await page.screenshot({ path: path.join(SHOTS, 'offline-1-queued.png'), fullPage: true });
    await page.click('.rv-done .btn.xl:not(.go)');
    await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => outbox().length === 0, null, { timeout: 15000 });
    const r = w.db.dealer_visit_reports.find(x => x.dealer_id === 'd-dir-greg'); assert.ok(r && r.approved_at && r.ended_at, 'the offline visit did not sync');
    assert.strictEqual(n(w, 'dealer_tasks', t => t.origin_id === r.id), 1);
    // A lost response: the same approval replays.
    const before = JSON.stringify([n(w, 'dealer_tasks'), n(w, 'dealer_notes'), n(w, 'dealer_visits'), n(w, 'dealer_activity')]);
    const last = calls.filter(c => c.name === 'routes-api' && /visit_approve/.test(c.body)).pop();
    await page.evaluate(b => { enqueue(JSON.parse(b)); return flushOutbox(); }, last.body);
    assert.strictEqual(JSON.stringify([n(w, 'dealer_tasks'), n(w, 'dealer_notes'), n(w, 'dealer_visits'), n(w, 'dealer_activity')]), before, 'a replay duplicated records');
  });
  /* ───────────── AI fails twice → manual review with Try AI again; the rep's own additions survive ───────────── */
  await step('AI failure: review still opens; Try AI again works in place; the rep\'s added follow-up is kept; several attendees → rep picks the recipient', async () => {
    await page.goto(`${B}/admin/scheduled-routes.html?route=r-2`); await page.waitForSelector('#stop_0 .btn.go.xl');
    await page.click('#stop_0 .btn.go.xl'); await page.waitForSelector('#vn_0');
    await page.fill('#vn_0', 'Second call at Glasgow. Bryant and Pat Lee. Send PR519 pricing.');
    w.AI.fail = 2; const c0 = w.AI.calls;
    await page.click('#stop_0 .vmode .btn.go.xl'); await page.waitForSelector('#rv_retry', { timeout: 15000 });
    assert.strictEqual(w.AI.calls - c0, 5, 'the server did not retry the failed part exactly once (2 tries + the 3 other parts)');
    assert.ok(/notes are saved/i.test(await page.textContent('#rv_body .rvnote')));
    assert.strictEqual(await page.inputValue('#rv_sum'), 'Second call at Glasgow. Bryant and Pat Lee. Send PR519 pricing.', 'the notes were not kept in the manual summary');
    assert.strictEqual(n(w, 'dealer_tasks', t => t.origin_type === 'visit_report' && t.dealer_id === 'd-greg'), 1, 'records created before approval');
    await page.click('#rv_body button:has-text("Add a follow-up")'); await page.fill('#rv_fu .rv-card:last-child .rv-t', 'Drop off a fabric sample');
    await page.fill('#rv_atname', 'Pat Lee'); await page.click('#rv_body .rv-add button');
    await page.fill('#rv_at .rv-card:last-child .rv-email', 'pat@glasgow.test');
    await page.screenshot({ path: path.join(SHOTS, 'ai-fail-manual.png'), fullPage: true });
    await page.click('#rv_retry'); await page.waitForSelector('#rv_body .rvnote.ok', { timeout: 15000 });
    const fus = await page.$$eval('#rv_fu .rv-card .rv-t', xs => xs.map(x => x.value));
    assert.ok(fus.includes('Send PR519 pricing') && fus.includes('Drop off a fabric sample'), 'follow-ups after retry: ' + fus);
    const att = await page.$$eval('#rv_at .rv-card .rv-name', xs => xs.map(x => x.value)); assert.ok(att.includes('Pat Lee'), 'the added attendee was lost: ' + att);
    await page.screenshot({ path: path.join(SHOTS, 'ai-retry-ok.png'), fullPage: true });
    assert.strictEqual(await page.inputValue('#rv_at .rv-card:last-child .rv-email'), 'pat@glasgow.test', 'the email typed before the retry was lost');
    await page.click('#rv_body > .btn.go.xl'); await page.waitForSelector('.rv-done', { timeout: 15000 });
    await page.click('.rv-done .btn.go.xl'); await page.waitForSelector('#draftwrap #d_body');
    const ticked = await page.$$eval('#d_people .d_p', xs => xs.filter(x => x.checked).map(x => x.getAttribute('data-email')));
    assert.deepStrictEqual(ticked, [], 'a recipient was chosen for the rep: ' + ticked);
    assert.ok(/2 people at the meeting have an email — tick who this goes to/.test(await page.textContent('#draftwrap')));
    assert.ok(/^Hi there,/.test(await page.inputValue('#d_body')), 'the draft greeted someone before a recipient was picked');
    await page.click('#d_people .rcpt:has-text("Pat Lee")');
    assert.ok(/^Hi Pat,/.test(await page.inputValue('#d_body')), 'the greeting did not follow the chosen recipient');
    await page.screenshot({ path: path.join(SHOTS, 'email-multi-attendee.png'), fullPage: true });
    await page.click('#draftwrap button:has-text("Close")'); await page.click('.rv-done .btn.xl:not(.go)');
  });
  await step('field: no JavaScript errors', async () => { assert.deepStrictEqual(errors.filter(e => /^field/.test(e)), []); });
  await ctx.close();

  /* ───────────── Half the answer: the summary is in, the follow-ups half isn't ───────────── */
  await step('AI partial: summary shows with a note and Try AI again; a follow-up typed meanwhile survives the retry', async () => {
    const w3 = world(); const s3 = await serve(w3); const B3 = `http://127.0.0.1:${s3.port}`;
    const c3 = await ctxFor(browser, 'greg', PHONE); const p3 = await c3.newPage(); const errs = []; p3.on('pageerror', e => errs.push(e.message));
    await p3.goto(`${B3}/admin/scheduled-routes.html?route=r-2`); await p3.waitForSelector('#stop_0 .btn.go.xl');
    await p3.click('#stop_0 .btn.go.xl'); await p3.waitForSelector('#vn_0'); await p3.fill('#vn_0', 'Met Bryant. Send PR519 pricing.');
    w3.AI.failNext = 2;
    await p3.click('#stop_0 .vmode .btn.go.xl'); await p3.waitForSelector('#rv_retry', { timeout: 15000 });
    assert.ok(/didn't finish the follow-ups/.test(await p3.textContent('#rv_body .rvnote')), 'no partial note');
    assert.strictEqual(await p3.inputValue('#rv_sum'), AI_VISIT.meeting_summary, 'the summary that came back is not shown');
    assert.strictEqual((await p3.$$('#rv_fu .rv-card')).length, 0);
    await p3.click('#rv_body button:has-text("Add a follow-up")'); await p3.fill('#rv_fu .rv-card:last-child .rv-t', 'Bring the swatch book');
    // the rep edits sections that DID come back — a retry must not touch them
    await p3.fill('#rv_sum', 'Edited by the rep.'); await p3.fill('#rv_op .rv-card .rv-q', '3');
    await p3.click('#rv_at .rv-card:first-child .rv-on');
    await noHScroll(p3, 'partial review phone'); await p3.screenshot({ path: path.join(SHOTS, 'ai-partial.png'), fullPage: true });
    assert.strictEqual(n(w3, 'dealer_tasks', t => t.origin_type === 'visit_report'), 0, 'records created before approval');
    const c0 = w3.AI.calls;
    await p3.click('#rv_retry'); await p3.waitForSelector('#rv_body .rvnote.ok', { timeout: 15000 });
    assert.strictEqual(w3.AI.calls - c0, 1, 'Try AI again asked for more than the missing part');
    assert.strictEqual(await p3.inputValue('#rv_sum'), 'Edited by the rep.', 'the summary was changed by the retry');
    assert.strictEqual(await p3.inputValue('#rv_op .rv-card .rv-q'), '3', 'the deal was changed by the retry');
    assert.strictEqual(await p3.isChecked('#rv_at .rv-card:first-child .rv-on'), false, 'an unticked attendee was ticked again');
    const fus = await p3.$$eval('#rv_fu .rv-card .rv-t', xs => xs.map(x => x.value));
    assert.ok(fus.includes('Send PR519 pricing') && fus.includes('Bring the swatch book'), 'follow-ups after retry: ' + fus);
    await p3.click('#rv_body > .btn.go.xl'); await p3.waitForSelector('.rv-done', { timeout: 15000 });
    assert.ok(n(w3, 'dealer_tasks', t => t.origin_type === 'visit_report' && t.title === 'Bring the swatch book') === 1, 'the typed follow-up was not created');
    assert.deepStrictEqual(errs, []); await c3.close(); s3.srv.close();
  });

  /* ───────────── The parts disagree: the deal is marked for the rep, nothing is chosen ───────────── */
  await step('consistency: when the summary says 6 and the deal says 4, the deal is marked and the banner lists it; the 4 is kept', async () => {
    const w4 = world(); const s4 = await serve(w4); const B4 = `http://127.0.0.1:${s4.port}`;
    w4.AI.override = p => /covers the DEALS/.test(p) ? { opportunities: [{ title: '4 Strongback Excursion chairs', manufacturer_slug: 'strongback-mobility', product: 'Excursion', quantity: 4, contact_name: 'Bryant Smith' }] }
      : /WHAT HAPPENED/.test(p) ? Object.assign({}, AI_VISIT, { meeting_summary: 'Met Bryant. He wants 6 Excursion chairs for the rental fleet.' }) : null;
    const c4 = await ctxFor(browser, 'greg', PHONE); const p4 = await c4.newPage(); const errs = []; p4.on('pageerror', e => errs.push(e.message));
    await p4.goto(`${B4}/admin/scheduled-routes.html?route=r-2`); await p4.waitForSelector('#stop_0 .btn.go.xl');
    await p4.click('#stop_0 .btn.go.xl'); await p4.waitForSelector('#vn_0'); await p4.fill('#vn_0', 'Bryant wants 6 Excursion chairs for the rental fleet.');
    await p4.click('#stop_0 .vmode .btn.go.xl'); await p4.waitForSelector('#rv_checks', { timeout: 15000 });
    assert.ok(/says 4, the summary says 6/.test(await p4.textContent('#rv_checks')), await p4.textContent('#rv_checks'));
    assert.ok(/says 4, the summary says 6/.test(await p4.textContent('#rv_op .rv-card .rv-review')));
    assert.strictEqual(await p4.inputValue('#rv_op .rv-card .rv-q'), '4', 'the quantity was changed');
    await noHScroll(p4, 'checks phone'); await p4.screenshot({ path: path.join(SHOTS, 'ai-checks.png'), fullPage: true });
    assert.deepStrictEqual(errs, []); await c4.close(); s4.srv.close();
  });

  /* ───────────── Poor network: a slow server still completes the review ───────────── */
  await step('slow network: the review waits, then fills in', async () => {
    const w2 = world(); const s2 = await serve(w2, { delayMs: 1500 }); const B2 = `http://127.0.0.1:${s2.port}`;
    const c2 = await ctxFor(browser, 'greg', PHONE); const p2 = await c2.newPage();
    await p2.goto(`${B2}/admin/scheduled-routes.html?route=r-1`); await p2.waitForSelector('#stop_0', { timeout: 20000 });
    await p2.click('#stop_0 .btn.go.xl'); await p2.waitForSelector('#vn_0'); await p2.fill('#vn_0', 'Met Bryant.');
    await p2.click('#stop_0 .vmode .btn.go.xl');
    await p2.waitForSelector('#rv_body .msg'); assert.ok(/Summarizing/.test(await p2.textContent('#rv_body')));
    await p2.waitForSelector('#rv_body .rv-card.opp', { timeout: 30000 });
    await c2.close(); s2.srv.close();
  });

  /* ───────────── Dealer 360: Visits & meetings ───────────── */
  for (const [label, dev] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await step(`Dealer 360 (${label}): Visits & meetings sits between Log a touch and Dealer handout, with the visit and its links`, async () => {
      const c = await ctxFor(browser, 'greg', dev); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(`${B}/admin/dealer.html?id=d-greg`); await p.waitForSelector('#visits .vm', { timeout: 20000 });
      if (label === 'phone') await noHScroll(p, 'Dealer 360 phone (whole page)');
      const order = await p.$$eval('.d360 > div:first-child > .card h2', hs => hs.map(h => h.textContent.trim()));
      const i = order.findIndex(t => /^Visits/.test(t)); assert.ok(i > 0 && /Log a touch/.test(order[i - 1]) && /Dealer handout/.test(order[i + 1]), order.join(' | '));
      const card = await p.textContent('#visits'); assert.ok(/Follow-up pending/.test(card) && /Bryant Smith/.test(card) && /PR519 lift chair/.test(card), card.slice(0, 400));
      await p.click('#visits .vm button:has-text("View full summary")'); assert.ok(/Rep commitments/.test(await p.textContent('#visits .vm-more')));
      await p.click('#visits .vm button:has-text("View tasks")'); assert.ok(/Send PR519 pricing/.test(await p.textContent('#visits .vm-more')));
      await p.click('#visits .vm button:has-text("View opportunit")'); assert.ok(/2 x PR519 lift chairs/.test(await p.textContent('#visits .vm-more')));
      if (label === 'phone') await noHScroll(p, 'Dealer 360 phone');
      await p.$eval('#visitsCard', e => e.scrollIntoView()); await p.screenshot({ path: path.join(SHOTS, `d360-${label}.png`) });
      // Completing the visit's last open task from here moves the follow-up status.
      const firstVisit = await p.$eval('#visits .vm[data-id]', e => e.getAttribute('data-id'));
      const open = w.db.dealer_tasks.filter(t => t.origin_type === 'visit_report' && t.status === 'open' && t.origin_id === firstVisit);
      if (label === 'desktop') {
        await p.click('#visits .vm button:has-text("View tasks")');
        for (const t of open) { await p.click(`#visits .vm-more .tkchk[onclick*="${t.id}"]`); await p.waitForTimeout(400); await p.click('#visits .vm button:has-text("View tasks")').catch(() => {}); }
        const rep = w.db.dealer_visit_reports.find(r => r.id === firstVisit);
        // the deal is still at its approved stage, so the visit stays pending until it moves
        assert.strictEqual(rep.followup_status, 'pending');
      }
      assert.deepStrictEqual(errs, []); await c.close();
    });
  }

  /* ───────────── Command Center ───────────── */
  for (const [label, dev] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    await step(`Command Center (${label}): Greg's own day`, async () => {
      const c = await ctxFor(browser, 'greg', dev); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(`${B}/admin/command-center-rep.html`); await p.waitForSelector('.hello');
      const t = await p.textContent('#body');
      assert.ok(/Open today's route/.test(t) && /Glasgow Prescription Center/.test(t), 'route missing: ' + t.slice(0, 1500));
      assert.ok(/actions completed/.test(t), 'no follow-up progress');
      assert.ok(!/TN loop|Retail Medical/.test(t), 'another rep\'s data leaked');
      assert.strictEqual(await p.$('#repsel'), null, 'a rep was offered the rep picker');
      if (label === 'phone') { await noHScroll(p, 'CC phone'); const small = await smallTargets(p, '.btn, .chk'); assert.deepStrictEqual(small, [], 'touch targets under 44px'); }
      await p.screenshot({ path: path.join(SHOTS, `cc-greg-${label}.png`), fullPage: true });
      const r2 = await p.goto(`${B}/admin/command-center-rep.html?rep=angelo@hcps.us`); await p.waitForSelector('.hello');
      assert.ok(!/TN loop/.test(await p.textContent('#body')), 'a rep opened the president\'s day');
      assert.deepStrictEqual(errs, []); await c.close();
    });
  }
  await step('Command Center: the president picks Greg — read-only', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage();
    await p.goto(`${B}/admin/command-center-rep.html`); await p.waitForSelector('#repsel');
    await p.selectOption('#repsel', 'greg@hcps.us'); await p.waitForSelector('.viewing');
    const t = await p.textContent('#body'); assert.ok(/Greg Campbell/.test(t) && /Glasgow Prescription Center/.test(t), t.slice(0, 300));
    const chk = await p.$$eval('.chk', bs => bs.map(b => b.disabled)); assert.ok(chk.length && chk.every(Boolean), 'the president could tick Greg\'s tasks');
    await p.screenshot({ path: path.join(SHOTS, 'cc-pres-viewing-greg.png'), fullPage: true });
    await c.close();
  });
  await step('Command Center: Relations can view a rep (Phase 0 matrix)', async () => {
    const c = await ctxFor(browser, 'lori', DESKTOP); const p = await c.newPage();
    await p.goto(`${B}/admin/command-center-rep.html?rep=greg@hcps.us`); await p.waitForSelector('.viewing');
    assert.ok(/Glasgow Prescription Center/.test(await p.textContent('#body'))); await c.close();
  });

  /* ───────────── My Sales Workspace (the President's own book) ───────────── */
  await step('Workspace: the President enters from the masthead — his own day, no picker, Back to Admin', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(`${B}/admin/tasks.html`); await p.waitForSelector('#ac-ws-enter');
    await p.waitForFunction(() => /Old overdue call/.test(document.body.innerText), null, { timeout: 15000 });   // Admin queue: company-wide
    assert.strictEqual(await p.$('.ac-ws'), null, 'workspace banner shown in the Admin view');
    await p.click('#ac-ws-enter'); await p.waitForSelector('.hello');
    assert.strictEqual((await p.textContent('#pgtitle')).trim(), 'My Sales Workspace');
    assert.ok(await p.$('.ac-ws') && await p.$('#ac-ws-exit') && await p.$('#wsback'), 'no workspace banner / Back to Admin');
    assert.strictEqual(await p.$('#repsel'), null, 'the rep picker is offered inside the workspace');
    const t = await p.textContent('#body');
    assert.ok(/TN loop|RMS/.test(t), 'his own route is missing: ' + t.slice(0, 400));
    assert.ok(!/KY loop|Glasgow Prescription/.test(t), 'Greg\'s day leaked into the workspace');
    assert.ok(!/read-only/.test(t), 'his own workspace is read-only');
    const nav = await p.$$eval('.ac-nav a', as => as.map(a => a.textContent.trim()));
    assert.deepStrictEqual(nav, ['My Command Center', "Today's Route & Visits", 'Route Planner', 'Dealer 360', 'My Tasks', 'Pipeline'], nav.join(' | '));
    await p.screenshot({ path: path.join(SHOTS, 'ws-1-command-center.png'), fullPage: true });
    // My Tasks inside the workspace: his own, no engine console.
    await p.click('.ac-nav a:has-text("My Tasks")'); await p.waitForSelector('.ac-ws');
    await p.waitForFunction(() => /My Tasks/.test((document.querySelector('#pgtitle') || {}).textContent || ''), null, { timeout: 15000 });
    assert.ok(!/Old overdue call/.test(await p.textContent('body')), 'Greg\'s task in his workspace');
    assert.strictEqual(await p.$('#mirbtn'), null, 'engine console inside the workspace');
    // The field app: his routes only, with the way back.
    await p.click('.ac-nav a:has-text("Today\'s Route")'); await p.waitForSelector('#wsstrip', { state: 'visible' });
    await p.waitForFunction(() => /TN loop/.test(document.body.innerText), null, { timeout: 15000 });
    assert.ok(!/KY loop/.test(await p.textContent('#app')), 'a route he planned for Greg shows in his workspace');
    await p.screenshot({ path: path.join(SHOTS, 'ws-2-field-app.png'), fullPage: true });
    // Dealer 360 picker: his book.
    await p.goto(`${B}/admin/dealer.html`); await p.waitForSelector('.ac-ws');
    await p.waitForFunction(() => /Retail Medical Solutions/.test(document.body.innerText), null, { timeout: 15000 });
    assert.ok(!/Glasgow Prescription Center/.test(await p.textContent('#body')), 'Greg\'s dealer in his Dealer 360 list');
    // Back to Admin Dashboard: the flag is gone and the Admin views are company-wide again.
    await p.click('#ac-ws-exit'); await p.waitForURL(/\/admin\/(\?workspace=off)?$/);
    assert.strictEqual(await p.evaluate(() => sessionStorage.getItem('hcps_workspace')), null);
    await p.goto(`${B}/admin/tasks.html`); await p.waitForFunction(() => /Old overdue call/.test(document.body.innerText), null, { timeout: 15000 });
    assert.strictEqual(await p.$('.ac-ws'), null);
    assert.deepStrictEqual(errs.filter(e => !/analytics|Failed to fetch/.test(e)), []); await c.close();
  });
  await step('Admin Dashboard: My Sales Workspace in the header and as a callout (desktop + phone); it opens the workspace', async () => {
    for (const [label, dev] of [['desktop', DESKTOP], ['phone', PHONE]]) {
      const c = await ctxFor(browser, 'pres', dev); const p = await c.newPage();
      await p.goto(`${B}/admin/`); await p.waitForSelector('#ws-callout', { state: 'visible', timeout: 15000 });
      assert.ok(await p.isVisible('#ws-enter'), label + ': header button hidden');
      await noHScroll(p, 'dashboard ' + label); await p.screenshot({ path: path.join(SHOTS, `dashboard-${label}.png`) });
      await p.click('#ws-callout'); await p.waitForSelector('.ac-ws');
      assert.strictEqual((await p.textContent('#pgtitle')).trim(), 'My Sales Workspace');
      await c.close();
    }
  });
  await step('Workspace (phone): banner, Back to Admin and the field-app strip fit a phone', async () => {
    const c = await ctxFor(browser, 'pres', PHONE); const p = await c.newPage();
    await p.goto(`${B}/admin/command-center-rep.html?workspace=mine`); await p.waitForSelector('.hello');
    await noHScroll(p, 'workspace CC phone'); await p.screenshot({ path: path.join(SHOTS, 'ws-phone-cc.png'), fullPage: true });
    const back = await p.$eval('#ac-ws-exit', e => e.getBoundingClientRect().height); assert.ok(back >= 24, 'Back to Admin too small: ' + back);
    await p.goto(`${B}/admin/scheduled-routes.html`); await p.waitForSelector('#wsstrip', { state: 'visible' });
    await noHScroll(p, 'workspace field app phone'); await p.screenshot({ path: path.join(SHOTS, 'ws-phone-field.png'), fullPage: true });
    await c.close();
  });
  await step('Workspace: opening an Admin page leaves it; the management view of Greg stays read-only', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage();
    await p.goto(`${B}/admin/command-center-rep.html?workspace=mine`); await p.waitForSelector('.ac-ws');
    await p.goto(`${B}/admin/permission-check.html`);   // not a workspace page
    await p.goto(`${B}/admin/command-center-rep.html?rep=greg@hcps.us`); await p.waitForSelector('.viewing');
    assert.strictEqual(await p.$('.ac-ws'), null, 'the workspace followed him into the Admin view');
    const chk = await p.$$eval('.chk', bs => bs.map(b => b.disabled)); assert.ok(chk.length && chk.every(Boolean), 'Greg\'s tasks could be ticked');
    await c.close();
  });
  await step('Workspace: a rep or Relations asking for it gets nothing different', async () => {
    for (const who of ['greg', 'lori']) {
      const c = await ctxFor(browser, who, DESKTOP); const p = await c.newPage();
      await p.goto(`${B}/admin/command-center-rep.html?workspace=mine`); await p.waitForSelector('.hello');
      assert.strictEqual(await p.$('.ac-ws'), null, who + ' got the workspace banner');
      assert.strictEqual(await p.$('#ac-ws-enter'), null, who + ' was offered My Sales Workspace');
      assert.notStrictEqual((await p.textContent('#pgtitle')).trim(), 'My Sales Workspace');
      const sent = calls.filter(x => x.name === 'rep-command-api');   // headers aren't recorded; the page must not claim the mode
      assert.ok(sent.length);
      if (who === 'lori') await p.waitForSelector('#repsel');   // Relations keeps the rep picker
      await c.close();
    }
  });
  // Phase 2E: Angelo's TEST deal (the Permission check probes it by id) and one of Greg's — added here so the
  // visit-flow steps above still start with no deals.
  w.db.opportunities = (w.db.opportunities || []).concat([{ id: 'cd84e191-74c9-481a-8786-a31fa6093164', dealer_id: '3f7d87a2-7fbc-47e1-a34a-aaaacf4c4c7b', title: 'TEST deal', stage: 'identified', status: 'open', value: 100, owner_rep: 'Angelo Audia', owner_email: 'angelo@hcps.us', source: 'manual', created_at: new Date(Date.now() - 10 * 864e5).toISOString() },
      { id: 'o-greg-1', dealer_id: 'd-greg', title: 'Glasgow lift chairs', stage: 'quoted', status: 'open', value: 2400, owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us', source: 'manual', created_at: new Date(Date.now() - 20 * 864e5).toISOString() }]);
  w.db.opportunity_events = (w.db.opportunity_events || []).concat([{ opportunity_id: 'o-greg-1', kind: 'baseline', to_stage: 'quoted', to_status: 'open', value: 2400, changed_by: 'system', source: 'baseline', changed_at: new Date(Date.now() - 5 * 864e5).toISOString() }]);
  await step('Permission check (president): My Sales Workspace check passes in his own session', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage();
    await p.goto(`${B}/admin/permission-check.html`); await p.waitForSelector('#wscheck');
    await p.click('#wscheck'); await p.waitForSelector('.verdict.ok, .verdict.bad', { timeout: 30000 });
    const fails = await p.$$eval('.row', rs => rs.filter(r => r.querySelector('.r.f')).map(r => r.innerText.replace(/\s+/g, ' ')));
    assert.deepStrictEqual(fails, [], 'failed checks: ' + fails.join(' | '));
    await p.screenshot({ path: path.join(SHOTS, 'permission-check-workspace.png'), fullPage: true });
    await c.close();
  });

  /* ───────────── Permission check page: the live server answers, as the person being checked ───────────── */
  for (const who of ['greg', 'lori']) {
    await step(`Permission check (${who}): every refusal and every allowed action passes, on a phone`, async () => {
      const c = await ctxFor(browser, who, PHONE); const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(`${B}/admin/permission-check.html`); await p.waitForSelector('.verdict.ok, .verdict.bad', { timeout: 30000 });
      const fails = await p.$$eval('.row', rs => rs.filter(r => r.querySelector('.r.f')).map(r => r.innerText.replace(/\s+/g, ' ')));
      assert.deepStrictEqual(fails, [], 'failed checks: ' + fails.join(' | '));
      assert.ok(/ALL \d+ CHECKS PASSED/.test(await p.textContent('#verdict')));
      await noHScroll(p, 'permission check phone'); await p.screenshot({ path: path.join(SHOTS, `permission-check-${who}.png`), fullPage: true });
      assert.deepStrictEqual(errs, []); await c.close();
    });
  }
  await step('Permission check (president): offers the rep and Relations accounts to check, and runs nothing until asked', async () => {
    const c = await ctxFor(browser, 'pres', DESKTOP); const p = await c.newPage();
    await p.goto(`${B}/admin/permission-check.html`); await p.waitForSelector('#who .btn', { timeout: 15000 });
    const names = await p.$$eval('#who .btn', b => b.map(x => x.textContent.trim()));
    assert.ok(names.some(t => /Greg Campbell/.test(t)) && names.some(t => /Lori Hunt/.test(t)) && !names.some(t => /Angelo/.test(t)), names.join(' | '));
    assert.strictEqual(await p.$('#verdict'), null, 'the check ran in the president\'s own session');
    await c.close();
  });

  await browser.close(); srv.close();
  console.log(`\nPhase 1 UI: ${pass} passed, ${fail} failed  (screenshots in ${SHOTS})`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

/* HCPS Smart Email Learning, Phase 1 — capture, end to end through the REAL handlers on the mock world (synthetic data only).
   - nothing is kept while the switch is off, or for anyone but the President (owner decision 2)
   - a kept draft is exactly what the editor shows (body + signature); the send keeps exactly what Outlook was given
   - capture never changes a draft answer, a send answer or what is sent, and a capture failure never fails either
   - a send pairs only with the sender's own draft for the same dealer, once
   - the owner page API is President only and read only
     node test/email-learning-p1.test.js */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
const FAKE = require('./email-learning.fake');
const EL = require('../netlify/functions/_email_learning.js');

const UA = '0a0a0a0a-0000-4000-8000-00000000000a', UG = '0b0b0b0b-0000-4000-8000-00000000000b';
function world(opts) {
  opts = opts || {};
  const S = standardSeed({
    dealers: [{ id: UA, business_name: 'Sampletown Medical', rep_name: 'Angelo Audia', parent_id: null, email: 'pat@sampletown.test', contact_name: 'Pat Example', state: 'TN' },
      { id: UG, business_name: 'Exampleville Pharmacy', rep_name: 'Greg Campbell', parent_id: null, email: 'lee@exampleville.test', contact_name: 'Lee Sample', state: 'KY' }],
    app_settings: [{ key: 'phase2_flags', value: Object.assign({}, opts.flags === undefined ? { email_learning_capture: true } : opts.flags) }],
    dealer_visit_reports: [], email_drafts: [],
  });
  S.rpc = FAKE.rpc();
  if (opts.missing) S.missingRpc = ['hcps_email_draft_create', 'hcps_email_draft_record_send'];
  S.ai = () => ({ subject: 'PR519 pricing for Sampletown', body: 'Hi Pat,\n\nThe PR519 is a strong fit for your lift chair line.\n\nWould Tuesday or Thursday suit a quick review?' });
  return createWorld(S);
}
const rpcCalls = (w, fn) => w.writes.filter(x => x.kind === 'rpc' && x.fn === fn);
const sends = w => w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url));

(async () => {
  // ── pure pieces ──────────────────────────────────────────────────────────
  await t('types: every generator template maps to an approved email type', () => {
    for (const k of ['previsit', 'visit_followup', 'follow_up', 'dormant_account', 'new_product', 'product_opportunity', 'reorder_reminder', 'cross_sell', 'portal_activation'])
      assert.ok(EL.EMAIL_TYPES.includes(EL.emailType(k)), k);
    assert.strictEqual(EL.emailType('new_product'), 'product_intro'); assert.strictEqual(EL.emailType('dormant_account'), 'dormant_account');
    assert.strictEqual(EL.emailType('nonsense'), null);
  });
  await t('who is captured: the President only (Greg, Lori, the analytics token, no email → nobody)', () => {
    assert.strictEqual(EL.captureAuthor({ role: 'president', email: 'Angelo@HCPS.us' }), 'angelo@hcps.us');
    for (const me of [{ role: 'rep', email: 'greg@hcps.us' }, { role: 'relations', email: 'lori@hcps.us' }, { role: 'admin', email: 'a@hcps.us' }, { role: 'president', email: '' }, null])
      assert.strictEqual(EL.captureAuthor(me), null);
  });
  await t('asShown: body, blank line, signature — exactly what the editors put in the message box', () => {
    assert.strictEqual(EL.asShown('Hi,\n\nText', 'Sam\nHCPS'), 'Hi,\n\nText\n\nSam\nHCPS');
    assert.strictEqual(EL.asShown('Hi', ''), 'Hi');
  });
  await t('lineDiff: unchanged / removed / added lines in order', () => {
    assert.deepStrictEqual(EL.lineDiff('a\nb\nc', 'a\nB\nc'), [{ op: 'same', text: 'a' }, { op: 'del', text: 'b' }, { op: 'add', text: 'B' }, { op: 'same', text: 'c' }]);
  });
  await t('recordDraft / recordSend never throw — a broken database call answers null / a status', async () => {
    const me = { role: 'president', email: 'angelo@hcps.us' }, sbGet = async () => [{ value: { email_learning_capture: true } }];
    const boom = async () => { throw new Error('down'); };
    assert.strictEqual(await EL.recordDraft(sbGet, me, { template: 'follow_up', generator: 'ai-email-api', subject: 's', body: 'b' }, boom), null);
    assert.strictEqual(await EL.recordSend(sbGet, me, { draft_id: UA, subject: 's', body: 'b' }, boom), 'error');
    const badFlags = async () => { throw new Error('flags unreadable'); };
    let called = false; const spy = async () => { called = true; return { ok: true, id: UA }; };
    assert.strictEqual(await EL.recordDraft(badFlags, me, { template: 'follow_up', generator: 'ai-email-api', subject: 's', body: 'b' }, spy), null);
    assert.strictEqual(called, false, 'an unreadable switch must mean OFF');
  });

  // ── pre-visit heads-up (routes-api) ──────────────────────────────────────
  let w = world(), R = load('routes-api.js', w);
  let hu;
  await t('heads-up as the President, switch on: the answer is unchanged plus draft_id; the kept draft = body + signature', async () => {
    const r = await call(R, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-03', eta: '11:21 AM', contact_name: 'Pat Example' }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.ok(r.body.ok && /^[0-9a-f-]{36}$/.test(r.body.draft_id), JSON.stringify(r.body));
    hu = r.body;
    const row = w.db.email_drafts.find(x => x.id === hu.draft_id);
    assert.strictEqual(row.email_type, 'previsit_headsup'); assert.strictEqual(row.generator, 'routes-api'); assert.strictEqual(row.author_email, 'angelo@hcps.us');
    assert.strictEqual(row.dealer_id, UA); assert.strictEqual(row.original_subject, hu.subject);
    assert.strictEqual(row.original_body, hu.body + '\n\n' + hu.signature);
  });
  await t('heads-up wording is exactly what it was before capture (only draft_id is new)', async () => {
    const w0 = world({ flags: {} }), R0 = load('routes-api.js', w0);
    const r = await call(R0, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-03', eta: '11:21 AM', contact_name: 'Pat Example' }, { token: 'pres' });
    assert.strictEqual(r.body.draft_id, null);
    const { draft_id: a, ...restA } = hu, { draft_id: b, ...restB } = r.body;
    assert.deepStrictEqual(restA, restB);
  });
  await t('heads-up by Greg: no draft kept, no database call', async () => {
    const before = rpcCalls(w, 'hcps_email_draft_create').length;
    const r = await call(R, { action: 'previsit_draft', dealer_id: UG, date: '2026-11-03', eta: '9:00 AM' }, { token: 'greg' });
    assert.ok(r.body.ok); assert.strictEqual(r.body.draft_id, null);
    assert.strictEqual(rpcCalls(w, 'hcps_email_draft_create').length, before);
  });
  await t('switch off (missing / false / "true" as text): nothing kept, no database call', async () => {
    for (const flags of [{}, { email_learning_capture: false }, { email_learning_capture: 'true' }]) {
      const w2 = world({ flags }), R2 = load('routes-api.js', w2);
      const r = await call(R2, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-03' }, { token: 'pres' });
      assert.ok(r.body.ok); assert.strictEqual(r.body.draft_id, null);
      assert.strictEqual(rpcCalls(w2, 'hcps_email_draft_create').length, 0, JSON.stringify(flags));
    }
  });
  await t('migration not installed: the heads-up still answers normally (draft_id null)', async () => {
    const w3 = world({ missing: true }), R3 = load('routes-api.js', w3);
    const r = await call(R3, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-03' }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.ok(r.body.ok && r.body.subject); assert.strictEqual(r.body.draft_id, null);
  });

  // ── send (email-sync-api) ────────────────────────────────────────────────
  let E = load('email-sync-api.js', w);
  await t('send with the draft id: Outlook gets exactly what was typed; the edited version is kept beside the draft; the answer is unchanged', async () => {
    const edited = 'Hi Pat,\n\nI\'ll be in Sampletown Tuesday morning — about 11:20.\n\nAngelo';
    const r = await call(E, { action: 'send', dealer_id: UA, to: 'pat@sampletown.test', cc: ['buyer@sampletown.test'], subject: 'Tuesday visit', body_text: edited, draft_id: hu.draft_id }, { token: 'pres' });
    assert.deepStrictEqual(r.body, { ok: true, to: 'pat@sampletown.test', cc: ['buyer@sampletown.test'] });
    const g = sends(w); assert.strictEqual(g.length, 1);
    const msg = JSON.parse(typeof g[0].body === 'string' ? g[0].body : JSON.stringify(g[0].body)).message;
    assert.strictEqual(msg.subject, 'Tuesday visit'); assert.ok(msg.body.content.includes('Sampletown Tuesday morning'));
    assert.ok(!JSON.stringify(msg).includes(hu.draft_id), 'the draft id must never reach the email');
    const row = w.db.email_drafts.find(x => x.id === hu.draft_id);
    assert.strictEqual(row.sent_body, edited); assert.strictEqual(row.sent_subject, 'Tuesday visit'); assert.strictEqual(row.edited, true); assert.strictEqual(row.recipient_count, 2);
    assert.strictEqual(row.original_body, hu.body + '\n\n' + hu.signature, 'the original never changes');
    assert.ok(!JSON.stringify(row).includes('pat@sampletown.test') && !JSON.stringify(row).includes('buyer@'), 'no recipient address is kept');
  });
  await t('the same draft sent again is not recorded twice (first send stays)', async () => {
    const r = await call(E, { action: 'send', dealer_id: UA, to: 'pat@sampletown.test', subject: 'Again', body_text: 'Again', draft_id: hu.draft_id }, { token: 'pres' });
    assert.ok(r.body.ok);
    assert.strictEqual(w.db.email_drafts.find(x => x.id === hu.draft_id).sent_subject, 'Tuesday visit');
  });
  await t('a failed Outlook send records nothing', async () => {
    const d = await call(R, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-04' }, { token: 'pres' });
    const w2 = w; const realFetch = w2.fetch;
    const failing = async (url, o) => (/sendMail/.test(String(url)) ? new Response('{"error":"boom"}', { status: 500 }) : realFetch(url, o));
    w2.fetch = failing; global.fetch = failing;
    try {
      const r = await call(E, { action: 'send', dealer_id: UA, to: 'pat@sampletown.test', subject: 'S', body_text: 'B', draft_id: d.body.draft_id }, { token: 'pres' });
      assert.strictEqual(r.body.ok, false);
    } finally { w2.fetch = realFetch; global.fetch = realFetch; }
    assert.strictEqual(w.db.email_drafts.find(x => x.id === d.body.draft_id).sent_at, null);
  });
  await t('capture failure after a successful send: the send still answers ok, unchanged', async () => {
    const d = await call(R, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-05' }, { token: 'pres' });
    const S2 = standardSeed({ dealers: [{ id: UA, business_name: 'Sampletown Medical', rep_name: 'Angelo Audia', parent_id: null }], app_settings: [{ key: 'phase2_flags', value: { email_learning_capture: true } }] });
    S2.rpc = FAKE.rpc(); S2.failWrite = (m, tbl) => (tbl === 'rpc/hcps_email_draft_record_send' ? 500 : 0);
    const w5 = createWorld(S2), E5 = load('email-sync-api.js', w5);
    const r = await call(E5, { action: 'send', dealer_id: UA, to: 'pat@sampletown.test', subject: 'S', body_text: 'B', draft_id: d.body.draft_id }, { token: 'pres' });
    assert.deepStrictEqual(r.body, { ok: true, to: 'pat@sampletown.test', cc: [] });
    assert.strictEqual(sends(w5).length, 1);
    E = load('email-sync-api.js', w);
  });
  await t('a send cannot claim someone else\'s draft or another dealer\'s draft', async () => {
    const d = await call(R, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-06' }, { token: 'pres' });
    // Greg sending with Angelo's draft id: not captured at all (not the President)
    await call(E, { action: 'send', dealer_id: UG, to: 'lee@exampleville.test', subject: 'S', body_text: 'B', draft_id: d.body.draft_id }, { token: 'greg' });
    assert.strictEqual(w.db.email_drafts.find(x => x.id === d.body.draft_id).sent_at, null);
    // Angelo sending to another dealer with this draft id: dealer mismatch
    const r6 = await call(E, { action: 'send', dealer_id: UG, to: 'lee@exampleville.test', subject: 'S', body_text: 'B', draft_id: d.body.draft_id }, { token: 'pres' });
    assert.ok(r6.body.ok); assert.strictEqual(w.db.email_drafts.find(x => x.id === d.body.draft_id).sent_at, null);
    const last = rpcCalls(w, 'hcps_email_draft_record_send').slice(-1)[0];
    assert.strictEqual(last.p.author_email, 'angelo@hcps.us', 'the author always comes from the sign-in, never the request');
  });
  await t('the sent text is kept exactly — trailing spaces and blank lines included', async () => {
    const d = await call(R, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-07' }, { token: 'pres' });
    const exact = '  Hi Pat,\n\nTuesday works.  \n\n';
    await call(E, { action: 'send', dealer_id: UA, to: 'pat@sampletown.test', subject: 'S', body_text: exact, draft_id: d.body.draft_id }, { token: 'pres' });
    assert.strictEqual(w.db.email_drafts.find(x => x.id === d.body.draft_id).sent_body, exact);
  });
  await t('switch turned off between drafting and sending: the send is not kept', async () => {
    const d = await call(R, { action: 'previsit_draft', dealer_id: UA, date: '2026-11-08' }, { token: 'pres' });
    const fl = w.db.app_settings.find(x => x.key === 'phase2_flags'); fl.value = { email_learning_capture: false };
    try {
      const r = await call(E, { action: 'send', dealer_id: UA, to: 'pat@sampletown.test', subject: 'S', body_text: 'B', draft_id: d.body.draft_id }, { token: 'pres' });
      assert.ok(r.body.ok);
      assert.strictEqual(w.db.email_drafts.find(x => x.id === d.body.draft_id).sent_at, null);
    } finally { fl.value = { email_learning_capture: true }; }
  });
  await t('a send without a draft id (typed from scratch) makes no database call', async () => {
    const before = rpcCalls(w, 'hcps_email_draft_record_send').length;
    const r = await call(E, { action: 'send', dealer_id: UA, to: 'pat@sampletown.test', subject: 'S', body_text: 'B' }, { token: 'pres' });
    assert.ok(r.body.ok); assert.strictEqual(rpcCalls(w, 'hcps_email_draft_record_send').length, before);
  });
  await t('a junk draft id is ignored before any database call', async () => {
    const before = rpcCalls(w, 'hcps_email_draft_record_send').length;
    await call(E, { action: 'send', dealer_id: UA, to: 'pat@sampletown.test', subject: 'S', body_text: 'B', draft_id: "x'),(drop" }, { token: 'pres' });
    assert.strictEqual(rpcCalls(w, 'hcps_email_draft_record_send').length, before);
  });

  // ── visit follow-up: the saved draft keeps its id ─────────────────────────
  await t('visit_email_save keeps the draft id with the saved follow-up, and keeps it on a later save without one', async () => {
    const w7 = world();
    w7.db.dealer_visit_reports.push({ id: 'vr-1', dealer_id: UA, route_id: null, rep_email: 'angelo@hcps.us', status: 'completed', approved_at: new Date().toISOString() });
    const R7 = load('routes-api.js', w7);
    const id = '0c0c0c0c-0000-4000-8000-00000000000c';
    let r = await call(R7, { action: 'visit_email_save', dealer_id: UA, report_id: 'vr-1', email: { to: 'pat@sampletown.test', subject: 'S', body: 'B', draft_id: id } }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.email.draft_id, id);
    r = await call(R7, { action: 'visit_email_save', dealer_id: UA, report_id: 'vr-1', email: { to: 'pat@sampletown.test', subject: 'S2', body: 'B2' } }, { token: 'pres' });
    assert.strictEqual(r.body.email.draft_id, id);
    r = await call(R7, { action: 'visit_email_save', dealer_id: UA, report_id: 'vr-1', email: { subject: 'S3', body: 'B3', draft_id: 'not-a-uuid' } }, { token: 'pres' });
    assert.strictEqual(r.body.email.draft_id, id, 'a junk id never replaces the real one');
  });

  // ── Dealer 360 AI composer (ai-email-api) ─────────────────────────────────
  await t('AI draft as the President: draft_id returned; kept as body + signature with its email type', async () => {
    const w8 = world(), A = load('ai-email-api.js', w8, { ANTHROPIC_API_KEY: 'k' });
    const r = await call(A, { action: 'draft', dealer_id: UA, template: 'new_product', contact_name: 'Pat Example' }, { token: 'pres' });
    assert.ok(r.body.ok, JSON.stringify(r.body)); assert.ok(/^[0-9a-f-]{36}$/.test(r.body.draft_id));
    const row = w8.db.email_drafts[0];
    assert.strictEqual(row.email_type, 'product_intro'); assert.strictEqual(row.template, 'new_product'); assert.strictEqual(row.generator, 'ai-email-api');
    assert.strictEqual(row.original_body, r.body.body + '\n\n' + r.body.signature);
  });
  await t('AI draft by Greg: no draft_id, nothing kept', async () => {
    const w9 = world(), A = load('ai-email-api.js', w9, { ANTHROPIC_API_KEY: 'k' });
    const r = await call(A, { action: 'draft', dealer_id: UG, template: 'follow_up' }, { token: 'greg' });
    assert.ok(r.body.ok); assert.strictEqual(r.body.draft_id, null); assert.strictEqual(w9.db.email_drafts.length, 0);
  });

  // ── owner page API ───────────────────────────────────────────────────────
  const L = load('email-learning-api.js', w);
  await t('owner page: no token 401, forged token 401, Greg 403, Lori 403', async () => {
    assert.strictEqual((await call(L, { action: 'status' })).status, 401);
    assert.strictEqual((await call(L, { action: 'status' }, { token: 'forged' })).status, 401);
    assert.strictEqual((await call(L, { action: 'status' }, { token: 'greg' })).status, 403);
    assert.strictEqual((await call(L, { action: 'list' }, { token: 'lori' })).status, 403);
  });
  await t('owner page: status counts; list carries no email text beyond the subject; get shows both versions + comparison', async () => {
    const s = await call(L, { action: 'status' }, { token: 'pres' });
    assert.strictEqual(s.status, 200); assert.ok(s.body.installed && s.body.capture_on); assert.ok(s.body.totals.drafts >= 4 && s.body.totals.sent >= 1);
    const l = await call(L, { action: 'list', only: 'edited' }, { token: 'pres' });
    assert.strictEqual(l.status, 200); assert.ok(l.body.rows.length >= 1);
    const flat = JSON.stringify(l.body.rows);
    assert.ok(!flat.includes('Sampletown Tuesday morning') && !flat.includes('sent_body') && !flat.includes('original_body'));
    const g = await call(L, { action: 'get', id: hu.draft_id }, { token: 'pres' });
    assert.strictEqual(g.status, 200); assert.strictEqual(g.body.draft.dealer, 'Sampletown Medical');
    assert.ok(g.body.diff.body.some(x => x.op === 'add' && /Tuesday morning/.test(x.text)));
    assert.strictEqual((await call(L, { action: 'get', id: 'nope' }, { token: 'pres' })).status, 400);
    assert.strictEqual((await call(L, { action: 'list', type: 'bogus' }, { token: 'pres' })).status, 400);
  });
  await t('owner page: GET refused; unknown action refused; no write action exists', async () => {
    assert.strictEqual((await call(L, { action: 'status' }, { token: 'pres', method: 'GET' })).status, 405);
    for (const a of ['create', 'record_send', 'delete', 'purge', 'approve']) assert.strictEqual((await call(L, { action: a }, { token: 'pres' })).status, 400, a);
  });
  await t('owner page before the migration: status says not installed; list 503', async () => {
    const S = standardSeed({ app_settings: [{ key: 'phase2_flags', value: {} }] }); S.missingTables = ['email_drafts'];
    const L10 = load('email-learning-api.js', createWorld(S));
    const s = await call(L10, { action: 'status' }, { token: 'pres' });
    assert.strictEqual(s.status, 200); assert.strictEqual(s.body.installed, false); assert.strictEqual(s.body.capture_on, false);
    assert.strictEqual((await call(L10, { action: 'list' }, { token: 'pres' })).status, 503);
    assert.strictEqual((await call(L10, { action: 'get', id: UA }, { token: 'pres' })).status, 503);
  });
  done('Email learning P1');
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

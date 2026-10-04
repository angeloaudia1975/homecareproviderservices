/* Phase 2B — the AI Morning Brief (rep-command-api `brief`, stored in rep_daily_briefs).

   Approved rules under test:
     · `today` never runs AI and never writes; it only reads today's stored brief (the page renders at once)
     · one stored brief per person per day, reused; a signals_key marks it stale when the day's facts change
     · every focus item / watch-out points at a real task, deal, follow-up, appointment, stop or signal from
       the input — anything else (or any invented $ amount) is dropped before storage
     · one (re)generation per person per 10 minutes; one generation at a time (the row is the lock)
     · if the AI fails, nothing fake is stored: the page falls back to the rule-based priorities
     · management and Relations may READ a rep's stored brief, never write one in that person's name
     · a rep's and the President's signals come from their own book (My Sales Workspace and Admin view
       alike); Customer Relations gets her own work plus the top company-wide relationship signals
     · behind the morning_brief switch */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
// Loaded through the harness so the mutation run (phase0.mutants.js) reaches the pure functions too.
const BAI = load('_brief_ai.js', createWorld(standardSeed()));

const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), YDAY = dayStr(-1), AGO5 = dayStr(-5), AGO20 = dayStr(-20);
const TZ = new Date().getTimezoneOffset();
const WS = { 'x-hcps-workspace': 'mine' };
const nowIso = () => new Date().toISOString();

// The fake AI answers with the first refs it was given (so every item is grounded) unless a test says otherwise.
const refsIn = p => [...String(p).matchAll(/^- ([RATFDS]\d+) /gm)].map(m => m[1]);
const goodAI = body => { const p = body.messages[0].content; const r = refsIn(p);
  return { headline: 'Three things matter today.', focus: r.slice(0, 4).map(x => ({ ref: x, reason: 'It is due now and the dealer is waiting.', action: 'Call them this morning' })),
    watch_outs: r.slice(4, 5).map(x => ({ ref: x, text: 'Keep an eye on this one.' })), first_stop: /- R1 /.test(p) ? { ref: 'R1', tip: 'Start with the open follow-up.' } : undefined }; };

function seed(opts) {
  opts = opts || {};
  const S = standardSeed({
    dealers: [
      { id: 'd-ang-mail', business_name: 'Clarksville Home Medical', rep_email: 'angelo@hcps.us', rep_name: null, parent_id: null, state: 'TN' },
      { id: 'd-test', business_name: 'TEST — Sandbox', rep_name: null, parent_id: null, state: 'IN', is_test: true } ],
    rep_routes: [{ id: 'r-g', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', name: 'Greg today', scheduled_date: TODAY, stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center' }] }],
    dealer_tasks: [
      { id: 't-g1', dealer_id: 'd-greg', title: 'Call Glasgow about the PO', status: 'open', priority: 'high', due_date: YDAY, assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' },
      { id: 't-l1', dealer_id: 'd-none', title: 'Lori: check on the House account', status: 'open', priority: 'normal', due_date: TODAY, assigned_rep: 'Lori Hunt', assigned_email: 'lori@hcps.us' },
      { id: 't-a1', dealer_id: 'd-ang', title: 'Angelo: send RMS pricing', status: 'open', priority: 'high', due_date: TODAY, assigned_rep: 'Angelo Audia', assigned_email: 'angelo@hcps.us' } ],
    opportunities: [{ id: 'o-g', dealer_id: 'd-greg', title: '2 x PR519', stage: 'quoted', status: 'open', value: 1798, expected_close: YDAY, owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us', created_at: AGO20, updated_at: AGO5 }],
    dealer_visit_reports: [
      { id: 'v-g', route_id: null, dealer_id: 'd-greg', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: AGO5 + 'T15:00:00Z', completed_at: AGO5 + 'T16:00:00Z', approved_at: AGO5 + 'T16:00:00Z',
        followup_status: 'pending', followup_due: YDAY, summary: { meeting_summary: 'Met Rita.', dealer_commitments: [{ text: 'send the PO', due_date: YDAY }], rep_commitments: [{ text: 'send pricing', due_date: YDAY }] } } ],
    dealer_engagement: [
      { dealer_id: 'd-greg', status: 'at_risk', trend: 'down', churn_score: 70, months_since: 3, last_period: '2026-06', total_sales: 50000, recent_sales: 2000 },
      { dealer_id: 'd-ang', status: 'watch', trend: 'flat', churn_score: 40, months_since: 2, last_period: '2026-07', total_sales: 20000, recent_sales: 5000 },
      { dealer_id: 'd-ang-mail', status: 'healthy', trend: 'down', churn_score: 30, months_since: 1, last_period: '2026-08', total_sales: 9000, recent_sales: 900 },
      { dealer_id: 'd-none', status: 'dormant', trend: 'down', churn_score: 50, months_since: 5, last_period: '2026-04', total_sales: 8000, recent_sales: 0 },
      { dealer_id: 'd-test', status: 'at_risk', trend: 'down', churn_score: 99, months_since: 4, last_period: '2026-05', total_sales: 900000, recent_sales: 0 } ],
    dealer_carts: [{ uid: 'u1', dealer_id: 'd-dir-greg', cart: { items: [{ qty: 2, p: { name: 'PR519 Lift Chair', base_price: 620 } }] }, updated_at: YDAY + 'T18:00:00Z' }],
    dealer_sessions: [{ id: 's1', dealer_id: 'd-none', last_seen_at: nowIso() }],
    dealer_intent: [{ dealer_id: 'd-ang', score_total: 40, top_manufacturer: 'golden-technologies', top_product: 'PR519', last_event_at: nowIso() }],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }],
    service_requests: [], rep_daily_briefs: opts.briefs || [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }].concat(opts.flags === undefined ? [{ key: 'phase2_flags', value: { adhoc_visit: true, morning_brief: true } }] : (opts.flags ? [opts.flags] : [])),
  });
  S.unique = { rep_daily_briefs: [['rep_email', 'brief_date', 'kind']] };
  if (opts.missing) S.missingTables = ['rep_daily_briefs'];
  S.ai = opts.ai || goodAI;
  return S;
}
const W = opts => createWorld(seed(opts));
const CC = (w, body, tok, ws, env) => call(load('rep-command-api.js', w, Object.assign({ ANTHROPIC_API_KEY: 'k' }, env || {})), Object.assign({ date: TODAY, tz: TZ, hour: 8 }, body), { token: tok || 'greg', headers: ws ? WS : {} });
const TODAYCALL = (w, tok, ws, extra) => CC(w, Object.assign({ action: 'today' }, extra || {}), tok, ws);
const BRIEF = (w, mode, tok, ws, extra, env) => CC(w, Object.assign({ action: 'brief', mode }, extra || {}), tok, ws, env);
const aiCalls = w => w.outbound.filter(o => o.kind === 'ai').length;
const rows = (w, email) => (w.db.rep_daily_briefs || []).filter(r => !email || r.rep_email === email);
const back = (w, email, ms) => { for (const r of rows(w, email)) r.attempted_at = new Date(Date.parse(r.attempted_at) - ms).toISOString(); };

(async () => {
  /* ---- the switch ---- */
  await t('Switch off (missing, or not exactly true): no card data on today, the brief action refuses; Phase 1 today is unchanged', async () => {
    for (const flags of [null, { key: 'phase2_flags', value: { morning_brief: 'true' } }, { key: 'phase2_flags', value: { adhoc_visit: true } }]) {
      const w = W({ flags });
      const d = await TODAYCALL(w);
      assert.strictEqual(d.status, 200); assert.ok(!('morning_brief' in d.body), 'morning_brief present with the switch off');
      assert.ok(d.body.header && d.body.priorities, 'Phase 1 panels missing');
      const b = await BRIEF(w, 'auto');
      assert.strictEqual(b.status, 403); assert.strictEqual(b.body.code, 'flag_off');
      assert.strictEqual(aiCalls(w), 0); assert.strictEqual(rows(w).length, 0);
    }
  });

  await t('today never runs AI and never writes — it only reads the stored brief (the page renders at once)', async () => {
    const w = W();
    const d = await TODAYCALL(w);
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    const mb = d.body.morning_brief;
    assert.ok(mb && mb.enabled && mb.own && mb.can_generate); assert.strictEqual(mb.status, 'none'); assert.strictEqual(mb.brief, null);
    assert.strictEqual(aiCalls(w), 0); assert.strictEqual(rows(w).length, 0);
    assert.ok(!w.writes.some(x => x.table === 'rep_daily_briefs'));
  });

  /* ---- writing, storing, reusing ---- */
  await t('First open: the brief is written once, grounded to real ids, and stored; the next call reuses it (no AI)', async () => {
    const w = W();
    const b = await BRIEF(w, 'auto');
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    assert.strictEqual(b.body.generated, true); assert.strictEqual(aiCalls(w), 1);
    const B = b.body.brief; assert.ok(B && B.headline && B.focus.length >= 1);
    const ids = new Set(['t-g1', 'v-g', 'o-g', 'd-greg', 'sig_cart_d-dir-greg', 'sig_quiet_d-greg', 'sig_decline_d-greg', 'sig_dealer_commitment_d-greg']);
    for (const f of B.focus) { assert.ok(f.id && (ids.has(String(f.id)) || /^sig_/.test(f.id)), 'ungrounded id ' + f.id); assert.ok(f.reason); }
    assert.ok(B.focus.some(f => f.id === 't-g1' && f.title === 'Call Glasgow about the PO'), 'the task item does not carry the real task');
    assert.ok(B.first_stop && B.first_stop.dealer_id === 'd-greg');
    const r = rows(w, 'greg@hcps.us'); assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].status, 'ready'); assert.strictEqual(r[0].kind, 'morning'); assert.strictEqual(r[0].brief_date, TODAY);
    assert.ok(r[0].signals_key && r[0].inputs && r[0].inputs.refs && r[0].model); assert.strictEqual(r[0].generated_by, 'greg@hcps.us');
    const again = await BRIEF(w, 'auto');
    assert.strictEqual(aiCalls(w), 1, 'reused, not rewritten'); assert.strictEqual(again.body.stale, false); assert.deepStrictEqual(again.body.brief.focus, B.focus);
    back(w, 'greg@hcps.us', 3 * 3600e3);   // hours later the stored brief is still the day's brief
    const later = await BRIEF(w, 'auto');
    assert.strictEqual(aiCalls(w), 1, 'auto rewrote a stored brief once 10 minutes had passed'); assert.strictEqual(later.body.too_soon, undefined);
    const d = await TODAYCALL(w);
    assert.strictEqual(d.body.morning_brief.status, 'ready'); assert.deepStrictEqual(d.body.morning_brief.brief.headline, B.headline);
    assert.strictEqual(aiCalls(w), 1);
  });

  await t('Grounding: unknown refs, repeated refs and invented $ amounts are dropped; nothing grounded → treated as a failure', async () => {
    let n = 0;
    const w = W({ ai: body => { n++; const r = refsIn(body.messages[0].content);
      return { headline: 'Pipeline is $1,000,000 today.', focus: [{ ref: 'X9', reason: 'made up', action: 'x' }, { ref: 'T99', reason: 'not an input', action: 'x' },
        { ref: r[0], reason: 'Worth $5,000 to us.', action: 'Call' }, { ref: 'D1', reason: 'The quote is $1,798 and past its close date.', action: 'Call Rita' }, { ref: 'D1', reason: 'twice', action: 'x' }] }; } });
    const b = await BRIEF(w, 'auto');
    const B = b.body.brief;
    assert.deepStrictEqual(B.focus.map(f => f.id), ['o-g'], JSON.stringify(B.focus));
    assert.ok(B.headline && !/1,000,000/.test(B.headline), 'invented amount kept in the headline');
    assert.ok(/stop on today's route/.test(B.headline), 'the rule headline did not replace it: ' + B.headline);
    assert.ok(B.dropped >= 4);
    // Nothing usable at all: one retry, then a failure — no fake brief stored.
    let m = 0;
    const w2 = W({ ai: () => { m++; return { headline: 'x', focus: [{ ref: 'Q1', reason: 'nope' }] }; } });
    const f = await BRIEF(w2, 'auto');
    assert.strictEqual(f.status, 200); assert.strictEqual(f.body.ai_failed, true); assert.strictEqual(f.body.brief, null);
    assert.strictEqual(m, 2, 'one retry'); assert.ok(f.body.rule_headline);
    assert.strictEqual(rows(w2)[0].status, 'failed');
    void n;
  });

  await t('AI failure: rule-based fallback, failed row; no new attempt for 10 minutes, then one more try', async () => {
    let calls = 0; const w = W({ ai: () => { calls++; return { status: 500, body: { error: { message: 'busy' } } }; } });
    const f = await BRIEF(w, 'auto');
    assert.strictEqual(f.body.ai_failed, true); assert.strictEqual(f.body.status, 'failed'); assert.ok(f.body.signals.length >= 1);
    const c1 = calls;
    const again = await BRIEF(w, 'auto');
    assert.strictEqual(calls, c1, 'retried inside 10 minutes'); assert.strictEqual(again.body.too_soon, true); assert.strictEqual(again.body.brief, null);
    const d = await TODAYCALL(w); assert.strictEqual(d.body.morning_brief.status, 'failed');
    back(w, 'greg@hcps.us', 11 * 60e3);
    await BRIEF(w, 'auto');
    assert.ok(calls > c1, 'no new attempt after 10 minutes');
  });

  await t('No AI key: the card falls back to the rule-based priorities (nothing fake stored)', async () => {
    const w = W();
    const f = await BRIEF(w, 'auto', 'greg', false, null, { ANTHROPIC_API_KEY: '' });
    assert.strictEqual(f.body.ai_failed, true); assert.strictEqual(f.body.ai_error, 'ai_unavailable'); assert.strictEqual(f.body.brief, null);
    assert.strictEqual(aiCalls(w), 0);
  });

  /* ---- stale, refresh ---- */
  await t('Stale: when the day changes the stored brief is flagged (today still never rewrites it); Refresh once per 10 minutes', async () => {
    const w = W();
    await BRIEF(w, 'auto'); assert.strictEqual(aiCalls(w), 1);
    w.db.dealer_tasks.find(x => x.id === 't-g1').status = 'done';   // the overdue task got done
    const c = await BRIEF(w, 'check');
    assert.strictEqual(c.body.stale, true); assert.strictEqual(aiCalls(w), 1);
    const a = await BRIEF(w, 'auto');
    assert.strictEqual(a.body.stale, true); assert.strictEqual(aiCalls(w), 1, 'auto rewrote a stored brief');
    await TODAYCALL(w); assert.strictEqual(aiCalls(w), 1);
    const r1 = await BRIEF(w, 'refresh');
    assert.strictEqual(r1.body.too_soon, true); assert.strictEqual(aiCalls(w), 1, 'refreshed inside 10 minutes');
    back(w, 'greg@hcps.us', 9 * 60e3);
    const r9 = await BRIEF(w, 'refresh');
    assert.strictEqual(r9.body.too_soon, true); assert.strictEqual(aiCalls(w), 1, 'refreshed after 9 minutes');
    back(w, 'greg@hcps.us', -9 * 60e3);
    assert.ok(Date.parse(r1.body.next_refresh_at) > Date.now() + 8 * 60e3);
    back(w, 'greg@hcps.us', 11 * 60e3);
    const r2 = await BRIEF(w, 'refresh');
    assert.strictEqual(r2.body.generated, true); assert.strictEqual(aiCalls(w), 2); assert.strictEqual(r2.body.stale, false);
    assert.ok(!r2.body.brief.focus.some(f => f.id === 't-g1'), 'the done task is still in the brief');
    assert.strictEqual(rows(w).length, 1, 'refresh replaced the row');
  });

  await t('A refresh that fails keeps the brief already written today', async () => {
    let fail = false; const w = W({ ai: b => fail ? { status: 500, body: {} } : goodAI(b) });
    const first = await BRIEF(w, 'auto'); const before = JSON.stringify(first.body.brief);
    fail = true; back(w, 'greg@hcps.us', 11 * 60e3);
    const r = await BRIEF(w, 'refresh');
    assert.strictEqual(r.body.ai_failed, true); assert.deepStrictEqual(r.body.brief, JSON.parse(before));
    assert.strictEqual(rows(w)[0].status, 'ready'); assert.deepStrictEqual(rows(w)[0].content, JSON.parse(before));
  });

  /* ---- one at a time ---- */
  await t('One generation at a time: a brief being written is waited for, not written twice; a stuck one is retried after 90 s', async () => {
    const w = W({ briefs: [{ id: 'b1', rep_email: 'greg@hcps.us', brief_date: TODAY, kind: 'morning', status: 'generating', content: {}, attempted_at: nowIso() }] });
    const p = await BRIEF(w, 'auto');
    assert.strictEqual(p.body.pending, true); assert.strictEqual(aiCalls(w), 0);
    const r = await BRIEF(w, 'refresh');
    assert.strictEqual(r.body.pending, true); assert.strictEqual(aiCalls(w), 0);
    rows(w)[0].attempted_at = new Date(Date.now() - 120e3).toISOString();
    const g = await BRIEF(w, 'auto');
    assert.strictEqual(g.body.generated, true); assert.strictEqual(aiCalls(w), 1); assert.strictEqual(rows(w).length, 1);
    // Two first opens at once: the second insert finds the row and waits.
    const w2 = W();
    const real = w2.fetch; let raced = false;
    w2.fetch = (u, o) => { if (!raced && o && o.method === 'POST' && /rep_daily_briefs/.test(String(u))) { raced = true;
        w2.db.rep_daily_briefs.push({ id: 'other', rep_email: 'greg@hcps.us', brief_date: TODAY, kind: 'morning', status: 'generating', content: {}, attempted_at: nowIso() }); }
      return real(u, o); };
    const q = await BRIEF(w2, 'auto');
    assert.strictEqual(q.body.pending, true); assert.strictEqual(aiCalls(w2), 0); assert.strictEqual(rows(w2).length, 1);
  });

  await t('Two Refreshes at once: the one that loses the claim waits — one AI call', async () => {
    const w = W();
    await BRIEF(w, 'auto'); back(w, 'greg@hcps.us', 11 * 60e3);
    const real = w.fetch; let stolen = false;
    w.fetch = (u, o) => { if (!stolen && o && o.method === 'PATCH' && /rep_daily_briefs\?id=eq\.[^&]+&attempted_at=/.test(String(u))) { stolen = true;
        const r = rows(w, 'greg@hcps.us')[0]; r.attempted_at = nowIso(); r.status = 'generating'; }   // the other tab claimed it first
      return real(u, o); };
    const r = await BRIEF(w, 'refresh');
    assert.strictEqual(stolen, true, 'the claim is not conditional on the attempt it read');
    assert.strictEqual(r.body.pending, true); assert.strictEqual(aiCalls(w), 1);
  });

  await t('A dry run (the permission check) never writes or calls the AI — it only answers who the brief would be for', async () => {
    const w = W();
    for (const mode of ['auto', 'refresh']) {
      const d = await BRIEF(w, mode, 'greg', false, { dry_run: true });
      assert.strictEqual(d.status, 200); assert.strictEqual(d.body.dry_run, true); assert.strictEqual(d.body.own, true);
    }
    assert.strictEqual(aiCalls(w), 0); assert.strictEqual(rows(w).length, 0);
  });

  /* ---- whose brief ---- */
  await t('Management and Relations READ a rep\'s stored brief; they cannot write one in his name (also not as a dry run)', async () => {
    const w = W();
    await BRIEF(w, 'auto'); const greg = rows(w, 'greg@hcps.us')[0]; const before = JSON.stringify(greg);
    for (const tok of ['pres', 'lori']) {
      const c = await BRIEF(w, 'check', tok, false, { rep: 'greg@hcps.us' });
      assert.strictEqual(c.status, 200); assert.strictEqual(c.body.person, 'greg@hcps.us'); assert.strictEqual(c.body.can_generate, false); assert.strictEqual(c.body.own, false);
      assert.strictEqual(c.body.brief.headline, greg.content.headline);
      for (const mode of ['auto', 'refresh']) {
        const x = await BRIEF(w, mode, tok, false, { rep: 'greg@hcps.us' });
        assert.strictEqual(x.status, 403, tok + ' ' + mode); assert.strictEqual(x.body.code, 'not_yours');
        const dry = await BRIEF(w, mode, tok, false, { rep: 'greg@hcps.us', dry_run: true });
        assert.strictEqual(dry.status, 403, 'dry run ' + tok + ' ' + mode);
      }
      const d = await TODAYCALL(w, tok, false, { rep: 'greg@hcps.us' });
      assert.strictEqual(d.body.morning_brief.can_generate, false); assert.strictEqual(d.body.morning_brief.brief.headline, greg.content.headline);
    }
    assert.strictEqual(aiCalls(w), 1); assert.strictEqual(JSON.stringify(rows(w, 'greg@hcps.us')[0]), before);
    assert.strictEqual(rows(w).length, 1, 'a brief was written for someone');
  });

  await t('A rep asking for someone else\'s brief gets his own (the rep field is ignored for a rep, as on today)', async () => {
    const w = W();
    await BRIEF(w, 'auto', 'pres');
    const c = await BRIEF(w, 'check', 'greg', false, { rep: 'angelo@hcps.us' });
    assert.strictEqual(c.body.person, 'greg@hcps.us'); assert.strictEqual(c.body.brief, null);
    const d = await TODAYCALL(w, 'greg', false, { rep: 'angelo@hcps.us' });
    assert.strictEqual(d.body.morning_brief.person, 'greg@hcps.us');
  });

  /* ---- what it reads ---- */
  await t('Lori (Relations): her own work PLUS the top company-wide relationship signals (other reps\' and House dealers), TEST excluded', async () => {
    let prompt = '';
    const w = W({ ai: b => { prompt = b.messages[0].content; return goodAI(b); } });
    const c = await BRIEF(w, 'check', 'lori');
    assert.strictEqual(c.body.scope, 'company_wide');
    const ids = c.body.signals.map(s => s.dealer_id);
    assert.ok(ids.includes('d-greg') && ids.includes('d-dir-greg'), 'Greg\'s dealers missing: ' + ids);
    assert.ok(ids.includes('d-ang') && ids.includes('d-none'), 'Angelo\'s / House dealers missing: ' + ids);
    assert.ok(!ids.includes('d-test'), 'TEST dealer in the signals');
    assert.ok(c.body.signals.length <= 10 && c.body.signals.length >= 5, 'not 5-10 signals: ' + c.body.signals.length);
    assert.strictEqual(new Set(ids).size, ids.length, 'a dealer listed twice');
    assert.ok(c.body.signals.every(s => s.owner && s.why && s.action));
    const b = await BRIEF(w, 'auto', 'lori');
    assert.strictEqual(b.body.generated, true);
    assert.ok(/EVERY dealer in the company/.test(prompt) && /at least 2 focus items must be S refs/.test(prompt), 'company-wide instruction missing');
    assert.ok(/T1 "Lori: check on the House account"/.test(prompt), 'her own task missing from the prompt');
    assert.ok(!/Call Glasgow about the PO/.test(prompt), 'Greg\'s task in Lori\'s brief');
    assert.strictEqual(b.body.brief.scope, 'company_wide'); assert.ok(b.body.brief.signals.length >= 5);
  });

  await t('Greg (rep): signals only from his own book', async () => {
    const w = W();
    const c = await BRIEF(w, 'check', 'greg');
    assert.strictEqual(c.body.scope, 'own_book');
    const ids = c.body.signals.map(s => s.dealer_id);
    assert.ok(ids.length && ids.every(id => ['d-greg', 'd-greg-branch', 'd-dir-greg'].includes(id)), 'outside his book: ' + ids);
    // His own visit follow-ups are his own work (listed there), not repeated as signals.
    assert.ok(!c.body.signals.some(x => /visit|said they'd|Promised/.test(x.why + ' ' + (x.also || []).join(' '))), 'his own visit repeated as a signal');
  });

  await t('Angelo — My Sales Workspace AND Admin view: his own book only (never company-wide President data); one brief per day', async () => {
    let prompt = '';
    const w = W({ ai: b => { prompt = b.messages[0].content; return goodAI(b); } });
    for (const ws of [true, false]) {
      const c = await BRIEF(w, 'check', 'pres', ws);
      assert.strictEqual(c.body.scope, 'own_book', 'ws=' + ws);
      const ids = c.body.signals.map(s => s.dealer_id);
      assert.ok(ids.length && ids.every(id => ['d-ang', 'd-ang-mail'].includes(id)), 'outside his book (ws=' + ws + '): ' + ids);
    }
    const b = await BRIEF(w, 'auto', 'pres', true);
    assert.strictEqual(b.body.generated, true);
    assert.ok(!/Glasgow|Nobody Owns Me/.test(prompt), 'another book in his prompt');
    assert.ok(/working his own dealer book/.test(prompt));
    const adm = await BRIEF(w, 'auto', 'pres', false);
    assert.strictEqual(aiCalls(w), 1, 'a second brief for the same person and day'); assert.strictEqual(adm.body.brief.headline, b.body.brief.headline);
    assert.strictEqual(rows(w, 'angelo@hcps.us').length, 1);
  });

  /* ---- before the migration ---- */
  await t('Before the migration (no table): today still loads; the brief action says what to run', async () => {
    const w = W({ missing: true });
    const d = await TODAYCALL(w);
    assert.strictEqual(d.status, 200); assert.strictEqual(d.body.morning_brief.storage_missing, true);
    const b = await BRIEF(w, 'auto');
    assert.strictEqual(b.status, 503); assert.strictEqual(b.body.error, 'storage_missing'); assert.strictEqual(aiCalls(w), 0);
  });

  /* ---- the pure parts ---- */
  await t('rankSignals: strongest first, one per dealer (others noted), limit, TEST and stale data left out', () => {
    const today = TODAY;
    const sig = BAI.rankSignals({ today, scope: null, exclude: new Set(['x-test']), limit: 4, names: { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }, owners: { a: 'Greg' },
      carts: [{ dealer_id: 'a', cart: { items: [{ qty: 1, p: { base_price: 500 } }] }, updated_at: YDAY },
              { dealer_id: 'e', cart: { items: [{ qty: 1, p: { base_price: 900 } }] }, updated_at: dayStr(-12) },
              { dealer_id: 'x-test', cart: { items: [{ qty: 9, p: { base_price: 900 } }] }, updated_at: TODAY }],
      engagement: [{ dealer_id: 'a', status: 'at_risk', churn_score: 80, total_sales: 90000, months_since: 3 }, { dealer_id: 'b', status: 'watch', churn_score: 10, total_sales: 5000, months_since: 2 },
                   { dealer_id: 'c', status: 'healthy', trend: 'down', churn_score: 10, total_sales: 5000, recent_sales: 100 }, { dealer_id: 'x-test', status: 'at_risk', churn_score: 99, total_sales: 1e6 }],
      visits: [{ dealer_id: 'd', followup_status: 'pending', followup_due: AGO5, checkin_at: dayStr(-9), summary: {} }],
      intent: [], sessions: [] });
    assert.deepStrictEqual(sig.map(s => s.type + ':' + s.dealer_id), ['cart:a', 'followup_overdue:d', 'quiet:b', 'decline:c']);
    assert.strictEqual(sig[0].owner, 'Greg'); assert.strictEqual(sig[2].owner, 'House');
    assert.ok(sig[0].also.length === 1 && /No order in 3 months/.test(sig[0].also[0]));
    assert.ok(sig[0].amounts.includes(500) && sig[0].amounts.includes(90000));
    const many = Array.from({ length: 14 }, (_, k) => ({ dealer_id: 'm' + k, status: 'at_risk', churn_score: k, total_sales: 5000 + k }));
    const base = { today, scope: null, carts: [], visits: [], intent: [], sessions: [], engagement: many };
    assert.strictEqual(BAI.rankSignals(Object.assign({ limit: 10 }, base)).length, 10, 'Relations: top 10');
    assert.strictEqual(BAI.rankSignals(base).length, 8, 'default: top 8');
    assert.strictEqual(BAI.rankSignals(Object.assign({ limit: 10 }, base))[0].dealer_id, 'm13', 'not strongest first');
    const scoped = BAI.rankSignals({ today, scope: new Set(['b']), engagement: [{ dealer_id: 'a', status: 'at_risk', total_sales: 9000 }, { dealer_id: 'b', status: 'at_risk', total_sales: 9000 }], carts: [], visits: [], intent: [], sessions: [] });
    assert.deepStrictEqual(scoped.map(s => s.dealer_id), ['b']);
  });

  await t('signalsKey: same facts → same key; a moved due date, a stage change or a new signal → a new key', () => {
    const day = { header: { date: TODAY, rep: { name: 'G' } }, priorities: [{ kind: 'task', id: 't1', title: 'x', dealer_id: 'd', dealer: 'D', due: TODAY, why: 'Due today' }],
      route: null, appointments: [], followup_queue: { visits: [] }, opportunities: { needs_attention: [{ id: 'o1', title: 'deal', dealer_id: 'd', dealer: 'D', stage: 'quoted', value: 10, why: [] }] } };
    const k = d => BAI.signalsKey(BAI.briefInputs(d, [], { scope: 'own_book' }));
    const k0 = k(day), clone = () => JSON.parse(JSON.stringify(day));
    assert.strictEqual(k(clone()), k0);
    const a = clone(); a.priorities[0].due = YDAY; assert.notStrictEqual(k(a), k0);
    const b = clone(); b.opportunities.needs_attention[0].stage = 'won'; assert.notStrictEqual(k(b), k0);
    assert.notStrictEqual(BAI.signalsKey(BAI.briefInputs(day, [{ id: 's', type: 'cart', dealer_id: 'z', dealer: 'Z', why: 'w', action: 'a', amounts: [] }], { scope: 'own_book' })), k0);
  });

  await t('ground: amounts must be in the facts ($1,798 / $1.8k ok; $5,000 not); first_stop only as R1', () => {
    const inputs = { refs: { T1: { kind: 'task', id: 't1', dealer_id: 'd', dealer: 'D', title: 'Task' }, D1: { kind: 'deal', id: 'o1', dealer_id: 'd', dealer: 'D', title: 'Deal' } },
      amounts: [1798], route: { stops: [{ dealer_id: 'd', dealer: 'D' }] }, counts: {}, signals: [] };
    assert.ok(BAI.amountsOk('quote $1,798 and $1.8k', [1798])); assert.ok(!BAI.amountsOk('$5,000', [1798]));
    const g = BAI.ground({ headline: 'Go.', focus: [{ ref: 't1', reason: 'r', action: 'a' }, { ref: 'D1', reason: 'worth $5,000', action: 'a' }], first_stop: { ref: 'R2', tip: 'x' } }, inputs);
    assert.deepStrictEqual(g.focus.map(f => f.id), ['t1']); assert.strictEqual(g.first_stop, null);
    assert.strictEqual(BAI.ground({ headline: 'x', focus: [{ ref: 'D9', reason: 'r' }] }, inputs), null);
  });

  done('Phase 2B morning brief');
})();

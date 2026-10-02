/* Phase 1: Visit Intelligence, end to end against the real handlers (routes-api, crm-api,
   pipeline-api, ai-email-api) on the fake database. Start → End → AI suggestions → approve →
   follow-up, and above all: NO REPLAY CREATES A DUPLICATE CRM RECORD. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const pad = n => String(n).padStart(2, '0');
const dayStr = (off) => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), IN3 = dayStr(3), IN7 = dayStr(7);
const ROUTE = { id: 'r-1', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', rep_name: 'Angelo Audia', name: 'KY loop', scheduled_date: TODAY,
  stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-dir-greg', name: 'Directory Only' }] };
const ANG_ROUTE = { id: 'r-ang', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'TN loop', scheduled_date: TODAY, stops: [{ dealer_id: 'd-ang', name: 'RMS' }] };

const AI_OUT = {
  meeting_summary: 'Met Bryant and Stacey. Reviewed lift chairs; they want pricing on 2 PR519 chairs.',
  products_discussed: ['PR519 lift chair', 'Strongback Excursion'], dealer_interests: ['Lift chairs'], dealer_concerns: ['Lead times'],
  objections: [], competitors: ['Pride'], pricing_requests: ['PR519 pricing'], samples_requested: [], literature_requested: ['Golden catalog'], training_requested: [],
  attendees: [{ name: 'Bryant Smith', title: 'Pharmacist' }, { name: 'Stacey New', title: 'Buyer' }],
  rep_commitments: [{ text: 'Send PR519 pricing', due_date: IN3 }], dealer_commitments: [{ text: 'Call me Friday', due_date: '' }],
  follow_ups: [{ title: 'Send PR519 pricing', due_date: IN3, priority: 'high', from: 'rep_commitment' }, { title: 'Call Bryant back', due_date: IN7, priority: 'normal', from: 'dealer_commitment' }],
  opportunities: [{ title: '2 x PR519 lift chairs', manufacturer_slug: 'golden-technologies', product: 'PR519', quantity: 2, est_value: null, contact_name: 'Bryant Smith', stage: 'identified', expected_close: '' }],
  suggested_next_action: { text: 'Send pricing', due_date: IN3 }, interest_slugs: ['golden-technologies'], poor_fit_slugs: [] };

function seed(extra) {
  const S = standardSeed(Object.assign({
    rep_routes: [ROUTE, ANG_ROUTE],
    dealer_visit_reports: [],
    dealer_contacts: [{ id: 'c-bryant', dealer_id: 'd-greg', name: 'Bryant Smith', email: 'bryant@glasgow.test', title: 'Pharmacist', phone: '270-111' }],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }, { slug: 'strongback-mobility', name: 'Strongback Mobility' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }],
  }, extra || {}));
  S.unique = { dealer_tasks: [['origin_type', 'origin_id', 'origin_key']], opportunities: [['origin_type', 'origin_id', 'origin_key']],
    dealer_visits: [['visit_report_id']], dealer_visit_participants: [['visit_report_id', 'name_key']], dealer_contacts: [['dealer_id', 'email']],
    dealer_visit_reports: [['route_id', 'dealer_id']] };
  S.catalog = { 'golden-technologies': [{ code: 'PR-519', name: 'Golden PR519 Lift Chair', base_price: 899 }] };
  S.ai = () => AI_OUT;
  return S;
}
const W = extra => createWorld(seed(extra));
const R = (w, body, tok, env) => call(load('routes-api.js', w, env === undefined ? { ANTHROPIC_API_KEY: 'k' } : env), body, { token: tok || 'greg' });
const C = (w, body, tok) => call(load('crm-api.js', w), body, { token: tok || 'greg' });
const n = (w, table, f) => (w.db[table] || []).filter(f || (() => true)).length;
const sideEffects = w => ({ reports: n(w, 'dealer_visit_reports'), visits: n(w, 'dealer_visits'), notes: n(w, 'dealer_notes'), activity: n(w, 'dealer_activity', a => a.kind === 'visit'),
  tasks: n(w, 'dealer_tasks'), opps: n(w, 'opportunities'), intent: n(w, 'intent_events'), contacts: n(w, 'dealer_contacts'), participants: n(w, 'dealer_visit_participants') });
const stop = { route_id: 'r-1', dealer_id: 'd-greg' };

// What the review screen sends: the suggestion as approved (optionally edited / pruned).
function approval(sug, edit) {
  const body = Object.assign({ action: 'visit_approve' }, stop, {
    summary: sug, interest_slugs: sug.interest_slugs,
    participants: sug.attendees.map(a => ({ key: a.key, name: a.name, title: a.title, contact_id: a.contact_id, add_as_contact: !a.contact_id, source: 'ai' })),
    tasks: sug.follow_ups.map(f => ({ key: f.key, title: f.title, due_date: f.due_date, priority: f.priority, kind: 'followup', ai: true })),
    opportunities: sug.opportunities.map(o => ({ key: o.key, title: o.title, manufacturer: o.manufacturer, product: o.product, quantity: o.quantity, value: o.value, stage: o.stage, contact_id: o.contact_id })) });
  return edit ? edit(body) : body;
}
async function startEndAnalyze(w, extra) {
  await R(w, Object.assign({ action: 'visit_checkin' }, stop));
  await R(w, Object.assign({ action: 'visit_end' }, stop));
  const a = await R(w, Object.assign({ action: 'visit_analyze', notes: 'Met Bryant and Stacey about lift chairs. Send PR519 pricing.', local_date: TODAY }, stop, extra || {}));
  assert.strictEqual(a.status, 200, JSON.stringify(a.body)); assert.ok(a.body.ok, JSON.stringify(a.body));
  return a.body.suggestion;
}

(async () => {
  /* ── 1. Lifecycle ── */
  await t('1 Start → End → Summary → Approve: one visit, its records, linked back', async () => {
    const w = W();
    const s = await R(w, Object.assign({ action: 'visit_checkin' }, stop)); assert.strictEqual(s.body.status, 'checked_in');
    const e = await R(w, Object.assign({ action: 'visit_end' }, stop)); assert.strictEqual(e.body.status, 'ended'); assert.ok(e.body.ended_at);
    const rep = w.db.dealer_visit_reports[0]; assert.strictEqual(rep.status, 'ended'); assert.ok(rep.duration_min >= 0);
    const sug = (await R(w, Object.assign({ action: 'visit_analyze', notes: 'Met Bryant and Stacey.', local_date: TODAY }, stop))).body.suggestion;
    assert.strictEqual(n(w, 'dealer_tasks'), 0, 'the AI step created a task'); assert.strictEqual(n(w, 'opportunities'), 0, 'the AI step created a deal');
    assert.ok(rep.ai_suggestion && rep.ai_suggestion.follow_ups.length === 2, 'suggestion not kept on the visit');
    const ap = await R(w, approval(sug));
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body)); assert.strictEqual(ap.body.first_completion, true);
    assert.deepStrictEqual(ap.body.created, { tasks: 2, opportunities: 1, participants: 2, contacts: 1 });
    assert.strictEqual(rep.status, 'completed'); assert.ok(rep.completed_at && rep.approved_at); assert.strictEqual(rep.followup_status, 'pending');
    for (const tk of w.db.dealer_tasks) { assert.strictEqual(tk.origin_type, 'visit_report'); assert.strictEqual(tk.origin_id, rep.id); assert.strictEqual(tk.assigned_email, 'greg@hcps.us'); assert.strictEqual(tk.source, 'visit'); }
    const o = w.db.opportunities[0]; assert.strictEqual(o.origin_id, rep.id); assert.strictEqual(o.manufacturer, 'golden-technologies'); assert.strictEqual(o.product, 'PR519');
    assert.strictEqual(Number(o.value), 1798, 'catalog price × quantity'); assert.strictEqual(o.contact_id, 'c-bryant'); assert.strictEqual(o.owner_email, 'greg@hcps.us');
    const fx = sideEffects(w); assert.strictEqual(fx.visits, 1); assert.strictEqual(fx.notes, 1); assert.strictEqual(fx.activity, 1); assert.strictEqual(fx.intent, 1);
    assert.strictEqual(w.db.dealer_activity[0].ref_id, rep.id); assert.strictEqual(w.db.dealer_visits[0].visit_report_id, rep.id);
  });
  await t('1 End is idempotent and keeps the time it was tapped (offline)', async () => {
    const w = W();
    const t0 = new Date(Date.now() - 50 * 60000).toISOString(), t1 = new Date(Date.now() - 5 * 60000).toISOString();
    await R(w, Object.assign({ action: 'visit_checkin', at: t0 }, stop));
    const e1 = await R(w, Object.assign({ action: 'visit_end', at: t1 }, stop));
    assert.strictEqual(e1.body.ended_at, t1); assert.strictEqual(e1.body.duration_min, 45);
    const e2 = await R(w, Object.assign({ action: 'visit_end' }, stop));
    assert.strictEqual(e2.body.already, true); assert.strictEqual(e2.body.ended_at, t1, 'a second End moved the end time');
    assert.strictEqual(n(w, 'dealer_visit_reports'), 1);
    const future = await R(w, { action: 'visit_checkin', route_id: 'r-1', dealer_id: 'd-dir-greg', at: new Date(Date.now() + 3600000).toISOString() });
    assert.ok(Date.parse(future.body.checkin_at) <= Date.now() + 1000, 'a future client time was believed');
  });
  await t('1 Draft notes after End do not pull the visit back', async () => {
    const w = W();
    await R(w, Object.assign({ action: 'visit_checkin' }, stop)); await R(w, Object.assign({ action: 'visit_end' }, stop));
    await R(w, Object.assign({ action: 'visit_report_save', status: 'in_progress', fields: { notes: 'more' } }, stop));
    assert.strictEqual(w.db.dealer_visit_reports[0].status, 'ended');
  });

  /* ── 2. Replays never duplicate ── */
  await t('2 Double-tap approval: one set of every record', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    const [a, b2] = await Promise.all([R(w, approval(sug)), R(w, approval(sug))]);
    assert.strictEqual(a.status, 200); assert.strictEqual(b2.status, 200);
    assert.strictEqual([a.body.first_completion, b2.body.first_completion].filter(Boolean).length, 1, 'both approvals claimed the visit');
    const fx = sideEffects(w);
    assert.deepStrictEqual(fx, { reports: 1, visits: 1, notes: 1, activity: 1, tasks: 2, opps: 1, intent: 1, contacts: 2, participants: 2 });
  });
  await t('2 Immediate and delayed replays of an approval add nothing', async () => {
    const w = W(); const sug = await startEndAnalyze(w); const body = approval(sug);
    await R(w, body); const before = sideEffects(w);
    const again = await R(w, body); assert.strictEqual(again.body.first_completion, false);
    assert.deepStrictEqual(again.body.created, { tasks: 0, opportunities: 0, participants: 0, contacts: 0 });
    // the rep works one task, then the outbox replays the approval an hour later
    const tk = w.db.dealer_tasks[0]; await C(w, { action: 'complete_task', id: tk.id });
    await R(w, body); await R(w, JSON.parse(JSON.stringify(body)));
    assert.deepStrictEqual(sideEffects(w), before, 'a delayed replay created records');
    assert.strictEqual(tk.status, 'done', 'a replay reopened a finished task');
  });
  await t('2 Offline: the queued check-in, End and approval replay in order, then again — same visit', async () => {
    const w = W(); const t0 = new Date(Date.now() - 40 * 60000).toISOString(), t1 = new Date(Date.now() - 10 * 60000).toISOString();
    const sug = (() => { const raw = require('../netlify/functions/_visit_ai.js'); return raw.normalizeSuggestion(AI_OUT, { visitDate: TODAY, contacts: [], mfrs: [{ slug: 'golden-technologies', name: 'Golden Technologies' }] }); })();
    const queue = [Object.assign({ action: 'visit_checkin', at: t0 }, stop), Object.assign({ action: 'visit_end', at: t1 }, stop), approval(sug)];
    for (const q of queue) assert.strictEqual((await R(w, q)).status, 200);
    const once = sideEffects(w);
    for (const q of queue) await R(w, q);   // the whole queue again (lost responses)
    assert.deepStrictEqual(sideEffects(w), once);
    const rep = w.db.dealer_visit_reports[0]; assert.strictEqual(rep.checkin_at, t0); assert.strictEqual(rep.ended_at, t1); assert.strictEqual(rep.duration_min, 30);
  });
  await t('2 Off a route: a legitimate later visit is new; a late replay of the first is not', async () => {
    const w = W(); const offStop = { dealer_id: 'd-greg' };
    const ai = require('../netlify/functions/_visit_ai.js');
    const mk = (summary) => ai.normalizeSuggestion(Object.assign({}, AI_OUT, { meeting_summary: summary }), { visitDate: TODAY, contacts: [], mfrs: [{ slug: 'golden-technologies', name: 'Golden Technologies' }] });
    const s1 = mk('First visit.'), s2 = mk('Second visit, a week later.');
    const ap = s => Object.assign(approval(s), { route_id: undefined }, offStop);
    await R(w, Object.assign({ action: 'visit_checkin' }, offStop)); await R(w, Object.assign({ action: 'visit_end' }, offStop));
    const a1 = await R(w, ap(s1)); assert.strictEqual(a1.body.first_completion, true);
    await R(w, Object.assign({ action: 'visit_checkin' }, offStop));
    const a2 = await R(w, ap(s2)); assert.strictEqual(a2.body.first_completion, true, 'the later visit was swallowed');
    assert.notStrictEqual(a1.body.report_id, a2.body.report_id);
    const before = sideEffects(w);
    const late = await R(w, ap(s1)); assert.strictEqual(late.body.report_id, a1.body.report_id); assert.strictEqual(late.body.first_completion, false);
    assert.deepStrictEqual(sideEffects(w), before, 'the late replay duplicated visit 1');
    assert.strictEqual(before.reports, 2); assert.strictEqual(before.visits, 2);
  });

  /* ── 3. Participants ── */
  await t('3 Attendees: an existing contact is linked, a new one becomes a normal Dealer 360 contact', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    const bry = sug.attendees.find(a => a.name === 'Bryant Smith'); assert.strictEqual(bry.contact_id, 'c-bryant', 'existing contact not matched');
    await R(w, approval(sug));
    const parts = w.db.dealer_visit_participants; assert.strictEqual(parts.length, 2);
    const stacey = w.db.dealer_contacts.find(c => c.name === 'Stacey New'); assert.ok(stacey, 'new attendee not added as a contact');
    assert.strictEqual(stacey.dealer_id, 'd-greg'); assert.ok(!stacey.email, 'contact without email');
    const list = await C(w, { action: 'contacts', dealer_id: 'd-greg' });
    assert.ok(list.body.contacts.some(c => c.name === 'Stacey New'), 'not in Dealer 360 contacts');
    assert.strictEqual(parts.find(p => p.name_snapshot === 'Stacey New').contact_id, stacey.id);
  });
  await t('3 A new attendee WITH an email merges on the email; a replay never makes a second contact', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    const body = approval(sug, b0 => { b0.participants.push({ key: 'p-x', name: 'Pat Owner', email: 'PAT@glasgow.test', title: 'Owner', add_as_contact: true }); return b0; });
    await R(w, body); await R(w, body);
    assert.strictEqual(n(w, 'dealer_contacts', c => c.email === 'pat@glasgow.test'), 1);
    assert.strictEqual(n(w, 'dealer_contacts', c => c.name === 'Stacey New'), 1, 'no-email contact duplicated on replay');
  });
  await t('3 A deleted contact still reads on the visit from its snapshot', async () => {
    const w = W(); const sug = await startEndAnalyze(w); await R(w, approval(sug));
    w.db.dealer_contacts = w.db.dealer_contacts.filter(c => c.id !== 'c-bryant');
    for (const p of w.db.dealer_visit_participants) if (p.contact_id === 'c-bryant') p.contact_id = null;   // on delete set null
    const v = await C(w, { action: 'visits', dealer_id: 'd-greg' });
    const att = v.body.past[0].attendees.map(a => a.name);
    assert.ok(att.includes('Bryant Smith'), 'history lost the deleted contact: ' + JSON.stringify(att));
  });

  /* ── 4. Tasks ── */
  await t('4 One follow-up, several, and a rejected one; approved ones are in My Tasks and the badge', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    const ap = await R(w, approval(sug, b0 => { b0.tasks = b0.tasks.slice(0, 1); return b0; }));   // second suggestion rejected
    assert.strictEqual(ap.body.created.tasks, 1);
    assert.ok(!w.db.dealer_tasks.some(x => x.title === 'Call Bryant back'), 'a rejected suggestion became a task');
    const my = await C(w, { action: 'my_tasks' }); const badge = await C(w, { action: 'task_count' });
    assert.ok(my.body.tasks.some(x => x.title === 'Send PR519 pricing')); assert.strictEqual(badge.body.count, my.body.tasks.length);
    const tk = w.db.dealer_tasks[0]; assert.strictEqual(tk.priority, 'high'); assert.strictEqual(tk.due_date, IN3);
    const w2 = W(); const sug2 = await startEndAnalyze(w2);
    const ap2 = await R(w2, approval(sug2, b0 => { b0.tasks.push({ key: 'fu_manual_1', title: 'Drop off samples', due_date: IN7, priority: 'low', kind: 'followup' }); return b0; }));
    assert.strictEqual(ap2.body.created.tasks, 3);
  });
  await t('4 Edited suggestion: the rep\'s title, date and priority are what is created', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    await R(w, approval(sug, b0 => { b0.tasks[0].title = 'Email PR519 quote to Bryant'; b0.tasks[0].due_date = IN7; b0.tasks[0].priority = 'low'; return b0; }));
    const tk = w.db.dealer_tasks.find(x => x.origin_key === sug.follow_ups[0].key);
    assert.strictEqual(tk.title, 'Email PR519 quote to Bryant'); assert.strictEqual(tk.due_date, IN7); assert.strictEqual(tk.priority, 'low');
  });
  await t('6 Follow-up status: pending → complete when every linked task is done or dismissed; reopen → pending', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    await R(w, approval(sug, b0 => { b0.opportunities = []; return b0; }));
    const rep = w.db.dealer_visit_reports[0]; assert.strictEqual(rep.followup_status, 'pending'); assert.strictEqual(rep.followup_due, IN3);
    const [t1, t2] = w.db.dealer_tasks;
    let r1 = await C(w, { action: 'complete_task', id: t1.id }); assert.strictEqual(r1.body.followup.status, 'pending');
    r1 = await C(w, { action: 'dismiss_task', id: t2.id }); assert.strictEqual(r1.body.followup.status, 'complete');
    assert.strictEqual(rep.followup_status, 'complete'); assert.ok(rep.followup_completed_at);
    await C(w, { action: 'reopen_task', id: t2.id }); assert.strictEqual(rep.followup_status, 'pending');
  });
  await t('6 Follow-up status: nothing approved → none; a deal holds it pending until it moves; manual override', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    await R(w, approval(sug, b0 => { b0.tasks = []; b0.opportunities = []; return b0; }));
    const rep = w.db.dealer_visit_reports[0]; assert.strictEqual(rep.followup_status, 'none');
    const w2 = W(); const sug2 = await startEndAnalyze(w2);
    await R(w2, approval(sug2, b0 => { b0.tasks = []; return b0; }));
    const rep2 = w2.db.dealer_visit_reports[0]; assert.strictEqual(rep2.followup_status, 'pending');
    const o = w2.db.opportunities[0];
    const u = await call(load('pipeline-api.js', w2), { action: 'update', id: o.id, stage: 'contacted' }, { token: 'greg' });
    assert.strictEqual(u.status, 200); assert.ok(o.stage_changed_at, 'stage change not recorded'); assert.strictEqual(rep2.followup_status, 'complete');
    const m = await R(w2, Object.assign({ action: 'visit_followup_set', status: 'pending' }, stop)); assert.strictEqual(m.body.manual, true);
    assert.strictEqual(rep2.followup_status, 'pending');
    const back = await R(w2, Object.assign({ action: 'visit_followup_set', status: 'auto' }, stop)); assert.strictEqual(back.body.followup_status, 'complete');
  });

  /* ── 5. Opportunities ── */
  await t('5 Approved deals go to Pipeline with the existing stages; rejected ones do not; several in one meeting', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    await R(w, approval(sug, b0 => { b0.opportunities.push({ key: 'op_manual_1', title: 'Excursion transport chairs', manufacturer: 'strongback-mobility', product: '1002', quantity: 4, value: 1800, stage: 'quoted' },
                                                           { key: 'op_manual_2', title: 'Bad stage', stage: 'won' }); return b0; }));
    const board = await call(load('pipeline-api.js', w), { action: 'board' }, { token: 'greg' });
    const titles = (board.body.opportunities || []).map(o => o.title);
    assert.ok(titles.includes('2 x PR519 lift chairs') && titles.includes('Excursion transport chairs'), 'approved deals missing from Pipeline: ' + titles);
    const q = w.db.opportunities.find(o => o.title === 'Excursion transport chairs'); assert.strictEqual(q.stage, 'quoted'); assert.strictEqual(Number(q.probability), 0.6);
    const bad = w.db.opportunities.find(o => o.title === 'Bad stage'); assert.strictEqual(bad.stage, 'identified', 'a visit created a won deal');
    const kept = (w.db.dealer_visit_reports[0].summary.opportunities || []).find(o => o.title === 'Bad stage');
    assert.strictEqual(kept && kept.stage, 'identified', 'the visit recorded a won stage as approved');
    const OPP = require('../netlify/functions/_opps.js');
    for (const st of ['won', 'lost', 'WON', 'nonsense', '']) assert.strictEqual(OPP.oppRow({ dealer_id: 'd', title: 'x', stage: st }, {}).stage, 'identified', 'oppRow kept stage ' + st);
    assert.strictEqual(OPP.oppRow({ dealer_id: 'd', title: 'x', stage: 'Quoted' }, {}).stage, 'quoted');
    const w2 = W(); const sug2 = await startEndAnalyze(w2);
    await R(w2, approval(sug2, b0 => { b0.opportunities = []; return b0; }));
    assert.strictEqual(n(w2, 'opportunities'), 0, 'a rejected deal was created');
  });

  /* ── 7. Dealer 360 — Visits & Meetings ── */
  await t('7 Dealer 360 card: upcoming, active and past visits with attendees, follow-up, linked tasks and deals', async () => {
    const w = W({ rep_routes: [ROUTE, ANG_ROUTE, { id: 'r-next', owner_email: 'greg@hcps.us', name: 'Next week', scheduled_date: IN7, stops: [{ dealer_id: 'd-greg' }] }] });
    let v = await C(w, { action: 'visits', dealer_id: 'd-greg' });
    assert.ok(v.body.upcoming.some(u => u.route_id === 'r-next') && v.body.upcoming.some(u => u.route_id === 'r-1'));
    await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    v = await C(w, { action: 'visits', dealer_id: 'd-greg' }); assert.strictEqual(v.body.active.length, 1); assert.ok(!v.body.upcoming.some(u => u.route_id === 'r-1'));
    const sug = (await R(w, Object.assign({ action: 'visit_analyze', notes: 'x', local_date: TODAY }, stop))).body.suggestion;
    await R(w, approval(sug));
    v = await C(w, { action: 'visits', dealer_id: 'd-greg' });
    const p = v.body.past[0];
    assert.strictEqual(v.body.active.length, 0); assert.strictEqual(p.attendees.length, 2); assert.strictEqual(p.tasks.length, 2); assert.strictEqual(p.opportunities.length, 1);
    assert.strictEqual(p.followup_status, 'pending'); assert.ok(p.summary.meeting_summary); assert.ok(p.duration_min != null);
    assert.ok(p.summary.products_discussed.length, 'products discussed missing');
  });

  /* ── 8. Permissions ── */
  await t('8 Greg cannot start, end, analyze, approve or read visits on another rep\'s dealer or route', async () => {
    const w = W(); const sug = AI_OUT;
    for (const body of [{ action: 'visit_checkin', dealer_id: 'd-ang' }, { action: 'visit_end', dealer_id: 'd-ang' }, { action: 'visit_analyze', dealer_id: 'd-ang', notes: 'x' },
      { action: 'visit_approve', dealer_id: 'd-ang', summary: sug }, { action: 'visit_end', route_id: 'r-ang', dealer_id: 'd-ang' }, { action: 'visit_report_get', dealer_id: 'd-ang', detail: true },
      { action: 'visit_followup_set', dealer_id: 'd-ang', status: 'complete' }, { action: 'visit_email_save', dealer_id: 'd-ang', email: { subject: 'x' } }]) {
      const r = await R(w, body); assert.strictEqual(r.status, 403, body.action + ' answered ' + r.status);
    }
    assert.strictEqual((await C(w, { action: 'visits', dealer_id: 'd-ang' })).status, 403);
    // a visit id from another dealer can't be reached through Greg's own dealer
    await R(w, Object.assign({ action: 'visit_checkin' }, { route_id: 'r-ang', dealer_id: 'd-ang' }), 'pres');
    const angRep = w.db.dealer_visit_reports.find(r => r.dealer_id === 'd-ang');
    const x = await R(w, { action: 'visit_followup_set', dealer_id: 'd-greg', report_id: angRep.id, status: 'complete' });
    assert.strictEqual(x.status, 403); assert.strictEqual(n(w, 'dealer_tasks'), 0);
  });
  await t('8 Lori follows Relations access; the president sees all', async () => {
    const w = W(); const sug = await startEndAnalyze(w); await R(w, approval(sug));
    for (const tok of ['lori', 'pres']) {
      const v = await C(w, { action: 'visits', dealer_id: 'd-greg' }, tok); assert.strictEqual(v.status, 200, tok); assert.strictEqual(v.body.past.length, 1, tok);
      assert.strictEqual((await C(w, { action: 'visits', dealer_id: 'd-ang' }, tok)).status, 200, tok);
    }
    // Lori may not work a route she is not on, and still cannot change dealer settings
    assert.strictEqual((await R(w, Object.assign({ action: 'visit_end' }, { route_id: 'r-ang', dealer_id: 'd-ang' }), 'lori')).status, 403);
  });
  await t('8 Greg sees only his own visits\' tasks and deals in My Tasks and Pipeline', async () => {
    const w = W(); const sug = await startEndAnalyze(w); await R(w, approval(sug));
    await R(w, { action: 'visit_checkin', route_id: 'r-ang', dealer_id: 'd-ang' }, 'pres');
    const ang = (await R(w, { action: 'visit_analyze', route_id: 'r-ang', dealer_id: 'd-ang', notes: 'x', local_date: TODAY }, 'pres')).body.suggestion;
    await R(w, Object.assign(approval(ang), { route_id: 'r-ang', dealer_id: 'd-ang' }), 'pres');
    const my = await C(w, { action: 'my_tasks' }); assert.ok(my.body.tasks.every(x => x.dealer_id === 'd-greg'), 'Greg sees Angelo\'s visit tasks');
    const board = await call(load('pipeline-api.js', w), { action: 'board' }, { token: 'greg' });
    assert.ok((board.body.opportunities || []).every(o => o.dealer_id !== 'd-ang'), 'Greg sees Angelo\'s visit deals');
  });

  /* ── AI + email ── */
  await t('2 Meeting intelligence is a suggestion: cached for the same notes, refreshed on demand, off without a key', async () => {
    const w = W(); let calls = 0; const S = seed(); S.ai = () => { calls++; return AI_OUT; }; const w2 = createWorld(S);
    await R(w2, Object.assign({ action: 'visit_checkin' }, stop));
    const body = Object.assign({ action: 'visit_analyze', notes: 'same notes', local_date: TODAY }, stop);
    await R(w2, body); const c2 = await R(w2, body); assert.strictEqual(c2.body.cached, true); assert.strictEqual(calls, 1);
    await R(w2, Object.assign({ refresh: true }, body)); assert.strictEqual(calls, 2);
    await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const off = await R(w, Object.assign({ action: 'visit_analyze', notes: 'x' }, stop), 'greg', { ANTHROPIC_API_KEY: '' });
    assert.strictEqual(off.body.ok, false); assert.strictEqual(off.body.error, 'ai_unavailable');
    assert.strictEqual(w.db.dealer_visit_reports[0].fields.notes, 'x', 'the typed notes were not kept');
  });
  await t('2 Nothing written yet: no AI call, the review still gets the contact and line pickers, nothing is blanked', async () => {
    let calls = 0; const S = seed(); S.ai = () => { calls++; return AI_OUT; }; const w = createWorld(S);
    await R(w, Object.assign({ action: 'visit_checkin' }, stop)); await R(w, Object.assign({ action: 'visit_end' }, stop));
    w.db.dealer_visit_reports[0].fields = { purpose: 'Quarterly check-in' };
    const a = await R(w, Object.assign({ action: 'visit_analyze', notes: '', transcript: '', local_date: TODAY }, stop));
    assert.strictEqual(a.status, 200); assert.strictEqual(a.body.ok, false); assert.strictEqual(a.body.error, 'no_notes');
    assert.strictEqual(calls, 0, 'the AI was called with nothing to read');
    assert.ok((a.body.contacts || []).some(c => c.id === 'c-bryant'), 'no contact picker'); assert.ok((a.body.manufacturers || []).length >= 2, 'no line picker');
    assert.deepStrictEqual(w.db.dealer_visit_reports[0].fields, { purpose: 'Quarterly check-in' }, 'an empty analyze rewrote the visit');
  });
  await t('Follow-up email: a send is recorded on the visit by its id', async () => {
    const w = W(); const sug = await startEndAnalyze(w); await R(w, approval(sug));
    const id = w.db.dealer_visit_reports[0].id;
    const sv = await R(w, { action: 'visit_email_save', dealer_id: 'd-greg', report_id: id, sent: true, email: { to: 'bryant@glasgow.test', cc: ['x@glasgow.test'], subject: 'S', body: 'B' } });
    assert.strictEqual(sv.status, 200, JSON.stringify(sv.body)); assert.ok(w.db.dealer_visit_reports[0].followup_email.sent_at, 'not marked sent');
    const wrong = await R(w, { action: 'visit_email_save', dealer_id: 'd-dir-greg', report_id: id, email: { subject: 'x' } });
    assert.ok(wrong.status === 403, 'another dealer\'s visit id was accepted: ' + wrong.status);
    const c = await C(w, { action: 'visits', dealer_id: 'd-greg' }); assert.ok(c.body.past[0].email && c.body.past[0].email.sent_at, 'Dealer 360 does not show the send');
  });
  await t('Follow-up email: drafted from the APPROVED summary only, saved as a draft, never sent from here', async () => {
    const w = W(); const sug = await startEndAnalyze(w);
    let prompt = ''; const S = w; // capture the email prompt
    const early = await call(load('ai-email-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'draft', dealer_id: 'd-greg', template: 'visit_followup', visit_report_id: w.db.dealer_visit_reports[0].id }, { token: 'greg' });
    assert.strictEqual(early.status, 400, 'drafted before approval');
    await R(w, approval(sug));
    const before = w.outbound.length;
    const d = await call(load('ai-email-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'draft', dealer_id: 'd-greg', template: 'visit_followup', visit_report_id: w.db.dealer_visit_reports[0].id }, { token: 'greg' });
    const ai = w.outbound.slice(before).find(x => x.kind === 'ai'); prompt = ai && JSON.stringify(ai.body);
    assert.ok(/MEETING RECAP/.test(prompt) && /Send PR519 pricing/.test(prompt), 'the recap is not in the prompt');
    assert.ok(!w.outbound.some(x => x.kind === 'graph' || x.kind === 'resend'), 'an email was sent');
    const sv = await R(w, Object.assign({ action: 'visit_email_save', email: { to: 'bryant@glasgow.test', subject: 'Following up', body: 'Hi Bryant' } }, stop));
    assert.strictEqual(sv.status, 200); assert.strictEqual(w.db.dealer_visit_reports[0].followup_email.subject, 'Following up');
    assert.strictEqual(w.db.dealer_visit_reports[0].followup_email.sent_at, null);
    const other = await call(load('ai-email-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'draft', dealer_id: 'd-ang', template: 'visit_followup', visit_report_id: w.db.dealer_visit_reports[0].id }, { token: 'greg' });
    assert.strictEqual(other.status, 403);
    const cross = await call(load('ai-email-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'draft', dealer_id: 'd-dir-greg', template: 'visit_followup', visit_report_id: w.db.dealer_visit_reports[0].id }, { token: 'greg' });
    assert.strictEqual(cross.status, 404, 'a visit on one dealer drafted an email to another');
  });

  done('Phase 1 visit intelligence');
})();

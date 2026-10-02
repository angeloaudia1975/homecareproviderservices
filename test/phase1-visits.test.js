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
const n_ = n;
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
    // One summary = four AI requests made at the same time (what happened / commitments / follow-ups / deals).
    await R(w2, body); const c2 = await R(w2, body); assert.strictEqual(c2.body.cached, true); assert.strictEqual(calls, 4);
    await R(w2, Object.assign({ refresh: true }, body)); assert.strictEqual(calls, 8);
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

  /* ── Blocker fixes (Phase 1 live findings) ── */
  const TEST_DEALER = { id: 'd-test', business_name: 'TEST — Sandbox', rep_name: null, parent_id: null, state: 'IN', is_test: true };
  const cut = (text, stop) => ({ status: 200, body: { content: [{ type: 'text', text }], stop_reason: stop || 'end_turn' } });
  await t('AI: a cut-off first answer is retried once, automatically, and the review opens', async () => {
    const S = seed(); const prompts = [];
    let cutOnce = false;
    S.ai = b => { const p = JSON.stringify(b); prompts.push(p);
      if(!cutOnce && /WHAT HAPPENED/.test(p)){ cutOnce = true; return cut('{"meeting_summary":"Met Bryant and Sta', 'max_tokens'); } return AI_OUT; };
    const w = createWorld(S);
    await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const a = await R(w, Object.assign({ action: 'visit_analyze', notes: 'Met Bryant.', local_date: TODAY }, stop));
    assert.strictEqual(a.body.ok, true, JSON.stringify(a.body)); assert.strictEqual(a.body.attempts, 2);
    assert.strictEqual(prompts.length, 5, 'expected 4 parts + 1 retry');
    assert.strictEqual(prompts.filter(p => /covers the COMMITMENTS/.test(p)).length, 1);
    assert.strictEqual(prompts.filter(p => /WHAT HAPPENED/.test(p)).length, 2); assert.strictEqual(prompts.filter(p => /WHAT HAPPENS NEXT/.test(p)).length, 1);
    assert.strictEqual(prompts.filter(p => /covers the DEALS/.test(p)).length, 1);
    const retry = prompts.find(p => /previous answer was cut off/.test(p)); assert.ok(retry && /WHAT HAPPENED/.test(retry), 'the retry did not ask for a shorter answer');
    assert.ok(/minified JSON/.test(prompts[0]), 'compact output was not requested');
    assert.ok(/"max_tokens":4096/.test(prompts[0]), 'the output allowance was not raised');
    assert.ok(prompts.every(p => /"thinking":\{"type":"disabled"\}/.test(p)), 'thinking was left on (slow, and it eats the output allowance)');
    assert.strictEqual(a.body.suggestion.follow_ups.length, 2);
  });
  await t('AI: a wrong-shaped answer (no summary) is retried; fenced JSON with stray braces after it parses first time', async () => {
    const S = seed(); let n = 0;
    S.ai = b => { const p = JSON.stringify(b); if(/WHAT HAPPENED/.test(p)) n++; return n === 1 && /WHAT HAPPENED/.test(p) ? { follow_ups: [{ title: 'x' }] } : AI_OUT; };
    const w = createWorld(S); await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const a = await R(w, Object.assign({ action: 'visit_analyze', notes: 'n1', local_date: TODAY }, stop));
    assert.strictEqual(a.body.ok, true); assert.strictEqual(a.body.attempts, 2);
    const S2 = seed(); let m = 0; S2.ai = () => { m++; return 'Here you go:\n```json\n' + JSON.stringify(AI_OUT) + '\n```\nNote: {not json}'; };
    const w2 = createWorld(S2); await R(w2, Object.assign({ action: 'visit_checkin' }, stop));
    const b2 = await R(w2, Object.assign({ action: 'visit_analyze', notes: 'n2', local_date: TODAY }, stop));
    assert.strictEqual(b2.body.ok, true, JSON.stringify(b2.body)); assert.strictEqual(b2.body.attempts, 1); assert.strictEqual(m, 4, 'one request per part');
  });
  await t('AI: both attempts fail → a usable manual review; notes kept; the rep can still approve by hand', async () => {
    const S = seed(); let n = 0; S.ai = () => { n++; return cut('{"meeting_summary":"trunc', 'max_tokens'); };
    const w = createWorld(S); await R(w, Object.assign({ action: 'visit_checkin' }, stop)); await R(w, Object.assign({ action: 'visit_end' }, stop));
    const a = await R(w, Object.assign({ action: 'visit_analyze', notes: 'Met Bryant. Send pricing Friday.', local_date: TODAY }, stop));
    assert.strictEqual(a.body.ok, false); assert.strictEqual(a.body.attempts, 2); assert.strictEqual(n, 8, 'more than one retry per part');
    assert.ok(/notes are saved/i.test(a.body.message), a.body.message);
    assert.ok((a.body.contacts || []).length && (a.body.manufacturers || []).length, 'pickers missing on failure');
    assert.strictEqual(w.db.dealer_visit_reports[0].fields.notes, 'Met Bryant. Send pricing Friday.');
    assert.strictEqual(n_(w, 'dealer_tasks'), 0, 'records created before approval');
    const manual = Object.assign({ action: 'visit_approve' }, stop, { summary: { meeting_summary: 'Met Bryant; send pricing Friday.' },
      participants: [{ key: 'at_m_1', name: 'Bryant Smith', contact_id: 'c-bryant' }], tasks: [{ key: 'fu_m_1', title: 'Send pricing', due_date: IN3, priority: 'normal' }],
      opportunities: [{ key: 'op_m_1', title: '2 lift chairs', stage: 'identified' }] });
    const ap = await R(w, manual); assert.strictEqual(ap.status, 200); assert.deepStrictEqual(ap.body.created, { tasks: 1, opportunities: 1, participants: 1, contacts: 0 });
  });
  await t('AI: the QA "fail the first answer" switch works only for the president on a TEST dealer', async () => {
    const S = seed({ dealers: [TEST_DEALER] }); let n = 0; S.ai = () => { n++; return AI_OUT; };
    const w = createWorld(S);
    await R(w, { action: 'visit_checkin', dealer_id: 'd-test' }, 'pres');
    const q = await R(w, { action: 'visit_analyze', dealer_id: 'd-test', notes: 'qa', local_date: TODAY, qa_fail_first: true }, 'pres');
    assert.strictEqual(q.body.ok, true); assert.strictEqual(q.body.attempts, 2); assert.strictEqual(q.body.qa_forced, true); assert.strictEqual(n, 5, 'four parts + the forced retry');
    assert.deepStrictEqual(Object.keys(q.body.parts).sort(), ['commitments', 'deals', 'followups', 'meeting']); assert.strictEqual(q.body.parts.meeting.attempts, 2);
    await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const g = await R(w, Object.assign({ action: 'visit_analyze', notes: 'rep', local_date: TODAY, qa_fail_first: true }, stop));
    assert.strictEqual(g.body.attempts, 1, 'a rep could force a retry'); assert.ok(!g.body.qa_forced);
    await R(w, { action: 'visit_checkin', route_id: 'r-ang', dealer_id: 'd-ang' }, 'pres');
    const p = await R(w, { action: 'visit_analyze', route_id: 'r-ang', dealer_id: 'd-ang', notes: 'real dealer', local_date: TODAY, qa_fail_first: true }, 'pres');
    assert.strictEqual(p.body.attempts, 1, 'the switch worked on a real dealer');
  });
  await t('AI: the summary is asked for in four parts; if a later part fails the review opens with what came back, marked partial', async () => {
    const S = seed(); let next = 0;
    S.ai = b => { const p = JSON.stringify(b);
      if(/WHAT HAPPENS NEXT/.test(p)){ next++; return cut('{"follow_ups":[{"title":"Send pri', 'max_tokens'); }
      // a stray follow-up in the "what happened" answer is ignored — follow-ups only come from their own half
      return Object.assign({}, AI_OUT, { follow_ups: [{ title: 'stray' }] }); };
    const w = createWorld(S); await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const body = Object.assign({ action: 'visit_analyze', notes: 'Met Bryant.', local_date: TODAY }, stop);
    const a = await R(w, body);
    assert.strictEqual(a.body.ok, true, JSON.stringify(a.body)); assert.deepStrictEqual(a.body.suggestion.partial, ['follow_ups']);
    assert.ok(a.body.suggestion.rep_commitments.length, 'the commitments that came back were lost'); assert.strictEqual(a.body.parts.followups.ok, false);
    assert.ok(a.body.suggestion.meeting_summary, 'the summary that did come back was lost'); assert.strictEqual(a.body.suggestion.attendees.length, AI_OUT.attendees.length);
    assert.strictEqual(a.body.suggestion.opportunities.length, AI_OUT.opportunities.length, 'the deals that did come back were lost');
    assert.strictEqual(a.body.suggestion.follow_ups.length, 0, 'a stray follow-up from another part was used'); assert.strictEqual(next, 2, 'the follow-ups part was not retried once');
    assert.strictEqual(n_(w, 'dealer_tasks'), 0, 'records created before approval');
    const again = await R(w, body); assert.ok(!again.body.cached, 'a partial summary was served from cache'); assert.strictEqual(next, 4);
    // the follow-ups half's own stray summary never replaces the real one
    const S2 = seed(); S2.ai = b => /WHAT HAPPENS NEXT/.test(JSON.stringify(b)) ? Object.assign({}, AI_OUT, { meeting_summary: 'WRONG' }) : AI_OUT;
    const w2 = createWorld(S2); await R(w2, Object.assign({ action: 'visit_checkin' }, stop));
    const b2 = await R(w2, body); assert.strictEqual(b2.body.suggestion.meeting_summary, AI_OUT.meeting_summary); assert.ok(!b2.body.suggestion.partial);
    // only the deals part fails → partial "opportunities", follow-ups kept; both fail → "actions"
    const S3 = seed(); S3.ai = b => /covers the DEALS/.test(JSON.stringify(b)) ? cut('{"opportunities":[{"ti', 'max_tokens') : AI_OUT;
    const w3 = createWorld(S3); await R(w3, Object.assign({ action: 'visit_checkin' }, stop));
    const c3 = await R(w3, body); assert.deepStrictEqual(c3.body.suggestion.partial, ['opportunities']); assert.strictEqual(c3.body.suggestion.follow_ups.length, 2); assert.strictEqual(c3.body.suggestion.opportunities.length, 0);
    const S4 = seed(); S4.ai = b => /WHAT HAPPENED/.test(JSON.stringify(b)) ? AI_OUT : cut('{"x', 'max_tokens');
    const w4 = createWorld(S4); await R(w4, Object.assign({ action: 'visit_checkin' }, stop));
    const c4 = await R(w4, body); assert.deepStrictEqual(c4.body.suggestion.partial, ['commitments', 'follow_ups', 'opportunities']);
  });
  await t('Duplicates: a repeated follow-up and a next action that repeats a follow-up are offered unticked', async () => {
    const S = seed(); S.ai = () => Object.assign({}, AI_OUT, {
      follow_ups: AI_OUT.follow_ups.concat([{ title: 'Send the PR519 pricing to the dealer', due_date: IN3, priority: 'normal' }]),
      suggested_next_action: { text: 'Send PR519 pricing', due_date: IN3 } });
    const w = createWorld(S); await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const sug = (await R(w, Object.assign({ action: 'visit_analyze', notes: 'dup', local_date: TODAY }, stop))).body.suggestion;
    assert.strictEqual(sug.follow_ups.length, 3, 'a suggestion was dropped');
    assert.ok(!sug.follow_ups[0].dup_of && !sug.follow_ups[1].dup_of, 'distinct follow-ups marked as repeats');
    assert.strictEqual(sug.follow_ups[2].dup_of, sug.follow_ups[0].key);
    assert.strictEqual(sug.suggested_next_action.duplicate_of, sug.follow_ups[0].key);
    const VAI = require('../netlify/functions/_visit_ai.js');
    assert.strictEqual(VAI.sameAction({ title: 'Call Bryant back' }, { title: 'Send PR519 pricing' }), false);
    assert.strictEqual(VAI.sameAction({ title: 'Send pricing', due_date: '2026-10-06' }, { title: 'Send pricing', due_date: '2026-10-20' }), false, 'different dates are different work');
  });
  await t('Visits are only recorded against a dealer that exists — for the president too', async () => {
    const w = W(); const before = n_(w, 'dealer_visit_reports');
    for (const body of [{ action: 'visit_checkin', route_id: 'r-1', dealer_id: 'd-ghost' }, { action: 'visit_checkin', dealer_id: 'd-ghost' },
      { action: 'visit_end', dealer_id: 'd-ghost' }, { action: 'visit_approve', dealer_id: 'd-ghost', summary: { meeting_summary: 'x' } },
      { action: 'visit_report_save', dealer_id: 'd-ghost', status: 'in_progress', fields: { notes: 'x' } }]) {
      const r = await R(w, body, 'pres'); assert.strictEqual(r.status, 404, body.action + ' → ' + r.status + ' ' + JSON.stringify(r.body));
    }
    assert.strictEqual(n_(w, 'dealer_visit_reports'), before, 'a stray visit was created');
    assert.strictEqual((await R(w, Object.assign({ action: 'visit_checkin' }, stop), 'pres')).status, 200, 'a real dealer was refused');
  });
  await t('Email: the real visit date is in the prompt; relative days are rewritten once, then replaced; nothing is sent', async () => {
    const S = seed({ dealers: [TEST_DEALER] }); const prompts = [];
    S.ai = b => { const s = JSON.stringify(b); if (!/MEETING RECAP/.test(s)) return AI_OUT; prompts.push(s);
      return { subject: 'Following up', body: 'Hi Bryant,\n\nThanks for the time yesterday. I will send it tomorrow.' }; };
    const w = createWorld(S); const sug = await (async () => { await R(w, Object.assign({ action: 'visit_checkin', at: '2026-10-02T15:25:00Z' }, stop)).catch(() => {}); return null; })();
    await R(w, Object.assign({ action: 'visit_end' }, stop));
    const s1 = (await R(w, Object.assign({ action: 'visit_analyze', notes: 'Met Bryant.', local_date: TODAY }, stop))).body.suggestion;
    await R(w, approval(s1)); const rep = w.db.dealer_visit_reports[0];
    rep.checkin_at = '2026-10-02T15:25:00Z';
    const before = w.outbound.filter(x => x.kind === 'graph' || x.kind === 'resend').length;
    const d = await call(load('ai-email-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'draft', dealer_id: 'd-greg', template: 'visit_followup', visit_report_id: rep.id, contact_name: 'Bryant Smith' }, { token: 'greg' });
    assert.strictEqual(d.body.ok, true, JSON.stringify(d.body));
    assert.ok(/Visit date: Friday, October 2, 2026/.test(prompts[0]), 'the visit date is not in the prompt');
    assert.ok(/"thinking":\{"type":"disabled"\}/.test(prompts[0]), 'thinking was left on for the email draft');
    assert.ok(/meeting was on October 2/.test(prompts[0]) && /NEVER use relative day words/.test(prompts[0]));
    assert.strictEqual(prompts.length, 2, 'no rewrite was asked for'); assert.ok(/used relative day words/.test(prompts[1]) && /yesterday[^a-z]+[^"]*tomorrow/.test(prompts[1]), prompts[1].slice(-400));
    assert.ok(/the time on October 2/.test(d.body.body) && !/yesterday/i.test(d.body.body), d.body.body);
    assert.strictEqual(d.body.visit_date, 'October 2'); assert.ok((d.body.warnings || []).length === 1, 'a remaining "tomorrow" was not flagged');
    assert.strictEqual(w.outbound.filter(x => x.kind === 'graph' || x.kind === 'resend').length, before, 'an email was sent');
    // QA date override: president + TEST dealer only.
    const T = require('../netlify/functions/ai-email-api.js').__test;
    assert.deepStrictEqual(T.visitDateParts('2026-09-28T14:00:00Z'), { md: 'September 28', long: 'Monday, September 28, 2026' });
    assert.deepStrictEqual(T.visitDateParts('2026-10-03T03:30:00Z').md, 'October 2', 'an evening visit was dated the next day');
    const g = await call(load('ai-email-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'draft', dealer_id: 'd-greg', template: 'visit_followup', visit_report_id: rep.id, qa_visit_at: '2026-09-28T14:00:00Z' }, { token: 'pres' });
    assert.ok(/Visit date: Friday, October 2/.test(prompts[prompts.length - 2]), 'the QA override worked on a real dealer');
    // No recipient picked yet (several attendees): the greeting names no one; a chosen contact is greeted by name.
    assert.ok(/^Hi Bryant,/.test(d.body.body), 'a chosen contact lost their greeting: ' + d.body.body.slice(0, 40));
    assert.ok(/^Hi there,/.test(g.body.body), 'the draft greeted someone before a recipient was picked: ' + g.body.body.slice(0, 40));
    assert.ok(/No recipient has been chosen yet/.test(prompts[prompts.length - 2]) && !/No recipient has been chosen yet/.test(prompts[0]));
  });
  await t('Email recipients: one attendee → that person; several → the rep picks; none → the main contact; saved draft keeps its address', async () => {
    const src = require('./phase0-mock').adminSrc('scheduled-routes.html');
    const lift = name => { const at = src.indexOf('function ' + name + '('); let i = src.indexOf('{', at), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(at, i + 1); };
    const re = /const RCPT_RE\s*=\s*[^\n]*;/.exec(src)[0];
    const pick = new Function(re + '\n' + lift('pickVisitRecipients') + '\nreturn pickVisitRecipients;')();
    const rows = [{ name: 'Sandbox Main', email: 'main@dealer.test', source: 'contact' }, { name: 'Bryant Smith', email: 'bryant@dealer.test', source: 'contact' }];
    const one = pick(rows, [{ name: 'Bryant Smith', email: 'bryant@dealer.test' }, { name: 'Dana Price', email: '' }], '');
    assert.deepStrictEqual([...one.pre], ['bryant@dealer.test']); assert.strictEqual(one.greet, 'Bryant Smith'); assert.deepStrictEqual(one.noEmail, ['Dana Price']);
    assert.strictEqual(one.rows.filter(r => r.email === 'bryant@dealer.test').length, 1, 'an attendee was listed twice'); assert.strictEqual(one.rows[0].source, 'attendee');
    const many = pick(rows, [{ name: 'Bryant Smith', email: 'bryant@dealer.test' }, { name: 'Pat Lee', email: 'pat@dealer.test' }], '');
    assert.strictEqual(many.pre.size, 0, 'a recipient was chosen for the rep'); assert.ok(/tick who this goes to/.test(many.note)); assert.strictEqual(many.greet, '');
    const none = pick(rows, [], ''); assert.deepStrictEqual([...none.pre], ['main@dealer.test']);
    const noEmails = pick(rows, [{ name: 'Dana Price', email: '' }], ''); assert.deepStrictEqual([...noEmails.pre], ['main@dealer.test']);
    const saved = pick(rows, [{ name: 'Bryant Smith', email: 'bryant@dealer.test' }], 'main@dealer.test'); assert.deepStrictEqual([...saved.pre], ['main@dealer.test']);
    const typed = pick(rows, [], 'someone@else.test'); assert.strictEqual(typed.extra, 'someone@else.test');
  });

  /* ── Consistency across the four AI parts, partial retry, QA part-failure switch ── */
  const VAI = require('../netlify/functions/_visit_ai.js');
  const byPart = (fns) => b => { const p = JSON.stringify(b);
    const part = /WHAT HAPPENED/.test(p) ? 'meeting' : /covers the COMMITMENTS/.test(p) ? 'commitments' : /WHAT HAPPENS NEXT/.test(p) ? 'followups' : /covers the DEALS/.test(p) ? 'deals' : 'other';
    fns.calls = fns.calls || {}; fns.calls[part] = (fns.calls[part] || 0) + 1;
    return (fns[part] || (() => AI_OUT))(b); };
  await t('Consistency: quantity, model, contact, promised date and asked-for follow-ups are compared across the parts; conflicts are marked, never resolved', async () => {
    const sug = { meeting_summary: 'Met Bryant and Stacey. They want pricing on 2 PR-535 chairs and 6 Excursion chairs.', pricing_requests: ['PR-535 pricing'],
      literature_requested: ['Golden catalog'], training_requested: ['staff in-service'], attendees: [{ name: 'Bryant Cole' }, { name: 'Stacey Webb' }],
      rep_commitments: [{ text: 'Send PR-535 pricing and catalog', due_date: '2026-10-06' }],
      follow_ups: [{ key: 'f1', title: 'Send PR-535 pricing and the Golden catalog', due_date: '2026-10-08' }, { key: 'f2', title: 'Quote 4 Excursion chairs', due_date: '' }],
      suggested_next_action: { text: 'Send PR-535 pricing', due_date: '2026-10-07' },
      opportunities: [{ key: 'o1', title: '2 x PR-535 MaxiComfort', product: 'PR-535', quantity: 2, contact_name: 'Bryant Cole' },
        { key: 'o2', title: '4 Strongback Excursion chairs', product: 'Excursion', quantity: 4, contact_name: 'Luis Ortega' },
        { key: 'o3', title: '1 x PR-519', product: 'PR-519', quantity: 1 }] };
    VAI.crossCheck(sug, { notes: 'Bryant wants 2 PR-535 and 6 Excursion chairs. Send pricing by Tuesday.', mfrs: [{ slug: 'g', name: 'Golden Technologies' }, { slug: 's', name: 'Strongback Mobility' }] });
    const kinds = sug.checks.map(c => c.kind + ':' + (c.key || c.section));
    for (const k of ['quantity:o2', 'model:o3', 'contact:o2', 'date:f1', 'date:next_action', 'request:follow_ups']) assert.ok(kinds.includes(k), 'not flagged: ' + k + ' in ' + kinds.join(', '));
    assert.ok(!kinds.includes('quantity:o1') && !kinds.includes('model:o1') && !kinds.includes('contact:o1'), 'a consistent deal was flagged: ' + kinds.join(', '));
    assert.ok(/says 4, the summary says 6/.test(sug.opportunities[1].review), sug.opportunities[1].review);
    assert.strictEqual(sug.opportunities[1].quantity, 4, 'a conflict was resolved by choosing a number'); assert.strictEqual(sug.follow_ups[0].due_date, '2026-10-08', 'a date was changed');
    assert.ok(sug.suggested_next_action.review && sug.follow_ups[0].review);
    // a consistent suggestion raises nothing
    const ok = { meeting_summary: 'Met Bryant; pricing on 2 PR519 chairs.', pricing_requests: ['PR519 pricing'], literature_requested: ['Golden catalog'], attendees: [{ name: 'Bryant Smith' }],
      rep_commitments: [{ text: 'Send PR519 pricing', due_date: IN3 }], follow_ups: [{ key: 'a', title: 'Send PR519 pricing and the Golden catalog', due_date: IN3 }],
      suggested_next_action: {}, opportunities: [{ key: 'b', title: '2 x PR519 lift chairs', product: 'PR519', quantity: 2, contact_name: 'Bryant Smith' },
        { key: 'c', title: '1 x PR519 for the showroom', product: 'PR519', quantity: 1 }] };
    ok.meeting_summary = 'Met Bryant; pricing on 2 PR519 chairs for a customer and 1 PR519 for the showroom.';
    VAI.crossCheck(ok, { notes: 'Met Bryant. 2 PR519 chairs for a customer, 1 PR519 for the showroom; send pricing and the catalog.', mfrs: [] });
    assert.deepStrictEqual(ok.checks, [], JSON.stringify(ok.checks));
    // "20 walkers and 12 rollators" — each number belongs to its own product
    const two = { meeting_summary: 'Opening order: 20 walkers and 12 rollators, plus samples.', attendees: [], follow_ups: [], suggested_next_action: {},
      opportunities: [{ key: 'w', title: '20 walkers', product: 'walkers', quantity: 20 }, { key: 'r', title: '12 rollators', product: 'rollators', quantity: 12 }] };
    VAI.crossCheck(two, { notes: '20 walkers and 12 rollators', mfrs: [] }); assert.deepStrictEqual(two.checks, [], JSON.stringify(two.checks));
    two.meeting_summary = 'They want 20 walkers and rollators for the new store.';
    VAI.crossCheck(two, { notes: '20 walkers and 12 rollators', mfrs: [] }); assert.deepStrictEqual(two.checks, [], '"20 walkers and rollators" was read as 20 rollators');
    two.meeting_summary = 'Nina asked for samples of the two rollator models and pricing in 2 weeks.';
    VAI.crossCheck(two, { notes: '20 walkers and 12 rollators', mfrs: [] }); assert.deepStrictEqual(two.checks, [], '"two rollator models" was read as 2 rollators');
    two.meeting_summary = 'Opening order: 20 walkers and 12 rollators, plus samples.';
    two.opportunities[1].quantity = 10; VAI.crossCheck(two, { notes: '20 walkers and 12 rollators', mfrs: [] });
    assert.ok(/says 10, the summary says 12/.test(two.opportunities[1].review || ''), JSON.stringify(two.checks));
    // through the server: the deals part says 4, the summary says 6 → the deal is marked, the number kept
    const S = seed(); S.ai = byPart({ meeting: () => Object.assign({}, AI_OUT, { meeting_summary: 'Met Bryant. They want 6 Excursion chairs.' }),
      deals: () => ({ opportunities: [{ title: '4 Strongback Excursion chairs', manufacturer_slug: 'strongback-mobility', product: 'Excursion', quantity: 4, contact_name: 'Bryant Smith' }] }) });
    const w = createWorld(S); await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const a = await R(w, Object.assign({ action: 'visit_analyze', notes: 'Bryant wants 6 Excursion chairs.', local_date: TODAY }, stop));
    const o = a.body.suggestion.opportunities[0]; assert.strictEqual(o.quantity, 4); assert.ok(/says 4, the summary says 6/.test(o.review || ''), JSON.stringify(a.body.suggestion.checks));
    assert.strictEqual(n_(w, 'opportunities'), 0, 'records created before approval');
  });
  await t('QA part-failure switch: president on a TEST dealer only; a forced part makes no AI call; per-part results are reported', async () => {
    const fns = {}; const S = seed({ dealers: [TEST_DEALER] }); S.ai = byPart(fns); const w = createWorld(S);
    await R(w, { action: 'visit_checkin', dealer_id: 'd-test' }, 'pres');
    const q = await R(w, { action: 'visit_analyze', dealer_id: 'd-test', notes: 'qa', local_date: TODAY, qa_fail_part: ['deals'] }, 'pres');
    assert.deepStrictEqual(q.body.suggestion.partial, ['opportunities']); assert.strictEqual(q.body.parts.deals.error, 'qa_forced'); assert.ok(!fns.calls.deals, 'a forced part called the AI');
    assert.strictEqual(q.body.parts.meeting.ok, true); assert.strictEqual(q.body.parts.meeting.attempts, 1);
    const m = await R(w, { action: 'visit_analyze', dealer_id: 'd-test', notes: 'qa', local_date: TODAY, qa_fail_part: 'meeting', refresh: true }, 'pres');
    assert.strictEqual(m.body.ok, false); assert.strictEqual(m.body.error, 'qa_forced'); assert.ok((m.body.contacts || []).length >= 0 && m.body.parts.meeting.ok === false);
    await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const g = await R(w, Object.assign({ action: 'visit_analyze', notes: 'rep', local_date: TODAY, qa_fail_part: ['deals', 'meeting'] }, stop));
    assert.strictEqual(g.body.ok, true); assert.ok(!g.body.suggestion.partial, 'a rep could force a part to fail');
    await R(w, { action: 'visit_checkin', route_id: 'r-ang', dealer_id: 'd-ang' }, 'pres');
    const p = await R(w, { action: 'visit_analyze', route_id: 'r-ang', dealer_id: 'd-ang', notes: 'real', local_date: TODAY, qa_fail_part: 'deals' }, 'pres');
    assert.ok(!p.body.suggestion.partial, 'the switch worked on a real dealer');
  });
  await t('Try AI again after a partial summary asks only for the missing parts and keeps every other section exactly as it was', async () => {
    const fns = {}; const S = seed({ dealers: [TEST_DEALER] }); S.ai = byPart(fns); const w = createWorld(S);
    await R(w, { action: 'visit_checkin', dealer_id: 'd-test' }, 'pres');
    const body = { action: 'visit_analyze', dealer_id: 'd-test', notes: 'Met Bryant. Send PR519 pricing; 2 PR519 chairs.', local_date: TODAY };
    const first = (await R(w, Object.assign({ qa_fail_part: ['followups', 'deals'] }, body), 'pres')).body.suggestion;
    assert.deepStrictEqual(first.partial, ['follow_ups', 'opportunities']); assert.strictEqual(first.follow_ups.length, 0); assert.strictEqual(first.opportunities.length, 0);
    // from now on the "what happened" and commitments parts would answer differently — they must not be asked again
    fns.meeting = () => Object.assign({}, AI_OUT, { meeting_summary: 'A DIFFERENT SUMMARY', attendees: [{ name: 'Someone Else' }] });
    fns.commitments = () => ({ rep_commitments: [{ text: 'DIFFERENT', due_date: '' }] });
    const before = Object.assign({}, fns.calls);
    const again = await R(w, Object.assign({ retry_parts: ['followups', 'deals'], refresh: true }, body), 'pres');
    const g = again.body.suggestion;
    assert.strictEqual(again.body.merged, true); assert.ok(!g.partial, 'still marked partial: ' + JSON.stringify(g.partial));
    assert.strictEqual(fns.calls.meeting, before.meeting, 'the summary was asked for again'); assert.strictEqual(fns.calls.commitments, before.commitments, 'the commitments were asked for again');
    assert.strictEqual(g.meeting_summary, first.meeting_summary); assert.deepStrictEqual(g.attendees, first.attendees); assert.deepStrictEqual(g.rep_commitments, first.rep_commitments);
    assert.strictEqual(g.follow_ups.length, 2); assert.strictEqual(g.opportunities.length, 1);
    assert.strictEqual(n_(w, 'dealer_tasks'), 0, 'records created before approval'); assert.strictEqual(n_(w, 'opportunities'), 0);
    // only one of two missing parts comes back → still partial for the other
    const third = (await R(w, Object.assign({ qa_fail_part: ['followups', 'deals'], refresh: true }, body), 'pres')).body.suggestion;
    const half = (await R(w, Object.assign({ retry_parts: ['followups', 'deals'], qa_fail_part: ['deals'], refresh: true }, body), 'pres')).body.suggestion;
    assert.deepStrictEqual(half.partial, ['opportunities']); assert.strictEqual(half.follow_ups.length, 2); assert.strictEqual(half.meeting_summary, third.meeting_summary);
    // the notes changed since → the whole summary runs again (nothing stale is kept)
    const changed = await R(w, Object.assign({}, body, { notes: 'New notes', retry_parts: ['deals'], refresh: true }), 'pres');
    assert.ok(!changed.body.merged); assert.strictEqual(changed.body.suggestion.meeting_summary, 'A DIFFERENT SUMMARY');
  });
  await t('AI: a model that refuses the thinking setting is asked again without it; usage is reported per part', async () => {
    const S = seed(); let n = 0;
    S.ai = b => { n++; return b.thinking ? { status: 400, body: { error: { message: 'thinking: not supported for this model' } } } : { status: 200, body: { content: [{ type: 'text', text: JSON.stringify(AI_OUT) }], stop_reason: 'end_turn', usage: { output_tokens: 321 } } }; };
    const w = createWorld(S); await R(w, Object.assign({ action: 'visit_checkin' }, stop));
    const a = await R(w, Object.assign({ action: 'visit_analyze', notes: 'Met Bryant.', local_date: TODAY }, stop));
    assert.strictEqual(a.body.ok, true, JSON.stringify(a.body)); assert.strictEqual(n, 8, 'each part: one refused call and one without thinking');
    assert.strictEqual(a.body.parts.meeting.tokens, 321); assert.strictEqual(a.body.parts.meeting.attempts, 1);
  });
  await t('Several deals and several follow-ups stay separate records; a replayed approval adds nothing', async () => {
    const S = seed(); S.ai = () => Object.assign({}, AI_OUT, {
      follow_ups: [{ title: 'Send PR519 pricing', due_date: IN3 }, { title: 'Ship the fabric sample book', due_date: IN3 }, { title: 'Book the staff in-service', due_date: IN7 }],
      opportunities: [{ title: '2 x PR519 lift chairs', manufacturer_slug: 'golden-technologies', product: 'PR519', quantity: 2 },
        { title: '1 x PR519 lift chair (showroom)', manufacturer_slug: 'golden-technologies', product: 'PR519', quantity: 1 },
        { title: '4 Strongback Excursion chairs', manufacturer_slug: 'strongback-mobility', product: 'Excursion', quantity: 4 }] });
    const w = createWorld(S); const sug = await startEndAnalyze(w);
    assert.strictEqual(sug.follow_ups.length, 3); assert.strictEqual(sug.opportunities.length, 3); assert.ok(sug.follow_ups.every(f => !f.dup_of), 'separate follow-ups were merged');
    const ap = approval(sug); await R(w, ap);
    const tasks = w.db.dealer_tasks.filter(x => x.origin_type === 'visit_report'), opps = w.db.opportunities.filter(x => x.origin_type === 'visit_report');
    assert.strictEqual(tasks.length, 3); assert.strictEqual(opps.length, 3); assert.strictEqual(new Set(opps.map(o => o.title)).size, 3);
    const before = JSON.stringify(sideEffects(w)); await R(w, ap); await R(w, ap);
    assert.strictEqual(JSON.stringify(sideEffects(w)), before, 'a replayed approval created records');
  });
  await t('Review screen: a partial summary and an AI failure offer Try AI again; no key / no notes do not', async () => {
    const src = require('./phase0-mock').adminSrc('scheduled-routes.html');
    const lift = name => { const at = src.indexOf('function ' + name + '('); let i = src.indexOf('{', at), d = 0; for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(at, i + 1); };
    const consts = /const SECTION_NAME=[^\n]*\n/.exec(src)[0];
    const mk = new Function('REV', consts + lift('missingSections') + '\n' + lift('canRetryAi') + '\n' + lift('partialNote') + '\nreturn { canRetryAi, partialNote };');
    const part = { manual: false }; const f = mk(part); f.partialNote();
    assert.ok(part.partial && /didn't finish the follow-ups/.test(part.msg) && f.canRetryAi(), 'a partial summary offers no retry');
    const deals = { manual: false }; mk(deals).partialNote(['opportunities']); assert.ok(/didn't finish the opportunities\./.test(deals.msg), deals.msg);
    assert.deepStrictEqual(deals.missing, ['opportunities']);
    const two = { manual: false }; mk(two).partialNote(['commitments', 'follow_ups', 'opportunities']); assert.ok(/the commitments, the follow-ups and the opportunities/.test(two.msg), two.msg);
    const old = { manual: false }; mk(old).partialNote('follow_ups'); assert.deepStrictEqual(old.missing, ['follow_ups'], 'a summary saved before the split is not understood');
    assert.ok(mk({ manual: true, err: 'ai_incomplete' }).canRetryAi());
    assert.ok(!mk({ manual: true, err: 'ai_unavailable' }).canRetryAi() && !mk({ manual: true, err: 'no_notes' }).canRetryAi());
    assert.ok(!mk({ manual: false }).canRetryAi(), 'a full AI summary offered a retry');
  });

  done('Phase 1 visit intelligence');
})();

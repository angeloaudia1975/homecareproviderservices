/* Phase 1: Sales Rep Command Center (rep-command-api) — the right person's day, built only from
   their own data, paged past 1000 rows, no AI on load. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), TOMORROW = dayStr(1), YDAY = dayStr(-1), LAST_MONTH = dayStr(-40);
const TZ = new Date().getTimezoneOffset();
const nowIso = new Date().toISOString();

function seed(extra) {
  const S = standardSeed(Object.assign({
    rep_routes: [
      { id: 'r-g', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', name: 'Greg today', scheduled_date: TODAY, stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-dir-greg', name: 'Directory Only' }] },
      { id: 'r-g2', owner_email: 'greg@hcps.us', name: 'Greg tomorrow', scheduled_date: TOMORROW, stops: [{ dealer_id: 'd-greg-branch', name: 'Glasgow North' }] },
      { id: 'r-a', owner_email: 'angelo@hcps.us', name: 'Angelo today', scheduled_date: TODAY, stops: [{ dealer_id: 'd-ang', name: 'RMS' }] } ],
    dealer_tasks: [
      { id: 't-g1', dealer_id: 'd-greg', title: 'Overdue call', status: 'open', priority: 'normal', due_date: YDAY, assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' },
      { id: 't-g2', dealer_id: 'd-greg', title: 'Due today', status: 'open', priority: 'high', due_date: TODAY, assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' },
      { id: 't-a1', dealer_id: 'd-ang', title: 'Angelo task', status: 'open', priority: 'high', due_date: TODAY, assigned_rep: 'Angelo Audia', assigned_email: 'angelo@hcps.us' } ],
    opportunities: [
      { id: 'o-g', dealer_id: 'd-greg', title: 'Greg deal', stage: 'contacted', status: 'open', value: 1000, owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us', expected_close: YDAY, created_at: LAST_MONTH, updated_at: LAST_MONTH },
      { id: 'o-a', dealer_id: 'd-ang', title: 'Angelo deal', stage: 'quoted', status: 'open', value: 5000, owner_rep: 'Angelo Audia', owner_email: 'angelo@hcps.us', expected_close: YDAY } ],
    dealer_visit_reports: [
      { id: 'v-old', dealer_id: 'd-greg', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: LAST_MONTH + 'T15:00:00Z', completed_at: LAST_MONTH + 'T16:00:00Z', approved_at: LAST_MONTH + 'T16:00:00Z', status: 'completed',
        summary: { meeting_summary: 'Reviewed lift chairs.', dealer_concerns: ['Lead times'], objections: ['Price'], rep_commitments: [{ text: 'Send pricing' }] }, followup_status: 'pending', followup_due: YDAY },
      { id: 'v-ang', dealer_id: 'd-ang', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', checkin_at: nowIso, status: 'checked_in', followup_status: 'pending' } ],
    monthly_sales: [ { dealer_id: 'd-greg', period: dayStr(-35).slice(0, 7) + '-01', amount: 1200, product_name: 'PR519 Lift Chair' },
                     { dealer_id: 'd-greg', period: dayStr(-150).slice(0, 7) + '-01', amount: 300, product_name: 'Walker' } ],
    dealer_notes: [{ id: 'n1', dealer_id: 'd-greg', body: 'Asked about the fall promo.', created_at: dayStr(-5) + 'T12:00:00Z' }],
    dealer_contacts: [{ id: 'c-b', dealer_id: 'd-greg', name: 'Bryant Smith', title: 'Pharmacist', phone: '270-111' }],
    dealer_engagement: [{ dealer_id: 'd-greg', status: 'watch', trend: -12, score: 55 }],
    cross_sell: [{ dealer_id: 'd-greg', rec_name: 'Strongback Mobility', basis_name: 'Golden', rank: 1 }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }],
  }, extra || {}));
  return S;
}
const W = extra => createWorld(seed(extra));
const CC = (w, tok, body) => call(load('rep-command-api.js', w), Object.assign({ action: 'today', date: TODAY, tz: TZ }, body || {}), { token: tok || 'greg' });

(async () => {
  await t('8 Greg\'s Command Center shows only Greg\'s day', async () => {
    const w = W(); const r = await CC(w);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.strictEqual(b.header.rep.email, 'greg@hcps.us'); assert.strictEqual(b.header.viewing_other, false);
    assert.strictEqual(b.route.id, 'r-g'); assert.deepStrictEqual(b.route.stops.map(s => s.dealer_id), ['d-greg', 'd-dir-greg']);
    const all = JSON.stringify(b);
    for (const leak of ['t-a1', 'o-a', 'v-ang', 'Angelo task', 'Angelo deal', 'd-ang']) assert.ok(!all.includes(leak), 'leaked ' + leak);
    assert.strictEqual(b.header.open_tasks, 2); assert.strictEqual(b.header.overdue, 1); assert.strictEqual(b.header.due_today, 1);
    assert.strictEqual(b.tomorrow.stops, 1); assert.strictEqual(b.tomorrow.first_stop, 'Glasgow North');
  });
  await t('8 A rep cannot pick someone else\'s Command Center', async () => {
    const w = W(); const r = await CC(w, 'greg', { rep: 'angelo@hcps.us' });
    assert.strictEqual(r.body.header.rep.email, 'greg@hcps.us', 'rep param honoured for a rep');
    const reps = await call(load('rep-command-api.js', w), { action: 'reps' }, { token: 'greg' }); assert.deepStrictEqual(reps.body.reps, []);
  });
  await t('8 The president can view any rep; Relations follows the Phase 0 matrix', async () => {
    const w = W();
    const p = await CC(w, 'pres', { rep: 'greg@hcps.us' }); assert.strictEqual(p.body.header.rep.email, 'greg@hcps.us'); assert.strictEqual(p.body.header.viewing_other, true);
    assert.strictEqual(p.body.route.id, 'r-g'); assert.ok(!JSON.stringify(p.body).includes('Angelo task'));
    const own = await CC(w, 'pres'); assert.strictEqual(own.body.route.id, 'r-a', 'the president\'s own day'); assert.ok(!own.body.route.stops.some(s => s.dealer_id === 'd-greg'), 'a route built for Greg shows as the president\'s');
    const l = await CC(w, 'lori', { rep: 'greg@hcps.us' }); assert.strictEqual(l.body.header.rep.email, 'greg@hcps.us');
    const reps = await call(load('rep-command-api.js', w), { action: 'reps' }, { token: 'pres' }); assert.ok(reps.body.reps.length >= 3);
    assert.strictEqual((await CC(w, 'pres', { rep: 'ghost@hcps.us' })).status, 404);
  });
  await t('Meeting Prep: a short brief per stop from existing Dealer 360 data', async () => {
    const w = W(); const b = (await CC(w)).body; const p = b.prep.find(x => x.dealer_id === 'd-greg');
    assert.ok(p.last_visit && p.last_visit.summary === 'Reviewed lift chairs.'); assert.deepStrictEqual(p.concerns, ['Lead times', 'Price']);
    assert.ok(p.last_purchase && p.last_purchase.amount === 1200);
    assert.strictEqual(p.activity.sales_60, 1200); assert.strictEqual(p.activity.sales_180, 1500);
    assert.deepStrictEqual(p.recent_products, ['PR519 Lift Chair', 'Walker']);
    assert.strictEqual(p.open_tasks.count, 2); assert.strictEqual(p.open_opportunities.count, 1);
    assert.strictEqual(p.recent_notes[0].text, 'Asked about the fall promo.'); assert.strictEqual(p.trend.status, 'watch');
    assert.strictEqual(p.crossover.line, 'Strongback Mobility'); assert.strictEqual(p.contacts[0].name, 'Bryant Smith');
  });
  await t('Priorities, follow-up queue and opportunities needing attention', async () => {
    const w = W(); const b = (await CC(w)).body;
    const kinds = b.priorities.map(x => x.why);
    assert.ok(kinds.includes('Overdue') && kinds.includes('Due today'), JSON.stringify(b.priorities));
    assert.ok(b.priorities.some(x => x.kind === 'followup'), 'overdue visit follow-up not a priority');
    assert.strictEqual(b.followup_queue.visits.length, 1); assert.deepStrictEqual(b.followup_queue.visits[0].commitments.rep, ['Send pricing']);
    const o = b.opportunities.needs_attention.find(x => x.id === 'o-g'); assert.ok(o && o.why.includes('Close date passed') && o.why.includes('No update in 30+ days'));
    assert.strictEqual(b.opportunities.weighted, 300);
  });
  await t('Visit progress and Today\'s Follow-Up Progress move as the day goes', async () => {
    const S = seed(); S.unique = { dealer_tasks: [['origin_type', 'origin_id', 'origin_key']], opportunities: [['origin_type', 'origin_id', 'origin_key']], dealer_visit_participants: [['visit_report_id', 'name_key']] };
    const w = createWorld(S);
    let b = (await CC(w, 'greg', { hour: 8 })).body; assert.strictEqual(b.phase, 'morning'); assert.strictEqual(b.visit_progress.counts.planned, 2);
    const R = body => call(load('routes-api.js', w), body, { token: 'greg' });
    await R({ action: 'visit_checkin', route_id: 'r-g', dealer_id: 'd-greg' }); await R({ action: 'visit_end', route_id: 'r-g', dealer_id: 'd-greg' });
    await R({ action: 'visit_approve', route_id: 'r-g', dealer_id: 'd-greg', summary: { meeting_summary: 'Good visit.', rep_commitments: [{ text: 'Send quote' }] },
      participants: [{ name: 'New Buyer', add_as_contact: true }], tasks: [{ key: 'fu_1', title: 'Send quote', due_date: TODAY }, { key: 'fu_2', title: 'Ship samples', due_date: TOMORROW }],
      opportunities: [{ key: 'op_1', title: 'Chairs' }] });
    b = (await CC(w, 'greg', { hour: 11 })).body;
    assert.strictEqual(b.phase, 'field'); assert.strictEqual(b.visit_progress.counts.done, 1); assert.strictEqual(b.visit_progress.counts.planned, 1);
    const va = b.visit_activity[0]; assert.strictEqual(va.tasks, 2); assert.strictEqual(va.opportunities, 1); assert.strictEqual(va.contacts_added, 1); assert.strictEqual(va.summary, 'Good visit.');
    assert.strictEqual(b.end_of_day.progress.label, '0 of 3 actions completed');   // fu_1, fu_2 + the task already due today
    const fu1 = w.db.dealer_tasks.find(x => x.origin_key === 'fu_1');
    await call(load('crm-api.js', w), { action: 'complete_task', id: fu1.id }, { token: 'greg' });
    b = (await CC(w, 'greg', { hour: 17 })).body;
    assert.strictEqual(b.phase, 'wrap'); assert.strictEqual(b.end_of_day.progress.completed, 1); assert.strictEqual(b.end_of_day.tasks_completed, 1);
    assert.strictEqual(b.end_of_day.rep_commitments, 1);
  });
  await t('Paging: a rep\'s tasks and deals are counted past 1000 rows, and nobody else\'s are', async () => {
    const many = []; for (let i = 0; i < 1100; i++) many.push({ id: 'x' + i, dealer_id: 'd-greg', title: 'T' + i, status: 'open', priority: 'normal', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' });
    for (let i = 0; i < 1100; i++) many.push({ id: 'y' + i, dealer_id: 'd-ang', title: 'A' + i, status: 'open', priority: 'normal', assigned_rep: 'Angelo Audia', assigned_email: 'angelo@hcps.us' });
    const w = W({ dealer_tasks: many });
    const b = (await CC(w)).body; assert.strictEqual(b.header.open_tasks, 1100, 'cut at ' + b.header.open_tasks);
    const calls = w.calls.filter(c => /dealer_tasks/.test(c.url) && c.method === 'GET');
    assert.ok(calls.every(c => /assigned_email|origin_id|dealer_id=in/.test(c.url)), 'a task read was not filtered on the server: ' + calls.map(c => c.url).find(u => !/assigned_email|origin_id|dealer_id=in/.test(u)));
  });
  await t('No AI on load', async () => {
    const S = seed(); let ai = 0; S.ai = () => { ai++; return {}; }; const w = createWorld(S);
    await call(load('rep-command-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'today', date: TODAY, tz: TZ }, { token: 'greg' });
    assert.strictEqual(ai, 0); assert.ok(!w.outbound.some(x => x.kind === 'ai'));
  });
  await t('Pure pieces: stop status and follow-up progress', async () => {
    const { __test } = load('rep-command-api.js', W());
    assert.strictEqual(__test.stopStatus(null), 'planned'); assert.strictEqual(__test.stopStatus({ checkin_at: 'x' }), 'on_site');
    assert.strictEqual(__test.stopStatus({ checkin_at: 'x', ended_at: 'y' }), 'ended'); assert.strictEqual(__test.stopStatus({ approved_at: 'z' }), 'done');
    const p = __test.followupProgress({ today: TODAY, todaysReportIds: ['v1'], tasksOpenMine: [{ id: 'a', due_date: TODAY, status: 'open' }], tasksClosedToday: [{ id: 'b', due_date: TODAY, status: 'done' }],
      originTasksToday: [{ id: 'c', origin_id: 'v1', status: 'dismissed' }, { id: 'a', origin_id: 'v1', status: 'open' }] });
    assert.deepStrictEqual([p.completed, p.total], [2, 3]);
  });

  done('Phase 1 command center');
})();

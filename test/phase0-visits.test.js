/* Phase 0F: a visit runs once. Double taps, outbox replays and late drafts must not create a
   second visit log, Dealer 360 note, task, opportunity or interest signal, and must not re-open a
   finished visit. Every case runs the real routes-api handler against the fake database. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const ROUTE = { id: 'r-1', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'KY loop', scheduled_date: '2026-10-05', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }] };
function seed() {
  return standardSeed({
    rep_routes: [ROUTE],
    dealer_visit_reports: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }],
  });
}
const FIELDS = { purpose: 'Quarterly review', notes: 'Talked through the Golden lift chairs.', followups: ['Send the price sheet'], opportunities: ['Golden lift chairs'], next_action: 'Call back', next_action_date: '2026-10-20' };
const STRUCT = { interest_slugs: ['golden-technologies'], poor_fit_slugs: ['bemis'] };
const save = (m, status, extra) => call(m, Object.assign({ action: 'visit_report_save', route_id: 'r-1', dealer_id: 'd-greg', status, fields: FIELDS }, extra || {}), { token: 'greg' });
const count = (w, table) => (w.db[table] || []).length;
const fanout = w => ({ visits: count(w, 'dealer_visits'), notes: count(w, 'dealer_notes'), tasks: count(w, 'dealer_tasks'), opps: count(w, 'opportunities'), intent: count(w, 'intent_events'), excl: count(w, 'dealer_handout_exclusions') });
const ONE = { visits: 1, notes: 1, tasks: 2, opps: 1, intent: 1, excl: 1 };
const report = w => w.db.dealer_visit_reports.filter(r => r.dealer_id === 'd-greg');

(async () => {
  await t('0F the first completion writes the visit once — everything it should', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    const r = await save(m, 'completed', { structured: STRUCT });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.first_completion, true);
    assert.deepStrictEqual(fanout(w), ONE);
    assert.strictEqual(report(w).length, 1); assert.strictEqual(report(w)[0].status, 'completed'); assert.ok(report(w)[0].completed_at);
  });
  await t('0F a double tap / outbox replay of "complete" changes nothing', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    await save(m, 'completed', { structured: STRUCT });
    const at = report(w)[0].completed_at;
    const r2 = await save(load('routes-api.js', w), 'completed', { structured: STRUCT });
    assert.strictEqual(r2.status, 200); assert.strictEqual(r2.body.first_completion, false); assert.strictEqual(r2.body.completed_at, at);
    assert.deepStrictEqual(fanout(w), ONE, 'side effects ran twice');
    assert.strictEqual(report(w)[0].completed_at, at, 'completion time moved');
  });
  await t('0F two completions racing — exactly one wins the claim', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    const [a, b] = await Promise.all([save(m, 'completed', { structured: STRUCT }), save(m, 'completed', { structured: STRUCT })]);
    assert.strictEqual([a.body.first_completion, b.body.first_completion].filter(Boolean).length, 1, JSON.stringify([a.body, b.body]));
    assert.deepStrictEqual(fanout(w), ONE);
  });
  await t('0F a draft saved after completion keeps the edit but does not re-open the visit', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    await save(m, 'completed');
    const at = report(w)[0].completed_at;
    const r = await save(load('routes-api.js', w), 'in_progress', { fields: Object.assign({}, FIELDS, { notes: 'Added after the visit.' }) });
    assert.strictEqual(r.body.status, 'completed');
    assert.strictEqual(report(w)[0].status, 'completed'); assert.strictEqual(report(w)[0].completed_at, at);
    assert.strictEqual(report(w)[0].fields.notes, 'Added after the visit.');
    assert.strictEqual(count(w, 'dealer_visits'), 1);
  });
  await t('0F status only moves forward', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    await save(m, 'in_progress');
    await call(load('routes-api.js', w), { action: 'visit_checkin', route_id: 'r-1', dealer_id: 'd-greg' }, { token: 'greg' });
    assert.strictEqual(report(w)[0].status, 'in_progress', 'a late check-in pulled the draft back');
    assert.ok(report(w)[0].checkin_at, 'the arrival time is still recorded');
  });
  await t('0F a repeated check-in keeps the first arrival time; none re-opens a finished visit', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    const a = await call(m, { action: 'visit_checkin', route_id: 'r-1', dealer_id: 'd-greg' }, { token: 'greg' });
    const first = report(w)[0].checkin_at;
    await new Promise(r => setTimeout(r, 5));
    const b = await call(load('routes-api.js', w), { action: 'visit_checkin', route_id: 'r-1', dealer_id: 'd-greg' }, { token: 'greg' });
    assert.strictEqual(report(w)[0].checkin_at, first); assert.strictEqual(b.body.checkin_at, a.body.checkin_at);
    await save(load('routes-api.js', w), 'completed');
    await call(load('routes-api.js', w), { action: 'visit_checkin', route_id: 'r-1', dealer_id: 'd-greg' }, { token: 'greg' });
    assert.strictEqual(report(w)[0].status, 'completed', 'check-in re-opened a finished visit');
  });
  await t('0F an unknown status is refused and writes nothing', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    const r = await save(m, 'done');
    assert.strictEqual(r.status, 400); assert.strictEqual(report(w).length, 0);
  });
  await t('0F a draft never pulls a visit back to an earlier step', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    await save(m, 'in_progress');
    const r = await save(load('routes-api.js', w), 'checked_in');
    assert.strictEqual(report(w)[0].status, 'in_progress'); assert.strictEqual(r.body.status, 'in_progress');
  });
  await t('0F a draft that lands just after another device completed the visit is healed', async () => {
    const S = seed(); S.tables.dealer_visit_reports.push({ id: 'vr-x', route_id: 'r-1', dealer_id: 'd-greg', rep_email: 'greg@hcps.us', status: 'in_progress', fields: {} });
    const w = createWorld(S); const m = load('routes-api.js', w);
    const inner = global.fetch;   // the other device's claim lands between this save's read and its write
    global.fetch = async (url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      if (/dealer_visit_reports\?on_conflict/.test(url) && body && body.status === 'in_progress') { const row = w.db.dealer_visit_reports[0]; row.completed_at = '2026-10-05T15:00:00Z'; row.status = 'completed'; }
      return inner(url, opts);
    };
    try { await save(m, 'in_progress'); } finally { global.fetch = inner; }
    assert.strictEqual(report(w)[0].status, 'completed', 'a finished visit was left looking unfinished');
  });
  await t('0F a row with completed_at is healed to "completed" by the next save', async () => {
    const S = seed(); S.tables.dealer_visit_reports.push({ id: 'vr-x', route_id: 'r-1', dealer_id: 'd-greg', rep_email: 'greg@hcps.us', status: 'in_progress', completed_at: '2026-10-05T15:00:00Z', fields: {} });
    const w = createWorld(S); const m = load('routes-api.js', w);
    await save(m, 'in_progress');
    assert.strictEqual(report(w)[0].status, 'completed');
    assert.strictEqual(count(w, 'dealer_visits'), 0, 'an already-finished visit must not fan out');
  });
  await t('0F off a route: check-in and completion share one report', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    await call(m, { action: 'visit_checkin', dealer_id: 'd-greg' }, { token: 'greg' });
    await call(load('routes-api.js', w), { action: 'visit_checkin', dealer_id: 'd-greg' }, { token: 'greg' });
    assert.strictEqual(report(w).length, 1, 'second check-in made a second report');
    const r = await call(load('routes-api.js', w), { action: 'visit_report_save', dealer_id: 'd-greg', status: 'completed', fields: FIELDS }, { token: 'greg' });
    assert.strictEqual(r.body.first_completion, true);
    assert.strictEqual(report(w).length, 1); assert.ok(report(w)[0].checkin_at && report(w)[0].completed_at);
  });
  await t('0F off a route: an exact replay is the same visit; a new visit is new', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    const body = { action: 'visit_report_save', dealer_id: 'd-greg', status: 'completed', fields: FIELDS };
    await call(m, body, { token: 'greg' });
    const r2 = await call(load('routes-api.js', w), body, { token: 'greg' });
    assert.strictEqual(r2.body.first_completion, false); assert.strictEqual(report(w).length, 1); assert.strictEqual(count(w, 'dealer_visits'), 1);
    const r3 = await call(load('routes-api.js', w), Object.assign({}, body, { fields: Object.assign({}, FIELDS, { purpose: 'Next month' }) }), { token: 'greg' });
    assert.strictEqual(r3.body.first_completion, true); assert.strictEqual(report(w).length, 2); assert.strictEqual(count(w, 'dealer_visits'), 2);
  });
  await t('0F off a route: a late replay of an earlier visit, after a newer one finished, is still the earlier visit', async () => {
    const w = createWorld(seed());
    const v1 = { action: 'visit_report_save', dealer_id: 'd-greg', status: 'completed', fields: FIELDS, structured: STRUCT };
    const v2 = Object.assign({}, v1, { fields: Object.assign({}, FIELDS, { purpose: 'Second visit', followups: ['Drop off a brochure'] }) });
    await call(load('routes-api.js', w), v1, { token: 'greg' });
    await call(load('routes-api.js', w), { action: 'visit_checkin', dealer_id: 'd-greg' }, { token: 'greg' });
    const second = await call(load('routes-api.js', w), v2, { token: 'greg' });
    assert.strictEqual(second.body.first_completion, true, 'the newer visit is a visit of its own');
    const before = fanout(w);
    const late = await call(load('routes-api.js', w), v1, { token: 'greg' });   // visit 1's lost response, retried late
    assert.strictEqual(late.body.first_completion, false, 'the late replay was treated as a new visit');
    assert.deepStrictEqual(fanout(w), before, 'the late replay repeated side effects');
    assert.strictEqual(report(w).length, 2);
  });
  await t('0F off a route: the same report a month later is a new visit', async () => {
    const w = createWorld(seed());
    const v1 = { action: 'visit_report_save', dealer_id: 'd-greg', status: 'completed', fields: FIELDS };
    await call(load('routes-api.js', w), v1, { token: 'greg' });
    report(w)[0].completed_at = new Date(Date.now() - 40 * 86400000).toISOString();
    const again = await call(load('routes-api.js', w), v1, { token: 'greg' });
    assert.strictEqual(again.body.first_completion, true, 'an identical visit 40 days later was swallowed');
    assert.strictEqual(count(w, 'dealer_visits'), 2);
  });
  await t('0F a rep still cannot report a visit on someone else\'s dealer', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    const r = await call(m, { action: 'visit_report_save', dealer_id: 'd-ang', status: 'completed', fields: FIELDS }, { token: 'greg' });
    assert.strictEqual(r.status, 403); assert.strictEqual(count(w, 'dealer_visit_reports'), 0);
  });

  done('0F visits run once');
})();

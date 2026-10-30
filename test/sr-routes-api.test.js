/* routes-api — saved-route ownership and the President's own day (handler suite; 2026-10-30 audit).
   · A rep re-saving his own route re-assigned it to himself, undoing the President's hand-over.
   · The President re-saving a rep's route became its owner (the rep lost edit rights).
   · route_day by date, in My Sales Workspace, returned whichever rep's route was edited last.
   Real handler, fake database. Run: node test/sr-routes-api.test.js */
const assert = require('assert');
const { createWorld, load, standardSeed } = require('./phase0-mock');
let pass = 0, fail = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } }
function world() {
  return createWorld(standardSeed({ rep_routes: [
    { id: 'r-greg', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'Greg loop', scheduled_date: '2026-11-04', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }],
      assigned_to_email: 'lori@hcps.us', assigned_to_rep: 'Lori Hunt', updated_at: '2026-10-01T00:00:00Z' },
    { id: 'r-ang', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'My TN day', scheduled_date: '2026-11-05', stops: [{ dealer_id: 'd-ang', name: 'RMS' }], updated_at: '2026-10-01T00:00:00Z' },
    { id: 'r-other', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'Planned for Greg', scheduled_date: '2026-11-05', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }],
      assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', updated_at: '2026-10-20T00:00:00Z' },
  ], dealer_visit_reports: [] }));
}
async function call(w, who, body, headers) {
  const mod = load('routes-api.js', w, {});
  const r = await mod.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: 'Bearer ' + who }, headers || {}), body: JSON.stringify(body) });
  return { status: r.statusCode, j: JSON.parse(r.body || '{}') };
}
(async () => {
  await t('a rep re-saving his route keeps the President’s assignment (to Lori) and stays owner', async () => {
    const w = world();
    const r = await call(w, 'greg', { action: 'save_route', id: 'r-greg', name: 'Greg loop v2', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }] });
    assert.ok(r.j.ok, JSON.stringify(r.j));
    const row = w.db.rep_routes.find(x => x.id === 'r-greg');
    assert.strictEqual(row.name, 'Greg loop v2');
    assert.strictEqual(row.assigned_to_email, 'lori@hcps.us'); assert.strictEqual(row.owner_email, 'greg@hcps.us');
  });
  await t('the President re-saving a rep’s route does not take it over', async () => {
    const w = world();
    assert.ok((await call(w, 'pres', { action: 'save_route', id: 'r-greg', name: 'Edited by the office', stops: [] })).j.ok);
    const row = w.db.rep_routes.find(x => x.id === 'r-greg');
    assert.strictEqual(row.owner_email, 'greg@hcps.us'); assert.strictEqual(row.rep_name, 'Greg Campbell'); assert.strictEqual(row.assigned_to_email, 'lori@hcps.us');
  });
  await t('an explicit assignment by the President still moves it', async () => {
    const w = world();
    assert.ok((await call(w, 'pres', { action: 'save_route', id: 'r-greg', name: 'x', stops: [], assigned_to_email: 'greg@hcps.us' })).j.ok);
    assert.strictEqual(w.db.rep_routes.find(x => x.id === 'r-greg').assigned_to_email, 'greg@hcps.us');
  });
  await t('a new route is still owned by whoever saves it', async () => {
    const w = world();
    const r = await call(w, 'greg', { action: 'save_route', name: 'Brand new', stops: [] });
    const row = w.db.rep_routes.find(x => x.id === r.j.id); assert.strictEqual(row.owner_email, 'greg@hcps.us');
  });
  await t('My Sales Workspace: route_day by date is the President’s own route, not the one he planned for Greg', async () => {
    const w = world();
    const r = await call(w, 'pres', { action: 'route_day', date: '2026-11-05' }, { 'x-hcps-workspace': 'mine' });
    assert.strictEqual(r.j.route && r.j.route.id, 'r-ang', JSON.stringify(r.j.route && r.j.route.name));
    const admin = await call(w, 'pres', { action: 'route_day', date: '2026-11-05' });
    assert.strictEqual(admin.j.route && admin.j.route.id, 'r-other', 'admin mode keeps company-wide reach');
  });
  /* ---------- Data integrity (Angelo, 2026-10-30) ---------- */
  const visit = (o) => Object.assign({ id: 'vr-' + Math.random().toString(36).slice(2, 8), route_id: 'r-greg', dealer_id: 'd-greg', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell',
    status: 'completed', checkin_at: '2026-10-29T15:00:00Z', completed_at: '2026-10-29T15:40:00Z', approved_at: '2026-10-29T15:45:00Z', fields: { notes: 'Greg met Bryant.' } }, o || {});
  await t('a route holding a visit record is never deleted (409, route and visit kept); archive hides it; restore brings it back', async () => {
    const w = world(); w.db.dealer_visit_reports.push(visit());
    const d = await call(w, 'greg', { action: 'delete_route', id: 'r-greg' });
    assert.strictEqual(d.status, 409); assert.strictEqual(d.j.error, 'route_has_visits'); assert.ok(d.j.can_archive);
    assert.ok(w.db.rep_routes.find(r => r.id === 'r-greg'), 'the route was deleted'); assert.strictEqual(w.db.dealer_visit_reports.length, 1);
    assert.ok((await call(w, 'greg', { action: 'archive_route', id: 'r-greg' })).j.ok);
    assert.ok(w.db.rep_routes.find(r => r.id === 'r-greg').archived_at);
    const list = await call(w, 'greg', { action: 'list_routes' });
    assert.ok(!list.j.routes.some(r => r.id === 'r-greg'), 'an archived route is still listed');
    const all = await call(w, 'greg', { action: 'list_routes', include_archived: true });
    assert.ok(all.j.routes.find(r => r.id === 'r-greg').archived_at);
    const day = await call(w, 'greg', { action: 'route_day', route_id: 'r-greg' });
    assert.strictEqual(day.j.stops[0].visit.status, 'completed', 'an archived route lost its visit history');
    assert.ok((await call(w, 'greg', { action: 'archive_route', id: 'r-greg', archived: false })).j.ok);
    assert.strictEqual(w.db.rep_routes.find(r => r.id === 'r-greg').archived_at, null);
  });
  await t('a route with no visits still deletes; someone else cannot archive it', async () => {
    const w = world();
    assert.strictEqual((await call(w, 'lori', { action: 'archive_route', id: 'r-greg' })).status, 403);
    assert.ok((await call(w, 'greg', { action: 'delete_route', id: 'r-greg' })).j.ok);
    assert.ok(!w.db.rep_routes.find(r => r.id === 'r-greg'));
  });
  await t('a stop with a visit cannot be dropped from the route (409); reordering and adding stops still save', async () => {
    const w = world(); w.db.rep_routes.find(r => r.id === 'r-greg').stops = [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-dir-greg', name: 'Directory' }];
    w.db.dealer_visit_reports.push(visit());
    const drop = await call(w, 'greg', { action: 'save_route', id: 'r-greg', name: 'x', stops: [{ dealer_id: 'd-dir-greg', name: 'Directory' }] });
    assert.strictEqual(drop.status, 409); assert.strictEqual(drop.j.error, 'stop_has_visit'); assert.deepStrictEqual(drop.j.stops, ['Glasgow']);
    assert.strictEqual(w.db.rep_routes.find(r => r.id === 'r-greg').stops.length, 2, 'the stop was dropped');
    const ok1 = await call(w, 'greg', { action: 'save_route', id: 'r-greg', name: 'x', stops: [{ dealer_id: 'd-dir-greg', name: 'Directory' }, { dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-ang', name: 'RMS' }] });
    assert.ok(ok1.j.ok, JSON.stringify(ok1.j));
    const ok2 = await call(w, 'greg', { action: 'save_route', id: 'r-greg', name: 'x', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-ang', name: 'RMS' }] });
    assert.ok(ok2.j.ok, 'dropping a stop WITHOUT a visit must still work');
  });
  await t('reassigned route: the new rep can neither re-check-in, edit, end, approve nor re-email the first rep\'s visit (409, report untouched)', async () => {
    const w = world(); const v0 = visit({ followup_email: { subject: 'Greg wrote this', body: 'b' } }); w.db.dealer_visit_reports.push(v0);
    w.db.rep_routes.find(r => r.id === 'r-greg').assigned_to_email = 'lori@hcps.us';
    const before = JSON.stringify(w.db.dealer_visit_reports);
    for (const body of [{ action: 'visit_checkin' }, { action: 'visit_report_save', status: 'completed', fields: { notes: 'Lori overwrote' } }, { action: 'visit_end' },
      { action: 'visit_analyze', notes: 'x' }, { action: 'visit_approve', summary: { meeting_summary: 'x' } }, { action: 'visit_followup_set', status: 'complete' },
      { action: 'visit_email_save', email: { subject: 'Lori', body: 'x' } }]) {
      const r = await call(w, 'lori', Object.assign({ route_id: 'r-greg', dealer_id: 'd-greg' }, body));
      assert.strictEqual(r.status, 409, body.action + ' → ' + r.status + ' ' + JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'visit_belongs_to_other_rep');
    }
    const byId = await call(w, 'pres', { action: 'visit_approve', dealer_id: 'd-greg', report_id: v0.id, summary: { meeting_summary: 'x' } });
    assert.strictEqual(byId.status, 409, 'management approving by id overwrote the rep');
    assert.strictEqual(JSON.stringify(w.db.dealer_visit_reports), before, 'the first rep\'s report changed');
    const day = await call(w, 'lori', { action: 'route_day', route_id: 'r-greg' });
    assert.ok(day.j.stops[0].visit.by_other && day.j.stops[0].visit.rep_name === 'Greg Campbell', 'the stop does not say whose visit it is');
    const own = await call(w, 'greg', { action: 'visit_followup_set', route_id: 'r-greg', dealer_id: 'd-greg', status: 'complete' });
    assert.ok(own.j.ok, 'the rep who made the visit can still work it: ' + JSON.stringify(own.j));
  });
  await t('one-way route: saving needs an explicit departure time AND zone; round trips do not need a zone', async () => {
    const w = world();
    const noTz = await call(w, 'greg', { action: 'save_route', name: 'One way', round_trip: false, stops: [], depart_time: '08:30' });
    assert.strictEqual(noTz.status, 422); assert.strictEqual(noTz.j.error, 'departure_required');
    const noTime = await call(w, 'greg', { action: 'save_route', name: 'One way', round_trip: false, stops: [], depart_tz: 'America/New_York' });
    assert.strictEqual(noTime.status, 422);
    const bad = await call(w, 'greg', { action: 'save_route', name: 'One way', round_trip: false, stops: [], depart_time: '8am', depart_tz: 'Mars/Base' });
    assert.strictEqual(bad.status, 422);
    const ok = await call(w, 'greg', { action: 'save_route', name: 'One way', round_trip: false, stops: [], depart_time: '07:45', depart_tz: 'America/New_York' });
    assert.ok(ok.j.ok); const row = w.db.rep_routes.find(r => r.id === ok.j.id);
    assert.deepStrictEqual([row.depart_time, row.depart_tz, row.round_trip], ['07:45', 'America/New_York', false]);
    const day = await call(w, 'greg', { action: 'route_day', route_id: ok.j.id });
    assert.deepStrictEqual([day.j.route.depart_time, day.j.route.depart_tz], ['07:45', 'America/New_York']);
    const rt = await call(w, 'greg', { action: 'save_route', name: 'Loop', stops: [], home_base: { lat: 36.5, lng: -86.6, depart_time: '09:00' }, depart_time: '09:00' });
    assert.ok(rt.j.ok); assert.strictEqual(w.db.rep_routes.find(r => r.id === rt.j.id).depart_tz, null);
  });
  await t('before the SQL runs (no new columns): archiving and one-way saves answer 503; round trips and listing still work', async () => {
    const S = standardSeed({ rep_routes: [{ id: 'r-x', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'x', stops: [], updated_at: '2026-10-01T00:00:00Z' }], dealer_visit_reports: [] });
    S.columns = { rep_routes: ['id', 'owner_email', 'rep_name', 'name', 'scheduled_date', 'home_base', 'round_trip', 'stops', 'distance_m', 'duration_s', 'geometry', 'notes', 'created_at', 'updated_at', 'assigned_to_email', 'assigned_to_rep', 'assigned_at', 'assigned_by', 'calendar'] };
    const w = createWorld(S);
    assert.strictEqual((await call(w, 'greg', { action: 'archive_route', id: 'r-x' })).status, 503);
    assert.strictEqual((await call(w, 'greg', { action: 'save_route', name: 'o', round_trip: false, stops: [], depart_time: '08:00', depart_tz: 'America/Chicago' })).status, 503);
    assert.ok((await call(w, 'greg', { action: 'save_route', name: 'loop', stops: [], home_base: { lat: 1, lng: 1 }, depart_time: '08:00' })).j.ok);
    const l = await call(w, 'greg', { action: 'list_routes' }); assert.ok(l.j.ok && l.j.routes.length === 2, JSON.stringify(l.j).slice(0, 200));
  });
  await t('logging a visit (map): the same notes sent twice at once, or saved again, make ONE visit, note, task set and deal', async () => {
    const w = world();
    const body = { action: 'save_visit', dealer_id: 'd-greg', summary: 'Met Bryant', details: { summary: 'Met Bryant', follow_ups: ['Send pricing'], opportunities: ['2 lift chairs'] } };
    const [a, b2] = await Promise.all([call(w, 'greg', body), call(w, 'greg', body)]);
    const again = await call(w, 'greg', body);
    const n = t2 => (w.db[t2] || []).filter(x => x.dealer_id === 'd-greg').length;
    assert.strictEqual(n('dealer_visits'), 1); assert.strictEqual(n('dealer_notes'), 1); assert.strictEqual(n('dealer_tasks'), 1); assert.strictEqual(n('opportunities'), 1);
    assert.ok([a, b2, again].filter(x => x.j.already).length === 2, JSON.stringify([a.j, b2.j, again.j]));
    const diff = await call(w, 'greg', Object.assign({}, body, { summary: 'Met Bryant and Stacey', details: { summary: 'Met Bryant and Stacey' } }));
    assert.ok(diff.j.ok && !diff.j.already); assert.strictEqual(n('dealer_visits'), 2, 'a genuinely new visit was refused');
    const other = await call(w, 'pres', body); assert.ok(!other.j.already, 'another rep logging the same notes is a different visit');
  });
  await t('one-tap log_visit is idempotent too', async () => {
    const w = world();
    await call(w, 'greg', { action: 'log_visit', dealer_id: 'd-greg', notes: 'stopped by' });
    const r = await call(w, 'greg', { action: 'log_visit', dealer_id: 'd-greg', notes: 'stopped by' });
    assert.ok(r.j.already); assert.strictEqual(w.db.dealer_visits.length, 1);
  });
  console.log(`\nsr-routes-api: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();

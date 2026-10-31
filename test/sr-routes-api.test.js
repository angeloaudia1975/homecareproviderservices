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

// An assignment is reviewed first, then confirmed with the review's code (owner decision 2026-10-30).
async function assignR(w, who, id, email) {
  const rv = await call(w, who, { action: 'assign_route', id, assigned_to_email: email, review: true });
  if (!rv.j.review_code) return rv;
  return call(w, who, { action: 'assign_route', id, assigned_to_email: email, review_code: rv.j.review_code });
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
    const body = { action: 'save_route', id: 'r-greg', name: 'x', stops: [], assigned_to_email: 'greg@hcps.us' };
    const rv = await call(w, 'pres', body); assert.strictEqual(rv.status, 409, JSON.stringify(rv.j));
    assert.ok((await call(w, 'pres', Object.assign({}, body, { review_code: rv.j.review_code }))).j.ok);
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
    const ok1 = await call(w, 'greg', { action: 'save_route', id: 'r-greg', name: 'x', stops: [{ dealer_id: 'd-dir-greg', name: 'Directory' }, { dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-greg-branch', name: 'Glasgow North' }] });
    assert.ok(ok1.j.ok, JSON.stringify(ok1.j));
    const ok2 = await call(w, 'greg', { action: 'save_route', id: 'r-greg', name: 'x', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-greg-branch', name: 'Glasgow North' }] });
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
  await t('reassigned mid-day: the rep who already made the visit can still finish, approve and follow it up (not stranded)', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-other');   // the President's route, driven by Greg
    const v0 = visit({ route_id: 'r-other', status: 'in_progress' }); w.db.dealer_visit_reports.push(v0);
    rt.assigned_to_email = 'lori@hcps.us'; rt.assigned_to_rep = 'Lori Hunt';          // handed to Lori after Greg's visit
    for (const body of [{ action: 'visit_report_save', status: 'in_progress', fields: { notes: 'Greg finishing' } }, { action: 'visit_end' },
      { action: 'visit_followup_set', status: 'complete' }]) {
      const r = await call(w, 'greg', Object.assign({ route_id: 'r-other', dealer_id: 'd-greg' }, body));
      assert.ok(r.status < 300, body.action + ' stranded the first rep: ' + r.status + ' ' + JSON.stringify(r.j));
    }
    assert.strictEqual(w.db.dealer_visit_reports.filter(x => x.route_id === 'r-other').length, 1);
    assert.strictEqual(w.db.dealer_visit_reports.find(x => x.route_id === 'r-other').rep_email, 'greg@hcps.us');
    const other = await call(w, 'greg', { action: 'visit_checkin', route_id: 'r-other', dealer_id: 'd-ang' });
    assert.strictEqual(other.status, 403, 'a stop he never visited is still Lori\'s');
  });
  await t('a report_id naming another report never bypasses the route stop\'s owner', async () => {
    const w = world(); const v0 = visit({}); w.db.dealer_visit_reports.push(v0);
    w.db.dealer_visit_reports.push({ id: 'vr-lori-old', dealer_id: 'd-greg', rep_email: 'lori@hcps.us', rep_name: 'Lori Hunt', status: 'completed', fields: {} });
    w.db.rep_routes.find(r => r.id === 'r-greg').assigned_to_email = 'lori@hcps.us';
    const before = JSON.stringify(w.db.dealer_visit_reports.find(x => x.id === v0.id));
    const r = await call(w, 'lori', { action: 'visit_report_save', route_id: 'r-greg', dealer_id: 'd-greg', report_id: 'vr-lori-old', status: 'completed', fields: { notes: 'overwrite' } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.j));
    assert.strictEqual(JSON.stringify(w.db.dealer_visit_reports.find(x => x.id === v0.id)), before);
  });
  await t('two reps starting the same stop at the same moment: one claims it, the other is refused — never an overwrite', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-greg'); rt.assigned_to_email = 'lori@hcps.us';   // owner Greg, driven by Lori: both reach it
    const [a, b] = await Promise.all([call(w, 'greg', { action: 'visit_checkin', route_id: 'r-greg', dealer_id: 'd-greg' }),
                                      call(w, 'lori', { action: 'visit_checkin', route_id: 'r-greg', dealer_id: 'd-greg' })]);
    const rows = w.db.dealer_visit_reports.filter(x => x.route_id === 'r-greg' && x.dealer_id === 'd-greg');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual([a.status < 300, b.status < 300].filter(Boolean).length, 1, JSON.stringify([a, b]));
    const won = a.status < 300 ? 'greg@hcps.us' : 'lori@hcps.us';
    assert.strictEqual([a, b].find(x => x.status >= 300).j.error, 'visit_belongs_to_other_rep');
    assert.strictEqual(rows[0].rep_email, won, 'the stop names the rep who lost the claim');
  });
  await t('an invalid save on an untouched stop claims nothing', async () => {
    const w = world();
    const r = await call(w, 'greg', { action: 'visit_report_save', route_id: 'r-greg', dealer_id: 'd-greg', status: 'bogus' });
    assert.strictEqual(r.status, 400); assert.strictEqual(w.db.dealer_visit_reports.length, 0);
  });
  await t('logging a visit that fails half-way is resumed by the retry — nothing missing, nothing doubled', async () => {
    const S = standardSeed({ rep_routes: [], dealer_visit_reports: [] }); let failing = true;
    S.failWrite = (m, table) => (failing && m === 'POST' && table === 'dealer_tasks') ? 500 : 0;
    const w = createWorld(S);
    const body = { action: 'save_visit', dealer_id: 'd-greg', request_key: 'k-123', summary: 'Met Bryant', details: { summary: 'Met Bryant', follow_ups: ['Send pricing'], opportunities: ['2 lift chairs'] } };
    const first = await call(w, 'greg', body);
    assert.strictEqual(first.status, 502, JSON.stringify(first.j)); assert.strictEqual(first.j.error, 'save_incomplete');
    failing = false;
    const second = await call(w, 'greg', body); assert.ok(second.j.ok && second.j.resumed, JSON.stringify(second.j));
    const third = await call(w, 'greg', body); assert.ok(third.j.already, JSON.stringify(third.j));
    const n = t2 => (w.db[t2] || []).filter(x => x.dealer_id === 'd-greg').length;
    assert.deepStrictEqual([n('dealer_visits'), n('dealer_notes'), n('dealer_tasks'), n('opportunities')], [1, 1, 1, 1]);
  });
  await t('reassigning a route keeps its departure time (start point replaced or cleared)', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-greg');
    rt.home_base = { label: 'Greg home', lat: 36.9, lng: -86.4, depart_time: '07:15' };
    w.db.staff_users.forEach(u => { if (u.email === 'lori@hcps.us') u.home_base = { label: 'Lori home', lat: 36.1, lng: -86.8 }; });
    const r = await assignR(w, 'pres', 'r-greg', 'lori@hcps.us');
    assert.ok(r.j.ok, JSON.stringify(r.j)); assert.strictEqual(rt.home_base.label, 'Lori home'); assert.strictEqual(rt.home_base.depart_time, '07:15');
    w.db.staff_users.forEach(u => { if (u.email === 'greg@hcps.us') u.home_base = null; });
    rt.owner_email = 'angelo@hcps.us';
    const r2 = await assignR(w, 'pres', 'r-greg', 'greg@hcps.us');
    assert.ok(r2.j.ok); assert.strictEqual(rt.home_base, null); assert.strictEqual(rt.depart_time, '07:15', 'the departure went with the start point');
  });
  await t('reassigned after visiting: the first rep still OPENS the route — only his own stops — and the new rep sees them as his', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-other');
    rt.stops = [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-ang', name: 'RMS' }];
    w.db.dealer_visit_reports.push(visit({ route_id: 'r-other', status: 'ended' }));
    rt.assigned_to_email = 'lori@hcps.us';
    const d = await call(w, 'greg', { action: 'route_day', route_id: 'r-other' });
    assert.strictEqual(d.status, 200, JSON.stringify(d.j)); assert.ok(d.j.route.own_visits_only);
    assert.deepStrictEqual(d.j.stops.map(s => s.dealer_id), ['d-greg'], 'shows stops he never visited');
    w.db.dealer_visit_reports.length = 0;
    assert.strictEqual((await call(w, 'greg', { action: 'route_day', route_id: 'r-other' })).status, 403, 'a rep with no visit on it still reaches the route');
  });
  await t('an archived route is never "today\'s route" (field app by date, Command Center, Dealer 360 upcoming)', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-ang'); const date = rt.scheduled_date;
    w.db.rep_routes.forEach(r => { if (r.id !== 'r-ang' && r.scheduled_date === date) r.scheduled_date = '2026-12-01'; });
    assert.strictEqual((await call(w, 'pres', { action: 'route_day', date })).j.route.id, 'r-ang');
    rt.archived_at = '2026-10-30T12:00:00Z'; rt.updated_at = '2026-10-31T00:00:00Z';
    const d = await call(w, 'pres', { action: 'route_day', date });
    assert.strictEqual(d.j.route, null, 'the archived route is still today\'s route');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'netlify', 'functions', 'rep-command-api.js'), 'utf8')
      + require('fs').readFileSync(require('path').join(__dirname, '..', 'netlify', 'functions', 'crm-api.js'), 'utf8');
    assert.strictEqual((src.match(/filter\(r=>!r\.archived_at\)/g) || []).length, 2, 'Command Center / Dealer 360 route reads do not drop archived routes');
  });
  await t('a route planned without a start point but with a departure zone is timed from its first stop on the phone', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-other');
    Object.assign(rt, { home_base: null, round_trip: true, depart_time: '09:00', depart_tz: 'America/Chicago' });
    const d = await call(w, 'greg', { action: 'route_day', route_id: 'r-other' });
    assert.strictEqual(d.j.route.timed_from_first_stop, true);
    rt.depart_tz = null;
    assert.strictEqual((await call(w, 'greg', { action: 'route_day', route_id: 'r-other' })).j.route.timed_from_first_stop, false);
  });
  await t('before the SQL runs, a route whose departure only the new columns could hold is refused, not silently dropped', async () => {
    const S = standardSeed({ rep_routes: [], dealer_visit_reports: [] });
    S.columns = { rep_routes: ['id', 'owner_email', 'rep_name', 'name', 'scheduled_date', 'home_base', 'round_trip', 'stops', 'distance_m', 'duration_s', 'geometry', 'notes', 'created_at', 'updated_at', 'assigned_to_email', 'assigned_to_rep', 'assigned_at', 'assigned_by', 'calendar'] };
    const w = createWorld(S);
    const r = await call(w, 'greg', { action: 'save_route', name: 'no start', stops: [], depart_time: '09:00', depart_tz: 'America/Chicago' });
    assert.strictEqual(r.status, 503, JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'schema_update_needed');
    assert.ok((await call(w, 'greg', { action: 'save_route', name: 'loop', stops: [], home_base: { lat: 1, lng: 1, depart_time: '09:00' }, depart_time: '09:00' })).j.ok, 'a round trip keeps its time in its start point');
  });
  await t('an empty claim (a refused or failed first write) never blocks deleting the route or dropping the stop', async () => {
    const w = world(); w.db.dealer_visit_reports.push({ id: 'vr-claim', route_id: 'r-greg', dealer_id: 'd-greg', rep_email: 'greg@hcps.us', status: 'planned', checkin_at: null, fields: {} });
    const drop = await call(w, 'greg', { action: 'save_route', id: 'r-greg', name: 'x', stops: [] });
    assert.ok(drop.j.ok, JSON.stringify(drop.j));
    const del = await call(w, 'greg', { action: 'delete_route', id: 'r-greg' });
    assert.ok(del.j.ok, JSON.stringify(del.j));
  });
  await t('reassigned after visiting a dealer OUTSIDE his book: the first rep still finishes that visit — and only that visit', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-other');   // Angelo's route, assigned to Greg
    rt.stops = [{ dealer_id: 'd-ang', name: 'RMS' }];
    const ci = await call(w, 'greg', { action: 'visit_checkin', route_id: 'r-other', dealer_id: 'd-ang' });
    assert.ok(ci.j.ok, 'precondition: ride-along check-in ' + JSON.stringify(ci.j));
    rt.assigned_to_email = 'lori@hcps.us'; rt.assigned_to_rep = 'Lori Hunt';
    assert.strictEqual((await call(w, 'greg', { action: 'route_day', route_id: 'r-other' })).status, 200);
    for (const body of [{ action: 'visit_report_save', status: 'in_progress', fields: { notes: 'finishing' } }, { action: 'visit_end' }, { action: 'visit_report_get' }]) {
      const r = await call(w, 'greg', Object.assign({ route_id: 'r-other', dealer_id: 'd-ang' }, body));
      assert.ok(r.status < 300, body.action + ' → ' + r.status + ' ' + JSON.stringify(r.j));
    }
    const other = await call(w, 'greg', { action: 'previsit_draft', route_id: 'r-other', dealer_id: 'd-ang' });
    assert.strictEqual(other.status, 403, 'his old visit opened the rest of the dealer to him');
    const l = await call(w, 'greg', { action: 'list_routes' });
    const listed = l.j.routes.find(r => r.id === 'r-other');
    assert.ok(listed && listed.own_visits_only, 'the reassigned route is gone from his list: ' + JSON.stringify(l.j.routes.map(r => r.id)));
    const lori = await call(w, 'lori', { action: 'list_routes' });
    assert.ok(!lori.j.routes.find(r => r.id === 'r-other').own_visits_only);
  });
  await t('a bare claim nobody acted on for 10 minutes passes to the rep now driving the stop; a fresh one does not', async () => {
    const w = world(); w.db.rep_routes.find(r => r.id === 'r-greg').assigned_to_email = 'lori@hcps.us';
    const claim = { id: 'vr-claim', route_id: 'r-greg', dealer_id: 'd-greg', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', status: 'planned', checkin_at: null, fields: {}, updated_at: new Date().toISOString() };
    w.db.dealer_visit_reports.push(claim);
    assert.strictEqual((await call(w, 'lori', { action: 'visit_checkin', route_id: 'r-greg', dealer_id: 'd-greg' })).status, 409, 'took a claim Greg may be acting on');
    claim.updated_at = new Date(Date.now() - 11 * 60000).toISOString();
    const r = await call(w, 'lori', { action: 'visit_checkin', route_id: 'r-greg', dealer_id: 'd-greg' });
    assert.ok(r.j.ok, JSON.stringify(r.j)); assert.strictEqual(claim.rep_email, 'lori@hcps.us');
    const w2 = world(); w2.db.rep_routes.find(r => r.id === 'r-greg').assigned_to_email = 'lori@hcps.us';
    w2.db.dealer_visit_reports.push(Object.assign({}, claim, { rep_email: 'greg@hcps.us', checkin_at: '2026-10-30T14:00:00Z', status: 'checked_in' }));
    assert.strictEqual((await call(w2, 'lori', { action: 'visit_checkin', route_id: 'r-greg', dealer_id: 'd-greg' })).status, 409, 'took over a real check-in');
  });
  await t('an old report never opens NEW visits at a dealer outside the rep\'s book (report_id without the route stop)', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-other'); rt.stops = [{ dealer_id: 'd-ang', name: 'RMS' }];
    const ci = await call(w, 'greg', { action: 'visit_checkin', route_id: 'r-other', dealer_id: 'd-ang' }); assert.ok(ci.j.ok);
    rt.assigned_to_email = 'lori@hcps.us';
    const rep = w.db.dealer_visit_reports.find(x => x.route_id === 'r-other' && x.dealer_id === 'd-ang');
    const n0 = ['dealer_visit_reports', 'dealer_visits', 'dealer_notes', 'dealer_tasks', 'opportunities'].map(t2 => (w.db[t2] || []).length);
    for (const body of [{ action: 'visit_report_save', status: 'completed', fields: { notes: 'x', follow_ups: ['y'] } }, { action: 'visit_checkin' }, { action: 'visit_end' }]) {
      const r = await call(w, 'greg', Object.assign({ dealer_id: 'd-ang', report_id: rep.id }, body));
      assert.strictEqual(r.status, 403, body.action + ' → ' + r.status + ' ' + JSON.stringify(r.j));
    }
    assert.deepStrictEqual(['dealer_visit_reports', 'dealer_visits', 'dealer_notes', 'dealer_tasks', 'opportunities'].map(t2 => (w.db[t2] || []).length), n0);
  });
  await t('a route-stop visit is no ticket to any OTHER report of his at that dealer (report_id must be that visit)', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-other'); rt.stops = [{ dealer_id: 'd-ang', name: 'RMS' }];
    w.db.dealer_visit_reports.push({ id: 'vr-old', route_id: null, dealer_id: 'd-ang', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', status: 'ended', checkin_at: '2026-09-01T14:00:00Z', ended_at: '2026-09-01T15:00:00Z', fields: { notes: 'old' }, updated_at: '2026-09-01T15:00:00Z' });
    assert.ok((await call(w, 'greg', { action: 'visit_checkin', route_id: 'r-other', dealer_id: 'd-ang' })).j.ok);
    rt.assigned_to_email = 'lori@hcps.us';
    const T = ['dealer_visits', 'dealer_notes', 'dealer_tasks', 'opportunities']; const n0 = T.map(t2 => (w.db[t2] || []).length);
    for (const body of [{ action: 'visit_report_get' }, { action: 'visit_approve', summary: { meeting_summary: 'x' }, tasks: [{ title: 't' }], opportunities: [{ title: 'o' }] },
      { action: 'visit_email_save', email: { subject: 's', body: 'b' } }, { action: 'visit_followup_set', status: 'complete' }, { action: 'visit_analyze', notes: 'x' }]) {
      const r = await call(w, 'greg', Object.assign({ route_id: 'r-other', dealer_id: 'd-ang', report_id: 'vr-old' }, body));
      assert.strictEqual(r.status, 403, body.action + ' → ' + r.status + ' ' + JSON.stringify(r.j));
    }
    assert.deepStrictEqual(T.map(t2 => (w.db[t2] || []).length), n0, 'CRM rows written');
    const own = w.db.dealer_visit_reports.find(x => x.route_id === 'r-other');
    assert.strictEqual((await call(w, 'greg', { action: 'visit_report_get', route_id: 'r-other', dealer_id: 'd-ang', report_id: own.id })).status, 200, 'his own route-stop report by id');
  });
  await t('a bare claim is not "his visit": it does not keep a reassigned route open to him', async () => {
    const w = world(); const rt = w.db.rep_routes.find(r => r.id === 'r-other'); rt.stops = [{ dealer_id: 'd-ang', name: 'RMS' }];
    w.db.dealer_visit_reports.push({ id: 'vr-b', route_id: 'r-other', dealer_id: 'd-ang', rep_email: 'greg@hcps.us', status: 'planned', checkin_at: null, fields: {}, updated_at: new Date().toISOString() });
    rt.assigned_to_email = 'lori@hcps.us';
    assert.strictEqual((await call(w, 'greg', { action: 'route_day', route_id: 'r-other' })).status, 403);
    assert.strictEqual((await call(w, 'greg', { action: 'visit_checkin', route_id: 'r-other', dealer_id: 'd-ang' })).status, 403);
    assert.ok(!(await call(w, 'greg', { action: 'list_routes' })).j.routes.some(r => r.id === 'r-other'));
  });
  console.log(`\nsr-routes-api: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();

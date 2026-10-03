/* Phase 2A — unplanned visits ("Start visit" on Dealer 360, no route needed).

   The phone makes a visit_key when Start is tapped and sends it on every later call for that visit,
   queued or not; the server finds the visit by that key. So a replay that arrives after the visit was
   approved lands on THAT visit and never opens a second one; a second Start while a visit is still
   unfinished resumes it (approved decision 2026-10-03); a new visit after approval is a new row.
   Behind the adhoc_visit switch (app_settings phase2_flags — missing or not exactly true = off).
   Amendment 1: in My Sales Workspace the President's visit writes reach only HIS book
   (dealers.rep_email first); in Admin mode he keeps company-wide reach. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), IN3 = dayStr(3);
const WS = { 'x-hcps-workspace': 'mine' };
const FLAGS_ON = { key: 'phase2_flags', value: { adhoc_visit: true, morning_brief: false } };

const AI_OUT = {
  meeting_summary: 'Met Rita. Reviewed lift chairs; she wants pricing on 2 PR519 chairs.',
  products_discussed: ['PR519 lift chair'], dealer_interests: ['Lift chairs'], dealer_concerns: [], objections: [], competitors: [],
  pricing_requests: ['PR519 pricing'], samples_requested: [], literature_requested: [], training_requested: [],
  attendees: [{ name: 'Rita Owner', title: 'Owner' }],
  rep_commitments: [{ text: 'Send PR519 pricing', due_date: IN3 }], dealer_commitments: [],
  follow_ups: [{ title: 'Send PR519 pricing', due_date: IN3, priority: 'high', from: 'rep_commitment' }],
  opportunities: [], suggested_next_action: { text: 'Send pricing', due_date: IN3 }, interest_slugs: [], poor_fit_slugs: [] };

function seed(opts) {
  opts = opts || {};
  const S = standardSeed({
    dealers: [{ id: 'd-ang-mail', business_name: 'Clarksville Home Medical', rep_email: 'angelo@hcps.us', rep_name: null, parent_id: null, state: 'TN' }],
    rep_routes: [
      { id: 'r-a', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'Angelo today', scheduled_date: TODAY, stops: [{ dealer_id: 'd-ang', name: 'RMS' }] },
      // planned BY Angelo FOR Greg: Greg's day — not a way into Greg's dealer from the workspace
      { id: 'r-g', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', rep_name: 'Angelo Audia', name: 'Planned for Greg', scheduled_date: TODAY, stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }] } ],
    dealer_visit_reports: opts.reports || [],
    dealer_contacts: [], dealer_tasks: [], opportunities: [], dealer_visits: [], dealer_visit_participants: [], dealer_notes: [], dealer_activity: [],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }].concat(opts.flags === undefined ? [FLAGS_ON] : (opts.flags ? [opts.flags] : [])),
  });
  S.unique = { dealer_tasks: [['origin_type', 'origin_id', 'origin_key']], opportunities: [['origin_type', 'origin_id', 'origin_key']],
    dealer_visits: [['visit_report_id']], dealer_visit_participants: [['visit_report_id', 'name_key']], dealer_contacts: [['dealer_id', 'email']],
    dealer_visit_reports: [['route_id', 'dealer_id'], ['visit_key']] };
  // supabase/phase2_adhoc_visits.sql: one OPEN unplanned visit per rep per dealer.
  S.uniquePartial = { dealer_visit_reports: [{ cols: ['dealer_id', 'rep_email'], lower: ['rep_email'], where: r => r.route_id == null && r.completed_at == null }] };
  if (opts.columns) S.columns = opts.columns;
  S.ai = () => AI_OUT;
  return S;
}
const W = opts => createWorld(seed(opts));
const R = (w, body, tok, ws) => call(load('routes-api.js', w, { ANTHROPIC_API_KEY: 'k' }), body, { token: tok || 'greg', headers: ws ? WS : {} });
const CRM = (w, body, tok, ws) => call(load('crm-api.js', w), body, { token: tok || 'greg', headers: ws ? WS : {} });
const offRoute = (w, did) => w.db.dealer_visit_reports.filter(r => r.route_id == null && (!did || r.dealer_id === did));
const K1 = 'vk_test_0001', K2 = 'vk_test_0002';
const V = (did, key) => Object.assign({ dealer_id: did }, key ? { visit_key: key } : {});

async function fullVisit(w, did, key, tok, ws) {
  const c = await R(w, Object.assign({ action: 'visit_checkin' }, V(did, key)), tok, ws);
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const e = await R(w, Object.assign({ action: 'visit_end' }, V(did, key)), tok, ws);
  assert.strictEqual(e.status, 200, JSON.stringify(e.body));
  const a = await R(w, Object.assign({ action: 'visit_analyze', notes: 'Met Rita about lift chairs. Send PR519 pricing.', local_date: TODAY }, V(did, key)), tok, ws);
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  const sug = a.body.suggestion;
  // Live-test shape: follow-up tasks only — no deals, and attendees are NOT added as contacts.
  const ap = await R(w, Object.assign({ action: 'visit_approve', summary: sug,
    participants: (sug.attendees || []).map(x => ({ key: x.key, name: x.name, title: x.title, add_as_contact: false, source: 'ai' })),
    tasks: (sug.follow_ups || []).map(f => ({ key: f.key, title: f.title, due_date: f.due_date, priority: f.priority, kind: 'followup', ai: true })),
    opportunities: [] }, V(did, key)), tok, ws);
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
  return { checkin: c.body, end: e.body, sug, approve: ap.body, body: ap };
}

(async () => {
  /* ---- the switch ---- */
  await t('Switch off (no row / not exactly true): dealer mode answers flag_off, Dealer 360 gets adhoc_visit=false; route days unchanged', async () => {
    for (const flags of [null, { key: 'phase2_flags', value: { adhoc_visit: 'true' } }, { key: 'phase2_flags', value: [true] }]) {
      const w = W({ flags });
      const r = await R(w, { action: 'route_day', dealer_id: 'd-greg' });
      assert.strictEqual(r.status, 403, JSON.stringify(r.body)); assert.strictEqual(r.body.code, 'flag_off');
      const v = await CRM(w, { action: 'visits', dealer_id: 'd-greg' });
      assert.strictEqual(v.status, 200); assert.strictEqual(v.body.adhoc_visit, false); assert.strictEqual(v.body.my_open_visit, null);
      const rd = await R(w, { action: 'route_day', route_id: 'r-g' });
      assert.strictEqual(rd.status, 200); assert.strictEqual(rd.body.route.id, 'r-g'); assert.strictEqual(rd.body.stops.length, 1);
    }
    const w = W(); const v = await CRM(w, { action: 'visits', dealer_id: 'd-greg' });
    assert.strictEqual(v.body.adhoc_visit, true);
  });

  /* ---- start, key, replay ---- */
  await t('Start with a key: one off-route row carrying the key (origin adhoc); response gives report_id + visit_key', async () => {
    const w = W();
    const day = await R(w, { action: 'route_day', dealer_id: 'd-greg' });
    assert.strictEqual(day.status, 200, JSON.stringify(day.body));
    assert.strictEqual(day.body.route.adhoc, true); assert.strictEqual(day.body.route.id, null);
    assert.strictEqual(day.body.stops.length, 1); assert.strictEqual(day.body.stops[0].dealer_id, 'd-greg'); assert.strictEqual(day.body.stops[0].visit, null);
    assert.strictEqual(day.body.stops[0].name, 'Glasgow Prescription Center');
    const c = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(c.status, 200); assert.strictEqual(c.body.visit_key, K1); assert.ok(c.body.report_id);
    const rows = offRoute(w, 'd-greg');
    assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].visit_key, K1); assert.strictEqual(rows[0].origin, 'adhoc');
    assert.strictEqual(rows[0].rep_email, 'greg@hcps.us'); assert.strictEqual(rows[0].id, c.body.report_id);
    const day2 = await R(w, { action: 'route_day', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(day2.body.stops[0].visit.id, c.body.report_id); assert.strictEqual(day2.body.stops[0].visit.visit_key, K1);
    // without the key (another phone): this rep's open visit
    const day3 = await R(w, { action: 'route_day', dealer_id: 'd-greg' });
    assert.strictEqual(day3.body.stops[0].visit.id, c.body.report_id);
  });

  await t('Replays after approval (Start, End, Save, Approve with the same key) change nothing — no second visit, no extra tasks', async () => {
    const w = W();
    const v = await fullVisit(w, 'd-greg', K1);
    const id = v.checkin.report_id;
    const snap = JSON.stringify(w.db.dealer_visit_reports); const nT = w.db.dealer_tasks.length;
    assert.ok(nT >= 1); assert.strictEqual(w.db.opportunities.length, 0); assert.strictEqual(w.db.dealer_contacts.length, 0);
    const c = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(c.status, 200); assert.strictEqual(c.body.already, true); assert.strictEqual(c.body.report_id, id); assert.strictEqual(c.body.status, 'completed');
    const e = await R(w, { action: 'visit_end', dealer_id: 'd-greg', visit_key: K1, at: new Date().toISOString() });
    assert.strictEqual(e.status, 200); assert.strictEqual(e.body.already, true); assert.strictEqual(e.body.report_id, id);
    const ap = await R(w, { action: 'visit_approve', dealer_id: 'd-greg', visit_key: K1, summary: v.sug,
      tasks: (v.sug.follow_ups || []).map(f => ({ key: f.key, title: f.title, due_date: f.due_date, kind: 'followup' })), opportunities: [] });
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    const sv = await R(w, { action: 'visit_report_save', dealer_id: 'd-greg', visit_key: K1, status: 'in_progress', fields: { notes: 'late replay' } });
    assert.strictEqual(sv.status, 200, JSON.stringify(sv.body));
    assert.strictEqual(offRoute(w, 'd-greg').length, 1, 'still one visit');
    assert.strictEqual(w.db.dealer_tasks.length, nT, 'no extra tasks');
    const row = offRoute(w, 'd-greg')[0];
    assert.ok(row.completed_at); assert.strictEqual(row.status, 'completed');
    void snap;
  });

  await t('A new visit after approval is a new row with its own key; the approved one is untouched', async () => {
    const w = W();
    const v = await fullVisit(w, 'd-greg', K1);
    const before = JSON.stringify(offRoute(w, 'd-greg')[0]);
    const day = await R(w, { action: 'route_day', dealer_id: 'd-greg', visit_key: K1 });
    assert.ok(day.body.stops[0].visit.approved_at, 'the phone sees the finished visit (and offers "Start another visit")');
    const c = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K2 });
    assert.strictEqual(c.status, 200); assert.notStrictEqual(c.body.report_id, v.checkin.report_id); assert.strictEqual(c.body.visit_key, K2);
    const rows = offRoute(w, 'd-greg'); assert.strictEqual(rows.length, 2);
    assert.strictEqual(JSON.stringify(rows.find(r => r.visit_key === K1)), before);
  });

  await t('Late replays of an approved visit never land on the NEXT visit (the key keeps them apart)', async () => {
    const w = W();
    const v1 = await fullVisit(w, 'd-greg', K1);
    const c2 = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K2 });
    await R(w, { action: 'visit_report_save', dealer_id: 'd-greg', visit_key: K2, status: 'in_progress', fields: { notes: 'second visit notes' } });
    const v2before = JSON.stringify(w.db.dealer_visit_reports.find(r => r.id === c2.body.report_id));
    // the first visit's queued requests arrive now
    const sv = await R(w, { action: 'visit_report_save', dealer_id: 'd-greg', visit_key: K1, status: 'in_progress', fields: { notes: 'first visit — late copy' } });
    assert.strictEqual(sv.status, 200);
    const e = await R(w, { action: 'visit_end', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(e.body.report_id, v1.checkin.report_id); assert.strictEqual(e.body.already, true);
    const an = await R(w, { action: 'visit_analyze', dealer_id: 'd-greg', visit_key: K1, notes: 'first visit notes, resent', local_date: TODAY });
    assert.strictEqual(an.status, 200, JSON.stringify(an.body));
    const ap = await R(w, { action: 'visit_approve', dealer_id: 'd-greg', visit_key: K1, summary: Object.assign({}, v1.sug, { meeting_summary: v1.sug.meeting_summary + ' ' }), opportunities: [],
      tasks: (v1.sug.follow_ups || []).map(f => ({ key: f.key, title: f.title, due_date: f.due_date, kind: 'followup' })) });
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    const v2 = w.db.dealer_visit_reports.find(r => r.id === c2.body.report_id);
    assert.strictEqual(JSON.stringify(v2), v2before, 'the second visit is untouched');
    assert.ok(!v2.approved_at && !v2.ended_at);
    assert.strictEqual(offRoute(w, 'd-greg').length, 2);
  });

  await t('End racing a Start (End lost the insert): it ends the visit that won, from that visit\'s own arrival', async () => {
    const arr = new Date(Date.now() - 15 * 60e3).toISOString();
    const w = W({ reports: [{ id: 'vr-won', route_id: null, dealer_id: 'd-greg', rep_email: 'greg@hcps.us', checkin_at: arr, status: 'checked_in', completed_at: null, visit_key: K1 }] });
    const real = w.fetch; let hidden = 0;
    w.fetch = (u, o) => { if (!hidden && (!o || !o.method || o.method === 'GET') && /dealer_visit_reports\?route_id=is\.null&dealer_id=eq\.d-greg&rep_email=eq\.greg%40hcps\.us&completed_at=is\.null/.test(String(u))) { hidden++; u = String(u).replace('dealer_id=eq.d-greg', 'dealer_id=eq.none'); } return real(u, o); };
    const e = await R(w, { action: 'visit_end', dealer_id: 'd-greg', visit_key: K2, started_at: new Date(Date.now() - 60e3).toISOString() });
    assert.strictEqual(hidden, 1);
    assert.strictEqual(e.status, 200, JSON.stringify(e.body)); assert.strictEqual(e.body.report_id, 'vr-won');
    const row = w.db.dealer_visit_reports.find(r => r.id === 'vr-won');
    assert.ok(row.ended_at); assert.strictEqual(row.checkin_at, arr); assert.ok(row.duration_min >= 14, String(row.duration_min));
    assert.strictEqual(offRoute(w, 'd-greg').length, 1);
  });

  await t('Approve racing a Start (Approve lost the insert): it approves the visit that won — no second row', async () => {
    const w = W({ reports: [{ id: 'vr-won', route_id: null, dealer_id: 'd-greg', rep_email: 'greg@hcps.us', checkin_at: new Date().toISOString(), status: 'checked_in', completed_at: null, visit_key: K1 }] });
    const real = w.fetch; let hidden = 0;
    w.fetch = (u, o) => { if (!hidden && (!o || !o.method || o.method === 'GET') && /dealer_visit_reports\?route_id=is\.null&dealer_id=eq\.d-greg&rep_email=eq\.greg%40hcps\.us&completed_at=is\.null/.test(String(u))) { hidden++; u = String(u).replace('dealer_id=eq.d-greg', 'dealer_id=eq.none'); } return real(u, o); };
    const ap = await R(w, { action: 'visit_approve', dealer_id: 'd-greg', visit_key: K2, summary: { meeting_summary: 'Quick stop; dropped off catalogs.' }, tasks: [], opportunities: [] });
    assert.strictEqual(hidden, 1);
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    assert.strictEqual(offRoute(w, 'd-greg').length, 1);
    assert.ok(w.db.dealer_visit_reports.find(r => r.id === 'vr-won').approved_at);
  });

  await t('Second Start while a visit is unfinished resumes it (different key, or no key) — never two open visits', async () => {
    const w = W();
    const c1 = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K1 });
    const c2 = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K2 });
    assert.strictEqual(c2.status, 200); assert.strictEqual(c2.body.resumed, true);
    assert.strictEqual(c2.body.report_id, c1.body.report_id); assert.strictEqual(c2.body.visit_key, K1, 'the phone adopts the open visit\'s key');
    const c3 = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg' });
    assert.strictEqual(c3.status, 200); assert.strictEqual(c3.body.already, true);
    // ended but not approved is still unfinished
    await R(w, { action: 'visit_end', dealer_id: 'd-greg', visit_key: K1 });
    const c4 = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: 'vk_other_9' });
    assert.strictEqual(c4.body.resumed, true); assert.strictEqual(c4.body.report_id, c1.body.report_id);
    assert.strictEqual(offRoute(w, 'd-greg').length, 1);
    // Another person's open visit at the same dealer is theirs: Lori starts her own.
    const l = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: 'vk_lori_01' }, 'lori');
    assert.strictEqual(l.status, 200); assert.notStrictEqual(l.body.report_id, c1.body.report_id);
    assert.strictEqual(offRoute(w, 'd-greg').length, 2);
  });

  await t('An open Phase 1 visit without a key adopts the phone\'s key', async () => {
    const w = W({ reports: [{ id: 'vr-old', route_id: null, dealer_id: 'd-greg', rep_email: 'greg@hcps.us', checkin_at: new Date(Date.now() - 600e3).toISOString(), status: 'checked_in', completed_at: null }] });
    const c = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(c.body.report_id, 'vr-old'); assert.strictEqual(c.body.resumed, true); assert.strictEqual(c.body.visit_key, K1);
    assert.strictEqual(w.db.dealer_visit_reports.find(r => r.id === 'vr-old').visit_key, K1);
    const e = await R(w, { action: 'visit_end', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(e.body.report_id, 'vr-old');
  });

  await t('End adopts the phone\'s key onto an open keyless visit, so a later End replay finds it after approval', async () => {
    const w = W({ reports: [{ id: 'vr-old', route_id: null, dealer_id: 'd-greg', rep_email: 'greg@hcps.us', checkin_at: new Date(Date.now() - 600e3).toISOString(), status: 'checked_in', completed_at: null }] });
    const e = await R(w, { action: 'visit_end', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(e.body.report_id, 'vr-old');
    assert.strictEqual(w.db.dealer_visit_reports.find(r => r.id === 'vr-old').visit_key, K1);
    const ap = await R(w, { action: 'visit_approve', dealer_id: 'd-greg', visit_key: K1, summary: { meeting_summary: 'Dropped off catalogs.' }, tasks: [], opportunities: [] });
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    const again = await R(w, { action: 'visit_end', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(again.body.report_id, 'vr-old'); assert.strictEqual(again.body.already, true);
    assert.strictEqual(offRoute(w, 'd-greg').length, 1);
  });

  await t('Two Starts at the same moment: the one that lost the insert resumes the winner (partial unique index)', async () => {
    const w = W({ reports: [{ id: 'vr-won', route_id: null, dealer_id: 'd-greg', rep_email: 'greg@hcps.us', checkin_at: new Date().toISOString(), status: 'checked_in', completed_at: null, visit_key: K1 }] });
    // The losing request read before the winner's row existed: hide it from its FIRST open-visit read.
    const real = w.fetch; let hidden = 0;
    w.fetch = (u, o) => { if (!hidden && (!o || !o.method || o.method === 'GET') && /dealer_visit_reports\?route_id=is\.null&dealer_id=eq\.d-greg&rep_email=eq\.greg%40hcps\.us&completed_at=is\.null/.test(String(u))) { hidden++; u = String(u).replace('dealer_id=eq.d-greg', 'dealer_id=eq.none'); } return real(u, o); };
    const c = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K2 });
    assert.strictEqual(hidden, 1, 'race simulated');
    assert.strictEqual(c.status, 200, JSON.stringify(c.body)); assert.strictEqual(c.body.resumed, true);
    assert.strictEqual(c.body.report_id, 'vr-won'); assert.strictEqual(c.body.visit_key, K1);
    assert.strictEqual(offRoute(w, 'd-greg').length, 1);
  });

  await t('Offline order: End arrives before Start — one ended visit with the key; the late Start is that visit', async () => {
    const w = W();
    const st = new Date(Date.now() - 20 * 60e3).toISOString();
    const e = await R(w, { action: 'visit_end', dealer_id: 'd-greg', visit_key: K1, started_at: st, at: new Date().toISOString() });
    assert.strictEqual(e.status, 200); assert.ok(e.body.report_id);
    const c = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K1, at: st });
    assert.strictEqual(c.body.already, true); assert.strictEqual(c.body.report_id, e.body.report_id);
    const rows = offRoute(w, 'd-greg'); assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].visit_key, K1); assert.ok(rows[0].ended_at);
  });

  await t('A malformed key is ignored (Phase 1 rule applies) — never stored', async () => {
    const w = W();
    for (const bad of ['x', 'has space key', 'a'.repeat(65), '<script>']) {
      const c = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: bad });
      assert.strictEqual(c.status, 200);
    }
    const rows = offRoute(w, 'd-greg'); assert.strictEqual(rows.length, 1); assert.ok(!rows[0].visit_key);
  });

  /* ---- reading a visit ---- */
  await t('visit_report_get off a route: by report_id (scoped), by key, else ONLY the caller\'s own visit', async () => {
    const w = W();
    const g = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K1 });
    await R(w, { action: 'visit_report_save', dealer_id: 'd-greg', visit_key: K1, status: 'in_progress', fields: { notes: 'greg notes' } });
    const byKey = await R(w, { action: 'visit_report_get', dealer_id: 'd-greg', visit_key: K1 });
    assert.strictEqual(byKey.body.report.id, g.body.report_id); assert.strictEqual(byKey.body.report.fields.notes, 'greg notes');
    const byId = await R(w, { action: 'visit_report_get', dealer_id: 'd-greg', report_id: g.body.report_id });
    assert.strictEqual(byId.body.report.id, g.body.report_id);
    // Lori (relations) has no visit here: the no-key read is HER own visit, not Greg's.
    const lo = await R(w, { action: 'visit_report_get', dealer_id: 'd-greg' }, 'lori');
    assert.strictEqual(lo.status, 200); assert.strictEqual(lo.body.report, null);
    // …and Greg's key does not reach Greg's visit for her either (keys are per rep).
    const lk = await R(w, { action: 'visit_report_get', dealer_id: 'd-greg', visit_key: K1 }, 'lori');
    assert.strictEqual(lk.body.report, null);
    // The workspace President is a rep: Greg's visit by id is refused.
    const ws = await R(w, { action: 'visit_report_get', dealer_id: 'd-greg', report_id: g.body.report_id }, 'pres', true);
    assert.ok([403, 404].includes(ws.status), JSON.stringify(ws.body));
    // A report id must belong to the dealer asked about.
    const wrong = await R(w, { action: 'visit_report_get', dealer_id: 'd-ang', report_id: g.body.report_id }, 'pres');
    assert.ok([403, 404].includes(wrong.status), JSON.stringify(wrong.body));
  });

  /* ---- who may start a visit where ---- */
  await t('Reach: a rep only in his book; Relations anywhere; unknown dealer refused', async () => {
    const w = W();
    const no = await R(w, { action: 'route_day', dealer_id: 'd-ang' });
    assert.strictEqual(no.status, 403, JSON.stringify(no.body));
    const noc = await R(w, { action: 'visit_checkin', dealer_id: 'd-ang', visit_key: K1 });
    assert.strictEqual(noc.status, 403); assert.strictEqual(offRoute(w).length, 0);
    const branch = await R(w, { action: 'route_day', dealer_id: 'd-greg-branch' });
    assert.strictEqual(branch.status, 200, 'a branch of his dealer is his');
    const lori = await R(w, { action: 'route_day', dealer_id: 'd-ang' }, 'lori');
    assert.strictEqual(lori.status, 200);
    const lc = await R(w, { action: 'visit_checkin', dealer_id: 'd-none', visit_key: 'vk_lori_02' }, 'lori');
    assert.strictEqual(lc.status, 200);
    const ghost = await R(w, { action: 'route_day', dealer_id: 'd-ghost' }, 'pres');
    assert.strictEqual(ghost.status, 404, JSON.stringify(ghost.body));
    const gc = await R(w, { action: 'visit_checkin', dealer_id: 'd-ghost', visit_key: K2 }, 'pres');
    assert.ok([403, 404].includes(gc.status)); assert.ok(!w.db.dealer_visit_reports.some(r => r.dealer_id === 'd-ghost'));
    const stranger = await R(w, { action: 'route_day', dealer_id: 'd-greg' }, 'stranger');
    assert.strictEqual(stranger.status, 401);
  });

  await t('Amendment 1: in My Sales Workspace the President starts visits only in his own book; Admin mode keeps company-wide reach', async () => {
    const w = W();
    // his book: by rep_email (authoritative) and by rep_name
    for (const did of ['d-ang-mail', 'd-ang']) {
      const d = await R(w, { action: 'route_day', dealer_id: did }, 'pres', true);
      assert.strictEqual(d.status, 200, did + ' ' + JSON.stringify(d.body));
    }
    // Greg's dealer — even though Angelo planned a route there FOR Greg — and House accounts
    for (const did of ['d-greg', 'd-none']) {
      const d = await R(w, { action: 'route_day', dealer_id: did }, 'pres', true);
      assert.strictEqual(d.status, 403, did + ' ' + JSON.stringify(d.body));
      const c = await R(w, { action: 'visit_checkin', dealer_id: did, visit_key: K1 }, 'pres', true);
      assert.strictEqual(c.status, 403, did);
      const e = await R(w, { action: 'visit_end', dealer_id: did, visit_key: K1 }, 'pres', true);
      assert.strictEqual(e.status, 403, did);
      const a = await R(w, { action: 'visit_approve', dealer_id: did, visit_key: K1, summary: { meeting_summary: 'x' } }, 'pres', true);
      assert.strictEqual(a.status, 403, did);
      const v = await CRM(w, { action: 'visits', dealer_id: did }, 'pres', true);
      assert.strictEqual(v.status, 403, did);
    }
    assert.strictEqual(offRoute(w).length, 0, 'nothing written');
    // Admin mode (no workspace header): company-wide
    const d = await R(w, { action: 'route_day', dealer_id: 'd-greg' }, 'pres');
    assert.strictEqual(d.status, 200);
    const c = await R(w, { action: 'visit_checkin', dealer_id: 'd-none', visit_key: K1 }, 'pres');
    assert.strictEqual(c.status, 200);
    // his own route still works from the workspace
    const rc = await R(w, { action: 'visit_checkin', route_id: 'r-a', dealer_id: 'd-ang' }, 'pres', true);
    assert.strictEqual(rc.status, 200, JSON.stringify(rc.body));
    // the workspace header means nothing for a rep
    const g = await R(w, { action: 'route_day', dealer_id: 'd-ang' }, 'greg', true);
    assert.strictEqual(g.status, 403);
  });

  await t('Amendment 1 across the visit tools: follow-up email draft, dictation and the email timeline are his book only in the workspace', async () => {
    const w = W();
    const AE = (did, ws) => call(load('ai-email-api.js', w), { action: 'draft', dealer_id: did, template: 'follow_up' }, { token: 'pres', headers: ws ? WS : {} });
    const VV = (did, ws) => call(load('visit-voice-api.js', w), { dealer_id: did, text: 'Met Rita' }, { token: 'pres', headers: ws ? WS : {} });
    const ES = (body, ws) => call(load('email-sync-api.js', w), body, { token: 'pres', headers: ws ? WS : {} });
    for (const did of ['d-greg', 'd-none']) {
      assert.strictEqual((await AE(did, true)).status, 403, 'draft ' + did);
      assert.strictEqual((await VV(did, true)).status, 403, 'voice ' + did);
      assert.strictEqual((await ES({ action: 'dealer', dealer_id: did }, true)).status, 403, 'timeline ' + did);
      assert.strictEqual((await ES({ action: 'send', dealer_id: did, to: 'x@y.test', subject: 's', body: 'b' }, true)).status, 403, 'send ' + did);
      // Admin mode: company-wide (whatever happens next, it is not a refusal)
      assert.notStrictEqual((await AE(did, false)).status, 403, 'draft admin ' + did);
      assert.notStrictEqual((await VV(did, false)).status, 403, 'voice admin ' + did);
      assert.strictEqual((await ES({ action: 'dealer', dealer_id: did }, false)).status, 200, 'timeline admin ' + did);
    }
    assert.notStrictEqual((await AE('d-ang', true)).status, 403, 'his own dealer in the workspace');
    assert.strictEqual((await ES({ action: 'dealer', dealer_id: 'd-ang-mail' }, true)).status, 200);
    assert.ok(!w.outbound.some(o => o.kind === 'graph' && o.method === 'POST'), 'nothing sent');
  });

  /* ---- Dealer 360 ---- */
  await t('Dealer 360 visits: my_open_visit is the caller\'s OWN unfinished unplanned visit; mine marks own rows', async () => {
    const w = W();
    const g = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg', visit_key: K1 });
    const gv = await CRM(w, { action: 'visits', dealer_id: 'd-greg' });
    assert.strictEqual(gv.body.my_open_visit, g.body.report_id);
    assert.strictEqual(gv.body.active.length, 1); assert.strictEqual(gv.body.active[0].mine, true); assert.strictEqual(gv.body.active[0].route_id, null);
    const lv = await CRM(w, { action: 'visits', dealer_id: 'd-greg' }, 'lori');
    assert.strictEqual(lv.body.my_open_visit, null, 'Greg\'s visit is not Lori\'s to resume'); assert.strictEqual(lv.body.active[0].mine, false);
    const pv = await CRM(w, { action: 'visits', dealer_id: 'd-greg' }, 'pres');
    assert.strictEqual(pv.body.my_open_visit, null);
    await fullVisitFinish(w, 'd-greg', K1);
    const after = await CRM(w, { action: 'visits', dealer_id: 'd-greg' });
    assert.strictEqual(after.body.my_open_visit, null); assert.strictEqual(after.body.past.length, 1);
  });

  /* ---- before the migration ---- */
  await t('Before the migration (no visit_key column, no switch): route visits and keyless visits work exactly as in Phase 1', async () => {
    const cols = ['id', 'route_id', 'dealer_id', 'rep_email', 'rep_name', 'scheduled_date', 'checkin_at', 'completed_at', 'status', 'fields', 'transcript', 'structured',
      'created_at', 'updated_at', 'visit_note_id', 'ended_at', 'duration_min', 'ai_suggestion', 'ai_suggested_at', 'ai_input_hash', 'summary', 'approved_at', 'approved_by',
      'followup_status', 'followup_due', 'followup_completed_at', 'followup_manual', 'followup_email', 'origin'];
    const w = W({ flags: null, columns: { dealer_visit_reports: cols } });
    const off = await R(w, { action: 'route_day', dealer_id: 'd-greg' });
    assert.strictEqual(off.status, 403); assert.strictEqual(off.body.code, 'flag_off');
    const rd = await R(w, { action: 'route_day', route_id: 'r-g' });
    assert.strictEqual(rd.status, 200, JSON.stringify(rd.body)); assert.strictEqual(rd.body.stops.length, 1);
    const c = await R(w, { action: 'visit_checkin', route_id: 'r-g', dealer_id: 'd-greg' });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const e = await R(w, { action: 'visit_end', route_id: 'r-g', dealer_id: 'd-greg' });
    assert.strictEqual(e.status, 200, JSON.stringify(e.body));
    const k = await R(w, { action: 'visit_checkin', dealer_id: 'd-greg-branch' });
    assert.strictEqual(k.status, 200, JSON.stringify(k.body));
    const kg = await R(w, { action: 'visit_report_get', dealer_id: 'd-greg-branch' });
    assert.strictEqual(kg.status, 200); assert.ok(kg.body.report);
    const v = await CRM(w, { action: 'visits', dealer_id: 'd-greg' });
    assert.strictEqual(v.status, 200); assert.strictEqual(v.body.adhoc_visit, false);
  });

  done('Phase 2A unplanned visits');
})();

async function fullVisitFinish(w, did, key) {
  await R(w, { action: 'visit_end', dealer_id: did, visit_key: key });
  const a = await R(w, { action: 'visit_analyze', notes: 'Met Rita. Send PR519 pricing.', local_date: TODAY, dealer_id: did, visit_key: key });
  const sug = a.body.suggestion;
  const ap = await R(w, { action: 'visit_approve', dealer_id: did, visit_key: key, summary: sug, opportunities: [],
    tasks: (sug.follow_ups || []).map(f => ({ key: f.key, title: f.title, due_date: f.due_date, kind: 'followup' })) });
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
}

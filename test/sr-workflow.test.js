/* Scheduled Routes — the complete workflow, end to end, through the REAL handlers (fake database, fake Outlook, synthetic
   *.test data; nothing reaches a real dealer):
     President plans a route for Greg (his own dealer + a ride-along stop) with a departure → assigns it →
     Greg opens his day (departure + zone come down) → arrival times from the shared RouteClock →
     heads-up draft with the ETA (and an after-hours ETA left out) → Outlook heads-up to the dealer's contact →
     visit: check-in → notes → end → approve (note, timeline, task, deal, attendee) →
     the President reassigns the route to Lori → Greg still drafts + sends that visit's follow-up, to that dealer's people only →
     Lori can't take over or rewrite Greg's visit → every CRM record of the visit is intact and still Greg's.
     node test/sr-workflow.test.js */
const assert = require('assert');
const path = require('path');
const { createWorld, load, standardSeed } = require('./phase0-mock');
const RouteClock = require(path.join(__dirname, '..', 'src', 'admin', 'route-clock.js'));
let pass = 0, fail = 0; const STEPS = [];
async function step(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); throw e; } }

const S = standardSeed({
  dealer_contacts: [{ id: 'c-ang', dealer_id: 'd-ang', name: 'Rita Example', email: 'rita@rms.test', title: 'Owner' },
                    { id: 'c-greg', dealer_id: 'd-greg', name: 'Bryant Sample', email: 'bryant@glasgow.test', title: 'Buyer' }],
  rep_routes: [], dealer_visit_reports: [], dealer_visit_participants: [], dealer_visits: [], dealer_notes: [], dealer_activity: [],
  dealer_tasks: [], opportunities: [], email_optout: [], intent_events: [],
  app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: {} }],
});
S.ai = () => ({ subject: 'Thanks for meeting', body: 'Hi Rita,\n\nThanks for walking through the lift chairs with me.' });
const w = createWorld(S);
async function call(fn, who, body) {
  const mod = load(fn + '.js', w, { ANTHROPIC_API_KEY: 'k' });
  const r = await mod.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + who }, body: JSON.stringify(body) });
  let j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
  return { status: r.statusCode, j };
}
const R = (who, b) => call('routes-api', who, b);
const sends = () => w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url));
const DATE = '2026-11-05';

(async () => {
  let routeId, day, itin, report, crmBefore;
  try {
    await step('1 the President plans a route for Greg (his dealer + a ride-along stop), leaving 08:00 Central', async () => {
      const r = await R('pres', { action: 'save_route', name: 'KY/TN ride-along', scheduled_date: DATE, assigned_to_email: 'greg@hcps.us', round_trip: true,
        home_base: { lat: 36.53, lng: -86.36, label: 'Cottontown, TN' }, depart_time: '08:00',
        stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center', state: 'KY', lat: 36.99, lng: -85.91, visit_min: 45 },
                { dealer_id: 'd-ang', name: 'Retail Medical Solutions', state: 'TN', lat: 36.16, lng: -86.78, visit_min: 30 }] });
      assert.ok(r.j.ok, JSON.stringify(r.j)); routeId = r.j.id;
      const row = w.db.rep_routes.find(x => x.id === routeId);
      assert.strictEqual(row.owner_email, 'angelo@hcps.us'); assert.strictEqual(row.assigned_to_email, 'greg@hcps.us'); assert.strictEqual(row.assigned_by, 'angelo@hcps.us');
    });
    await step('2 explicit assignment (assign_route) keeps the plan and its departure', async () => {
      const a = await R('pres', { action: 'assign_route', id: routeId, assigned_to_email: 'greg@hcps.us' });
      assert.ok(a.j.ok, JSON.stringify(a.j));
      const row = w.db.rep_routes.find(x => x.id === routeId); assert.strictEqual(row.stops.length, 2);
    });
    await step('3 Greg opens his day: both stops workable (ride-along authorized), departure comes down', async () => {
      const r = await R('greg', { action: 'route_day', route_id: routeId });
      assert.strictEqual(r.status, 200, JSON.stringify(r.j)); day = r.j;
      assert.strictEqual(day.stops.length, 2); assert.ok(day.stops.every(s => !s.locked), 'a ride-along stop was locked');
      assert.ok(day.stops.find(s => s.dealer_id === 'd-ang').contacts.some(c => c.email === 'rita@rms.test'));
    });
    await step('4 arrival times: the shared RouteClock from 08:00 Central (Kentucky stop first, then Tennessee)', async () => {
      itin = RouteClock.routeItinerary({ stops: day.stops.map(s => ({ state: s.state, lng: s.lng, visit_min: s.visit_min })),
        legs: [{ duration_s: 90 * 60 }, { duration_s: 100 * 60 }], leadingLeg: true, startDate: DATE, startMinutes: 8 * 60, startTz: 'America/Chicago' });
      const fmt = it => new Intl.DateTimeFormat('en-US', { timeZone: it.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(it.arriveAbs));
      assert.strictEqual(fmt(itin[0]), '9:30 AM', 'stop 1 = 08:00 + 1 h 30'); assert.strictEqual(fmt(itin[1]), '11:55 AM', 'stop 2 = 9:30 + 45 min + 1 h 40');
      assert.ok(!RouteClock.outsideHours || !itin.some(it => RouteClock.outsideHours(it)), 'a working-day arrival was flagged');
    });
    await step('5 heads-up draft with the ETA; an after-hours ETA is left out, never mailed', async () => {
      const h = await R('greg', { action: 'previsit_draft', route_id: routeId, dealer_id: 'd-ang', date: DATE, eta: '11:55 AM', contact_name: 'Rita Example' });
      assert.strictEqual(h.status, 200, JSON.stringify(h.j)); assert.ok(/11:55 AM/.test(h.j.body || h.j.subject || ''), 'ETA missing: ' + JSON.stringify(h.j).slice(0, 200));
      const late = await R('greg', { action: 'previsit_draft', route_id: routeId, dealer_id: 'd-ang', date: DATE, eta: '1:21 AM' });
      assert.ok(!/1:21/.test(JSON.stringify(late.j.body || '')), 'a 1:21 AM arrival went into the draft');
    });
    await step('6 heads-up sent from Outlook to the ride-along dealer\'s contact (fake Graph) — and refused to a stranger', async () => {
      const ok = await call('email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: routeId, to: 'rita@rms.test', subject: 'In your area Thursday', body_text: 'See you around 11:55 AM.' });
      assert.ok(ok.j.ok, JSON.stringify(ok.j)); assert.strictEqual(sends().length, 1);
      const no = await call('email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: routeId, to: 'someone@else.test', subject: 'x', body_text: 'y' });
      assert.strictEqual(no.status, 403); assert.strictEqual(sends().length, 1);
    });
    await step('7 the visit: check in → notes → end → approve (note, timeline, task, deal, attendee recorded once)', async () => {
      const stop = { route_id: routeId, dealer_id: 'd-ang' };
      assert.ok((await R('greg', Object.assign({ action: 'visit_checkin' }, stop))).j.ok);
      assert.ok((await R('greg', Object.assign({ action: 'visit_report_save', status: 'in_progress', fields: { notes: 'Met Rita about PR519.' } }, stop))).j.ok);
      assert.strictEqual((await R('greg', Object.assign({ action: 'visit_end' }, stop))).j.status, 'ended');
      const ap = await R('greg', Object.assign({ action: 'visit_approve', summary: { meeting_summary: 'Met Rita; send PR519 pricing.' },
        participants: [{ key: 'p1', name: 'Rita Example', title: 'Owner', contact_id: 'c-ang', source: 'rep' }],
        tasks: [{ key: 't1', title: 'Send PR519 pricing to Rita', due_date: '2026-11-07', priority: 'normal', kind: 'followup' }],
        opportunities: [{ key: 'o1', title: 'PR519 lift chairs', stage: 'identified', value: 0 }] }, stop));
      assert.strictEqual(ap.status, 200, JSON.stringify(ap.j)); assert.ok(ap.j.ok, JSON.stringify(ap.j));
      report = w.db.dealer_visit_reports.find(x => x.route_id === routeId && x.dealer_id === 'd-ang');
      assert.ok(report && report.completed_at && report.rep_email === 'greg@hcps.us');
      crmBefore = { notes: w.db.dealer_notes.filter(x => x.dealer_id === 'd-ang').length, tasks: w.db.dealer_tasks.filter(x => x.dealer_id === 'd-ang').length,
        opps: w.db.opportunities.filter(x => x.dealer_id === 'd-ang').length, parts: w.db.dealer_visit_participants.filter(x => x.visit_report_id === report.id).length };
      assert.ok(crmBefore.notes >= 1 && crmBefore.tasks >= 1 && crmBefore.opps >= 1 && crmBefore.parts >= 1, JSON.stringify(crmBefore));
    });
    await step('8 the President reassigns the route to Lori', async () => {
      assert.ok((await R('pres', { action: 'assign_route', id: routeId, assigned_to_email: 'lori@hcps.us' })).j.ok);
    });
    await step('9 Greg still writes and sends THAT visit\'s follow-up (AI draft from the visit; to Rita; saved on the visit)', async () => {
      const d = await call('ai-email-api', 'greg', { action: 'draft', dealer_id: 'd-ang', template: 'visit_followup', visit_report_id: report.id, contact_name: 'Rita' });
      assert.strictEqual(d.status, 200, JSON.stringify(d.j));
      const s = await call('email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: routeId, report_id: report.id, to: 'rita@rms.test', subject: d.j.subject, body_text: d.j.body });
      assert.ok(s.j.ok, JSON.stringify(s.j)); assert.strictEqual(sends().length, 2);
      const sv = await R('greg', { action: 'visit_email_save', route_id: routeId, dealer_id: 'd-ang', sent: true, email: { to: 'rita@rms.test', subject: d.j.subject, body: d.j.body } });
      assert.ok(sv.j.ok, JSON.stringify(sv.j));
    });
    await step('10 ...but nothing else of the dealer: no new heads-up, packet, or general email for Greg', async () => {
      assert.strictEqual((await R('greg', { action: 'previsit_draft', route_id: routeId, dealer_id: 'd-ang' })).status, 403);
      assert.strictEqual((await R('greg', { action: 'business_case', dealer_ids: ['d-ang'] })).status, 403);
      assert.strictEqual((await call('email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', to: 'rita@rms.test', subject: 's', body_text: 'b' })).status, 403);
      assert.strictEqual((await call('ai-email-api', 'greg', { action: 'draft', dealer_id: 'd-ang', template: 'cross_sell' })).status, 403);
    });
    await step('11 Lori (the new driver) works the route, but cannot take over or rewrite Greg\'s visit', async () => {
      const day2 = await R('lori', { action: 'route_day', route_id: routeId });
      assert.strictEqual(day2.status, 200); assert.ok(day2.j.stops.find(s => s.dealer_id === 'd-ang').visit.by_other, 'Greg\'s visit not shown as his');
      const re = await R('lori', { action: 'visit_report_save', route_id: routeId, dealer_id: 'd-ang', status: 'in_progress', fields: { notes: 'overwritten' } });
      assert.strictEqual(re.status, 409, JSON.stringify(re.j));
    });
    await step('12 CRM records of the visit are intact and still Greg\'s', async () => {
      const now = { notes: w.db.dealer_notes.filter(x => x.dealer_id === 'd-ang').length, tasks: w.db.dealer_tasks.filter(x => x.dealer_id === 'd-ang').length,
        opps: w.db.opportunities.filter(x => x.dealer_id === 'd-ang').length, parts: w.db.dealer_visit_participants.filter(x => x.visit_report_id === report.id).length };
      assert.deepStrictEqual(now, crmBefore);
      const r = w.db.dealer_visit_reports.find(x => x.id === report.id);
      assert.strictEqual(r.rep_email, 'greg@hcps.us'); assert.ok(!/overwritten/.test(JSON.stringify(r.fields || {})));
      assert.ok(r.followup_email && r.followup_email.sent_at, 'the follow-up was not recorded as sent');
      assert.ok(sends().every(x => { const m = JSON.parse(typeof x.body === 'string' ? x.body : JSON.stringify(x.body)).message;
        return m.toRecipients.concat(m.ccRecipients || []).every(a => /@rms\.test$/.test(a.emailAddress.address)); }), 'an email went outside the dealer');
    });
  } catch (e) { /* the failing step already printed; later steps depend on it */ }
  console.log(`\nsr-workflow: ${pass} passed, ${fail} failed`);
  process.exitCode = fail || pass < 12 ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

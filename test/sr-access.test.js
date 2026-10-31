/* Scheduled Routes — dealer access through routes (security fix, Angelo 2026-10-30). Real handlers, fake database, synthetic
   data only; nothing reaches a real mailbox (Outlook is the mock's fake Graph).
   Priority 1: a rep never gains another rep's dealer by putting it on a route he built himself — save is refused, a legacy
   stop shows no contacts, every visit / email / packet action is refused, Command Center Meeting Prep leaves it out. Routes
   the PRESIDENT assigned (incl. ride-alongs) keep working; a route assigned by anyone else, or by a deactivated President,
   opens nothing.
   Priority 2: after a reassignment the rep who personally performed a visit still follows it up — that visit, that dealer,
   that dealer's own addresses — and nothing else of the dealer.
     node test/sr-access.test.js */
const assert = require('assert');
const { createWorld, load, standardSeed } = require('./phase0-mock');
let pass = 0, fail = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } }

const AI_SEEN = [];   // every prompt the fake AI received
const ANG_CONTACT = { id: 'c-ang', dealer_id: 'd-ang', name: 'Rita Example', email: 'rita@rms.test', phone: '615-555-0101', title: 'Owner' };
function world(extra) {
  const S = standardSeed(Object.assign({
    rep_routes: [
      // Greg's OWN route, with a (legacy) stop of Angelo's dealer that the old code let him add.
      { id: 'r-self', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'Greg own loop', scheduled_date: today(), assigned_to_email: 'greg@hcps.us',
        assigned_to_rep: 'Greg Campbell', assigned_by: 'greg@hcps.us', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-ang', name: 'RMS', city: 'Nashville', state: 'TN' }],
        round_trip: true, updated_at: '2026-10-30T10:00:00Z' },
      // The President's ride-along for Greg, through Angelo's dealer.
      { id: 'r-ride', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'Ride-along', scheduled_date: '2026-11-05', assigned_to_email: 'greg@hcps.us',
        assigned_to_rep: 'Greg Campbell', assigned_by: 'angelo@hcps.us', stops: [{ dealer_id: 'd-ang', name: 'RMS' }], round_trip: true, updated_at: '2026-10-29T10:00:00Z' },
    ],
    dealer_contacts: [ANG_CONTACT, { id: 'c-greg', dealer_id: 'd-greg', name: 'Bryant', email: 'bryant@glasgow.test' }],
    dealer_visit_reports: [], dealer_visit_participants: [], dealer_activity: [], email_optout: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { adhoc_visit: true } }],
  }, extra || {}));
  S.ai = b => { AI_SEEN.push(JSON.stringify(b)); return { subject: 'Thanks for the visit', body: 'Hi Rita,\n\nThanks for meeting with me about the lift chairs.' }; };
  return createWorld(S);
}
// The same world without the President's ride-along: Greg has NO authorized way to Angelo's dealer.
function selfOnly(extra) { const w = world(extra); w.db.rep_routes = w.db.rep_routes.filter(r => r.id !== 'r-ride'); return w; }
// The Command Center's day is Chicago's (a UTC 'today' fails every evening after 7 PM CT).
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
async function call(w, fn, who, body, headers) {
  const mod = load(fn + '.js', w, { ANTHROPIC_API_KEY: 'k' });
  const r = await mod.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: 'Bearer ' + who }, headers || {}), body: JSON.stringify(body) });
  let j = {}; try { j = JSON.parse(r.body || '{}'); } catch (e) {}
  return { status: r.statusCode, j };
}
const routes = (w, who, b) => call(w, 'routes-api', who, b);
async function assignA(w, id, email) {   // review, then confirm with the review's code
  const rv = await routes(w, 'pres', { action: 'assign_route', id, assigned_to_email: email, review: true });
  return rv.j.review_code ? routes(w, 'pres', { action: 'assign_route', id, assigned_to_email: email, review_code: rv.j.review_code }) : rv;
}
const sends = w => w.outbound.filter(x => x.kind === 'graph' && /sendMail/.test(x.url));
const leaks = obj => /rita@rms\.test|615-555-0101|Rita Example/.test(JSON.stringify(obj));

(async () => {
  // ── Priority 1: a self-built route opens nothing ─────────────────────────────────────────────
  await t('save_route: a rep cannot put another rep\'s dealer on a NEW route (403, nothing written)', async () => {
    const w = selfOnly(); const n0 = w.db.rep_routes.length;
    const r = await routes(w, 'greg', { action: 'save_route', name: 'Sneaky', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-ang', name: 'RMS' }] });
    assert.strictEqual(r.status, 403, JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'not_your_dealer'); assert.deepStrictEqual(r.j.dealer_ids, ['d-ang']);
    assert.strictEqual(w.db.rep_routes.length, n0, 'a route was written');
    assert.ok((await routes(w, 'greg', { action: 'save_route', name: 'Fine', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }] })).j.ok, 'his own dealers still save');
  });
  await t('save_route: adding another rep\'s dealer to an existing route is refused; a legacy stop already on it may stay', async () => {
    const w = selfOnly();
    const add = await routes(w, 'greg', { action: 'save_route', id: 'r-ride2', name: 'x', stops: [] });
    assert.strictEqual(add.status, 404);
    w.db.rep_routes.find(r => r.id === 'r-self').stops = [{ dealer_id: 'd-greg', name: 'Glasgow' }];
    const r = await routes(w, 'greg', { action: 'save_route', id: 'r-self', name: 'Greg own loop', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-ang', name: 'RMS' }] });
    assert.strictEqual(r.status, 403, JSON.stringify(r.j));
    assert.strictEqual(w.db.rep_routes.find(x => x.id === 'r-self').stops.length, 1, 'the stop was added anyway');
    const w2 = selfOnly();   // r-self already holds d-ang (saved before this fix): re-saving it in a new order is not refused
    const keep = await routes(w2, 'greg', { action: 'save_route', id: 'r-self', name: 'Greg own loop', stops: [{ dealer_id: 'd-ang', name: 'RMS' }, { dealer_id: 'd-greg', name: 'Glasgow' }] });
    assert.ok(keep.j.ok, JSON.stringify(keep.j));
  });
  await t('route_day on his own route: the other rep\'s stop shows name + address only — no contact, email or phone', async () => {
    const w = selfOnly();
    const r = await routes(w, 'greg', { action: 'route_day', route_id: 'r-self' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.j));
    const s = r.j.stops.find(x => x.dealer_id === 'd-ang');
    assert.ok(s && s.locked, 'stop not locked: ' + JSON.stringify(s));
    assert.strictEqual(s.name, 'RMS'); assert.strictEqual(s.city, 'Nashville');
    assert.deepStrictEqual(s.contacts, []); assert.strictEqual(s.contact_email, ''); assert.strictEqual(s.contact_phone, '');
    assert.ok(!leaks(r.j), 'contact data leaked: ' + JSON.stringify(s));
    const mine = r.j.stops.find(x => x.dealer_id === 'd-greg'); assert.ok(!mine.locked && mine.contacts.length, 'his own stop lost its contacts');
    const byDate = await routes(w, 'greg', { action: 'route_day', date: today() });
    assert.ok(!leaks(byDate.j), 'route_day by date leaked the contact');
  });
  await t('every dealer action on that stop is refused server-side (visit, heads-up, packet, notice, follow-up)', async () => {
    const w = selfOnly();
    for (const b of [{ action: 'visit_checkin', route_id: 'r-self', dealer_id: 'd-ang' }, { action: 'visit_report_get', route_id: 'r-self', dealer_id: 'd-ang' },
      { action: 'previsit_draft', route_id: 'r-self', dealer_id: 'd-ang' }, { action: 'business_case', dealer_ids: ['d-ang'] },
      { action: 'notify_visit', dealer_id: 'd-ang' }, { action: 'send_followup', route_id: 'r-self', dealer_id: 'd-ang', body: 'hi' },
      { action: 'route_day', dealer_id: 'd-ang' }]) {
      const r = await routes(w, 'greg', b);
      assert.strictEqual(r.status, 403, b.action + ' → ' + r.status + ' ' + JSON.stringify(r.j));
      assert.ok(!leaks(r.j), b.action + ' leaked');
    }
    assert.strictEqual(w.db.dealer_visit_reports.length, 0, 'a visit was opened');
  });
  await t('Outlook send: a dealer outside the book is refused without a President route or his own visit — even naming his own route', async () => {
    const w = selfOnly();
    for (const extra of [{}, { route_id: 'r-self' }, { report_id: 'nope' }]) {
      const r = await call(w, 'email-sync-api', 'greg', Object.assign({ action: 'send', dealer_id: 'd-ang', to: 'rita@rms.test', subject: 'Hello', body_text: 'Hi' }, extra));
      assert.strictEqual(r.status, 403, JSON.stringify(extra) + ' ' + JSON.stringify(r.j));
    }
    assert.strictEqual(sends(w).length, 0, 'an email left');
  });
  await t('AI draft for another rep\'s dealer is refused (any template) without his own visit', async () => {
    const w = selfOnly();
    for (const tpl of ['follow_up', 'visit_followup']) {
      const r = await call(w, 'ai-email-api', 'greg', { action: 'draft', dealer_id: 'd-ang', template: tpl, visit_report_id: 'x' });
      assert.strictEqual(r.status, 403, tpl + ' ' + JSON.stringify(r.j));
    }
  });
  await t('Command Center Meeting Prep leaves out the other rep\'s stop on a self-built route', async () => {
    const w = selfOnly();
    w.db.monthly_sales = [{ dealer_id: 'd-ang', period: '2026-09', amount: 1234, product_name: 'Lift chair' }, { dealer_id: 'd-greg', period: '2026-09', amount: 50, product_name: 'Cane' }];
    const r = await call(w, 'rep-command-api', 'greg', { action: 'today', date: today() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.j).slice(0, 300));
    const ids = (r.j.prep || []).map(p => p.dealer_id || p.id);
    assert.ok(!JSON.stringify(r.j.prep || []).includes('Retail Medical') && !leaks(r.j.prep || []), 'prep for d-ang: ' + JSON.stringify(r.j.prep).slice(0, 300));
    assert.ok(JSON.stringify(r.j.prep || []).includes('Glasgow'), 'his own stop lost its prep: ' + JSON.stringify(ids));
  });

  // ── Priority 1: what keeps working ───────────────────────────────────────────────────────────
  await t('President-assigned ride-along: contacts shown, heads-up, check-in and the packet work', async () => {
    const w = world();
    const d = await routes(w, 'greg', { action: 'route_day', route_id: 'r-ride' });
    const s = d.j.stops.find(x => x.dealer_id === 'd-ang'); assert.ok(s && !s.locked && s.contacts.length, JSON.stringify(s));
    for (const b of [{ action: 'previsit_draft', route_id: 'r-ride', dealer_id: 'd-ang', date: '2026-11-05' }, { action: 'business_case', dealer_ids: ['d-ang'] },
      { action: 'visit_checkin', route_id: 'r-ride', dealer_id: 'd-ang' }]) {
      const r = await routes(w, 'greg', b); assert.notStrictEqual(r.status, 403, b.action + ' ' + JSON.stringify(r.j));
    }
  });
  await t('ride-along heads-up from Outlook: allowed to the dealer\'s own contacts, refused to anyone else', async () => {
    const w = world();
    const ok = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: 'r-ride', to: 'rita@rms.test', cc: ['r@rms.test'], subject: 'Visit', body_text: 'See you' });
    assert.ok(ok.j.ok, JSON.stringify(ok.j)); assert.strictEqual(sends(w).length, 1);
    const bad = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: 'r-ride', to: 'rita@rms.test', cc: ['someone@else.test'], subject: 'Visit', body_text: 'x' });
    assert.strictEqual(bad.status, 403); assert.strictEqual(bad.j.error, 'recipient_not_allowed'); assert.strictEqual(sends(w).length, 1);
  });
  await t('legacy President route without assigned_by still counts (owner is the President)', async () => {
    const w = world(); delete w.db.rep_routes.find(r => r.id === 'r-ride').assigned_by;
    assert.notStrictEqual((await routes(w, 'greg', { action: 'previsit_draft', route_id: 'r-ride', dealer_id: 'd-ang', date: '2026-11-05' })).status, 403);
  });
  await t('a route assigned by someone who is NOT an active President opens nothing', async () => {
    for (const mod of [r => { r.owner_email = 'lori@hcps.us'; r.assigned_by = 'lori@hcps.us'; },            // Relations handed it over
      r => { r.owner_email = 'former@hcps.us'; r.assigned_by = 'former@hcps.us'; },                           // not a staff user
      r => { r.assigned_by = 'boss2@hcps.us'; }]) {                                                          // a deactivated President
      const w = world(); w.db.staff_users.push({ email: 'boss2@hcps.us', role: 'president', active: false, name: 'Old Boss' });
      mod(w.db.rep_routes.find(r => r.id === 'r-ride'));
      const r = await routes(w, 'greg', { action: 'previsit_draft', route_id: 'r-ride', dealer_id: 'd-ang', date: '2026-11-05' });
      assert.strictEqual(r.status, 403, JSON.stringify(w.db.rep_routes.find(x => x.id === 'r-ride')));
      const d = await routes(w, 'greg', { action: 'route_day', route_id: 'r-ride' });
      assert.ok(!leaks(d.j), 'contacts leaked on a route nobody authorized');
    }
  });
  await t('the President re-saving a rep\'s own route does not turn it into a ride-along', async () => {
    const w = selfOnly();
    assert.ok((await routes(w, 'pres', { action: 'save_route', id: 'r-self', name: 'Greg own loop', assigned_to_email: 'greg@hcps.us',
      stops: w.db.rep_routes.find(r => r.id === 'r-self').stops })).j.ok);
    assert.strictEqual(w.db.rep_routes.find(r => r.id === 'r-self').assigned_by, 'angelo@hcps.us', 'precondition');
    assert.strictEqual((await routes(w, 'greg', { action: 'previsit_draft', route_id: 'r-self', dealer_id: 'd-ang' })).status, 403);
  });
  await t('reassignment: the President moving the ride-along to Lori closes it to Greg (no visit yet)', async () => {
    const w = world();
    assert.ok((await assignA(w, 'r-ride', 'lori@hcps.us')).j.ok);
    assert.strictEqual((await routes(w, 'greg', { action: 'previsit_draft', route_id: 'r-ride', dealer_id: 'd-ang' })).status, 403);
    assert.strictEqual((await routes(w, 'greg', { action: 'route_day', route_id: 'r-ride' })).status, 403);
    assert.strictEqual((await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: 'r-ride', to: 'rita@rms.test', subject: 's', body_text: 'b' })).status, 403);
  });
  await t('management and Relations plan any dealer; Relations still works every stop', async () => {
    const w = world();
    assert.ok((await routes(w, 'pres', { action: 'save_route', name: 'Office', stops: [{ dealer_id: 'd-greg' }, { dealer_id: 'd-ang' }] })).j.ok);
    assert.ok((await routes(w, 'lori', { action: 'save_route', name: 'Relations day', stops: [{ dealer_id: 'd-greg' }, { dealer_id: 'd-ang' }] })).j.ok);
    const id = w.db.rep_routes.find(r => r.name === 'Relations day').id;
    const d = await routes(w, 'lori', { action: 'route_day', route_id: id });
    assert.ok(d.j.stops.every(s => !s.locked) && leaks(d.j), 'Relations lost her reach');
  });

  // ── Priority 2: follow-up continuity after reassignment ──────────────────────────────────────
  async function visitedThenReassigned() {
    const w = world();
    const ci = await routes(w, 'greg', { action: 'visit_checkin', route_id: 'r-ride', dealer_id: 'd-ang' });
    assert.ok(ci.j.ok, 'precondition: check-in ' + JSON.stringify(ci.j));
    const rep = w.db.dealer_visit_reports.find(x => x.route_id === 'r-ride' && x.dealer_id === 'd-ang');
    Object.assign(rep, { status: 'completed', ended_at: '2026-11-05T16:00:00Z', completed_at: '2026-11-05T16:05:00Z', approved_at: '2026-11-05T16:06:00Z', summary: { meeting_summary: 'Rita wants the PR519 sheet.' } });
    w.db.dealer_visit_participants.push({ id: 'p1', visit_report_id: rep.id, dealer_id: 'd-ang', name_snapshot: 'Sam Buyer', email_snapshot: 'sam@rms.test', attended: true });
    assert.ok((await assignA(w, 'r-ride', 'lori@hcps.us')).j.ok);
    return { w, rep };
  }
  await t('after reassignment the visiting rep still drafts the follow-up (AI, visit-only — no account history in the prompt)', async () => {
    const { w, rep } = await visitedThenReassigned();
    w.db.monthly_sales = [{ dealer_id: 'd-ang', period: '2026-09', amount: 98765, product_name: 'Secret line' }];
    AI_SEEN.length = 0;
    const r = await call(w, 'ai-email-api', 'greg', { action: 'draft', dealer_id: 'd-ang', template: 'visit_followup', visit_report_id: rep.id, contact_name: 'Rita' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.j));
    assert.ok(AI_SEEN.length >= 1, 'the AI was never asked');
    assert.ok(AI_SEEN.every(p => !/98,?765|Secret line/.test(p)), 'account history went into the prompt');
    assert.ok(AI_SEEN.some(p => /PR519 sheet/.test(p)), 'the visit recap was missing from the prompt');
    // control: the dealer's own rep (in his book) still gets the account history
    AI_SEEN.length = 0;
    const own = await call(w, 'ai-email-api', 'pres', { action: 'draft', dealer_id: 'd-ang', template: 'visit_followup', visit_report_id: rep.id });
    assert.strictEqual(own.status, 200); assert.ok(AI_SEEN.some(p => /98,?765|Secret line/.test(p)), 'control: the full context path lost the history');
    const other = await call(w, 'ai-email-api', 'greg', { action: 'draft', dealer_id: 'd-ang', template: 'follow_up', visit_report_id: rep.id });
    assert.strictEqual(other.status, 403, 'his visit opened other email types');
  });
  await t('after reassignment the visiting rep sends the follow-up to the visit\'s attendees (and the dealer\'s own email) — not the dealer\'s whole contact list', async () => {
    const { w, rep } = await visitedThenReassigned();
    // Rita is a dealer contact on file (created by someone else) and was at the visit: verified.
    w.db.dealer_visit_participants.push({ id: 'p2', visit_report_id: rep.id, dealer_id: 'd-ang', contact_id: 'c-ang', name_snapshot: 'Rita Example', email_snapshot: 'rita@rms.test', attended: true });
    const ok = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: 'r-ride', report_id: rep.id, to: 'rita@rms.test', subject: 'Following up', body_text: 'Thanks' });
    assert.ok(ok.j.ok, JSON.stringify(ok.j)); assert.strictEqual(sends(w).length, 1);
    // Sam's address was only typed in as an attendee: recorded, but NOT a recipient on its own.
    const typed = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: 'r-ride', report_id: rep.id, to: 'rita@rms.test', cc: ['sam@rms.test'], subject: 'x', body_text: 'y' });
    assert.strictEqual(typed.status, 403, 'a typed attendee address was allowed'); assert.deepStrictEqual(typed.j.recipients, ['sam@rms.test']); assert.strictEqual(sends(w).length, 1);
    // A dealer contact on file who was NOT at this visit is not a recipient of this visit's follow-up.
    w.db.dealer_contacts.push({ id: 'c-other', dealer_id: 'd-ang', name: 'Oscar', email: 'oscar@rms.test' });
    const notAtVisit = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', report_id: rep.id, to: 'oscar@rms.test', subject: 'x', body_text: 'y' });
    assert.strictEqual(notAtVisit.status, 403, 'a contact who was not at the visit was allowed'); assert.strictEqual(sends(w).length, 1);
    const bad = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', report_id: rep.id, to: 'outsider@gmail.test', subject: 'x', body_text: 'y' });
    assert.strictEqual(bad.status, 403); assert.strictEqual(bad.j.error, 'recipient_not_allowed'); assert.strictEqual(sends(w).length, 1);
    for (const b of [{ action: 'generate_followup', route_id: 'r-ride', dealer_id: 'd-ang' }, { action: 'visit_email_save', route_id: 'r-ride', dealer_id: 'd-ang', email: { to: 'rita@rms.test', subject: 's', body: 'b' } },
      { action: 'send_followup', route_id: 'r-ride', dealer_id: 'd-ang', body: 'Thanks' }, { action: 'visit_report_get', route_id: 'r-ride', dealer_id: 'd-ang' }]) {
      const r = await routes(w, 'greg', b); assert.ok(r.status < 300, b.action + ' → ' + r.status + ' ' + JSON.stringify(r.j));
    }
  });
  await t('attendee verification: a contact the rep created himself is not verified; the President approves an attendee for that visit only', async () => {
    const { w, rep } = await visitedThenReassigned();
    // Greg recorded "Pat" with a new address and created her as a contact from his own visit (contacts_added).
    w.db.dealer_contacts.push({ id: 'c-pat', dealer_id: 'd-ang', name: 'Pat New', email: 'pat@outside.test' });
    rep.summary = Object.assign({}, rep.summary, { contacts_added: ['c-pat'] });
    w.db.dealer_visit_participants.push({ id: 'p3', visit_report_id: rep.id, dealer_id: 'd-ang', contact_id: 'c-pat', name_snapshot: 'Pat New', email_snapshot: 'pat@outside.test', attended: true });
    const self = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', report_id: rep.id, to: 'pat@outside.test', subject: 's', body_text: 'b' });
    assert.strictEqual(self.status, 403, 'a contact he created himself became a recipient');
    // The review lists who is verified, approved or unverified (rep may read his own visit's list).
    const rv = await routes(w, 'greg', { action: 'followup_recipients', report_id: rep.id });
    assert.ok(rv.j.ok, JSON.stringify(rv.j)); assert.ok(!rv.j.can_approve);
    assert.deepStrictEqual(rv.j.people.map(p => p.email + ':' + p.status).sort(), ['pat@outside.test:unverified', 'sam@rms.test:unverified']);
    // Greg cannot approve; Lori (another rep's reach) cannot read it; the President must give a reason.
    assert.strictEqual((await routes(w, 'greg', { action: 'approve_recipient', report_id: rep.id, email: 'sam@rms.test', reason: 'met him' })).status, 403);
    assert.strictEqual((await routes(w, 'pres', { action: 'approve_recipient', report_id: rep.id, email: 'sam@rms.test' })).status, 400);
    // Only a recorded attendee of THIS visit can be approved.
    const notAtt = await routes(w, 'pres', { action: 'approve_recipient', report_id: rep.id, email: 'stranger@x.test', reason: 'phone call' });
    assert.strictEqual(notAtt.status, 400); assert.strictEqual(notAtt.j.error, 'not_an_attendee');
    const ap = await routes(w, 'pres', { action: 'approve_recipient', report_id: rep.id, email: 'sam@rms.test', reason: 'Confirmed Sam is the buyer by phone' });
    assert.ok(ap.j.ok, JSON.stringify(ap.j)); assert.ok(ap.j.people.some(p => p.email === 'sam@rms.test' && p.status === 'approved'));
    const contactsBefore = JSON.stringify(w.db.dealer_contacts);
    const sent = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', report_id: rep.id, to: 'sam@rms.test', subject: 'Following up', body_text: 'Thanks' });
    assert.ok(sent.j.ok, JSON.stringify(sent.j));
    assert.strictEqual(JSON.stringify(w.db.dealer_contacts), contactsBefore, 'approving changed a dealer contact');
    // The approval is for that visit only: another of his visits there does not inherit it.
    const other = { id: 'vr-greg-2', route_id: null, dealer_id: 'd-ang', rep_email: 'greg@hcps.us', checkin_at: '2026-11-07T15:00:00Z', status: 'checked_in', summary: {} };
    w.db.dealer_visit_reports.push(other);
    w.db.dealer_visit_participants.push({ id: 'p4', visit_report_id: other.id, dealer_id: 'd-ang', name_snapshot: 'Sam Buyer', email_snapshot: 'sam@rms.test', attended: true });
    const elsewhere = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', report_id: other.id, to: 'sam@rms.test', subject: 's', body_text: 'b' });
    assert.strictEqual(elsewhere.status, 403, 'an approval leaked to another visit');
    // Re-approving the visit keeps the President's approval (the rep's input can't drop or forge it).
    const re = await routes(w, 'greg', { action: 'visit_approve', route_id: 'r-ride', dealer_id: 'd-ang', summary: { meeting_summary: 'x', approved_recipients: [{ email: 'evil@x.test' }] } });
    const r2 = w.db.dealer_visit_reports.find(x => x.id === rep.id);
    assert.deepStrictEqual((r2.summary.approved_recipients || []).map(x => x.email), ['sam@rms.test'], 'approvals changed by the rep: ' + JSON.stringify(re.j).slice(0, 200));
  });
  await t('ride-along: contacts the rep created himself from his visits are not recipients either', async () => {
    const w = world();
    w.db.dealer_contacts.push({ id: 'c-mine', dealer_id: 'd-ang', name: 'Typed', email: 'typed@outside.test' });
    w.db.dealer_visit_reports.push({ id: 'vr-old', route_id: 'r-ride', dealer_id: 'd-ang', rep_email: 'greg@hcps.us', checkin_at: '2026-11-01T15:00:00Z', status: 'completed', summary: { contacts_added: ['c-mine'] } });
    const r = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: 'r-ride', to: 'typed@outside.test', subject: 's', body_text: 'b' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.j));
    const ok = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: 'r-ride', to: 'rita@rms.test', subject: 's', body_text: 'b' });
    assert.ok(ok.j.ok, 'a legitimate ride-along email to a contact on file was refused: ' + JSON.stringify(ok.j));
  });
  await t('assignment review: the President sees the stops and the dealers outside the rep\'s book before confirming; a stop added after the review needs a new one', async () => {
    const w = selfOnly();
    w.db.rep_routes.push({ id: 'r-plan', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'TN day', scheduled_date: '2026-11-09',
      stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-ang', name: 'RMS', city: 'Nashville', state: 'TN' }], round_trip: true });
    const noReview = await routes(w, 'pres', { action: 'assign_route', id: 'r-plan', assigned_to_email: 'greg@hcps.us' });
    assert.strictEqual(noReview.status, 409); assert.strictEqual(noReview.j.error, 'review_required');
    assert.ok(!w.db.rep_routes.find(r => r.id === 'r-plan').assigned_to_email, 'assigned without a review');
    const rv = await routes(w, 'pres', { action: 'assign_route', id: 'r-plan', assigned_to_email: 'greg@hcps.us', review: true });
    assert.ok(rv.j.ok && rv.j.review_code, JSON.stringify(rv.j));
    assert.deepStrictEqual(rv.j.stops.map(s => s.dealer_id + ':' + s.outside_book), ['d-greg:false', 'd-ang:true']);
    assert.strictEqual(rv.j.outside_count, 1); assert.ok(!w.db.rep_routes.find(r => r.id === 'r-plan').assigned_to_email, 'the review assigned it');
    w.db.rep_routes.find(r => r.id === 'r-plan').stops.push({ dealer_id: 'd-none', name: 'Late add' });
    const stale = await routes(w, 'pres', { action: 'assign_route', id: 'r-plan', assigned_to_email: 'greg@hcps.us', review_code: rv.j.review_code });
    assert.strictEqual(stale.status, 409, 'a stale review was accepted'); assert.ok(stale.j.stops.some(s => s.dealer_id === 'd-none'));
    const ok = await routes(w, 'pres', { action: 'assign_route', id: 'r-plan', assigned_to_email: 'greg@hcps.us', review_code: stale.j.review_code });
    assert.ok(ok.j.ok, JSON.stringify(ok.j)); assert.strictEqual(w.db.rep_routes.find(r => r.id === 'r-plan').assigned_to_email, 'greg@hcps.us');
    const rep = await routes(w, 'greg', { action: 'assign_route', id: 'r-plan', assigned_to_email: 'greg@hcps.us', review: true });
    assert.strictEqual(rep.status, 403, 'a rep reviewed an assignment');
  });
  await t('...but his old visit opens nothing else: heads-up, packet, new visits, Dealer-wide email, other dealers', async () => {
    const { w, rep } = await visitedThenReassigned();
    for (const b of [{ action: 'previsit_draft', route_id: 'r-ride', dealer_id: 'd-ang' }, { action: 'business_case', dealer_ids: ['d-ang'] },
      { action: 'notify_visit', dealer_id: 'd-ang' }, { action: 'route_day', dealer_id: 'd-ang' },
      { action: 'send_followup', dealer_id: 'd-ang', report_id: rep.id, body: 'x' }]) {
      const r = await routes(w, 'greg', b); assert.strictEqual(r.status, 403, b.action + ' ' + JSON.stringify(r.j));
    }
    const noRef = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', to: 'rita@rms.test', subject: 's', body_text: 'b' });
    assert.strictEqual(noRef.status, 403, 'a send without his visit was allowed');
    const lorisRep = { id: 'vr-lori', route_id: 'r-ride', dealer_id: 'd-ang', rep_email: 'lori@hcps.us', checkin_at: '2026-11-06T15:00:00Z', status: 'checked_in' };
    w.db.dealer_visit_reports.push(lorisRep);
    const steal = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', report_id: 'vr-lori', to: 'rita@rms.test', subject: 's', body_text: 'b' });
    assert.strictEqual(steal.status, 403, "another rep's visit gave him a send");
    w.db.dealer_visit_participants.push({ id: 'p-l', visit_report_id: 'vr-lori', dealer_id: 'd-ang', name_snapshot: 'Pat', email_snapshot: 'pat@rms.test', attended: true });
    const steal2 = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', report_id: 'vr-lori', to: 'pat@rms.test', subject: 's', body_text: 'b' });
    assert.strictEqual(steal2.status, 403, "another rep's visit gave him a send to its attendee");
    const stealAi = await call(w, 'ai-email-api', 'greg', { action: 'draft', dealer_id: 'd-ang', template: 'visit_followup', visit_report_id: 'vr-lori' });
    assert.strictEqual(stealAi.status, 403, "another rep's visit gave him an AI draft");
    const day = await routes(w, 'greg', { action: 'route_day', route_id: 'r-ride' });
    assert.ok(day.j.route.own_visits_only && day.j.stops.length === 1, 'the reassigned route showed him more than his visit');
  });
  await t('a visit that was only planned (never started) gives no follow-up right', async () => {
    const w = selfOnly();
    w.db.dealer_visit_reports.push({ id: 'vr-claim', route_id: 'r-self', dealer_id: 'd-ang', rep_email: 'greg@hcps.us', status: 'planned', checkin_at: null, ended_at: null, completed_at: null });
    const r = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', report_id: 'vr-claim', to: 'rita@rms.test', subject: 's', body_text: 'b' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.j)); assert.strictEqual(sends(w).length, 0);
    const a = await call(w, 'ai-email-api', 'greg', { action: 'draft', dealer_id: 'd-ang', template: 'visit_followup', visit_report_id: 'vr-claim' });
    assert.strictEqual(a.status, 403, JSON.stringify(a.j));
  });
  await t('the President and Lori (the new driver) keep full reach; the CRM records of the visit stay intact', async () => {
    const { w, rep } = await visitedThenReassigned();
    const r = await routes(w, 'lori', { action: 'route_day', route_id: 'r-ride' });
    assert.ok(leaks(r.j));
    assert.strictEqual(w.db.dealer_visit_reports.find(x => x.id === rep.id).rep_email, 'greg@hcps.us', 'the visit changed hands');
  });
  await t('review M1: the owner cannot add dealers to a route the President handed to someone else; a non-President hand-over is unaffected', async () => {
    const w = selfOnly();
    w.db.rep_routes.push({ id: 'r-handed', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'Handed', scheduled_date: '2026-11-06',
      assigned_to_email: 'tom@hcps.us', assigned_to_rep: 'Tom', assigned_by: 'angelo@hcps.us', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }], round_trip: true });
    const r = await routes(w, 'greg', { action: 'save_route', id: 'r-handed', name: 'Handed', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-greg-branch', name: 'Glasgow North' }] });
    assert.strictEqual(r.status, 403, JSON.stringify(r.j)); assert.strictEqual(r.j.error, 'assigned_route_locked');
    assert.strictEqual(w.db.rep_routes.find(x => x.id === 'r-handed').stops.length, 1, 'the stop was added anyway');
    const arch = await routes(w, 'greg', { action: 'archive_route', id: 'r-handed' });
    assert.ok(arch.j.ok, 'precondition: archive ' + JSON.stringify(arch.j));
    {   // archive → add → un-archive must not get a stop in
      const sneak = await routes(w, 'greg', { action: 'save_route', id: 'r-handed', name: 'Handed', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-greg-branch', name: 'Glasgow North' }] });
      assert.strictEqual(sneak.status, 403, 'archiving opened the route: ' + JSON.stringify(sneak.j));
      await routes(w, 'greg', { action: 'archive_route', id: 'r-handed', archived: false });
    }
    w.db.staff_users.forEach(u => { if (u.email === 'angelo@hcps.us') u.active = false; });
    const off = await routes(w, 'greg', { action: 'save_route', id: 'r-handed', name: 'Handed', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-greg-branch', name: 'Glasgow North' }] });
    assert.strictEqual(off.status, 403, 'a switched-off President opened the route: ' + JSON.stringify(off.j));
    w.db.staff_users.forEach(u => { if (u.email === 'angelo@hcps.us') u.active = true; });
    const reorder = await routes(w, 'greg', { action: 'save_route', id: 'r-handed', name: 'Handed v2', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }] });
    assert.ok(reorder.j.ok, 'a save without new dealers must still work: ' + JSON.stringify(reorder.j));
    const pres = await routes(w, 'pres', { action: 'save_route', id: 'r-handed', name: 'Handed', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-greg-branch', name: 'Glasgow North' }] });
    assert.ok(pres.j.ok, 'the President adds freely: ' + JSON.stringify(pres.j));
    w.db.rep_routes.find(x => x.id === 'r-handed').assigned_by = 'greg@hcps.us';   // not a President's hand-over: grants nothing, so no lock
    const own = await routes(w, 'greg', { action: 'save_route', id: 'r-handed', name: 'Handed', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-greg-branch', name: 'Glasgow North' }, { dealer_id: 'd-dir-greg', name: 'Dir' }] });
    assert.ok(own.j.ok, JSON.stringify(own.j));
  });
  await t('review L1: an archived ride-along opens nothing any more', async () => {
    const w = world(); w.db.rep_routes.find(r => r.id === 'r-ride').archived_at = '2026-11-10T00:00:00Z';
    const day = await routes(w, 'greg', { action: 'route_day', route_id: 'r-self' });
    assert.ok(day.j.stops.find(x => x.dealer_id === 'd-ang').locked && !leaks(day.j), 'the archived ride-along still opened the dealer');
    const send = await call(w, 'email-sync-api', 'greg', { action: 'send', dealer_id: 'd-ang', route_id: 'r-ride', to: 'rita@rms.test', subject: 's', body_text: 'b' });
    assert.strictEqual(send.status, 403, JSON.stringify(send.j));
  });
  await t('review L3: a locked stop shows only the status of another rep\'s visit there', async () => {
    const w = selfOnly();
    w.db.dealer_visit_reports.push({ id: 'vr-x', route_id: 'r-self', dealer_id: 'd-ang', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', status: 'completed',
      checkin_at: '2026-11-04T15:00:00Z', completed_at: '2026-11-04T16:00:00Z', followup_status: 'pending', ai_suggested_at: '2026-11-04T16:01:00Z' });
    const day = await routes(w, 'greg', { action: 'route_day', route_id: 'r-self' });
    const s = day.j.stops.find(x => x.dealer_id === 'd-ang');
    assert.ok(s.locked, JSON.stringify(s)); assert.deepStrictEqual(s.visit, { status: 'completed' });
  });
  await t('a failed access read refuses (503) instead of guessing', async () => {
    const S = standardSeed({ rep_routes: [], dealer_contacts: [ANG_CONTACT] }); S.failRead = tbl => (tbl === 'rep_routes' ? 500 : 0);
    const w2 = createWorld(S);
    const r = await routes(w2, 'greg', { action: 'previsit_draft', dealer_id: 'd-ang' });
    assert.strictEqual(r.status, 503, JSON.stringify(r.j));
  });
  console.log(`\nsr-access: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

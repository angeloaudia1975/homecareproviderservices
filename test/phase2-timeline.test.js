/* Phase 2D — the Dealer 360 Relationship Timeline (crm-api `timeline`, built by _timeline.js).

   Approved rules under test:
     · one chronological history per dealer, built at read time from the existing stores; nothing is
       written by reading it, no activity table, no writer changes
     · each thing appears ONCE: a visit with its note and activity row; a call with its note and activity
       row; an email with its logged activity row; an appointment with its meeting rows; a Golden order
       with its order activity rows
     · Golden / portal activity reduced to one line per portal per day, plus milestones: first sign-in
       ever, a sign-in after 30+ days away, a cart left open over $500, any order
     · newest first, 50 a page, Load older by date: nothing skipped, nothing repeated; filter chips
     · who may read it = who may open the dealer's Dealer 360 (a rep: their book; Relations and the
       President: any dealer; My Sales Workspace: Angelo's own book)
     · behind the `timeline` switch: off → the action refuses and Dealer 360 keeps the old 50-row list */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
const TLM = load('_timeline.js', createWorld(standardSeed()));

const H = 3600e3, DAY = 86400e3;
const NOW = Date.now();
const at = ms => new Date(NOW - ms).toISOString();
const WS = { 'x-hcps-workspace': 'mine' };
const TZ = 300;

function rich() {
  const D = 'd-greg';
  const v1 = at(2 * DAY), v1done = at(2 * DAY - H);
  const S = standardSeed({
    dealer_visit_reports: [
      { id: 'v1', dealer_id: D, rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: v1, completed_at: v1done, approved_at: v1done, duration_min: 45,
        visit_note_id: 'n-v1', followup_status: 'pending', summary: { meeting_summary: 'Met Rita and Bob about PR519 lift chairs.' } },
      { id: 'v-open', dealer_id: D, rep_email: 'greg@hcps.us', checkin_at: at(H), completed_at: null } ],          // not finished → not on the timeline
    dealer_visit_participants: [{ visit_report_id: 'v1', name_snapshot: 'Rita Owner' }, { visit_report_id: 'v1', name_snapshot: 'Bob Buyer' }, { visit_report_id: 'v1', name_snapshot: 'No Show', attended: false }],
    dealer_tasks: [
      { id: 'tv1', dealer_id: D, title: 'Send PR519 pricing', status: 'open', origin_type: 'visit_report', origin_id: 'v1', assigned_rep: 'Greg Campbell', created_at: v1done },
      { id: 'tv2', dealer_id: D, title: 'Bring samples', status: 'open', origin_type: 'visit_report', origin_id: 'v1', assigned_rep: 'Greg Campbell', created_at: v1done },
      { id: 't-done', dealer_id: D, title: 'Call about the PO', status: 'done', done_at: at(DAY), completed_by: 'greg@hcps.us', assigned_rep: 'Greg Campbell', created_at: at(6 * DAY) },
      { id: 't-dis', dealer_id: D, title: 'Old reminder', status: 'dismissed', done_at: at(20 * DAY), assigned_rep: 'Greg Campbell', created_at: at(25 * DAY) } ],
    opportunities: [
      { id: 'o-v1', dealer_id: D, title: '2 x PR519', stage: 'identified', status: 'open', value: 1798, origin_type: 'visit_report', origin_id: 'v1', owner_rep: 'Greg Campbell', created_at: v1done },
      { id: 'o-7', dealer_id: D, title: 'Scooter fleet', stage: 'quoted', status: 'open', value: 5000, owner_rep: 'Greg Campbell', created_at: at(7 * DAY) } ],
    dealer_notes: [
      { id: 'n-v1', dealer_id: D, kind: 'visit', body: '🚗 Dealer visit — summary', author_name: 'Greg Campbell', created_at: at(2 * DAY - H - 10 * 60e3) },   // written at approval, linked by visit_note_id
      { id: 'n-c1', dealer_id: D, kind: 'call', body: '📞 Call — interested', author_name: 'Greg Campbell', created_at: at(3 * DAY) },
      { id: 'n-lv', dealer_id: D, kind: 'visit', body: 'Legacy visit log', author_name: 'Greg Campbell', created_at: at(30 * DAY) },
      { id: 'n-1', dealer_id: D, kind: 'note', body: 'They are expanding to a second store.', author_name: 'Lori Hunt', created_at: at(12 * DAY) } ],
    call_outcomes: [{ id: 'c1', dealer_id: D, rep_name: 'Greg Campbell', outcome: 'interested', manufacturer: 'Golden', talked_to: 'Rita', rep_notes: 'Wants a demo', next_step: 'Book the demo', note_id: 'n-c1', called_at: at(3 * DAY) }],
    dealer_activity: [
      { id: 'a-v1', dealer_id: D, kind: 'visit', subject: 'Visit', ref_type: 'visit_report', ref_id: 'v1', created_at: v1 },
      { id: 'a-lv', dealer_id: D, kind: 'visit', subject: 'Legacy visit', created_at: at(30 * DAY) },
      { id: 'a-c1', dealer_id: D, kind: 'call', subject: 'Interested — Golden', created_at: at(3 * DAY - 30e3) },
      { id: 'a-e1', dealer_id: D, kind: 'email', subject: 'PR519 pricing', actor: 'greg@hcps.us', created_at: at(DAY + 9 * H) },
      { id: 'a-s1', dealer_id: D, kind: 'campaign', subject: 'Auto email: reorder_nudge', contact_email: 'g@glasgow.test', actor: 'Automation engine', created_at: at(4 * DAY - 60e3) },
      { id: 'a-s2', dealer_id: D, kind: 'email', subject: 'Visit follow-up sent', contact_email: 'g@glasgow.test', created_at: at(DAY + 2 * H) },
      { id: 'a-m1', dealer_id: D, kind: 'meeting', subject: 'Appointment booked — Demo', actor: 'Dealer Hub', created_at: at(15 * DAY) },
      { id: 'a-sys1', dealer_id: D, kind: 'system', subject: 'Line(s) activated: Golden Technologies', created_at: at(40 * DAY) },
      { id: 'a-sys2', dealer_id: D, kind: 'system', subject: 'Dealer added', created_at: at(300 * DAY) },
      { id: 'a-touch', dealer_id: D, kind: 'call', subject: 'Called about Strongback pricing', detail: 'Left a voicemail', actor: 'Lori Hunt', created_at: at(13 * DAY) },
      // Golden: one day with 3 sign-ins, 14 views, 2 added to cart; an order (2 rows) + a purchase; carts.
      ...Array.from({ length: 3 }, (_, i) => ({ id: 'g-s' + i, dealer_id: D, kind: 'golden', subject: 'Signed in to the Golden portal', actor: 'Golden portal', created_at: at(9 * DAY - i * H) })),
      ...Array.from({ length: 14 }, (_, i) => ({ id: 'g-v' + i, dealer_id: D, kind: 'golden', subject: 'Viewed PR519', created_at: at(9 * DAY - i * 60e3 - 30e3) })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: 'g-c' + i, dealer_id: D, kind: 'golden', subject: 'Added PR519 to cart', created_at: at(9 * DAY - 2 * H - i * 60e3) })),
      { id: 'g-ab-big', dealer_id: D, kind: 'golden', subject: 'Abandoned cart ($750)', created_at: at(9 * DAY - 3 * H) },
      { id: 'g-ab-small', dealer_id: D, kind: 'golden', subject: 'Abandoned cart ($200)', created_at: at(9 * DAY - 3 * H - 60e3) },
      { id: 'g-ord1', dealer_id: D, kind: 'golden', subject: 'Placed an order — $1,200 (#G-77)', created_at: at(5 * DAY) },
      { id: 'g-ord2', dealer_id: D, kind: 'golden', subject: 'Order completed — $1,200 (#G-77)', created_at: at(4 * DAY + 5 * H) },
      { id: 'g-buy', dealer_id: D, kind: 'golden', subject: 'Purchased PR519 ×2', created_at: at(5 * DAY - 60e3) },
      // Golden sign-in history: the first ever 100 days ago, then 60 days ago (40 days away), then the day above.
      { id: 'g-first', dealer_id: D, kind: 'golden', subject: 'Signed in to the Golden portal', created_at: at(100 * DAY) },
      { id: 'g-back', dealer_id: D, kind: 'golden', subject: 'Signed in to the Golden portal', created_at: at(60 * DAY) },
      { id: 'a-gfirst', dealer_id: D, kind: 'system', subject: 'Activated — first Golden sign-in', created_at: at(100 * DAY) } ],
    email_messages: [
      { id: 'm1', dealer_id: D, direction: 'outbound', subject: 'PR519 pricing', snippet: 'Hi Rita, here is the pricing…', mailbox_upn: 'greg@hcps.us', sent_at: at(DAY + 9 * H + 60e3), received_at: at(DAY + 9 * H + 60e3) },
      { id: 'm2', dealer_id: D, direction: 'inbound', subject: 'RE: PR519 pricing', snippet: 'Thanks, we will order.', from_name: 'Rita Owner', from_address: 'rita@glasgow.test', sent_at: at(DAY), received_at: at(DAY) } ],
    email_sends: [
      { id: 's1', dealer_id: D, template: 'reorder_nudge', contact_email: 'g@glasgow.test', sent_at: at(4 * DAY) },
      { id: 's2', dealer_id: D, template: 'visit_followup', contact_email: 'g@glasgow.test', sent_at: at(DAY + 2 * H + 30e3) } ],
    intent_events: [
      { dealer_id: D, source: 'email', event_type: 'email_open', occurred_at: at(4 * DAY - H) }, { dealer_id: D, source: 'email', event_type: 'email_open', occurred_at: at(4 * DAY - 2 * H) },
      { dealer_id: D, source: 'email', event_type: 'email_click', occurred_at: at(4 * DAY - 3 * H) },
      ...Array.from({ length: 3 }, (_, i) => ({ dealer_id: D, source: 'ordering', event_type: 'product_view', occurred_at: at(10 * DAY - i * 60e3) })),
      { dealer_id: D, source: 'golden', event_type: 'product_view', occurred_at: at(9 * DAY) } ],    // Golden intent rows are counted from the activity rows, not twice
    dealer_sessions: [
      { uid: 'u1', dealer_id: D, login_at: at(200 * DAY), last_seen_at: at(200 * DAY) },
      { uid: 'u1', dealer_id: D, login_at: at(10 * DAY), last_seen_at: at(10 * DAY) },
      { uid: 'u1', dealer_id: D, login_at: at(10 * DAY - H), last_seen_at: at(10 * DAY - H) } ],
    dealer_carts: [{ uid: 'u1', dealer_id: D, cart: { items: [{ qty: 2, p: { name: 'PR519', base_price: 620 } }] }, updated_at: at(6 * DAY) }],
    orders: [{ id: 'ord1', dealer_id: D, manufacturer: 'golden-technologies', status: 'submitted', subtotal: 2400, po_number: 'PO-9', submitted_at: at(8 * DAY) }],
    federation_orders: [
      { event_id: 'e1', dealer_id: D, external_order_id: 'G-77', order_total: 1200, line_count: 1, status: 'created', occurred_at: at(5 * DAY) },
      { event_id: 'e2', dealer_id: D, external_order_id: 'G-77', order_total: 1200, line_count: 1, status: 'completed', occurred_at: at(4 * DAY + 5 * H) } ],
    monthly_sales: [
      { dealer_id: D, manufacturer: 'golden-technologies', period: '2026-08-01', amount: 1000 }, { dealer_id: D, manufacturer: 'pride-mobility', period: '2026-08-01', amount: 500 },
      { dealer_id: D, manufacturer: 'golden-technologies', period: '2026-07-01', amount: 250 } ],
    service_requests: [{ id: 'sr1', dealer_id: D, service: 'Demo', meeting_type: 'Product demo', start_at: at(14 * DAY), created_at: at(15 * DAY), status: 'completed', rep_name: 'Greg Campbell' }],
    dealer_visits: [{ id: 'dv1', dealer_id: D, visit_report_id: 'v1', visited_at: v1 }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { adhoc_visit: true, timeline: true } }],
  });
  return S;
}
const W = (S) => createWorld(S || rich());
const TL = (w, extra, tok, ws) => call(load('crm-api.js', w), Object.assign({ action: 'timeline', dealer_id: 'd-greg', tz: TZ }, extra || {}), { token: tok || 'greg', headers: ws ? WS : {} });
const ids = r => r.body.events.map(e => e.id);
const byId = (r, id) => r.body.events.find(e => e.id === id);

async function all(w, extra, tok) {   // every page, in order
  const out = []; let before; let pages = 0;
  for (;;) { const r = await TL(w, Object.assign({}, extra || {}, before ? { before } : {}), tok); assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    out.push(...r.body.events); pages++; if (!r.body.next_before) break; assert.ok(!before || r.body.next_before < before, 'the cursor did not move back'); before = r.body.next_before; assert.ok(pages < 60, 'too many pages'); }
  return { events: out, pages };
}

(async () => {
  await t('Switch off: the action refuses, Dealer 360\'s list says so and keeps the old 50-row activity list', async () => {
    const S = rich(); S.tables.app_settings = [{ key: 'phase2_flags', value: { adhoc_visit: true, timeline: 'true' } }];
    const w = W(S);
    const r = await TL(w); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'flag_off');
    const l = await call(load('crm-api.js', w), { action: 'list', dealer_id: 'd-greg' }, { token: 'greg' });
    assert.strictEqual(l.body.timeline, false); assert.ok(l.body.activity.length > 0 && l.body.activity.length <= 50);
    const w2 = W(); const l2 = await call(load('crm-api.js', w2), { action: 'list', dealer_id: 'd-greg' }, { token: 'greg' });
    assert.strictEqual(l2.body.timeline, true);
  });

  await t('One entry per visit, with its attendees, tasks and deals; its note, its activity row and the legacy pair appear once', async () => {
    const w = W(); const { events } = await all(w);
    const I = events.map(e => e.id);
    assert.strictEqual(I.filter(x => x === 'visit:v1').length, 1);
    for (const gone of ['note:n-v1', 'act:a-v1', 'act:a-lv']) assert.ok(!I.includes(gone), gone + ' shown on its own');
    assert.ok(!I.includes('visit:v-open'), 'an unfinished visit is on the timeline');
    const v = events.find(e => e.id === 'visit:v1');
    assert.strictEqual(v.cat, 'visits'); assert.deepStrictEqual(v.ref, { type: 'visit_report', id: 'v1' });
    assert.ok(/Greg Campbell/.test(v.title) && /45 min/.test(v.title)); assert.ok(/Met Rita and Bob/.test(v.detail));
    assert.strictEqual(v.meta, 'With Rita Owner, Bob Buyer · 2 tasks · 1 deal · follow-up open');
    // The legacy visit (a note and an activity row written together, no report) shows once, as the note.
    assert.ok(I.includes('note:n-lv')); assert.strictEqual(events.find(e => e.id === 'note:n-lv').cat, 'visits');
  });

  await t('One entry per call (its note and activity row folded); a hand-logged call stays as it is', async () => {
    const w = W(); const { events } = await all(w); const I = events.map(e => e.id);
    assert.ok(I.includes('call:c1')); assert.ok(!I.includes('note:n-c1') && !I.includes('act:a-c1'));
    const c = events.find(e => e.id === 'call:c1'); assert.ok(/Call — interested · Golden/.test(c.title) && /Talked to Rita/.test(c.detail) && /Next: Book the demo/.test(c.meta), JSON.stringify(c));
    assert.strictEqual(events.find(e => e.id === 'act:a-touch').cat, 'calls');
  });

  await t('One entry per email: a sent Outlook email and its logged row; an engine send and its row; the visit follow-up send and its row', async () => {
    const w = W(); const { events } = await all(w); const I = events.map(e => e.id);
    for (const x of ['email:m1', 'email:m2', 'send:s1', 'send:s2']) assert.ok(I.includes(x), x);
    for (const x of ['act:a-e1', 'act:a-s1', 'act:a-s2']) assert.ok(!I.includes(x), x + ' shown twice');
    assert.ok(/^Email sent: PR519 pricing/.test(events.find(e => e.id === 'email:m1').title)); assert.ok(/^Email received: RE: PR519 pricing/.test(events.find(e => e.id === 'email:m2').title));
    const eng = events.find(e => e.kind === 'engage'); assert.ok(eng && eng.meta === '2 opens, 1 click', JSON.stringify(eng));
  });

  await t('Golden: one line for the day (sign-ins, 14 viewed, 2 added to cart, the small abandoned cart); milestones of their own; one entry per order', async () => {
    const w = W(); const { events } = await all(w); const I = events.map(e => e.id);
    const days = events.filter(e => e.kind === 'golden');
    assert.strictEqual(days.length, 1, JSON.stringify(days));
    // 3 sign-ins that day, but the first of them came 51 days after the last one: it is a milestone of
    // its own, so the day line counts the other 2. "3 added to cart" = 2 added + the $200 abandoned cart.
    assert.strictEqual(days[0].meta, '2 sign-ins, 14 products viewed, 3 added to cart', days[0].meta);
    assert.ok(!I.some(x => /^act:g-|^gact:g-v/.test(x)), 'raw Golden rows on the timeline');
    const titles = events.filter(e => e.kind === 'milestone').map(e => e.title);
    assert.ok(titles.includes('First sign-in to the Golden portal'), titles.join(' | '));
    assert.ok(titles.includes('Back on the Golden portal after 40 days'), titles.join(' | '));
    assert.ok(titles.includes('Back on the Golden portal after 51 days'), titles.join(' | '));
    assert.ok(titles.includes('Golden cart left open · $750'), titles.join(' | '));
    assert.ok(!titles.some(x => /\$200/.test(x)));
    const go = events.filter(e => e.kind === 'gorder'); assert.strictEqual(go.length, 1, JSON.stringify(go));
    assert.ok(/Golden order · \$1,200 \(#G-77\)/.test(go[0].title) && /completed/.test(go[0].meta));
    // "Activated — first Golden sign-in" is the same moment as that milestone: shown once, not twice.
    assert.ok(!I.includes('act:a-gfirst'), 'the first Golden sign-in shows twice');
    assert.strictEqual(titles.filter(x => /first golden sign-in|First sign-in to the Golden/i.test(x)).length, 1);
  });

  await t('HCPS ordering portal: first sign-in ever, back after 30+ days, a cart over $500, and one line for the day', async () => {
    const w = W(); const { events } = await all(w);
    const titles = events.filter(e => e.kind === 'milestone').map(e => e.title);
    assert.ok(titles.includes('First sign-in to the HCPS ordering portal'));
    assert.ok(titles.includes('Back on the ordering portal after 190 days'), titles.join(' | '));
    assert.ok(titles.includes('Ordering-portal cart left open · $1,240'), titles.join(' | '));
    const line = events.filter(e => e.kind === 'portal' && e.title === 'HCPS ordering portal');
    assert.strictEqual(line.length, 1); assert.strictEqual(line[0].meta, '1 sign-in, 3 products viewed');
  });

  await t('Tasks (added / completed / dismissed), deals, orders, monthly sales, appointments (meeting row folded), notes and system events', async () => {
    const w = W(); const { events } = await all(w); const I = events.map(e => e.id);
    for (const x of ['task-new:tv1', 'task-new:tv2', 'task-new:t-done', 'task-done:t-done', 'task-done:t-dis', 'deal:o-v1', 'deal:o-7', 'order:ord1', 'sales:2026-08', 'sales:2026-07', 'appt:sr1', 'note:n-1', 'act:a-sys1', 'act:a-sys2'])
      assert.ok(I.includes(x), x + ' missing');
    assert.ok(!I.includes('act:a-m1'), 'the booking row of the appointment shows twice');
    assert.ok(/Task dismissed: Old reminder/.test(byId({ body: { events } }, 'task-done:t-dis').title));
    assert.strictEqual(events.find(e => e.id === 'sales:2026-08').title, 'August 2026 sales · $1,500');
    assert.ok(/from a visit/.test(events.find(e => e.id === 'task-new:tv1').meta));
    // Newest first, and nothing in the future of the cursor.
    for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].at >= events[i].at, 'out of order at ' + i);
    assert.ok(events.every(e => Date.parse(e.at) <= Date.now() && e.id && e.title && e.cat && e.kind));
    // dealer_visits is never a separate entry.
    assert.ok(!I.some(x => /dv1/.test(x)));
  });

  await t('Filter chips: each returns only its own kind of entry', async () => {
    const w = W(); const everything = (await all(w)).events;
    for (const cat of ['visits', 'calls', 'emails', 'tasks', 'deals', 'orders', 'portal', 'notes']) {
      const r = await all(w, { filter: cat });
      assert.ok(r.events.length > 0, cat + ' is empty');
      assert.ok(r.events.every(e => e.cat === cat), cat + ': ' + r.events.filter(e => e.cat !== cat).map(e => e.id).join(','));
      assert.deepStrictEqual(r.events.map(e => e.id).sort(), everything.filter(e => e.cat === cat).map(e => e.id).sort(), cat + ' differs from the All view');
    }
    const r = await TL(w, { filter: 'bogus' }); assert.strictEqual(r.body.filter, 'all');
  });

  await t('Paging: 50 a page, newest first; Load older reaches the end with nothing skipped and nothing repeated (ties kept together)', async () => {
    const notes = Array.from({ length: 130 }, (_, i) => ({ id: 'pn' + String(i).padStart(3, '0'), dealer_id: 'd-greg', kind: 'note', body: 'n' + i, created_at: at((i + 1) * H) }));
    const same = at(50 * H + 1); notes.push({ id: 'tie1', dealer_id: 'd-greg', kind: 'note', body: 't', created_at: same }, { id: 'tie2', dealer_id: 'd-greg', kind: 'note', body: 't', created_at: same });
    const tasks = Array.from({ length: 70 }, (_, i) => ({ id: 'pt' + i, dealer_id: 'd-greg', title: 'T' + i, status: 'open', created_at: at((i + 1) * 2 * H + 1800e3) }));
    // Two more notes at exactly the time of the 50th entry: the first page must keep all three together.
    const t50 = notes.map(n => n.created_at).concat(tasks.map(x => x.created_at)).sort().reverse()[49];
    notes.push({ id: 'b50a', dealer_id: 'd-greg', kind: 'note', body: 'x', created_at: t50 }, { id: 'b50b', dealer_id: 'd-greg', kind: 'note', body: 'x', created_at: t50 });
    const S = standardSeed({ dealer_notes: notes, dealer_tasks: tasks, dealer_activity: [], app_settings: [{ key: 'phase2_flags', value: { timeline: true } }] });
    const w = W(S);
    const first = await TL(w); assert.ok(first.body.events.length >= 52 && first.body.events.length <= 53, String(first.body.events.length)); assert.ok(first.body.next_before);
    const { events, pages } = await all(w);
    const I = events.map(e => e.id);
    assert.strictEqual(new Set(I).size, I.length, 'an entry repeated across pages');
    assert.strictEqual(I.length, 134 + 70, 'entries skipped: ' + I.length);
    assert.ok(['b50a', 'b50b'].every(x => first.body.events.some(e => e.id === 'note:' + x)), 'entries at the same moment were split across pages');
    assert.ok(pages >= 4, pages + ' pages');
    for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].at >= events[i].at, 'out of order across pages at ' + i);
    // Filter + paging together.
    const tk = await all(w, { filter: 'tasks' }); assert.strictEqual(tk.events.length, 70); assert.strictEqual(new Set(tk.events.map(e => e.id)).size, 70);
  });

  await t('Paging a heavy Golden dealer (more rows than one read takes): every day line once, every view counted', async () => {
    const rows = []; const N = 3500;
    for (let i = 0; i < N; i++) rows.push({ id: 'hv' + i, dealer_id: 'd-greg', kind: 'golden', subject: 'Viewed PR' + (i % 7), created_at: at(DAY + Math.floor(i / 100) * DAY + (i % 100) * 60e3) });
    const S = standardSeed({ dealer_activity: rows, app_settings: [{ key: 'phase2_flags', value: { timeline: true } }] });   // the fake returns at most 1000 rows a read, like Supabase
    const w = W(S);
    const { events } = await all(w, { filter: 'portal' });
    const lines = events.filter(e => e.kind === 'golden');
    assert.strictEqual(new Set(lines.map(e => e.id)).size, lines.length, 'a day line repeated');
    assert.strictEqual(lines.length, 35, lines.length + ' day lines');
    const total = lines.reduce((a, e) => a + Number((/(\d+) products viewed/.exec(e.meta) || [])[1] || 0), 0);
    assert.strictEqual(total, N, 'views counted ' + total);
  });

  await t('Monthly sales with more rows than one read returns (1000): every month reaches the Orders view, once', async () => {
    const rows = []; for (let m = 0; m < 30; m++) for (let k = 0; k < 50; k++) { const d = new Date(Date.UTC(2026, 8 - m, 1)); rows.push({ dealer_id: 'd-greg', manufacturer: 'line-' + (k % 5), period: d.toISOString().slice(0, 10), amount: 10 }); }
    const S = standardSeed({ monthly_sales: rows, app_settings: [{ key: 'phase2_flags', value: { timeline: true } }] });
    const w = W(S);
    for (const f of ['orders', 'all']) {
      const { events, pages } = await all(w, { filter: f });
      const months = events.filter(e => e.kind === 'sales');
      assert.strictEqual(months.length, 30, `${f}: ${months.length} months in ${pages} pages`); assert.strictEqual(new Set(months.map(e => e.id)).size, 30);
      assert.ok(months.every(e => / · \$500$/.test(e.title)), f + ': a month was cut short: ' + months.map(e => e.title).join(' | '));
    }
  });

  await t('Who may read it: Greg his book only; Lori and the President any dealer; My Sales Workspace Angelo\'s own book; no token → 401', async () => {
    const w = W();
    assert.strictEqual((await TL(w, {}, 'greg')).status, 200);
    for (const d of ['d-none', 'd-ang']) assert.strictEqual((await TL(w, { dealer_id: d }, 'greg')).status, 403, d);
    for (const tok of ['lori', 'pres']) for (const d of ['d-greg', 'd-none', 'd-ang']) assert.strictEqual((await TL(w, { dealer_id: d }, tok)).status, 200, tok + ' ' + d);
    assert.strictEqual((await TL(w, { dealer_id: 'd-greg' }, 'pres', true)).status, 403, 'workspace reached another rep\'s dealer');
    assert.strictEqual((await TL(w, { dealer_id: 'd-ang' }, 'pres', true)).status, 200);
    assert.strictEqual((await call(load('crm-api.js', w), { action: 'timeline', dealer_id: 'd-greg' }, {})).status, 401);
    // The same answer as Dealer 360's own list for every one of them.
    for (const [tok, ws, d] of [['greg', false, 'd-none'], ['pres', true, 'd-greg'], ['lori', false, 'd-none']]) {
      const l = await call(load('crm-api.js', w), { action: 'list', dealer_id: d }, { token: tok, headers: ws ? WS : {} });
      assert.strictEqual(l.status, (await TL(w, { dealer_id: d }, tok, ws)).status, `${tok} ${d}`);
    }
  });

  await t('Read-only: building the timeline writes nothing; a missing source table just leaves its entries out', async () => {
    const w = W(); const n = w.writes.length;
    await all(w); for (const f of ['visits', 'emails', 'orders', 'portal']) await all(w, { filter: f });
    assert.strictEqual(w.writes.length, n, JSON.stringify(w.writes.slice(n)).slice(0, 300));
    const S = rich(); S.missingTables = ['call_outcomes', 'federation_orders', 'email_messages', 'dealer_sessions'];
    const w2 = W(S); const { events } = await all(w2); const I = events.map(e => e.id);
    assert.ok(I.includes('visit:v1') && I.includes('send:s1') && I.includes('note:n-c1'), 'the rest of the timeline is gone');
    assert.ok(!I.some(x => /^call:|^email:|^gorder:x/.test(x)));
    assert.ok(I.includes('gact:g-ord1') && I.includes('gact:g-ord2'), 'Golden order rows without their order table should still show');
  });

  await t('build() alone: the floor never lets a capped source skip rows, and day lines group by the person\'s own day', () => {
    // A notes read that came back full (40 of 40) and an older visit: the visit waits for the next page
    // (which starts just above the oldest note), it is not lost; the oldest note waits with it.
    const notes = Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, kind: 'note', body: 'b', created_at: new Date(NOW - (i + 1) * H).toISOString() }));
    const raw = { notes: { rows: notes, cap: 40, kind: 'simple', col: 'created_at' }, visits: { rows: [{ id: 'old', checkin_at: new Date(NOW - 200 * H).toISOString(), completed_at: new Date(NOW - 199 * H).toISOString() }], cap: TLM.CAP, kind: 'simple', col: 'checkin_at' } };
    const out = TLM.build(raw, { before: NOW, tz: TZ, cat: 'all' });
    assert.ok(!out.events.some(e => e.id === 'visit:old')); assert.strictEqual(out.events.length, 39); assert.ok(!out.events.some(e => e.id === 'note:x39'));
    assert.strictEqual(out.next_before, new Date(Date.parse(notes[39].created_at) + 1).toISOString());
    // Not full: everything shows and the end is reached.
    const out1 = TLM.build({ notes: { rows: notes, cap: 60, kind: 'simple', col: 'created_at' }, visits: raw.visits }, { before: NOW, tz: TZ, cat: 'all' });
    assert.strictEqual(out1.events.length, 41); assert.strictEqual(out1.next_before, null);
    // Two portal views at 23:30 and 00:30 Eastern are two days, though the same UTC day.
    const ev = ['2026-10-04T03:30:00.000Z', '2026-10-04T04:30:00.000Z'];
    const raw2 = { golden: { rows: ev.map((c, i) => ({ id: 'g' + i, subject: 'Viewed X', created_at: c })), cap: 3000, kind: 'roll', col: 'created_at' } };
    const out2 = TLM.build(raw2, { before: Date.parse('2026-10-05T00:00:00Z'), tz: 240, cat: 'portal' });
    assert.deepStrictEqual(out2.events.map(e => e.id).sort(), ['golden:2026-10-03', 'golden:2026-10-04']);
    assert.strictEqual(out2.next_before, null);
    // Sign-in milestones: 31 days away is one, 20 days is not; the oldest is "first ever" only when the
    // read holds the whole history.
    const si = [0, 20, 51].map(d => ({ id: 's' + d, created_at: new Date(NOW - (60 - d) * DAY).toISOString() }));
    const b3 = cap => TLM.build({ gold_signins: { rows: si, cap, kind: 'meta', col: 'created_at' } }, { before: NOW, tz: TZ, cat: 'portal' }).events.map(e => e.title);
    assert.deepStrictEqual(b3(200), ['Back on the Golden portal after 31 days', 'First sign-in to the Golden portal']);
    assert.deepStrictEqual(b3(3), ['Back on the Golden portal after 31 days']);
    // Without a computed first sign-in, the writer's "Activated" row stands in for it (under Portal).
    const act = [{ id: 'sys', kind: 'system', subject: 'Activated — first Golden sign-in', created_at: si[0].created_at }];
    const b4 = cap => TLM.build({ gold_signins: { rows: si, cap, kind: 'meta', col: 'created_at' }, activity: { rows: act, cap: 120, kind: 'simple', col: 'created_at' } }, { before: NOW, tz: TZ, cat: 'all' }).events.map(e => e.id + '|' + e.cat);
    assert.ok(!b4(200).includes('act:sys|portal')); assert.ok(b4(3).includes('act:sys|portal'));
  });

  done('Phase 2D relationship timeline');
})();

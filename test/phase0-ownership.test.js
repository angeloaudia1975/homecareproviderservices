/* Phase 0B.4: a rep cannot reach a record just by knowing its id. Every case runs the real
   handler. Greg (rep) owns Glasgow (+ its branch) and the directory-only dealer; Angelo
   (president) owns Retail Medical Solutions; Lori is relations (sees all — unchanged in 0B). */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const notDenied = (r, msg) => assert.ok(r.status !== 403 && r.status !== 401, (msg || '') + ' was refused: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 160));
const denied = (r, msg) => assert.strictEqual(r.status, 403, (msg || '') + ' should be 403, got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 160));

function seed() {
  const S = standardSeed({
    dealer_tasks: [
      { id: 't-ang', dealer_id: 'd-ang', title: 'Angelo task', status: 'open', priority: 'normal', assigned_rep: 'Angelo Audia' },
      { id: 't-greg', dealer_id: 'd-greg', title: 'Greg task', status: 'open', priority: 'normal', assigned_rep: 'Greg Campbell' },
      { id: 't-greg-on-ang', dealer_id: 'd-ang', title: 'Greg asked to help', status: 'open', priority: 'normal', assigned_rep: 'Greg Campbell' },
    ],
    dealer_contacts: [
      { id: 'c-ang', dealer_id: 'd-ang', email: 'buyer@rms.test', name: 'RMS Buyer', title: 'Owner', phone: '111' },
      { id: 'c-greg', dealer_id: 'd-greg', email: 'buyer@glasgow.test', name: 'Bryant', title: 'Pharmacist', phone: '222' },
    ],
    opportunities: [
      { id: 'o-ang', dealer_id: 'd-ang', title: 'RMS deal', stage: 'identified', status: 'open', owner_rep: 'Angelo Audia', value: 1000 },
      { id: 'o-greg', dealer_id: 'd-greg', title: 'Glasgow deal', stage: 'identified', status: 'open', owner_rep: 'Greg Campbell', value: 500 },
      { id: 'o-blank', dealer_id: null, title: 'Unowned deal', stage: 'identified', status: 'open', owner_rep: null, value: 9 },
    ],
    email_messages: [
      { id: 'm-ang', dealer_id: 'd-ang', graph_id: 'g1', mailbox_upn: 'angelo@hcps.us', subject: 'Pricing', direction: 'inbound', received_at: '2026-09-01' },
      { id: 'm-greg-box', dealer_id: null, graph_id: 'g2', mailbox_upn: 'greg@hcps.us', subject: 'Mine', direction: 'inbound', received_at: '2026-09-01' },
      { id: 'm-greg', dealer_id: 'd-greg', graph_id: 'g3', mailbox_upn: 'angelo@hcps.us', subject: 'Glasgow', direction: 'inbound', received_at: '2026-09-01' },
    ],
    rep_routes: [
      { id: 'r-greg', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', name: 'KY loop', scheduled_date: '2026-10-05', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }, { dealer_id: 'd-ang', name: 'RMS ride-along' }] },
      { id: 'r-ang', owner_email: 'angelo@hcps.us', name: 'TN loop', scheduled_date: '2026-10-06', stops: [{ dealer_id: 'd-none', name: 'Nobody' }] },
    ],
    dealer_visit_reports: [
      { id: 'v-none', route_id: 'r-ang', dealer_id: 'd-none', rep_email: 'angelo@hcps.us', status: 'completed', fields: { notes: 'secret notes' } },
    ],
    service_requests: [
      { id: 'sr-ang', dealer_id: 'd-ang', status: 'requested', service: 'Demo', company: 'RMS', email: 'r@rms.test', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia' },
      { id: 'sr-greg', dealer_id: 'd-greg', status: 'requested', service: 'Demo', company: 'Glasgow', email: 'g@glasgow.test', owner_email: null, rep_name: 'Greg Campbell' },
      { id: 'sr-open', dealer_id: null, status: 'requested', service: 'Demo', company: 'New prospect', email: 'p@new.test', owner_email: null, rep_name: null },
    ],
    dealer_engagement: [
      { dealer_id: 'd-ang', status: 'healthy', score: 80, rep_name: 'Angelo Audia', total_sales: 10 },
      { dealer_id: 'd-none', status: 'dormant', score: 10, rep_name: '', total_sales: 1 },
      { dealer_id: 'd-greg', status: 'watch', score: 50, rep_name: 'Greg Campbell', total_sales: 5 },
    ],
    orders: [ { id: 'ord-ang', dealer_id: 'd-ang', manufacturer: 'golden', status: 'submitted', subtotal: 10, order_items: [] } ],
    monthly_sales: [
      { id: 1, dealer_id: 'd-ang', manufacturer: 'golden', period: '2026-08-01', amount: 100, commission: 5, customer_name: 'Retail Medical Solutions' },
      { id: 2, dealer_id: 'd-greg', manufacturer: 'golden', period: '2026-08-01', amount: 50, commission: 2, customer_name: 'Glasgow Prescription Center' },
    ],
    manufacturers: [{ slug: 'golden', name: 'Golden Technologies' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }],
  });
  S.tokens.blank = 'blank@hcps.us';
  S.tables.staff_users.push({ email: 'blank@hcps.us', name: 'No Book', role: 'rep', rep_name: '', active: true });
  return S;
}

(async () => {
  /* ── email-sync-api ── */
  await t('email: a rep cannot read another rep\'s dealer timeline', async () => {
    const w = createWorld(seed()); const m = load('email-sync-api.js', w);
    denied(await call(m, { action: 'dealer', dealer_id: 'd-ang' }, { token: 'greg' }));
    notDenied(await call(m, { action: 'dealer', dealer_id: 'd-greg' }, { token: 'greg' }), 'own dealer');
    notDenied(await call(m, { action: 'dealer', dealer_id: 'd-ang' }, { token: 'lori' }), 'relations (unchanged in 0B)');
    notDenied(await call(m, { action: 'dealer', dealer_id: 'd-ang' }, { token: 'pres' }), 'president');
  });
  await t('email: a rep cannot open a message body from someone else\'s dealer or mailbox', async () => {
    const w = createWorld(seed()); const m = load('email-sync-api.js', w);
    denied(await call(m, { action: 'message', id: 'm-ang' }, { token: 'greg' }), 'other dealer, other mailbox');
    notDenied(await call(m, { action: 'message', id: 'm-greg' }, { token: 'greg' }), 'own dealer');
    notDenied(await call(m, { action: 'message', id: 'm-greg-box' }, { token: 'greg' }), 'own mailbox, unmatched');
    notDenied(await call(m, { action: 'message', id: 'm-ang' }, { token: 'pres' }), 'president');
  });
  await t('email: a rep cannot log a send onto another rep\'s dealer', async () => {
    const w = createWorld(seed()); const m = load('email-sync-api.js', w);
    denied(await call(m, { action: 'send', dealer_id: 'd-ang', to: 'buyer@rms.test', subject: 's', body_text: 'b' }, { token: 'greg' }));
    assert.ok(!w.outbound.some(x => x.kind === 'graph' && /sendMail/.test(x.url)), 'nothing may be sent when refused');
    notDenied(await call(m, { action: 'send', dealer_id: 'd-greg', to: 'buyer@glasgow.test', subject: 's', body_text: 'b' }, { token: 'greg' }), 'own dealer');
  });

  /* ── crm-api tasks + contacts ── */
  await t('tasks: a rep cannot complete, reopen or dismiss another rep\'s task by id', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    for (const action of ['complete_task', 'reopen_task', 'dismiss_task']) denied(await call(m, { action, id: 't-ang' }, { token: 'greg' }), action);
    assert.strictEqual(w.db.dealer_tasks.find(x => x.id === 't-ang').status, 'open', 'task must be untouched');
    notDenied(await call(m, { action: 'complete_task', id: 't-greg' }, { token: 'greg' }), 'own task');
    assert.strictEqual(w.db.dealer_tasks.find(x => x.id === 't-greg').status, 'done');
    notDenied(await call(m, { action: 'complete_task', id: 't-greg-on-ang' }, { token: 'greg' }), 'task assigned to him on another dealer');
    notDenied(await call(m, { action: 'complete_task', id: 't-ang' }, { token: 'pres' }), 'president');
  });
  await t('tasks: an unknown task id is a 404, not a silent success', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    const r = await call(m, { action: 'complete_task', id: 'nope' }, { token: 'greg' });
    assert.strictEqual(r.status, 404);
  });
  await t('contacts: a rep cannot edit or delete another dealer\'s contact through his own dealer id', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    let r = await call(m, { action: 'save_contact', dealer_id: 'd-greg', id: 'c-ang', name: 'Hijacked' }, { token: 'greg' });
    assert.ok(r.status === 403 || r.status === 404, 'edit got ' + r.status);
    assert.strictEqual(w.db.dealer_contacts.find(x => x.id === 'c-ang').name, 'RMS Buyer');
    r = await call(m, { action: 'delete_contact', dealer_id: 'd-greg', id: 'c-ang' }, { token: 'greg' });
    assert.ok(r.status === 403 || r.status === 404, 'delete got ' + r.status);
    assert.ok(w.db.dealer_contacts.find(x => x.id === 'c-ang'), 'contact must survive');
    notDenied(await call(m, { action: 'save_contact', dealer_id: 'd-greg', id: 'c-greg', name: 'Bryant L.' }, { token: 'greg' }), 'own contact');
    assert.strictEqual(w.db.dealer_contacts.find(x => x.id === 'c-greg').name, 'Bryant L.');
  });

  await t('contacts: an id must belong to the dealer it is edited under, even for the president', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    const r = await call(m, { action: 'save_contact', dealer_id: 'd-greg', id: 'c-ang', name: 'Moved' }, { token: 'pres' });
    assert.strictEqual(r.status, 403, 'mismatched dealer/contact got ' + r.status);
    assert.strictEqual(w.db.dealer_contacts.find(x => x.id === 'c-ang').name, 'RMS Buyer');
  });

  /* ── pipeline-api ── */
  await t('pipeline: a rep cannot add a deal on another rep\'s dealer or edit another rep\'s deal', async () => {
    const w = createWorld(seed()); const m = load('pipeline-api.js', w);
    denied(await call(m, { action: 'add', dealer_id: 'd-ang', title: 'x' }, { token: 'greg' }), 'add on other dealer');
    denied(await call(m, { action: 'update', id: 'o-ang', stage: 'won' }, { token: 'greg' }), 'update other deal');
    assert.strictEqual(w.db.opportunities.find(x => x.id === 'o-ang').stage, 'identified');
    notDenied(await call(m, { action: 'update', id: 'o-greg', stage: 'contacted' }, { token: 'greg' }), 'own deal');
    notDenied(await call(m, { action: 'add', dealer_id: 'd-greg', title: 'mine' }, { token: 'greg' }), 'own dealer');
    notDenied(await call(m, { action: 'update', id: 'o-ang', stage: 'contacted' }, { token: 'pres' }), 'president');
  });
  await t('pipeline: a rep cannot hand a deal to someone else', async () => {
    const w = createWorld(seed()); const m = load('pipeline-api.js', w);
    await call(m, { action: 'update', id: 'o-greg', owner_rep: 'Angelo Audia' }, { token: 'greg' });
    assert.strictEqual(w.db.opportunities.find(x => x.id === 'o-greg').owner_rep, 'Greg Campbell');
    const r = await call(m, { action: 'add', dealer_id: 'd-greg', title: 'mine', owner_rep: 'Angelo Audia' }, { token: 'greg' });
    const made = w.db.opportunities.find(x => x.title === 'mine');
    assert.ok(made && made.owner_rep === 'Greg Campbell', 'owner forced to the rep: ' + JSON.stringify(made));
  });
  await t('pipeline: a rep with no book sees no deals (no blank-name match)', async () => {
    const w = createWorld(seed()); const m = load('pipeline-api.js', w);
    const r = await call(m, { action: 'board' }, { token: 'blank' });
    const list = (r.body && (r.body.opportunities || r.body.opps || r.body.list)) || [];
    assert.ok(!list.some(o => o.id === 'o-blank'), 'blank rep_name matched an unowned deal');
  });

  /* ── schedule-api ── */
  await t('scheduling: a rep cannot work another rep\'s appointment or book into someone else\'s calendar', async () => {
    const w = createWorld(seed()); const m = load('schedule-api.js', w);
    for (const action of ['cancel', 'complete', 'reopen']) denied(await call(m, { action, id: 'sr-ang' }, { token: 'greg' }), action);
    denied(await call(m, { action: 'assign', id: 'sr-greg', rep_email: 'angelo@hcps.us', date: '2026-10-07', time: '10:00 AM', override_hours: true }, { token: 'greg' }), 'booking for someone else');
    denied(await call(m, { action: 'set_dealer', id: 'sr-open', dealer_id: 'd-ang' }, { token: 'greg' }), 'linking to another rep\'s dealer');
    notDenied(await call(m, { action: 'complete', id: 'sr-greg' }, { token: 'greg' }), 'own dealer request');
    notDenied(await call(m, { action: 'cancel', id: 'sr-ang' }, { token: 'pres' }), 'president');
  });
  await t('scheduling: a rep\'s queue shows his requests and unclaimed ones, not other reps\'', async () => {
    const w = createWorld(seed()); const m = load('schedule-api.js', w);
    const r = await call(m, { action: 'queue' }, { token: 'greg' });
    const ids = (r.body.requests || []).map(x => x.id).sort();
    assert.deepStrictEqual(ids, ['sr-greg', 'sr-open']);
    const p = await call(m, { action: 'queue' }, { token: 'pres' });
    assert.strictEqual((p.body.requests || []).length, 3);
  });

  /* ── routes-api dealer actions ── */
  await t('routes: dealer actions are refused for dealers off the rep\'s book and off his routes', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    for (const [action, extra] of [['log_visit', {}], ['save_visit', { details: {} }], ['visit_report_get', {}], ['notify_visit', {}], ['previsit_draft', {}], ['send_followup', { body: 'x' }], ['generate_followup', {}]])
      denied(await call(m, Object.assign({ action, dealer_id: 'd-none' }, extra), { token: 'greg' }), action);
    denied(await call(m, { action: 'business_case', dealer_ids: ['d-none'] }, { token: 'greg' }), 'business_case');
    assert.ok(!w.writes.some(x => x.table === 'dealer_visits'), 'nothing may be written');
  });
  await t('routes: a stop on a route assigned to the rep is workable even off his book', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    notDenied(await call(m, { action: 'previsit_draft', dealer_id: 'd-ang' }, { token: 'greg' }), 'ride-along stop');
    notDenied(await call(m, { action: 'previsit_draft', dealer_id: 'd-greg' }, { token: 'greg' }), 'own dealer');
  });
  await t('routes: a visit report needs a real route the rep can see, with that dealer on it', async () => {
    const w = createWorld(seed()); const m = load('routes-api.js', w);
    let r = await call(m, { action: 'visit_report_save', route_id: 'no-such-route', dealer_id: 'd-greg', status: 'in_progress', fields: {} }, { token: 'greg' });
    assert.strictEqual(r.status, 404, 'fake route id must not bypass the check, got ' + r.status);
    r = await call(m, { action: 'visit_checkin', route_id: 'r-greg', dealer_id: 'd-dir-greg' }, { token: 'greg' });
    denied(r, 'dealer not on that route');
    r = await call(m, { action: 'visit_report_get', route_id: 'r-ang', dealer_id: 'd-none' }, { token: 'greg' });
    denied(r, 'someone else\'s route');
    notDenied(await call(m, { action: 'visit_checkin', route_id: 'r-greg', dealer_id: 'd-greg' }, { token: 'greg' }), 'own stop');
  });

  /* ── management-only tools ── */
  await t('sales import is management only', async () => {
    const w = createWorld(seed()); const m = load('sales-import-api.js', w);
    denied(await call(m, { action: 'dealers' }, { token: 'greg' }), 'rep');
    denied(await call(m, { action: 'add_alias', company: 'X', dealer_id: 'd-ang' }, { token: 'lori' }), 'relations');
    notDenied(await call(m, { action: 'dealers' }, { token: 'pres' }), 'president');
  });
  await t('platform mode is management only', async () => {
    const w = createWorld(seed()); const m = load('platform-api.js', w);
    denied(await call(m, { action: 'set', mode: 'sandbox' }, { token: 'greg' }), 'rep');
    denied(await call(m, { action: 'set', mode: 'sandbox' }, { token: 'lori' }), 'relations');
    notDenied(await call(m, { action: 'get' }, { token: 'greg' }), 'reading the mode');
  });
  await t('Audiences, Campaign Studio and CardChamp refuse the rep role', async () => {
    for (const [fn, body] of [['audiences-api.js', { action: 'contacts' }], ['audiences-api.js', { action: 'set_contact', dealer_id: 'd-ang', email: 'x@y.test' }], ['campaign-api.js', { action: 'list' }], ['partner-api.js', { action: 'report' }]]) {
      const w = createWorld(seed()); const m = load(fn, w);
      denied(await call(m, body, { token: 'greg' }), fn + ' ' + body.action);
      const r = await call(m, body, { token: 'lori' });
      assert.ok(r.status !== 403, fn + ' relations unchanged in 0B, got ' + r.status);
    }
  });

  /* ── dealers-api ── */
  await t('Dealer Manager: rep edits use the shared scope, and portal access is checked', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    denied(await call(m, { action: 'portal_access', dealer_id: 'd-ang' }, { token: 'greg' }), 'portal_access');
    denied(await call(m, { action: 'edit', dealer_id: 'd-ang', patch: { phone: '1' } }, { token: 'greg' }), 'edit other');
    notDenied(await call(m, { action: 'edit', dealer_id: 'd-greg', patch: { phone: '1' } }, { token: 'greg' }), 'edit own (dealers.rep_name)');
    notDenied(await call(m, { action: 'edit', dealer_id: 'd-greg-branch', patch: { phone: '1' } }, { token: 'greg' }), 'edit own branch (family)');
  });

  /* ── read leaks ── */
  await t('orders: a rep with no book sees no orders', async () => {
    const w = createWorld(seed()); const m = load('orders-admin.js', w);
    const r = await call(m, { action: 'list' }, { token: 'blank' });
    assert.strictEqual((r.body.orders || []).length, 0, 'blank rep_name saw ' + (r.body.orders || []).length);
  });
  await t('health: a rep with no book sees no dealers', async () => {
    const w = createWorld(seed()); const m = load('health-api.js', w);
    const r = await call(m, null, { method: 'GET', token: 'blank' });
    assert.strictEqual((r.body.rows || []).length, 0, 'blank rep_name saw ' + (r.body.rows || []).length);
  });
  await t('analytics: a rep receives contact details only for his own dealers', async () => {
    const w = createWorld(seed()); const m = load('analytics.js', w);
    const r = await call(m, null, { method: 'GET', token: 'greg' });
    const info = r.body.dealerInfo || {};
    assert.ok(!info['Retail Medical Solutions'], 'another rep\'s dealer contact leaked');
    assert.ok(info['Glasgow Prescription Center'], 'own dealer must stay');
    assert.ok(!(r.body.assignments || []).some(a => a.rep_name === 'Angelo Audia'), 'other assignments leaked');
    const p = await call(m, null, { method: 'GET', token: 'pres' });
    assert.ok((p.body.dealerInfo || {})['Retail Medical Solutions'], 'president keeps everything');
  });

  done('0B.4 record ownership');
})();

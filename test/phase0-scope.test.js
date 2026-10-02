/* Phase 0D: one owner per dealer (dealers.rep_email), one resolver (_scope.js), one writer.
   Resolver cases run _scope.js directly against the fake database; the rest run the real
   handlers. Greg (rep) owns by EMAIL; several rows carry deliberately stale or conflicting names
   so a test fails if any reader still trusts the name or the legacy directory over the email. */
const assert = require('assert');
const { createWorld, load, call, t, done, BASE, ORDER_REPO } = require('./phase0-mock');

const STAFF = [
  { email: 'angelo@hcps.us', name: 'Angelo Audia', role: 'president', rep_name: 'Angelo Audia', active: true, can_travel: true },
  { email: 'greg@hcps.us', name: 'Greg Campbell', role: 'rep', rep_name: 'Greg Campbell', active: true, can_travel: true },
  { email: 'lori@hcps.us', name: 'Lori Hunt', role: 'relations', rep_name: 'Lori Hunt', active: true },
];
const DEALERS = [
  { id: 'd-g1', business_name: 'Greg Email Dealer', rep_name: 'Greg Campbell', rep_email: 'greg@hcps.us', state: 'KY' },
  { id: 'd-stale', business_name: 'Stale Name Dealer', rep_name: 'Old Name', rep_email: 'greg@hcps.us', state: 'KY' },          // email wins
  { id: 'd-conflict', business_name: 'Angelo Email Dealer', rep_name: 'Greg Campbell', rep_email: 'angelo@hcps.us', state: 'TN' }, // email wins
  { id: 'd-hq', business_name: 'Greg HQ', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', state: 'KY' },
  { id: 'd-hq-open', business_name: 'Greg HQ North', parent_id: 'd-hq', state: 'KY' },                                              // family -> Greg
  { id: 'd-hq-ang', business_name: 'Greg HQ South', parent_id: 'd-hq', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', state: 'KY' }, // explicit branch stays Angelo's
  { id: 'd-quipt', business_name: 'Quipt HQ', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', state: 'TN' },
  { id: 'd-care', business_name: 'Care Medical aka MyQuipt', parent_id: 'd-quipt', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', state: 'TN' }, // Greg's branch; HQ not
  { id: 'd-dir', business_name: 'Directory Only Co', state: 'KY' },                                                               // directory -> Greg
  { id: 'd-named', business_name: 'Named Dealer', rep_name: 'Angelo Audia', state: 'TN' },                                         // row beats directory
  { id: 'd-house', business_name: 'HomeCare Provider Services', rep_name: 'House (unassigned)', state: 'TN' },
  { id: 'd-none', business_name: 'Nobody Co', state: 'OH' },
];
const DIR = [
  { dealer_name: 'Directory Only Co', rep_name: 'Greg Campbell' },
  { dealer_name: 'Named Dealer', rep_name: 'Greg Campbell' },
  { dealer_name: 'Greg Email Dealer', rep_name: 'Greg Campbell' },
  { dealer_name: 'Raw Sales Name LLC', rep_name: 'Greg Campbell' },   // a sales name that is no dealer
];
const GREG_BOOK = ['d-g1', 'd-stale', 'd-hq', 'd-hq-open', 'd-care', 'd-dir'].sort();

function seed(extra) {
  const S = {
    tokens: { pres: 'angelo@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', renamed: 'greg@hcps.us' },
    authUsers: ['angelo@hcps.us', 'greg@hcps.us', 'lori@hcps.us'],
    tables: {
      staff_users: STAFF.map(s => ({ ...s })), dealers: DEALERS.map(d => ({ parent_id: null, rep_name: null, rep_email: null, ...d })),
      dealer_directory: DIR.map(x => ({ ...x })),
      dealer_tasks: [
        { id: 't-g1-greg', dealer_id: 'd-g1', status: 'open', title: 'Greg task', assigned_rep: 'Greg Campbell' },
        { id: 't-g1-none', dealer_id: 'd-g1', status: 'open', title: 'Engine task', assigned_rep: null },
        { id: 't-g1-lori', dealer_id: 'd-g1', status: 'open', title: 'Lori helps', assigned_rep: 'Lori Hunt' },
        { id: 't-g1-done', dealer_id: 'd-g1', status: 'done', title: 'Old task', assigned_rep: 'Greg Campbell' },
        { id: 't-stale-greg', dealer_id: 'd-stale', status: 'open', title: 'Other dealer', assigned_rep: 'Greg Campbell' },
      ],
      opportunities: [
        { id: 'o-g1-open', dealer_id: 'd-g1', status: 'open', stage: 'identified', title: 'Open deal', owner_rep: 'Greg Campbell', value: 100 },
        { id: 'o-g1-won', dealer_id: 'd-g1', status: 'won', stage: 'won', title: 'Won deal', owner_rep: 'Greg Campbell', value: 100 },
        { id: 'o-g1-lori', dealer_id: 'd-g1', status: 'open', stage: 'identified', title: 'Lori deal', owner_rep: 'Lori Hunt', value: 100 },
      ],
      dealer_engagement: DEALERS.map(d => ({ dealer_id: d.id, status: 'watch', score: 50, rep_name: 'Stale Cache Name', total_sales: 1 })),
      orders: DEALERS.map(d => ({ id: 'ord-' + d.id, dealer_id: d.id, manufacturer: 'golden', status: 'submitted', subtotal: 1, order_items: [] })),
      monthly_sales: DEALERS.map((d, i) => ({ id: i + 1, dealer_id: d.id, manufacturer: 'golden', period: '2026-08-01', amount: 10, commission: 1, customer_name: d.business_name, rep_name: 'Stale Sale Name' })),
      dealer_addresses: DEALERS.map(d => ({ dealer_id: d.id, address: '1 Main', city: 'X', state: d.state, zip: '00000', label: 'Main', pri: 1, addr_key: d.id })),
      manufacturers: [{ slug: 'golden', name: 'Golden Technologies' }],
      app_settings: [{ key: 'platform', value: { mode: 'development' } }],
      dealer_intent: DEALERS.map(d => ({ dealer_id: d.id, score_total: 50, tier: 'high', top_manufacturer: 'golden' })),
    },
  };
  if (extra) extra(S);
  return S;
}
function db(w) {
  const sbGet = async p => { const r = await w.fetch(BASE + '/rest/v1/' + p); if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + await r.text()); return r.json(); };
  const sbSend = async (m, p, b, x) => { const r = await w.fetch(BASE + '/rest/v1/' + p, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, x || {}), body: b != null ? JSON.stringify(b) : undefined }); if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + await r.text()); const s = await r.text(); return s ? JSON.parse(s) : null; };
  return { sbGet, sbSend };
}
const GREG = { role: 'rep', email: 'greg@hcps.us', rep_name: 'Greg Campbell' };
const row = (w, id) => w.db.dealers.find(d => d.id === id);
const task = (w, id) => w.db.dealer_tasks.find(x => x.id === id);
const opp = (w, id) => w.db.opportunities.find(x => x.id === id);
const sorted = a => [...a].map(String).sort();

(async () => {
  /* ───────────── the resolver ───────────── */
  await t('0D a rep\'s book is decided by rep_email, with the family rules', async () => {
    const w = createWorld(seed()); const SC = load('_scope.js', w); const { sbGet } = db(w);
    const sc = await SC.dealerScope(GREG, sbGet);
    assert.deepStrictEqual(sorted(sc.ids), GREG_BOOK);
  });
  await t('0D email beats a stale or conflicting name; a named row beats the directory', async () => {
    const w = createWorld(seed()); const SC = load('_scope.js', w); const { sbGet } = db(w);
    const ids = (await SC.dealerScope(GREG, sbGet)).ids;
    assert.ok(ids.has('d-stale'), 'rep_email=greg with a stale rep_name must be Greg\'s');
    assert.ok(!ids.has('d-conflict'), 'rep_email=angelo must not be Greg\'s even though rep_name says Greg');
    assert.ok(!ids.has('d-named'), 'a row naming Angelo must not fall back to the directory\'s Greg');
    assert.ok(!ids.has('d-house') && !ids.has('d-none'), 'House and unowned dealers belong to no rep');
  });
  await t('0D an explicitly owned branch keeps its owner both ways (Care Medical rule)', async () => {
    const w = createWorld(seed()); const SC = load('_scope.js', w); const { sbGet } = db(w);
    const ids = (await SC.dealerScope(GREG, sbGet)).ids;
    assert.ok(ids.has('d-care') && !ids.has('d-quipt'), 'Greg\'s branch must not pull in Angelo\'s HQ');
    assert.ok(ids.has('d-hq-open') && !ids.has('d-hq-ang'), 'an open branch follows the HQ; an owned one does not');
  });
  await t('0D renaming a rep does not empty their book (email is the key)', async () => {
    const w = createWorld(seed(S => { S.tables.staff_users[1].rep_name = 'Gregory Campbell'; })); const SC = load('_scope.js', w); const { sbGet } = db(w);
    const ids = (await SC.dealerScope({ role: 'rep', email: 'greg@hcps.us', rep_name: 'Gregory Campbell' }, sbGet)).ids;
    for (const id of ['d-g1', 'd-stale', 'd-hq', 'd-care']) assert.ok(ids.has(id), id + ' lost after the rename');
    const oi = await SC.ownerIndex(sbGet);
    assert.strictEqual(oi.repOf('d-g1'), 'Gregory Campbell', 'the label follows the staff record');
  });
  await t('0D a rep with neither email nor name owns nothing', async () => {
    const w = createWorld(seed()); const SC = load('_scope.js', w); const { sbGet } = db(w);
    assert.strictEqual((await SC.dealerScope({ role: 'rep', email: '', rep_name: '' }, sbGet)).ids.size, 0);
  });
  await t('0D the resolver reads past the 1000-row page limit', async () => {
    const w = createWorld(seed(S => { for (let i = 0; i < 1500; i++) S.tables.dealers.push({ id: 'z' + String(i).padStart(4, '0'), business_name: 'Filler ' + i, rep_name: null, rep_email: null, parent_id: null });
      S.tables.dealers.push({ id: 'zz-last', business_name: 'Last Greg Dealer', rep_name: 'Greg Campbell', rep_email: 'greg@hcps.us', parent_id: null }); }));
    const SC = load('_scope.js', w); const { sbGet } = db(w);
    assert.ok((await SC.dealerScope(GREG, sbGet)).ids.has('zz-last'), 'dealer past row 1000 was dropped');
  });
  await t('0D ownerIndex labels: staff name for an email owner, directory for raw sales names', async () => {
    const w = createWorld(seed()); const SC = load('_scope.js', w); const { sbGet } = db(w);
    const oi = await SC.ownerIndex(sbGet);
    assert.strictEqual(oi.repOf('d-stale'), 'Greg Campbell');
    assert.strictEqual(oi.emailOf('d-stale'), 'greg@hcps.us');
    assert.strictEqual(oi.repOf('d-conflict'), 'Angelo Audia');
    assert.strictEqual(oi.repOf('d-dir'), 'Greg Campbell');
    assert.strictEqual(oi.repOf('d-house'), 'House (unassigned)');
    assert.strictEqual(oi.emailOf('d-house'), '');
    assert.strictEqual(oi.repByName['Raw Sales Name LLC'], 'Greg Campbell', 'directory-only sales names keep their rep');
    assert.strictEqual(oi.repByName['Named Dealer'], 'Angelo Audia', 'a dealer\'s real owner overrides its directory row');
  });

  /* ───────────── the writer ───────────── */
  await t('0D changing the owner writes rep_email, rep_name and the directory together', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await call(m, { action: 'rep', dealer_id: 'd-g1', dealer_name: 'Greg Email Dealer', rep_name: 'Angelo Audia' }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(row(w, 'd-g1').rep_email, 'angelo@hcps.us');
    assert.strictEqual(row(w, 'd-g1').rep_name, 'Angelo Audia');
    assert.strictEqual(w.db.dealer_directory.find(x => x.dealer_name === 'Greg Email Dealer').rep_name, 'Angelo Audia');
  });
  await t('0D open work follows the dealer; third-party, closed and other dealers\' work stays', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await call(m, { action: 'rep', dealer_id: 'd-g1', rep_name: 'Angelo Audia' }, { token: 'pres' });
    assert.deepStrictEqual(r.body.moved, { tasks: 2, opportunities: 1 }, JSON.stringify(r.body));
    assert.strictEqual(task(w, 't-g1-greg').assigned_rep, 'Angelo Audia');
    assert.strictEqual(task(w, 't-g1-none').assigned_rep, 'Angelo Audia');
    assert.strictEqual(task(w, 't-g1-lori').assigned_rep, 'Lori Hunt');
    assert.strictEqual(task(w, 't-g1-done').assigned_rep, 'Greg Campbell');
    assert.strictEqual(task(w, 't-stale-greg').assigned_rep, 'Greg Campbell');
    assert.strictEqual(opp(w, 'o-g1-open').owner_rep, 'Angelo Audia');
    assert.strictEqual(opp(w, 'o-g1-won').owner_rep, 'Greg Campbell');
    assert.strictEqual(opp(w, 'o-g1-lori').owner_rep, 'Lori Hunt');
  });
  await t('0D the new owner can work the dealer at once and the old one cannot', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    await call(m, { action: 'rep', dealer_id: 'd-g1', rep_name: 'Angelo Audia' }, { token: 'pres' });
    const crm = load('crm-api.js', w);
    assert.strictEqual((await call(crm, { action: 'list', dealer_id: 'd-g1' }, { token: 'greg' })).status, 403);
    await call(load('dealers-api.js', w), { action: 'rep', dealer_id: 'd-none', rep_name: 'Greg Campbell' }, { token: 'pres' });
    assert.strictEqual((await call(load('crm-api.js', w), { action: 'list', dealer_id: 'd-none' }, { token: 'greg' })).status, 200);
  });
  await t('0D bulk reassignment uses the same writer (directory and work included)', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await call(m, { action: 'rep_bulk', dealer_ids: ['d-g1', 'd-none'], rep_name: 'Lori Hunt' }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    for (const id of ['d-g1', 'd-none']) { assert.strictEqual(row(w, id).rep_email, 'lori@hcps.us'); assert.strictEqual(row(w, id).rep_name, 'Lori Hunt'); }
    assert.strictEqual(w.db.dealer_directory.find(x => x.dealer_name === 'Nobody Co').rep_name, 'Lori Hunt');
    assert.strictEqual(task(w, 't-g1-greg').assigned_rep, 'Lori Hunt');
  });
  await t('0D Dealer 360 name-only save now changes the real owner', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await call(m, { action: 'rep', dealer_name: 'Greg Email Dealer', rep_name: 'Angelo Audia' }, { token: 'pres' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(row(w, 'd-g1').rep_email, 'angelo@hcps.us', 'the dealer row must change, not just the directory');
  });
  await t('0D a name that is no dealer stays a directory-only write', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const before = JSON.stringify(w.db.dealers);
    await call(m, { action: 'rep', dealer_name: 'Raw Sales Name LLC', rep_name: 'Angelo Audia' }, { token: 'pres' });
    assert.strictEqual(JSON.stringify(w.db.dealers), before);
    assert.strictEqual(w.db.dealer_directory.find(x => x.dealer_name === 'Raw Sales Name LLC').rep_name, 'Angelo Audia');
  });
  await t('0D clearing an owner empties both columns and moves no work', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await call(m, { action: 'rep', dealer_id: 'd-g1', rep_name: '' }, { token: 'pres' });
    assert.strictEqual(row(w, 'd-g1').rep_email, null); assert.strictEqual(row(w, 'd-g1').rep_name, null);
    assert.deepStrictEqual(r.body.moved, { tasks: 0, opportunities: 0 });
    assert.strictEqual(task(w, 't-g1-greg').assigned_rep, 'Greg Campbell');
  });
  await t('0D a name that matches no staff member is kept as a name with no email', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    await call(m, { action: 'rep', dealer_id: 'd-none', rep_name: 'House (unassigned)' }, { token: 'pres' });
    assert.strictEqual(row(w, 'd-none').rep_email, null); assert.strictEqual(row(w, 'd-none').rep_name, 'House (unassigned)');
  });
  await t('0D a rep still cannot reassign dealers', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await call(m, { action: 'rep', dealer_id: 'd-conflict', rep_name: 'Greg Campbell' }, { token: 'greg' });
    assert.strictEqual(r.status, 403); assert.strictEqual(row(w, 'd-conflict').rep_email, 'angelo@hcps.us');
  });
  await t('0D analytics assignment save (assign.js) changes the real owner and keeps the account #', async () => {
    const w = createWorld(seed()); const m = load('assign.js', w);
    const r = await call(m, { dealer_name: 'Greg Email Dealer', rep_name: 'Angelo Audia', hcps_account: 'A-1' }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(row(w, 'd-g1').rep_email, 'angelo@hcps.us');
    const d = w.db.dealer_directory.find(x => x.dealer_name === 'Greg Email Dealer');
    assert.strictEqual(d.rep_name, 'Angelo Audia'); assert.strictEqual(d.hcps_account, 'A-1');
    assert.strictEqual(task(w, 't-g1-greg').assigned_rep, 'Angelo Audia');
  });
  await t('0D ordering-site editor keeps the dealer row in step, and an unchanged save writes nothing', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w, { ANALYTICS_TOKEN: 'pass' }, ORDER_REPO);
    const H = { headers: { 'x-analytics-token': 'pass' } };
    let r = await call(m, { action: 'rep', dealer_name: 'Greg Email Dealer', rep_name: 'Greg Campbell' }, H);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!w.writes.some(x => x.kind === 'patch' && x.table === 'dealers'), 'unchanged owner must not patch the dealer');
    r = await call(m, { action: 'rep', dealer_name: 'Greg Email Dealer', rep_name: 'Lori Hunt' }, H);
    assert.strictEqual(row(w, 'd-g1').rep_email, 'lori@hcps.us'); assert.strictEqual(row(w, 'd-g1').rep_name, 'Lori Hunt');
    assert.strictEqual(task(w, 't-g1-greg').assigned_rep, 'Lori Hunt');
  });

  /* ───────────── the readers ───────────── */
  await t('0D Dealer Manager list = the resolver\'s book', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await call(m, null, { token: 'greg', method: 'GET' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.deepStrictEqual(sorted(r.body.dealers.map(d => d.id)), GREG_BOOK);
    const st = r.body.dealers.find(d => d.id === 'd-stale');
    assert.strictEqual(st.rep, 'Greg Campbell'); assert.strictEqual(st.rep_email, 'greg@hcps.us');
  });
  await t('0D map shows exactly the book', async () => {
    const w = createWorld(seed()); const m = load('geocode-api.js', w);
    const r = await call(m, null, { token: 'greg', method: 'GET' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const ids = [...(r.body.points || []), ...(r.body.unmapped || [])].map(p => p.dealer_id);
    assert.deepStrictEqual(sorted(new Set(ids)), GREG_BOOK);
  });
  await t('0D dealer health shows the book, labelled with the live owner', async () => {
    const w = createWorld(seed()); const m = load('health-api.js', w);
    const r = await call(m, null, { token: 'greg', method: 'GET' });
    assert.deepStrictEqual(sorted(r.body.rows.map(x => x.dealer_id)), GREG_BOOK);
    // Every owned row carries the live owner; the open branch is in the book through its HQ but
    // stays UNLABELLED — an unowned dealer is never shown as assigned (no guessing).
    for (const x of r.body.rows) assert.strictEqual(x.rep_name, x.dealer_id === 'd-hq-open' ? null : 'Greg Campbell', x.dealer_id + ' label ' + x.rep_name);
  });
  await t('0D orders show exactly the book', async () => {
    const w = createWorld(seed()); const m = load('orders-admin.js', w);
    const r = await call(m, { action: 'list' }, { token: 'greg' });
    assert.deepStrictEqual(sorted(r.body.orders.map(o => o.dealer_id)), GREG_BOOK);
  });
  await t('0D analytics: rep attribution and contact details follow the real owner', async () => {
    const w = createWorld(seed()); const m = load('analytics.js', w);
    const r = await call(m, null, { token: 'greg', method: 'GET' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const info = Object.keys(r.body.dealerInfo || {});
    assert.ok(info.includes('Stale Name Dealer') && info.includes('Care Medical aka MyQuipt'), 'own dealers missing: ' + info);
    assert.ok(!info.includes('Angelo Email Dealer') && !info.includes('Quipt HQ') && !info.includes('Named Dealer'), 'other dealers leaked: ' + info);
    const pr = await call(load('analytics.js', w), null, { token: 'pres', method: 'GET' });
    const facts = pr.body.facts || [];
    const repOfDealer = n => (facts.find(f => f.dealer === n) || {}).rep;
    assert.strictEqual(repOfDealer('Stale Name Dealer'), 'Greg Campbell');
    assert.strictEqual(repOfDealer('Angelo Email Dealer'), 'Angelo Audia');
    assert.strictEqual(repOfDealer('Named Dealer'), 'Angelo Audia');
  });
  await t('0D pipeline actuals cover exactly the book', async () => {
    const w = createWorld(seed()); const m = load('pipeline-api.js', w);
    const r = await call(m, { action: 'board' }, { token: 'greg' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const total = (r.body.history || []).reduce((s, h) => s + (h.actual || 0), 0);
    assert.strictEqual(total, GREG_BOOK.length * 10, 'actuals ' + total);
  });
  await t('0D Command Center 360 and the marketing list use the same book', async () => {
    const w = createWorld(seed()); const c = load('command360-api.js', w);
    const r = await call(c, { action: 'summary' }, { token: 'greg' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const pen = (r.body.penetration && r.body.penetration.list) || r.body.penList || [];
    if (pen.length) assert.deepStrictEqual(sorted(pen.map(d => d.id)), GREG_BOOK);
    else assert.strictEqual((r.body.penetration || {}).total, GREG_BOOK.length, JSON.stringify(r.body.penetration));
    const mk = await call(load('marketing-api.js', w), { action: 'today' }, { token: 'greg' });
    assert.strictEqual(mk.status, 200);
    assert.deepStrictEqual(sorted(new Set((mk.body.opportunities || []).map(o => o.dealer_id))), GREG_BOOK);
    const lbl = (mk.body.opportunities || []).find(o => o.dealer_id === 'd-stale');
    assert.strictEqual(lbl && lbl.rep, 'Greg Campbell');
  });
  await t('0D the nightly engine labels dealer health with the real owner', async () => {
    const w = createWorld(seed()); const E = load('_engine.js', w);
    await E.recomputeEngagement();
    const lab = id => (w.db.dealer_engagement.find(e => e.dealer_id === id) || {}).rep_name;
    assert.strictEqual(lab('d-stale'), 'Greg Campbell');
    assert.strictEqual(lab('d-conflict'), 'Angelo Audia');
    assert.strictEqual(lab('d-named'), 'Angelo Audia');
    assert.strictEqual(lab('d-dir'), 'Greg Campbell');
  });
  await t('0D weekly report credits sales to the real owner', async () => {
    const w = createWorld(seed()); const R = load('_report.js', w);
    const g = await R.gather();
    const ytd = rep => (g.reps.find(r => r.rep === rep) || {}).ytd || 0;
    assert.strictEqual(ytd('Greg Campbell'), 50, JSON.stringify(g.reps.map(r => [r.rep, r.ytd])));
    assert.strictEqual(ytd('Angelo Audia'), 40);
  });
  await t('0D record checks agree with the lists (Greg works an email-owned dealer with a stale name)', async () => {
    const w = createWorld(seed()); const crm = load('crm-api.js', w);
    assert.strictEqual((await call(crm, { action: 'list', dealer_id: 'd-stale' }, { token: 'greg' })).status, 200);
    assert.strictEqual((await call(load('crm-api.js', w), { action: 'list', dealer_id: 'd-conflict' }, { token: 'greg' })).status, 403);
    assert.strictEqual((await call(load('crm-api.js', w), { action: 'list', dealer_id: 'd-care' }, { token: 'greg' })).status, 200);
    assert.strictEqual((await call(load('crm-api.js', w), { action: 'list', dealer_id: 'd-quipt' }, { token: 'greg' })).status, 403);
  });

  done('0D shared owner + scope');
})();

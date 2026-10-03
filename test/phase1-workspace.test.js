/* My Sales Workspace (President dual role) + the Command Center landing pilot for Relations.

   The President is also a working rep. With the header `x-hcps-workspace: mine` the working sales
   lists answer exactly as they would for a rep with his email — his book (dealers.rep_email, the
   same resolver every rep gets), his tasks, routes and deals, his own Command Center with no
   picker — while every write keeps his real authority. The header means nothing to anyone else.
   staff-auth landingFor() sends a Relations Manager to the pilot page only when her own email is
   listed; management always lands on /admin/. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done, BASE } = require('./phase0-mock');

const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), IN3 = dayStr(3);
const TZ = new Date().getTimezoneOffset();
const WS = { 'x-hcps-workspace': 'mine' };
const CCURL = '/admin/command-center-rep.html';

const AI_OUT = {
  meeting_summary: 'Met Rita. Reviewed lift chairs; she wants pricing on 2 PR519 chairs.',
  products_discussed: ['PR519 lift chair'], dealer_interests: ['Lift chairs'], dealer_concerns: [], objections: [], competitors: [],
  pricing_requests: ['PR519 pricing'], samples_requested: [], literature_requested: [], training_requested: [],
  attendees: [{ name: 'Rita Owner', title: 'Owner' }],
  rep_commitments: [{ text: 'Send PR519 pricing', due_date: IN3 }], dealer_commitments: [],
  follow_ups: [{ title: 'Send PR519 pricing', due_date: IN3, priority: 'high', from: 'rep_commitment' }],
  opportunities: [{ title: '2 x PR519 lift chairs', manufacturer_slug: 'golden-technologies', product: 'PR519', quantity: 2, est_value: null, contact_name: 'Rita Owner', stage: 'identified', expected_close: '' }],
  suggested_next_action: { text: 'Send pricing', due_date: IN3 }, interest_slugs: ['golden-technologies'], poor_fit_slugs: [] };

function seed(extra) {
  const S = standardSeed(Object.assign({
    dealers: [
      // owned by EMAIL (the authoritative column) — in Angelo's book whatever the name says
      { id: 'd-ang-mail', business_name: 'Clarksville Home Medical', rep_email: 'angelo@hcps.us', rep_name: null, parent_id: null, state: 'TN' },
      // a stale name with Greg's email: Greg's, never Angelo's
      { id: 'd-mixed', business_name: 'Mixed Signals Supply', rep_email: 'greg@hcps.us', rep_name: 'Angelo Audia', parent_id: null, state: 'KY' } ],
    rep_routes: [
      { id: 'r-a', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'Angelo today', scheduled_date: TODAY, stops: [{ dealer_id: 'd-ang', name: 'RMS' }] },
      { id: 'r-a2', owner_email: 'greg@hcps.us', assigned_to_email: 'angelo@hcps.us', name: 'Built by Greg for Angelo', scheduled_date: TODAY, stops: [{ dealer_id: 'd-ang-mail', name: 'Clarksville' }] },
      { id: 'r-g', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', rep_name: 'Angelo Audia', name: 'Planned for Greg', scheduled_date: TODAY, stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }] },
      { id: 'r-g2', owner_email: 'greg@hcps.us', name: 'Greg own', scheduled_date: TODAY, stops: [{ dealer_id: 'd-greg-branch', name: 'Glasgow North' }] } ],
    dealer_tasks: [
      { id: 't-a1', dealer_id: 'd-ang', title: 'Angelo task', status: 'open', priority: 'high', due_date: TODAY, assigned_rep: 'Angelo Audia', assigned_email: 'angelo@hcps.us' },
      { id: 't-g1', dealer_id: 'd-greg', title: 'Greg task', status: 'open', priority: 'normal', due_date: TODAY, assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' },
      { id: 't-l1', dealer_id: 'd-none', title: 'Lori task', status: 'open', priority: 'normal', due_date: TODAY, assigned_rep: 'Lori Hunt', assigned_email: 'lori@hcps.us' },
      { id: 't-u', dealer_id: 'd-none', title: 'Unassigned', status: 'open', priority: 'low' } ],
    opportunities: [
      { id: 'o-a', dealer_id: 'd-ang', title: 'Angelo deal', stage: 'quoted', status: 'open', value: 5000, owner_rep: 'Angelo Audia', owner_email: 'angelo@hcps.us' },
      { id: 'o-g', dealer_id: 'd-greg', title: 'Greg deal', stage: 'contacted', status: 'open', value: 1000, owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us' } ],
    monthly_sales: [
      { dealer_id: 'd-ang', manufacturer: 'golden', period: dayStr(-35).slice(0, 7) + '-01', amount: 500, customer_name: 'Retail Medical Solutions' },
      { dealer_id: 'd-greg', manufacturer: 'golden', period: dayStr(-35).slice(0, 7) + '-01', amount: 1200, customer_name: 'Glasgow Prescription Center' } ],
    dealer_visit_reports: [],
    dealer_contacts: [],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }],
  }, extra || {}));
  S.unique = { dealer_tasks: [['origin_type', 'origin_id', 'origin_key']], opportunities: [['origin_type', 'origin_id', 'origin_key']],
    dealer_visits: [['visit_report_id']], dealer_visit_participants: [['visit_report_id', 'name_key']], dealer_contacts: [['dealer_id', 'email']],
    dealer_visit_reports: [['route_id', 'dealer_id']] };
  S.catalog = { 'golden-technologies': [{ code: 'PR-519', name: 'Golden PR519 Lift Chair', base_price: 899 }] };
  S.ai = () => AI_OUT;
  return S;
}
const W = extra => createWorld(seed(extra));
const as = (tok, ws) => ({ token: tok, headers: ws ? WS : {} });
const CC = (w, tok, ws, body) => call(load('rep-command-api.js', w), Object.assign({ action: 'today', date: TODAY, tz: TZ }, body || {}), as(tok, ws));
const TASKS = (w, tok, ws) => call(load('crm-api.js', w), { action: 'my_tasks' }, as(tok, ws));
const BOARD = (w, tok, ws) => call(load('pipeline-api.js', w), { action: 'board' }, as(tok, ws));
const ROUTES = (w, tok, ws) => call(load('routes-api.js', w), { action: 'list_routes' }, as(tok, ws));
const DEALERS = (w, tok, ws) => call(load('dealers-api.js', w), null, { token: tok, method: 'GET', headers: ws ? WS : {} });
const R = (w, body, tok, ws) => call(load('routes-api.js', w, { ANTHROPIC_API_KEY: 'k' }), body, as(tok || 'pres', ws));
const ids = a => (a || []).map(x => x.id).sort();

/* ---- landing ---- */
const login = async (w, who) => (await call(load('staff-auth.js', w), { action: 'login', email: who + '@hcps.us', password: 'pw-' + who + '-1' })).body;
function landWorld(setting) {
  const S = standardSeed(setting === undefined ? {} : { app_settings: [{ key: 'rep_landing', value: setting }] });
  for (const [u, role] of [['pat', 'rep'], ['rae', 'relations']]) {
    S.authUsers.push(u + '@hcps.us'); S.passwords[u + '@hcps.us'] = 'pw-' + u + '-1';
    S.tables.staff_users.push({ email: u + '@hcps.us', name: u, role, rep_name: u, active: true });
  }
  return createWorld(S);
}

(async () => {
  /* ───────────── Landing: Greg + Lori → Command Center, Angelo → Admin ───────────── */
  await t('landing: the pilot config sends Greg and Lori to the Command Center; Angelo stays on /admin/', async () => {
    const w = landWorld({ mode: 'pilot', url: CCURL, emails: ['greg@hcps.us', 'LORI@hcps.us '] });
    assert.strictEqual((await login(w, 'greg')).profile.landing, CCURL);
    const lori = await login(w, 'lori');
    assert.strictEqual(lori.profile.landing, CCURL);
    assert.strictEqual(lori.profile.role, 'relations', 'Lori is still Relations');
    assert.strictEqual((await login(w, 'angelo')).profile.landing, '/admin/');
    assert.strictEqual((await login(w, 'pat')).profile.landing, '/admin/rep-home.html', 'an unlisted rep moved');
    assert.strictEqual((await login(w, 'rae')).profile.landing, '/admin/rep-home.html', 'an unlisted Relations user moved');
  });
  await t('landing: Relations moves ONLY when listed — "on" alone, "off", or a bad URL never move her', async () => {
    let w = landWorld({ mode: 'on', url: CCURL });
    assert.strictEqual((await login(w, 'lori')).profile.landing, '/admin/rep-home.html', '"on" moved an unlisted Relations user');
    assert.strictEqual((await login(w, 'greg')).profile.landing, CCURL, '"on" still moves every rep');
    w = landWorld({ mode: 'on', url: CCURL, emails: ['lori@hcps.us'] });
    assert.strictEqual((await login(w, 'lori')).profile.landing, CCURL);
    assert.strictEqual((await login(w, 'rae')).profile.landing, '/admin/rep-home.html');
    w = landWorld({ mode: 'off', url: CCURL, emails: ['lori@hcps.us'] });
    assert.strictEqual((await login(w, 'lori')).profile.landing, '/admin/rep-home.html');
    w = landWorld({ mode: 'pilot', url: 'https://evil.test/cc', emails: ['lori@hcps.us'] });
    assert.strictEqual((await login(w, 'lori')).profile.landing, '/admin/rep-home.html');
    w = landWorld({ mode: 'pilot', url: CCURL, emails: ['greg@hcps.us'] });
    assert.strictEqual((await login(w, 'lori')).profile.landing, '/admin/rep-home.html');
  });
  await t('landing: listing the President changes nothing — management always lands on /admin/', async () => {
    const w = landWorld({ mode: 'pilot', url: CCURL, emails: ['angelo@hcps.us', 'lori@hcps.us'] });
    assert.strictEqual((await login(w, 'angelo')).profile.landing, '/admin/');
    const me = await call(load('staff-auth.js', w), { action: 'me' }, { token: 'lori' });
    assert.strictEqual(me.body.profile.landing, CCURL, '"me" carries the same landing');
  });

  /* ───────────── The header: management only ───────────── */
  await t('workspaceMine: honored for management only, and only for the value "mine"', async () => {
    const ev = h => ({ headers: h }); const SC = load('_scope.js', W());
    assert.strictEqual(SC.workspaceMine(ev(WS), { role: 'president' }), true);
    assert.strictEqual(SC.workspaceMine(ev({ 'x-hcps-workspace': 'MINE' }), { role: 'admin' }), true);
    assert.strictEqual(SC.workspaceMine(ev(WS), { role: 'relations' }), false);
    assert.strictEqual(SC.workspaceMine(ev(WS), { role: 'rep' }), false);
    assert.strictEqual(SC.workspaceMine(ev({ 'x-hcps-workspace': 'all' }), { role: 'president' }), false);
    assert.strictEqual(SC.workspaceMine(ev({}), { role: 'president' }), false);
    assert.strictEqual(SC.workspaceMine(null, { role: 'president' }), false);
  });
  await t('ownBook: the rep resolver — rep_email first (a stale name never wins), rep_name only when no email', async () => {
    const w = W(); const SC = load('_scope.js', w); const sbGet = async p => { const r = await w.fetch(BASE + '/rest/v1/' + p, { headers: {} }); return r.json(); };
    const book = await SC.ownBook({ email: 'angelo@hcps.us', rep_name: 'Angelo Audia', role: 'president' }, sbGet);
    assert.strictEqual(book.isAll, false);
    assert.deepStrictEqual([...book.ids].sort(), ['d-ang', 'd-ang-mail']);
  });

  /* ───────────── Command Center ───────────── */
  await t('CC: in the workspace the President gets his own day — the picker is ignored and offered to no one', async () => {
    const w = W();
    const r = await CC(w, 'pres', true, { rep: 'greg@hcps.us' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.header.rep.email, 'angelo@hcps.us');
    assert.strictEqual(r.body.header.viewing_other, false, 'his own day must be operational');
    assert.strictEqual(r.body.header.workspace, true);
    assert.ok(['r-a', 'r-a2'].includes(r.body.route.id), 'route ' + r.body.route.id);
    assert.ok(!JSON.stringify(r.body).includes('Greg task'), 'Greg\'s work leaked into the workspace');
    const reps = await call(load('rep-command-api.js', w), { action: 'reps' }, as('pres', true));
    assert.deepStrictEqual(reps.body.reps, []);
  });
  await t('CC: outside the workspace the President\'s management view of Greg stays read-only, with the picker', async () => {
    const w = W();
    const r = await CC(w, 'pres', false, { rep: 'greg@hcps.us' });
    assert.strictEqual(r.body.header.rep.email, 'greg@hcps.us');
    assert.strictEqual(r.body.header.viewing_other, true);
    assert.strictEqual(r.body.header.workspace, false);
    const reps = await call(load('rep-command-api.js', w), { action: 'reps' }, as('pres', false));
    assert.ok(reps.body.reps.length >= 3);
  });
  await t('CC: Lori keeps the picker and views Greg read-only, header or not; Greg is unchanged', async () => {
    const w = W();
    for (const ws of [false, true]) {
      const l = await CC(w, 'lori', ws, { rep: 'greg@hcps.us' });
      assert.strictEqual(l.body.header.rep.email, 'greg@hcps.us'); assert.strictEqual(l.body.header.viewing_other, true);
      assert.strictEqual(l.body.header.workspace, false);
      const reps = await call(load('rep-command-api.js', w), { action: 'reps' }, as('lori', ws));
      assert.ok(reps.body.reps.length >= 3, 'Relations lost the rep picker');
      const g = await CC(w, 'greg', ws, { rep: 'angelo@hcps.us' });
      assert.strictEqual(g.body.header.rep.email, 'greg@hcps.us'); assert.strictEqual(g.body.header.workspace, false);
    }
  });

  /* ───────────── My Tasks ───────────── */
  await t('My Tasks: workspace = his own tasks only; the Admin queue stays company-wide', async () => {
    const w = W();
    const ws = await TASKS(w, 'pres', true);
    assert.deepStrictEqual(ids(ws.body.tasks), ['t-a1']); assert.strictEqual(ws.body.sees_all, false);
    const adm = await TASKS(w, 'pres', false);
    assert.deepStrictEqual(ids(adm.body.tasks), ['t-a1', 't-g1', 't-l1', 't-u']); assert.strictEqual(adm.body.sees_all, true);
    const cnt = await call(load('crm-api.js', w), { action: 'task_count' }, as('pres', true));
    assert.strictEqual(cnt.body.count, 1, 'masthead badge disagrees with the workspace list');
  });
  await t('My Tasks: the header changes nothing for Relations or a rep', async () => {
    const w = W();
    const l = await TASKS(w, 'lori', true); assert.strictEqual(l.body.sees_all, true); assert.strictEqual(l.body.tasks.length, 4);
    const g0 = await TASKS(w, 'greg', false), g1 = await TASKS(w, 'greg', true);
    assert.deepStrictEqual(ids(g1.body.tasks), ids(g0.body.tasks)); assert.deepStrictEqual(ids(g1.body.tasks), ['t-g1']);
  });

  /* ───────────── Pipeline ───────────── */
  await t('Pipeline: workspace = his deals and his book\'s actuals; the Admin board is unchanged', async () => {
    const w = W();
    const ws = await BOARD(w, 'pres', true);
    assert.strictEqual(ws.status, 200, JSON.stringify(ws.body));
    assert.deepStrictEqual(ids(ws.body.opportunities), ['o-a']); assert.strictEqual(ws.body.workspace, true);
    const actual = ws.body.history.reduce((a, h) => a + h.actual, 0);
    assert.strictEqual(actual, 500, 'actuals outside his book: ' + actual);
    const adm = await BOARD(w, 'pres', false);
    assert.deepStrictEqual(ids(adm.body.opportunities), ['o-a', 'o-g']); assert.strictEqual(adm.body.history.reduce((a, h) => a + h.actual, 0), 1700);
    const l = await BOARD(w, 'lori', true); assert.deepStrictEqual(ids(l.body.opportunities), ['o-a', 'o-g'], 'the header narrowed Relations');
    const g = await BOARD(w, 'greg', true); assert.deepStrictEqual(ids(g.body.opportunities), ['o-g']);
  });

  /* ───────────── Routes ───────────── */
  await t('Routes: workspace = routes he drives (his own, or assigned to him) — not ones he planned for Greg', async () => {
    const w = W();
    const ws = await ROUTES(w, 'pres', true);
    assert.deepStrictEqual(ids(ws.body.routes), ['r-a', 'r-a2']); assert.strictEqual(ws.body.workspace, true);
    const adm = await ROUTES(w, 'pres', false);
    assert.deepStrictEqual(ids(adm.body.routes), ['r-a', 'r-a2', 'r-g', 'r-g2']);
    const g0 = await ROUTES(w, 'greg', false), g1 = await ROUTES(w, 'greg', true);
    assert.deepStrictEqual(ids(g1.body.routes), ids(g0.body.routes));
  });

  /* ───────────── Dealer list (Dealer 360 picker) ───────────── */
  await t('Dealers: workspace = his book (rep resolver); Admin, Relations and Greg are unchanged', async () => {
    const w = W();
    const ws = await DEALERS(w, 'pres', true);
    assert.strictEqual(ws.status, 200, JSON.stringify(ws.body).slice(0, 300));
    assert.deepStrictEqual(ids(ws.body.dealers), ['d-ang', 'd-ang-mail']); assert.strictEqual(ws.body.workspace, true);
    const all = await DEALERS(w, 'pres', false); assert.strictEqual(all.body.dealers.length, 7); assert.ok(!all.body.workspace);
    const l = await DEALERS(w, 'lori', true); assert.strictEqual(l.body.dealers.length, 7);
    const g0 = await DEALERS(w, 'greg', false), g1 = await DEALERS(w, 'greg', true);
    assert.deepStrictEqual(ids(g1.body.dealers), ids(g0.body.dealers));
    assert.ok(!ids(g1.body.dealers).includes('d-ang-mail'));
  });

  /* ───────────── Route planner map ───────────── */
  await t('Map: workspace = pins for his book only; Admin, Relations and Greg are unchanged', async () => {
    const w = W({ dealer_addresses: [
        { dealer_id: 'd-ang', address: '1 Main', city: 'Nashville', state: 'TN', zip: '37201', label: 'HQ' },
        { dealer_id: 'd-ang-mail', address: '3 Oak', city: 'Clarksville', state: 'TN', zip: '37040', label: 'HQ' },
        { dealer_id: 'd-greg', address: '2 Elm', city: 'Glasgow', state: 'KY', zip: '42141', label: 'HQ' } ],
      geocache: [{ q: '1 main, nashville, tn 37201', lat: 36, lng: -86, ok: true }, { q: '3 oak, clarksville, tn 37040', lat: 36.5, lng: -87.3, ok: true },
        { q: '2 elm, glasgow, ky 42141', lat: 37, lng: -85.9, ok: true }] });
    const MAP = (tok, ws) => call(load('geocode-api.js', w), null, { token: tok, method: 'GET', headers: ws ? WS : {} });
    const pins = r => (r.body.points || []).map(p => p.dealer_id).sort();
    assert.deepStrictEqual(pins(await MAP('pres', true)), ['d-ang', 'd-ang-mail']);
    assert.deepStrictEqual(pins(await MAP('pres', false)), ['d-ang', 'd-ang-mail', 'd-greg']);
    assert.deepStrictEqual(pins(await MAP('lori', true)), ['d-ang', 'd-ang-mail', 'd-greg']);
    assert.deepStrictEqual(pins(await MAP('greg', true)), ['d-greg']);
  });

  /* ───────────── Operational: the workspace never reduces what he may do ───────────── */
  await t('Workspace is operational: Start → End → AI summary → approve attendees, tasks and the deal on his own dealer', async () => {
    const w = W(); const stop = { route_id: 'r-a', dealer_id: 'd-ang' };
    const s = await R(w, Object.assign({ action: 'visit_checkin' }, stop), 'pres', true); assert.strictEqual(s.status, 200, JSON.stringify(s.body)); assert.strictEqual(s.body.status, 'checked_in');
    const e = await R(w, Object.assign({ action: 'visit_end' }, stop), 'pres', true); assert.strictEqual(e.body.status, 'ended');
    const a = await R(w, Object.assign({ action: 'visit_analyze', notes: 'Met Rita about lift chairs. Send PR519 pricing.', local_date: TODAY }, stop), 'pres', true);
    assert.strictEqual(a.status, 200, JSON.stringify(a.body)); const sug = a.body.suggestion; assert.ok(sug && sug.follow_ups.length, JSON.stringify(a.body).slice(0, 300));
    const ap = await R(w, Object.assign({ action: 'visit_approve' }, stop, { summary: sug, interest_slugs: sug.interest_slugs,
      participants: sug.attendees.map(x => ({ key: x.key, name: x.name, title: x.title, contact_id: x.contact_id, add_as_contact: !x.contact_id, source: 'ai' })),
      tasks: sug.follow_ups.map(f => ({ key: f.key, title: f.title, due_date: f.due_date, priority: f.priority, kind: 'followup', ai: true })),
      opportunities: sug.opportunities.map(o => ({ key: o.key, title: o.title, manufacturer: o.manufacturer, product: o.product, quantity: o.quantity, value: o.value, stage: o.stage, contact_id: o.contact_id })) }), 'pres', true);
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    const rep = w.db.dealer_visit_reports.find(v => v.dealer_id === 'd-ang');
    assert.ok(rep && rep.approved_at && rep.rep_email === 'angelo@hcps.us');
    assert.ok(w.db.dealer_tasks.some(x => x.origin_type === 'visit_report' && x.dealer_id === 'd-ang'), 'no follow-up task');
    assert.ok(w.db.opportunities.some(x => x.origin_type === 'visit_report' && x.dealer_id === 'd-ang'), 'no opportunity');
    assert.ok((w.db.dealer_visit_participants || []).some(x => /Rita/.test(x.name_snapshot || '')), 'attendee not approved');
    // and it shows on his own day
    const day = await CC(w, 'pres', true); assert.strictEqual(day.body.visit_activity.length, 1); assert.strictEqual(day.body.header.viewing_other, false);
  });
  await t('Workspace is operational: create and complete a task, create a deal, draft the follow-up email', async () => {
    const w = W();
    const add = await call(load('crm-api.js', w), { action: 'add_task', dealer_id: 'd-ang', title: 'Bring catalog' }, as('pres', true));
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const tk = w.db.dealer_tasks.find(x => x.title === 'Bring catalog'); assert.ok(tk);
    const done_ = await call(load('crm-api.js', w), { action: 'complete_task', id: tk.id }, as('pres', true));
    assert.strictEqual(done_.status, 200, JSON.stringify(done_.body));
    assert.notStrictEqual(w.db.dealer_tasks.find(x => x.id === tk.id).status, 'open');
    const opp = await call(load('pipeline-api.js', w), { action: 'add', dealer_id: 'd-ang-mail', title: 'Spring lift chairs', value: 2500 }, as('pres', true));
    assert.strictEqual(opp.status, 200, JSON.stringify(opp.body));
    assert.ok(w.db.opportunities.some(o => o.title === 'Spring lift chairs' && o.dealer_id === 'd-ang-mail'));
  });
  await t('Workspace is not a permission reduction: his President authority outside the book is unchanged', async () => {
    const w = W();
    const r = await call(load('crm-api.js', w), { action: 'list', dealer_id: 'd-greg' }, as('pres', true));
    assert.strictEqual(r.status, 200, 'President refused a dealer outside his book while in the workspace');
    const a = await call(load('crm-api.js', w), { action: 'add_task', dealer_id: 'd-greg', title: 'Coach Greg' }, as('pres', true));
    assert.strictEqual(a.status, 200);
  });
  await t('The header grants a rep nothing: Greg still cannot reach Angelo\'s dealer or records', async () => {
    const w = W();
    for (const [fn, body] of [['crm-api.js', { action: 'list', dealer_id: 'd-ang' }], ['crm-api.js', { action: 'add_task', dealer_id: 'd-ang-mail', title: 'x' }],
      ['pipeline-api.js', { action: 'update', id: 'o-a', stage: 'won' }], ['crm-api.js', { action: 'reopen_task', id: 't-a1' }]]) {
      const r = await call(load(fn, w), body, as('greg', true));
      assert.ok(r.status === 403 || r.status === 404, fn + ' ' + body.action + ' answered ' + r.status);
    }
  });

  done('Phase 1 — My Sales Workspace + Relations landing');
})();

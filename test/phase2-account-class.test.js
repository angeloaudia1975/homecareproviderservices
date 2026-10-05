/* Phase 2 add-on — account_class (Morning Brief signal eligibility), approved 2026-10-05.

   Approved rules under test:
     · an optional dealers.account_class, set by President/Admin only (dealers-api set_account_class);
       Greg (rep) and Lori (Relations) cannot change it
     · existing records stay blank, and blank is eligible — nothing drops out of the brief by itself
     · eligible: blank, dealer, prospect, other · excluded: manufacturer, vendor, service_provider,
       internal, not_relevant — for every relationship signal (going quiet, reorder risk, open cart,
       portal activity, overdue commitments and follow-ups)
     · it controls signal eligibility only: no change to ownership, rep scope, access, Dealer 360
       visibility, or any other column of the account
     · nothing is inferred from the company name; before the SQL runs everything behaves as before */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
const AC = load('_account_class.js', createWorld(standardSeed()));

const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), YDAY = dayStr(-1), AGO5 = dayStr(-5);
const TZ = new Date().getTimezoneOffset();
const nowIso = () => new Date().toISOString();

// One account per class, all in Greg's book. Names say nothing about the class on purpose: the class
// is the only thing that may decide (nothing is inferred from a company name).
const CLS = { 'a-blank': null, 'a-dealer': 'dealer', 'a-prospect': 'prospect', 'a-other': 'other',
  'a-mfr': 'manufacturer', 'a-vendor': 'vendor', 'a-svc': 'service_provider', 'a-int': 'internal', 'a-nr': 'not_relevant' };
const ELIGIBLE = ['a-blank', 'a-dealer', 'a-prospect', 'a-other'];
const EXCLUDED = ['a-mfr', 'a-vendor', 'a-svc', 'a-int', 'a-nr'];
const ids = Object.keys(CLS);

// kind: which signal every account gets — quiet (going quiet), decline (reorder risk), cart, portal,
// visit (overdue dealer commitment, overdue follow-up, overdue rep commitment = relationship risk).
function seed(kind, opts) {
  opts = opts || {};
  const dealers = ids.map((id, i) => Object.assign({ id, business_name: 'Account ' + (i + 1), rep_email: 'greg@hcps.us', rep_name: null, parent_id: null, state: 'KY',
    updated_at: '2026-01-01T00:00:00Z', email: 'x' + i + '@acct.test' }, opts.noColumn ? {} : { account_class: CLS[id] }));
  const per = f => ids.map(f);
  const S = standardSeed({
    dealers,
    dealer_engagement: kind === 'quiet' ? per(id => ({ dealer_id: id, status: 'at_risk', trend: 'down', churn_score: 60, months_since: 3, last_period: '2026-06', total_sales: 20000, recent_sales: 0 }))
      : kind === 'decline' ? per(id => ({ dealer_id: id, status: 'healthy', trend: 'down', churn_score: 30, months_since: 1, last_period: '2026-09', total_sales: 20000, recent_sales: 900 })) : [],
    dealer_carts: kind === 'cart' ? per((id, i) => ({ uid: 'u' + i, dealer_id: id, cart: { items: [{ qty: 1, p: { name: 'Lift chair', base_price: 700 } }] }, updated_at: YDAY + 'T18:00:00Z' })) : [],
    dealer_sessions: kind === 'portal' ? per((id, i) => ({ id: 's' + i, dealer_id: id, last_seen_at: nowIso() })) : [],
    dealer_visit_reports: kind === 'visit' ? per((id, i) => ({ id: 'v' + i, route_id: null, dealer_id: id, rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell',
      checkin_at: AGO5 + 'T15:00:00Z', completed_at: AGO5 + 'T16:00:00Z', approved_at: AGO5 + 'T16:00:00Z', followup_status: 'pending', followup_due: YDAY,
      summary: { meeting_summary: 'Met.', dealer_commitments: [{ text: 'send the PO', due_date: YDAY }], rep_commitments: [{ text: 'send pricing', due_date: YDAY }] } })) : [],
    dealer_intent: [], manufacturers: [], service_requests: [], rep_daily_briefs: [], dealer_tasks: [], opportunities: [], rep_routes: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }, { key: 'phase2_flags', value: { morning_brief: true } }],
  });
  S.tokens.admin = 'ops@hcps.us'; S.tokens.owner = 'boss@hcps.us';
  S.tables.staff_users.push({ email: 'ops@hcps.us', name: 'Ops Admin', role: 'admin', rep_name: '', active: true },
    { email: 'boss@hcps.us', name: 'Owner', role: 'owner', rep_name: '', active: true });
  if (opts.noColumn) S.columns = { dealers: ['id', 'business_name', 'rep_email', 'rep_name', 'parent_id', 'state', 'updated_at', 'email', 'is_test', 'hcps_account', 'status', 'contact_name', 'phone', 'address', 'city', 'zip', 'notes', 'website', 'email_verified', 'golden_url', 'golden_status', 'active', 'ovation_access'] };
  S.ai = () => ({ headline: 'x', focus: [] });
  return S;
}
const W = (kind, opts) => createWorld(seed(kind, opts));
const BRIEFCHECK = (w, tok) => call(load('rep-command-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'brief', mode: 'check', date: TODAY, tz: TZ, hour: 8 }, { token: tok });
const DAPI = (w, body, tok) => call(load('dealers-api.js', w), body, { token: tok });
const SET = (w, id, cls, tok) => DAPI(w, { action: 'set_account_class', dealer_id: id, account_class: cls }, tok || 'pres');
const sigIds = r => (r.body.signals || []).map(s => s.dealer_id);
const row = (w, id) => w.db.dealers.find(d => d.id === id);

(async () => {
  await t('the controlled set: eligible = blank, dealer, prospect, other; excluded = manufacturer, vendor, service_provider, internal, not_relevant', () => {
    assert.deepStrictEqual(AC.CLASSES, ['dealer', 'prospect', 'manufacturer', 'vendor', 'service_provider', 'internal', 'other', 'not_relevant']);
    for (const c of [null, '', undefined, 'dealer', 'prospect', 'other']) assert.strictEqual(AC.signalEligible(c), true, String(c));
    for (const c of ['manufacturer', 'vendor', 'service_provider', 'internal', 'not_relevant']) assert.strictEqual(AC.signalEligible(c), false, c);
    assert.strictEqual(AC.isClass('Vendor'), false); assert.strictEqual(AC.isClass('dealer '), false); assert.strictEqual(AC.isClass('vendor'), true);
  });

  for (const kind of ['quiet', 'decline', 'cart', 'portal', 'visit']) {
    await t(`${kind}: blank, Dealer, Prospect and Other accounts raise the signal; the five excluded classes raise none (Lori, company-wide)`, async () => {
      const w = W(kind);
      const r = await BRIEFCHECK(w, 'lori');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.scope, 'company_wide');
      const got = sigIds(r);
      for (const id of ELIGIBLE) assert.ok(got.includes(id), `${id} (${CLS[id] || 'blank'}) lost its ${kind} signal: ${got.join(',')}`);
      for (const id of EXCLUDED) assert.ok(!got.includes(id), `${id} (${CLS[id]}) still raised a ${kind} signal`);
      const types = new Set((r.body.signals || []).map(s => s.type));
      const want = { quiet: 'quiet', decline: 'decline', cart: 'cart', portal: 'portal', visit: 'dealer_commitment' }[kind];
      assert.ok(types.has(want), [...types].join(','));
      // Nothing was written, no AI ran: a read-only check.
      assert.strictEqual(w.outbound.filter(o => o.kind === 'ai').length, 0); assert.strictEqual((w.db.rep_daily_briefs || []).length, 0);
    });
  }

  await t('a rep\'s own book: blank/Dealer/Prospect/Other keep their signals, excluded classes are gone (Greg, going quiet)', async () => {
    const w = W('quiet');
    const r = await BRIEFCHECK(w, 'greg');
    assert.strictEqual(r.body.scope, 'own_book');
    const got = sigIds(r);
    for (const id of ELIGIBLE) assert.ok(got.includes(id), id + ' missing: ' + got.join(','));
    for (const id of EXCLUDED) assert.ok(!got.includes(id), id + ' present');
  });

  await t('before the SQL runs (no account_class column): every account still raises its signals and nothing errors', async () => {
    const w = W('quiet', { noColumn: true });
    const r = await BRIEFCHECK(w, 'lori');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const got = sigIds(r); for (const id of ids) assert.ok(got.includes(id), id);
    const g = await call(load('dealers-api.js', w), null, { token: 'pres', method: 'GET' });
    assert.strictEqual(g.status, 200, JSON.stringify(g.body).slice(0, 300)); assert.ok(g.body.dealers.every(d => d.account_class === null), 'account_class should read null before the migration');
    const s = await SET(w, 'a-vendor', 'vendor');
    assert.strictEqual(s.status, 200); assert.strictEqual(s.body.ok, false); assert.strictEqual(s.body.error, 'needs_migration');
  });

  await t('Greg cannot change account_class — not on his own dealer, not on any other; nothing is written', async () => {
    const w = W('quiet'); const before = JSON.stringify(w.db.dealers);
    for (const [id, cls] of [['a-blank', 'vendor'], ['a-vendor', ''], ['d-greg', 'not_relevant'], ['d-none', 'internal']]) {
      const r = await SET(w, id, cls, 'greg'); assert.strictEqual(r.status, 403, id);
    }
    assert.strictEqual(JSON.stringify(w.db.dealers), before);
    assert.ok(!w.writes.some(x => x.table === 'dealers'), 'a dealers write happened');
  });

  await t('Lori cannot change account_class (Relations is not management); nothing is written', async () => {
    const w = W('quiet'); const before = JSON.stringify(w.db.dealers);
    for (const [id, cls] of [['a-blank', 'vendor'], ['a-mfr', 'dealer'], ['d-none', 'not_relevant']]) {
      const r = await SET(w, id, cls, 'lori'); assert.strictEqual(r.status, 403, id);
    }
    assert.strictEqual(JSON.stringify(w.db.dealers), before);
  });

  await t('President, Admin and Owner can set it; blank clears it; an unknown value is refused; who/when is recorded', async () => {
    const w = W('quiet');
    let r = await SET(w, 'a-blank', 'vendor', 'pres');
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body, { ok: true, dealer_id: 'a-blank', account_class: 'vendor', signal_eligible: false });
    assert.strictEqual(row(w, 'a-blank').account_class, 'vendor'); assert.strictEqual(row(w, 'a-blank').account_class_set_by, 'angelo@hcps.us'); assert.ok(row(w, 'a-blank').account_class_set_at);
    r = await SET(w, 'a-blank', 'Prospect ', 'admin'); assert.strictEqual(r.status, 200); assert.strictEqual(row(w, 'a-blank').account_class, 'prospect'); assert.strictEqual(row(w, 'a-blank').account_class_set_by, 'ops@hcps.us');
    r = await SET(w, 'a-blank', '', 'owner'); assert.strictEqual(r.status, 200); assert.strictEqual(row(w, 'a-blank').account_class, null); assert.strictEqual(r.body.signal_eligible, true);
    r = await SET(w, 'a-blank', 'competitor', 'pres'); assert.strictEqual(r.status, 400); assert.strictEqual(row(w, 'a-blank').account_class, null);
    r = await SET(w, 'nope', 'vendor', 'pres'); assert.strictEqual(r.status, 404);
    r = await DAPI(w, { action: 'set_account_class', account_class: 'vendor' }, 'pres'); assert.strictEqual(r.status, 400);
    // The signal follows the class: set → gone from the brief; cleared → back.
    await SET(w, 'a-dealer', 'not_relevant'); assert.ok(!sigIds(await BRIEFCHECK(w, 'lori')).includes('a-dealer'));
    await SET(w, 'a-dealer', ''); assert.ok(sigIds(await BRIEFCHECK(w, 'lori')).includes('a-dealer'));
    // Dealer 360's dealer list carries the class (management sees it in the header and the editor).
    const g = await call(load('dealers-api.js', w), null, { token: 'pres', method: 'GET' });
    assert.strictEqual(g.body.dealers.find(d => d.id === 'a-vendor').account_class, 'vendor'); assert.strictEqual(g.body.dealers.find(d => d.id === 'a-blank').account_class, '');
  });

  await t('changing it touches nothing else: owner, rep scope, Dealer 360 access and visibility, every other column stay exactly as they were', async () => {
    const w = W('quiet');
    const crm = (tok, id) => call(load('crm-api.js', w), { action: 'list', dealer_id: id }, { token: tok });
    const list = async tok => ((await call(load('dealers-api.js', w), null, { token: tok, method: 'GET' })).body.dealers || []).map(d => ({ id: d.id, rep: d.rep, rep_email: d.rep_email }));
    const snap = async () => ({ greg: await list('greg'), lori: await list('lori'), pres: await list('pres'),
      access: await Promise.all(['a-blank', 'a-vendor', 'd-greg', 'd-none'].map(async id => [(await crm('greg', id)).status, (await crm('lori', id)).status, (await crm('pres', id)).status])) });
    const before = await snap();
    const rowsBefore = JSON.parse(JSON.stringify(w.db.dealers));
    const nWrites = w.writes.length;
    await SET(w, 'a-blank', 'vendor'); await SET(w, 'a-dealer', 'internal'); await SET(w, 'd-greg', 'not_relevant'); await SET(w, 'a-vendor', '');
    assert.deepStrictEqual(await snap(), before, 'access, ownership or the dealer lists changed');
    // Every other column is byte-identical (updated_at included — so nothing re-syncs to Zoho because of it).
    const strip = r => { const o = Object.assign({}, r); delete o.account_class; delete o.account_class_set_by; delete o.account_class_set_at; return o; };
    assert.deepStrictEqual(w.db.dealers.map(strip), rowsBefore.map(strip));
    // Only dealers rows were written, one per change, and only the three class columns.
    const ws = w.writes.slice(nWrites);
    assert.strictEqual(ws.length, 4, JSON.stringify(ws));
    for (const x of ws) { assert.ok(x.kind === 'patch' && x.table === 'dealers' && /^id=eq\./.test(x.qs), JSON.stringify(x)); assert.deepStrictEqual(Object.keys(x.body).sort(), ['account_class', 'account_class_set_at', 'account_class_set_by']); }
    // Greg still sees and works his classified dealers: his Command Center and the brief's own tasks are his.
    assert.strictEqual((await crm('greg', 'a-blank')).status, 200);
  });

  done('Phase 2 add-on: account_class');
})();

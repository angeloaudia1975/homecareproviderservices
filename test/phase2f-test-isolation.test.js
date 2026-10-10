/* Phase 2F-2 — TEST isolation for every Zoho push path (_zoho_test.js, the one shared rule).

   A dealer with is_test = true, and everything attached to it — its email, contacts, deals, tasks, notes,
   appointments, website-booking Leads, sales rows and campaign recipients — is never sent to Zoho, by the 15-minute autosync or by
   any on-demand push. If the TEST dealers can't be read, nothing is pushed (fail closed) and the reason is
   recorded. Existing Zoho TEST records are not touched. Real records are pushed exactly as before. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const ENV = { ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'zcs-b81d44e0aa', ZOHO_WEBHOOK_SECRET: 'whsec-7f3a9c2e51' };
const TEST_MARKS = ['TEST — Golden Sandbox', 'orders@hcps.test', 'pharm@example.test', 'Sandbox deal', 'Sandbox task', 'Sandbox note', 'd-test'];
function seed(o) {
  o = o || {};
  const S = standardSeed({
    app_settings: [{ key: 'zoho_auth', value: { refresh_token: 'rt', api_domain: 'https://www.zohoapis.com' } }, { key: 'zoho_push_hashes', value: {} },
      { key: 'zoho_campaigns_auth', value: { refresh_token: 'crt' } }],
    dealer_contacts: [
      { id: 'c1', dealer_id: 'd-greg', name: 'Rita Owner', email: 'rita@glasgow.test' },
      { id: 'c2', dealer_id: 'd-ang', name: 'Shared Person', email: 'shared@both.test' },
      { id: 'ct1', dealer_id: 'd-test', name: 'Sandbox (Angelo)', email: 'orders@hcps.test' },
      { id: 'ct2', dealer_id: 'd-test', name: 'Import Test Renamed', email: 'pharm@example.test' },
      { id: 'ct3', dealer_id: 'd-test', name: 'Shared on TEST', email: 'shared@both.test' } ],
    opportunities: [
      { id: 'o1', dealer_id: 'd-greg', title: 'Real deal 1', stage: 'identified', value: 100, expected_close: '2026-11-01', zoho_id: 'Z1' },
      { id: 'o2', dealer_id: 'd-ang', title: 'Real deal 2', stage: 'quoted', value: 200, expected_close: '2026-12-01', zoho_id: null },
      { id: 'ot1', dealer_id: 'd-test', title: 'Sandbox deal A', stage: 'lost', value: 1, expected_close: '2026-10-02', zoho_id: 'ZT1' },
      { id: 'ot2', dealer_id: 'd-test', title: 'Sandbox deal B', stage: 'identified', value: 0, expected_close: null, zoho_id: null } ],
    dealer_tasks: [{ id: 't1', dealer_id: 'd-greg', title: 'Real task', status: 'open' }, { id: 'tt1', dealer_id: 'd-test', title: 'Sandbox task', status: 'open' }],
    dealer_notes: [{ id: 'n1', dealer_id: 'd-greg', body: 'Real note', author_name: 'Greg' }, { id: 'nt1', dealer_id: 'd-test', body: 'Sandbox note', author_name: 'Angelo' }],
    monthly_sales: [{ id: 's1', dealer_id: 'd-greg', manufacturer: 'golden-technologies', amount: 500, period: '2026-08-01' }, { id: 'st1', dealer_id: 'd-test', manufacturer: 'golden-technologies', amount: 9, period: '2026-08-01' }],
    zoho_sync_queue: [], zoho_sync_log: [],
  });
  S.tables.dealers.push({ id: 'd-test', business_name: 'TEST — Golden Sandbox', rep_name: null, parent_id: null, state: 'IN', is_test: true, email: 'orders@hcps.test', contact_name: 'Sandbox (Angelo)' });
  S.zoho = { modules: { Accounts: [{ id: 'A1', Account_Name: 'Glasgow Prescription Center' }, { id: 'AT', Account_Name: 'TEST — Golden Sandbox' }],
    Deals: [{ id: 'Z1', Deal_Name: 'Real deal 1', Stage: 'Qualification', Amount: 100, Closing_Date: '2026-11-01' }, { id: 'ZT1', Deal_Name: 'Sandbox deal A', Stage: 'Closed Lost', Amount: 1, Closing_Date: '2026-10-02' }] } };
  if (o.ruleDown) S.failRead = (tb, qs) => tb === 'dealers' && /is_test=eq\.true/.test(decodeURIComponent(qs)) ? 500 : 0;
  return S;
}
const W = o => createWorld(seed(o));
const zohoWrites = w => w.outbound.filter(x => x.kind === 'zoho' && x.method !== 'GET');
const sent = w => JSON.stringify(zohoWrites(w).map(x => [x.path, x.body]));
const noTest = (w, where) => { const s = sent(w); for (const m of TEST_MARKS) assert.ok(!s.includes(m), where + ': TEST data sent to Zoho (' + m + ')'); };
const fails = w => (w.db.zoho_sync_log || []).filter(l => l.result === 'fail');
const api = (w, body) => call(load('zoho-api.js', w, ENV), body, { token: 'pres' });

(async () => {
  await t('Autosync: no TEST account, contact or deal is pushed; real ones are, and a real dealer\'s copy of a shared email still goes', async () => {
    // 2F-5: a linked deal is pushed when HCPS changed something since its last-synchronized baseline (here: its name).
    const w = W(); w.db.zoho_deal_baseline = [{ opportunity_id: 'o1', zoho_id: 'Z1', base: { stage: 'identified', zoho_stage: 'Qualification', amount: 100, close_date: '2026-11-01' }, owned_hash: 'renamed-since' }];
    const mod = load('zoho-autosync.js', w, ENV); const r = JSON.parse((await mod.handler({})).body);
    noTest(w, 'autosync');
    const s = sent(w);
    for (const m of ['Glasgow Prescription Center', 'Retail Medical Solutions', 'rita@glasgow.test', 'shared@both.test', 'Real deal 1', 'Real deal 2']) assert.ok(s.includes(m), m + ' was not pushed');
    assert.deepStrictEqual(r.summary.test_excluded, { accounts: 1, contacts: 4, deals: 2 });   // contacts: 3 TEST contacts + the TEST dealer's own email
    const h = w.db.app_settings.find(x => x.key === 'zoho_push_hashes').value;
    assert.ok(!Object.keys(h).some(k => /d-test|ot1|ot2|orders@hcps\.test|pharm@example\.test/.test(k)), 'a TEST record was fingerprinted as pushed');
    assert.strictEqual(r.summary.failures, 0);
  });

  await t('Autosync, TEST dealers unreadable: nothing at all is pushed (fail closed), the pull still runs, the reason is recorded', async () => {
    const w = W({ ruleDown: true }); const mod = load('zoho-autosync.js', w, ENV); const r = JSON.parse((await mod.handler({})).body);
    assert.deepStrictEqual(zohoWrites(w), [], 'something was pushed while TEST dealers were unknown');
    assert.strictEqual(r.summary.outbound_skipped, 'test_rule_unavailable');
    assert.ok(w.outbound.some(x => x.kind === 'zoho' && x.method === 'GET' && /\/Deals\?/.test(x.path)), 'the pull did not run');
    const f = fails(w).find(x => JSON.parse(x.detail).phase === 'test_rule'); assert.ok(f && /nothing was pushed/.test(f.detail));
    assert.strictEqual((w.db.zoho_sync_log || []).find(l => l.entity === 'autosync' && l.action === 'run').result, 'partial');
  });

  await t('Autosync, TEST dealers\' contacts unreadable: also fail closed — nothing pushed', async () => {
    const S = seed(); S.failRead = (tb, qs) => tb === 'dealer_contacts' && /dealer_id=in\./.test(decodeURIComponent(qs)) ? 500 : 0;
    const w = createWorld(S); const r = JSON.parse((await load('zoho-autosync.js', w, ENV).handler({})).body);
    assert.deepStrictEqual(zohoWrites(w), []); assert.strictEqual(r.summary.outbound_skipped, 'test_rule_unavailable');
  });

  await t('Existing Zoho TEST records are left alone: no update, no delete', async () => {
    const w = W(); await load('zoho-autosync.js', w, ENV).handler({});
    assert.ok(!zohoWrites(w).some(x => /ZT1|AT/.test(JSON.stringify(x.body || '')) || x.method === 'DELETE'));
    assert.ok(w.db.opportunities.find(o => o.id === 'ot1').zoho_id === 'ZT1');
  });

  await t('On-demand pushes all follow the rule: accounts, contacts, deals, sales roll-ups, notes and tasks', async () => {
    for (const [action, key, n] of [['sync_accounts', 'test_excluded', 1], ['sync_contacts', 'test_excluded', 4], ['sync_opportunities', 'test_excluded', 2], ['sync_deals', 'test_excluded', 1], ['mirror_to_zoho', 'test_excluded', 2]]) {
      const w = W(); const r = await api(w, { action });
      assert.strictEqual(r.status, 200, action); assert.strictEqual(r.body[key], n, action + ' ' + JSON.stringify(r.body).slice(0, 200));
      noTest(w, action);
      assert.ok(zohoWrites(w).length > 0, action + ' pushed nothing at all');
    }
    // The task/note mirror leaves the TEST rows unstamped (never "sent").
    const w = W(); await api(w, { action: 'mirror_to_zoho' });
    assert.ok(!w.db.dealer_tasks.find(x => x.id === 'tt1').zoho_synced_at && !w.db.dealer_notes.find(x => x.id === 'nt1').zoho_synced_at);
    assert.ok(w.db.dealer_tasks.find(x => x.id === 't1').zoho_synced_at, 'the real task was not mirrored');
  });

  await t('On-demand imports by name or email: a TEST dealer\'s name or address in an upload is skipped', async () => {
    let w = W(); let r = await api(w, { action: 'zoho_import_accounts', rows: [{ name: 'TEST — Golden Sandbox' }, { name: 'Test - Golden Sandbox, Inc.' }, { name: 'Glasgow Prescription Center' }] });
    assert.strictEqual(r.body.test_excluded, 2); noTest(w, 'import accounts'); assert.ok(sent(w).includes('Glasgow Prescription Center'));
    w = W(); r = await api(w, { action: 'zoho_import_contacts', rows: [{ email: 'orders@hcps.test', last: 'Sandbox', company: 'Somewhere' }, { email: 'x@y.test', last: 'Y', company: 'TEST — Golden Sandbox' },
      { email: 'pharm@example.test', last: 'Contact', company: 'Somewhere Else' }, { email: 'real@glasgow.test', last: 'Real', company: 'Glasgow Prescription Center' }] });
    assert.strictEqual(r.body.test_excluded, 3);   // the TEST dealer's own email, its name, and one of its contacts' addresses noTest(w, 'import contacts'); assert.ok(sent(w).includes('real@glasgow.test'));
  });

  await t('On-demand pushes with TEST dealers unreadable: refused, nothing sent, reason recorded', async () => {
    for (const action of ['sync_accounts', 'sync_contacts', 'sync_opportunities', 'sync_deals', 'mirror_to_zoho', 'zoho_import_accounts', 'zoho_import_contacts']) {
      const w = W({ ruleDown: true }); const r = await api(w, { action, rows: [{ name: 'Glasgow Prescription Center', email: 'a@b.test' }] });
      assert.strictEqual(r.body.ok, false, action); assert.strictEqual(r.body.error, 'test_rule_unavailable', action);
      assert.deepStrictEqual(zohoWrites(w), [], action + ' pushed'); assert.ok(fails(w).some(x => /TEST dealers couldn't be read/.test(x.detail)), action);
    }
  });

  await t('Scheduling: an appointment for the TEST dealer creates no Zoho task; a real one still does', async () => {
    const mk = (id, dealer_id, company) => ({ id, status: 'requested', company, dealer_id, email: 'buyer@x.test', contact_name: 'Buyer', service: 'Demo', preferred_date: '2026-10-20', mode: 'remote' });
    let w = W(); w.db.service_requests = [mk('sr-t', 'd-test', 'TEST — Golden Sandbox')];
    let r = await call(load('schedule-api.js', w, ENV), { action: 'assign', id: 'sr-t', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', override_hours: true }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.ok(!zohoWrites(w).some(x => /\/Tasks/.test(x.path)), 'a TEST appointment reached Zoho');
    // Not yet tied to a dealer, but the company IS the TEST dealer: still skipped.
    w = W(); w.db.service_requests = [mk('sr-n', null, 'TEST — Golden Sandbox')];
    r = await call(load('schedule-api.js', w, ENV), { action: 'assign', id: 'sr-n', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', override_hours: true, dealer_id: undefined }, { token: 'pres' });
    assert.ok(!zohoWrites(w).some(x => /\/Tasks/.test(x.path)));
    // The rep ties a walk-in request to the TEST dealer while assigning it: still skipped (the chosen dealer is passed on).
    w = W(); w.db.service_requests = [mk('sr-w', null, 'Walk-in Name Not On File')];
    r = await call(load('schedule-api.js', w, ENV), { action: 'assign', id: 'sr-w', dealer_id: 'd-test', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', override_hours: true }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200)); assert.ok(!zohoWrites(w).some(x => /\/Tasks/.test(x.path)), 'an appointment assigned to the TEST dealer reached Zoho');
    w = W(); w.db.service_requests = [mk('sr-r', 'd-greg', 'Glasgow Prescription Center')];
    r = await call(load('schedule-api.js', w, ENV), { action: 'assign', id: 'sr-r', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', override_hours: true }, { token: 'pres' });
    assert.ok(zohoWrites(w).some(x => /\/Tasks/.test(x.path)), 'the real appointment did not reach Zoho'); assert.strictEqual(r.body.zoho.ok, true);
  });

  await t('Scheduling: a website booking whose company or email is a TEST dealer\'s never becomes a Zoho Lead; a real prospect still does', async () => {
    const book = async (w, company, email) => { const mod = load('schedule-api.js', w, ENV); const s = await call(mod, { action: 'consult_slots' });
      const slot = s.body.days.flatMap(d => d.slots)[0]; return call(mod, { action: 'consult_book', company, name: 'Pat', email, start_utc: slot.start_utc }); };
    for (const [company, email] of [['TEST - Golden Sandbox, Inc.', 'qa@nowhere.test'], ['Some Name', 'orders@hcps.test']]) {
      const w = W(); const r = await book(w, company, email);
      assert.strictEqual(r.body.ok, true, 'the booking itself must still succeed'); assert.ok(!zohoWrites(w).some(x => /\/Leads/.test(x.path)), company + ' became a Zoho Lead');
    }
    const w = W(); await book(w, 'Brand New Prospect LLC', 'pat@prospect.test');
    assert.ok(zohoWrites(w).some(x => /\/Leads\/upsert/.test(x.path)), 'a real prospect was not saved as a Lead');
  });

  await t('Scheduling with TEST dealers unreadable: no Zoho task and no Lead, the booking still succeeds, the reason is recorded', async () => {
    let w = W({ ruleDown: true }); w.db.service_requests = [{ id: 'sr-r', status: 'requested', company: 'Glasgow Prescription Center', dealer_id: 'd-greg', email: 'b@x.test', contact_name: 'B', service: 'Demo', preferred_date: '2026-10-20', mode: 'remote' }];
    let r = await call(load('schedule-api.js', w, ENV), { action: 'assign', id: 'sr-r', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', override_hours: true }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(zohoWrites(w), []); assert.ok(fails(w).some(x => x.entity === 'task' && /TEST dealers couldn't be read/.test(x.detail)));
    w = W({ ruleDown: true }); const mod = load('schedule-api.js', w, ENV); const s = await call(mod, { action: 'consult_slots' });
    r = await call(mod, { action: 'consult_book', company: 'Brand New Prospect LLC', name: 'Pat', email: 'pat@prospect.test', start_utc: s.body.days.flatMap(d => d.slots)[0].start_utc });
    assert.strictEqual(r.body.ok, true); assert.deepStrictEqual(zohoWrites(w), []); assert.ok(fails(w).some(x => x.entity === 'lead' && /TEST dealers couldn't be read/.test(x.detail)));
  });

  await t('Master-list load (accounts and contacts stages): a TEST dealer\'s name or address is skipped; unreadable rule → nothing sent', async () => {
    // The action reads the bundled master list at call time; it is swapped for a small list here (the loader
    // gives each run a fresh copy, so the swap happens after load and the real file is never changed).
    const loadMaster = (w, body) => { const mod = load('zoho-api.js', w, ENV); const m = require('../netlify/functions/_zoho_master_data.js');
      m.accounts = [{ name: 'TEST — Golden Sandbox' }, { name: 'Glasgow Prescription Center' }];
      m.contacts = [{ company: 'TEST — Golden Sandbox', email: 'x@y.test', last: 'X' }, { company: 'Elsewhere', email: 'orders@hcps.test', last: 'Y' }, { company: 'Glasgow Prescription Center', email: 'real@glasgow.test', last: 'Real' }];
      return call(mod, body, { token: 'pres' }); };
    let w = W(); let r = await loadMaster(w, { action: 'zoho_load_master', stage: 'accounts' });
    assert.strictEqual(r.body.test_excluded, 1, JSON.stringify(r.body).slice(0, 200)); noTest(w, 'load master accounts'); assert.ok(sent(w).includes('Glasgow Prescription Center'));
    w = W(); r = await loadMaster(w, { action: 'zoho_load_master', stage: 'contacts' });
    assert.strictEqual(r.body.test_excluded, 2, JSON.stringify(r.body).slice(0, 200)); noTest(w, 'load master contacts'); assert.ok(sent(w).includes('real@glasgow.test'));
    w = W({ ruleDown: true }); r = await loadMaster(w, { action: 'zoho_load_master', stage: 'accounts' });
    assert.strictEqual(r.body.error, 'test_rule_unavailable'); assert.deepStrictEqual(zohoWrites(w), []);
  });

  await t('Campaigns: a TEST dealer\'s recipients are dropped before the list goes to Zoho Campaigns; unreadable rule → nothing sent', async () => {
    const camp = { id: 'mc1', name: 'Fall promo', status: 'draft', audience: { count: 3, sample: [
      { dealer_id: 'd-greg', name: 'Rita', email: 'rita@glasgow.test' }, { dealer_id: 'd-test', name: 'Sandbox', email: 'orders@hcps.test' }, { dealer_id: 'd-ang', name: 'Shared', email: 'shared@both.test' } ] } };
    let w = W(); w.db.marketing_campaigns = [JSON.parse(JSON.stringify(camp))];
    await call(load('campaign-api.js', w, ENV), { action: 'push_to_zoho', id: 'mc1' }, { token: 'pres' });
    const up = w.calls.filter(c => /campaigns\.zoho\.com/.test(c.url)).map(c => decodeURIComponent(String(c.body || ''))).join(' ');
    assert.ok(/rita@glasgow\.test/.test(up) && /shared@both\.test/.test(up), 'real recipients were not uploaded: ' + up.slice(0, 200));
    assert.ok(!/orders@hcps\.test/.test(up), 'a TEST recipient was uploaded');
    w = W({ ruleDown: true }); w.db.marketing_campaigns = [JSON.parse(JSON.stringify(camp))];
    const r = await call(load('campaign-api.js', w, ENV), { action: 'push_to_zoho', id: 'mc1' }, { token: 'pres' });
    assert.strictEqual(r.body.error, 'test_rule_unavailable'); assert.ok(!w.calls.some(c => /campaigns\.zoho\.com/.test(c.url)));
  });

  await t('Every push path in the code goes through the shared rule (no path left out)', () => {
    const fs = require('fs'), path = require('path'), dir = path.join(__dirname, '..', 'netlify', 'functions');
    const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
    const api = read('zoho-api.js');
    for (const a of ['sync_accounts', 'sync_contacts', 'zoho_import_accounts', 'zoho_import_contacts', 'zoho_load_master', 'sync_deals', 'mirror_to_zoho', 'sync_opportunities']) {
      const i = api.indexOf('b.action==="' + a + '"'); const j = api.indexOf('if(b.action===', i + 10);
      assert.ok(/testRule\(\)/.test(api.slice(i, j > 0 ? j : undefined)), a + ' does not use the TEST rule');
    }
    assert.ok(/ZT\.load\(sbGet\)/.test(read('zoho-autosync.js')) && /ZT\.load\(sbGet\)/.test(read('schedule-api.js')) && /_zoho_test\.js"\)\.load\(sbGet\)/.test(read('campaign-api.js')));
    // Any other file that writes to Zoho must be added here and to the rule.
    const writers = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !/^_zoho/.test(f) && /zohoapis|upsertRecords\(|zoho\("(POST|PUT)"|pushCampaign\(/.test(read(f)));
    assert.deepStrictEqual(writers.sort(), ['campaign-api.js', 'schedule-api.js', 'zoho-api.js', 'zoho-autosync.js']);
  });

  done('Phase 2F-2 TEST isolation');
})();

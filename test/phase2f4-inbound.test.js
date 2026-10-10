/* Phase 2F-4 — reliable inbound capture + duplicate protection + echo classification (capture/classify ONLY).

   I1  Identity: every webhook event is captured under a stable key (module + Zoho record id + Modified_Time +
       a hash of the cleaned payload) through hcps_zoho_capture_event — one queue row per event. A repeat of
       the same event (a Zoho retry, even concurrent) only counts the delivery; two genuine edits are two rows.
   I2  Every event ends in an explainable state: captured (pending), duplicate (counted + receipt "duplicate"),
       failed (no id / unknown module / unreadable body — a failed row + a failure row), not captured (failure
       row + 503 so Zoho may retry). Unauthenticated calls stay refused (401) and are never captured. No secret
       is stored, logged or returned. Modified_By never decides anything.
   I3  Echo classification (autosync): an event is an HCPS echo ONLY when (a) exactly one HCPS record's last
       ACCEPTED push went to that Zoho record (module + id), (b) Zoho's current values of the pushed fields hash
       to that push's fingerprint, and (c) the event's Modified_Time falls at that push (−10 min … +2 min).
       Echo → status "ignored" with the reason. Otherwise "external" (or "unresolved" when it can't be tied to
       one HCPS record, or Zoho has no such record) and it STAYS PENDING for 2F-5. If Zoho or HCPS's push records
       can't be read, nothing is guessed: the events stay unclassified, a failure row says why, the run is partial.
   I4  Capture/classification never applies anything: no dealer, contact, deal, stage/value/close date,
       activity or timeline write, no new contact, and no Zoho write.
   I5  Push times are recorded only for pushes Zoho accepted; 2F-2 TEST blocking and the outbound/pull
       behaviour are unchanged.
   I6  The migration: a full unique index on event_key is the conflict target; the old partial index is dropped;
       the function and the webhook agree on every field; there is a rollback. */
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const NEW = 'hdr-9b1f27c4e05d48a6b3c2f1e0d9a8b7c6', CLIENT_SECRET = 'zcs-b81d44e0aa';
const ENV = { ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: CLIENT_SECRET, ZOHO_WEBHOOK_HEADER_SECRET: NEW, ZOHO_WEBHOOK_SECRET: undefined };
const SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'phase2f4_inbound_identity.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'phase2f4_inbound_identity_rollback.sql'), 'utf8');

function seed(o) {
  o = o || {};
  const S = standardSeed({
    app_settings: [{ key: 'zoho_auth', value: { refresh_token: 'rt', api_domain: 'https://www.zohoapis.com' } }, { key: 'zoho_push_hashes', value: {} }].concat(o.settings || []),
    dealer_contacts: [{ id: 'c1', dealer_id: 'd-greg', name: 'Rita Owner', email: 'rita@glasgow.test' }, { id: 'ct1', dealer_id: 'd-test', name: 'Sandbox (Angelo)', email: 'orders@hcps.test' }],
    opportunities: [
      { id: 'o1', dealer_id: 'd-greg', title: 'Real deal 1', stage: 'identified', value: 100, expected_close: '2026-11-01', zoho_id: 'Z1' },
      { id: 'o2', dealer_id: 'd-ang', title: 'Real deal 2', stage: 'quoted', value: 200, expected_close: '2026-12-01', zoho_id: null, line: 'Golden' },
      { id: 'ot1', dealer_id: 'd-test', title: 'Sandbox deal A', stage: 'lost', value: 1, expected_close: '2026-10-02', zoho_id: 'ZT1' } ],
    dealer_activity: [], zoho_sync_queue: o.queue || [], zoho_sync_log: [],
  });
  S.tables.dealers.push({ id: 'd-test', business_name: 'TEST — Golden Sandbox', rep_name: null, parent_id: null, state: 'IN', is_test: true, email: 'orders@hcps.test', contact_name: 'Sandbox (Angelo)' });
  S.zoho = Object.assign({ modules: {
    Accounts: [{ id: 'A1', Account_Name: 'Glasgow Prescription Center' }, { id: 'AT', Account_Name: 'TEST — Golden Sandbox' }],
    Contacts: [{ id: 'CT1', Last_Name: 'Sandbox', Email: 'orders@hcps.test' }],
    Deals: [{ id: 'Z1', Deal_Name: 'Real deal 1', Stage: 'Qualification', Amount: 100, Closing_Date: '2026-11-01', Modified_Time: '2026-10-01T15:00:00Z' },
      { id: 'ZT1', Deal_Name: 'Sandbox deal A', Stage: 'Closed Lost', Amount: 1, Closing_Date: '2026-10-02', Modified_Time: '2026-10-01T15:00:00Z' },
      { id: 'ZX9', Deal_Name: 'Someone else\'s deal', Stage: 'Qualification', Amount: 5, Closing_Date: '2026-11-05', Modified_Time: '2026-10-01T15:00:00Z' }] } }, o.zoho || {});
  if (o.failRead) S.failRead = o.failRead; if (o.failWrite) S.failWrite = o.failWrite; if (o.missingRpc) S.missingRpc = o.missingRpc;
  return S;
}
const W = o => createWorld(seed(o));
const logs = w => w.db.zoho_sync_log || [];
const fails = w => logs(w).filter(l => l.result === 'fail');
const failPhase = (w, ph) => fails(w).filter(l => JSON.parse(l.detail).phase === ph);
const receipts = w => logs(w).filter(l => l.action === 'webhook');
const runRow = w => logs(w).filter(l => l.entity === 'autosync' && l.action === 'run').slice(-1)[0];
const queue = w => w.db.zoho_sync_queue;
const setting = (w, k) => { const r = (w.db.app_settings || []).find(x => x.key === k); return r ? r.value : undefined; };
const zohoWrites = w => w.outbound.filter(x => x.kind === 'zoho' && x.method !== 'GET');
const zrec = (w, mod, id) => w.db && (w.__seed.zoho.modules[mod] || []).find(r => String(r.id) === String(id));

let consoleOut = '';
const origErr = console.error, origWarn = console.warn;
function capture() { consoleOut = ''; console.error = (...a) => { consoleOut += a.join(' ') + '\n'; }; console.warn = console.error; }
function release() { console.error = origErr; console.warn = origWarn; }
const everything = (w, r) => JSON.stringify(w.db) + JSON.stringify(w.writes) + JSON.stringify(w.calls) + consoleOut + (r ? JSON.stringify(r) : '');
const noSecrets = (w, r) => { const all = everything(w, r); for (const s of [NEW, CLIENT_SECRET]) assert.ok(!all.includes(s), 'a secret is stored, logged or returned'); };

const form = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
const FORM = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' };
async function hook(w, ev, env) {
  const mod = load('zoho-webhook.js', w, env || ENV); capture();
  try { return await mod.handler(Object.assign({ httpMethod: 'POST', headers: {}, queryStringParameters: {} }, ev)); } finally { release(); }
}
const deliver = (w, fields, extraHeaders) => hook(w, { headers: Object.assign({ 'x-hcps-secret': NEW }, FORM, extraHeaders || {}), body: typeof fields === 'string' ? fields : form(fields) });
async function autosync(w) { const r = await load('zoho-autosync.js', w, ENV).handler({}); return JSON.parse(r.body); }
// The live webhook sends Modified_Time as "yyyy-mm-dd HH:MM:SS", Zoho org time (America/Chicago).
function chicago(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const at = ms => chicago(new Date(ms));
// A world whose seed stays reachable (the fake Zoho's records live on the seed).
function world(o) { const S = seed(o); const w = createWorld(S); w.__seed = S; return w; }
// Business tables: nothing here may change while events are captured or classified.
const business = w => JSON.stringify(['dealers', 'dealer_contacts', 'opportunities', 'dealer_activity', 'dealer_notes', 'dealer_tasks'].map(k => w.db[k] || null));
function pushTimes(w) { return setting(w, 'zoho_push_times') || {}; }
function setPushAt(w, key, iso) { const v = pushTimes(w); v[key] = Object.assign({}, v[key], { at: iso }); w.db.app_settings.find(x => x.key === 'zoho_push_times').value = v; }

(async () => {
  /* ---------------- I1 — identity ---------------- */
  await t('I1 an event is captured ONCE under its identity: one rpc call, one queue row carrying module, id, Modified_Time, Modified_By; receipt "captured"', async () => {
    const w = W();
    const r = await deliver(w, { module: 'Accounts', id: '7530569000000833001', Modified_Time: '2026-10-08 13:03:06', Modified_By: 'Angelo Audia', Account_Name: 'TEST — Golden Sandbox' });
    assert.strictEqual(r.statusCode, 200); assert.deepStrictEqual(JSON.parse(r.body), { ok: true, received: 'Accounts #7530569000000833001 TEST — Golden Sandbox' });
    const q = queue(w); assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].direction, 'in'); assert.strictEqual(q[0].entity, 'accounts'); assert.strictEqual(q[0].zoho_id, '7530569000000833001'); assert.strictEqual(q[0].entity_id, '7530569000000833001');
    assert.strictEqual(q[0].module, 'accounts'); assert.strictEqual(q[0].modified_time, '2026-10-08 13:03:06'); assert.strictEqual(q[0].modified_by, 'Angelo Audia');
    assert.strictEqual(q[0].status, 'pending'); assert.strictEqual(q[0].classification, null); assert.strictEqual(q[0].deliveries, 1);
    assert.ok(/^in:accounts:7530569000000833001:2026-10-08 13:03:06:[0-9a-f]{24}$/.test(q[0].event_key), q[0].event_key);
    const rc = receipts(w); assert.strictEqual(rc.length, 1); assert.strictEqual(rc[0].result, 'ok');
    const d = JSON.parse(rc[0].detail); assert.strictEqual(d.outcome, 'captured'); assert.strictEqual(d.queue_id, q[0].id); assert.strictEqual(d.event_key, q[0].event_key);
    assert.strictEqual(fails(w).length, 0); noSecrets(w, r);
  });

  await t('I1 the same event delivered again (a Zoho retry) is NOT a second queue item: deliveries counts it, the receipt says "duplicate", Zoho gets 200', async () => {
    const w = W(); const ev = { module: 'Contacts', id: '7530569000000901', Modified_Time: '2026-10-08 13:03:06', Modified_By: 'Angelo Audia', Account_Name: '7530569000000833001', Email: 'orders@hcps.test' };
    const a = await deliver(w, ev), b = await deliver(w, ev), c = await deliver(w, ev);
    for (const r of [a, b, c]) assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(queue(w).length, 1); assert.strictEqual(queue(w)[0].deliveries, 3);
    assert.deepStrictEqual(receipts(w).map(x => x.result), ['ok', 'duplicate', 'duplicate']);
    assert.deepStrictEqual(receipts(w).map(x => JSON.parse(x.detail).outcome), ['captured', 'duplicate', 'duplicate']);
    assert.strictEqual(JSON.parse(receipts(w)[2].detail).deliveries, 3); assert.strictEqual(fails(w).length, 0);
  });

  await t('I1 identity ignores field order and surrounding spaces, but nothing else: a re-ordered retry is the same event', async () => {
    const w = W();
    await deliver(w, form({ module: 'Deals', id: '75305690000099', Modified_Time: '2026-10-08 13:03:06', Account_Name: '7530569000000833001', Modified_By: 'Angelo Audia' }));
    await deliver(w, form({ Modified_By: 'Angelo Audia ', Account_Name: '7530569000000833001', id: '75305690000099', Modified_Time: '2026-10-08 13:03:06', module: 'Deals' }));
    assert.strictEqual(queue(w).length, 1); assert.strictEqual(queue(w)[0].deliveries, 2);
  });

  await t('I1 two genuine edits of the same record are two events — whether Modified_Time or only the payload differs', async () => {
    const w = W();
    await deliver(w, { module: 'Accounts', id: '55', Modified_Time: '2026-10-08 13:03:06', Account_Name: 'Glasgow Prescription Center' });
    await deliver(w, { module: 'Accounts', id: '55', Modified_Time: '2026-10-08 13:09:41', Account_Name: 'Glasgow Prescription Center' });
    await deliver(w, { module: 'Accounts', id: '55', Modified_Time: '2026-10-08 13:09:41', Account_Name: 'Glasgow Prescription Ctr' });
    assert.strictEqual(queue(w).length, 3); assert.strictEqual(new Set(queue(w).map(q => q.event_key)).size, 3);
    assert.ok(queue(w).every(q => q.status === 'pending' && q.deliveries === 1));
    assert.deepStrictEqual(receipts(w).map(x => JSON.parse(x.detail).outcome), ['captured', 'captured', 'captured']);
  });

  await t('I1 retries that race each other still make one queue item (the database key decides, not an application check)', async () => {
    const w = W(); const ev = { module: 'Accounts', id: '56', Modified_Time: '2026-10-08 13:03:06' };
    const mod = load('zoho-webhook.js', w, ENV); capture();
    try { await Promise.all([1, 2, 3, 4].map(() => mod.handler({ httpMethod: 'POST', headers: Object.assign({ 'x-hcps-secret': NEW }, FORM), queryStringParameters: {}, body: form(ev) }))); } finally { release(); }
    assert.strictEqual(queue(w).length, 1); assert.strictEqual(queue(w)[0].deliveries, 4);
    const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'zoho-webhook.js'), 'utf8');
    assert.ok(!/zoho_sync_queue\?/.test(src), 'the webhook writes the queue table directly (an application-side check) instead of through the function');
  });

  /* ---------------- I2 — explainable states, refusals, sanitization ---------------- */
  await t('I2 no record id, an unknown module or an unreadable body: kept as a FAILED queue row with the reason + a failure row (never dropped)', async () => {
    for (const [ev, why] of [
      [{ body: form({ module: 'Accounts', Modified_Time: '2026-10-08 13:03:06' }), headers: FORM }, /no Zoho record id/],
      [{ body: form({ module: 'Leads', id: '77' }), headers: FORM }, /no module HCPS captures \(Leads\)/],
      [{ body: '{"module": "Accounts", "id": ', headers: { 'content-type': 'application/json' } }, /no module HCPS captures|no Zoho record id/],
    ]) {
      const w = W(); const r = await hook(w, { headers: Object.assign({ 'x-hcps-secret': NEW }, ev.headers), body: ev.body });
      assert.strictEqual(r.statusCode, 200);
      const q = queue(w); assert.strictEqual(q.length, 1); assert.strictEqual(q[0].status, 'failed'); assert.ok(why.test(q[0].last_error), q[0].last_error);
      const f = failPhase(w, 'webhook_identity'); assert.strictEqual(f.length, 1); assert.ok(why.test(JSON.parse(f[0].detail).msg));
      assert.strictEqual(JSON.parse(receipts(w)[0].detail).outcome, 'failed'); noSecrets(w, r);
    }
  });

  await t('I2 a capture the database refuses: failure row (with the event identity), receipt "not_captured", 503 so Zoho may retry, nothing secret', async () => {
    const w = W({ failWrite: (m, tb) => tb === 'rpc/hcps_zoho_capture_event' ? 500 : 0 });
    const r = await deliver(w, { module: 'Accounts', id: '57', Modified_Time: '2026-10-08 13:03:06' });
    assert.strictEqual(r.statusCode, 503); assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'not_captured' });
    const f = failPhase(w, 'webhook_queue'); assert.strictEqual(f.length, 1);
    const d = JSON.parse(f[0].detail); assert.ok(/XX000/.test(d.msg)); assert.ok(/^in:accounts:57:2026-10-08 13:03:06:/.test(d.event_key));
    assert.strictEqual(JSON.parse(receipts(w)[0].detail).outcome, 'not_captured'); noSecrets(w, r);
  });

  await t('I2 unauthenticated or wrongly authenticated calls stay refused (401) and are never captured', async () => {
    for (const headers of [FORM, Object.assign({ 'x-hcps-secret': 'wrong' }, FORM)]) {
      const w = W(); const r = await hook(w, { headers, body: form({ module: 'Accounts', id: '58', Modified_Time: '2026-10-08 13:03:06' }) });
      assert.strictEqual(r.statusCode, 401); assert.strictEqual(queue(w).length, 0);
      assert.ok(!w.calls.some(c => /\/rpc\//.test(c.url)), 'a refused call reached the capture function');
    }
    const w = W(); const r = await hook(w, { headers: FORM, body: form({ module: 'Accounts', id: '58', secret: NEW }) });   // the secret as a parameter
    assert.strictEqual(r.statusCode, 401); assert.strictEqual(queue(w).length, 0); noSecrets(w, r);
  });

  await t('I2 sanitization intact: a credential-named field or a value holding the secret never reaches the queue, the key or the log', async () => {
    const w = W();
    const r = await deliver(w, { module: 'Accounts', id: '59', Modified_Time: '2026-10-08 13:03:06', token: 'abc-token', Description: 'note ' + NEW + ' end' });
    assert.strictEqual(r.statusCode, 200); const p = queue(w)[0].payload;
    assert.ok(!('token' in p)); assert.ok(!JSON.stringify(p).includes(NEW)); noSecrets(w, r);
  });

  await t('I2 Modified_By decides nothing at capture: an edit by "Angelo Audia" (the integration user AND a real person) is captured pending like any other', async () => {
    const w = W();
    const r = await deliver(w, { module: 'Accounts', id: '60', Modified_Time: '2026-10-08 13:03:06', Modified_By: 'Angelo Audia' });
    assert.strictEqual(r.statusCode, 200); assert.strictEqual(queue(w)[0].status, 'pending'); assert.strictEqual(queue(w)[0].classification, null);
  });

  /* ---------------- I3 — echo classification ---------------- */
  await t('I3 parseZohoTime: the webhook\'s Chicago wall-clock time (CDT and CST), ISO with offset, and garbage', async () => {
    const A = load('zoho-autosync.js', W(), ENV);
    const iso = s => { const d = A._parseZohoTime(s); return d ? d.toISOString() : null; };
    assert.strictEqual(iso('2026-10-08 13:03:06'), '2026-10-08T18:03:06.000Z');
    assert.strictEqual(iso('2026-01-08 13:03:06'), '2026-01-08T19:03:06.000Z');
    assert.strictEqual(iso('2026-03-08 03:30:00'), '2026-03-08T08:30:00.000Z');
    assert.strictEqual(iso('2026-10-08T13:03:06-05:00'), '2026-10-08T18:03:06.000Z');
    assert.strictEqual(iso('2026-10-08T18:03:06Z'), '2026-10-08T18:03:06.000Z');
    assert.strictEqual(iso('yesterday'), null); assert.strictEqual(iso(''), null);
  });

  await t('I3 a natural HCPS echo — account, contact and deal — is "ignored" with an auditable reason (tied to the Zoho id HCPS pushed to)', async () => {
    // run 1 creates o2 in Zoho and records the baselines; an HCPS change to o1 is then pushed by run 2 (2F-5: a
    // linked deal is pushed only for a field HCPS changed)
    const w = world(); await autosync(w); w.db.opportunities.find(o => o.id === 'o1').value = 120; await autosync(w);
    const T = pushTimes(w);
    for (const k of ['acct:d-greg', 'contact:rita@glasgow.test', 'opp:o1', 'opp:o2']) assert.ok(T[k] && T[k].at && T[k].id, 'no push record for ' + k);
    assert.strictEqual(T['opp:o1'].id, 'Z1');
    const now = Date.now();
    await deliver(w, { module: 'Accounts', id: T['acct:d-greg'].id, Modified_Time: at(now), Modified_By: 'Angelo Audia', Account_Name: 'Glasgow Prescription Center' });
    await deliver(w, { module: 'Contacts', id: T['contact:rita@glasgow.test'].id, Modified_Time: at(now), Modified_By: 'Angelo Audia', Email: 'rita@glasgow.test' });
    await deliver(w, { module: 'Deals', id: 'Z1', Modified_Time: at(now), Modified_By: 'Angelo Audia' });
    await deliver(w, { module: 'Deals', id: T['opp:o2'].id, Modified_Time: at(now), Modified_By: 'Angelo Audia' });   // a deal with a product line (Description)
    const before = business(w);
    const r = await autosync(w);
    for (const q of queue(w)) {
      assert.strictEqual(q.classification, 'echo', q.entity + ': ' + q.class_reason); assert.strictEqual(q.status, 'ignored');
      assert.ok(q.processed_at && q.classified_at); assert.ok(/^HCPS echo: Zoho record \S+ holds exactly what HCPS pushed for (acct|contact|opp):/.test(q.class_reason), q.class_reason);
    }
    assert.deepStrictEqual(r.summary.inbound, { classified: 4, echo: 4, external: 0, unresolved: 0, left_unclassified: 0 });
    assert.strictEqual(business(w), before, 'classifying echoes changed a business record');
  });

  await t('I3 Modified_By = Angelo but the values differ from HCPS\'s last push → EXTERNAL, kept pending (a real manual edit is never discarded)', async () => {
    const w = world(); await autosync(w);
    const id = pushTimes(w)['acct:d-greg'].id; zrec(w, 'Accounts', id).Phone = '270-555-0199';   // a person edits the account in Zoho
    await deliver(w, { module: 'Accounts', id, Modified_Time: at(Date.now()), Modified_By: 'Angelo Audia' });
    const before = business(w); await autosync(w);
    const q = queue(w)[0]; assert.strictEqual(q.classification, 'external'); assert.strictEqual(q.status, 'pending'); assert.strictEqual(q.processed_at, null);
    assert.ok(/differ from HCPS's last successful push for acct:d-greg/.test(q.class_reason), q.class_reason);
    assert.strictEqual(business(w), before, 'the external change was applied to HCPS (2F-4 is capture/classify only)');
    assert.deepStrictEqual(zohoWrites(w).filter(x => /Accounts/.test(x.path)).length, 1, 'the Zoho edit was pushed over (only run 1\'s push should exist)');
  });

  await t('I3 values equal to HCPS\'s push but the change happened away from that push → EXTERNAL (time alone never proves an echo; equality alone neither)', async () => {
    const w = world(); await autosync(w);
    const id = pushTimes(w)['acct:d-greg'].id; const pushed = Date.parse(pushTimes(w)['acct:d-greg'].at);
    const cases = [[-11 * 60e3, 'external'], [-9 * 60e3, 'echo'], [90e3, 'echo'], [3 * 60e3, 'external'], [3 * 3600e3, 'external'], [-3600e3, 'external']];
    for (const [dt] of cases) await deliver(w, { module: 'Accounts', id, Modified_Time: at(pushed + dt), Modified_By: 'Angelo Audia' });
    await autosync(w);
    const got = queue(w).map(q => q.classification);
    assert.deepStrictEqual(got, cases.map(c => c[1]), JSON.stringify(queue(w).map(q => [q.modified_time, q.classification, q.class_reason])));
    for (const q of queue(w).filter(q => q.classification === 'external')) { assert.strictEqual(q.status, 'pending'); assert.ok(/was not made by that push/.test(q.class_reason)); }
  });

  await t('I3 a record HCPS never pushed (TEST account/contact/deal, an unlinked deal) → EXTERNAL with the reason; a TEST record is noted as such', async () => {
    const w = world(); await autosync(w);
    const now = at(Date.now());
    await deliver(w, { module: 'Accounts', id: 'AT', Modified_Time: now, Account_Name: 'TEST — Golden Sandbox' });
    await deliver(w, { module: 'Contacts', id: 'CT1', Modified_Time: now, Email: 'orders@hcps.test' });
    await deliver(w, { module: 'Deals', id: 'ZT1', Modified_Time: now });
    await deliver(w, { module: 'Deals', id: 'ZX9', Modified_Time: now });
    await autosync(w);
    const q = queue(w); assert.ok(q.every(x => x.classification === 'external'), JSON.stringify(q.map(x => [x.zoho_id, x.classification])));
    // Accounts, Contacts and unlinked Deals stay pending; a LINKED deal's external event is processed by 2F-5 (no change here).
    assert.deepStrictEqual(q.map(x => x.status), ['pending', 'pending', 'synced', 'pending'], JSON.stringify(q.map(x => [x.zoho_id, x.status, x.outcome])));
    assert.ok(q.every(x => /HCPS has no recorded successful push to this Zoho record/.test(x.class_reason)));
    assert.ok(q.slice(0, 3).every(x => /TEST/.test(x.class_reason)), JSON.stringify(q.map(x => x.class_reason)));
    assert.ok(!/TEST/.test(q[3].class_reason));
  });

  await t('I3 UNRESOLVED (kept pending): the record is not in Zoho, or two HCPS records were last pushed to the same Zoho record', async () => {
    const w = world(); await autosync(w);
    const T = pushTimes(w); const id = T['acct:d-greg'].id;
    T['acct:d-ang'] = { at: T['acct:d-greg'].at, id }; w.db.app_settings.find(x => x.key === 'zoho_push_times').value = T;
    await deliver(w, { module: 'Accounts', id: '999999', Modified_Time: at(Date.now()) });
    await deliver(w, { module: 'Accounts', id, Modified_Time: at(Date.now()) });
    await autosync(w);
    const [gone, two] = queue(w);
    assert.strictEqual(gone.classification, 'unresolved'); assert.ok(/not found in Zoho/.test(gone.class_reason)); assert.strictEqual(gone.status, 'pending');
    assert.strictEqual(two.classification, 'unresolved'); assert.ok(/2 HCPS records were last pushed to this Zoho record/.test(two.class_reason)); assert.strictEqual(two.status, 'pending');
  });

  await t('I3 Zoho can\'t be read: that module\'s events stay UNCLASSIFIED (not guessed), a failure row says why, the run is partial; other modules still classify', async () => {
    const w = world(); await autosync(w);
    const T = pushTimes(w);
    await deliver(w, { module: 'Accounts', id: T['acct:d-greg'].id, Modified_Time: at(Date.now()) });
    await deliver(w, { module: 'Contacts', id: T['contact:rita@glasgow.test'].id, Modified_Time: at(Date.now()) });
    w.__seed.zoho.idsFail = { Accounts: 500 };
    const r = await autosync(w);
    const [a, c] = queue(w);
    assert.strictEqual(a.classification, null); assert.strictEqual(a.status, 'pending');
    assert.strictEqual(c.classification, 'echo');
    const f = failPhase(w, 'inbound_classify'); assert.strictEqual(f.length, 1); assert.ok(/Zoho Accounts couldn't be read/.test(JSON.parse(f[0].detail).msg));
    assert.strictEqual(runRow(w).result, 'partial'); assert.strictEqual(r.summary.inbound.left_unclassified, 1);
    delete w.__seed.zoho.idsFail; await autosync(w);
    assert.strictEqual(queue(w)[0].classification, 'echo', 'the next run did not classify it');
  });

  await t('I3 HCPS push times can\'t be read: no event is classified, the stored times are NOT wiped, a failure row says why, the run is partial', async () => {
    const S0 = world(); await autosync(S0); const saved = pushTimes(S0);
    const w = world({ settings: [{ key: 'zoho_push_times', value: saved }], failRead: (tb, qs) => tb === 'app_settings' && /zoho_push_times/.test(decodeURIComponent(qs)) ? 500 : 0 });
    // the world has fresh hashes, so this run pushes everything again — and must still not overwrite the unreadable times
    await deliver(w, { module: 'Accounts', id: saved['acct:d-greg'].id, Modified_Time: at(Date.now()) });
    const r = await autosync(w);
    assert.strictEqual(queue(w)[0].classification, null); assert.strictEqual(r.summary.inbound.left_unclassified, 1);
    assert.deepStrictEqual(setting(w, 'zoho_push_times'), saved, 'push times were overwritten after a failed read');
    assert.strictEqual(failPhase(w, 'push_times_read').length, 1); assert.strictEqual(runRow(w).result, 'partial');
  });

  await t('I3 an event already classified is never classified again; failed rows are never classified', async () => {
    const pre = [{ id: 1, direction: 'in', entity: 'accounts', entity_id: '61', zoho_id: '61', event_key: 'k1', status: 'pending', classification: 'external', class_reason: 'X', classified_at: '2026-10-08T10:00:00Z', modified_time: '2026-10-08 05:00:00' },
      { id: 2, direction: 'in', entity: 'unknown', entity_id: null, zoho_id: null, event_key: 'k2', status: 'failed', classification: null, last_error: 'the event carries no Zoho record id' }];
    const w = world({ queue: pre }); const r = await autosync(w);
    assert.deepStrictEqual(queue(w).map(q => [q.status, q.classification, q.class_reason || null, q.classified_at || null]), [['pending', 'external', 'X', '2026-10-08T10:00:00Z'], ['failed', null, null, null]]);
    assert.strictEqual(r.summary.inbound, undefined);
  });

  await t('I3 the classifier never reads Modified_By', async () => {
    const w = world({ queue: [{ id: 1, direction: 'in', entity: 'accounts', entity_id: '63', zoho_id: '63', event_key: 'k63', status: 'pending', classification: null, modified_time: '2026-10-08 13:03:06', modified_by: 'Angelo Audia' }] });
    const A = load('zoho-autosync.js', w, ENV);
    assert.ok(!/modified_?by/i.test(A._classifyOne.toString()), 'classifyOne looks at Modified_By');
    await A.handler({});
    const reads = w.calls.filter(c => c.method === 'GET' && /\/zoho_sync_queue\?/.test(c.url)).map(c => decodeURIComponent(c.url));
    assert.ok(reads.length >= 1 && reads.every(u => !/modified_by|select=\*/.test(u)), 'the inbound queue read takes Modified_By: ' + reads.join(' '));
  });

  /* ---------------- I4 — capture/classify only ---------------- */
  await t('I4 capture + classification change NO business record and write nothing to Zoho — not even a new contact or a timeline entry', async () => {
    const w = world(); await autosync(w); await autosync(w);   // settle: nothing left to push
    const before = business(w); const zBefore = zohoWrites(w).length; const wBefore = w.writes.length;
    const T = pushTimes(w); const now = at(Date.now());
    zrec(w, 'Contacts', T['contact:rita@glasgow.test'].id).Phone = '270-555-0101';
    w.__seed.zoho.modules.Contacts.push({ id: 'CNEW', Last_Name: 'Newperson', First_Name: 'Nina', Email: 'nina@glasgow.test', Account_Name: { id: T['acct:d-greg'].id } });
    zrec(w, 'Deals', 'ZX9').Amount = 9999;   // (a LINKED deal's stage/amount/close is the existing 15-minute pull's job — unchanged, not part of 2F-4)
    for (const ev of [{ module: 'Contacts', id: T['contact:rita@glasgow.test'].id, Email: 'rita@glasgow.test' }, { module: 'Contacts', id: 'CNEW', Email: 'nina@glasgow.test', Account_Name: T['acct:d-greg'].id },
      { module: 'Accounts', id: T['acct:d-greg'].id, Account_Name: 'Glasgow Prescription Center' }, { module: 'Deals', id: 'ZX9' }, { module: 'Deals', id: 'Z1' }])
      await deliver(w, Object.assign({ Modified_Time: now, Modified_By: 'Angelo Audia' }, ev));
    // the webhook alone wrote nothing but the log and the capture function
    const hookWrites = w.writes.slice(wBefore).filter(x => x.kind !== 'rpc' && x.table !== 'zoho_sync_log');
    assert.deepStrictEqual(hookWrites, []);
    const zw = zohoWrites(w).length; const wMid = w.writes.length;
    await autosync(w);
    const classifyWrites = w.writes.slice(wMid).filter(x => !['zoho_sync_queue', 'zoho_sync_log', 'app_settings'].includes(x.table) && !/^opportunities$/.test(x.table));
    assert.deepStrictEqual(classifyWrites, [], 'wrote ' + JSON.stringify(classifyWrites));
    assert.deepStrictEqual(w.writes.slice(wMid).filter(x => x.table === 'opportunities'), [], 'a deal was changed');
    assert.strictEqual(zohoWrites(w).length, zw, 'something was pushed to Zoho');
    assert.strictEqual(zw, zBefore);
    assert.ok(queue(w).every(q => q.classification), 'not everything was classified');
    // Account/Contact events and the unlinked deal stay pending; the linked deal's event (Z1, nothing changed) is processed by 2F-5.
    assert.ok(queue(w).filter(q => q.classification !== 'echo' && !(q.entity === 'deals' && q.zoho_id === 'Z1')).every(q => q.status === 'pending'));
    assert.ok(queue(w).filter(q => q.entity === 'deals' && q.zoho_id === 'Z1').every(q => q.status === 'ignored' || (q.status === 'synced' && /no change to a shared field/.test(q.outcome))));
    assert.strictEqual((w.db.dealer_contacts || []).filter(c => /nina@/.test(c.email)).length, 0, 'a new contact was created from an inbound event');
    assert.strictEqual((w.db.dealer_activity || []).length, 0, 'a timeline entry was created from an inbound event');
    assert.strictEqual(w.db.opportunities.find(o => o.id === 'o1').stage, 'identified', 'the deal stage was changed');
    // (2F-5: o1 was never pushed — its fields were already in step — so its event is external, not an echo)
    assert.deepStrictEqual(queue(w).map(q => q.classification), ['external', 'external', 'echo', 'external', 'external'], JSON.stringify(queue(w).map(q => q.class_reason)));
    assert.strictEqual(business(w), before);
  });

  /* ---------------- I5 — push bookkeeping + unchanged outbound ---------------- */
  await t('I5 push times are recorded only for records Zoho ACCEPTED (with the Zoho id); refused records get neither a fingerprint nor a time', async () => {
    const w = world({ zoho: { batchFail: { Contacts: 400 } } }); await autosync(w);
    const T = pushTimes(w), H = setting(w, 'zoho_push_hashes');
    assert.ok(T['acct:d-greg'] && T['acct:d-ang']); assert.ok(!Object.keys(T).some(k => /^contact:/.test(k)), 'a refused contact got a push time');
    assert.ok(!Object.keys(H).some(k => /^contact:/.test(k)));
    assert.strictEqual(T['opp:o2'].id, w.db.opportunities.find(o => o.id === 'o2').zoho_id, 'a created deal is recorded under the id Zoho gave it');
    assert.ok(!Object.keys(T).some(k => /d-test|ot1|orders@hcps\.test/.test(k)), 'a TEST record got a push time');
  });

  await t('I5 TEST blocking and the run\'s shape are unchanged: nothing TEST is pushed, summary keys as before (+ inbound only when events were classified)', async () => {
    const w = world(); const r = await autosync(w);
    const sent = JSON.stringify(zohoWrites(w).map(x => [x.path, x.body]));
    for (const m of ['TEST — Golden Sandbox', 'orders@hcps.test', 'Sandbox deal']) assert.ok(!sent.includes(m), 'TEST data pushed: ' + m);
    assert.deepStrictEqual(r.summary.test_excluded, { accounts: 1, contacts: 2, deals: 1 });
    assert.deepStrictEqual(Object.keys(r.summary).sort(), ['accounts', 'contacts', 'deals', 'deals_pulled', 'errors', 'failures', 'opportunities', 'run', 'test_excluded']);
    assert.strictEqual(runRow(w).result, 'ok');
  });

  await t('I5 sync_state counts inbound echoes ("ignored") next to pending/synced', async () => {
    const S = standardSeed({ zoho_sync_queue: [{ id: 1, direction: 'in', status: 'pending' }, { id: 2, direction: 'in', status: 'ignored' }, { id: 3, direction: 'in', status: 'ignored' }, { id: 4, direction: 'out', status: 'failed' }], zoho_sync_log: [], app_settings: [] });
    const w = createWorld(S); const r = await call(load('zoho-api.js', w, ENV), { action: 'sync_state' }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.queue.in_ignored, 2); assert.strictEqual(r.body.webhooks.ignored, 2);
    assert.strictEqual(r.body.queue.in_pending, 1); assert.strictEqual(r.body.queue.failed, 1);
  });

  /* ---------------- I6 — the migration ---------------- */
  await t('I6 migration: full unique index on event_key is the conflict target; the partial index is dropped; ignored + classifications allowed; service_role only', async () => {
    const s = SQL.replace(/--.*$/gm, '');
    assert.ok(/create unique index if not exists zoho_queue_event_key_uniq on public\.zoho_sync_queue \(event_key\);/.test(s), 'no full unique index on event_key');
    assert.ok(/drop index if exists public\.zoho_queue_open_uniq;/.test(s));
    assert.ok(/on conflict \(event_key\) do update/.test(s) && !/on conflict \(direction/.test(s), 'the conflict target is not event_key');
    assert.ok(/check \(status in \('pending','processing','synced','failed','skipped','conflict','ignored'\)\)/.test(s));
    assert.ok(/check \(classification is null or classification in \('external','echo','unresolved'\)\)/.test(s));
    assert.ok(/check \(direction <> 'in' or event_key is not null\)/.test(s));
    assert.ok(/revoke all on function public\.hcps_zoho_capture_event\(jsonb\) from public, anon, authenticated;/.test(s));
    assert.ok(/grant execute on function public\.hcps_zoho_capture_event\(jsonb\) to service_role;/.test(s));
    assert.ok(/^begin;/m.test(s) && /^commit;/m.test(s), 'not one transaction');
    assert.ok(!/\bdelete\b|\btruncate\b|drop table/i.test(s), 'the migration deletes data');
  });

  await t('I6 the webhook sends exactly the fields the capture function reads', async () => {
    const read = new Set([...SQL.matchAll(/p->>?'([a-z_]+)'/g)].map(m => m[1]));
    const w = W(); await deliver(w, { module: 'Accounts', id: '62', Modified_Time: '2026-10-08 13:03:06' });
    const sent = Object.keys(w.calls.find(c => /\/rpc\/hcps_zoho_capture_event$/.test(c.url)).body.p);
    assert.deepStrictEqual(sent.slice().sort(), [...read].sort());
  });

  await t('I6 rollback: restores the old partial index and status check, drops the function, keeps every row (older open duplicates → skipped)', async () => {
    const s = ROLLBACK.replace(/--.*$/gm, '');
    assert.ok(/drop function if exists public\.hcps_zoho_capture_event\(jsonb\);/.test(s));
    assert.ok(/create unique index if not exists zoho_queue_open_uniq on public\.zoho_sync_queue \(direction, entity, entity_id\)\s+where status in \('pending','processing'\);/.test(s));
    assert.ok(/check \(status in \('pending','processing','synced','failed','skipped','conflict'\)\)/.test(s));
    assert.ok(/drop index if exists public\.zoho_queue_event_key_uniq;/.test(s));
    assert.ok(!/\bdelete\b|\btruncate\b|drop table/i.test(s), 'the rollback deletes rows');
    assert.ok(s.indexOf('drop constraint if exists zoho_sync_queue_echo_check') < s.indexOf("where status = 'ignored'"), 'the echo check must go before ignored rows change');
  });

  done('Phase 2F-4 inbound capture + echo classification');
})();

/* Phase 2F-1 — Zoho sync security + observability.

   F2.1  Nothing that looks like a credential is stored or logged by the webhook: the ?secret= (or the
         x-hcps-secret header), any secret/token/auth-named field, and any value containing one of this
         deployment's secrets. (2F-4: the event is captured through hcps_zoho_capture_event.)
   F9.1  Every failure the sync used to swallow becomes a failure row (zoho_sync_log, result "fail") and
         the autosync run is logged "partial". What the sync sends to Zoho and writes to HCPS is unchanged.
   F9.2  One failure row per failed record, with its full reason (Zoho's code, message and details); the
         run's summary row is complete JSON (no 600-character cut) and carries counts, not details.

   The fake Zoho (phase0-mock.js) answers OAuth + CRM v8 like the real API; Supabase is the in-memory fake. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const WH_SECRET = 'whsec-7f3a9c2e51', CLIENT_SECRET = 'zcs-b81d44e0aa';
const ENV = { ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: CLIENT_SECRET, ZOHO_WEBHOOK_SECRET: WH_SECRET };
const ZL = load('_zoho_log.js', createWorld(standardSeed()), ENV);

function seed(o) {
  o = o || {};
  const S = standardSeed({
    app_settings: [{ key: 'zoho_auth', value: { refresh_token: 'rt', api_domain: 'https://www.zohoapis.com' } }, { key: 'zoho_push_hashes', value: {} }],
    dealer_contacts: [{ id: 'c1', dealer_id: 'd-greg', name: 'Rita Owner', email: 'rita@glasgow.test' }, { id: 'c2', dealer_id: 'd-ang', name: 'Bob Buyer', email: 'bob@rms.test' }],
    opportunities: Array.from({ length: o.opps || 3 }, (_, i) => ({ id: 'o' + i, dealer_id: i % 2 ? 'd-ang' : 'd-greg', title: 'Deal ' + i, stage: 'identified', value: 10 * i, expected_close: '2026-11-0' + (i % 9 + 1), zoho_id: i < 2 ? 'Z' + i : null })),
    zoho_sync_queue: [], zoho_sync_log: [],
  });
  S.zoho = Object.assign({ modules: { Accounts: [{ id: 'A1', Account_Name: 'Glasgow Prescription Center' }], Deals: [{ id: 'Z0', Deal_Name: 'Deal 0', Stage: 'Closed Won', Amount: 0, Closing_Date: '2026-11-01' }, { id: 'Z1', Deal_Name: 'Deal 1', Stage: 'Qualification', Amount: 10, Closing_Date: '2026-11-02' }] } }, o.zoho || {});
  if (o.rejectQueue) S.missingRpc = ['hcps_zoho_capture_event'];   // a refused capture (the database before the 2F-4 migration)
  if (o.failWrite) S.failWrite = o.failWrite; if (o.failRead) S.failRead = o.failRead;
  return S;
}
const W = o => createWorld(seed(o));
const logs = w => w.db.zoho_sync_log || [];
const fails = w => logs(w).filter(l => l.result === 'fail');
const runRow = w => logs(w).find(l => l.entity === 'autosync' && l.action === 'run');
const everything = w => JSON.stringify(w.db) + JSON.stringify(w.writes);
async function autosync(w) { const mod = load('zoho-autosync.js', w, ENV); const r = await mod.handler({}); return JSON.parse(r.body); }
async function webhook(w, opts) {
  const mod = load('zoho-webhook.js', w, ENV);
  return mod.handler(Object.assign({ httpMethod: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, queryStringParameters: { secret: WH_SECRET } }, opts));
}
const form = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

(async () => {
  /* ---------------- F2.1 — the webhook stores and logs no credential ---------------- */
  await t('F2.1 webhook: the secret, credential-named fields and any value holding a secret never reach the queue or the log', async () => {
    const w = W();
    const r = await webhook(w, { body: form({ module: 'Accounts', id: '7530569000000123', 'Account Name': 'Glasgow Prescription Center', token: 'abc-token', Authorization: 'Bearer x', Description: 'note ' + WH_SECRET + ' end', Phone: '270-555' }) });
    assert.strictEqual(r.statusCode, 200); assert.ok(JSON.parse(r.body).ok);
    const q = w.db.zoho_sync_queue; assert.strictEqual(q.length, 1, 'with a working index the event is queued as before');
    const p = q[0].payload;
    assert.ok(!('secret' in p) && !('token' in p) && !('Authorization' in p), 'a credential field was stored: ' + Object.keys(p).join(','));
    assert.strictEqual(p.Description, 'note [redacted] end'); assert.strictEqual(p.Phone, '270-555'); assert.strictEqual(p['Account Name'], 'Glasgow Prescription Center');
    assert.ok(!everything(w).includes(WH_SECRET), 'the webhook secret is somewhere in the database');
    assert.ok(!everything(w).includes('abc-token'));
    // The receipt carries the same summary as before (module, id, account); since 2F-3 it is the "summary" of a JSON detail.
    const rec = logs(w).find(l => l.action === 'webhook'); assert.strictEqual(rec.result, 'ok'); assert.strictEqual(JSON.parse(rec.detail).summary, 'Accounts #7530569000000123 Glasgow Prescription Center');
  });

  await t('F2.1 webhook: the header form (x-hcps-secret) is honoured and not stored either; a wrong secret stores nothing', async () => {
    const w = W();
    const r = await webhook(w, { queryStringParameters: {}, headers: { 'content-type': 'application/json', 'x-hcps-secret': WH_SECRET }, body: JSON.stringify({ module: 'Deals', id: '9', 'x-hcps-secret': WH_SECRET, Stage: 'Closed Won' }) });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(!everything(w).includes(WH_SECRET)); assert.strictEqual(w.db.zoho_sync_queue[0].payload.Stage, 'Closed Won');
    const w2 = W(); const bad = await webhook(w2, { queryStringParameters: { secret: 'nope' }, body: form({ module: 'Deals', id: '9' }) });
    // 2F-3: a rejected call is no longer silent — one "auth" failure row (names only), no receipt, nothing queued.
    assert.strictEqual(bad.statusCode, 401); assert.strictEqual(w2.db.zoho_sync_queue.length, 0);
    assert.deepStrictEqual(logs(w2).map(l => l.action + ':' + l.result), ['auth:fail']); assert.ok(!everything(w2).includes('nope'));
  });

  await t('F9.1 webhook: when the database refuses the capture, a failure row says so (2F-4: Zoho gets 503 and retries)', async () => {
    const w = W({ rejectQueue: true });
    const r = await webhook(w, { body: form({ module: 'Accounts', id: '55', secret: WH_SECRET }) });
    assert.strictEqual(r.statusCode, 503, 'a refused capture must be retried by Zoho');
    const qw = w.calls.find(c => /\/rpc\/hcps_zoho_capture_event$/.test(c.url));
    assert.ok(qw && qw.method === 'POST', 'the capture call changed');
    assert.strictEqual(w.db.zoho_sync_queue.length, 0);
    const f = fails(w); assert.strictEqual(f.length, 1, 'no failure row for the refused capture');
    assert.strictEqual(f[0].action, 'queue'); assert.strictEqual(f[0].direction, 'in'); assert.strictEqual(f[0].entity_id, '55');
    const d = JSON.parse(f[0].detail); assert.ok(/PGRST202/.test(d.msg), d.msg); assert.strictEqual(d.http, 404);
    assert.ok(!everything(w).includes(WH_SECRET));
    assert.strictEqual(logs(w).find(l => l.action === 'webhook').result, 'ok', 'the receipt row is still written');
  });

  await t('redact(): credential names dropped at any depth; this deployment\'s secrets masked inside any text', () => {
    const r = ZL.redact({ a: 1, secret: 's', API_KEY: 'k', nested: { refresh_token: 'r', note: 'x ' + CLIENT_SECRET + ' y', list: [{ password: 'p', ok: 'fine' }] } });
    assert.deepStrictEqual(r, { a: 1, nested: { note: 'x [redacted] y', list: [{ ok: 'fine' }] } });
    const row = ZL.failRow({ entity: 'contact', entity_id: 'e', phase: 'contacts', msg: 'boom ' + WH_SECRET, extra: { zoho_details: { token: 't', api_name: 'Email' } } });
    assert.deepStrictEqual(Object.keys(row).sort(), ['action', 'dealer_id', 'detail', 'direction', 'entity', 'entity_id', 'result', 'zoho_id'], 'every failure row has the same keys (bulk insert)');
    assert.ok(!row.detail.includes(WH_SECRET) && !row.detail.includes('"token"') && /api_name/.test(row.detail));
    const big = ZL.failRow({ msg: 'x'.repeat(20000) }); assert.ok(big.detail.length <= ZL.DETAIL_MAX && JSON.parse(big.detail).msg_cut === true);
  });

  /* ---------------- F9.1 / F9.2 — autosync ---------------- */
  await t('Clean run: logged "ok", complete JSON summary with failures 0, no failure rows', async () => {
    const w = W(); const res = await autosync(w);
    assert.ok(res.ok); const run = runRow(w); assert.strictEqual(run.result, 'ok');
    const s = JSON.parse(run.detail); assert.strictEqual(s.failures, 0); assert.ok(s.run); assert.strictEqual(fails(w).length, 0);
  });

  await t('A refused batch: one failure row per record (not the first 2), each with Zoho\'s reason; the run is "partial"', async () => {
    const w = W({ zoho: { batchFail: { Contacts: 400 } } }); await autosync(w);
    const f = fails(w).filter(x => x.entity === 'contact');
    const emails = ['g@glasgow.test', 'r@rms.test', 'rita@glasgow.test', 'bob@rms.test'];   // dealers' main emails + contacts
    assert.deepStrictEqual(f.map(x => x.entity_id).sort(), emails.slice().sort());
    for (const x of f) { const d = JSON.parse(x.detail); assert.strictEqual(d.phase, 'contacts'); assert.ok(/BATCH_REJECTED/.test(d.msg) && /INVALID_DATA/.test(JSON.stringify(d.zoho_details))); assert.ok(d.run); }
    assert.strictEqual(f.find(x => x.entity_id === 'rita@glasgow.test').dealer_id, 'd-greg');
    const run = runRow(w); assert.strictEqual(run.result, 'partial'); const s = JSON.parse(run.detail);
    assert.strictEqual(s.failures, 4); assert.deepStrictEqual(s.failures_by_phase, { contacts: 4 }); assert.ok(!/INVALID_DATA/.test(run.detail), 'details belong on the failure rows');
  });

  await t('Every refused deal gets its own row — 12 of 12, where the summary used to keep 8', async () => {
    const w = W({ opps: 12, zoho: { deal: () => ({ code: 'MANDATORY_NOT_FOUND', message: 'required field not found', details: { api_name: 'Closing_Date' } }) } });
    await autosync(w);
    const f = fails(w).filter(x => x.entity === 'opportunity'); assert.strictEqual(f.length, 12);
    assert.ok(f.every(x => /MANDATORY_NOT_FOUND/.test(x.detail) && /Closing_Date/.test(x.detail)));
    assert.strictEqual(f.find(x => x.entity_id === 'o1').zoho_id, 'Z1'); assert.strictEqual(runRow(w).result, 'partial');
  });

  await t('Swallowed failures now recorded: Zoho id write-back, pulled change, incomplete Zoho read, fingerprints, HCPS reads', async () => {
    // New deal created in Zoho but its id can't be saved; a pulled change can't be saved.
    let w = W({ failWrite: (m, tb) => m === 'PATCH' && tb === 'opportunities' ? 500 : 0, zoho: { keep: { Deals: true } } }); await autosync(w);
    let f = fails(w); const zid = f.find(x => JSON.parse(x.detail).phase === 'opps_zoho_id');
    assert.ok(zid && zid.entity_id === 'o2' && zid.zoho_id && /create the deal in Zoho again/.test(zid.detail));
    const pl = f.find(x => JSON.parse(x.detail).phase === 'pull_deals'); assert.ok(pl && pl.direction === 'in' && pl.entity_id === 'o0' && pl.zoho_id === 'Z0');
    assert.strictEqual(runRow(w).result, 'partial');
    // Zoho Deals read fails on page 1: recorded with page and status; nothing is pulled (as before).
    w = W({ zoho: { readFail: { Deals: { page: 1, status: 500 } } } }); await autosync(w);
    f = fails(w); const rd = f.find(x => JSON.parse(x.detail).phase === 'pull_read'); const d = JSON.parse(rd.detail);
    assert.strictEqual(d.page, 1); assert.strictEqual(d.status, 500); assert.ok(/stopped early/.test(d.msg));
    assert.ok(!w.writes.some(x => x.kind === 'patch' && x.table === 'opportunities' && !('zoho_id' in (x.body || {}))), 'something was pulled');
    // Accounts read fails: recorded (contacts and deals still go out, unlinked, as before).
    w = W({ zoho: { readFail: { Accounts: { page: 1, status: 503 } } } }); await autosync(w);
    assert.ok(fails(w).some(x => JSON.parse(x.detail).phase === 'accounts_read'));
    // Push fingerprints can't be saved.
    w = W({ failWrite: (m, tb, b) => m === 'POST' && tb === 'app_settings' && b && b.key === 'zoho_push_hashes' ? 500 : 0 }); await autosync(w);
    assert.ok(fails(w).some(x => x.entity === 'sync_state' && /pushed again/.test(x.detail)));
    // HCPS deals or contacts can't be read.
    w = W({ failRead: tb => tb === 'opportunities' ? 500 : 0 }); await autosync(w);
    assert.ok(fails(w).some(x => JSON.parse(x.detail).phase === 'opps_read')); assert.strictEqual(runRow(w).result, 'partial');
    w = W({ failRead: tb => tb === 'dealer_contacts' ? 500 : 0 }); await autosync(w);
    assert.ok(fails(w).some(x => JSON.parse(x.detail).phase === 'contacts_read'));
  });

  await t('One refused account among several: exactly that dealer\'s row; the others are pushed and fingerprinted', async () => {
    const w = W({ zoho: { upsert: (m, r) => m === 'Accounts' && r.Account_Name === 'Retail Medical Solutions' ? { code: 'DUPLICATE_DATA', message: 'duplicate data', details: { api_name: 'Account_Name' } } : undefined } });
    await autosync(w);
    const f = fails(w); assert.strictEqual(f.length, 1); assert.strictEqual(f[0].entity, 'dealer'); assert.strictEqual(f[0].entity_id, 'd-ang'); assert.strictEqual(f[0].dealer_id, 'd-ang');
    const h = w.db.app_settings.find(x => x.key === 'zoho_push_hashes').value;
    assert.ok(h['acct:d-greg'] && !h['acct:d-ang'], 'fingerprints changed');
  });

  await t('A Zoho error that echoes a secret is masked in the failure row', async () => {
    const w = W({ opps: 1, zoho: { deal: () => ({ code: 'INVALID_DATA', message: 'bad value ' + CLIENT_SECRET }) } });
    await autosync(w);
    assert.ok(fails(w).length && !everything(w).includes(CLIENT_SECRET));
  });

  await t('Token refresh failure: the run row says why (still "fail", as before)', async () => {
    const w = W({ zoho: { tokenFail: true } }); await autosync(w);
    const run = logs(w).find(l => l.entity === 'autosync'); assert.strictEqual(run.result, 'fail'); assert.ok(/token refresh failed: invalid_code/.test(run.detail), run.detail);
  });

  /* ---------------- 2F-1.1 — credential-SHAPED text is masked on every logging path, crashes included ---------------- */
  const ZTOK = '1000.' + 'a1b2c3d4'.repeat(4) + '.' + '9f8e7d6c'.repeat(4);                  // a Zoho OAuth token's shape
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlX3ZhbHVl';   // a Supabase key's shape
  const SBKEY = 'sb_secret_Q1w2E3r4T5y6U7i8';
  await t('2F-1.1 scrubString: credential-shaped text is masked wherever it appears; business text is untouched', () => {
    const cases = [
      ['Authorization: Zoho-oauthtoken ' + ZTOK, ZTOK], ['sent Bearer abcdef0123456789xyz', 'abcdef0123456789xyz'],
      ['refresh ' + ZTOK + ' expired', ZTOK], ['key ' + JWT + ' leaked', JWT], ['using ' + SBKEY, SBKEY],
      ['refresh_token=r3fr3sh-value&grant_type=refresh_token', 'r3fr3sh-value'], ['{"access_token":"acc-123456","api_domain":"https://www.zohoapis.com"}', 'acc-123456'],
      ['password: hunter2xyz', 'hunter2xyz'], ['apikey=k-998877', 'k-998877'], ['client_secret: cs-zzz111', 'cs-zzz111'], ['x-hcps-secret=' + WH_SECRET, WH_SECRET],
    ];
    for (const [text, leak] of cases) { const out = ZL.scrubString(text); assert.ok(!out.includes(leak) && out.includes('[redacted]'), text + ' → ' + out); }
    for (const keep of ['INVALID_DATA: invalid data (api_name Email)', 'token refresh failed: invalid_client (http 400)', 'Call about the Bearer 4-wheel walker; token count 3',
      '{"token_type":"Bearer","api_domain":"https://www.zohoapis.com"}', 'Zoho connection settings couldn\'t be read: zoho_auth', '{"failures":2,"failures_by_phase":{"contacts":2}}'])
      assert.strictEqual(ZL.scrubString(keep), keep);
    // The same masking reaches webhook payloads (redact) and failure rows (failRow).
    const r = JSON.stringify(ZL.redact({ Description: 'customer pasted password: hunter2xyz here', nested: [{ note: 'Bearer ' + JWT }] }));
    const row = ZL.failRow({ msg: 'Zoho said Zoho-oauthtoken ' + ZTOK + ' is invalid' }).detail;
    assert.ok(!r.includes('hunter2xyz') && !r.includes(JWT) && !row.includes(ZTOK), r + ' ' + row);
  });

  await t('2F-1.1 autosync crash: the run\'s "fail" row and the reply keep the whole reason, with no secret or token in it', async () => {
    const tail = ' — end of reason';
    const boom = () => { throw new Error('socket closed after Zoho-oauthtoken ' + ZTOK + ' client_secret=' + CLIENT_SECRET + ' key ' + JWT + ' ' + 'x'.repeat(400) + tail); };
    const w = W({ zoho: { tokenJson: () => ({ get access_token() { return boom(); } }) } });
    const res = await autosync(w);
    assert.strictEqual(res.ok, false); const run = runRow(w); assert.strictEqual(run.result, 'fail');
    for (const leak of [ZTOK, CLIENT_SECRET, JWT]) assert.ok(!run.detail.includes(leak) && !res.error.includes(leak), 'the crash reason holds ' + leak.slice(0, 10));
    assert.ok(run.detail.endsWith(tail) && res.error.endsWith(tail), 'the crash reason was cut');
    assert.ok(!everything(w).includes(CLIENT_SECRET) && !everything(w).includes(ZTOK));
  });

  await t('2F-1.1 token refresh refused with a reply that echoes a token: the run row says why, token masked', async () => {
    const w = W({ zoho: { tokenJson: { message: 'invalid refresh_token=' + ZTOK } } }); await autosync(w);
    const run = runRow(w); assert.strictEqual(run.result, 'fail'); assert.ok(/token refresh failed/.test(run.detail) && !run.detail.includes(ZTOK), run.detail);
  });

  /* ---------------- F9.1 / F9.2 — on-demand actions and scheduling ---------------- */
  const api = (w, action) => call(load('zoho-api.js', w, ENV), { action }, { token: 'pres' });
  await t('2F-1.1 on-demand crash, connection test and code exchange: no token reaches the reply', async () => {
    const w = W({ zoho: { tokenJson: () => ({ get access_token() { throw new Error('reset by peer; Authorization: Zoho-oauthtoken ' + ZTOK); } }) } });
    const r = await api(w, 'sync_contacts'); assert.strictEqual(r.status, 500); assert.ok(r.body.error && !r.body.error.includes(ZTOK), r.body.error);
    const w2 = W({ zoho: { tokenJson: { message: 'bad refresh_token=' + ZTOK } } }); const s = await api(w2, 'test');
    assert.strictEqual(s.body.connected, false); assert.ok(s.body.detail && !s.body.detail.includes(ZTOK), s.body.detail);
    const x = await call(load('zoho-api.js', w2, ENV), { action: 'oauth_exchange', code: '1000.abc' }, { token: 'pres' });
    assert.strictEqual(x.body.ok, false); assert.ok(x.body.detail && !x.body.detail.includes(ZTOK), x.body.detail);
  });
  await t('On-demand pushes: every refused record is a failure row; the response counts them and is no longer "ok"', async () => {
    const w = W({ zoho: { batchFail: { Contacts: 400 } } }); const r = await api(w, 'sync_contacts');
    assert.strictEqual(r.body.ok, false); assert.strictEqual(r.body.failed, 4); assert.strictEqual(fails(w).length, 4);
    assert.ok(fails(w).every(x => JSON.parse(x.detail).phase === 'sync_contacts'));
  });

  await t('On-demand swallowed writes recorded: deal id not saved, mirror not stamped, incomplete Zoho read', async () => {
    let w = W({ failWrite: (m, tb) => m === 'PATCH' && tb === 'opportunities' ? 500 : 0 }); let r = await api(w, 'sync_opportunities');
    assert.strictEqual(r.body.ok, false); assert.strictEqual(r.body.failed, 1); assert.ok(/would create it again/.test(JSON.stringify(r.body.errors)));
    assert.strictEqual(fails(w)[0].entity_id, 'o2');
    w = W({ failWrite: (m, tb) => m === 'PATCH' && tb === 'dealer_notes' ? 500 : 0 });
    w.db.dealer_notes = [{ id: 'n1', dealer_id: 'd-greg', body: 'hello', author_name: 'Greg' }];
    r = await api(w, 'mirror_to_zoho'); assert.strictEqual(r.body.ok, false); assert.ok(fails(w).some(x => x.entity === 'note' && /duplicate/.test(x.detail)));
    w = W({ zoho: { readFail: { Deals: { page: 1, status: 500 } } } }); r = await api(w, 'pull_deals');
    assert.strictEqual(r.body.ok, false); assert.strictEqual(r.body.zoho_read_incomplete.length, 1); assert.strictEqual(fails(w)[0].action, 'read');
  });

  await t('Zoho sync page: failures in the last 24 hours are counted for the "Sync failures" tile', async () => {
    const w = W({ zoho: { batchFail: { Contacts: 400 } } }); await autosync(w);
    const r = await api(w, 'sync_state'); assert.strictEqual(r.body.failures.in_24h, 4); assert.ok(r.body.failures.last);
  });

  await t('Scheduling: a Zoho appointment task Zoho refuses is a failure row; the booking itself still succeeds', async () => {
    const w = W({ zoho: { create: m => m === 'Tasks' ? { code: 'INVALID_DATA', message: 'invalid Due_Date' } : undefined } });
    w.db.service_requests = [{ id: 'sr1', status: 'requested', company: 'Glasgow Prescription Center', email: 'buyer@glasgow.test', contact_name: 'Buyer', service: 'Demo', preferred_date: '2026-10-20', mode: 'remote' }];
    const r = await call(load('schedule-api.js', w, ENV), { action: 'assign', id: 'sr1', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', override_hours: true }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300)); assert.strictEqual(r.body.zoho.ok, false);
    const f = fails(w).find(x => x.entity === 'task'); assert.ok(f && /invalid Due_Date/.test(f.detail) && JSON.parse(f.detail).phase === 'schedule');
  });

  done('Phase 2F-1 Zoho security + observability');
})();

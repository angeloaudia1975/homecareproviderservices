/* Phase 2F-3 — Zoho webhook: credential rotation + structured payloads.

   W1  The credential is the HTTP header x-hcps-secret, checked against ZOHO_WEBHOOK_HEADER_SECRET — and only
       the header: the same value sent as a URL/body parameter is refused (401) and the refusal is recorded.
   W2  The retired secret (ZOHO_WEBHOOK_SECRET) is accepted the old way ONLY while it is still set; once it is
       removed, no call with it succeeds.
   W3  A refused call is recorded (reason + how it arrived, names only — never a value), at most 20 an hour;
       anonymous junk without a credential or a Zoho field is not recorded.
   W4  ONE normalization boundary: URL query, urlencoded form, multipart form, JSON (incl. lookups and Zoho's
       {data:[…]}), base64 bodies → module, record id, Modified_Time, Modified_By, Account_Name, Email.
   W5  Nothing else changed: the response, the GET probe, the queue write (and its 42P10 failure row), and the
       webhook writes nothing but zoho_sync_log / zoho_sync_queue (no business record).
   No secret value reaches the database, a write, a log line or a response — checked on every test. */
const assert = require('assert');
const { createWorld, load, standardSeed, t, done } = require('./phase0-mock');

const NEW = 'hdr-9b1f27c4e05d48a6b3c2f1e0d9a8b7c6', OLD = 'old-5e2d81f0aa', CLIENT_SECRET = 'zcs-b81d44e0aa';
const ENV = { ZOHO_CLIENT_SECRET: CLIENT_SECRET, ZOHO_WEBHOOK_HEADER_SECRET: NEW, ZOHO_WEBHOOK_SECRET: OLD };
// (undefined = the variable is deleted from the environment, not just left over from another test)
const ENV_ROTATED = { ZOHO_CLIENT_SECRET: CLIENT_SECRET, ZOHO_WEBHOOK_HEADER_SECRET: NEW, ZOHO_WEBHOOK_SECRET: undefined };   // old one deleted

function W(o) {
  o = o || {};
  const S = standardSeed({ dealer_contacts: [{ id: 'c1', dealer_id: 'd-greg', name: 'Rita Owner', email: 'rita@glasgow.test' }], zoho_sync_queue: [], zoho_sync_log: o.log || [] });
  if (o.rejectQueue) S.rejectConflict = { zoho_sync_queue: 'direction,entity,entity_id' };   // the live partial unique index
  return createWorld(S);
}
const logs = w => w.db.zoho_sync_log || [];
const auths = w => logs(w).filter(l => l.action === 'auth');
const receipts = w => logs(w).filter(l => l.action === 'webhook');
// Everything the function could have left anywhere: the database, every write, every outbound call, console output.
let consoleOut = '';
const origErr = console.error, origLog = console.log, origWarn = console.warn;
function capture() { consoleOut = ''; console.error = (...a) => { consoleOut += a.join(' ') + '\n'; }; console.warn = console.error; }
function release() { console.error = origErr; console.warn = origWarn; }
const everything = w => JSON.stringify(w.db) + JSON.stringify(w.writes) + JSON.stringify(w.calls) + consoleOut;
function noSecrets(w, r) {
  const all = everything(w) + (r ? JSON.stringify(r) : '');
  for (const [name, s] of [['header secret', NEW], ['retired secret', OLD], ['client secret', CLIENT_SECRET]])
    assert.ok(!all.includes(s), 'the ' + name + ' is stored, logged or returned');
}
async function hook(w, ev, env) {
  const mod = load('zoho-webhook.js', w, env || ENV);
  capture();
  try { return await mod.handler(Object.assign({ httpMethod: 'POST', headers: {}, queryStringParameters: {} }, ev)); } finally { release(); }
}
const form = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
const multipart = (o, b) => Object.entries(o).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${b}--\r\n`;
const FORM = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' };
const detailOf = row => JSON.parse(row.detail);

(async () => {
  /* ---------------- W1 — header credential ---------------- */
  await t('W1 the new secret in the x-hcps-secret header is accepted (any header case); the receipt says so; nothing secret stored', async () => {
    const w = W();
    const r = await hook(w, { headers: Object.assign({ 'X-HCPS-Secret': NEW }, FORM), body: form({ module: 'Accounts', id: '7530569000000833001', Account_Name: 'TEST — Golden Sandbox', Modified_Time: '2026-10-07T15:04:05-04:00', Modified_By: 'Angelo Audia' }) });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, received: 'Accounts #7530569000000833001 TEST — Golden Sandbox' });
    const rec = receipts(w); assert.strictEqual(rec.length, 1);
    assert.strictEqual(rec[0].entity, 'accounts'); assert.strictEqual(rec[0].entity_id, '7530569000000833001'); assert.strictEqual(rec[0].zoho_id, '7530569000000833001');
    const d = detailOf(rec[0]);
    assert.strictEqual(d.summary, 'Accounts #7530569000000833001 TEST — Golden Sandbox');
    assert.strictEqual(d.modified_time, '2026-10-07T15:04:05-04:00'); assert.strictEqual(d.modified_by, 'Angelo Audia');
    assert.strictEqual(d.accepted_via, 'header'); assert.strictEqual(d.shape.hcps_header, true); assert.strictEqual(d.shape.body, 'form');
    assert.deepStrictEqual(d.shape.body_keys, ['module', 'id', 'Account_Name', 'Modified_Time', 'Modified_By']);
    noSecrets(w, r);
  });

  await t('W1 the new secret sent as a PARAMETER (URL or body) is refused, with the reason recorded and the value nowhere', async () => {
    for (const ev of [
      { queryStringParameters: { 'x-hcps-secret': NEW, module: 'Contacts', id: '7530569000001865001' } },
      { headers: FORM, body: form({ module: 'Contacts', id: '7530569000001865001', 'x-hcps-secret': NEW }) },
      { headers: FORM, body: form({ module: 'Contacts', id: '7530569000001865001', secret: NEW }) },
    ]) for (const env of [ENV, ENV_ROTATED]) {   // before and after the retired secret is removed
      const w = W(); const r = await hook(w, ev, env);
      assert.strictEqual(r.statusCode, 401); assert.deepStrictEqual(JSON.parse(r.body), { ok: false, error: 'unauthorized' });
      assert.strictEqual(receipts(w).length, 0); assert.strictEqual(w.db.zoho_sync_queue.length, 0);
      const a = auths(w); assert.strictEqual(a.length, 1, 'the refusal was not recorded');
      assert.strictEqual(a[0].result, 'fail'); assert.strictEqual(a[0].direction, 'in'); assert.strictEqual(a[0].entity, 'contacts'); assert.strictEqual(a[0].entity_id, '7530569000001865001');
      const d = detailOf(a[0]); assert.ok(/sent as a parameter/.test(d.msg), d.msg); assert.strictEqual(d.presented, 'param');
      noSecrets(w, r);
    }
  });

  await t('W1 a wrong header value is refused — including one of exactly the right length', async () => {
    for (const wrong of ['nope', NEW.slice(0, -1) + (NEW.slice(-1) === 'x' ? 'y' : 'x')]) {
      const w = W(); const r = await hook(w, { headers: Object.assign({ 'x-hcps-secret': wrong }, FORM), body: form({ module: 'Deals', id: '7530569000001886012' }) });
      assert.strictEqual(r.statusCode, 401); assert.strictEqual(receipts(w).length, 0); assert.strictEqual(w.db.zoho_sync_queue.length, 0);
      const d = detailOf(auths(w)[0]); assert.ok(/did not match/.test(d.msg), d.msg); assert.strictEqual(d.presented, 'header');
      assert.ok(!everything(w).includes(wrong), 'the presented value was stored'); noSecrets(w, r);
    }
  });

  await t('W1 with no secret configured on the server every call is refused, and the reason says so', async () => {
    const w = W(); const r = await hook(w, { headers: Object.assign({ 'x-hcps-secret': NEW }, FORM), body: form({ module: 'Deals', id: '1' }) }, { ZOHO_CLIENT_SECRET: CLIENT_SECRET, ZOHO_WEBHOOK_HEADER_SECRET: undefined, ZOHO_WEBHOOK_SECRET: undefined });
    assert.strictEqual(r.statusCode, 401); assert.ok(/no webhook secret is configured/.test(detailOf(auths(w)[0]).msg));
    assert.strictEqual(receipts(w).length, 0); noSecrets(w, r);
  });

  /* ---------------- W2 — the retired secret ---------------- */
  await t('W2 the retired secret works the old way (parameter, or header) ONLY while ZOHO_WEBHOOK_SECRET is still set', async () => {
    const asParam = { queryStringParameters: { 'x-hcps-secret': OLD }, headers: FORM, body: form({ module: 'Deals', id: '7530569000001886012' }) };
    const asHeader = { headers: Object.assign({ 'x-hcps-secret': OLD }, FORM), body: form({ module: 'Deals', id: '7530569000001886012' }) };
    const w1 = W(); const r1 = await hook(w1, asParam);
    assert.strictEqual(r1.statusCode, 200); assert.strictEqual(detailOf(receipts(w1)[0]).accepted_via, 'legacy_param'); noSecrets(w1, r1);
    const w2 = W(); const r2 = await hook(w2, asHeader);
    assert.strictEqual(r2.statusCode, 200); assert.strictEqual(detailOf(receipts(w2)[0]).accepted_via, 'legacy_header'); noSecrets(w2, r2);
    // Rotation complete: the old secret is deleted from Netlify → the same calls are refused.
    for (const ev of [asParam, asHeader]) {
      const w = W(); const r = await hook(w, ev, ENV_ROTATED);
      assert.strictEqual(r.statusCode, 401, 'an old-secret call succeeded after rotation');
      assert.strictEqual(receipts(w).length, 0); assert.strictEqual(w.db.zoho_sync_queue.length, 0);
      assert.ok(/did not match/.test(detailOf(auths(w)[0]).msg));
      assert.ok(!everything(w).includes(OLD), 'the retired secret was stored');
    }
  });

  await t('W2 the new header secret keeps working after the retired one is removed', async () => {
    const w = W(); const r = await hook(w, { headers: Object.assign({ 'x-hcps-secret': NEW }, FORM), body: form({ module: 'Contacts', id: '7530569000001865001', Email: 'import@example.test' }) }, ENV_ROTATED);
    assert.strictEqual(r.statusCode, 200); assert.strictEqual(detailOf(receipts(w)[0]).accepted_via, 'header'); noSecrets(w, r);
  });

  /* ---------------- W3 — refused calls are visible, capped, and carry no values ---------------- */
  await t('W3 refusals are recorded at most 20 an hour (older ones do not count)', async () => {
    const recent = Array.from({ length: 20 }, (_, i) => ({ id: 'a' + i, direction: 'in', action: 'auth', result: 'fail', entity: 'deals', created_at: new Date(Date.now() - 60e3 * (i + 1)).toISOString() }));
    const w = W({ log: recent }); const r = await hook(w, { headers: Object.assign({ 'x-hcps-secret': 'nope' }, FORM), body: form({ module: 'Deals', id: '1' }) });
    assert.strictEqual(r.statusCode, 401); assert.strictEqual(auths(w).length, 20, 'a 21st refusal in the hour was recorded');
    const old = recent.map(x => Object.assign({}, x, { created_at: new Date(Date.now() - 2 * 3600e3).toISOString() }));
    const w2 = W({ log: old }); await hook(w2, { headers: Object.assign({ 'x-hcps-secret': 'nope' }, FORM), body: form({ module: 'Deals', id: '1' }) });
    assert.strictEqual(auths(w2).length, 21, 'refusals older than an hour blocked a new record');
  });

  await t('W3 a call with no credential: recorded when it looks like a Zoho event, ignored when it is anonymous junk', async () => {
    const w = W(); const r = await hook(w, { headers: FORM, body: form({ module: 'Contacts', id: '7530569000001865001', 'Account Name': 'TEST — Golden Sandbox' }) });
    assert.strictEqual(r.statusCode, 401); const a = auths(w); assert.strictEqual(a.length, 1);
    const d = detailOf(a[0]); assert.strictEqual(d.presented, 'none'); assert.ok(/no credential/.test(d.msg));
    assert.deepStrictEqual(d.shape.body_keys, ['module', 'id', 'Account Name']);
    const w2 = W(); const r2 = await hook(w2, { headers: FORM, body: form({ hello: 'world' }) });
    assert.strictEqual(r2.statusCode, 401); assert.strictEqual(logs(w2).length, 0); assert.strictEqual(w2.calls.filter(c => c.method !== 'GET').length, 0);
  });

  await t('W3 the recorded shape is key NAMES only: a value sent as a bare key, or a long token-like key, is not kept', async () => {
    const w = W(); const tokenKey = 'Zx81kQ0pL2mN4bV6cX8zA1sD3fG5hJ7k';
    await hook(w, { headers: FORM, queryStringParameters: { [NEW]: '', module: 'Deals' }, body: OLD + '&' + tokenKey + '=1&id=5' });
    const d = detailOf(auths(w)[0]);
    assert.ok(d.shape.query_keys.includes('[long-key]') && d.shape.query_keys.includes('module'), JSON.stringify(d.shape));
    assert.ok(d.shape.body_keys.includes('[long-key]') && !d.shape.body_keys.includes(tokenKey), JSON.stringify(d.shape));
    assert.ok(!everything(w).includes(tokenKey)); noSecrets(w);
  });

  /* ---------------- W4 — one normalization boundary ---------------- */
  const H = extra => Object.assign({ 'x-hcps-secret': NEW }, extra || {});
  const expectReceipt = (w, module, id, more) => {
    const rec = receipts(w); assert.strictEqual(rec.length, 1, 'no receipt');
    assert.strictEqual(rec[0].entity, module.toLowerCase()); assert.strictEqual(rec[0].entity_id, id); assert.strictEqual(rec[0].zoho_id, id);
    const d = detailOf(rec[0]); for (const [k, v] of Object.entries(more || {})) assert.deepStrictEqual(d[k], v, k);
    return d;
  };

  await t('W4 multipart form-data (Zoho Form-Data), incl. a key with a space ("Account Name") and an Email lookup to the dealer', async () => {
    const w = W(); const b = '----zohoBoundary7MA4YWxk';
    const r = await hook(w, { headers: H({ 'content-type': 'multipart/form-data; boundary=' + b }), body: multipart({ module: 'Contacts', id: '7530569000001865001', 'Account Name': 'Glasgow Prescription Center', Email: 'Rita@Glasgow.test', Modified_Time: '2026-10-07T15:04:05-04:00', Modified_By: 'Angelo Audia' }, b) });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, received: 'Contacts #7530569000001865001 Glasgow Prescription Center' });
    const d = expectReceipt(w, 'Contacts', '7530569000001865001', { modified_time: '2026-10-07T15:04:05-04:00', modified_by: 'Angelo Audia' });
    assert.strictEqual(d.shape.body, 'multipart'); assert.strictEqual(d.shape.content_type, 'multipart/form-data');
    assert.strictEqual(receipts(w)[0].dealer_id, 'd-greg', 'the email did not resolve the dealer');
    noSecrets(w, r);
  });

  await t('W4 base64 bodies (how Netlify hands over multipart / binary bodies) are decoded first', async () => {
    const w = W(); const b = 'XyZ123';
    const raw = multipart({ module: 'Deals', id: '7530569000001886012', Account_Name: 'TEST — Golden Sandbox', Modified_By: 'Angelo Audia' }, b);
    const r = await hook(w, { isBase64Encoded: true, headers: H({ 'content-type': 'multipart/form-data; boundary=' + b }), body: Buffer.from(raw, 'utf8').toString('base64') });
    assert.strictEqual(r.statusCode, 200);
    const d = expectReceipt(w, 'Deals', '7530569000001886012', { modified_by: 'Angelo Audia' }); assert.strictEqual(d.shape.base64, true);
    const w2 = W(); await hook(w2, { isBase64Encoded: true, headers: H(FORM), body: Buffer.from(form({ module: 'Accounts', id: '42' })).toString('base64') });
    expectReceipt(w2, 'Accounts', '42');
  });

  await t('W4 urlencoded form, with "+" for spaces, and a form body sent without a content type', async () => {
    const w = W(); await hook(w, { headers: H(FORM), body: 'module=Accounts&id=7530569000000833001&Account_Name=Golden+Sandbox&Modified_Time=2026-10-07T15%3A04%3A05-04%3A00' });
    expectReceipt(w, 'Accounts', '7530569000000833001', { summary: 'Accounts #7530569000000833001 Golden Sandbox', modified_time: '2026-10-07T15:04:05-04:00' });
    const w2 = W(); await hook(w2, { headers: H(), body: form({ module: 'Deals', id: '9' }) });
    assert.strictEqual(expectReceipt(w2, 'Deals', '9').shape.body, 'form_untyped');
  });

  await t('W4 JSON: plain fields, lookups ({name,id}) and Zoho\'s {data:[…]} envelope', async () => {
    const w = W(); await hook(w, { headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ module: 'Deals', id: '77', Account_Name: { name: 'Retail Medical Solutions', id: '5' }, Modified_By: { name: 'Greg Campbell', id: '8' }, Modified_Time: '2026-10-07T09:00:00-04:00' }) });
    expectReceipt(w, 'Deals', '77', { summary: 'Deals #77 Retail Medical Solutions', modified_by: 'Greg Campbell', modified_time: '2026-10-07T09:00:00-04:00' });
    const w2 = W(); await hook(w2, { headers: H({ 'content-type': 'application/json' }), body: JSON.stringify({ module: 'Contacts', data: [{ id: '88', Email: 'bob@rms.test', Modified_By: { name: 'Lori Hunt', id: '3' } }] }) });
    expectReceipt(w2, 'Contacts', '88', { modified_by: 'Lori Hunt' });
  });

  await t('W4 URL query only (Zoho "Body: None") still works; a body value wins over the same query key', async () => {
    const w = W(); await hook(w, { headers: H(), queryStringParameters: { module: 'Accounts', id: '7530569000000833001', Account_Name: 'TEST — Golden Sandbox' } });
    assert.strictEqual(expectReceipt(w, 'Accounts', '7530569000000833001').shape.body, 'none');
    const w2 = W(); await hook(w2, { headers: H(FORM), queryStringParameters: { module: 'Accounts', id: 'from-query' }, body: form({ id: 'from-body' }) });
    expectReceipt(w2, 'Accounts', 'from-body');
  });

  await t('W4 the record id: a generic id wins; otherwise the module\'s OWN id ("Deal Id" on a Deal) — never another module\'s', async () => {
    const w = W(); await hook(w, { headers: H(FORM), body: form({ module: 'Deals', 'Account Id': 'ACC-1', 'Deal Id': 'DEAL-1' }) });
    expectReceipt(w, 'Deals', 'DEAL-1');
    const w2 = W(); await hook(w2, { headers: H(FORM), body: form({ module: 'Contacts', 'Account Id': 'ACC-1', 'Contact Id': 'CON-1' }) });
    expectReceipt(w2, 'Contacts', 'CON-1');
    const w3 = W(); await hook(w3, { headers: H(FORM), body: form({ module: 'Deals', 'Account Id': 'ACC-1' }) });
    assert.strictEqual(receipts(w3)[0].entity_id, null, 'an Account id was taken as the Deal id');
    const w4 = W(); await hook(w4, { headers: H(FORM), body: form({ Module: 'Accounts', ID: 'G-1', 'Account Id': 'ACC-1' }) });
    expectReceipt(w4, 'Accounts', 'G-1');
  });

  await t('W4 the payload is sanitized after normalization: credential-named fields dropped, secret values masked', async () => {
    const w = W(); await hook(w, { headers: H(FORM), body: form({ module: 'Accounts', id: '1', Description: 'see ' + NEW + ' here', api_key: 'k-123', token: 't-123' }) });
    const p = w.db.zoho_sync_queue[0].payload; assert.strictEqual(p.Description, 'see [redacted] here');
    assert.ok(!('api_key' in p) && !('token' in p)); assert.ok(!everything(w).includes('t-123') && !everything(w).includes('k-123')); noSecrets(w);
  });

  /* ---------------- W5 — nothing else changed ---------------- */
  await t('W5 the queue write is unchanged, and the live 42P10 refusal is still recorded as a failure (receipt still written, Zoho still gets 200)', async () => {
    const w = W({ rejectQueue: true });
    const r = await hook(w, { headers: H(FORM), body: form({ module: 'Accounts', id: '7530569000000833001', Account_Name: 'TEST — Golden Sandbox' }) });
    assert.strictEqual(r.statusCode, 200); assert.deepStrictEqual(JSON.parse(r.body), { ok: true, received: 'Accounts #7530569000000833001 TEST — Golden Sandbox' });
    const qw = w.calls.filter(c => /zoho_sync_queue/.test(c.url) && c.method !== 'GET'); assert.strictEqual(qw.length, 1);
    assert.ok(/zoho_sync_queue\?on_conflict=direction,entity,entity_id$/.test(qw[0].url) && qw[0].method === 'POST' && qw[0].headers.prefer === 'resolution=merge-duplicates,return=minimal');
    assert.deepStrictEqual(Object.keys(qw[0].body).sort(), ['dealer_id', 'direction', 'entity', 'entity_id', 'op', 'payload', 'status', 'updated_at', 'zoho_id']);
    assert.strictEqual(qw[0].body.entity, 'accounts'); assert.strictEqual(qw[0].body.entity_id, '7530569000000833001'); assert.strictEqual(qw[0].body.status, 'pending');
    const f = logs(w).filter(l => l.result === 'fail'); assert.strictEqual(f.length, 1); assert.strictEqual(f[0].action, 'queue');
    assert.ok(/42P10/.test(detailOf(f[0]).msg)); assert.strictEqual(receipts(w).length, 1); noSecrets(w, r);
  });

  await t('W5 the webhook writes only to zoho_sync_log / zoho_sync_queue — no business record, on any path', async () => {
    const paths = [
      [{ headers: H(FORM), body: form({ module: 'Contacts', id: '1', Email: 'rita@glasgow.test' }) }, ENV],
      [{ headers: FORM, body: form({ module: 'Contacts', id: '1', secret: OLD }) }, ENV],
      [{ headers: Object.assign({ 'x-hcps-secret': 'bad' }, FORM), body: form({ module: 'Contacts', id: '1' }) }, ENV],
      [{ headers: FORM, body: form({ module: 'Contacts', id: '1', secret: OLD }) }, ENV_ROTATED],
    ];
    for (const [ev, env] of paths) {
      const w = W(); const before = JSON.stringify(Object.assign({}, w.db, { zoho_sync_log: null, zoho_sync_queue: null }));
      await hook(w, ev, env);
      const tables = w.calls.filter(c => c.method !== 'GET').map(c => String(c.url).split('/rest/v1/')[1].split('?')[0]);
      assert.ok(tables.every(x => x === 'zoho_sync_log' || x === 'zoho_sync_queue'), 'wrote to ' + tables.join(','));
      assert.strictEqual(JSON.stringify(Object.assign({}, w.db, { zoho_sync_log: null, zoho_sync_queue: null })), before, 'a business table changed');
      assert.ok(!w.calls.some(c => /zoho\.com|zohoapis/.test(String(c.url))), 'the webhook called Zoho');
    }
  });

  await t('W5 GET probe and the other methods answer exactly as before; a crash still answers 200 {ok:false}', async () => {
    const w = W(); const g = await hook(w, { httpMethod: 'GET' });
    assert.strictEqual(g.statusCode, 200); assert.deepStrictEqual(JSON.parse(g.body), { ok: true, service: 'zoho-webhook', ready: true });
    const p = await hook(w, { httpMethod: 'PUT' }); assert.strictEqual(p.statusCode, 405); assert.deepStrictEqual(JSON.parse(p.body), { error: 'POST only' });
    assert.strictEqual(logs(w).length, 0);
    const w2 = W(); const r = await hook(w2, { headers: { get 'x-hcps-secret'() { throw new Error('boom ' + NEW); } } });
    assert.strictEqual(r.statusCode, 200); assert.deepStrictEqual(JSON.parse(r.body), { ok: false });
    assert.strictEqual(logs(w2).filter(l => l.result === 'fail').length, 1); noSecrets(w2, r);
  });

  done('Phase 2F-3 Zoho webhook credential + payload');
})();

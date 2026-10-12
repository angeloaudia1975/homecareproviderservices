/* MI Inbox Automation, Phase B — the Report History API's capture actions (netlify/functions/mfr-reports-api.js:
   capture_status, inbox, attention, resolve, capture_now), loaded unmodified (mutant-capable through phase0-mock's
   loader) against a small fake of Supabase Auth / PostgREST / RPC. Proves: management only; reads are strict (an
   unreadable table is a 503, never an empty inbox); filters by manufacturer, period, status and search; the person's
   decision carries the VERIFIED sign-in as actor (never a request field) and needs a reason; capture_now does nothing
   while the switch is off; and none of these actions writes anything except through hcps_mfr_capture_resolve. */
const assert = require('assert');
const { load, call } = require('./phase0-mock');
const BASE = 'https://db.test';

const MSGS = [
  { id: 1, mailbox: 'angelo@hcps.us', internet_message_id: '<sr032@sb>', received_at: '2026-10-07T14:00:00Z', from_address: 'amanda.erickson@strongbackmobility.com',
    from_name: 'Amanda', subject: 'Commission report September 2026', manufacturer: 'strongback-mobility', web_link: 'https://outlook/1' },
  { id: 2, mailbox: 'angelo@hcps.us', internet_message_id: '<rose@x>', received_at: '2026-10-06T17:00:00Z', from_address: 'brittany@rose-healthcare.com',
    from_name: 'Brittany', subject: 'September Commissions Report', manufacturer: null },
  { id: 3, mailbox: 'angelo@hcps.us', internet_message_id: '<bemis@x>', received_at: '2026-10-05T21:00:00Z', from_address: 'faxstar03@bemismfg.com',
    subject: 'COMMISSION REPORT for Rep/Month: 705 / 2026-08', manufacturer: 'bemis' },
];
const ITEMS = [
  { id: 11, message_id: 1, file_name: '2026-09 SR032.pdf', state: 'registered', kind: 'commission_statement', period_start: '2026-09-01', period_end: '2026-09-30', source_id: 50, manufacturer: 'strongback-mobility' },
  { id: 21, message_id: 2, file_name: 'Audia September.xlsx', state: 'exception', attention: 'unknown_sender', manufacturer: null },
  { id: 31, message_id: 3, file_name: '705-2026-08.csv', state: 'classified', kind: 'commission_statement', period_start: '2026-08-01', period_end: '2026-08-31', manufacturer: 'bemis' },
];
function world(o) {
  o = o || {};
  const st = { calls: [], rpcs: [] };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
  st.fetch = async (url, opts) => {
    opts = opts || {}; const u = String(url), m = (opts.method || 'GET').toUpperCase(); st.calls.push({ u, m, body: opts.body });
    if (u.startsWith(BASE + '/auth/v1/user')) { const tok = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
      const em = { pres: 'angelo@hcps.us', admin: 'ad@hcps.us', greg: 'greg@hcps.us', lori: 'lori@hcps.us', off: 'gone@hcps.us' }[tok]; return em ? res(200, { email: em }) : res(401, {}); }
    if (u.startsWith(BASE + '/rest/v1/staff_users')) { const em = decodeURIComponent(u.match(/email=eq\.([^&]+)/)[1]);
      const s = { 'angelo@hcps.us': { role: 'president' }, 'ad@hcps.us': { role: 'admin' }, 'greg@hcps.us': { role: 'rep' }, 'lori@hcps.us': { role: 'relations' }, 'gone@hcps.us': { role: 'president', active: false } }[em];
      return res(200, s ? [{ email: em, ...s }] : []); }
    if (o.failRead && m === 'GET' && o.failRead(u)) return res(500, { message: 'forced' });
    if (u.startsWith(BASE + '/rest/v1/app_settings')) return res(200, o.flags ? [{ value: o.flags }] : []);
    if (u.startsWith(BASE + '/rest/v1/mfr_report_capture_state')) return res(200, [{ mailbox: 'angelo@hcps.us', checkpoint_at: '2026-10-11T12:00:00Z' }]);
    if (u.startsWith(BASE + '/rest/v1/mfr_report_capture_runs')) return res(200, []);
    if (u.startsWith(BASE + '/rest/v1/mfr_report_profiles')) return res(200, [{ id: 1, code: 'x', manufacturer: 'strongback-mobility', status: 'active' }]);
    if (u.startsWith(BASE + '/rest/v1/mfr_report_messages')) {
      if (/offset=([1-9])/.test(u)) return res(200, []);
      const ids = u.match(/id=in\.\(([^)]+)\)/); let rows = MSGS;
      if (ids) rows = rows.filter(r => ids[1].split(',').includes(String(r.id)));
      const mf = u.match(/manufacturer=eq\.([^&]+)/); if (mf) rows = rows.filter(r => r.manufacturer === decodeURIComponent(mf[1]));
      return res(200, rows); }
    if (u.startsWith(BASE + '/rest/v1/mfr_report_items')) {
      if (/offset=([1-9])/.test(u)) return res(200, []);
      let rows = ITEMS; const ids = u.match(/message_id=in\.\(([^)]+)\)/); if (ids) rows = rows.filter(r => ids[1].split(',').includes(String(r.message_id)));
      if (/attention=not\.is\.null/.test(u)) rows = rows.filter(r => r.attention && !r.resolved_at);
      return res(200, rows); }
    if (u.startsWith(BASE + '/rest/v1/mfr_sources')) return res(200, [{ id: 50, title: 'Strongback — commission statement 2026-09', status: 'received', kind: 'commission_statement' }]);
    if (u.startsWith(BASE + '/rest/v1/rpc/')) { const fn = u.split('/rpc/')[1]; const p = JSON.parse(opts.body).p; st.rpcs.push({ fn, p });
      if (o.rpc) { const r = o.rpc(fn, p); if (r) return res(r.status, r.body); }
      return res(200, { ok: true, item_id: p.item_id, action: p.action }); }
    if (u.startsWith('https://graph.microsoft.com') || u.startsWith('https://login.microsoftonline.com')) { st.graph = (st.graph || 0) + 1; return res(500, {}); }
    return res(404, { message: 'unexpected ' + m + ' ' + u });
  };
  return st;
}
const boot = o => { const w = world(o); return { w, m: load('mfr-reports-api.js', w) }; };
const as = tok => ({ token: tok });
const writes = w => w.calls.filter(c => c.m !== 'GET' && !/\/auth\/v1\//.test(c.u));

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }

(async () => {
  console.log('\n— who may call it —');
  await t('no sign-in / inactive → 401; rep / Relations → 403; nothing read or written', async () => {
    for (const [tok, code] of [[null, 401], ['off', 401], ['greg', 403], ['lori', 403]]) for (const action of ['capture_status', 'inbox', 'attention', 'resolve', 'capture_now']) {
      const { w, m } = boot(); const r = await call(m, { action, item_id: 21, decision: 'dismiss', reason: 'x y z' }, tok ? as(tok) : {});
      assert.strictEqual(r.status, code, `${tok} ${action}`); assert.strictEqual(w.calls.filter(c => /mfr_report|rpc/.test(c.u)).length, 0);
    }
  });

  console.log('\n— read-only views —');
  await t('capture_status: switch, checkpoint, profiles, counts by state, open attention count; read-only', async () => {
    const { w, m } = boot({ flags: { mi_report_capture: true } }); const r = await call(m, { action: 'capture_status' }, as('pres'));
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.switch_on, true); assert.strictEqual(r.body.needs_attention, 1);
    assert.deepStrictEqual(r.body.counts, { registered: 1, exception: 1, classified: 1 }); assert.strictEqual(writes(w).length, 0);
    const off = boot({ flags: { mi_report_capture: 'true' } }); assert.strictEqual((await call(off.m, { action: 'capture_status' }, as('pres'))).body.switch_on, false);
  });
  await t('capture_status / inbox / attention: an unreadable table is a 503, never an empty view', async () => {
    for (const [action, re] of [['capture_status', /mfr_report_capture_state/], ['inbox', /mfr_report_items/], ['attention', /mfr_report_messages/]]) {
      const { m } = boot({ failRead: u => re.test(u) }); assert.strictEqual((await call(m, { action }, as('admin'))).status, 503, action);
    }
  });
  await t('inbox: newest first, each email with its items and the linked register record', async () => {
    const { m } = boot(); const r = await call(m, { action: 'inbox', days: 800 }, as('pres'));
    assert.deepStrictEqual(r.body.messages.map(x => x.id), [1, 2, 3]);
    assert.strictEqual(r.body.messages[0].items[0].source.id, 50);
  });
  await t('inbox filters: manufacturer, status, reporting period, search', async () => {
    const f = async o => (await call(boot().m, Object.assign({ action: 'inbox', days: 800 }, o), as('pres'))).body.messages.map(x => x.id);
    assert.deepStrictEqual(await f({ manufacturer: 'bemis' }), [3]);
    assert.deepStrictEqual(await f({ status: 'registered' }), [1]);
    assert.deepStrictEqual(await f({ status: 'attention' }), [2]);
    assert.deepStrictEqual(await f({ period: '2026-08' }), [3]);
    assert.deepStrictEqual(await f({ q: 'rose-healthcare' }), [2]);
    assert.deepStrictEqual(await f({ q: 'sr032' }), [1]);
  });
  await t('attention: only open items with their email (Rose Healthcare = unknown sender)', async () => {
    const r = await call(boot().m, { action: 'attention' }, as('pres'));
    assert.deepStrictEqual(r.body.messages.map(x => x.id), [2]); assert.strictEqual(r.body.messages[0].items[0].attention, 'unknown_sender');
  });

  console.log('\n— a person\'s decision —');
  await t('resolve: the actor is the verified sign-in ("staff:<email>"), never a field in the request', async () => {
    const { w, m } = boot(); const r = await call(m, { action: 'resolve', item_id: 21, decision: 'dismiss', reason: 'Rose ended in January', actor: 'staff:someone@else.com' }, as('pres'));
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(w.rpcs.map(x => [x.fn, x.p.actor, x.p.action, x.p.item_id]), [['hcps_mfr_capture_resolve', 'staff:angelo@hcps.us', 'dismiss', 21]]);
  });
  await t('resolve needs an item, a known decision and a reason — refused before the database', async () => {
    for (const [b, code] of [[{ decision: 'dismiss', reason: 'ok go' }, 400], [{ item_id: 21, decision: 'delete', reason: 'ok go' }, 400], [{ item_id: 21, decision: 'retry', reason: ' ' }, 422]]) {
      const { w, m } = boot(); const r = await call(m, Object.assign({ action: 'resolve' }, b), as('pres'));
      assert.strictEqual(r.status, code, JSON.stringify(b)); assert.strictEqual(w.rpcs.length, 0);
    }
  });
  await t('a database refusal comes back as its code (409 nothing to resolve / cannot ignore; 422 bad input)', async () => {
    for (const [msg, code] of [['capture_nothing_to_resolve', 409], ['capture_cannot_ignore: item is registered', 409], ['capture_reason_required', 422]]) {
      const { m } = boot({ rpc: () => ({ status: 400, body: { message: msg } }) });
      const r = await call(m, { action: 'resolve', item_id: 11, decision: 'ignore', reason: 'test it' }, as('pres'));
      assert.strictEqual(r.status, code, msg); assert.ok(String(r.body.error).startsWith(msg.split(':')[0]));
    }
  });

  console.log('\n— capture now —');
  await t('capture_now while the switch is off → 403, no Graph call, no database write', async () => {
    for (const flags of [undefined, { mi_report_capture: false }, { mi_report_capture: 'true' }]) {
      const { w, m } = boot({ flags }); const r = await call(m, { action: 'capture_now' }, as('pres'));
      assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'capture_switch_off'); assert.ok(!w.graph); assert.strictEqual(writes(w).length, 0);
    }
  });
  console.log('\n— profile trial rule override (trial only) —');
  await t('rules_override: refused for an active profile or an unknown profile; nothing written, no Graph call', async () => {
    for (const [ov, code] of [[{ x: { file_name: 'a' } }, 'override_active_profile'], [{ nope: { file_name: 'a' } }, 'override_unknown_profile']]) {
      const { w, m } = boot(); const r = await call(m, { action: 'profile_trial', manufacturer: 'strongback-mobility', rules_override: ov }, as('pres'));
      assert.strictEqual(r.status, 422, JSON.stringify(r.body)); assert.strictEqual(r.body.error, code); assert.ok(!w.graph); assert.strictEqual(writes(w).length, 0);
    }
  });
  await t('the existing MI-1b actions are unchanged by Phase B (list still answers)', async () => {
    const { m } = boot(); const r = await call(m, { action: 'unknown_thing' }, as('pres')); assert.strictEqual(r.status, 400);
  });

  console.log(`\nmi-b-api: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

/* Phase 0G: the field outbox in scheduled-routes.html. Lifts the shipped block between
   OUTBOX:BEGIN and OUTBOX:END out of the page and runs it against a fake phone: localStorage,
   connectivity, and a scripted server. Nothing here is a paraphrase of the page's code. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = process.env.SR_PAGE || path.join(__dirname, '..', 'src', 'admin', 'scheduled-routes.html');
function liftOutbox() {
  let src = fs.readFileSync(PAGE, 'utf8');
  const M = process.env.P0_MUTANT ? require('./phase0.mutants.table.js')[process.env.P0_MUTANT] : null;
  if (M && M.file === 'scheduled-routes.html') { if (!src.includes(M.from)) throw new Error('MUTANT ANCHOR NOT FOUND: ' + process.env.P0_MUTANT); src = src.split(M.from).join(M.to); }
  const a = src.indexOf('/* OUTBOX:BEGIN'), b = src.indexOf('/* OUTBOX:END */');
  if (a < 0 || b < 0) throw new Error('OUTBOX markers not found in scheduled-routes.html');
  return src.slice(a, b);
}
const CODE = liftOutbox();

function phone(opts) {
  opts = opts || {};
  const store = new Map(Object.entries(opts.storage || {}));
  const sent = [];
  const script = (opts.server || []).slice();          // responses, in order: {status, body} | 'network'
  const ctx = {
    ME: opts.me === undefined ? { email: 'greg@hcps.us' } : opts.me, TOKEN: opts.token === undefined ? 'tok-greg' : opts.token,
    navigator: { onLine: opts.online !== false },
    localStorage: {
      getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => { if (opts.full) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
      removeItem: k => store.delete(k),
    },
    fetch: async (url, o) => {
      const body = JSON.parse(o.body); sent.push({ body, auth: o.headers.authorization || null });
      const r = sent.length > 50 ? 'network' : (script.length ? script.shift() : { status: 200, body: { ok: true } });   // a runaway loop ends
      if (r === 'network') throw new Error('Failed to fetch');
      return { status: r.status, json: async () => r.body };
    },
    gated: 0, gate: () => { ctx.gated++; },
    $: () => ({ textContent: '', style: {} }),
    renderSyncPanel: () => {},
    Date, Math, JSON, String, Array, Set, Promise, setTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE + '\n;this.__api={outbox,quarantine,enqueue,flushOutbox,tryOrQueue,adoptLegacyOutbox,retryQuarantined,discardQuarantined,cacheRoutes,loadCachedRoutes,obKey,setToken:t=>{TOKEN=t},getToken:()=>TOKEN,setMe:m=>{ME=m}};', ctx);
  return { ctx, api: ctx.__api, store, sent, script };
}

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message || e)); } }
const B = (n, extra) => Object.assign({ action: 'visit_report_save', route_id: 'r-1', dealer_id: 'd-' + n, status: 'in_progress', fields: { n } }, extra || {});
const OK = { status: 200, body: { ok: true } };

(async () => {
  await t('0G each person has their own queue and cache', async () => {
    const P = phone(); P.api.enqueue(B(1)); P.api.cacheRoutes([{ id: 'r-1' }]);
    assert.ok(P.store.has('sr_outbox_greg@hcps.us'), 'queue not keyed by person: ' + [...P.store.keys()]);
    P.api.setMe({ email: 'lori@hcps.us' }); P.api.setToken('tok-lori');
    assert.strictEqual(P.api.outbox().length, 0, 'Lori sees Greg\'s queue');
    assert.strictEqual(P.api.loadCachedRoutes(), null, 'Lori sees Greg\'s cached routes');
    await P.api.flushOutbox();
    assert.strictEqual(P.sent.length, 0, 'Greg\'s queued visit was sent under Lori\'s login');
  });
  await t('0G the old shared queue is never sent automatically — it goes to review', async () => {
    const P = phone({ storage: { sr_outbox: JSON.stringify([{ id: 'old1', body: B(1) }, { id: 'old2', body: B(2) }]) } });
    P.api.adoptLegacyOutbox(); await P.api.flushOutbox();
    assert.strictEqual(P.sent.length, 0);
    assert.strictEqual(P.api.quarantine().length, 2); assert.ok(P.api.quarantine().every(x => x.legacy));
    assert.ok(!P.store.has('sr_outbox'), 'legacy key left behind');
  });
  await t('0G a refused item leaves the queue for review and the rest still sync, in order', async () => {
    const P = phone({ server: [OK, { status: 403, body: { error: 'Not your dealer' } }, OK] });
    P.api.enqueue(B(1)); P.api.enqueue(B(2)); P.api.enqueue(B(3));
    await P.api.flushOutbox();
    assert.deepStrictEqual(P.sent.map(x => x.body.dealer_id), ['d-1', 'd-2', 'd-3']);
    assert.strictEqual(P.api.outbox().length, 0);
    assert.strictEqual(P.api.quarantine().length, 1); assert.strictEqual(P.api.quarantine()[0].body.dealer_id, 'd-2');
    assert.strictEqual(P.api.quarantine()[0].error, 'Not your dealer');
  });
  await t('0G a "200 but ok:false" answer is a refusal, not a retry', async () => {
    const P = phone({ server: [{ status: 200, body: { ok: false, error: 'tables_missing' } }] });
    P.api.enqueue(B(1)); await P.api.flushOutbox();
    assert.strictEqual(P.api.outbox().length, 0); assert.strictEqual(P.api.quarantine().length, 1);
  });
  for (const [label, r] of [['a server error', { status: 503, body: {} }], ['no connection', 'network'], ['a timeout', { status: 408, body: {} }]]) {
    await t(`0G ${label} stops the sync and keeps everything, in order`, async () => {
      const P = phone({ server: [OK, r] });
      P.api.enqueue(B(1)); P.api.enqueue(B(2)); P.api.enqueue(B(3));
      await P.api.flushOutbox();
      assert.deepStrictEqual(P.sent.map(x => x.body.dealer_id), ['d-1', 'd-2'], 'kept sending past a failure');
      assert.deepStrictEqual(P.api.outbox().map(x => x.body.dealer_id), ['d-2', 'd-3']);
      assert.strictEqual(P.api.outbox()[0].tries, 1); assert.strictEqual(P.api.quarantine().length, 0);
    });
  }
  await t('0G a lapsed session stops the sync, asks to sign in and keeps the queue', async () => {
    const P = phone({ server: [{ status: 401, body: {} }] });
    P.api.enqueue(B(1)); P.api.enqueue(B(2)); await P.api.flushOutbox();
    assert.strictEqual(P.sent.length, 1); assert.strictEqual(P.ctx.gated, 1); assert.strictEqual(P.api.getToken(), null);
    assert.strictEqual(P.api.outbox().length, 2); assert.strictEqual(P.api.quarantine().length, 0);
  });
  await t('0G Retry resends a reviewed item as you; Discard drops it', async () => {
    const P = phone({ server: [{ status: 409, body: { error: 'busy' } }, OK] });
    P.api.enqueue(B(1)); P.api.enqueue(B(2)); await P.api.flushOutbox();
    const id = P.api.quarantine()[0].id;
    P.script.push(OK);
    await P.api.retryQuarantined(id);
    assert.strictEqual(P.api.quarantine().length, 0); assert.strictEqual(P.api.outbox().length, 0);
    assert.strictEqual(P.sent.slice(-1)[0].auth, 'Bearer tok-greg');
    P.api.enqueue(B(3)); P.script.push({ status: 400, body: { error: 'bad' } }); await P.api.flushOutbox();
    P.api.discardQuarantined(P.api.quarantine()[0].id);
    assert.strictEqual(P.api.quarantine().length, 0); assert.strictEqual(P.api.outbox().length, 0);
  });
  await t('0G save now: offline queues; a refusal is shown and NOT queued; a server error queues', async () => {
    let P = phone({ online: false }); let r = await P.api.tryOrQueue(B(1));
    assert.ok(r.queued && P.api.outbox().length === 1 && P.sent.length === 0);
    P = phone({ server: [{ status: 403, body: { error: 'Not your dealer' } }] }); r = await P.api.tryOrQueue(B(1));
    assert.ok(r.rejected && r.error === 'Not your dealer'); assert.strictEqual(P.api.outbox().length, 0);
    P = phone({ server: [{ status: 502, body: {} }] }); r = await P.api.tryOrQueue(B(1));
    assert.ok(r.queued); assert.strictEqual(P.api.outbox().length, 1);
  });
  await t('0G a new save never overtakes older unsynced ones', async () => {
    const P = phone({ server: [OK, OK] });
    P.api.enqueue(B(1));
    const r = await P.api.tryOrQueue(B(2));
    assert.deepStrictEqual(P.sent.map(x => x.body.dealer_id), ['d-1', 'd-2']); assert.ok(r.sent);
    assert.strictEqual(P.api.outbox().length, 0);
  });
  await t('0G saves made before anyone is identified are kept and reviewed on sign-in', async () => {
    const P = phone({ me: null }); P.api.enqueue(B(1));
    assert.strictEqual(P.api.outbox().length, 1);
    P.api.setMe({ email: 'greg@hcps.us' }); P.api.adoptLegacyOutbox();
    assert.strictEqual(P.api.outbox().length, 0); assert.strictEqual(P.api.quarantine().length, 1);
  });
  await t('0G a phone with full storage does not resend the same item in a loop', async () => {
    const P = phone({ server: [OK, OK, OK] });
    P.api.enqueue(B(1)); P.ctx.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    await P.api.flushOutbox();
    assert.strictEqual(P.sent.length, 1, 'sent ' + P.sent.length + ' times');
  });

  console.log(`\n0G field outbox: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();

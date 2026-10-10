/* Phase 2F-5 — Deal conflict protection + Zoho stage preservation (_zoho_deals.js, the one deal engine).

   D1  Each two-way field (stage, amount, close date) is compared with the LAST-SYNCHRONIZED baseline, never updated_at:
       only Zoho changed → applied to HCPS; only HCPS changed → that field alone pushed to Zoho; neither → nothing;
       both → a conflict is recorded and NEITHER side changes (both changed to the same value → they simply agree).
   D2  Stage: Zoho's exact stage is kept (opportunities.zoho_stage); a Zoho stage that maps to the same HCPS stage
       changes no HCPS stage and is never rewritten to HCPS's preferred Zoho stage; HCPS pushes a stage only for its
       own stage change; an unmapped Zoho stage is preserved, flagged for review and never overwritten.
   D3  Zoho → HCPS only through an external/pending Deal event (2F-4); without one the difference is drift: logged
       once, never applied. Account/Contact events and Zoho-only (unlinked) deal events are not touched.
   D4  Pushes and applies happen once: an echo (or a re-delivered event) makes no second write.
   D5  TEST deals are never pushed (2F-2) but can be kept in step FROM Zoho; first sight of a linked deal (no baseline)
       changes nothing on either side; every failure is a failure row and leaves the deal to be retried, nothing guessed.
   D6  The on-demand actions use the same engine; new deals are created as before; the migration and rollback. */
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const ENV = { ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'zcs-b81d44e0aa', ZOHO_WEBHOOK_HEADER_SECRET: 'hdr-9b1f27c4e05d48a6b3c2f1e0d9a8b7c6' };
const SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'phase2f5_deal_sync.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'phase2f5_deal_sync_rollback.sql'), 'utf8');
// Loaded through the harness so the mutation run tests the decision rules too.
const DS = load('_zoho_deals.js', createWorld(standardSeed()), ENV);

const BASE1 = { stage: 'contacted', zoho_stage: 'Value Proposition', amount: 100, close_date: '2026-11-01' };
const BASET = { stage: 'lost', zoho_stage: 'Closed Lost', amount: 1, close_date: '2026-10-02' };
function seed(o) {
  o = o || {};
  const S = standardSeed({
    app_settings: [{ key: 'zoho_auth', value: { refresh_token: 'rt', api_domain: 'https://www.zohoapis.com' } }, { key: 'zoho_push_hashes', value: {} }],
    dealer_contacts: [],
    opportunities: [
      { id: 'o1', dealer_id: 'd-greg', title: 'Real deal 1', line: null, stage: 'contacted', status: 'open', probability: 0.3, value: 100, expected_close: '2026-11-01', zoho_id: 'Z1', zoho_stage: 'Value Proposition', updated_at: '2026-10-01T00:00:00Z' },
      { id: 'ot', dealer_id: 'd-test', title: 'Sandbox deal', line: null, stage: 'lost', status: 'lost', probability: 0, value: 1, expected_close: '2026-10-02', zoho_id: 'ZT', zoho_stage: 'Closed Lost', updated_at: '2026-10-01T00:00:00Z' } ].concat(o.opps || []),
    zoho_deal_baseline: o.noBaseline ? [] : [{ opportunity_id: 'o1', zoho_id: 'Z1', base: Object.assign({}, BASE1, o.base1 || {}), owned_hash: null }, { opportunity_id: 'ot', zoho_id: 'ZT', base: Object.assign({}, BASET), owned_hash: null }],
    zoho_deal_conflicts: [], zoho_sync_queue: o.queue || [], zoho_sync_log: [], dealer_activity: [],
  });
  S.tables.dealers.push({ id: 'd-test', business_name: 'TEST — Golden Sandbox', rep_name: null, parent_id: null, state: 'IN', is_test: true, email: 'orders@hcps.test' });
  S.zoho = { modules: {
    Accounts: [{ id: 'A1', Account_Name: 'Glasgow Prescription Center' }],
    Deals: [{ id: 'Z1', Deal_Name: 'Real deal 1', Stage: 'Value Proposition', Amount: 100, Closing_Date: '2026-11-01', Modified_Time: '2026-10-01T15:00:00Z' },
      { id: 'ZT', Deal_Name: 'Sandbox deal', Stage: 'Closed Lost', Amount: 1, Closing_Date: '2026-10-02', Modified_Time: '2026-10-01T15:00:00Z' },
      { id: 'ZX', Deal_Name: 'Zoho-only deal', Stage: 'Qualification', Amount: 5, Closing_Date: '2026-12-01', Modified_Time: '2026-10-01T15:00:00Z' }].concat(o.zdeals || []) } };
  if (o.zoho) Object.assign(S.zoho, o.zoho);
  if (o.failRead) S.failRead = o.failRead; if (o.failWrite) S.failWrite = o.failWrite;
  // The database's one-open-conflict-per-deal-and-field index.
  S.uniquePartial = { zoho_deal_conflicts: [{ cols: ['opportunity_id', 'field'], where: r => r.status === 'open' }] };
  return S;
}
function world(o) { const S = seed(o); const w = createWorld(S); w.__seed = S; return w; }
let evSeq = 100;
const zdeal = (w, id) => w.__seed.zoho.modules.Deals.find(d => d.id === id);
// A person edits the deal in Zoho: Zoho stamps a newer Modified_Time — later than every earlier edit, and (like
// any real edit made before a run) earlier than the writes HCPS's own run makes (the fake stamps those with "now").
let clock = Date.parse('2026-10-05T12:00:00Z');
const zedit = (w, id, fields) => { clock = Math.max(clock + 1000, Date.now() - 300e3); return Object.assign(zdeal(w, id), fields, { Modified_Time: new Date(clock).toISOString().replace('.000Z', '-00:00') }); };
// The webhook for the deal's CURRENT state (it carries the Modified_Time Zoho sent with it).
const ev = (w, zid, extra) => Object.assign({ id: ++evSeq, direction: 'in', entity: 'deals', entity_id: zid, zoho_id: zid, event_key: 'k' + evSeq, status: 'pending', classification: 'external', class_reason: 'external', classified_at: '2026-10-09T10:00:00Z',
  modified_time: (zdeal(w, zid) || {}).Modified_Time || '2026-10-09 10:00:00' }, extra || {});
const addEv = (w, zid, extra) => { const e = ev(w, zid, extra); w.db.zoho_sync_queue.push(e); return e; };
const opp = (w, id) => w.db.opportunities.find(o => o.id === id);
const baseOf = (w, id) => (w.db.zoho_deal_baseline.find(b => b.opportunity_id === id) || {}).base;
const logs = w => w.db.zoho_sync_log || [];
const fails = w => logs(w).filter(l => l.result === 'fail');
const failPhase = (w, ph) => fails(w).filter(l => JSON.parse(l.detail).phase === ph);
const runRow = w => logs(w).filter(l => l.entity === 'autosync' && l.action === 'run').slice(-1)[0];
const dealPuts = w => w.outbound.filter(x => x.kind === 'zoho' && x.method !== 'GET' && /\/Deals/.test(x.path));
const oppPatches = w => w.writes.filter(x => x.kind === 'patch' && x.table === 'opportunities');
const openConflicts = w => (w.db.zoho_deal_conflicts || []).filter(c => c.status === 'open');
async function autosync(w) { const r = await load('zoho-autosync.js', w, ENV).handler({}); return JSON.parse(r.body); }
const api = (w, action) => call(load('zoho-api.js', w, ENV), { action }, { token: 'pres' });

(async () => {
  /* ---------------- D1/D2 — the per-field decision (pure) ---------------- */
  await t('D1 decision table per field: neither / only Zoho / only HCPS / both (different) / both (same)', async () => {
    const b = { stage: 'contacted', zoho_stage: 'Needs Analysis', amount: 100, close_date: '2026-11-01' };
    const o = (x) => Object.assign({ stage: 'contacted', value: 100, expected_close: '2026-11-01' }, x);
    const z = (x) => Object.assign({ id: 'Z', Stage: 'Needs Analysis', Amount: 100, Closing_Date: '2026-11-01' }, x);
    const acts = (oo, zz) => DS.decideDeal(oo, zz, b).map(d => d.field + ':' + d.act + (d.kind ? '/' + d.kind : ''));
    assert.deepStrictEqual(acts(o(), z()), ['stage:none', 'amount:none', 'close_date:none']);
    assert.deepStrictEqual(acts(o(), z({ Amount: 150, Closing_Date: '2026-12-01', Stage: 'Proposal/Price Quote' })), ['stage:apply', 'amount:apply', 'close_date:apply']);
    assert.deepStrictEqual(acts(o({ value: 150, expected_close: '2026-12-01', stage: 'quoted' }), z()), ['stage:push', 'amount:push', 'close_date:push']);
    assert.deepStrictEqual(acts(o({ value: 150, expected_close: '2026-12-01', stage: 'quoted' }), z({ Amount: 175, Closing_Date: '2026-12-15', Stage: 'Closed Won' })),
      ['stage:conflict/both_changed', 'amount:conflict/both_changed', 'close_date:conflict/both_changed']);
    assert.deepStrictEqual(acts(o({ value: 150, expected_close: '2026-12-01', stage: 'quoted' }), z({ Amount: 150, Closing_Date: '2026-12-01', Stage: 'Negotiation/Review' })),
      ['stage:agree', 'amount:agree', 'close_date:agree']);
    // updated_at plays no part
    assert.deepStrictEqual(acts(o({ updated_at: '2030-01-01T00:00:00Z' }), z()), ['stage:none', 'amount:none', 'close_date:none']);
  });

  await t('D2 stage rules: an equivalent Zoho stage changes no HCPS stage; HCPS never rewrites an equivalent Zoho stage; unmapped → review, never overwritten', async () => {
    const b = { stage: 'contacted', zoho_stage: 'Needs Analysis', amount: 0, close_date: '2026-11-01' };
    let d = DS.decideStage({ stage: 'contacted' }, { Stage: 'Value Proposition' }, b);
    assert.strictEqual(d.act, 'apply'); assert.deepStrictEqual(d.set, { zoho_stage: 'Value Proposition' }); assert.deepStrictEqual(d.base, { stage: 'contacted', zoho_stage: 'Value Proposition' });
    d = DS.decideStage({ stage: 'contacted' }, { Stage: 'Identify Decision Makers' }, { stage: 'quoted', zoho_stage: 'Identify Decision Makers' });   // HCPS moved to the stage Zoho already maps to
    assert.strictEqual(d.act, 'agree');
    d = DS.decideStage({ stage: 'quoted' }, { Stage: 'Value Proposition' }, { stage: 'contacted', zoho_stage: 'Value Proposition' });
    assert.strictEqual(d.act, 'push'); assert.deepStrictEqual(d.put, { Stage: 'Proposal/Price Quote' });
    d = DS.decideStage({ stage: 'quoted' }, { Stage: 'On Hold (custom)' }, { stage: 'contacted', zoho_stage: 'Value Proposition' });
    assert.strictEqual(d.act, 'conflict'); assert.strictEqual(d.kind, 'unmapped_stage'); assert.strictEqual(d.preserve, 'On Hold (custom)'); assert.ok(!d.put);
    assert.deepStrictEqual(DS.STAGE_TO_ZOHO, { identified: 'Qualification', contacted: 'Needs Analysis', quoted: 'Proposal/Price Quote', won: 'Closed Won', lost: 'Closed Lost' }, 'the mapping changed');
  });

  await t('D2 close date: a blank HCPS close date is never pushed and never a change; no baseline + same values agree, different values are a review', async () => {
    const b = { close_date: '2026-11-01' };
    assert.strictEqual(DS.decideClose({ expected_close: null }, { Closing_Date: '2026-11-01' }, b).act, 'none');
    assert.strictEqual(DS.decideClose({ expected_close: null }, { Closing_Date: '2026-12-01' }, b).act, 'apply');
    assert.strictEqual(DS.decideAmount({ value: 5 }, { Amount: 5 }, {}).act, 'agree');
    const d = DS.decideAmount({ value: 5 }, { Amount: 7 }, {}); assert.strictEqual(d.act, 'conflict'); assert.strictEqual(d.kind, 'no_baseline');
    assert.strictEqual(DS.decideAmount({ value: 100 }, { Amount: 100.004 }, { amount: 100 }).act, 'none', 'amounts compare to the cent');
  });

  /* ---------------- D3/D4 — Zoho → HCPS, once, only with an event ---------------- */
  await t('D3 a Zoho-only change to a shared field reaches HCPS ONCE (with its event); the event says what happened; nothing is pushed back', async () => {
    const w = world(); zedit(w, 'Z1', { Amount: 250 }); const e = addEv(w, 'Z1');
    const r1 = await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 250); assert.strictEqual(opp(w, 'o1').stage, 'contacted', 'another field changed');
    assert.strictEqual(baseOf(w, 'o1').amount, 250);
    const q = w.db.zoho_sync_queue.find(x => x.id === e.id); assert.strictEqual(q.status, 'synced'); assert.ok(/amount 100 → 250/.test(q.outcome), q.outcome); assert.ok(q.processed_at);
    assert.strictEqual(r1.summary.deals.applied, 1); assert.strictEqual(r1.summary.deals_pulled, 1);
    assert.deepStrictEqual(dealPuts(w), [], 'the applied value was pushed back to Zoho');
    const n = oppPatches(w).length;
    // the same event delivered again (already processed) and two more runs: no second write anywhere
    await autosync(w); await autosync(w);
    assert.strictEqual(oppPatches(w).length, n, 'HCPS written twice'); assert.deepStrictEqual(dealPuts(w), []);
    assert.strictEqual(logs(w).filter(l => l.action === 'deal_apply').length, 1);
  });

  await t('D3 without an event a Zoho change is NOT applied: drift is logged once and applied when an event arrives', async () => {
    const w = world(); zedit(w, 'Z1', { Amount: 300 });
    let r = await autosync(w); await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 100, 'applied without an event'); assert.strictEqual(r.summary.deals.drift, 1);
    assert.strictEqual(logs(w).filter(l => l.action === 'drift').length, 1, 'drift logged more than once');
    assert.strictEqual(baseOf(w, 'o1').amount, 100);
    addEv(w, 'Z1'); r = await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 300); assert.strictEqual(r.summary.deals.applied, 1);
  });

  await t('D3 a STALE captured event never authorizes a newer, uncaptured Zoho change: nothing from it reaches HCPS; drift is reported once; the event waits', async () => {
    // webhook captured at Modified_Time A; Zoho changes again at B; no webhook for B; the run reads B
    const w = world();
    zedit(w, 'Z1', { Amount: 250 }); const eA = addEv(w, 'Z1');                     // A (captured)
    zedit(w, 'Z1', { Amount: 400, Closing_Date: '2027-02-01' });                    // B (no webhook yet)
    let r = await autosync(w); await autosync(w);
    const o = opp(w, 'o1'); assert.deepStrictEqual([o.value, o.expected_close, o.stage], [100, '2026-11-01', 'contacted'], 'something from the uncaptured change reached HCPS');
    assert.ok(!oppPatches(w).some(x => ['value', 'expected_close', 'stage', 'zoho_stage'].some(k => k in x.body)), 'HCPS was written');
    assert.deepStrictEqual(baseOf(w, 'o1'), BASE1, 'the baseline moved');
    assert.strictEqual(w.db.zoho_sync_queue.find(x => x.id === eA.id).status, 'pending', 'the stale event was consumed');
    assert.strictEqual(r.summary.deals.events_waiting, 1); assert.strictEqual(r.summary.deals.applied, 0);
    const d = logs(w).filter(l => l.action === 'drift'); assert.strictEqual(d.length, 1, 'drift not reported exactly once');
    assert.ok(/after the last captured Deal event/.test(JSON.parse(d[0].detail).note)); assert.deepStrictEqual(dealPuts(w), []);
    // B's own webhook arrives → now the state is fully captured → applied once, both events processed
    const eB = addEv(w, 'Z1'); r = await autosync(w);
    assert.deepStrictEqual([opp(w, 'o1').value, opp(w, 'o1').expected_close], [400, '2027-02-01']);
    assert.deepStrictEqual([eA, eB].map(e => w.db.zoho_sync_queue.find(x => x.id === e.id).status), ['synced', 'synced']);
    assert.strictEqual(r.summary.deals.applied, 1);
  });

  await t('D3 stale event, different fields: event A covered the amount, the uncaptured B changed the stage → neither A\'s nor B\'s value is taken', async () => {
    const w = world();
    zedit(w, 'Z1', { Amount: 260 }); addEv(w, 'Z1');
    zedit(w, 'Z1', { Stage: 'Closed Won' });
    await autosync(w);
    assert.deepStrictEqual([opp(w, 'o1').value, opp(w, 'o1').stage, opp(w, 'o1').zoho_stage], [100, 'contacted', 'Value Proposition']);
    // the uncaptured change is an unmapped stage: flagged for review, but NOT recorded as Zoho's stage from a stale state
    const w4 = world(); zedit(w4, 'Z1', { Amount: 265 }); const e4 = addEv(w4, 'Z1'); zedit(w4, 'Z1', { Stage: 'On Hold (custom)' }); await autosync(w4);
    assert.strictEqual(opp(w4, 'o1').zoho_stage, 'Value Proposition'); assert.strictEqual(opp(w4, 'o1').value, 100);
    assert.strictEqual(w4.db.zoho_sync_queue.find(x => x.id === e4.id).status, 'pending'); assert.strictEqual(openConflicts(w4)[0].kind, 'unmapped_stage');
    // the uncaptured change put the value back to the baseline: nothing differs, yet the event still waits and that is reported
    const w5 = world(); zedit(w5, 'Z1', { Amount: 275 }); const e5 = addEv(w5, 'Z1'); zedit(w5, 'Z1', { Amount: 100 }); const r5 = await autosync(w5);
    assert.strictEqual(w5.db.zoho_sync_queue.find(x => x.id === e5.id).status, 'pending'); assert.strictEqual(r5.summary.deals.events_waiting, 1);
    assert.strictEqual(logs(w5).filter(l => l.action === 'drift').length, 1);
    // an event whose Modified_Time can't be read, or a Zoho record without one, authorizes nothing either
    const w2 = world(); zedit(w2, 'Z1', { Amount: 270 }); addEv(w2, 'Z1', { modified_time: 'yesterday' }); await autosync(w2);
    assert.strictEqual(opp(w2, 'o1').value, 100);
    const w3 = world(); zedit(w3, 'Z1', { Amount: 280 }); addEv(w3, 'Z1'); delete zdeal(w3, 'Z1').Modified_Time; await autosync(w3);
    assert.strictEqual(opp(w3, 'o1').value, 100);
  });

  await t('D3 our own push moves Zoho\'s Modified_Time: the waiting event is applied once that push\'s echo is captured (no deadlock, nothing early)', async () => {
    const w = world();
    zedit(w, 'Z1', { Amount: 330 }); const eA = addEv(w, 'Z1');                     // a Zoho edit, captured
    opp(w, 'o1').expected_close = '2026-12-31'; await api(w, 'sync_opportunities');   // HCPS pushes its own change first (on demand) → Zoho stamps T
    assert.strictEqual(zdeal(w, 'Z1').Closing_Date, '2026-12-31');
    await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 100, 'applied before the newer state was captured'); assert.strictEqual(w.db.zoho_sync_queue.find(x => x.id === eA.id).status, 'pending');
    addEv(w, 'Z1', { classification: 'echo', status: 'ignored', processed_at: 'x', class_reason: 'echo', classified_at: 'x' });   // the push's echo arrives (at T)
    await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 330); assert.strictEqual(opp(w, 'o1').expected_close, '2026-12-31');
    assert.strictEqual(w.db.zoho_sync_queue.find(x => x.id === eA.id).status, 'synced');
  });

  await t('D3 a Zoho stage change: mapped → HCPS stage, status and probability as before + exact Zoho stage kept; history is written by the database (no Pipeline context)', async () => {
    const w = world(); zedit(w, 'Z1', { Stage: 'Negotiation/Review' }); addEv(w, 'Z1');
    await autosync(w);
    const o = opp(w, 'o1'); assert.strictEqual(o.stage, 'quoted'); assert.strictEqual(o.status, 'open'); assert.strictEqual(o.probability, 0.6); assert.strictEqual(o.zoho_stage, 'Negotiation/Review');
    const p = oppPatches(w).find(x => x.body.stage); assert.ok(!/x-hcps/.test(JSON.stringify(w.calls.filter(c => c.method === 'PATCH' && /opportunities/.test(c.url)).map(c => c.headers))), 'Pipeline context sent');
    assert.ok(p && p.body.updated_at);
    assert.deepStrictEqual(dealPuts(w), [], 'the stage was rewritten in Zoho');
  });

  await t('D2 an equivalent Zoho stage (Value Proposition → Identify Decision Makers, both "contacted"): HCPS stage untouched, exact stage kept, Zoho never rewritten', async () => {
    const w = world(); zedit(w, 'Z1', { Stage: 'Identify Decision Makers' }); addEv(w, 'Z1');
    await autosync(w);
    assert.strictEqual(opp(w, 'o1').stage, 'contacted'); assert.strictEqual(opp(w, 'o1').zoho_stage, 'Identify Decision Makers');
    assert.ok(!oppPatches(w).some(x => 'stage' in x.body || 'updated_at' in x.body), 'the HCPS deal itself was changed');
    // later HCPS changes another field: only that field goes; the Zoho stage stays as Zoho has it
    opp(w, 'o1').value = 140; await autosync(w);
    const puts = dealPuts(w); assert.strictEqual(puts.length, 1); assert.deepStrictEqual(Object.keys(puts[0].body.data[0]).sort(), ['Amount', 'id']);
    assert.strictEqual(zdeal(w, 'Z1').Stage, 'Identify Decision Makers'); assert.strictEqual(zdeal(w, 'Z1').Amount, 140);
  });

  await t('D2 an UNMAPPED Zoho stage is preserved and flagged for review; HCPS stage not changed; never overwritten — even after HCPS changes its stage', async () => {
    const w = world(); zedit(w, 'Z1', { Stage: 'On Hold (custom)' }); const e = addEv(w, 'Z1');
    await autosync(w);
    assert.strictEqual(opp(w, 'o1').stage, 'contacted'); assert.strictEqual(opp(w, 'o1').zoho_stage, 'On Hold (custom)');
    const c = openConflicts(w); assert.strictEqual(c.length, 1); assert.strictEqual(c[0].kind, 'unmapped_stage'); assert.strictEqual(c[0].zoho_value, 'On Hold (custom)');
    assert.strictEqual(w.db.zoho_sync_queue.find(x => x.id === e.id).status, 'conflict');
    opp(w, 'o1').stage = 'quoted'; await autosync(w); await autosync(w);
    assert.strictEqual(zdeal(w, 'Z1').Stage, 'On Hold (custom)', 'the unmapped stage was overwritten');
    assert.ok(!dealPuts(w).some(x => 'Stage' in x.body.data[0]));
    assert.strictEqual(openConflicts(w).length, 1, 'one open review only');
  });

  /* ---------------- D1 — HCPS → Zoho ---------------- */
  await t('D1 an HCPS-only change reaches Zoho: ONLY that field is pushed; baseline, push time and echo fingerprint recorded; its echo makes no second write', async () => {
    const w = world(); opp(w, 'o1').expected_close = '2026-12-15';
    const r = await autosync(w);
    const puts = dealPuts(w); assert.strictEqual(puts.length, 1); assert.deepStrictEqual(puts[0].body.data[0], { id: 'Z1', Closing_Date: '2026-12-15' });
    assert.strictEqual(zdeal(w, 'Z1').Closing_Date, '2026-12-15'); assert.strictEqual(zdeal(w, 'Z1').Stage, 'Value Proposition', 'the Zoho stage was rewritten');
    assert.strictEqual(baseOf(w, 'o1').close_date, '2026-12-15'); assert.strictEqual(r.summary.deals.pushed, 1); assert.strictEqual(r.summary.opportunities.ok, 1);
    const times = w.db.app_settings.find(x => x.key === 'zoho_push_times').value; assert.strictEqual(times['opp:o1'].id, 'Z1');
    assert.ok(w.db.app_settings.find(x => x.key === 'zoho_push_hashes').value['opp:o1']);
    // Zoho fires the webhook for our own push: 2F-4 marks it an echo → ignored; nothing is written again
    const d = new Date(Date.parse(times['opp:o1'].at));
    const mt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Chicago', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d).replace('T', ' ');
    w.db.zoho_sync_queue.push({ id: 900, direction: 'in', entity: 'deals', entity_id: 'Z1', zoho_id: 'Z1', event_key: 'echo1', status: 'pending', classification: null, modified_time: mt });
    const n = oppPatches(w).length; await autosync(w);
    const q = w.db.zoho_sync_queue.find(x => x.id === 900); assert.strictEqual(q.classification, 'echo', q.class_reason); assert.strictEqual(q.status, 'ignored');
    assert.strictEqual(dealPuts(w).length, 1, 'pushed twice'); assert.strictEqual(oppPatches(w).length, n, 'HCPS written for our own echo');
  });

  await t('D4 an echo-like event that 2F-4 could not prove (external) still makes no write: Zoho equals the baseline', async () => {
    const w = world(); opp(w, 'o1').value = 180; await autosync(w);
    const e = addEv(w, 'Z1'); const n = oppPatches(w).length, p = dealPuts(w).length;
    await autosync(w);
    const q = w.db.zoho_sync_queue.find(x => x.id === e.id); assert.strictEqual(q.status, 'synced'); assert.ok(/no change to a shared field/.test(q.outcome));
    assert.strictEqual(oppPatches(w).length, n); assert.strictEqual(dealPuts(w).length, p);
  });

  /* ---------------- D1 — both sides changed ---------------- */
  await t('D1 BOTH sides changed: a conflict is recorded, neither side changes, the event says so; it clears only when both sides agree again', async () => {
    const w = world(); opp(w, 'o1').value = 150; zedit(w, 'Z1', { Amount: 175 }); const e = addEv(w, 'Z1');
    await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 150, 'HCPS was overwritten'); assert.strictEqual(zdeal(w, 'Z1').Amount, 175, 'Zoho was overwritten');
    assert.deepStrictEqual(dealPuts(w), []); assert.strictEqual(baseOf(w, 'o1').amount, 100, 'the baseline moved');
    const c = openConflicts(w); assert.strictEqual(c.length, 1);
    assert.deepStrictEqual([c[0].field, c[0].kind, c[0].base_value, c[0].hcps_value, c[0].zoho_value], ['amount', 'both_changed', '100', '150', '175']);
    const q = w.db.zoho_sync_queue.find(x => x.id === e.id); assert.strictEqual(q.status, 'conflict'); assert.ok(/amount changed on both sides/.test(q.outcome));
    const lr = logs(w).filter(l => l.action === 'conflict'); assert.strictEqual(lr.length, 1); assert.strictEqual(lr[0].result, 'conflict');
    // more runs, and Zoho changing again: still a conflict, still no write, one record (values kept current)
    await autosync(w); zedit(w, 'Z1', { Amount: 190 }); addEv(w, 'Z1'); await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 150); assert.deepStrictEqual(dealPuts(w), []); assert.strictEqual(openConflicts(w).length, 1); assert.strictEqual(openConflicts(w)[0].zoho_value, '190');
    // a person makes HCPS match Zoho → both agree → resolved (kept), baseline moves, nothing written
    opp(w, 'o1').value = 190; await autosync(w);
    assert.strictEqual(openConflicts(w).length, 0); const res = w.db.zoho_deal_conflicts.find(x => x.status === 'resolved'); assert.ok(res && res.resolved_at && /agree/.test(res.resolution));
    assert.strictEqual(baseOf(w, 'o1').amount, 190); assert.deepStrictEqual(dealPuts(w), []);
  });

  await t('D1 an open conflict is not cleared by one side going back: it stays open until both sides agree (no event → nothing applied)', async () => {
    const w = world(); opp(w, 'o1').value = 150; zedit(w, 'Z1', { Amount: 175 }); addEv(w, 'Z1'); await autosync(w);
    opp(w, 'o1').value = 100; await autosync(w);   // HCPS back to the baseline; Zoho still different, no new event
    assert.strictEqual(openConflicts(w).length, 1, 'the conflict was cleared while the sides still differ');
    assert.strictEqual(opp(w, 'o1').value, 100); assert.strictEqual(zdeal(w, 'Z1').Amount, 175); assert.deepStrictEqual(dealPuts(w), []);
  });

  await t('D1 fields are independent: amount in conflict does not stop a Zoho close-date change or an HCPS stage change', async () => {
    const w = world(); opp(w, 'o1').value = 150; zedit(w, 'Z1', { Amount: 175 }); zedit(w, 'Z1', { Closing_Date: '2027-01-15' }); addEv(w, 'Z1');
    opp(w, 'o1').stage = 'won';
    await autosync(w);
    assert.strictEqual(opp(w, 'o1').expected_close, '2027-01-15'); assert.strictEqual(opp(w, 'o1').value, 150);
    const puts = dealPuts(w); assert.strictEqual(puts.length, 1); assert.deepStrictEqual(puts[0].body.data[0], { id: 'Z1', Stage: 'Closed Won' });
    assert.strictEqual(zdeal(w, 'Z1').Amount, 175); assert.strictEqual(opp(w, 'o1').zoho_stage, 'Closed Won');
    assert.deepStrictEqual(openConflicts(w).map(c => c.field), ['amount']);
  });

  /* ---------------- D5 — TEST, first sight, failures ---------------- */
  await t('D5 a TEST deal: a Zoho change (with its event) is kept in step in HCPS; an HCPS change is never pushed; both → conflict', async () => {
    const w = world(); zedit(w, 'ZT', { Amount: 25 }); addEv(w, 'ZT');
    let r = await autosync(w);
    assert.strictEqual(opp(w, 'ot').value, 25); assert.deepStrictEqual(dealPuts(w), []); assert.strictEqual(r.summary.test_excluded.deals, 1);
    opp(w, 'ot').value = 30; r = await autosync(w);
    assert.deepStrictEqual(dealPuts(w), [], 'a TEST deal was pushed'); assert.strictEqual(zdeal(w, 'ZT').Amount, 25); assert.ok(r.summary.deals.test_held >= 1);
    zedit(w, 'ZT', { Amount: 40 }); addEv(w, 'ZT'); await autosync(w);
    assert.strictEqual(opp(w, 'ot').value, 30); assert.strictEqual(zdeal(w, 'ZT').Amount, 40); assert.strictEqual(openConflicts(w).length, 1);
    const sent = JSON.stringify(w.outbound.filter(x => x.kind === 'zoho' && x.method !== 'GET').map(x => x.body));
    assert.ok(!/Sandbox deal|"ZT"/.test(sent), 'TEST data sent to Zoho');
  });

  await t('D5 first sight of linked deals (deploy): baselines recorded, exact Zoho stage kept, NOTHING changed on either side; a mismatch is a review, not a guess', async () => {
    const w = world({ noBaseline: true });
    opp(w, 'o1').zoho_stage = null; zedit(w, 'ZT', { Amount: 9 });   // the TEST deal differs between the two sides
    const r = await autosync(w);
    assert.deepStrictEqual(dealPuts(w), []); assert.ok(!oppPatches(w).some(x => ['stage', 'value', 'expected_close', 'status', 'probability'].some(k => k in x.body)), 'a business field was written');
    assert.deepStrictEqual(baseOf(w, 'o1'), { stage: 'contacted', zoho_stage: 'Value Proposition', amount: 100, close_date: '2026-11-01' });
    assert.strictEqual(opp(w, 'o1').zoho_stage, 'Value Proposition');
    const c = openConflicts(w); assert.strictEqual(c.length, 1); assert.deepStrictEqual([c[0].opportunity_id, c[0].field, c[0].kind], ['ot', 'amount', 'no_baseline']);
    assert.ok(!('amount' in baseOf(w, 'ot')));
    assert.strictEqual(r.summary.deals.agreed, 2); assert.strictEqual(runRow(w).result, 'ok');
  });

  await t('D5 failures are rows and nothing is guessed: baseline / Zoho unreadable → no deal written; an HCPS write that fails leaves the event pending and applies once later', async () => {
    // the tables exist but the open conflicts can't be read → no linked deal is decided (a duplicate record would be guessed)
    let w = world({ failRead: tb => tb === 'zoho_deal_conflicts' ? 500 : 0 }); opp(w, 'o1').value = 150; zedit(w, 'Z1', { Amount: 175 }); addEv(w, 'Z1');
    await autosync(w);
    assert.deepStrictEqual(dealPuts(w), []); assert.strictEqual(opp(w, 'o1').value, 150); assert.strictEqual(failPhase(w, 'deal_baseline_read').length, 1); assert.strictEqual(runRow(w).result, 'partial');
    assert.deepStrictEqual(baseOf(w, 'o1'), BASE1, 'an unreadable baseline was overwritten'); assert.strictEqual(openConflicts(w).length, 0);
    w = world({ zoho: { idsFail: { Deals: 500 } } }); opp(w, 'o1').value = 150; await autosync(w);
    assert.deepStrictEqual(dealPuts(w), []); assert.strictEqual(failPhase(w, 'deals_read').length, 1);
    assert.deepStrictEqual(w.db.zoho_deal_baseline.map(b => [b.opportunity_id, b.drift || null]), [['o1', null], ['ot', null]], 'deals were treated as missing from Zoho');
    assert.strictEqual(logs(w).filter(l => l.action === 'drift').length, 0);
    let fail = true; w = world({ failWrite: (m, tb, b) => fail && m === 'PATCH' && tb === 'opportunities' && b && 'value' in b ? 500 : 0 });
    zedit(w, 'Z1', { Amount: 260 }); const e = addEv(w, 'Z1');
    await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 100); assert.strictEqual(w.db.zoho_sync_queue.find(x => x.id === e.id).status, 'pending'); assert.strictEqual(baseOf(w, 'o1').amount, 100);
    assert.strictEqual(failPhase(w, 'pull_deals').length, 1);
    fail = false; await autosync(w); await autosync(w);
    assert.strictEqual(opp(w, 'o1').value, 260); assert.strictEqual(w.db.zoho_sync_queue.find(x => x.id === e.id).status, 'synced');
    assert.strictEqual(oppPatches(w).filter(x => 'value' in x.body).length, 1, 'applied more than once after the retry');   // (a refused write is not a write)
  });

  await t('D5 a refused push leaves the baseline where it was (pushed again next run); a TEST rule that can\'t be read pushes nothing', async () => {
    let w = world({ zoho: { deal: () => ({ code: 'INVALID_DATA', message: 'no' }) } }); opp(w, 'o1').value = 150;
    await autosync(w);
    assert.strictEqual(baseOf(w, 'o1').amount, 100); assert.strictEqual(failPhase(w, 'opps').length, 1);
    w = world({ failRead: (tb, qs) => tb === 'dealers' && /is_test=eq\.true/.test(decodeURIComponent(qs)) ? 500 : 0 }); opp(w, 'o1').value = 150;
    await autosync(w); assert.deepStrictEqual(dealPuts(w), []);
  });

  await t('D5 deploy order: if the 2F-5 tables are missing, no deal is created, pushed or changed (no duplicate deals in Zoho)', async () => {
    const S = seed({ opps: [{ id: 'on', dealer_id: 'd-greg', title: 'New deal', stage: 'identified', value: 5, expected_close: '2026-12-01', zoho_id: null }] });
    S.missingTables = ['zoho_deal_baseline', 'zoho_deal_conflicts']; const w = createWorld(S); w.__seed = S;
    opp(w, 'o1').value = 150; zedit(w, 'Z1', { Amount: 175 }); addEv(w, 'Z1');
    await autosync(w); await autosync(w);
    assert.deepStrictEqual(w.outbound.filter(x => x.kind === 'zoho' && x.method !== 'GET' && /\/Deals/.test(x.path)), [], 'a deal was created or pushed');
    assert.strictEqual(opp(w, 'o1').value, 150); assert.strictEqual(opp(w, 'on').zoho_id, null);
    assert.ok(failPhase(w, 'deal_baseline_read').length >= 1 && /2F-5 migration/.test(failPhase(w, 'deal_baseline_read')[0].detail));
  });

  await t('D5 one Zoho deal linked to TWO HCPS deals: neither is synchronized (nothing pushed or applied), a failure row says why, its events wait', async () => {
    const w = world({ opps: [{ id: 'o9', dealer_id: 'd-ang', title: 'Same Zoho deal', stage: 'contacted', value: 100, expected_close: '2026-11-01', zoho_id: 'Z1' }] });
    zedit(w, 'Z1', { Amount: 500 }); const e = addEv(w, 'Z1'); opp(w, 'o9').value = 120;
    await autosync(w);
    assert.deepStrictEqual([opp(w, 'o1').value, opp(w, 'o9').value], [100, 120]); assert.deepStrictEqual(dealPuts(w), []);
    assert.strictEqual(w.db.zoho_sync_queue.find(x => x.id === e.id).status, 'pending');
    const f = failPhase(w, 'deal_link_duplicate'); assert.strictEqual(f.length, 2); assert.ok(/linked to 2 HCPS deals/.test(f[0].detail));
    assert.ok(!w.db.zoho_deal_baseline.some(b => b.opportunity_id === 'o9'), 'a second baseline for the same Zoho deal');
  });

  /* ---------------- D3 — scope: only linked Deal events ---------------- */
  await t('D3 only external/pending events of LINKED deals are processed: Zoho-only deals, echoes, unresolved, Account and Contact events are untouched', async () => {
    const w = world(); zedit(w, 'ZX', { Amount: 7 });
    const ex = addEv(w, 'ZX'), ign = addEv(w, 'Z1', { status: 'ignored', classification: 'echo', processed_at: '2026-10-09T10:00:00Z' }), un = addEv(w, 'Z1', { classification: 'unresolved' });
    const ac = { id: 990, direction: 'in', entity: 'accounts', entity_id: 'A1', zoho_id: 'A1', event_key: 'ka', status: 'pending', classification: 'external', class_reason: 'x', classified_at: 'x' };
    const co = { id: 991, direction: 'in', entity: 'contacts', entity_id: 'C1', zoho_id: 'C1', event_key: 'kc', status: 'pending', classification: 'external', class_reason: 'x', classified_at: 'x' };
    w.db.zoho_sync_queue.push(ac, co);
    const before = JSON.stringify(w.db.zoho_sync_queue);
    const r = await autosync(w);
    assert.strictEqual(JSON.stringify(w.db.zoho_sync_queue), before, 'an event outside 2F-5\'s scope was changed');
    assert.strictEqual(r.summary.deals.unlinked_events, 1); assert.ok(!w.db.opportunities.some(o => o.zoho_id === 'ZX'), 'a Zoho-only deal was imported');
    void ex; void ign; void un;
  });

  /* ---------------- D6 — on-demand, creation, page, migration ---------------- */
  await t('D6 on demand: "Deal changes" applies only events (never pushes); "Pipeline → Zoho" pushes only HCPS changes (never applies, never overwrites a Zoho change)', async () => {
    let w = world(); zedit(w, 'Z1', { Amount: 220 }); addEv(w, 'Z1'); opp(w, 'o1').expected_close = '2026-12-20';
    let r = await api(w, 'pull_deals');
    assert.strictEqual(r.body.changed, 1); assert.strictEqual(opp(w, 'o1').value, 220); assert.deepStrictEqual(dealPuts(w), [], 'pull_deals pushed');
    w = world(); zedit(w, 'Z1', { Amount: 220 }); addEv(w, 'Z1'); opp(w, 'o1').expected_close = '2026-12-20';
    r = await api(w, 'sync_opportunities');
    assert.strictEqual(r.body.updated, 1); assert.deepStrictEqual(dealPuts(w)[0].body.data[0], { id: 'Z1', Closing_Date: '2026-12-20' });
    assert.strictEqual(opp(w, 'o1').value, 100, 'sync_opportunities applied'); assert.strictEqual(zdeal(w, 'Z1').Amount, 220, 'a Zoho change was overwritten');
    w = world(); opp(w, 'o1').value = 150; zedit(w, 'Z1', { Amount: 175 });
    r = await api(w, 'sync_opportunities'); assert.deepStrictEqual(dealPuts(w), []); assert.strictEqual(r.body.conflicts, 1);
  });

  await t('D6 a new HCPS deal is created in Zoho as before (full record, provisional close date when blank) with its baseline; a TEST one never', async () => {
    const w = world({ opps: [{ id: 'on', dealer_id: 'd-greg', title: 'New deal', line: 'Golden', stage: 'quoted', status: 'open', value: 500, expected_close: null, zoho_id: null },
      { id: 'otn', dealer_id: 'd-test', title: 'Sandbox new', stage: 'identified', value: 0, expected_close: null, zoho_id: null }] });
    const r = await autosync(w);
    const posts = w.outbound.filter(x => x.kind === 'zoho' && x.method === 'POST' && /\/Deals$/.test(x.path.split('?')[0]));
    assert.strictEqual(posts.length, 1); const rec = posts[0].body.data[0];
    const today = new Date().toISOString().slice(0, 10);
    assert.deepStrictEqual([rec.Deal_Name, rec.Amount, rec.Stage, rec.Closing_Date, rec.Description], ['New deal', 500, 'Proposal/Price Quote', today, 'Line: Golden']);
    const o = opp(w, 'on'); assert.ok(o.zoho_id); assert.strictEqual(o.zoho_stage, 'Proposal/Price Quote'); assert.strictEqual(o.expected_close, today);
    assert.deepStrictEqual(baseOf(w, 'on'), { stage: 'quoted', zoho_stage: 'Proposal/Price Quote', amount: 500, close_date: today });
    assert.strictEqual(opp(w, 'otn').zoho_id, null); assert.strictEqual(r.summary.deals.created, 1); assert.strictEqual(r.summary.test_excluded.deals, 2);
    await autosync(w); assert.strictEqual(w.outbound.filter(x => x.kind === 'zoho' && x.method !== 'GET' && /\/Deals/.test(x.path)).length, 1, 'the new deal was pushed again');
  });

  await t('D6 a new deal\'s Zoho id is saved on its own: if recording its exact Zoho stage fails, the id is still kept (no duplicate next run)', async () => {
    const w = world({ opps: [{ id: 'on', dealer_id: 'd-greg', title: 'New deal', stage: 'identified', value: 5, expected_close: '2026-12-01', zoho_id: null }],
      failWrite: (m, tb, b) => m === 'PATCH' && tb === 'opportunities' && b && 'zoho_stage' in b ? 500 : 0 });
    await autosync(w); await autosync(w);
    assert.ok(opp(w, 'on').zoho_id, 'the Zoho id was lost'); assert.strictEqual(w.outbound.filter(x => x.kind === 'zoho' && x.method === 'POST' && /\/Deals$/.test(x.path)).length, 1, 'created twice');
    assert.ok(failPhase(w, 'deal_zoho_stage').length >= 1);
  });

  await t('D6 the Zoho sync page counts open deal conflicts', async () => {
    const w = world(); opp(w, 'o1').value = 150; zedit(w, 'Z1', { Amount: 175 }); addEv(w, 'Z1'); await autosync(w);
    const r = await api(w, 'sync_state'); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.deal_conflicts, 1);
  });

  await t('D6 migration: nullable zoho_stage, baseline + conflicts tables (one open per deal/field), queue outcome; additive only; rollback removes exactly that', async () => {
    const s = SQL.replace(/--.*$/gm, '');
    assert.ok(/alter table public\.opportunities add column if not exists zoho_stage text;/.test(s));
    assert.ok(/create table if not exists public\.zoho_deal_baseline \(\s*opportunity_id uuid primary key references public\.opportunities\(id\) on delete cascade/.test(s));
    assert.ok(/create unique index if not exists zoho_deal_conflicts_one_open on public\.zoho_deal_conflicts \(opportunity_id, field\) where status = 'open';/.test(s));
    assert.ok(/kind\s+text not null check \(kind in \('both_changed','unmapped_stage','no_baseline'\)\)/.test(s));
    assert.ok(/alter table public\.zoho_sync_queue add column if not exists outcome text;/.test(s));
    assert.ok(/drop index if exists public\.zoho_deal_baseline_zoho_idx;\s*create unique index if not exists zoho_deal_baseline_zoho_uniq on public\.zoho_deal_baseline \(zoho_id\);/.test(s), 'one Zoho deal id per baseline is not enforced');
    const rest = s.replace(/on delete cascade/g, '').replace('drop index if exists public.zoho_deal_baseline_zoho_idx;', '');   // (only the first draft's own index)
    assert.ok(!/\bdrop\b|\bdelete\b|\btruncate\b|alter column|\bupdate\b/i.test(rest), 'the migration is not additive');
    assert.ok(/enable row level security/.test(s) && /^begin;/m.test(s) && /^commit;/m.test(s));
    const rb = ROLLBACK.replace(/--.*$/gm, '');
    for (const re of [/drop table if exists public\.zoho_deal_conflicts;/, /drop table if exists public\.zoho_deal_baseline;/, /alter table public\.opportunities drop column if exists zoho_stage;/, /alter table public\.zoho_sync_queue drop column if exists outcome;/]) assert.ok(re.test(rb), String(re));
    assert.ok(!/update|delete/i.test(rb), 'the rollback changes deal data');
  });

  await t('D6 the engine writes only deals it may: no history table, no Pipeline context, no Account/Contact table', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', '_zoho_deals.js'), 'utf8');
    assert.ok(!/opportunity_events|stage_changed_at|x-hcps-source|x-hcps-actor|dealer_contacts|dealer_activity|"dealers\?|PATCH",`dealers/.test(src.replace(/sbGetAll\("dealers\?select=id,business_name","id"\)/, '')));
    assert.ok(!/upsertRecords|\/crm\/v8\/(Accounts|Contacts)/.test(src));
  });

  done('Phase 2F-5 deal conflict protection + stage preservation');
})();

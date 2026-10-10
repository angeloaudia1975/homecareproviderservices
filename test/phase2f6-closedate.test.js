/* Phase 2F-6 — provisional close-date handling (F5).

   Part 1 (this file, first): the DISCOVERY probe (zoho-api probe_close_date). Before the sync logic changes, the
   real Zoho API's behaviour with a Deal's Closing_Date is established on the TEST deal only:
     · can an existing deal's Closing_Date be cleared (null / "")?
     · can an update leave Closing_Date out entirely?
     · is Closing_Date required when a deal is created (field settings, layouts, and a real create attempt)?
   The probe is president-only and refuses anything that isn't linked to exactly one TEST dealer's deal (and fails
   closed when the TEST rule can't be read). Its writes carry trigger:[] (no workflow → no webhook → nothing for the
   deal engine), never touch HCPS deal data, and are logged as action "probe" (ok / refused — never a sync failure). */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const ENV = { ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'zcs-b81d44e0aa' };
function seed(o) {
  o = o || {};
  const S = standardSeed({
    app_settings: [{ key: 'zoho_auth', value: { refresh_token: 'rt', api_domain: 'https://www.zohoapis.com' } }],
    opportunities: [
      { id: 'o1', dealer_id: 'd-greg', title: 'Real deal 1', stage: 'identified', value: 100, expected_close: '2026-11-01', zoho_id: '7000001' },
      { id: 'ot1', dealer_id: 'd-test', title: 'Sandbox deal A', stage: 'lost', value: 25, expected_close: '2026-10-02', zoho_id: '7000009' },
      { id: 'ot2', dealer_id: 'd-test', title: 'Sandbox deal B', stage: 'lost', value: 0, expected_close: '2026-10-02', zoho_id: '7000008' },
      { id: 'ot3', dealer_id: 'd-test', title: 'Sandbox deal B copy', stage: 'lost', value: 0, expected_close: '2026-10-02', zoho_id: '7000008' } ],
    zoho_sync_queue: [], zoho_sync_log: [],
  });
  S.tables.dealers.push({ id: 'd-test', business_name: 'TEST — Golden Sandbox', rep_name: null, parent_id: null, state: 'IN', is_test: true, email: 'orders@hcps.test' });
  S.zoho = { modules: {
    Accounts: [{ id: 'A1', Account_Name: 'Glasgow Prescription Center' }, { id: 'AT', Account_Name: 'TEST — Golden Sandbox' }],
    Deals: [
      { id: '7000001', Deal_Name: 'Real deal 1', Stage: 'Qualification', Amount: 100, Closing_Date: '2026-11-01', Account_Name: { id: 'A1' }, Modified_Time: '2026-10-01T10:00:00-05:00' },
      { id: '7000009', Deal_Name: 'Sandbox deal A', Stage: 'Closed Lost to Competition', Amount: 25, Closing_Date: '2026-10-02', Description: null, Account_Name: { id: o.realAccount ? 'A1' : 'AT' }, Modified_Time: '2026-10-01T10:00:00-05:00' },
      { id: '7000008', Deal_Name: 'Sandbox deal B', Stage: 'Closed Lost', Amount: 0, Closing_Date: '2026-10-02', Account_Name: { id: 'AT' } } ] },
    settings: {
      fields: { fields: [{ api_name: 'Deal_Name', system_mandatory: true }, { api_name: 'Closing_Date', data_type: 'date', system_mandatory: !!o.sysMandatory, read_only: false, custom_field: false }] },
      layouts: { layouts: [{ id: 'L1', name: 'Standard', status: 'active', sections: [{ fields: [{ api_name: 'Deal_Name', required: true }, { api_name: 'Closing_Date', required: !!o.layoutRequired }] }] }] } } };
  if (o.refuseBlank) S.zoho.deal = (method, rec) => ('Closing_Date' in rec && (rec.Closing_Date == null || rec.Closing_Date === '')) || (method === 'POST' && !('Closing_Date' in rec))
    ? { code: 'MANDATORY_NOT_FOUND', details: { api_name: 'Closing_Date' }, message: 'required field not found' } : undefined;
  if (o.ruleDown) S.failRead = (tb, qs) => tb === 'dealers' && /is_test=eq\.true/.test(decodeURIComponent(qs)) ? 500 : 0;
  if (o.linksDown) S.failRead = (tb, qs) => tb === 'opportunities' && /zoho_id=eq\./.test(decodeURIComponent(qs)) ? 500 : 0;
  return S;
}
const W = o => createWorld(seed(o));
const probe = (w, body, token) => call(load('zoho-api.js', w, ENV), Object.assign({ action: 'probe_close_date' }, body), { token: token || 'pres' });
const zWrites = w => w.outbound.filter(x => x.kind === 'zoho' && x.method !== 'GET');
const deal = (w, id) => w.db.opportunities.find(o => o.id === id);
const snapshot = w => JSON.stringify(w.db.opportunities);
const probeRows = w => (w.db.zoho_sync_log || []).filter(l => l.action === 'probe');

(async () => {
  await t('A real (non-TEST) deal is refused: nothing is written to Zoho or logged as a probe', async () => {
    const w = W(); const before = snapshot(w);
    for (const step of ['read', 'meta', 'clear', 'clear_blank', 'omit', 'create']) {
      const r = await probe(w, { zoho_id: '7000001', step, date: '2026-12-01' });
      assert.strictEqual(r.status, 403, step); assert.strictEqual(r.body.error, 'not_a_test_deal');
    }
    const r = await probe(w, { zoho_id: '7000001', step: 'restore', date: '2026-12-01' }); assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(zWrites(w), []); assert.deepStrictEqual(probeRows(w), []); assert.strictEqual(snapshot(w), before);
    assert.ok(!w.outbound.some(x => x.kind === 'zoho' && /7000001/.test(x.path)), 'the real deal was even read');
  });

  await t('Fail closed: TEST rule unreadable, or the HCPS link unreadable → nothing done', async () => {
    for (const o of [{ ruleDown: true }, { linksDown: true }]) {
      const w = W(o); const r = await probe(w, { zoho_id: '7000009', step: 'clear' });
      assert.ok(r.status === 503 || r.body.error === 'test_rule_unavailable', JSON.stringify(r.body));
      assert.deepStrictEqual(zWrites(w), []);
    }
  });

  await t('A Zoho deal not linked, or linked to two HCPS deals, is refused; a bad id is refused', async () => {
    const w = W();
    assert.strictEqual((await probe(w, { zoho_id: '7999999', step: 'clear' })).status, 403);
    assert.strictEqual((await probe(w, { zoho_id: '7000008', step: 'clear' })).status, 403);
    assert.strictEqual((await probe(w, { zoho_id: '70000x9', step: 'clear' })).status, 400);
    assert.strictEqual((await probe(w, { step: 'clear' })).status, 400);
    assert.deepStrictEqual(zWrites(w), []);
  });

  await t('President only: a rep or Relations gets 403, no token 401', async () => {
    const w = W();
    assert.strictEqual((await probe(w, { zoho_id: '7000009', step: 'clear' }, 'greg')).status, 403);
    assert.strictEqual((await probe(w, { zoho_id: '7000009', step: 'clear' }, 'lori')).status, 403);
    assert.strictEqual((await probe(w, { zoho_id: '7000009', step: 'clear' }, 'none')).status, 401);
    assert.deepStrictEqual(zWrites(w), []);
  });

  await t('meta is read-only and reports Closing_Date\'s field + layout settings', async () => {
    const w = W({ sysMandatory: false, layoutRequired: true }); const r = await probe(w, { zoho_id: '7000009', step: 'meta' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual(r.body.field, { api_name: 'Closing_Date', data_type: 'date', system_mandatory: false, read_only: false, custom_field: false });
    assert.deepStrictEqual(r.body.layouts, [{ id: 'L1', name: 'Standard', status: 'active', closing_date_in_layout: true, closing_date_required: true }]);
    assert.deepStrictEqual(zWrites(w), []); assert.deepStrictEqual(probeRows(w), []);
  });

  await t('clear: PUT {id, Closing_Date:null} with trigger:[] — Zoho\'s answer and the value read back are reported; HCPS untouched', async () => {
    const w = W(); const before = snapshot(w); const r = await probe(w, { zoho_id: '7000009', step: 'clear' });
    assert.strictEqual(r.status, 200);
    const wr = zWrites(w); assert.strictEqual(wr.length, 1);
    assert.strictEqual(wr[0].method, 'PUT'); assert.deepStrictEqual(wr[0].body, { data: [{ id: '7000009', Closing_Date: null }], trigger: [] });
    assert.strictEqual(r.body.zoho.code, 'SUCCESS'); assert.strictEqual(r.body.before.Closing_Date, '2026-10-02'); assert.strictEqual(r.body.after.Closing_Date, null);
    assert.strictEqual(snapshot(w), before, 'an HCPS deal changed');
    assert.deepStrictEqual(w.db.zoho_sync_queue, []);
    const p = probeRows(w); assert.strictEqual(p.length, 1); assert.strictEqual(p[0].result, 'ok'); assert.strictEqual(p[0].entity_id, 'ot1');
    assert.ok(!(w.db.zoho_sync_log || []).some(l => l.result === 'fail'));
  });

  await t('clear_blank sends "" ; a refusal is reported as Zoho gave it and logged "refused" — never a sync failure', async () => {
    const w = W({ refuseBlank: true });
    const r1 = await probe(w, { zoho_id: '7000009', step: 'clear_blank' });
    assert.deepStrictEqual(zWrites(w)[0].body, { data: [{ id: '7000009', Closing_Date: '' }], trigger: [] });
    assert.strictEqual(r1.body.zoho.code, 'MANDATORY_NOT_FOUND'); assert.deepStrictEqual(r1.body.zoho.details, { api_name: 'Closing_Date' });
    assert.strictEqual(r1.body.after.Closing_Date, '2026-10-02');
    const r2 = await probe(w, { zoho_id: '7000009', step: 'clear' }); assert.strictEqual(r2.body.zoho.code, 'MANDATORY_NOT_FOUND');
    assert.deepStrictEqual(probeRows(w).map(x => x.result), ['refused', 'refused']);
    assert.ok(!(w.db.zoho_sync_log || []).some(l => l.result === 'fail'));
  });

  await t('omit: an update WITHOUT Closing_Date re-sends only the deal\'s own Description, unchanged', async () => {
    const w = W(); const r = await probe(w, { zoho_id: '7000009', step: 'omit' });
    const body = zWrites(w)[0].body; assert.deepStrictEqual(body, { data: [{ id: '7000009', Description: null }], trigger: [] });
    assert.ok(!('Closing_Date' in body.data[0])); assert.strictEqual(r.body.zoho.code, 'SUCCESS'); assert.strictEqual(r.body.after.Closing_Date, '2026-10-02');
  });

  await t('restore needs a real date and puts exactly that date back', async () => {
    const w = W();
    assert.strictEqual((await probe(w, { zoho_id: '7000009', step: 'restore' })).status, 400);
    assert.strictEqual((await probe(w, { zoho_id: '7000009', step: 'restore', date: '10/2/2026' })).status, 400);
    assert.deepStrictEqual(zWrites(w), []);
    await probe(w, { zoho_id: '7000009', step: 'clear' });
    const r = await probe(w, { zoho_id: '7000009', step: 'restore', date: '2026-10-02' });
    assert.deepStrictEqual(zWrites(w)[1].body, { data: [{ id: '7000009', Closing_Date: '2026-10-02' }], trigger: [] });
    assert.strictEqual(r.body.after.Closing_Date, '2026-10-02');
  });

  await t('create: a new deal with NO Closing_Date, only under the TEST deal\'s own TEST account', async () => {
    const w = W(); const r = await probe(w, { zoho_id: '7000009', step: 'create' });
    const wr = zWrites(w); assert.strictEqual(wr.length, 1); assert.strictEqual(wr[0].method, 'POST');
    assert.deepStrictEqual(wr[0].body, { data: [{ Deal_Name: 'TEST 2F-6 create probe — sandbox', Stage: 'Qualification', Amount: 0, Account_Name: { id: 'AT' } }], trigger: [] });
    assert.strictEqual(r.body.zoho.code, 'SUCCESS'); assert.ok(r.body.created_id); assert.strictEqual(r.body.after.Closing_Date, null);
    assert.strictEqual(probeRows(w)[0].zoho_id, r.body.created_id);
    assert.strictEqual(w.db.opportunities.length, 4, 'an HCPS deal was created');
    const w2 = W({ realAccount: true }); const r2 = await probe(w2, { zoho_id: '7000009', step: 'create' });
    assert.strictEqual(r2.status, 403); assert.strictEqual(r2.body.error, 'not_test_account'); assert.deepStrictEqual(zWrites(w2), []);
    const w3 = W({ refuseBlank: true }); const r3 = await probe(w3, { zoho_id: '7000009', step: 'create' });
    assert.strictEqual(r3.body.zoho.code, 'MANDATORY_NOT_FOUND'); assert.strictEqual(r3.body.created_id, null); assert.strictEqual(probeRows(w3)[0].result, 'refused');
  });

  await t('An unknown step writes nothing', async () => {
    const w = W(); const r = await probe(w, { zoho_id: '7000009', step: 'delete' });
    assert.strictEqual(r.status, 400); assert.deepStrictEqual(zWrites(w), []);
  });

  done('Phase 2F-6 close-date');
})();

/* Ship-To branch resolution (netlify/functions/_shipto.js) — CLAUDE.md §18, Ship-To Correction & Branch Assignment.
   Strict mode (the automated path) never puts a multi-branch account's sale on the headquarters or the first branch
   without reliable evidence; legacy mode (the manual import) picks EXACTLY what the old pickBranch picked, labelled,
   with questionable picks flagged. The manual Sales Report Import preview now lists those flags and nothing else
   about the import changes.
     node test/shipto.test.js */
const assert = require('assert');
const { createWorld, load, call, standardSeed } = require('./phase0-mock');
const SH = () => require('../netlify/functions/_shipto.js');     // loaded through the mock loader's cache (mutants)

// A three-branch family + an unrelated single dealer.
const HQ = { id: 'hq', business_name: 'Williams Brothers Health Care Pharmacy', parent_id: null, city: 'Washington', state: 'IN', zip: '47501', address: '10 W Main Street' };
const PRN = { id: 'prn', business_name: 'Williams Brothers Princeton', parent_id: 'hq', city: 'Princeton', state: 'IN', zip: '47670', address: '200 N Hart St' };
const JAS = { id: 'jas', business_name: 'Williams Brothers Jasper', parent_id: 'hq', city: 'Jasper', state: 'IN', zip: '47546', address: '5 Newton St' };
const TWIN = { id: 'twin', business_name: 'Williams Brothers Jasper East', parent_id: 'hq', city: 'Jasper', state: 'IN', zip: '47546', address: '900 3rd Ave' };
const FAM = [HQ, PRN, JAS];
const ONE = { id: 'solo', business_name: 'Solo Medical', parent_id: null, city: 'Nashville', state: 'TN', zip: '37201' };
// The old pickBranch, verbatim in behaviour (sales-import-api.js before 2026-10-11).
const SUF = /\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm = n => String(n || '').toUpperCase().replace(/HEALTH ?CARE/g, 'HEALTHCARE').replace(/[.,'&/#-]/g, ' ').replace(SUF, ' ').replace(/\s+/g, ' ').trim();
const znorm = z => { const m = String(z || '').match(/\d{5}/); return m ? m[0] : ''; };
function oldPick(cands, row) {
  if (cands.length <= 1) return cands[0] || null;
  const zip = znorm(row.ship_zip), city = dnorm(row.ship_city), shipName = dnorm(row.ship_name);
  let hit = zip && cands.find(d => znorm(d.zip) === zip); if (hit) return hit;
  hit = city && cands.find(d => dnorm(d.city) === city); if (hit) return hit;
  hit = shipName && cands.find(d => dnorm(d.business_name) === shipName); if (hit) return hit;
  return cands.find(d => !d.parent_id) || cands[0];
}

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n')[0]); } }

(async () => {
  // Load through the mock loader so a mutant of _shipto.js is the module under test.
  const w0 = createWorld(standardSeed({})); load('sales-import-api.js', w0);
  const S = SH();
  const strict = (cands, row, o) => S.resolveBranch(cands, row, Object.assign({ mode: 'strict' }, o || {}));

  console.log('\n— strict (automated path): never HQ or the first branch without evidence —');
  await t('one account number over several branches, no ship-to at all → needs review ("no ship-to"), no dealer', async () => {
    const r = strict(FAM, { account_ref: 'A1' }); assert.strictEqual(r.dealer_id, null); assert.strictEqual(r.review, true); assert.strictEqual(r.reason, 'no_ship_to');
    assert.ok(r.suggestions.some(s => s.dealer_id === 'hq' && s.basis === 'hq'), 'HQ is offered as a suggestion only');
  });
  await t('no ship-to ZIP, city only → needs review; the city branch is only a suggestion', async () => {
    const r = strict(FAM, { ship_city: 'Jasper', ship_state: 'IN' }); assert.strictEqual(r.dealer_id, null); assert.strictEqual(r.reason, 'weak_evidence');
    assert.deepStrictEqual(r.suggestions.filter(s => s.basis === 'city').map(s => s.dealer_id), ['jas']);
  });
  await t('corporate billing address only (no delivery details) → needs review ("billing address only"), not the HQ', async () => {
    const r = strict(FAM, { bill_zip: '47501', bill_address: '10 W Main Street' }); assert.strictEqual(r.dealer_id, null); assert.strictEqual(r.reason, 'billing_address_only');
  });
  await t('billing ≠ delivery: the DELIVERY ZIP decides (Princeton), the billing address is ignored', async () => {
    const r = strict(FAM, { ship_zip: '47670-1234', bill_zip: '47501' }); assert.strictEqual(r.dealer_id, 'prn'); assert.strictEqual(r.basis, 'zip');
  });
  await t('a unique street address matches when the ZIP is missing', async () => {
    const r = strict(FAM, { ship_address: '200 North Hart Street' }); assert.strictEqual(r.dealer_id, 'prn'); assert.strictEqual(r.basis, 'address');
  });
  await t('a ZIP shared by two branches → needs review ("zip shared"), both suggested', async () => {
    const r = strict([HQ, PRN, JAS, TWIN], { ship_zip: '47546' }); assert.strictEqual(r.dealer_id, null); assert.strictEqual(r.reason, 'zip_shared');
    assert.deepStrictEqual(r.suggestions.filter(s => s.basis === 'zip').map(s => s.dealer_id).sort(), ['jas', 'twin']);
  });
  await t('a new shipping location (a ZIP no branch has) → needs review ("new location")', async () => {
    const r = strict(FAM, { ship_zip: '40202', ship_address: '1 Unknown Rd' }); assert.strictEqual(r.dealer_id, null); assert.strictEqual(r.reason, 'new_location');
  });
  await t('a verified recurring ship-to id → that branch, with its mapping as evidence', async () => {
    const maps = [{ id: 7, account_ref: 'A1', ship_key: 'id:st-0042', dealer_id: 'jas', scope: 'branch' }];
    const r = strict(FAM, { account_ref: 'a1 ', ship_to_id: 'ST-0042' }, { mappings: maps }); assert.strictEqual(r.dealer_id, 'jas'); assert.strictEqual(r.basis, 'verified_mapping'); assert.strictEqual(r.mapping_id, 7);
  });
  await t('a mapping is scoped narrowly: another ship-to of the same account is NOT sent to that branch', async () => {
    const maps = [{ account_ref: 'A1', ship_key: 'id:st-0042', dealer_id: 'jas', scope: 'branch' }];
    const r = strict(FAM, { account_ref: 'A1', ship_to_id: 'ST-0099' }, { mappings: maps }); assert.strictEqual(r.dealer_id, null); assert.strictEqual(r.review, true);
    const r2 = strict(FAM, { account_ref: 'A2', ship_to_id: 'ST-0042' }, { mappings: maps }); assert.strictEqual(r2.dealer_id, null, 'another account never borrows it');
    const r3 = strict(FAM, { account_ref: 'A1', ship_to_id: 'ST-0042' }, { mappings: maps.map(m => Object.assign({ retired_at: '2026-10-01' }, m)) }); assert.strictEqual(r3.dealer_id, null, 'a retired mapping is not used');
  });
  await t('an address mapping (street + ZIP) is remembered under the delivery address, not the account alone', async () => {
    assert.strictEqual(S.shipKey({ ship_address: '200 North Hart Street', ship_zip: '47670-1234' }), 'addr:200 N HART ST|47670');
    assert.strictEqual(S.shipKey({ account_ref: 'A1' }), null);
    const maps = [{ account_ref: 'A1', ship_key: 'addr:900 3RD AVE|47546', dealer_id: 'twin', scope: 'branch' }];
    assert.strictEqual(strict([HQ, PRN, JAS, TWIN], { account_ref: 'A1', ship_address: '900 3rd Avenue', ship_zip: '47546' }, { mappings: maps }).dealer_id, 'twin');
  });
  await t('a corporate / drop-ship sale only when a verified mapping says so', async () => {
    const maps = [{ account_ref: 'A1', ship_key: 'addr:44 PATIENT LN|47513', dealer_id: 'hq', scope: 'corporate' }];
    const r = strict(FAM, { account_ref: 'A1', ship_address: '44 Patient Lane', ship_zip: '47513' }, { mappings: maps });
    assert.strictEqual(r.dealer_id, 'hq'); assert.strictEqual(r.basis, 'corporate_confirmed');
    assert.strictEqual(strict(FAM, { account_ref: 'A1', ship_address: '44 Patient Lane', ship_zip: '47513' }).dealer_id, null);
  });
  await t('a dealer without branches is assigned without ship-to evidence; no candidate = unmatched (not review)', async () => {
    assert.strictEqual(strict([ONE], {}).dealer_id, 'solo'); assert.strictEqual(strict([], {}).basis, 'unmatched'); assert.strictEqual(strict([], {}).review, false);
  });
  await t('several invoice lines of one order with the same evidence get the same answer', async () => {
    const a = strict(FAM, { order_number: '5775', ship_zip: '47670' }), b = strict(FAM, { order_number: '5775', ship_zip: '47670', product_code: 'X' });
    assert.strictEqual(a.dealer_id, b.dealer_id);
  });

  console.log('\n— legacy (manual import): the same picks as before, now labelled —');
  await t('legacy mode picks exactly what the old pickBranch picked, over every combination of evidence', async () => {
    const zips = ['', '47501', '47670', '47546', '40202'], cities = ['', 'Princeton', 'Jasper', 'Louisville'], names = ['', 'Williams Brothers Jasper', 'Nobody'];
    const fams = [FAM, [PRN, JAS], [HQ, PRN, JAS, TWIN], [ONE], []];
    let n = 0;
    for (const f of fams) for (const z of zips) for (const c of cities) for (const nm of names) {
      const row = { ship_zip: z, ship_city: c, ship_name: nm }; const old = oldPick(f, row); const r = S.resolveBranch(f, row, { mode: 'legacy' });
      assert.strictEqual(r.dealer_id, old ? old.id : null, JSON.stringify({ f: f.map(d => d.id), row })); n++;
    }
    assert.ok(n > 250);
  });
  await t('legacy labels: unique ZIP is not flagged; HQ fallback, shared ZIP, city and name guesses are', async () => {
    const L = row => S.resolveBranch(FAM, row, { mode: 'legacy' });
    assert.deepStrictEqual([L({ ship_zip: '47670' }).basis, L({ ship_zip: '47670' }).questionable], ['zip', false]);
    assert.deepStrictEqual([L({}).basis, L({}).questionable, L({}).dealer_id], ['hq_fallback', true, 'hq']);
    assert.deepStrictEqual([L({ ship_city: 'Jasper' }).basis, L({ ship_city: 'Jasper' }).questionable], ['city', true]);
    const sh = S.resolveBranch([HQ, PRN, JAS, TWIN], { ship_zip: '47546' }, { mode: 'legacy' });
    assert.deepStrictEqual([sh.basis, sh.questionable, sh.dealer_id], ['zip_shared', true, 'jas']);
  });

  console.log('\n— the manual Sales Report Import preview —');
  const seed = () => {
    const s = standardSeed({ manufacturers: [{ slug: 'bemis', name: 'Bemis' }], dealer_aliases: [], dealer_manufacturers: [{ dealer_id: 'hq', manufacturer: 'bemis', account_ref: '777' }],
      monthly_sales: [], app_settings: [] });
    s.tables.dealers = s.tables.dealers.concat([HQ, PRN, JAS].map(d => Object.assign({ rep_name: 'Angelo Audia' }, d)));
    s.missingTables = ['mi1a_enrollment'];
    return s;
  };
  const rows = [
    { order_number: 'B1', date: '2026-09-02', company: 'Williams Brothers', account_ref: '777', product_code: 'X', qty: 1, unit_price: 50, ship_zip: '47670' },
    { order_number: 'B2', date: '2026-09-03', company: 'Williams Brothers', account_ref: '777', product_code: 'X', qty: 1, unit_price: 70 },
    { order_number: 'B2', date: '2026-09-03', company: 'Williams Brothers', account_ref: '777', product_code: 'Y', qty: 2, unit_price: 10 },
  ];
  await t('the preview flags the HQ-fallback order (both lines, one group) and leaves every pick as before', async () => {
    const w = createWorld(seed()); const m = load('sales-import-api.js', w);
    const r = await call(m, { action: 'preview', manufacturer: 'bemis', commission_rate: 10, rows }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const f = r.body.preview.ship_to_flags; assert.strictEqual(f.lines, 2); assert.strictEqual(f.groups.length, 1);
    assert.deepStrictEqual([f.groups[0].order, f.groups[0].basis, f.groups[0].dealer_id, f.groups[0].lines], ['B2', 'hq_fallback', 'hq', 2]);
    const per = Object.fromEntries(r.body.preview.per_dealer.map(d => [d.dealer_id, d.lines]));
    assert.deepStrictEqual(per, { prn: 1, hq: 2 }, 'the same branches as before: Princeton by ZIP, HQ by the old fallback');
  });
  await t('the preview writes nothing', async () => {
    const w = createWorld(seed()); const m = load('sales-import-api.js', w);
    await call(m, { action: 'preview', manufacturer: 'bemis', commission_rate: 10, rows }, { token: 'pres' });
    assert.strictEqual(w.writes.filter(x => x.table === 'monthly_sales').length, 0);
  });

  console.log(`\nshipto: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

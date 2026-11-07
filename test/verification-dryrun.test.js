/* Owner 2026-11-06: the historical verification DRY RUN lists every identifier with its proposed status and conflicts and
   writes NOTHING. Real handler against the in-memory PostgREST fake; synthetic data.  node test/verification-dryrun.test.js */
const assert = require('node:assert/strict');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
function seed() { return standardSeed({
  dealers: [{ id: 'hq', business_name: 'HQ Co', parent_id: null, city: 'A', state: 'KY' }, { id: 'br', business_name: 'HQ Co Branch', parent_id: 'hq' },
    { id: 'x', business_name: 'Other Co', parent_id: null }, { id: 'tst', business_name: 'TEST', parent_id: null, is_test: true }],
  dealer_manufacturers: [{ dealer_id: 'hq', manufacturer: 'bemis', account_ref: '723102', active: true },
    { dealer_id: 'br', manufacturer: 'bemis', account_ref: 'B-OWN', active: true },
    { dealer_id: 'hq', manufacturer: 'strongback-mobility', account_ref: 'hqlogin', active: true, verified_at: '2026-11-06T00:00:00Z', verified_ref: 'hqlogin', verified_by: 'a@h' },
    { dealer_id: 'hq', manufacturer: 'dalton', account_ref: 'JA2070', active: true }, { dealer_id: 'x', manufacturer: 'dalton', account_ref: 'ja2070', active: true },
    { dealer_id: 'hq', manufacturer: 'pedifix', account_ref: '555', active: true }, { dealer_id: 'x', manufacturer: 'pedifix', account_ref: '555', active: true },
    { dealer_id: 'hq', manufacturer: 'yuwell', account_ref: null, active: true }, { dealer_id: 'tst', manufacturer: 'bemis', account_ref: 'T-1', active: true }],
  dealer_account_claims: [{ id: 1, dealer_id: 'x', manufacturer: 'bemis', account_ref: 'NEW', status: 'pending' }] }); }
(async () => {
  await t('every identifier listed with proposed status and conflicts; nothing written; TEST dealers left out', async () => {
    const w = createWorld(seed()); const before = JSON.stringify(w.db.dealer_manufacturers);
    const r = await call(load('dealers-api.js', w), { action: 'verification_dry_run' }, { token: 'pres' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.written, 0); assert.equal(JSON.stringify(w.db.dealer_manufacturers), before, 'nothing written');
    const by = (d, m) => r.body.rows.find((x) => x.dealer_id === d && x.manufacturer === m);
    assert.equal(r.body.summary.identifiers, 7);
    assert.equal(by('hq', 'bemis').proposed, 'Verify — branch has its own identifier, check');
    assert.equal(by('hq', 'strongback-mobility').proposed, 'Already verified'); assert.equal(by('hq', 'strongback-mobility').kind, 'name / username');
    assert.equal(by('hq', 'dalton').proposed, 'Review — conflict', 'same identifier on two families (case-insensitive)');
    assert.equal(by('hq', 'pedifix').proposed, 'Verify', 'PediFix re-used numbers are noted, not a conflict'); assert.match(by('hq', 'pedifix').issues, /PediFix/);
    assert.ok(!r.body.rows.some((x) => x.dealer_id === 'tst'), 'TEST dealer left out'); assert.ok(!r.body.rows.some((x) => x.manufacturer === 'yuwell'), 'blank identifier not listed');
    assert.match(by('hq', 'bemis').provenance, /not stored/);
  });
  await t('management only', async () => {
    const r = await call(load('dealers-api.js', createWorld(seed())), { action: 'verification_dry_run' }, { token: 'greg' });
    assert.equal(r.status, 403);
  });
  done('verification dry run');
})();

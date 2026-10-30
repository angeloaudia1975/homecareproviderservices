/* routes-api — saved-route ownership and the President's own day (handler suite; 2026-10-30 audit).
   · A rep re-saving his own route re-assigned it to himself, undoing the President's hand-over.
   · The President re-saving a rep's route became its owner (the rep lost edit rights).
   · route_day by date, in My Sales Workspace, returned whichever rep's route was edited last.
   Real handler, fake database. Run: node test/sr-routes-api.test.js */
const assert = require('assert');
const { createWorld, load, standardSeed } = require('./phase0-mock');
let pass = 0, fail = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } }
function world() {
  return createWorld(standardSeed({ rep_routes: [
    { id: 'r-greg', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'Greg loop', scheduled_date: '2026-11-04', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }],
      assigned_to_email: 'lori@hcps.us', assigned_to_rep: 'Lori Hunt', updated_at: '2026-10-01T00:00:00Z' },
    { id: 'r-ang', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'My TN day', scheduled_date: '2026-11-05', stops: [{ dealer_id: 'd-ang', name: 'RMS' }], updated_at: '2026-10-01T00:00:00Z' },
    { id: 'r-other', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'Planned for Greg', scheduled_date: '2026-11-05', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }],
      assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', updated_at: '2026-10-20T00:00:00Z' },
  ], dealer_visit_reports: [] }));
}
async function call(w, who, body, headers) {
  const mod = load('routes-api.js', w, {});
  const r = await mod.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: 'Bearer ' + who }, headers || {}), body: JSON.stringify(body) });
  return { status: r.statusCode, j: JSON.parse(r.body || '{}') };
}
(async () => {
  await t('a rep re-saving his route keeps the President’s assignment (to Lori) and stays owner', async () => {
    const w = world();
    const r = await call(w, 'greg', { action: 'save_route', id: 'r-greg', name: 'Greg loop v2', stops: [{ dealer_id: 'd-greg', name: 'Glasgow' }] });
    assert.ok(r.j.ok, JSON.stringify(r.j));
    const row = w.db.rep_routes.find(x => x.id === 'r-greg');
    assert.strictEqual(row.name, 'Greg loop v2');
    assert.strictEqual(row.assigned_to_email, 'lori@hcps.us'); assert.strictEqual(row.owner_email, 'greg@hcps.us');
  });
  await t('the President re-saving a rep’s route does not take it over', async () => {
    const w = world();
    assert.ok((await call(w, 'pres', { action: 'save_route', id: 'r-greg', name: 'Edited by the office', stops: [] })).j.ok);
    const row = w.db.rep_routes.find(x => x.id === 'r-greg');
    assert.strictEqual(row.owner_email, 'greg@hcps.us'); assert.strictEqual(row.rep_name, 'Greg Campbell'); assert.strictEqual(row.assigned_to_email, 'lori@hcps.us');
  });
  await t('an explicit assignment by the President still moves it', async () => {
    const w = world();
    assert.ok((await call(w, 'pres', { action: 'save_route', id: 'r-greg', name: 'x', stops: [], assigned_to_email: 'greg@hcps.us' })).j.ok);
    assert.strictEqual(w.db.rep_routes.find(x => x.id === 'r-greg').assigned_to_email, 'greg@hcps.us');
  });
  await t('a new route is still owned by whoever saves it', async () => {
    const w = world();
    const r = await call(w, 'greg', { action: 'save_route', name: 'Brand new', stops: [] });
    const row = w.db.rep_routes.find(x => x.id === r.j.id); assert.strictEqual(row.owner_email, 'greg@hcps.us');
  });
  await t('My Sales Workspace: route_day by date is the President’s own route, not the one he planned for Greg', async () => {
    const w = world();
    const r = await call(w, 'pres', { action: 'route_day', date: '2026-11-05' }, { 'x-hcps-workspace': 'mine' });
    assert.strictEqual(r.j.route && r.j.route.id, 'r-ang', JSON.stringify(r.j.route && r.j.route.name));
    const admin = await call(w, 'pres', { action: 'route_day', date: '2026-11-05' });
    assert.strictEqual(admin.j.route && admin.j.route.id, 'r-other', 'admin mode keeps company-wide reach');
  });
  console.log(`\nsr-routes-api: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();

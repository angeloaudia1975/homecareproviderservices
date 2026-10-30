/* Route planner (map.html) — saved-route handling (browser regression suite; 2026-10-30 audit).

   · Saving a route did not tell the browser's draft its id → leaving for Dealer 360 and saving again
     created a second copy of the route.
   · Deleting the open route left the planner pointing at the deleted id.
   · Opening a route with no start point (cleared when it was assigned to a rep with no default) and
     re-saving it wrote the planner's own home address back in; opening any route also replaced the
     planner's personal home base in this browser.
   · A stop left on the page's "default visit" was saved blank and the field app then timed it at 30.
   · Logging a visit twice (double tap / Save again) created the visit, note, tasks and deals twice.
   Real page + real routes-api, fake database, synthetic data. Leaflet is served from node_modules
   (npm i --no-save leaflet@1.9.4 leaflet.markercluster@1.5.3, or SR_LEAFLET_DIR).
   Run: node test/sr-planner.qa.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./sr-harness');
if (!H.chromium) { console.log('SKIP: Playwright is not installed here.'); process.exit(process.env.CI ? 1 : 0); }
function nm(pkg) {
  const dirs = [process.env.SR_LEAFLET_DIR, path.join(__dirname, '..', 'node_modules')].filter(Boolean);
  for (const d of dirs) { const p = path.join(d, pkg); if (fs.existsSync(p)) return p; }
  try { return path.dirname(require.resolve(pkg + '/package.json')); } catch (e) { return null; }
}
const LEAF = nm('leaflet'), CLUS = nm('leaflet.markercluster');
if (!LEAF || !CLUS) { console.log('SKIP: leaflet / leaflet.markercluster not installed (npm i --no-save leaflet@1.9.4 leaflet.markercluster@1.5.3).'); process.exit(process.env.CI ? 1 : 0); }
const R = H.runner();

(async () => {
  const browser = await H.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = H.world({ rep_routes: [
    { id: 'r-nohome', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', assigned_to_email: 'greg@hcps.us', assigned_to_rep: 'Greg Campbell', name: 'Assigned, no start',
      scheduled_date: '2026-11-10', round_trip: true, home_base: null, stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY', lat: 36.99, lng: -85.91, visit_min: 40 }] },
  ] });
  const { srv, port, calls } = await H.serve(w);
  const B = `http://127.0.0.1:${port}`;
  const ctx = await H.ctxFor(browser, 'pres', H.DESKTOP);
  await ctx.route(/cdnjs\.cloudflare\.com\/.*\/(leaflet\.markercluster|MarkerCluster)/, r => { const f = path.basename(new URL(r.request().url()).pathname); r.fulfill({ path: path.join(CLUS, 'dist', f.replace('.min.', '.')) }); });
  await ctx.route(/cdnjs\.cloudflare\.com\/.*\/leaflet\/1\.9\.4\//, r => { const f = new URL(r.request().url()).pathname.split('/leaflet/1.9.4/')[1]; r.fulfill({ path: path.join(LEAF, 'dist', f.replace(/^leaflet\.min\./, 'leaflet.')) }); });
  await ctx.route(/tile\.openstreetmap|basemaps|tiles/, r => r.fulfill({ status: 204, body: '' }));
  const HOME = { q: '1003 Wilkinson Pl, Cottontown, TN 37048', lat: 36.51, lng: -86.64, short: 'Cottontown, TN', state: 'TN' };
  await ctx.addInitScript(h => { try { if (!localStorage.getItem('hcps_home_base')) localStorage.setItem('hcps_home_base', h); } catch (e) {} }, JSON.stringify(HOME));
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept());
  const saved = id => w.db.rep_routes.find(r => r.id === id);

  await R.step('planner boots with the local Leaflet', async () => {
    await p.goto(`${B}/admin/map.html`); await p.waitForFunction(() => typeof loadSaved === 'function' && typeof L !== 'undefined');
    await p.waitForTimeout(500);
  });
  await R.step('opening a route with no start point and re-saving keeps it without one (the planner home is not written in)', async () => {
    await p.evaluate(() => loadSaved('r-nohome')); await p.waitForTimeout(400);
    assert.strictEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('hcps_home_base')).q), HOME.q, 'personal home base changed');
    await p.evaluate(async () => { if (!document.getElementById('rname')) { const d = document.createElement('div'); d.innerHTML = '<input id="rname"><input id="rdate"><div id="rerr"></div>'; document.body.appendChild(d); }
      document.getElementById('rname').value = 'Assigned, no start'; await saveRouteGo(); });
    const r = saved('r-nohome');
    assert.strictEqual(r.home_base, null, 'the planner home was written into the rep route: ' + JSON.stringify(r.home_base));
    assert.strictEqual(r.round_trip, true);
    assert.strictEqual(r.assigned_to_email, 'greg@hcps.us', 'the assignment was dropped');
    assert.strictEqual(r.owner_email, 'angelo@hcps.us');
    assert.strictEqual(r.stops[0].visit_min, 40);
  });
  await R.step('a new route: Save stamps the default visit length and teaches the draft its id — saving again updates, never duplicates', async () => {
    await p.evaluate(() => { clearRoute(); const vm = document.getElementById('visitMin'); if (!vm) throw new Error('no visitMin: ' + document.body.innerHTML.slice(0, 300)); vm.value = '45';
      ROUTE = [{ _i: 'x1', dealer_id: 'd-ang', name: 'Retail Medical Solutions', city: 'Lawrenceburg', state: 'TN', lat: 35.24, lng: -87.33 },
               { _i: 'x2', dealer_id: 'd-greg', name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY', lat: 36.99, lng: -85.91, visit_min: 20 }];
      renderRoute(); });
    const before = w.db.rep_routes.length;
    await p.evaluate(async () => { document.getElementById('rname').value = 'New loop'; await saveRouteGo(); });
    assert.strictEqual(w.db.rep_routes.length, before + 1);
    const nr = w.db.rep_routes[w.db.rep_routes.length - 1];
    assert.deepStrictEqual(nr.stops.map(s => s.visit_min), [45, 20], 'default visit not stamped');
    const draftId = await p.evaluate(() => { const k = Object.keys(localStorage).find(k => /draft/i.test(k) && /route/i.test(k)); return k ? JSON.parse(localStorage.getItem(k)).route_id : 'no-draft-key'; });
    assert.strictEqual(draftId, nr.id, 'the browser draft does not know the saved id');
    await p.reload(); await p.waitForFunction(() => typeof saveRouteGo === 'function'); await p.waitForTimeout(500);
    await p.evaluate(async () => { if (!document.getElementById('rname')) { const d = document.createElement('div'); d.innerHTML = '<input id="rname"><input id="rdate"><div id="rerr"></div>'; document.body.appendChild(d); }
      document.getElementById('rname').value = 'New loop'; await saveRouteGo(); });
    assert.strictEqual(w.db.rep_routes.length, before + 1, 'saving after a reload created a duplicate route');
  });
  await R.step('deleting the open route: the next Save makes a new route instead of failing', async () => {
    const id = await p.evaluate(() => CURRENT_ROUTE_ID);
    await p.evaluate(id => delSaved(id, 'New loop'), id); await p.waitForTimeout(300);
    assert.strictEqual(await p.evaluate(() => CURRENT_ROUTE_ID), null);
    assert.ok(!saved(id), 'not deleted');
  });
  await R.step('logging a visit: a double tap and a repeat Save of the same notes send ONE save', async () => {
    await p.evaluate(() => { window._vnDealer = 'd-greg'; window.collectVisitDetails = () => ({ summary: 'Met Bryant', purpose: 'check-in' }); });
    const n0 = calls.filter(c => c.body && c.body.action === 'save_visit').length;
    await p.evaluate(async () => { await Promise.all([saveVisit(), saveVisit()]); await saveVisit(); });
    assert.strictEqual(calls.filter(c => c.body && c.body.action === 'save_visit').length - n0, 1);
  });
  await R.step('no page errors', async () => assert.deepStrictEqual(errors.filter(e => !/tile|openstreetmap/i.test(e)), []));
  srv.close(); await browser.close();
  R.done('sr-planner');
})();

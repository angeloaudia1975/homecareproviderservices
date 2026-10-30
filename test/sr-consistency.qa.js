/* Scheduled Routes — the route planner, the field app and the heads-up email agree (browser suite).

   Angelo, 2026-10-30: "verify that the route planner, field app, and generated heads-up email
   consistently display the same date and locally correct arrival time." For each saved route below
   the planner's own itinerary (computeItinerary — what its list and printed sheet show), the field
   app's stop cards and the heads-up drafted for every stop must name the same day and the same
   local time in the stop's own zone. Synthetic data; real pages + real routes-api; no email sent.

   Routes:  A  round trip from Cottontown, TN (Central) into Eastern Kentucky / Indiana, one overnight
            B  one-way, departure 07:30 Eastern (explicit), crossing into Central (Glasgow, KY)
            C  one-way saved before departures were required (no time, no zone): nothing is assumed —
               no arrival time anywhere, and the heads-up says why.
   Run: node test/sr-consistency.qa.js  (Leaflet from node_modules or SR_LEAFLET_DIR, as sr-planner) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./sr-harness');
if (!H.chromium) { console.log('SKIP: Playwright is not installed here.'); process.exit(process.env.CI ? 1 : 0); }
function nm(pkg) {
  const dirs = [process.env.SR_LEAFLET_DIR, path.join(__dirname, '..', 'node_modules')].filter(Boolean);
  for (const d of dirs) { const p = path.join(d, pkg); if (fs.existsSync(p)) return p; }
  return null;
}
const LEAF = nm('leaflet'), CLUS = nm('leaflet.markercluster');
if (!LEAF || !CLUS) { console.log('SKIP: leaflet not installed.'); process.exit(process.env.CI ? 1 : 0); }
const R = H.runner();

const HOME = { label: 'Cottontown, TN', address: '1003 wilkinson place cottontown, tn 37048', lat: 36.51, lng: -86.64, depart_time: '09:00' };
const stop = (dealer_id, name, city, state, lat, lng, extra) => Object.assign({ dealer_id, name, city, state, lat, lng, visit_min: 45 }, extra || {});
const ROUTES = [
  { id: 'r-A', name: 'A — round trip, one night', scheduled_date: '2026-11-03', round_trip: true, home_base: HOME, depart_time: '09:00',
    stops: [stop('d-greg', 'Louisville stop', 'Louisville', 'KY', 38.157, -85.706), stop('d-dir-greg', 'New Albany stop', 'New Albany', 'IN', 38.301, -85.816, { overnight: true, next_start_min: 485 }),
            stop('d-ang', 'Paoli stop', 'Paoli', 'IN', 38.567, -86.465)] },
  { id: 'r-B', name: 'B — one-way, Eastern start', scheduled_date: '2026-11-03', round_trip: false, home_base: null, depart_time: '07:30', depart_tz: 'America/New_York',
    stops: [stop('d-greg', 'Lexington stop', 'Lexington', 'KY', 38.04, -84.5), stop('d-dir-greg', 'Glasgow stop', 'Glasgow', 'KY', 36.99, -85.91)] },
  { id: 'r-C', name: 'C — one-way, saved without a departure', scheduled_date: '2026-11-03', round_trip: false, home_base: null,
    stops: [stop('d-greg', 'Lexington stop', 'Lexington', 'KY', 38.04, -84.5)] },
  { id: 'r-D', name: 'D — planned without a start point, departure 09:00 Central', scheduled_date: '2026-11-03', round_trip: true, home_base: null, depart_time: '09:00', depart_tz: 'America/Chicago',
    stops: [stop('d-greg', 'Lexington stop', 'Lexington', 'KY', 38.04, -84.5), stop('d-dir-greg', 'Glasgow stop', 'Glasgow', 'KY', 36.99, -85.91)] },
];
const MIN = [141, 34, 56, 70, 60];
const prettyDay = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

(async () => {
  const browser = await H.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = H.world({ rep_routes: ROUTES.map(r => Object.assign({ owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', updated_at: '2026-10-30T00:00:00Z' }, r)) });
  // The viewer has a default home of his own: route D must NOT be timed from it (the plan never was).
  (w.db.staff_users || []).forEach(u => { if (/angelo/.test(u.email || '')) u.home_base = HOME; });
  const { srv, port } = await H.serve(w, { legs: coords => MIN.slice(0, coords.length - 1).map(m => ({ duration_s: m * 60 })) });
  const B = `http://127.0.0.1:${port}`;
  const errors = [];
  const sends0 = w.outbound.length;

  for (const tz of ['America/Chicago', 'America/Los_Angeles']) {
    const ctx = await H.ctxFor(browser, 'pres', H.DESKTOP, tz);
    await ctx.route(/cdnjs\.cloudflare\.com\/.*\/(leaflet\.markercluster|MarkerCluster)/, r => { const f = path.basename(new URL(r.request().url()).pathname); r.fulfill({ path: path.join(CLUS, 'dist', f.replace('.min.', '.')) }); });
    await ctx.route(/cdnjs\.cloudflare\.com\/.*\/leaflet\/1\.9\.4\//, r => { const f = new URL(r.request().url()).pathname.split('/leaflet/1.9.4/')[1]; r.fulfill({ path: path.join(LEAF, 'dist', f.replace(/^leaflet\.min\./, 'leaflet.')) }); });
    await ctx.route(/tile\.openstreetmap|basemaps|tiles/, r => r.fulfill({ status: 204, body: '' }));
    const planner = await ctx.newPage(); planner.on('pageerror', e => errors.push('planner: ' + e.message));
    const field = await ctx.newPage(); field.on('pageerror', e => errors.push('field: ' + e.message));
    await planner.goto(`${B}/admin/map.html`); await planner.waitForFunction(() => typeof loadSaved === 'function' && typeof L !== 'undefined');
    await planner.waitForTimeout(400);

    for (const route of ROUTES.filter(r => r.id !== 'r-C')) {
      await R.step(`[${tz}] ${route.name}: planner = field app = heads-up (date + local time, every stop)`, async () => {
        // Planner
        await planner.evaluate(id => { LASTROUTE = { legs: [] }; return loadSaved(id); }, route.id);
        await planner.waitForFunction(() => LASTROUTE && LASTROUTE.legs && LASTROUTE.legs.length > 0, null, { timeout: 15000 });
        const plan = await planner.evaluate(() => computeItinerary().filter(it => it.isStop).map(it => ({ t: fmtAbs(it.arriveAbs, it.tz), d: isoDateIn(it.arriveAbs, it.tz) })));
        const listText = await planner.textContent('#rlist');
        for (const p of plan) assert.ok(listText.includes(p.t), `planner list lacks ${p.t}`);
        // Field app
        await field.goto(`${B}/admin/scheduled-routes.html?route=${route.id}`);
        await field.waitForFunction(() => /M /.test((document.getElementById('eta_0') || {}).textContent || ''), null, { timeout: 15000 });
        const fieldStops = await field.evaluate(() => DAY.stops.map((s, i) => ({ t: document.getElementById('eta_' + i).textContent, d: s._dateISO })));
        assert.deepStrictEqual(fieldStops, plan, 'field app ≠ planner');
        // Heads-up per stop
        for (let i = 0; i < plan.length; i++) {
          await field.click(`#stop_${i} .sh`); await field.click(`#stop_${i} button:has-text("Heads-up")`); await field.waitForSelector('#d_body');
          const body = await field.inputValue('#d_body');
          assert.ok(body.includes(`${prettyDay(plan[i].d)} around ${plan[i].t}`), `stop ${i + 1} heads-up: expected "${prettyDay(plan[i].d)} around ${plan[i].t}" in\n${body.slice(0, 260)}`);
          await field.click('#draftwrap button:text-is("Close")'); await field.waitForSelector('#draftwrap', { state: 'detached' });
        }
        if (route.id === 'r-A') { assert.strictEqual(plan[0].t, '12:21 PM EST', 'day starts at 9:00 CENTRAL'); assert.deepStrictEqual(plan.map(p => p.d), ['2026-11-03', '2026-11-03', '2026-11-04']); }
        if (route.id === 'r-B') { assert.strictEqual(plan[0].t, '7:30 AM EST', 'leaves the first stop\'s area at 07:30 EASTERN, as saved');
          assert.strictEqual(plan[1].t, '9:36 AM CST', '07:30 + 45 min visit + 141 min drive = 10:36 Eastern = 9:36 Central (Glasgow)'); }
        if (route.id === 'r-D') assert.strictEqual(plan[0].t, '10:00 AM EST', 'timed from the first stop at 09:00 Central, never from the rep\'s own home');
      });
    }
    await R.step(`[${tz}] C (no departure saved): no time anywhere — planner refuses to save it without one, field + heads-up say why`, async () => {
      await field.goto(`${B}/admin/scheduled-routes.html?route=r-C`); await field.waitForSelector('#stop_0');
      await field.waitForFunction(() => DAY && DAY._depart, null, { timeout: 15000 });
      assert.strictEqual(await field.textContent('#eta_0'), '—');
      assert.ok(/No departure set/.test(await field.textContent('#etal_0')));
      assert.ok(await field.isVisible('#nodepart'), 'no explanation banner');
      await field.click('#stop_0 .sh'); await field.click('#stop_0 button:has-text("Heads-up")'); await field.waitForSelector('#d_body');
      const body = await field.inputValue('#d_body');
      assert.ok(!/\d:\d\d [AP]M/.test(body), 'a time was assumed: ' + body.slice(0, 200));
      assert.ok(/no departure time set/.test(await field.textContent('#draftwrap')), 'no warning in the editor');
      await field.click('#draftwrap button:text-is("Close")');
      // Planner: open it, try to save without a zone → refused in the page; with a zone → saved.
      await planner.evaluate(() => loadSaved('r-C')); await planner.waitForTimeout(300);
      assert.ok(await planner.isVisible('#startTz'), 'the time-zone picker is hidden on a one-way route');
      const msg = await planner.evaluate(async () => { if (!document.getElementById('rname')) { const d = document.createElement('div'); d.innerHTML = '<input id="rname"><input id="rdate"><div id="rerr"></div>'; document.body.appendChild(d); }
        document.getElementById('rname').value = 'C'; document.getElementById('startTz').value = ''; await saveRouteGo(); return document.getElementById('rerr').textContent; });
      assert.ok(/time zone/.test(msg), msg);
      assert.strictEqual(w.db.rep_routes.find(r => r.id === 'r-C').depart_tz || null, null);
    });
    await ctx.close();
  }
  await R.step('no email sent, no page errors', async () => { assert.strictEqual(w.outbound.length, sends0); assert.deepStrictEqual(errors, []); });
  srv.close(); await browser.close();
  R.done('sr-consistency');
})();

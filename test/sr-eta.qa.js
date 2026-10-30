/* Scheduled Routes — arrival times on the phone and in the heads-up (browser regression suite).

   Synthetic copy of the live "Darrell Travel" shape (3 days, home base Cottontown, TN — Central —
   9:00 departure, first stop Louisville — Eastern; drive minutes as OpenRouteService returned them).
   Real page, real routes-api handler, fake database; directions answered by the harness. No email
   leaves. Runs in two browser zones to prove the phone's own zone changes nothing.
   Run: node test/sr-eta.qa.js */
const assert = require('assert');
const H = require('./sr-harness');
if (!H.chromium) { console.log('SKIP: Playwright is not installed here.'); process.exit(process.env.CI ? 1 : 0); }
const R = H.runner();

const MIN = [141, 15, 18, 34, 56, 36, 32, 62, 3, 55, 44, 44, 14, 43, 18, 160];
const CITY = [['Louisville', 'KY', 38.157, -85.706, null], ['Louisville', 'KY', 38.153, -85.589, 45], ['Louisville', 'KY', 38.247, -85.528, 45], ['New Albany', 'IN', 38.301, -85.816, 45, 1],
  ['Paoli', 'IN', 38.567, -86.465, 45], ['Bedford', 'IN', 38.861, -86.487, 45], ['Bloomington', 'IN', 39.165, -86.53, 45], ['Columbus', 'IN', 39.201, -85.92, 45], ['Columbus', 'IN', 39.2, -85.88, 45, 1],
  ['Batesville', 'IN', 39.3, -85.21, 60], ['Lawrenceburg', 'IN', 39.09, -84.87, 45], ['Cincinnati', 'OH', 39.1, -84.38, 60], ['Cincinnati', 'OH', 39.15, -84.42, 60], ['Wilder', 'KY', 39.05, -84.48, null], ['Florence', 'KY', 39.0, -84.65, null]];
const stops = night => CITY.map(([city, state, lat, lng, vm, on], i) => ({ dealer_id: 'd-greg', name: 'Synthetic stop ' + (i + 1), city, state, lat, lng, visit_min: vm,
  overnight: night ? !!on : false, next_start_min: night && on ? 485 : null }));
const HOME = { label: '1003 wilkinson place cottontown, tn 37048', address: '1003 wilkinson place cottontown, tn 37048', lat: 36.51, lng: -86.64, depart_time: '09:00' };

(async () => {
  const browser = await H.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = H.world({ rep_routes: [
    { id: 'r-3day', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'Synthetic 3-day loop', scheduled_date: '2026-11-03', round_trip: true, home_base: HOME, stops: stops(true) },
    { id: 'r-nonight', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'Synthetic loop, overnights missing', scheduled_date: '2026-11-03', round_trip: true, home_base: HOME, stops: stops(false) },
  ] });
  const { srv, port } = await H.serve(w, { legs: coords => MIN.slice(0, coords.length - 1).map(m => ({ duration_s: m * 60 })) });
  const B = `http://127.0.0.1:${port}`;
  const errors = [];
  const sends0 = w.outbound.length;

  for (const tz of ['America/Chicago', 'America/Los_Angeles']) {
    const ctx = await H.ctxFor(browser, 'greg', H.PHONE, tz); const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    const eta = i => p.textContent('#eta_' + i);
    await R.step(`[${tz}] 3-day route: stop 1 is 12:21 PM EST on day 1 (was 11:21 AM — start read in the wrong zone)`, async () => {
      await p.goto(`${B}/admin/scheduled-routes.html?route=r-3day`);
      await p.waitForFunction(() => /M /.test((document.getElementById('eta_0') || {}).textContent || ''));
      assert.strictEqual(await eta(0), '12:21 PM EST');
      assert.strictEqual(await p.textContent('#etal_0'), 'ETA · Day 1');
      assert.strictEqual(await p.textContent('#etal_9'), 'ETA · Day 3');
      const all = await p.$$eval('[id^=etal_]', xs => xs.map(x => x.textContent));
      assert.ok(all.every(x => !/after hours/.test(x)), 'a correctly planned route is flagged: ' + all);
    });
    await R.step(`[${tz}] heads-up for stop 1 carries the stop's own date and 12:21 PM EST`, async () => {
      await p.click('#stop_0 .sh'); await p.click('#stop_0 button:has-text("Heads-up")'); await p.waitForSelector('#d_body');
      const body = await p.inputValue('#d_body');
      assert.ok(/November 3 around 12:21 PM EST/.test(body), body.slice(0, 220));
      await p.click('#draftwrap button:text-is("Close")');
    });
    await R.step(`[${tz}] heads-up for a day-3 stop says November 5, not the route's start date`, async () => {
      await p.click('#stop_9 .sh'); await p.click('#stop_9 button:has-text("Heads-up")'); await p.waitForSelector('#d_body');
      const body = await p.inputValue('#d_body');
      assert.ok(/November 5 around 9:/.test(body), body.slice(0, 220));
      await p.click('#draftwrap button:text-is("Close")');
    });
    await R.step(`[${tz}] the ETAs survive a card re-render (closing a review used to blank them)`, async () => {
      await p.evaluate(() => renderDay());
      assert.strictEqual(await eta(0), '12:21 PM EST');
    });
    await R.step(`[${tz}] overnights missing: late stops flagged on the card, banner shown`, async () => {
      await p.goto(`${B}/admin/scheduled-routes.html?route=r-nonight`);
      await p.waitForFunction(() => /M /.test((document.getElementById('eta_11') || {}).textContent || ''));
      assert.ok(/AM EST/.test(await eta(11)), await eta(11));
      assert.ok(/after hours/.test(await p.textContent('#etal_11')));
      assert.ok(!/after hours/.test(await p.textContent('#etal_0')));
      assert.ok(/outside business hours/.test(await p.textContent('#app')), 'no route banner');
    });
    await R.step(`[${tz}] overnights missing: the heads-up leaves the 3 AM time out and says why`, async () => {
      await p.click('#stop_11 .sh'); await p.click('#stop_11 button:has-text("Heads-up")'); await p.waitForSelector('#d_body');
      const body = await p.inputValue('#d_body');
      assert.ok(!/\d:\d\d [AP]M/.test(body), 'a clock time reached the email: ' + body.slice(0, 220));
      assert.ok(/outside business hours/.test(await p.textContent('#draftwrap')), 'no warning shown');
      await p.click('#draftwrap button:text-is("Close")');
    });
    await R.step(`[${tz}] calendar export writes UTC instants (Z), and the summary uses each stop's zone`, async () => {
      const r = await p.evaluate(() => icsStamp(Date.UTC(2026, 10, 3, 17, 21)));
      assert.strictEqual(r, '20261103T172100Z');
    });
    await ctx.close();
  }
  await R.step('server: previsit_draft refuses an after-hours time from any caller', async () => {
    const mod = require('./phase0-mock').load('routes-api.js', w, {});
    const res = await mod.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer greg' }, body: JSON.stringify({ action: 'previsit_draft', dealer_id: 'd-greg', date: '2026-11-03', eta: '1:21 AM EST' }) });
    const j = JSON.parse(res.body);
    assert.ok(j.ok && !/1:21/.test(j.body) && /outside business hours/.test((j.warnings || []).join(' ')), res.body.slice(0, 300));
    const ok = JSON.parse((await mod.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer greg' }, body: JSON.stringify({ action: 'previsit_draft', dealer_id: 'd-greg', date: '2026-11-03', eta: '12:21 PM EST' }) })).body);
    assert.ok(/around 12:21 PM EST/.test(ok.body) && ok.warnings.length === 0);
  });
  await R.step('no email sent, no page errors', async () => { assert.strictEqual(w.outbound.length, sends0); assert.deepStrictEqual(errors, []); });
  srv.close(); await browser.close();
  R.done('sr-eta (browser)');
})();

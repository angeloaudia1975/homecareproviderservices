/* Scheduled Routes — the locked stop in the field app (browser; security fix 2026-10-30). Real page + real routes-api,
   fake database, synthetic data. A rep's own route that still holds another rep's dealer (saved before the fix) shows
   that stop as "not in your book": name, address and Navigate only — no contact, phone, Call, Heads-up, Start visit,
   visit package or Dealer 360 — on phone and desktop; his own stop is unchanged; a President ride-along is not locked.
   Run: node test/sr-access.qa.js */
const assert = require('assert');
const H = require('./sr-harness');
if (!H.chromium) { console.log('SKIP: Playwright is not installed here.'); process.exit(process.env.CI ? 1 : 0); }
const R = H.runner();
const TODAY = H.dayStr(0);

(async () => {
  const browser = await H.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = H.world({
    rep_routes: [
      { id: 'r-self', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'Greg own loop', scheduled_date: TODAY, assigned_to_email: 'greg@hcps.us', assigned_by: 'greg@hcps.us',
        round_trip: true, home_base: { lat: 36.99, lng: -85.91, label: 'Glasgow' }, depart_time: '09:00',
        stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY', lat: 37, lng: -85.9 },
                { dealer_id: 'd-ang', name: 'Retail Medical Solutions', address: '1 Main St', city: 'Nashville', state: 'TN', lat: 36.16, lng: -86.78 }] },
      { id: 'r-ride', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'Ride-along', scheduled_date: H.dayStr(1), assigned_to_email: 'lori-not@hcps.us',
        round_trip: true, home_base: { lat: 36.99, lng: -85.91 }, depart_time: '09:00', stops: [{ dealer_id: 'd-ang', name: 'Retail Medical Solutions', state: 'TN', lat: 36.16, lng: -86.78 }] },
    ],
    dealer_contacts: [{ id: 'c-bryant', dealer_id: 'd-greg', name: 'Bryant Smith', email: 'bryant@glasgow.test', phone: '270-111' },
                      { id: 'c-rita', dealer_id: 'd-ang', name: 'Rita Example', email: 'rita@rms.test', phone: '615-555-0101' }],
  });
  const { srv, port } = await H.serve(w);
  const B = `http://127.0.0.1:${port}`;
  try {
    for (const [label, dev] of [['phone', H.PHONE], ['desktop', H.DESKTOP]]) {
      await R.step(`${label}: the other rep's stop is locked — name, address, Navigate only; nothing of the dealer on the page`, async () => {
        const ctx = await H.ctxFor(browser, 'greg', dev); const p = await ctx.newPage();
        const errors = []; p.on('pageerror', e => errors.push(e.message));
        await p.goto(`${B}/admin/scheduled-routes.html?route=r-self`); await p.waitForSelector('#stop_1');
        const card = await p.textContent('#stop_1');
        assert.ok(/not in your book/.test(card) && /Retail Medical Solutions/.test(card) && /Nashville/.test(card), card);
        for (const b of ['Start visit', 'Heads-up', 'Call', 'Visit package', 'Dealer 360']) assert.strictEqual(await p.locator(`#stop_1 :text("${b}")`).count(), 0, b + ' shown on a locked stop');
        assert.strictEqual(await p.locator('#stop_1 a:has-text("Navigate")').count(), 1);
        const html = await p.content();
        assert.ok(!/rita@rms\.test|615-555-0101|Rita Example/.test(html), 'the dealer\'s contact reached the page');
        const own = await p.textContent('#stop_0');
        assert.ok(/Bryant Smith/.test(own) && /Start visit/.test(own), 'his own stop changed: ' + own);
        assert.deepStrictEqual(errors, []);
        await ctx.close();
      });
    }
  } finally { await browser.close(); srv.close(); }
  R.done('sr-access (browser)');
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

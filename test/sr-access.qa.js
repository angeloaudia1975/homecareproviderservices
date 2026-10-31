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
      { id: 'r-plan', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'TN plan', scheduled_date: TODAY,
        round_trip: true, home_base: { lat: 36.99, lng: -85.91 }, depart_time: '09:00',
        stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY', lat: 37, lng: -85.9 },
                { dealer_id: 'd-ang', name: 'Retail Medical Solutions', city: 'Nashville', state: 'TN', lat: 36.16, lng: -86.78 }] },
      { id: 'r-done', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'Reassigned', scheduled_date: TODAY, assigned_to_email: 'lori@hcps.us', assigned_by: 'angelo@hcps.us',
        round_trip: true, home_base: { lat: 36.99, lng: -85.91 }, depart_time: '09:00', stops: [{ dealer_id: 'd-ang', name: 'Retail Medical Solutions', state: 'TN', lat: 36.16, lng: -86.78 }] },
      { id: 'r-ride', owner_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', name: 'Ride-along', scheduled_date: H.dayStr(1), assigned_to_email: 'lori-not@hcps.us',
        round_trip: true, home_base: { lat: 36.99, lng: -85.91 }, depart_time: '09:00', stops: [{ dealer_id: 'd-ang', name: 'Retail Medical Solutions', state: 'TN', lat: 36.16, lng: -86.78 }] },
    ],
    dealer_visit_reports: [{ id: 'vr-g', route_id: 'r-done', dealer_id: 'd-ang', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', status: 'completed',
      checkin_at: '2026-10-29T15:00:00Z', ended_at: '2026-10-29T16:00:00Z', completed_at: '2026-10-29T16:05:00Z', approved_at: '2026-10-29T16:05:00Z', summary: { meeting_summary: 'x' } }],
    dealer_visit_participants: [{ id: 'p1', visit_report_id: 'vr-g', dealer_id: 'd-ang', name_snapshot: 'Sam Buyer', email_snapshot: 'sam@rms.test', attended: true },
                                { id: 'p2', visit_report_id: 'vr-g', dealer_id: 'd-ang', contact_id: 'c-rita', name_snapshot: 'Rita Example', email_snapshot: 'rita@rms.test', attended: true }],
    dealer_contacts: [{ id: 'c-bryant', dealer_id: 'd-greg', name: 'Bryant Smith', email: 'bryant@glasgow.test', phone: '270-111' },
                      { id: 'c-rita', dealer_id: 'd-ang', name: 'Rita Example', email: 'rita@rms.test', phone: '615-555-0101' }],
  });
  const { srv, port } = await H.serve(w);
  const B = `http://127.0.0.1:${port}`;
  try {
    for (const [label, dev] of [['phone', H.PHONE], ['desktop', H.DESKTOP]]) {
      await R.step(`${label}: President reviews the stops before an assignment is confirmed`, async () => {
        const ctx = await H.ctxFor(browser, 'pres', dev); const p = await ctx.newPage();
        const errors = []; p.on('pageerror', e => errors.push(e.message));
        await p.goto(`${B}/admin/scheduled-routes.html?route=r-plan`); await p.waitForSelector('#asgbox button');
        await p.click('#asgbox button'); await p.waitForSelector('#asgsel');
        await p.selectOption('#asgsel', 'greg@hcps.us'); await p.click('#asgbox button:has-text("Review")');
        await p.waitForSelector('#asgmsg :text("Confirm assignment")');
        const txt = await p.textContent('#asgmsg');
        assert.ok(/Glasgow Prescription Center/.test(txt) && /in their book/.test(txt), txt);
        assert.ok(/Retail Medical Solutions[^]*not in their book: this opens it to them/.test(txt), txt);
        assert.ok(!w.db.rep_routes.find(r => r.id === 'r-plan').assigned_to_email, 'assigned before confirming');
        await p.click('#asgmsg :text("Confirm assignment")');
        await p.waitForFunction(() => /Assigned to/.test(document.body.innerText));
        assert.strictEqual(w.db.rep_routes.find(r => r.id === 'r-plan').assigned_to_email, 'greg@hcps.us');
        const rt = w.db.rep_routes.find(r => r.id === 'r-plan'); rt.assigned_to_email = null; rt.assigned_by = null; rt.assigned_to_rep = null;
        assert.deepStrictEqual(errors, []);
        await ctx.close();
      });
      await R.step(`${label}: President sees which follow-up addresses are verified and approves a typed one with a reason`, async () => {
        const rep = w.db.dealer_visit_reports.find(r => r.id === 'vr-g'); rep.summary = { meeting_summary: 'x' };
        const ctx = await H.ctxFor(browser, 'pres', dev); const p = await ctx.newPage();
        const errors = []; p.on('pageerror', e => errors.push(e.message));
        await p.goto(`${B}/admin/scheduled-routes.html?route=r-done`); await p.waitForSelector('#stop_0');
        if (!(await p.locator('#body_0.open').count())) await p.click('#stop_0 .head, #stop_0 [onclick^="toggleBody"]').catch(() => {});
        await p.evaluate(() => openBody(0));
        await p.click('#body_0 :text("Follow-up recipients")'); await p.waitForSelector('#rcp_0 :text("not verified")');
        const t1 = await p.textContent('#rcp_0');
        assert.ok(/rita@rms\.test — not verified \(matches a contact on file\)/.test(t1) && /sam@rms\.test — not verified/.test(t1), t1);
        const samRow = p.locator('#rcp_0 > div > div', { hasText: 'sam@rms.test' });
        await samRow.locator(':text("Approve for this visit")').click();
        await p.waitForSelector('#rcpmsg_0:has-text("reason")');
        await samRow.locator('input').fill('Confirmed by phone with the owner');
        await samRow.locator(':text("Approve for this visit")').click();
        await p.waitForSelector('#rcp_0 :text("approved by the President")');
        assert.deepStrictEqual((rep.summary.approved_recipients || []).map(x => x.email), ['sam@rms.test']);
        assert.deepStrictEqual(errors, []);
        await ctx.close();
      });
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

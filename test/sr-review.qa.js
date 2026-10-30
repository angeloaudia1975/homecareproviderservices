/* Scheduled Routes — the visit review keeps the rep's edits, and a late AI answer never lands on
   another dealer (browser regression suite; found in the 2026-10-30 audit).

   · "Close" / "Not now — review later" threw away a rewritten summary and added follow-ups; reopening
     asked the AI again from scratch.
   · Open stop A's review, close it while "Summarizing…", open stop B: A's answer filled B's review,
     and Approve wrote A's attendees / follow-ups onto dealer B.
   Real page + real routes-api, fake database, synthetic data. Run: node test/sr-review.qa.js */
const assert = require('assert');
const H = require('./sr-harness');
if (!H.chromium) { console.log('SKIP: Playwright is not installed here.'); process.exit(process.env.CI ? 1 : 0); }
const R = H.runner();
const TODAY = H.dayStr(0);

const sug = who => ({ meeting_summary: 'AI summary for ' + who, products_discussed: [], dealer_interests: [], dealer_concerns: [], objections: [], competitors: [], pricing_requests: [],
  samples_requested: [], literature_requested: [], training_requested: [], attendees: who === 'A' ? [{ name: 'Bryant Smith', title: '' }, { name: 'Pat New', title: 'Buyer' }] : [{ name: 'Dana B', title: '' }],
  rep_commitments: [], dealer_commitments: [], follow_ups: [{ title: 'AI follow-up for ' + who, due_date: '', priority: 'normal', from: 'other' }], opportunities: [],
  suggested_next_action: { text: who === 'A' ? 'Call back Friday' : '', due_date: '' }, interest_slugs: [], poor_fit_slugs: [] });

(async () => {
  const browser = await H.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ended = (id, did) => ({ id, route_id: 'r-1', dealer_id: did, rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', status: 'in_progress',
    checkin_at: new Date(Date.now() - 3600e3).toISOString(), ended_at: new Date(Date.now() - 600e3).toISOString(), fields: { notes: 'Met them about lift chairs.' } });
  const w = H.world({
    rep_routes: [{ id: 'r-1', owner_email: 'greg@hcps.us', rep_name: 'Greg Campbell', name: 'KY loop', scheduled_date: TODAY,
      stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center', city: 'Glasgow', state: 'KY' }, { dealer_id: 'd-dir-greg', name: 'Directory Only Dealer', city: 'Bowling Green', state: 'KY' }] }],
    dealer_visit_reports: [ended('vr-a', 'd-greg'), ended('vr-b', 'd-dir-greg')],
  }, { ai: body => { const p = JSON.stringify(body); return sug(/Glasgow/.test(p) ? 'A' : 'B'); } });
  let slowA = 0;
  const MUT = { keep: { from: 'const kept=fresh?null:obRead(reviewKeyFor(i));', to: 'const kept=null;' },
    stale: { from: '  if(REV!==mine) return;\n  if(j){ REV.contacts=j.contacts||[];', to: '  if(!REV) return;\n  if(j){ REV.contacts=j.contacts||[];' } }[process.env.SR_MUTANT || ''];
  const { srv, port, calls } = await H.serve(w, { mutate: MUT ? { 'scheduled-routes.html': MUT } : null, slow: (n, b) => (n === 'routes-api' && b.action === 'visit_analyze' && b.dealer_id === 'd-greg' && slowA) ? slowA : 0 });
  const B = `http://127.0.0.1:${port}`;
  const ctx = await H.ctxFor(browser, 'greg', H.PHONE); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => { errors.push('dialog'); d.dismiss(); });
  const analyses = () => calls.filter(c => c.name === 'routes-api' && c.body.action === 'visit_analyze').length;

  await R.step('review later keeps the rewritten summary and an added follow-up; reopening does not re-ask the AI', async () => {
    await p.goto(`${B}/admin/scheduled-routes.html?route=r-1`); await p.waitForSelector('#stop_0');
    await p.click('#stop_0 button:has-text("Review summary")'); await p.waitForSelector('#rv_sum');
    assert.ok(/AI summary for A/.test(await p.inputValue('#rv_sum')));
    await p.fill('#rv_sum', 'My own summary of the Glasgow visit.');
    await p.click('#rv_body button:has-text("Add a follow-up")');
    await p.locator('#rv_fu .rv-card .rv-t').last().fill('Send the brochure');
    // the rep declines "add as a new contact" for the AI's attendee
    await p.locator('#rv_at .rv-card', { hasText: '' }).locator('.rv-new').first().uncheck();
    await p.uncheck('#rv_na_on');
    const n = analyses();
    await p.click('#rv_body button:has-text("review later")');
    await p.waitForFunction(() => !document.getElementById('rvwrap'));
    await p.click('#stop_0 button:has-text("Review summary")'); await p.waitForSelector('#rv_sum');
    assert.strictEqual(await p.inputValue('#rv_sum'), 'My own summary of the Glasgow visit.');
    const fus = await p.$$eval('#rv_fu .rv-card .rv-t', xs => xs.map(x => x.value));
    assert.ok(fus.includes('Send the brochure') && fus.includes('AI follow-up for A'), JSON.stringify(fus));
    assert.strictEqual(analyses(), n, 'reopening asked the AI again');
    assert.ok(/edits are back/.test(await p.textContent('#rv_body')));
    assert.strictEqual(await p.locator('#rv_at .rv-card .rv-new').first().isChecked(), false, '"add as contact" came back ticked');
    assert.strictEqual(await p.isChecked('#rv_na_on'), false, '"make it a task" came back ticked');
    assert.strictEqual(await p.inputValue('#rv_na'), 'Call back Friday');
  });
  await R.step('the kept review survives a reload; Approve saves the edited version and clears it', async () => {
    await p.reload(); await p.waitForSelector('#stop_0');
    await p.click('#stop_0 button:has-text("Review summary")'); await p.waitForSelector('#rv_sum');
    assert.strictEqual(await p.inputValue('#rv_sum'), 'My own summary of the Glasgow visit.');
    await p.click('#rv_body button:has-text("Approve")'); await p.waitForSelector('.rv-done', { timeout: 15000 });
    const rep = w.db.dealer_visit_reports.find(r => r.id === 'vr-a');
    assert.ok(rep.approved_at, 'not approved');
    assert.ok(w.db.dealer_tasks.some(t => t.dealer_id === 'd-greg' && t.title === 'Send the brochure'), 'the added follow-up was not created');
    assert.ok(!w.db.dealer_tasks.some(t => t.dealer_id === 'd-greg' && t.title === 'Call back Friday'), 'the unticked next action became a task');
    assert.ok(!(w.db.dealer_contacts || []).some(c => c.name === 'Pat New'), 'the declined contact was created');
    const left = await p.evaluate(() => Object.keys(localStorage).filter(k => /rev_/.test(k) && /d-greg/.test(k)).length);
    assert.strictEqual(left, 0, 'the kept review was not cleared after approval');
    await p.click('.rv-done button:has-text("Done")');
  });
  await R.step('a late AI answer for stop A never fills stop B’s review', async () => {
    // Fresh state for A: un-approve isn't possible, so use B as the slow one's victim through a reload.
    w.db.dealer_visit_reports.find(r => r.id === 'vr-a').approved_at = null;
    w.db.dealer_visit_reports.find(r => r.id === 'vr-a').completed_at = null;
    w.db.dealer_visit_reports.find(r => r.id === 'vr-a').status = 'in_progress';
    await p.evaluate(() => Object.keys(localStorage).filter(k => /rev_/.test(k)).forEach(k => localStorage.removeItem(k)));
    await p.reload(); await p.waitForSelector('#stop_0 button:has-text("Review summary")');
    slowA = 2500;
    await p.click('#stop_0 button:has-text("Review summary")'); await p.waitForSelector('#rv_body .msg');
    await p.click('#rvwrap .sheethd button:has-text("Close")');
    await p.click('#stop_1 button:has-text("Review summary")'); await p.waitForSelector('#rv_sum');
    assert.ok(/AI summary for B/.test(await p.inputValue('#rv_sum')));
    await p.waitForTimeout(3000);   // A's slow answer arrives now
    assert.ok(/AI summary for B/.test(await p.inputValue('#rv_sum')), 'stop A’s answer replaced stop B’s review');
    const at = await p.$$eval('#rv_at .rv-name', xs => xs.map(x => x.value));
    assert.deepStrictEqual(at, ['Dana B']);
    slowA = 0;
  });
  await R.step('no page errors, no dialogs, nothing emailed', async () => { assert.deepStrictEqual(errors, []); assert.strictEqual(w.outbound.filter(x => x.kind === 'graph' || x.kind === 'resend').length, 0); });
  srv.close(); await browser.close();
  R.done('sr-review' + (process.env.SR_MUTANT ? ' (MUTANT ' + process.env.SR_MUTANT + ')' : ''));
})();

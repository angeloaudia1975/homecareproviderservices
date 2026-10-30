/* Territory Lines — saves are confirmed, never assumed (server + browser regression suite).

   Found in the 2026-10-30 audit:
     · set_state deleted every line in a state and THEN inserted the new list — an insert that failed
       left the state with no lines at all.
     · the page ticked the box and updated the summary before the server answered and said nothing
       when the save failed (expired sign-in, network, server error).
     · "Clear" removed every line in a state with one tap.
   Real territory-api handler + real page, fake database. Run: node test/sr-territory.qa.js */
const assert = require('assert');
const H = require('./sr-harness');
const { load } = require('./phase0-mock');
const R = H.runner();

function world() {
  const w = H.world({ territory_lines: [{ state: 'TN', manufacturer: 'golden-technologies' }, { state: 'TN', manufacturer: 'strongback-mobility' }, { state: 'KY', manufacturer: 'golden-technologies' }],
    manufacturers: [{ slug: 'golden-technologies', name: 'Golden Technologies' }, { slug: 'strongback-mobility', name: 'Strongback Mobility' }, { slug: 'bemis', name: 'Bemis' }] });
  return w;
}
const lines = (w, st) => w.db.territory_lines.filter(r => r.state === st).map(r => r.manufacturer).sort();
async function call(w, body, who) {
  const mod = load('territory-api.js', w, {});
  const r = await mod.handler({ httpMethod: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + (who || 'pres') }, body: body ? JSON.stringify(body) : '' });
  return { status: r.statusCode, j: JSON.parse(r.body || '{}') };
}

(async () => {
  await R.step('server: set_state replaces the list (adds new, removes dropped, keeps the rest)', async () => {
    const w = world();
    const r = await call(w, { action: 'set_state', state: 'TN', manufacturers: ['golden-technologies', 'bemis'] });
    assert.ok(r.j.ok, JSON.stringify(r.j));
    assert.deepStrictEqual(lines(w, 'TN'), ['bemis', 'golden-technologies']);
    assert.deepStrictEqual(lines(w, 'KY'), ['golden-technologies'], 'another state was touched');
  });
  await R.step('server: an insert that fails no longer wipes the state', async () => {
    const S = require('./phase0-mock');
    const w2 = S.createWorld({ tokens: { pres: 'angelo@hcps.us' }, authUsers: ['angelo@hcps.us'], tables: { staff_users: [{ email: 'angelo@hcps.us', role: 'president', active: true }],
      territory_lines: [{ state: 'TN', manufacturer: 'golden-technologies' }, { state: 'TN', manufacturer: 'strongback-mobility' }], manufacturers: [{ slug: 'golden-technologies', name: 'Golden' }, { slug: 'bemis', name: 'Bemis' }, { slug: 'strongback-mobility', name: 'Strongback' }] },
      failWrite: (m, t) => (m === 'POST' && t === 'territory_lines') ? 500 : 0 });
    const r = await call(w2, { action: 'set_state', state: 'TN', manufacturers: ['bemis'] });
    assert.strictEqual(r.status, 500);
    assert.deepStrictEqual(lines(w2, 'TN'), ['golden-technologies', 'strongback-mobility'], 'the state was wiped by a failed save');
  });
  await R.step('server: Clear (empty list) removes only that state; unknown state refused; reps refused', async () => {
    const w = world();
    assert.ok((await call(w, { action: 'set_state', state: 'TN', manufacturers: [] })).j.ok);
    assert.deepStrictEqual(lines(w, 'TN'), []); assert.deepStrictEqual(lines(w, 'KY'), ['golden-technologies']);
    assert.strictEqual((await call(w, { action: 'set_state', state: 'ZZ', manufacturers: [] })).status, 400);
    assert.strictEqual((await call(w, { action: 'set_line', state: 'XX', manufacturer: 'bemis', on: true })).status, 400);
    assert.strictEqual((await call(w, { action: 'set_state', state: 'KY', manufacturers: [] }, 'greg')).status, 403);
    assert.deepStrictEqual(lines(w, 'KY'), ['golden-technologies']);
  });

  if (!H.chromium) { console.log('SKIP browser part: Playwright is not installed here.'); R.done('sr-territory'); return; }
  const browser = await H.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const w = world();
  const { srv, port } = await H.serve(w);
  const B = `http://127.0.0.1:${port}`;
  const ctx = await H.ctxFor(browser, 'pres', H.DESKTOP); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => { errors.push('dialog ' + d.message()); d.dismiss(); });
  const box = name => p.locator('.mfr', { hasText: name }).locator('input');
  await R.step('page: a failed save puts the tick back and says "Not saved"', async () => {
    await p.goto(`${B}/admin/territory.html`); await p.waitForSelector('#mfrgrid .mfr');
    await p.selectOption('#stateSel', 'TN');
    await p.route('**/territory-api', r => r.request().method() === 'POST' ? r.fulfill({ status: 500, body: '{"error":"boom"}', contentType: 'application/json' }) : r.continue());
    await box('Bemis').check();
    await p.waitForFunction(() => /Not saved/.test(document.getElementById('saved').textContent));
    assert.strictEqual(await box('Bemis').isChecked(), false, 'the tick stayed although nothing was saved');
    assert.ok(!/Bemis/.test(await p.textContent('#summary')), 'the summary claims Bemis');
    await p.unroute('**/territory-api');
  });
  await R.step('page: a good save is confirmed and stored', async () => {
    await box('Bemis').check();
    await p.waitForFunction(() => /Saved/.test(document.getElementById('saved').textContent));
    assert.deepStrictEqual(lines(w, 'TN'), ['bemis', 'golden-technologies', 'strongback-mobility']);
    assert.ok(/Bemis/.test(await p.textContent('#summary')));
  });
  await R.step('page: Clear asks first (in the page); the second tap clears', async () => {
    await p.click('button:has-text("Clear")');
    assert.deepStrictEqual(lines(w, 'TN').length, 3, 'one tap cleared the state');
    assert.ok(/Clear all 3 in TN\?/.test(await p.textContent('.row')));
    await p.click('button:has-text("Clear all 3 in TN?")');
    await p.waitForFunction(() => /Saved/.test(document.getElementById('saved').textContent));
    assert.deepStrictEqual(lines(w, 'TN'), []);
  });
  await R.step('page: no browser dialogs or page errors', async () => assert.deepStrictEqual(errors, []));
  srv.close(); await browser.close();
  R.done('sr-territory');
})();

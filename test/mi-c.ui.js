/* Phase C — the Ship-To Review page in Chromium (RULE 10). The page (src/admin/shipto-review.html + .js, unmodified)
   talks to a stand-in for shipto-review-api that runs the REAL review code (_report_rows / _shipto_review / _shipto) on
   the shared fixture and keeps corrections + mappings in memory. Proves: the queue (held report); orders needing review
   first; the panel shows what the file says and why; no location is pre-chosen for a needs-review order (never the HQ);
   a save needs a location and a reason; Save & Continue sends only the person's choice (no actor / fingerprint / ship
   key — the server derives them), revalidates and moves to the next order; no ship key → Remember disabled; outside the
   family needs a confirmation; export; mappings; shadow; no page error; no horizontal scroll and ≥44px controls at
   360 / 390 / 768 (1280 too). Needs Playwright (PLAYWRIGHT=… module path); skipped without it. */
const http = require('http'), path = require('path'), fs = require('fs');
let pw; try { pw = require(process.env.PLAYWRIGHT || 'playwright'); } catch (e) { console.log('SKIP: Playwright not installed'); process.exit(0); }
const FN = f => require(path.join(__dirname, '..', 'netlify', 'functions', f));
const RR = FN('_report_rows.js'), RV = FN('_shipto_review.js'), SH = FN('_shipto.js');
const FX = require('./fixtures/shipto-fixture.js');
const ADMIN = path.join(__dirname, '..', 'src', 'admin');
const OUT = process.env.MICUI_OUT || path.join(process.cwd(), 'mic-shots'); fs.mkdirSync(OUT, { recursive: true });
const parsed = RR.readOrderRows(FX.BYTES, 'csv');
const real = FX.DEALERS.filter(d => !d.is_test);
const matcher = SH.makeMatcher({ dealers: real, accounts: FX.ACCOUNTS, aliases: [] });
const nameOf = id => (FX.DEALERS.find(d => d.id === id) || {}).business_name || null;
let corrections = [], mappings = [];
const SRC = { id: 8, manufacturer: 'strongback-mobility', title: 'Strongback Mobility — order / sales export 2026-09', file_name: 'Angelo Sep Orders.csv', received_date: '2026-10-02', report_period_start: '2026-09-01', report_period_end: '2026-09-30', status: 'received' };
function review() {
  const rv = RV.buildReview(parsed.rows, { matcher, mappings: mappings.filter(m => !m.retired_at), corrections });
  for (const o of rv.orders) { o.dealer = o.dealer_id ? nameOf(o.dealer_id) : null;
    o.versions = corrections.filter(c => c.order_key === o.order_key).sort((a, b) => b.version - a.version).map(c => ({ ...c, dealer: nameOf(c.dealer_id) }));
    o.current_version = o.versions.length ? o.versions[0].version : 0; for (const s of o.suggestions || []) s.name = s.name || nameOf(s.dealer_id); }
  return rv;
}
const summary = rv => ({ source_id: 8, title: SRC.title, file_name: SRC.file_name, received_date: SRC.received_date, period: ['2026-09-01', '2026-09-30'], review_status: rv.status, counts: rv.counts, totals: rv.totals, needs_review_by_reason: rv.needs_review_by_reason });
const RANK = { needs_review: 0, corrected: 1, resolved: 2 };
const calls = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/.netlify/functions/shipto-review-api') {
    let body = ''; for await (const ch of req) body += ch; const b = JSON.parse(body || '{}'); calls.push(b);
    let st = 200, out;
    if (b.action === 'queue') out = { ok: true, reports: [summary(review())], held: 1 };
    else if (b.action === 'report') { const rv = review(); rv.orders.sort((x, y) => RANK[x.status] - RANK[y.status] || x.order_key.localeCompare(y.order_key, undefined, { numeric: true })); out = { ok: true, report: summary(rv), orders: rv.orders }; }
    else if (b.action === 'correct') {
      const o = review().orders.find(x => x.order_key === b.order_key);
      if (!o.candidates.some(c => c.dealer_id === b.dealer_id) && b.confirm_outside_family !== true) { st = 409; out = { error: 'outside_family', message: `${nameOf(b.dealer_id)} is not in the dealer family this account / company matched. Confirm to assign it anyway.` }; }
      else {
        const v = corrections.filter(c => c.order_key === o.order_key).length + 1;
        corrections.push({ id: 100 + corrections.length, order_key: o.order_key, version: v, order_fingerprint: o.fingerprint, scope: b.scope, dealer_id: b.dealer_id, ship_name: b.ship_name, ship_city: b.ship_city,
          ship_state: b.ship_state, ship_zip: b.ship_zip, ship_address: b.ship_address, reason: b.reason, actor: 'staff:angelo@homecareproviderservices.us', created_at: '2026-10-11T23:00:00Z' });
        let mres = 'none'; if (b.remember && o.ship_key) { mappings.push({ id: 500 + mappings.length, account_ref: SH._internal.nref(o.reported.account_ref), ship_key: o.ship_key, scope: b.scope, dealer_id: b.dealer_id, verified_by: 'staff:angelo@homecareproviderservices.us', verified_at: '2026-10-11T23:00:00Z' }); mres = 'created'; }
        const rv = review(); const nx = rv.orders.filter(x => x.status === 'needs_review').sort((x, y) => x.order_key.localeCompare(y.order_key, undefined, { numeric: true }));
        const next = nx.find(x => x.order_key.localeCompare(o.order_key, undefined, { numeric: true }) > 0) || nx[0] || null;
        out = { ok: true, saved: { version: v, mapping: mres }, report: summary(rv), next_order_key: next ? next.order_key : null };
      }
    }
    else if (b.action === 'dealer_search') out = { ok: true, dealers: real.filter(d => d.business_name.toUpperCase().includes(String(b.q).toUpperCase())).map(d => ({ dealer_id: d.id, name: d.business_name, branch: !!d.parent_id, root: d.parent_id || d.id, city: d.city, state: d.state, zip: d.zip, address: d.address })) };
    else if (b.action === 'export') out = { ok: true, file_name: 'x.csv', csv: RV.correctedCsv(parsed.headers, parsed.rows, review(), nameOf) };
    else if (b.action === 'mappings') out = { ok: true, mappings: mappings.map(m => ({ ...m, dealer: nameOf(m.dealer_id) })) };
    else if (b.action === 'retire_mapping') { const m = mappings.find(x => x.id === b.mapping_id); m.retired_at = 'now'; m.retire_reason = b.reason; out = { ok: true }; }
    else if (b.action === 'shadow') out = { ok: true, rows: 3, read_only: true, shadow: { orders: 3, same: 1, held: 1, different: 1, unmatched_history: 0, mixed_history: 0, held_reasons: { no_ship_to: 1 }, lane_disagreements: 1,
      by_lane: { sales_report: { lines: 2, orders: 2, same: 1, held: 1, different: 0, unmatched_history: 0, mixed_history: 0 }, commission: { lines: 1, orders: 1, same: 0, held: 0, different: 1, unmatched_history: 0, mixed_history: 0 },
        other: { lines: 0, orders: 0, same: 0, held: 0, different: 0, unmatched_history: 0, mixed_history: 0 } },
      lane_disagreement_list: [{ txn: '2026-07|A3', booked: { sales_report: { dealer_id: 'wja', name: 'Wilbur Brothers Jasper' }, commission: { dealer_id: 'wpr', name: 'Wilbur Brothers Princeton' } } }],
      list: [{ outcome: 'different', lane: 'commission', period: '2026-07', invoice: 'A3', key: 'commission|2026-07|A3', company: 'Wilbur Brothers Healthcare Pharmacy', ship_city: 'Jasper', ship_zip: '47546', booked_name: 'Wilbur Brothers Princeton', strict_name: 'Wilbur Brothers Jasper' },
        { outcome: 'held', lane: 'sales_report', period: '2026-07', invoice: 'A2', key: 'sales_report|2026-07|A2', company: 'Wilbur Brothers Healthcare Pharmacy', booked_name: 'Wilbur Brothers Healthcare Pharmacy', basis: 'no_ship_to' }] } };
    else { st = 400; out = { error: 'unknown_action' }; }
    res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); return;
  }
  if (u.pathname.startsWith('/.netlify/functions/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const f = path.join(ADMIN, path.basename(u.pathname));
  if (u.pathname.startsWith('/admin/') && fs.existsSync(f)) { res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : (f.endsWith('.js') ? 'text/javascript' : 'text/html') }); res.end(fs.readFileSync(f)); return; }
  res.writeHead(404); res.end('');
});
const fails = []; const check = (c, w) => { if (!c) { fails.push(w); console.log('FAIL ' + w); } else console.log('ok   ' + w); };
(async () => {
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const errors = [];
  const open = async w => {
    const page = await browser.newPage({ viewport: { width: w, height: 900 }, acceptDownloads: true });
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem('hcps_staff_token', 'walkthrough'); localStorage.setItem('hcps_staff_profile', JSON.stringify({ email: 'angelo@homecareproviderservices.us', role: 'president', name: 'Angelo' })); } catch (e) {} });
    await page.goto(base + '/admin/shipto-review.html'); await page.waitForSelector('.tabs');
    return page;
  };
  let page = await open(1280);
  await page.waitForSelector('.card2');
  check(await page.locator('.chip', { hasText: 'Held — orders need review' }).count() === 1, 'queue: the report is held');
  check(await page.locator('button', { hasText: 'Review 5 orders' }).count() === 1, 'queue: 5 orders need review');
  await page.screenshot({ path: path.join(OUT, 'queue-1280.png'), fullPage: true });
  await page.click('button:has-text("Review 5 orders")'); await page.waitForSelector('#panel');
  const firstOrd = await page.locator('.ord').first().textContent();
  check(/Needs ship-to review/.test(firstOrd), 'orders needing review come first');
  check(/Order 7200/.test(await page.locator('#panel .ttl').textContent()), 'the first order needing review is open (7200)');
  check(/Evansville/.test(await page.locator('#panel .rep').textContent()) && /Washington/.test(await page.locator('#panel .rep').textContent()), 'the panel shows the file’s ship-to AND bill-to');
  check(/matches no branch/.test(await page.locator('#panel').textContent()), 'the reason is shown in plain words');
  check(await page.locator('#panel input[name="dl"]:checked').count() === 0, 'no location is pre-chosen (never the headquarters by default)');
  check(await page.locator('#panel .opt', { hasText: 'headquarters' }).count() >= 1, 'the headquarters is offered as an option');
  await page.click('#save');
  check(/Choose the HCPS location/.test(await page.locator('.err').textContent()) && !calls.some(c => c.action === 'correct'), 'no location → nothing sent');
  await page.check('#panel .opt:has-text("Wilbur Brothers Jasper") input');
  await page.click('#save');
  check(/reason/.test(await page.locator('.err').textContent()) && !calls.some(c => c.action === 'correct'), 'no reason → nothing sent');
  await page.fill('#fs_zip', '47546'); await page.fill('#fs_city', 'Jasper'); await page.fill('#fs_reason', 'New Jasper store — confirmed with the dealer');
  check(await page.locator('#remember').isChecked(), 'Remember is on when the file has a ship-to key and the account is on record for the chosen family');
  await page.screenshot({ path: path.join(OUT, 'panel-1280.png'), fullPage: true });
  await page.click('#save'); await page.waitForFunction(() => /Saved \(version 1/.test(document.body.textContent));
  const sent = calls.filter(c => c.action === 'correct').pop();
  check(sent && !('actor' in sent) && !('order_fingerprint' in sent) && !('mapping_ship_key' in sent) && !('reported' in sent), 'Save sends only the person’s choice (actor, fingerprint, ship key derived by the server)');
  check(sent.dealer_id === 'wja' && sent.ship_zip === '47546' && sent.remember === true && sent.expected_version === 0, 'Save sends the location, the details, Remember and the version seen');
  check(/4 orders still need review/.test(await page.locator('.okm').textContent()), 'revalidated: 4 orders still need review');
  check(/Order 7201/.test(await page.locator('#panel .ttl').textContent()), 'Save & Continue moved to the next order (7201)');
  check(await page.locator('#remember').isDisabled() && /applies to this order only/.test(await page.locator('#panel').textContent()), 'no ship-to key in the file → Remember disabled, explained');
  // outside the family
  await page.fill('#dsearch', 'Boston'); await page.waitForSelector('#panel .opt:has-text("Boston Rehab")');
  await page.check('#panel .opt:has-text("Boston Rehab") input');
  check(await page.locator('#remember').isDisabled(), 'another family chosen → Remember disabled');
  await page.fill('#fs_reason', 'Ordered for the Boston affiliate'); await page.click('#save');
  await page.waitForSelector('#confout');
  check(/not in the dealer family/.test(await page.locator('.err').textContent()), 'outside the family → confirmation asked');
  await page.check('#confout'); await page.click('#save'); await page.waitForFunction(() => /3 orders still need review/.test(document.body.textContent));
  check(calls.filter(c => c.action === 'correct').pop().confirm_outside_family === true, 'the confirmation is sent');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Download corrected report")')]);
  check(!!dl, 'the corrected report downloads');
  await page.click('.tabs button:has-text("Verified mappings")'); await page.waitForSelector('table.tbl');
  check(await page.locator('table.tbl tbody tr').count() === 1 && /Wilbur Brothers Jasper/.test(await page.locator('table.tbl').textContent()), 'the remembered mapping is listed');
  await page.click('button[data-retire]'); await page.fill('input[id^="rr"]', 'store closed'); await page.click('button[id^="rg"]'); await page.waitForSelector('text=Retired');
  check(calls.some(c => c.action === 'retire_mapping' && c.reason === 'store closed'), 'retiring a mapping sends its reason');
  await page.click('.tabs button:has-text("Shadow check")'); await page.click('#shrun'); await page.waitForSelector('text=Split in history');
  const laneRows = await page.locator('table.tbl').nth(0).locator('tbody tr').count(); check(laneRows === 2, 'shadow: one row per lane with history (' + laneRows + ')');
  check(/Sales report lines/.test(await page.locator('table.tbl').nth(0).textContent()) && /Commission lines/.test(await page.locator('table.tbl').nth(0).textContent()), 'shadow: sales-report and commission lanes shown apart');
  check(/booked to different locations in different lanes/.test(await page.locator('#body').textContent()), 'shadow: a lane disagreement is shown');
  const shRows = await page.locator('table.tbl').nth(1).locator('tbody tr').count(); check(shRows === 2, 'shadow results listed (' + shRows + ')');
  check(/Commission lines/.test(await page.locator('table.tbl').nth(1).locator('tbody tr').first().textContent()), 'shadow: each listed order names its lane');
  await page.screenshot({ path: path.join(OUT, 'shadow-1280.png'), fullPage: true });
  await page.close();
  // RULE 10: phone / tablet
  for (const w of [360, 390, 768]) {
    const p = await open(w); await p.waitForSelector('.card2');
    const measure = () => p.evaluate(() => {
      const over = document.documentElement.scrollWidth - window.innerWidth;
      const small = [...document.querySelectorAll('.tabs button, button.go, #panel input:not([type=radio]):not([type=checkbox]), #panel .opt, input[type=search]')]
        .filter(el => el.offsetParent && el.getBoundingClientRect().height < 43.5).map(el => (el.textContent || el.id || el.type).trim().slice(0, 30));
      return { over, small };
    });
    let m = await measure();
    check(m.over <= 0 && (w > 760 || m.small.length === 0), `${w}px queue: no horizontal scroll (${m.over}px), controls ≥44px${m.small.length ? ' — too small: ' + m.small.join(', ') : ''}`);
    await p.click('button.go[data-open]'); await p.waitForSelector('#panel');
    m = await measure();
    check(m.over <= 0 && (w > 760 || m.small.length === 0), `${w}px review + panel: no horizontal scroll (${m.over}px), controls ≥44px${m.small.length ? ' — too small: ' + m.small.join(', ') : ''}`);
    const fs16 = await p.evaluate(() => [...document.querySelectorAll('#panel input:not([type=radio]):not([type=checkbox])')].every(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
    check(w > 760 || fs16, `${w}px: panel inputs are 16px (no iOS zoom)`);
    await p.screenshot({ path: path.join(OUT, `review-${w}.png`), fullPage: true });
    await p.close();
  }
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
  console.log(`\nmi-c-ui: ${fails.length ? 'FAILED ' + fails.length : 'all checks passed'} · screenshots in ${OUT}`);
  process.exit(fails.length ? 1 : 0);
})();

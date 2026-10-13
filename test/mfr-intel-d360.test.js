/* Dealer 360 › Manufacturer-reported intelligence (crm-api action mfr_intel): shown only from a PUBLISHED report, only for
   a printed dealer matched to exactly this HCPS dealer, never a sister branch, never review / held / unmatched rows, never
   when two printed dealers of one report land on the same HCPS dealer; and only to people who may open that Dealer 360.
     node test/mfr-intel-d360.test.js */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
const snap = (id, source_id, dealer_id, status, extra) => Object.assign({ id, source_id, manufacturer: 'strongback-mobility', report_period_start: '2026-09-01', report_period_end: '2026-09-30',
  printed_name: 'P' + id, printed_city: 'Glasgow', printed_state: 'KY', group_heading: 'Slowing down', tier: 'T2', trend: 'down', l12m_text: '$4,200', prior12_text: '$6,000', month_text: '$0',
  last_order_text: 'Jul 2026', ergosteel_text: 'not yet', floor_text: 'not known', display_status: 'not_known', match_status: status, dealer_id, match_method: 'name_city', matched_by: 'system', matched_at: '2026-10-13' }, extra || {});
const seed = (o) => standardSeed({
  dealer_tasks: [],
  mfr_sources: [{ id: 7, kind: 'dealer_report', title: 'Strongback — September 2026', file_name: 'sb.pdf', prepared_date: '2026-10-08', publication_status: 'published', published_at: '2026-10-13' },
    { id: 8, kind: 'dealer_report', title: 'Strongback — August 2026', file_name: 'sb8.pdf', publication_status: 'unpublished' },
    { id: 9, kind: 'dealer_report', title: 'Two lines one dealer', file_name: 'sb9.pdf', publication_status: 'published' }],
  mfr_dealer_snapshots: (o && o.snaps) || [
    snap(1, 7, 'd-greg', 'matched'),                    // shown
    snap(2, 8, 'd-greg', 'matched'),                    // report not published
    snap(3, 7, null, 'review', { printed_name: 'Glasgow Rx' }),
    snap(4, 9, 'd-greg', 'matched'), snap(5, 9, 'd-greg', 'matched'),   // conflicting assignment
    snap(6, 7, 'd-greg-branch', 'matched')],            // the branch's own line, never shown on the HQ
  mfr_dealer_observations: [{ id: 1, source_id: 7, snapshot_id: 1, kind: 'told_us', position_key: 'p4:y1', observed_on: '2026-09-10', text: 'Wants a demo chair', structured: {} },
    { id: 2, source_id: 7, snapshot_id: 1, kind: 'contact_person', position_key: 'p4:y2:x1', observed_on: null, text: 'Jane Doe, Buyer', structured: {} },
    { id: 3, source_id: 7, snapshot_id: 3, kind: 'told_us', position_key: 'p5:y1', observed_on: null, text: 'NOT FOR THIS DEALER', structured: {} },
    { id: 4, source_id: null, snapshot_id: null, kind: 'offer', position_key: 'p1:y1', observed_on: null, text: '5% off', structured: {} }],
});
(async () => {
  await t('President: only the published, verified, unique line for exactly this dealer, with its own observations', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    const r = await call(m, { action: 'mfr_intel', dealer_id: 'd-greg' }, { token: 'pres' });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.reports.map(x => x.id), [1]);
    assert.deepStrictEqual(r.body.reports[0].observations.map(o => o.text), ['Wants a demo chair', 'Jane Doe, Buyer']);
    assert.strictEqual(r.body.reports[0].report.title, 'Strongback — September 2026');
  });
  await t('the rep who owns the dealer sees it; a rep outside the book is refused before anything is read', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    assert.strictEqual((await call(m, { action: 'mfr_intel', dealer_id: 'd-greg' }, { token: 'greg' })).body.reports.length, 1);
    const r = await call(m, { action: 'mfr_intel', dealer_id: 'd-ang' }, { token: 'greg' }); assert.strictEqual(r.status, 403);
  });
  await t('no sign-in → refused', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    const r = await call(m, { action: 'mfr_intel', dealer_id: 'd-greg' }, {}); assert.ok(r.status === 401 || r.status === 403, String(r.status));
  });
  await t('nothing verified and published → an empty list (the card stays hidden)', async () => {
    const w = createWorld(seed({ snaps: [snap(3, 7, null, 'review')] })); const m = load('crm-api.js', w);
    assert.deepStrictEqual((await call(m, { action: 'mfr_intel', dealer_id: 'd-greg' }, { token: 'pres' })).body.reports, []);
  });
  await t('a malformed dealer id is refused', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    assert.strictEqual((await call(m, { action: 'mfr_intel', dealer_id: 'x;drop' }, { token: 'pres' })).status, 400);
  });
  done('mfr-intel-d360');
})();

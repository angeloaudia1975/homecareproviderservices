/* Phase 2E — Opportunity stage history (pipeline-api `history`) and the Conversion report (`conversion`,
   built by _conversion.js). The history rows themselves are written by the database trigger — that is
   proved in a real Postgres by test/phase2-opportunity-events.pg.test.js; here the rows are seeded as the
   trigger writes them.

   Approved rules under test:
     · the existing `opportunities` table and five stages; history is an audit layer only
     · a baseline entry is a starting point, never a move: no moves, closes, "entered Quoted" or time in
       stage are counted from it
     · win rate = won ÷ (won + lost) closed in the period; time in stage = median days for stages whose
       entry was recorded
     · possible order match: same dealer + same manufacturer + an order within 120 days after creation;
       a manufacturer that isn't certain stays unmatched; never called attribution
     · scope like the board: Greg his own deals, Lori and the President company-wide, My Sales Workspace
       Angelo's own; no commission figures
     · the Pipeline says who it is on its writes (x-hcps-source / x-hcps-actor) so the trigger can record it
     · behind the `conversion` switch: off → the board and page are exactly as before */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, load, call, standardSeed, t, done, adminSrc } = require('./phase0-mock');
const CV = load('_conversion.js', createWorld(standardSeed()));

const DAY = 86400e3, NOW = Date.now();
const ago = d => new Date(NOW - d * DAY).toISOString();
const dayAgo = d => ago(d).slice(0, 10);
const WS = { 'x-hcps-workspace': 'mine' };
const MFRS = [{ slug: 'golden-technologies', name: 'Golden Technologies' }, { slug: 'pride-mobility', name: 'Pride Mobility' }, { slug: 'golden-guardian', name: 'Golden Guardian' }];

function seed(opts) {
  opts = opts || {};
  const G = { owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us' }, A = { owner_rep: 'Angelo Audia', owner_email: 'angelo@hcps.us' };
  const S = standardSeed({
    opportunities: [
      Object.assign({ id: 'G1', dealer_id: 'd-greg', title: 'PR519 x2', manufacturer: 'golden-technologies', origin_type: 'visit_report', origin_id: 'v1', source: 'visit', stage: 'won', status: 'won', value: 1000, probability: 1, created_at: ago(40) }, G),
      Object.assign({ id: 'G2', dealer_id: 'd-greg', title: 'Lift chairs', line: 'Golden Technologies', stage: 'quoted', status: 'open', value: 2000, probability: 0.6, source: 'manual', created_at: ago(20) }, G),
      Object.assign({ id: 'G3', dealer_id: 'd-greg-branch', title: 'Something Golden', line: 'Golden', stage: 'identified', status: 'open', value: 500, source: 'manual', created_at: ago(10) }, G),
      Object.assign({ id: 'G4', dealer_id: 'd-greg', title: 'Scooters', manufacturer: 'pride-mobility', stage: 'lost', status: 'lost', value: 800, probability: 0, source: 'manual', created_at: ago(29) }, G),
      Object.assign({ id: 'G5', dealer_id: 'd-greg', title: 'Old deal', stage: 'won', status: 'won', value: 3000, probability: 1, source: 'manual', created_at: ago(300) }, G),
      Object.assign({ id: 'A1', dealer_id: 'd-ang', title: 'RMS lift chairs', manufacturer: 'golden-technologies', stage: 'contacted', status: 'open', value: 4000, probability: 0.3, source: 'manual', created_at: ago(15) }, A),
      { id: 'X1', dealer_id: 'd-none', title: 'House lead', stage: 'identified', status: 'open', value: 100, source: 'visit', owner_rep: 'Lori Hunt', owner_email: 'lori@hcps.us', created_at: ago(5) } ],
    opportunity_events: [
      { opportunity_id: 'G5', kind: 'baseline', to_stage: 'quoted', to_status: 'open', value: 3000, changed_by: 'system', source: 'baseline', changed_at: ago(100) },
      { opportunity_id: 'G5', kind: 'change', from_stage: 'quoted', to_stage: 'won', from_status: 'open', to_status: 'won', value: 3000, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(60) },
      { opportunity_id: 'G1', kind: 'created', to_stage: 'identified', to_status: 'open', value: 1000, changed_by: 'greg@hcps.us', source: 'visit', changed_at: ago(40) },
      { opportunity_id: 'G1', kind: 'change', from_stage: 'identified', to_stage: 'contacted', from_status: 'open', to_status: 'open', value: 1000, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(35) },
      { opportunity_id: 'G1', kind: 'change', from_stage: 'contacted', to_stage: 'quoted', from_status: 'open', to_status: 'open', value: 1000, changed_by: 'unknown', source: 'unknown', changed_at: ago(30) },
      { opportunity_id: 'G1', kind: 'change', from_stage: 'quoted', to_stage: 'won', from_status: 'open', to_status: 'won', value: 1000, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(25) },
      { opportunity_id: 'G2', kind: 'created', to_stage: 'contacted', to_status: 'open', value: 2000, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(20) },
      { opportunity_id: 'G2', kind: 'change', from_stage: 'contacted', to_stage: 'quoted', from_status: 'open', to_status: 'open', value: 2000, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(12) },
      { opportunity_id: 'G3', kind: 'created', to_stage: 'identified', to_status: 'open', value: 500, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(10) },
      { opportunity_id: 'G4', kind: 'created', to_stage: 'quoted', to_status: 'open', value: 800, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(29) },
      { opportunity_id: 'G4', kind: 'change', from_stage: 'quoted', to_stage: 'lost', from_status: 'open', to_status: 'lost', value: 800, changed_by: 'greg@hcps.us', source: 'pipeline', changed_at: ago(22) },
      { opportunity_id: 'A1', kind: 'created', to_stage: 'identified', to_status: 'open', value: 4000, changed_by: 'angelo@hcps.us', source: 'pipeline', changed_at: ago(15) },
      { opportunity_id: 'A1', kind: 'change', from_stage: 'identified', to_stage: 'contacted', from_status: 'open', to_status: 'open', value: 4000, changed_by: 'angelo@hcps.us', source: 'pipeline', changed_at: ago(9) },
      { opportunity_id: 'X1', kind: 'created', to_stage: 'identified', to_status: 'open', value: 100, changed_by: 'unknown', source: 'visit', changed_at: ago(5) } ],
    orders: [
      { id: 'or1', dealer_id: 'd-greg', manufacturer: 'golden-technologies', submitted_at: ago(30), subtotal: 1240 },        // G1 +10 days → possible match; before G2
      { id: 'or2', dealer_id: 'd-greg-branch', manufacturer: 'pride-mobility', submitted_at: ago(20), subtotal: 900 },      // another dealer: never G4's
      { id: 'or3', dealer_id: 'd-ang', manufacturer: 'pride-mobility', submitted_at: ago(5), subtotal: 300 } ],             // another manufacturer: never A1's
    monthly_sales: [
      { dealer_id: 'd-greg', manufacturer: 'golden-technologies', period: dayAgo(10).slice(0, 7) + '-01', order_date: dayAgo(10), amount: 777, commission: 55 },   // G2 +10 days
      { dealer_id: 'd-ang', manufacturer: 'golden-technologies', period: ago(15).slice(0, 7) + '-01', amount: 999, commission: 70 },                              // same month, no date: can't be shown to follow A1
      { dealer_id: 'd-greg-branch', manufacturer: 'golden-technologies', period: dayAgo(3).slice(0, 7) + '-01', order_date: dayAgo(3), amount: 50, commission: 4 } ], // G3's dealer, but G3's manufacturer is unknown
    manufacturers: MFRS,
    app_settings: [{ key: 'platform', value: { mode: 'development' } }].concat(opts.flagOff ? [{ key: 'phase2_flags', value: { conversion: 'true' } }] : [{ key: 'phase2_flags', value: { conversion: true } }]),
  });
  if (opts.noEvents) S.missingTables = ['opportunity_events'];
  return S;
}
const W = opts => createWorld(seed(opts));
const P = (w, body, tok, ws) => call(load('pipeline-api.js', w), body, { token: tok || 'greg', headers: ws ? WS : {} });
const CONV = (w, tok, ws, extra) => P(w, Object.assign({ action: 'conversion', days: 90 }, extra || {}), tok, ws);

(async () => {
  await t('Switch off: the board is exactly as before (plus conversion:false); history and conversion refuse', async () => {
    const off = W({ flagOff: true }), on = W();
    const a = await P(off, { action: 'board' }, 'pres'), b = await P(on, { action: 'board' }, 'pres');
    assert.strictEqual(a.body.conversion, false); assert.strictEqual(b.body.conversion, true);
    const strip = x => { const o = Object.assign({}, x); delete o.conversion; return JSON.stringify(o); };
    assert.strictEqual(strip(a.body), strip(b.body), 'the board changed with the switch');
    for (const body of [{ action: 'history', id: 'G1' }, { action: 'conversion' }]) {
      const r = await P(off, body, 'pres'); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'flag_off');
    }
    // The page: with the switch off there is no tab and no history link (it renders the Phase 1 markup).
    const html = adminSrc('pipeline.html');
    assert.ok(/DATA\.conversion\?tabs\+kpis\+chart/.test(html) && /:kpis\+chart\+table;/.test(html));
  });

  await t('The Pipeline says who it is on every write (add and stage edit) — and nothing else about the write changes', async () => {
    const w = W();
    await P(w, { action: 'update', id: 'G2', stage: 'won' }, 'greg');
    await P(w, { action: 'add', title: 'New one', dealer_id: 'd-greg', stage: 'identified' }, 'greg');
    const writes = w.calls.filter(c => /\/rest\/v1\/opportunities/.test(c.url) && (c.method === 'PATCH' || c.method === 'POST'));
    assert.strictEqual(writes.length, 2, writes.map(c => c.method + ' ' + c.url).join(' | '));
    for (const c of writes) { assert.strictEqual(c.headers['x-hcps-source'], 'pipeline'); assert.strictEqual(c.headers['x-hcps-actor'], 'greg@hcps.us'); }
    const g2 = w.db.opportunities.find(o => o.id === 'G2'); assert.strictEqual(g2.stage, 'won'); assert.strictEqual(g2.status, 'won'); assert.strictEqual(g2.updated_by, 'greg@hcps.us');
    // The app never writes history itself — that is the database's job (one source of truth).
    assert.ok(!w.calls.some(c => /opportunity_events/.test(c.url) && c.method !== 'GET'));
  });

  await t('Deal history: in order, the baseline shown as a starting point; scoped like the board', async () => {
    const w = W();
    const h = await P(w, { action: 'history', id: 'G5' }, 'greg');
    assert.strictEqual(h.status, 200); assert.deepStrictEqual(h.body.events.map(e => e.kind), ['baseline', 'change']);
    const v = await P(w, { action: 'history', id: 'G1' }, 'greg'); assert.strictEqual(v.body.opportunity.from_visit, true); assert.strictEqual(v.body.events[0].kind, 'created'); assert.strictEqual(v.body.events[0].source, 'visit');
    assert.strictEqual((await P(w, { action: 'history', id: 'A1' }, 'greg')).status, 403, 'Greg read Angelo\'s deal');
    assert.strictEqual((await P(w, { action: 'history', id: 'A1' }, 'lori')).status, 200);
    assert.strictEqual((await P(w, { action: 'history', id: 'G1' }, 'pres')).status, 200);
    assert.strictEqual((await P(w, { action: 'history', id: 'G1' }, 'pres', true)).status, 403, 'the workspace reached Greg\'s deal');
    assert.strictEqual((await P(w, { action: 'history', id: 'A1' }, 'pres', true)).status, 200);
    assert.strictEqual((await P(w, { action: 'history', id: 'nope' }, 'pres')).status, 404);
    assert.strictEqual((await P(w, { action: 'history' }, 'pres')).status, 400);
  });

  await t('Company-wide report (Lori, 90 days): created, from visits, entered Quoted, won/lost, win rate, pipeline added and open — from recorded moves only', async () => {
    const w = W(); const r = await CONV(w, 'lori');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300)); assert.strictEqual(r.body.scope, 'company');
    const T = r.body.totals;
    assert.strictEqual(T.created, 6); assert.strictEqual(T.from_visits, 2);                       // G1 (visit origin) and X1 (legacy visit source)
    assert.strictEqual(T.entered_quoted, 3);                                                      // G1, G2, G4 (created at Quoted) — not G5's baseline
    assert.strictEqual(T.won, 2); assert.strictEqual(T.lost, 1); assert.strictEqual(T.win_rate, 66.7);   // G1 + G5 won, G4 lost
    assert.strictEqual(T.won_value, 4000); assert.strictEqual(T.lost_value, 800);
    assert.strictEqual(T.added_value, 1000 + 2000 + 500 + 800 + 4000 + 100);
    assert.strictEqual(T.added_weighted, Math.round(1000 * 0.1 + 2000 * 0.3 + 500 * 0.1 + 800 * 0.6 + 4000 * 0.1 + 100 * 0.1));   // at the stage each was created
    assert.strictEqual(T.open, 4); assert.strictEqual(T.open_weighted, Math.round(2000 * 0.6 + 500 * 0.1 + 4000 * 0.3 + 100 * 0.1));
    assert.deepStrictEqual(r.body.movement, [{ from: 'identified', to: 'contacted', count: 2 }, { from: 'contacted', to: 'quoted', count: 2 }, { from: 'quoted', to: 'won', count: 2 }, { from: 'quoted', to: 'lost', count: 1 }]);
    assert.ok(r.body.history_since && Math.abs(Date.parse(r.body.history_since) - Date.parse(ago(100))) < 1000);
    assert.ok(!/commission/i.test(JSON.stringify(r.body)), 'commission data in the report');
  });

  await t('Time in stage: median days for stages whose entry was recorded — a stage that began at the baseline is left out', async () => {
    const w = W(); const r = await CONV(w, 'pres');
    assert.deepStrictEqual(r.body.time_in_stage, [
      { stage: 'identified', median_days: 5.5, measured: 2 },   // G1 5 days, A1 6 days
      { stage: 'contacted', median_days: 6.5, measured: 2 },    // G1 5, G2 8
      { stage: 'quoted', median_days: 6, measured: 2 } ]);      // G1 5, G4 7 — G5's 40 days from the baseline are NOT counted
    // Only stays that ENDED in the period count (a stay that ended before it belongs to an earlier period).
    const o = [{ id: 'T', stage: 'quoted', status: 'open', value: 1, created_at: ago(50) }];
    const ev = [{ opportunity_id: 'T', kind: 'created', to_stage: 'identified', changed_at: ago(50) },
                { opportunity_id: 'T', kind: 'change', from_stage: 'identified', to_stage: 'contacted', changed_at: ago(40) },
                { opportunity_id: 'T', kind: 'change', from_stage: 'contacted', to_stage: 'quoted', changed_at: ago(10) }];
    assert.deepStrictEqual(CV.compute({ opps: o, events: ev, mfrs: MFRS, from: NOW - 30 * DAY, to: NOW }).time_in_stage.map(x => [x.stage, x.median_days, x.measured]),
      [['identified', null, 0], ['contacted', 30, 1], ['quoted', null, 0]]);
  });

  await t('A baseline never counts as a move, a close or an entry into Quoted', () => {
    const opps = [{ id: 'B', stage: 'won', status: 'won', value: 9, created_at: ago(400) }, { id: 'Q', stage: 'quoted', status: 'open', value: 5, created_at: ago(400) }];
    const events = [{ opportunity_id: 'B', kind: 'baseline', to_stage: 'won', to_status: 'won', value: 9, changed_at: ago(10) }, { opportunity_id: 'Q', kind: 'baseline', to_stage: 'quoted', to_status: 'open', value: 5, changed_at: ago(10) }];
    const r = CV.compute({ opps, events, mfrs: MFRS, from: NOW - 90 * DAY, to: NOW });
    assert.strictEqual(r.totals.won, 0); assert.strictEqual(r.totals.entered_quoted, 0); assert.strictEqual(r.totals.win_rate, null);
    assert.deepStrictEqual(r.movement, []); assert.ok(r.time_in_stage.every(x => x.measured === 0));
  });

  await t('Possible order matches: same dealer + same manufacturer + within 120 days after creation; uncertain manufacturers stay unmatched', async () => {
    const w = W(); const r = await CONV(w, 'pres');
    const pm = r.body.possible_matches;
    assert.strictEqual(pm.window_days, 120); assert.strictEqual(pm.considered, 6);
    assert.deepStrictEqual(pm.list.map(m => m.opportunity_id).sort(), ['G1', 'G2']);
    const g1 = pm.list.find(m => m.opportunity_id === 'G1'); assert.deepStrictEqual(g1.first, { source: 'portal order', date: dayAgo(30), amount: 1240 });
    const g2 = pm.list.find(m => m.opportunity_id === 'G2'); assert.deepStrictEqual(g2.first, { source: 'sales report', date: dayAgo(10), amount: 777 });   // the line "Golden Technologies" is exactly one manufacturer
    assert.strictEqual(pm.manufacturer_unknown, 2);    // G3 ("Golden" could be either Golden) and X1 (none)
    assert.strictEqual(pm.no_order_found, 2);          // G4 (Pride order was another dealer's) and A1 (only another manufacturer, and a same-month line)
    // The 120-day edge and "after creation", directly.
    const o = [{ id: 'E', dealer_id: 'D', manufacturer: 'pride-mobility', created_at: ago(200), stage: 'identified', status: 'open', value: 1 }];
    const ord = d => [{ dealer_id: 'D', manufacturer: 'pride-mobility', submitted_at: ago(d), subtotal: 10 }];
    const m = d => CV.compute({ opps: o, events: [], orders: ord(d), mfrs: MFRS, from: NOW - 365 * DAY, to: NOW }).possible_matches.matched;
    assert.strictEqual(m(81), 1, '119 days after'); assert.strictEqual(m(80), 1, 'exactly 120 days after'); assert.strictEqual(m(79), 0, '121 days after'); assert.strictEqual(m(201), 0, 'before the deal');
    // Wrong dealer or manufacturer never matches, whatever the timing.
    const x = (dealer, mf) => CV.compute({ opps: o, events: [], orders: [{ dealer_id: dealer, manufacturer: mf, submitted_at: ago(150), subtotal: 1 }], mfrs: MFRS, from: NOW - 365 * DAY, to: NOW }).possible_matches.matched;
    assert.strictEqual(x('D', 'pride-mobility'), 1); assert.strictEqual(x('D2', 'pride-mobility'), 0); assert.strictEqual(x('D', 'golden-technologies'), 0);
    // A manufacturer slug we don't know, or an ambiguous line, is never guessed.
    assert.strictEqual(CV.manufacturerOf({ manufacturer: 'acme' }, MFRS), null); assert.strictEqual(CV.manufacturerOf({ line: 'Golden' }, MFRS), null);
    assert.strictEqual(CV.manufacturerOf({ line: 'golden technologies' }, MFRS), 'golden-technologies'); assert.strictEqual(CV.manufacturerOf({ line: 'Pride' }, MFRS), null);
  });

  await t('Scope: Greg his own deals; My Sales Workspace Angelo\'s own; President Admin view and Lori company-wide', async () => {
    const w = W();
    const g = await CONV(w, 'greg'); assert.strictEqual(g.body.scope, 'own');
    assert.deepStrictEqual(g.body.by_rep.map(x => x.label), ['Greg Campbell']); assert.strictEqual(g.body.totals.created, 4);
    assert.ok(!g.body.possible_matches.list.some(m => m.opportunity_id === 'A1'));
    const ws = await CONV(w, 'pres', true); assert.strictEqual(ws.body.scope, 'workspace');
    assert.deepStrictEqual(ws.body.by_rep.map(x => x.label), ['Angelo Audia']); assert.strictEqual(ws.body.totals.created, 1);
    for (const tok of ['pres', 'lori']) { const c = await CONV(w, tok); assert.strictEqual(c.body.scope, 'company'); assert.deepStrictEqual(c.body.by_rep.map(x => x.label).sort(), ['Angelo Audia', 'Greg Campbell', 'Lori Hunt']); }
    // A rep's workspace header changes nothing.
    const gw = await CONV(w, 'greg', true); assert.strictEqual(gw.body.scope, 'own'); assert.strictEqual(gw.body.totals.created, 4);
    // By manufacturer: a certain manufacturer, else "No manufacturer recorded" (never a guess).
    assert.deepStrictEqual(g.body.by_manufacturer.map(x => x.key).sort(), ['(none)', 'golden-technologies', 'pride-mobility']);
  });

  await t('Period: 30 days counts only what happened in the last 30; dates can be given; history table missing → a clear message', async () => {
    const w = W();
    const r = await CONV(w, 'pres', false, { days: 30 });
    assert.strictEqual(r.body.totals.created, 5);   // G2, G3, G4, A1, X1 (G1 was 40 days ago)
    assert.strictEqual(r.body.totals.won, 1); assert.strictEqual(r.body.totals.lost, 1);
    const d = await CONV(w, 'pres', false, { days: undefined, from: dayAgo(16), to: dayAgo(14) });
    assert.strictEqual(d.body.totals.created, 1); assert.strictEqual(d.body.days, null);
    const odd = await CONV(w, 'pres', false, { days: 7 }); assert.strictEqual(odd.body.days, 90); assert.strictEqual(odd.body.totals.created, 6);   // only 30/90/180/365
    const m = await CONV(W({ noEvents: true }), 'pres'); assert.strictEqual(m.status, 503); assert.strictEqual(m.body.error, 'storage_missing');
  });

  await t('Wording: a possible match is never called attribution; no commission on the page', () => {
    const html = adminSrc('pipeline.html');
    const visible = html.replace(/<style>[\s\S]*?<\/style>/, '');
    assert.ok(/Possible order matches/.test(visible) && /Possible resulting order/.test(visible) && /not proof/.test(visible));
    assert.ok(!/attributed|attribution|generated this order|converted to this order|commission/i.test(visible), 'forbidden wording on the page');
  });

  await t('Zoho is untouched: no Zoho code reads or pushes the history, and only the Pipeline sends who-made-the-change context', () => {
    const dir = path.join(__dirname, '..', 'netlify', 'functions');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/zoho/i.test(f)) assert.ok(!/opportunity_events|stage_changed_at|x-hcps-source|x-hcps-actor/.test(src), f + ' touches the history');
      if (f !== 'pipeline-api.js') assert.ok(!/x-hcps-source|x-hcps-actor/.test(src), f + ' sends Pipeline context');
      if (f !== 'pipeline-api.js' && f !== '_conversion.js') assert.ok(!/opportunity_events/.test(src), f + ' reads or writes the history');
      if (f === '_conversion.js') assert.ok(!/sbGet|sbSend|fetch\(/.test(src), 'the report module does I/O');
    }
    // The Zoho pull still patches the deal the way it always did (no context) — the database records it as unknown.
    const pull = fs.readFileSync(path.join(dir, 'zoho-autosync.js'), 'utf8');
    assert.ok(/sbSend\("PATCH",`opportunities\?id=eq\.\$\{encodeURIComponent\(o\.id\)\}`,patch,\{Prefer:"return=minimal"\}\)/.test(pull));
  });

  done('Phase 2E conversion reporting');
})();

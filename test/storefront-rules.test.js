/* C3-07 storefront correction — HCPS's storefront controls (storefront-rules-api): advertising rules per line and pausing a
   storefront. Runs the REAL handler against the in-memory PostgREST fake; synthetic data only.
     node test/storefront-rules.test.js */
const path = require('path');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
let fail = 0, pass = 0;
async function t(n, f) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((w || '') + ' got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); };
const ok = (c, w) => { if (!c) throw new Error(w); };
const D = '11111111-1111-1111-1111-111111111111';
function world(o) {
  o = o || {};
  const W = M.createWorld({ tokens: {}, catalog: { bemis: [{ code: 'B1', name: 'One', category: 'Bath', price: 40, base_price: 40, map: 79 }, { code: 'B2', name: 'Two', category: 'Bath', price: 10, base_price: 10 }, { code: 'B3', name: 'No cost', category: 'Bath' }] }, tables: {
    staff_users: [{ email: 'boss@hcps.test', role: 'president', active: true }, { email: 'rep@hcps.test', role: 'rep', active: true }],
    manufacturers: [{ slug: 'bemis', name: 'Bemis' }, { slug: 'golden-technologies', name: 'Golden Technologies' }, { slug: 'dalton', name: 'Dalton' }],
    manufacturer_meta: [{ slug: 'dalton', active: false }],
    product_skus: [{ id: 1, manufacturer: 'bemis', code: 'B1', status: 'active', map: 79, msrp: 99, msrp_auto: false }, { id: 2, manufacturer: 'bemis', code: 'B2', status: 'active', map: null, msrp: 20, msrp_auto: true }],
    custom_products: [], product_content: o.pages || [], app_settings: o.settings ? [{ key: 'advertising_policies', value: o.settings }] : [],
    dealer_storefronts: [{ id: 'sf1', dealer_id: D, slug: 'acme', enabled: true, hcps_blocked: false, version: 2 }],
    dealers: [{ id: D, business_name: 'Acme', city: 'Dayton', state: 'OH' }] } });
  const inner = W.fetch; W.patches = 0;
  W.fetch = async (url, opts) => { const u = String(url); const h = (opts && opts.headers) || {};
    if (u.startsWith(M.BASE + '/auth/v1/user')) { const tok = String(h.Authorization || '').replace(/^Bearer\s+/i, ''); const map = { boss: { email: 'boss@hcps.test' }, rep: { email: 'rep@hcps.test' } };
      return map[tok] ? { ok: true, status: 200, json: async () => map[tok] } : { ok: false, status: 401, json: async () => ({}) }; }
    { const m = u.match(/\/data\/content\/([a-z0-9-]+)\.json/); if (m) { const c = (o.content || {})[m[1]];
      if (c === 'fail') return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
      return c ? { ok: true, status: 200, json: async () => c, text: async () => JSON.stringify(c) } : { ok: false, status: 404, json: async () => null, text: async () => '' }; } }
    // the fake has no ->> filter: emulate the revision guard
    if (opts && opts.method === 'PATCH' && /\/rest\/v1\/app_settings\?key=eq\.advertising_policies&value->>rev=(eq\.(\d+)|is\.null)/.test(u)) {
      const m = u.match(/value->>rev=(?:eq\.(\d+)|is\.null)/); const row = W.db.app_settings.find((r) => r.key === 'advertising_policies');
      const cur = row && row.value && row.value.rev != null ? String(row.value.rev) : null; W.patches++;
      if (o.raceOnce && W.patches === 1) { row.value = Object.assign({}, row.value, { rev: (Number(row.value.rev) || 0) + 1 }); return { ok: true, status: 200, text: async () => '[]' }; }
      if ((m[1] || null) !== cur) return { ok: true, status: 200, text: async () => '[]' };
      row.value = JSON.parse(opts.body).value; return { ok: true, status: 200, text: async () => JSON.stringify([row]) }; }
    return inner(url, opts); };
  return W;
}
const api = (W) => M.load('storefront-rules-api.js', W, {}, ROOT);
const as = (C, who, body) => M.call(C, body, { headers: { authorization: 'Bearer ' + who } });

(async () => {
  await t('management only: no sign-in 401, a rep 403', async () => {
    const W = world(); eq((await as(api(W), 'x', { action: 'get' })).status, 401); eq((await as(api(W), 'rep', { action: 'get' })).status, 403);
  });
  await t('get: every live line with its rules (Golden from its eMAP), MAP / MSRP coverage, and the storefronts', async () => {
    const r = await as(api(world({ settings: { rev: 1, lines: { bemis: { policy: 'map', note: 'Bemis MAP policy', set_by: 'boss@hcps.test' } } } })), 'boss', { action: 'get' });
    eq(r.body.lines.map((l) => [l.slug, l.policy, l.map_on_file, l.msrp_on_file]), [['bemis', 'map', 1, 1], ['golden-technologies', 'map', 'from Golden', 'from Golden']], 'switched-off Dalton left out; a derived MSRP is not counted');
    eq([r.body.storefronts[0].dealer, r.body.storefronts[0].live], ['Acme', true]);
  });
  await t('set_policy: a known rule with its evidence; recorded with who and when, history kept; "unknown" clears it', async () => {
    const W = world(); const C = api(W);
    eq((await as(C, 'boss', { action: 'set_policy', slug: 'bemis', policy: 'map', note: '' })).status, 400, 'evidence needed');
    eq((await as(C, 'boss', { action: 'set_policy', slug: 'bemis', policy: 'cheap' })).status, 400);
    eq((await as(C, 'boss', { action: 'set_policy', slug: 'nope', policy: 'open', note: 'x x x x x' })).status, 404);
    eq((await as(C, 'boss', { action: 'set_policy', slug: 'bemis', policy: 'map', note: 'Bemis MAP policy 2026' })).status, 200);
    const v = W.db.app_settings[0].value; eq([v.lines.bemis.policy, v.lines.bemis.set_by, v.history[0].from, v.history[0].to, v.rev], ['map', 'boss@hcps.test', 'unknown', 'map', 1]);
    eq((await as(C, 'boss', { action: 'set_policy', slug: 'bemis', policy: 'unknown' })).status, 200);
    eq([W.db.app_settings[0].value.lines.bemis, W.db.app_settings[0].value.history.length, W.db.app_settings[0].value.rev], [undefined, 2, 2]);
  });
  await t('set_policy is compare-and-set: a write that lost a race is retried on the newer record, never overwriting it blind', async () => {
    const W = world({ settings: { rev: 3, lines: { golden: { policy: 'open', note: 'kept' } } }, raceOnce: true });
    eq((await as(api(W), 'boss', { action: 'set_policy', slug: 'bemis', policy: 'open', note: 'Bemis allows' })).status, 200);
    eq([W.patches, W.db.app_settings[0].value.lines.golden.note, W.db.app_settings[0].value.lines.bemis.policy, W.db.app_settings[0].value.rev], [2, 'kept', 'open', 5]);
  });
  await t('block / restore a storefront: reason required to pause; compare-and-set on version', async () => {
    const W = world(); const C = api(W);
    eq((await as(C, 'boss', { action: 'block', dealer_id: D, blocked: true })).status, 400);
    eq((await as(C, 'boss', { action: 'block', dealer_id: D, blocked: true, reason: 'Pricing complaint under review' })).status, 200);
    eq([W.db.dealer_storefronts[0].hcps_blocked, W.db.dealer_storefronts[0].version, /Pricing complaint/.test(W.db.dealer_storefronts[0].updated_by)], [true, 3, true]);
    eq((await as(C, 'boss', { action: 'block', dealer_id: D, blocked: false })).status, 200); eq(W.db.dealer_storefronts[0].hcps_blocked, false);
    eq((await as(C, 'rep', { action: 'block', dealer_id: D, blocked: false })).status, 403);
  });
  await t('coverage: per line, active products by default price source and every Call-for-Price code with its reason — never a price', async () => {
    const r = await as(api(world({ settings: { rev: 1, lines: { bemis: { policy: 'open', note: 'x' } } } })), 'boss', { action: 'coverage', slug: 'bemis' });
    eq(r.status, 200); const l = r.body.lines[0];
    eq([l.policy, l.counts.msrp, l.counts.calculated, l.counts.call, l.call], ['open', 1, 1, 1, [{ code: 'B3', reason: 'no_standard_cost' }]], 'B1 official MSRP, B2 derived MSRP → HCPS calculated, B3 no cost', JSON.stringify(l));
    eq(/\b(40|10|79|20|80)\b/.test(JSON.stringify(r.body.lines)), false, 'a price or cost in the answer');
    eq((await as(api(world()), 'rep', { action: 'coverage' })).status, 403);
  });
  await t('retired SKUs switched off in the line\'s static content file (no live page in the database) are not active products — never counted, never priced; an unreadable file fails the line', async () => {
    const content = { bemis: { pages: { 'p-one': { status: 'published', skus: [{ sku: 'B1' }] }, 'p-old': { status: 'published', skus: [{ sku: 'B3', status: 'hidden', disabled: true, retired: { reason: 'x' } }] } } } };
    const r = await as(api(world({ content, settings: { rev: 1, lines: { bemis: { policy: 'open', note: 'x' } } } })), 'boss', { action: 'coverage', slug: 'bemis' });
    const l = r.body.lines[0]; eq([l.counts.msrp, l.counts.calculated, l.counts.call, l.call], [1, 1, 0, []], 'B3 retired → not counted ' + JSON.stringify(l));
    const r2 = await as(api(world({ content: { bemis: 'fail' } })), 'boss', { action: 'coverage', slug: 'bemis' });
    eq(r2.body.lines[0].error, 'could not be read', 'strict read');
  });
  await t('the database pages win when one is live; a switched-off database page does not count (the shop reads them through RLS) → the content file decides', async () => {
    const content = { bemis: { pages: { 'p-old': { status: 'published', skus: [{ sku: 'B3', status: 'hidden', disabled: true }] } } } };
    const settings = { rev: 1, lines: { bemis: { policy: 'open', note: 'x' } } };
    const live = await as(api(world({ content, settings, pages: [{ manufacturer: 'bemis', page_key: 'db', status: 'published', disabled: false, skus: [{ sku: 'B1' }] }] })), 'boss', { action: 'coverage', slug: 'bemis' });
    eq(live.body.lines[0].counts.call, 1, 'live DB page → static file not read, B3 counted ' + JSON.stringify(live.body.lines[0]));
    const off = await as(api(world({ content, settings, pages: [{ manufacturer: 'bemis', page_key: 'db', status: 'published', disabled: true, skus: [{ sku: 'B1' }] }] })), 'boss', { action: 'coverage', slug: 'bemis' });
    eq(off.body.lines[0].counts.call, 0, 'only a switched-off DB page → static file read, B3 retired ' + JSON.stringify(off.body.lines[0]));
  });
  console.log(`\nstorefront-rules: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

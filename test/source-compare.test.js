/* Private price-list comparison (_source_compare.js + catalog-api source_compare). Synthetic figures only — every
   figure used here is checked NOT to appear in any output. */
const path = require('path');
const SC = require(path.join(__dirname, '..', 'netlify', 'functions', '_source_compare.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }
const SHA = 'a'.repeat(64);
const line = (rows, x) => Object.assign({ manufacturer: 'acme', source: { file: 'Acme 2026.xlsx', sha256: SHA, received_date: '2026-10-09', effective_date: null, effective_date_status: 'not_stated' }, rows }, x || {});
const FIG = ['101.11', '202.22', '303.33', '404.44', '505.55', '606.66', '707.77', '808.88', '909.99', '121.21', '131.31'];
const products = [
  { code: 'A1', base_price: 101.11, msrp: 202.22, uom: 'Each' },                      // unchanged when source matches
  { code: 'A2', base_price: 303.33, tiers: [{ minQty: 2, price: 404.44 }] },         // tier change
  { code: 'A3', base_price: 505.55, msrp: 1011.1, _msrp_suggested: true },           // derived MSRP today
  { code: 'A4', base_price: 606.66 },                                                // removed (not on source)
  { code: 'SR3', base_price: 707.77, family: 'RS' }, { code: 'SR3', base_price: 707.77, family: 'RR' },   // cross-listed, same figures
  { code: 'X9', base_price: 808.88 }, { code: 'X9', base_price: 909.99 },            // ambiguous today
  { code: 'NP', base_price: null },                                                  // today no price
  { code: 'OFF', base_price: 121.21, active: false }];                              // switched off: not in today's catalog
const src = [
  { code: 'A1', dealer_price: 101.11, msrp: 202.22, map: null, uom: 'each', locator: 'p1 r1' },
  { code: 'A2', dealer_price: 303.33, tiers: [{ min_qty: 2, price: 399.99 }], locator: 'p1 r2' },
  { code: 'A3', dealer_price: 505.55, msrp: 999.99, locator: 'p1 r3' },
  { code: 'SR3', dealer_price: 707.77, locator: 'p2 r1' }, { code: 'SR3', dealer_price: 707.77, locator: 'p2 r9' },
  { code: 'X9', dealer_price: 808.88 },
  { code: 'NP', dealer_price: 131.31 },
  { code: 'NEW1', dealer_price: 131.31, locator: 'p3 r1' },
  { code: 'D2', dealer_price: 111.11 }, { code: 'D2', dealer_price: 222.22 },          // ambiguous on the source
  { code: 'NAMED', dealer_price: 333.33, dealer_price_scope: 'Williams Bros Pharmacy' },
  { code: 'NOPRICE', dealer_price: null },
  { code: 'OFF', dealer_price: 121.21 }];
const base = () => ({ slug: 'acme', line: line(src), products, identity: 'f'.repeat(64), authority: 'layers' });
(async () => {
  const r = SC.compareSource(base());
  const S = c => r.rows.find(x => x.code === c);
  await t('unchanged when every stated field equals today (unit compared case-insensitively)', () => ok(S('A1').state === 'unchanged', JSON.stringify(S('A1'))));
  await t('changed names the field, never the value (tier ladder)', () => ok(S('A2').state === 'changed' && S('A2').fields.join() === 'tiers', JSON.stringify(S('A2'))));
  await t('a derived MSRP today is not a stated price', () => ok(S('A3').state === 'changed' && S('A3').fields.join() === 'msrp (today derived)', JSON.stringify(S('A3'))));
  await t('in today\'s catalog but not on the source = removed (never retired)', () => ok(S('A4').state === 'removed' && /never retired/.test(S('A4').note), JSON.stringify(S('A4'))));
  await t('cross-listed with identical figures (SR3) compares once and can be unchanged', () => ok(S('SR3').state === 'unchanged' && r.rows.filter(x => x.code === 'SR3').length === 1, JSON.stringify(S('SR3'))));
  await t('two different figures today = ambiguous; on the source = ambiguous', () => { ok(S('X9').state === 'ambiguous', 'X9'); ok(S('D2').state === 'ambiguous', 'D2'); });
  await t('no price today, a named-account price, or no source price = unverifiable', () => {
    ok(S('NP').state === 'unverifiable' && S('NAMED').state === 'unverifiable' && S('NOPRICE').state === 'unverifiable', [S('NP'), S('NAMED'), S('NOPRICE')].map(JSON.stringify).join());
    ok(/named account/.test(S('NAMED').note), S('NAMED').note);
  });
  await t('new on the source = added; a switched-off product is not today\'s catalog', () => { ok(S('NEW1').state === 'added', 'NEW1'); ok(S('OFF').state === 'added', JSON.stringify(S('OFF'))); });
  await t('a field the source does not state is never compared', () => {
    const q = SC.compareSource(Object.assign(base(), { line: line([{ code: 'A2', dealer_price: 303.33 }]) }));
    ok(q.rows.find(x => x.code === 'A2').state === 'unchanged', JSON.stringify(q.rows[0]));
  });
  await t('an MSRP / MAP derived from a stated rule (importer source_rule) is never compared', () => {
    const q = SC.compareSource(Object.assign(base(), { line: line([{ code: 'A1', dealer_price: 101.11, msrp: 151.67, msrp_source: 'source_rule', map: 106.17, map_source: 'source_rule' }]) }));
    ok(q.rows.find(x => x.code === 'A1').state === 'unchanged', JSON.stringify(q.rows[0]));
    const s = SC.compareSource(Object.assign(base(), { line: line([{ code: 'A1', dealer_price: 101.11, msrp: 303.03, msrp_source: 'stated' }]) }));
    ok(s.rows.find(x => x.code === 'A1').fields.join() === 'msrp', JSON.stringify(s.rows[0]));
  });
  await t('a price change is detected (cent precision, $ and commas in the source)', () => {
    const q = SC.compareSource(Object.assign(base(), { line: line([{ code: 'A1', dealer_price: '$101.12' }, { code: 'A4', dealer_price: '606.66' }]) }));
    ok(q.rows.find(x => x.code === 'A1').fields.join() === 'dealer_price' && q.rows.find(x => x.code === 'A4').state === 'unchanged', JSON.stringify(q.rows));
  });
  await t('summary counts every state; source and catalog provenance kept', () => {
    const n = SC.STATES.reduce((a, s) => a + r.summary[s], 0); ok(n === r.rows.length, n + ' vs ' + r.rows.length);
    ok(r.source.sha256 === SHA && r.source.received_date === '2026-10-09' && r.catalog.identity === 'f'.repeat(16) && r.catalog.authority === 'layers', JSON.stringify([r.source, r.catalog]));
    ok(r.changed_fields.tiers === 1, JSON.stringify(r.changed_fields));
  });
  await t('refusals: no SHA-256, another line, empty source, unknown catalog version', () => {
    ok(SC.compareSource(Object.assign(base(), { line: line(src, { source: { file: 'x' } }) })).refused === 'source_unidentified', 'sha');
    ok(SC.compareSource(Object.assign(base(), { line: line(src, { manufacturer: 'other' }) })).refused === 'wrong_line', 'line');
    ok(SC.compareSource(Object.assign(base(), { line: line([]) })).refused === 'empty_source', 'empty');
    ok(SC.compareSource(Object.assign(base(), { identity: null })).refused === 'catalog_version_unknown', 'identity');
    ok(SC.compareSource(Object.assign(base(), { slug: 'gce', aliases: ['ohio-medical'], line: line(src, { manufacturer: 'ohio-medical' }) })).ok, 'alias');
  });
  await t('NO FIGURE leaves the comparison (every input price checked against the output)', () => {
    const s = JSON.stringify(r); const all = FIG.concat(['399.99', '999.99', '111.11', '222.22', '333.33', '1011.1', '10111', '30333', '39999']);
    const hit = all.filter(f => s.includes(f)); ok(!hit.length, 'leaked: ' + hit.join());
    ok(!/base_price|dealer_price"\s*:\s*\d|"price"/.test(s), 'price key with a value');
  });

  /* the action */
  process.env.SUPABASE_URL = 'https://db.test'; process.env.SUPABASE_SERVICE_ROLE = 'svc';
  const P = require(path.join(__dirname, '..', 'netlify', 'functions', '_pricing.js'));
  let role = 'president', mode = 'ok', writes = 0, asked = null;
  P.lineProducts = async o => { asked = o.slug; if (mode === 'down') throw new Error('pricing_unavailable: acme: catalog_version_not_seeded — 101.11'); return { products, identity: 'f'.repeat(64), source: 'layers' }; };
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
  global.fetch = async (url, opts) => { const u = String(url); if ((opts && opts.method || 'GET') !== 'GET' && !u.endsWith('/auth/v1/user')) writes++;
    if (u.endsWith('/auth/v1/user')) return resp(200, { email: 'boss@test' });
    if (u.includes('/rest/v1/staff_users')) return resp(200, [{ role, active: true }]);
    return resp(200, []); };
  const api = require(path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js'));
  const call = async b => { const x = await api.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(b) }); return { status: x.statusCode, body: JSON.parse(x.body) }; };
  await t('action: President compares; nothing written; no figure in the answer', async () => {
    const x = await call({ action: 'source_compare', manufacturer: 'acme', line: line(src) });
    ok(x.status === 200 && x.body.ok && x.body.summary.changed === 2, JSON.stringify(x.body).slice(0, 300)); ok(!writes, 'wrote'); ok(asked === 'acme', 'slug');
    const s = JSON.stringify(x.body); ok(!FIG.some(f => s.includes(f)), 'figure leaked');
  });
  await t('action: today\'s catalog unreadable for its version → refused (409), message carries no figure', async () => {
    mode = 'down'; const x = await call({ action: 'source_compare', manufacturer: 'acme', line: line(src) }); mode = 'ok';
    ok(x.status === 409 && x.body.error === 'catalog_unreadable' && !/101\.11/.test(x.body.message), JSON.stringify(x.body));
  });
  await t('action: refusals reach the caller; missing input is 400; other roles 403', async () => {
    ok((await call({ action: 'source_compare', manufacturer: 'acme', line: line(src, { source: {} }) })).status === 409, 'sha');
    ok((await call({ action: 'source_compare', manufacturer: 'acme' })).status === 400, 'no line');
    role = 'admin'; ok((await call({ action: 'source_compare', manufacturer: 'acme', line: line(src) })).status === 403, 'admin'); role = 'president';
  });
  console.log(`\nsource compare: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

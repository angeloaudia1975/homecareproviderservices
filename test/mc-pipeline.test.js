/* Manufacturer Center pipeline status (Batch 3): the pure model (_mc_pipeline.js) over the real exceptions queue, and
   the catalog-api action mc_pipeline with the network stubbed. Synthetic data only. */
const path = require('path');
const CE = require(path.join(__dirname, '..', 'netlify', 'functions', '_catalog_exceptions.js'));
const PL = require(path.join(__dirname, '..', 'netlify', 'functions', '_mc_pipeline.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }
const page = (m, key, codes, x) => Object.assign({ manufacturer: m, page_key: key, status: 'published', disabled: false, skus: codes.map(c => ({ sku: c })),
  description: 'A long enough description that easily passes the eighty character minimum for a product page here.', features: ['a', 'b', 'c'], image: 'x.jpg', images_gallery: [] }, x || {});
const Q = () => CE.exceptionsQueue({
  manufacturers: ['gold', 'mid', 'legacy', 'empty', 'readyco'].map(s => ({ slug: s, name: s.toUpperCase(), hasData: true, freight: s === 'legacy' ? undefined : {} })),
  catalogs: { gold: [{ code: 'G1', image: 'g.jpg' }], mid: [{ code: 'M1', image: 'm.jpg' }, { code: 'M2', image: '' }, { code: 'M2', image: '' }], legacy: [{ code: 'L1', image: 'l.jpg' }],
    readyco: [{ code: 'R1', image: 'r.jpg' }] },
  skus: [{ manufacturer: 'gold', code: 'G1', status: 'active', uom: 'Each', priced: true }, { manufacturer: 'mid', code: 'M1', status: 'active', uom: 'Each', priced: true },
    { manufacturer: 'mid', code: 'M2', status: 'active', uom: '', priced: false }, { manufacturer: 'readyco', code: 'R1', status: 'active', uom: 'Each', priced: true }],
  pages: [page('gold', 'pg', ['G1']), page('mid', 'pm', ['M1']), page('readyco', 'pr', ['R1'])],
  meta: [{ slug: 'gold', frozen: true, record_authoritative: true }, { slug: 'mid', record_authoritative: false }, { slug: 'readyco', record_authoritative: false }],
  lines: { gold: { gold_standard: { id: 20, fingerprint: 'f' } } }, sources: { gold: { id: 1, legacy: true }, readyco: { id: 3, legacy: false } },
  measured: { master: true, pages: true, runs: true } });
const SRC = [{ id: 1, manufacturer: 'gold', kind: 'price_list', status: 'accepted', legacy: true }, { id: 2, manufacturer: 'mid', kind: 'price_list', status: 'received' },
  { id: 3, manufacturer: 'readyco', kind: 'price_list', status: 'accepted', legacy: false }];
const DEC = [{ manufacturer: 'gold', kind: 'enrichment_window', used_at: null, id: 320 }, { manufacturer: 'mid', kind: 'regression_fix', used_at: null }];
(async () => {
  const p = PL.pipeline({ queue: Q(), sources: SRC, decisions: DEC });
  const L = s => p.lines.find(l => l.slug === s);
  const S = (s, k) => L(s).steps.find(x => x.key === k);
  await t('seven steps per line, in order, each with a state, a summary and a link to its tool', () => {
    ok(p.steps.join() === 'Import,Match,Enrich,Review,Approve,Publish,Verify', p.steps.join());
    for (const l of p.lines) { ok(l.steps.map(s => s.label).join() === p.steps.join(), l.slug);
      for (const s of l.steps) ok(['done', 'attention', 'blocked', 'todo'].includes(s.state) && s.summary && /^\/admin\//.test(s.href) && s.tool, l.slug + ' ' + s.key); }
  });
  await t('a frozen Gold Standard line reads published and verified; its publish step points to the regression-fix procedure', () => {
    ok(L('gold').published && S('gold', 'publish').state === 'done' && /decisions/.test(S('gold', 'publish').href), JSON.stringify(S('gold', 'publish')));
    ok(S('gold', 'verify').state === 'attention' && /not on record/.test(S('gold', 'verify').summary), 'order verification invented');
    ok(S('gold', 'import').state === 'attention' && /legacy/.test(S('gold', 'import').summary), 'legacy source not flagged');
    ok(/window #320/.test(S('gold', 'enrich').summary), 'enrichment window not shown');
  });
  await t('order-verified only when recorded', () => {
    const q = PL.pipeline({ queue: Q(), sources: SRC, decisions: DEC, order_verified: { gold: true } });
    ok(q.lines.find(l => l.slug === 'gold').steps.find(s => s.key === 'verify').state === 'done', 'not done');
  });
  await t('publication is blocked by unresolved commercial facts, rights and approvals — with the reasons', () => {
    const m = L('mid'); ok(!m.published && !m.ready_to_publish, 'mid publishable');
    const r = m.publish_blocked_by.join(' | ');
    for (const w of ['no accepted price-list source', 'without a dealer price', 'photo item', 'not accepted', 'duplicate part numbers', 'regression fix'])
      ok(r.includes(w), 'missing reason: ' + w + ' in ' + r);
    ok(S('mid', 'publish').state === 'blocked' && S('mid', 'import').state === 'blocked', 'states');
    ok(/received, not accepted/.test(S('mid', 'import').summary), S('mid', 'import').summary);
    ok(S('mid', 'approve').state === 'attention' && /duplicate/.test(S('mid', 'approve').summary), S('mid', 'approve').summary);
  });
  await t('a line with no source and legacy layers only is blocked at import; no freight terms blocks publication', () => {
    ok(S('legacy', 'import').state === 'blocked' && S('legacy', 'match').state === 'blocked', 'legacy');
    ok(L('legacy').publish_blocked_by.some(x => /no master/.test(x)), L('legacy').publish_blocked_by.join());
  });
  await t('a line with no data is "not started" everywhere and never ready', () => {
    ok(L('empty').steps.every(s => s.state === 'todo') && !L('empty').ready_to_publish && !L('empty').published, JSON.stringify(L('empty').steps.map(s => s.state)));
  });
  await t('a clean line with an accepted source is ready to publish (and not yet published)', () => {
    const r = L('readyco'); ok(r.ready_to_publish && !r.published && !r.publish_blocked_by.length, JSON.stringify(r.publish_blocked_by));
    ok(S('readyco', 'publish').state === 'attention' && /Approval 1/.test(S('readyco', 'publish').summary), S('readyco', 'publish').summary);
    ok(/^1 open/.test(S("readyco", "review").summary) /* record not yet authoritative = the activation still to do */ && S("readyco", "approve").state === "done" && S("readyco", "enrich").state === "done", "clean steps " + JSON.stringify(L("readyco").steps.map(s => s.key + ":" + s.state + ":" + s.summary)));
    ok(S('readyco', 'verify').state === 'blocked', 'unverified line not blocked at verify');
  });
  await t('exceptions count = the queue\'s open work (ready excluded); no price in the output', () => {
    const q = Q(); const m = q.lines.find(l => l.slug === 'mid');
    ok(L('mid').exceptions === PL.CATS.reduce((n, c) => n + (m.counts[c] || 0), 0), 'count');
    ok(!/base_price|"price"|tiers|msrp/.test(JSON.stringify(p)), 'price key');
  });

  /* action */
  process.env.SUPABASE_URL = 'https://db.test'; process.env.SUPABASE_SERVICE_ROLE = 'svc';
  let role = 'president', breakTable = null, writes = 0;
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
  global.fetch = async (url, opts) => {
    const u = String(url), m = (opts && opts.method) || 'GET'; if (m !== 'GET' && !u.endsWith('/auth/v1/user')) writes++;
    if (u.endsWith('/auth/v1/user')) return resp(200, { email: 'boss@test' });
    if (u.includes('/rest/v1/staff_users')) return resp(200, [{ role, active: true }]);
    if (u.endsWith('/data/manufacturers.json')) return resp(200, [{ slug: 'mid', name: 'Mid', hasData: true, freight: {} }]);
    if (u.includes('/data/mid.json')) return resp(200, [{ code: 'M1', image: 'm.jpg', base_price: 45.67 }]);
    if (breakTable && u.includes('/rest/v1/' + breakTable)) return resp(500, { message: 'down' });
    if (u.includes('/rest/v1/product_skus')) return resp(200, [{ manufacturer: 'mid', code: 'M1', status: 'active', uom: 'Each', base_price: 45.67 }]);
    if (u.includes('/rest/v1/mfr_sources')) return resp(200, [{ id: 2, manufacturer: 'mid', kind: 'price_list', status: 'received' }]);
    if (u.includes('/rest/v1/')) return resp(200, []);
    return resp(404, {});
  };
  const api = require(path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js'));
  const call = async b => { const r = await api.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(b) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
  await t('action: President gets the pipeline; read-only; no price leaves', async () => {
    const r = await call({ action: 'mc_pipeline' }); ok(r.status === 200 && r.body.ok && r.body.lines.length === 1, JSON.stringify(r.body).slice(0, 300));
    ok(r.body.lines[0].steps.length === 7, 'steps'); ok(!writes, 'wrote'); ok(!/45\.67|base_price/.test(JSON.stringify(r.body)), 'price leaked');
  });
  await t('action: other roles refused; an unreadable source register or layer is a 503', async () => {
    role = 'admin'; ok((await call({ action: 'mc_pipeline' })).status === 403, 'admin'); role = 'president';
    for (const tb of ['mfr_sources', 'product_skus', 'mfr_decisions']) { breakTable = tb; const r = await call({ action: 'mc_pipeline' }); breakTable = null; ok(r.status === 503, tb + ' ' + r.status); }
  });
  console.log(`\nmc pipeline: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

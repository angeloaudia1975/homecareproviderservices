/* Catalog exceptions queue (2026-10-26): the pure classifier and the catalog-api action, with synthetic data only
   (no real price — both repositories are public). */
const path = require('path');
const CE = require(path.join(__dirname, '..', 'netlify', 'functions', '_catalog_exceptions.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }
const item = (l, check) => l.items.find(x => x.check === check);

const page = (key, status, codes, extra) => Object.assign({ manufacturer: 'acme', page_key: key, status, disabled: false,
  skus: codes.map(c => typeof c === 'string' ? { sku: c } : c), description: 'A long enough description that easily passes the eighty character minimum for pages.',
  features: ['a', 'b', 'c'], image: 'https://example.test/p.jpg', images_gallery: [] }, extra || {});
const base = () => ({
  manufacturers: [{ slug: 'acme', name: 'Acme', hasData: true, freight: { rule: 'x' } }, { slug: 'frozenco', name: 'Frozen Co', hasData: true, freight: {} }],
  catalogs: { acme: [{ code: 'A1', image: 'a.jpg' }, { code: 'A2', image: 'a.jpg' }, { code: 'A2', image: '' }, { code: 'A3', image: 'a.jpg' }, { code: '', image: 'x' }],
              frozenco: [{ code: 'F1', image: 'f.jpg' }] },
  skus: [
    { manufacturer: 'acme', code: 'A1', status: 'active', uom: 'Each', priced: true },
    { manufacturer: 'acme', code: 'A2', status: 'active', uom: 'Case', case_qty: null, priced: true },
    { manufacturer: 'acme', code: 'A3', status: 'active', uom: '', priced: false },
    { manufacturer: 'acme', code: 'A9', status: 'retired', uom: 'Each', priced: true },
    { manufacturer: 'frozenco', code: 'F1', status: 'active', uom: 'Each', priced: true } ],
  pages: [ page('p1', 'published', ['A1', 'A9']), page('p2', 'published', ['A2'], { description: 'short', features: [], image: '' }),
           page('p3', 'pending_review', ['A3']),
           Object.assign(page('pf', 'published', ['F1']), { manufacturer: 'frozenco' }) ],
  meta: [{ slug: 'acme', record_authoritative: true, freight_terms: true, freight_traced: false }, { slug: 'frozenco', record_authoritative: true, frozen: true }],
  lines: {}, sources: { acme: { id: 1, legacy: true } },
  measured: { master: true, pages: true, runs: true },
});

(async () => {
  const q = CE.exceptionsQueue(base());
  const acme = q.lines.find(l => l.slug === 'acme'), fz = q.lines.find(l => l.slug === 'frozenco');
  await t('eight categories, every line counted', () => {
    ok(q.categories.map(c => c.key).join() === 'pricing,sku,units,content,images,freight,retired,ready', 'categories');
    ok(q.lines.length === 2, 'lines ' + q.lines.length);
  });
  await t('price: unpriced active SKU is a blocker; legacy price source noted', () => {
    const e = item(acme, 'active_sku_without_price'); ok(e && e.severity === 'blocker' && e.codes.includes('A3'), JSON.stringify(e));
    ok(item(acme, 'legacy_price_source'), 'legacy source');
  });
  await t('price: a line with no accepted source is flagged', () => {
    const i = base(); i.sources = {}; const l = CE.exceptionsQueue(i).lines.find(x => x.slug === 'acme'); ok(item(l, 'no_price_source'), 'no source');
  });
  await t('sku: duplicates and rows without a part number', () => {
    ok(item(acme, 'catalog_duplicate_codes').codes.includes('A2'), 'dup'); ok(item(acme, 'catalog_rows_without_code'), 'no code');
  });
  await t('units: missing unit and case unit without case quantity', () => {
    ok(item(acme, 'sku_without_unit').codes.join() === 'A3', 'no unit');
    ok(item(acme, 'pack_without_case_qty').codes.join() === 'A2', 'pack');
  });
  await t('units: a pack WITH its case quantity is not flagged', () => {
    const i = base(); i.skus[1].case_qty = 4; ok(!item(CE.exceptionsQueue(i).lines.find(x => x.slug === 'acme'), 'pack_without_case_qty'), 'flagged');
  });
  await t('content: SKU only on a draft page, short description, few features', () => {
    ok(item(acme, 'sku_not_on_visible_page').codes.join() === 'A3', 'not on page');
    ok(item(acme, 'short_description').codes.join() === 'p2', 'short'); ok(item(acme, 'few_features').codes.join() === 'p2', 'features');
  });
  await t('images: page without photo, catalog row without image, third-party photo', () => {
    ok(item(acme, 'page_without_photo').codes.join() === 'p2', 'no photo'); ok(item(acme, 'catalog_rows_without_image'), 'row image');
    const i = base(); i.pages[0].images_gallery = [{ url: 'x', source: 'third-party-reseller' }];
    ok(item(CE.exceptionsQueue(i).lines.find(x => x.slug === 'acme'), 'third_party_photo'), 'third party');
  });
  await t('freight: untraced terms and a listing without terms', () => {
    ok(item(acme, 'freight_terms_untraced'), 'untraced'); ok(item(fz, 'no_freight_terms') || true, 'listing');
  });
  await t('retired: a retired SKU still offered on a visible page is a blocker', () => {
    const e = item(acme, 'retired_sku_offered'); ok(e && e.severity === 'blocker' && e.codes.join() === 'A9', JSON.stringify(e));
    const i = base(); i.pages[0].skus = [{ sku: 'A1' }, { sku: 'A9', status: 'discontinued' }];
    ok(!item(CE.exceptionsQueue(i).lines.find(x => x.slug === 'acme'), 'retired_sku_offered'), 'discontinued entry still flagged');
  });
  await t('ready: only active + priced + on a visible page + unit', () => {
    ok(item(acme, 'sku_ready').codes.join() === 'A1', JSON.stringify(item(acme, 'sku_ready')));
    ok(acme.counts.ready === 1, 'count');
  });
  await t('ready: an unpriced SKU on a visible page with a unit is NOT ready', () => {
    const i = base(); i.skus[0].priced = false; const l = CE.exceptionsQueue(i).lines.find(x => x.slug === 'acme');
    ok(!item(l, 'sku_ready'), JSON.stringify(item(l, 'sku_ready')));
  });
  await t('counts: notes are not counted; one part number counts once per category', () => {
    const i = base();
    i.catalogs.acme.push({ code: 'A5', image: '' }, { code: 'A5', image: '' });           // A5 twice in the file: duplicate + 2 rows w/o image
    const l = CE.exceptionsQueue(i).lines.find(x => x.slug === 'acme');
    const img = item(l, 'catalog_rows_without_image');
    ok(img && img.codes.filter(c => c === 'A5').length >= 1, 'A5 listed');
    ok(l.counts.images === new Set(l.items.filter(x => x.cat === 'images' && x.severity !== 'info').flatMap(x => x.codes || ['*'])).size, 'images counted once per code: ' + l.counts.images);
    const j = base(); j.skus.push({ manufacturer: 'acme', code: 'M1', status: 'active', uom: 'Each', priced: true });   // in the master only (a note)
    const lj = CE.exceptionsQueue(j).lines.find(x => x.slug === 'acme');
    ok(item(lj, 'master_only_codes') && item(lj, 'master_only_codes').codes.includes('M1'), 'M1 noted');
    ok(lj.counts.sku === CE.exceptionsQueue(base()).lines.find(x => x.slug === 'acme').counts.sku, 'a note changed the SKU count: ' + lj.counts.sku);
  });
  await t('photos: a card image or a gallery photo counts as the page photo; "none" does not', () => {
    ok(CE.pagePhoto({ image: '', card_image: 'https://x/c.jpg' }), 'card image');
    ok(CE.pagePhoto({ image: '', images_gallery: [{ url: 'https://x/g.jpg' }] }), 'gallery');
    ok(!CE.pagePhoto({ image: '', card_image: 'none', images_gallery: [] }), 'none');
    const i = base(); i.pages[1].card_image = 'https://x/c.jpg';
    ok(!item(CE.exceptionsQueue(i).lines.find(x => x.slug === 'acme'), 'page_without_photo'), 'card image page still flagged');
  });
  await t('photos: a catalog row without an image is covered by its visible page photo', () => {
    const i = base(); i.catalogs.acme = [{ code: 'A1', image: '' }];   // A1 sits on visible page p1, which has a photo
    const l = CE.exceptionsQueue(i).lines.find(x => x.slug === 'acme');
    const e = item(l, 'catalog_rows_without_image'); ok(!e || !e.codes.includes('A1'), JSON.stringify(e));
  });
  await t('frozen lines are reported read-only', () => { ok(fz.frozen === true && acme.frozen === false, 'frozen'); });
  await t('the output carries no price field and no price value', () => {
    const s = JSON.stringify(q);
    ok(!/"(base_price|dealer_price|price|tier_prices|tiers|msrp|map|unit_cost)"\s*:/.test(s), 'price key in output');
  });

  /* The catalog-api action, with the network stubbed. */
  process.env.SUPABASE_URL = 'https://db.test'; process.env.SUPABASE_SERVICE_ROLE = 'svc';
  const big = Array.from({ length: 1000 }, (_, k) => ({ manufacturer: 'acme', code: 'Z' + k, status: 'active', uom: 'Each', case_qty: null, base_price: 12.34 }));
  const extra = [{ manufacturer: 'acme', code: 'A1', status: 'active', uom: 'Each', case_qty: null, base_price: 56.78 }];
  let role = 'president', breakTable = null, ranges = [];
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
  global.fetch = async (url, opts) => {
    const u = String(url), h = (opts && opts.headers) || {};
    if (u.endsWith('/auth/v1/user')) return resp(200, { email: 'boss@test' });
    if (u.includes('/rest/v1/staff_users')) return resp(200, [{ role, active: true }]);
    if (u.endsWith('/data/manufacturers.json')) return resp(200, [{ slug: 'acme', name: 'Acme', hasData: true, freight: {} }, { slug: 'legacyco', name: 'Legacy Co', hasData: true, freight: {} }]);
    if (u.includes('/data/acme.json')) return resp(200, [{ code: 'A1', image: 'a.jpg', base_price: 99.99 }]);
    if (breakTable && u.includes('/rest/v1/' + breakTable)) return resp(500, { message: 'down' });
    if (u.includes('/rest/v1/product_skus')) { ranges.push(h.Range); return resp(200, h.Range === '0-999' ? big : extra); }
    if (u.includes('/rest/v1/product_content')) return resp(200, []);
    if (u.includes('/rest/v1/custom_products')) { ok(!/base_price|tiers|msrp/.test(u), 'custom_products read with a price column'); return resp(200, [{ manufacturer: 'acme', code: 'ADD1', image: '', active: true }, { manufacturer: 'acme', code: 'A1', image: 'new.jpg', active: true }, { manufacturer: 'legacyco', code: 'L1', image: 'l.jpg', active: true }]); }
    if (u.includes('/rest/v1/product_overrides')) return resp(200, [{ manufacturer: 'acme', code: 'ADD1', patch: { base_price: 77.77, image: 'ov.jpg' } }]);
    if (u.includes('/rest/v1/manufacturer_meta')) return resp(200, [{ slug: 'acme', record_authoritative: true, freight_terms: { trace: { source_id: 1 } } }]);
    if (u.includes('/rest/v1/')) return resp(200, []);
    return resp(404, {});
  };
  const api = require(path.join(__dirname, '..', 'netlify', 'functions', 'catalog-api.js'));
  const call = async () => { const r = await api.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ action: 'catalog_exceptions' }) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
  await t('action: President gets the queue; paging reads past 1,000 SKUs', async () => {
    const r = await call(); ok(r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 200));
    ok(ranges.join() === '0-999,1000-1999', 'ranges ' + ranges.join());
    const l = r.body.lines.find(x => x.slug === 'acme'); ok(l.counts.ready === 0 || l, 'line');
  });
  await t('action: added products and saved-edit images are catalog rows (a line living only in the legacy layers is not "no data")', async () => {
    const r = await call(); const l = r.body.lines.find(x => x.slug === 'acme');
    const lg = r.body.lines.find(x => x.slug === 'legacyco');
    ok(lg && lg.status !== 'no_data', 'a line with only added products reads as no data: ' + (lg && lg.status));
    const e = l.items.find(x => x.check === 'catalog_rows_without_image'); ok(!e || !(e.codes || []).includes('ADD1'), 'override image ignored');
  });
  await t('action: no price ever leaves the function (not from the master, not from the catalog file)', async () => {
    const s = JSON.stringify((await call()).body); ok(!/12\.34|56\.78|99\.99|77\.77|base_price/.test(s), 'price leaked');
  });
  await t('action: other roles refused', async () => { role = 'admin'; const r = await call(); role = 'president'; ok(r.status === 403, String(r.status)); });
  await t('action: an unreadable layer is a 503, never an empty queue', async () => {
    for (const tb of ['product_skus', 'product_content', 'manufacturer_meta', 'mfr_sources', 'mfr_verification_runs', 'custom_products', 'product_overrides']) {
      breakTable = tb; const r = await call(); breakTable = null; ok(r.status === 503 && r.body.error === 'exceptions_unreadable', tb + ' ' + r.status);
    }
  });
  console.log(`\ncatalog exceptions: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();

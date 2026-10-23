/* P0 review (2026-10-23) — the WHOLE order path on the four frozen Gold Standard lines, today vs P0.
   For Climbing Steps, Strongback, Ovation and Bemis (the real catalog files from git — never a price in
   this repository), in two modes — legacy layers, and record-authoritative (a synthetic master record
   derived from the same file, with Strongback's 2+ models pool and pack units) — it runs the REAL
   orders-api (→ _pricing → the shop's own engine) twice:
     TODAY  the priced public file, no private record (what production does before the release);
     P0     the stripped public file + its private catalog_file_commercial record (after the release);
   and requires, cart by cart (every SKU at 1, a quantity ladder 2/6/11/21/8/3, a small cart near the freight
   thresholds, a contract price on the first SKU):
     · price_check answers identically (unit, line totals, tiers, pooled breaks, case packs, freight);
     · create stores identical orders and order lines (subtotal, freight_fee, estimated_total, units);
     · the dealer confirmation email is identical (text and HTML);
     · My Orders (order-history-api) reads back identical history from what was stored.
   It also proves version integrity end to end: a public file reordered / edited / newer / older than the
   stored record makes price_check AND create refuse (503), store nothing and send nothing. */
const path = require('path'), fs = require('fs');
const M = require(process.env.MOCK || path.join(__dirname, 'phase0-mock.js'));
const ROOT = process.env.CAT_ROOT || path.join(__dirname, '..', 'netlify', 'functions');
const CC = require(path.join(ROOT, '_catalog_commercial.js'));
const FF = require('./p0-fullfile.js');
const MFRS = JSON.parse(fs.readFileSync(process.env.MFRS_JSON || path.join(FF.ORD, 'public', 'data', 'manufacturers.json'), 'utf8'));
const HIST = path.join(ROOT, 'order-history-api.js');
const OB = 'https://ordering.test';
const norm = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
let fail = 0, pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 3).join('\n     ')); } }
const canon = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, k2) => (o[k2] = x[k2], o), {}) : x);
const eq = (a, b, w) => { const A = canon(a), B = canon(b); if (A !== B) { let i = 0; while (A[i] === B[i]) i++; throw new Error((w || '') + ' differ at ' + i + ': …' + A.slice(Math.max(0, i - 80), i + 80) + '  VS  …' + B.slice(Math.max(0, i - 80), i + 80)); } };
const ok = (c, w) => { if (!c) throw new Error(w); };
const copy = v => JSON.parse(JSON.stringify(v));
const VOLATILE = /^(id|order_id|created_at|submitted_at|updated_at|inserted_at|sent_at|at)$/;
const scrub = v => JSON.parse(JSON.stringify(v, (k, x) => (VOLATILE.test(k) ? undefined : typeof x === 'string' ? x.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>') : x)));
const LINES = { 'climbing-steps': 'Climbing Steps', 'strongback-mobility': 'Strongback Mobility', 'ovation-medical': 'Ovation Medical', 'bemis': 'Bemis' };
const SB_MODELS = new Set(['1003AB', '1012AB', '1017', '1007AB', '1010AB', '1019', '1036DB', 'ES0001', 'R0001']);

/* A synthetic master record from the same file (record mode): its prices, ladders, units — plus the
   Strongback models pool and a 4-pack — so pooled breaks and case packs are exercised identically. */
function syntheticRecord(slug, full) {
  const seen = new Set();
  return full.filter(r => r && r.code && !seen.has(r.code) && seen.add(r.code)).map(r => {
    const tiers = (Array.isArray(r.tiers) ? r.tiers : []).map(x => ({ min_qty: Number(x.min_qty != null ? x.min_qty : x.minQty), price: Number(x.price) }))
      .filter(x => isFinite(x.min_qty) && isFinite(x.price) && x.min_qty > 1);
    if (slug === 'strongback-mobility' && SB_MODELS.has(r.code)) tiers.forEach(x => { if (x.min_qty === 2) x.pool = 'strongback-models'; });
    const o = { manufacturer: slug, code: r.code, base_price: r.base_price != null ? Number(r.base_price) : null, tiers: tiers.length ? tiers : null,
                msrp: r.msrp != null ? Number(r.msrp) : null, map: r.map != null ? Number(r.map) : null, status: 'active', code_norm: norm(r.code) };
    if (r.code === 'A1005') { o.uom = '4-pack'; o.case_qty = 4; o.map_basis = 'each'; }
    else if (r.case_qty != null) { o.case_qty = Number(r.case_qty); o.uom = r.uom || 'Case'; }
    return o;
  });
}

function world(slug, { file, commercial, mode, full }) {
  const W = M.createWorld({ tokens: { dealer: 'd@x.com' }, tables: {
    app_settings: [{ key: 'platform_state', value: { mode: 'development' } }],
    manufacturers: [{ slug, name: LINES[slug] }], manufacturer_meta: [{ slug, record_authoritative: mode === 'record' }],
    dealers: [{ id: 'd1', parent_id: null, is_test: true, business_name: 'TEST dealer' }],
    dealer_users: [{ uid: 'u1', status: 'approved', dealer_id: 'd1', email: 'd@x.com' }],
    dealer_manufacturers: [{ dealer_id: 'd1', manufacturer: slug, active: true }],
    dealer_contract_prices: [{ dealer_id: 'd1', manufacturer: slug, code: full[0].code, price: 1.23, active: true }],
    product_overrides: [], custom_products: [], product_images: [], product_links: [], product_media: [], product_content: [],
    product_skus: mode === 'record' ? syntheticRecord(slug, full) : [],
    catalog_file_commercial: commercial || [],
    orders: [], order_items: [], tracking_requests: [], email_sends: [], intent_events: [], email_attribution: [] } });
  const inner = W.fetch;
  W.mail = [];
  W.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(M.BASE + '/auth/v1/user')) return { ok: true, status: 200, json: async () => ({ id: 'u1', email: 'd@x.com' }) };
    if (u === OB + '/data/manufacturers.json') return { ok: true, status: 200, json: async () => copy(MFRS), text: async () => JSON.stringify(MFRS) };
    if (u.startsWith(OB + '/data/content/')) return { ok: false, status: 404, json: async () => null, text: async () => '' };
    if (u.startsWith(OB + '/data/' + slug + '.json')) return { ok: true, status: 200, json: async () => copy(file), text: async () => JSON.stringify(file) };
    if (u.startsWith(OB + '/data/')) return { ok: false, status: 404, json: async () => null, text: async () => '' };
    if (u.startsWith('https://api.resend.com')) { W.mail.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ id: 'm' }) }; }
    (W.db.product_skus || []).forEach(r => { r.code_norm = norm(r.code); });
    return inner(url, opts);
  };
  return W;
}
const orders = W => M.load('orders-api.js', W, { ORDERING_BASE: OB, RESEND_API_KEY: 'k' }, ROOT);
const call = (C, body) => M.call(C, body, { headers: { authorization: 'Bearer dealer' } });
const DEALER = { business: 'TEST dealer', email: 'buyer@test.invalid', contact: 'Buyer' };

async function history(storedOrders, storedItems, slug) {
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE = 'svc';
  const rows = storedOrders.map((o, i) => Object.assign({}, o, { id: 'o' + i, submitted_at: '2026-10-23T12:00:00Z',
    order_items: storedItems.filter(it => it.order_id === o.id).map(it => Object.assign({}, it, { order_id: 'o' + i })) }));
  const saved = global.fetch;
  global.fetch = async (url) => { const u = String(url);
    const body = /auth\/v1\/user/.test(u) ? { id: 'u1', email: 'd@x.com' }
      : /dealer_users|dealers\?/.test(u) ? [{ dealer_id: 'd1', id: 'd1', auth_user_id: 'u1', status: 'approved', business_name: 'B', approved: true }]
      : /manufacturers\?/.test(u) ? [{ slug, name: LINES[slug] }]
      : /orders\?/.test(u) ? rows : [];
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }; };
  try { delete require.cache[require.resolve(HIST)]; const r = await require(HIST).handler({ httpMethod: 'POST', headers: { authorization: 'Bearer jwt' }, body: JSON.stringify({ action: 'history' }) });
        return JSON.parse(r.body); }
  finally { global.fetch = saved; }
}

(async () => {
  for (const slug of Object.keys(LINES)) {
    const full = FF.fullFile(slug), s = CC.splitCatalogFile(full);
    const rec = { manufacturer: slug, identity_sha256: CC.catalogIdentity(s.public), rows: s.overlay };
    const codes = [...new Set(full.map(r => r.code).filter(Boolean))];
    const LADDER = [2, 6, 11, 21, 8, 3];
    const carts = { 'every SKU at 1': codes.map(c => [c, 1]), 'quantity ladder': codes.map((c, i) => [c, LADDER[i % LADDER.length]]),
                    'small cart (freight thresholds)': codes.slice(0, 2).map(c => [c, 1]) };
    if (slug === 'strongback-mobility') carts['two models (pooled 2+) + a 4-pack'] = [['1003AB', 1], ['1017', 1], ['A1005', 2]].filter(([c]) => codes.includes(c));
    for (const mode of ['layers', 'record']) {
      await t(`${slug} · ${mode}: price_check, create, stored order, email and My Orders identical today vs P0 (${Object.keys(carts).length} carts)`, async () => {
        for (const [label, lines] of Object.entries(carts)) {
          const o = () => [{ manufacturer_slug: slug, manufacturer_name: LINES[slug], po: 'PO-' + label.length, items: lines.map(([code, qty]) => ({ code, qty, unit: 0 })) }];
          const A = world(slug, { file: full, mode, full }), B = world(slug, { file: s.public, commercial: [copy(rec)], mode, full });
          const pa = await call(orders(A), { action: 'price_check', orders: o() }), pb = await call(orders(B), { action: 'price_check', orders: o() });
          eq(pa.status, 200, label + ' today status ' + JSON.stringify(pa.body).slice(0, 200)); eq(pb.status, 200, label + ' P0 status ' + JSON.stringify(pb.body).slice(0, 200));
          eq(pb.body.orders, pa.body.orders, `${label}: price_check`);
          const priced = pa.body.orders[0].items.map(i => ({ code: i.code, qty: i.qty, unit: i.unit }));
          const sub = [{ manufacturer_slug: slug, manufacturer_name: LINES[slug], po: 'PO', items: priced }];
          const ca = await call(orders(A), { action: 'create', dealer: DEALER, orders: copy(sub) }), cb = await call(orders(B), { action: 'create', dealer: DEALER, orders: copy(sub) });
          eq(ca.status, 200, label + ' create today ' + JSON.stringify(ca.body).slice(0, 200)); eq(cb.status, 200, label + ' create P0 ' + JSON.stringify(cb.body).slice(0, 200));
          eq(scrub(cb.body), scrub(ca.body), `${label}: create answer`);
          ok(A.db.orders.length === 1 && B.db.orders.length === 1, 'one order stored each');
          eq(scrub(B.db.orders), scrub(A.db.orders), `${label}: stored order (subtotal, freight_fee, estimated_total …)`);
          eq(scrub(B.db.order_items), scrub(A.db.order_items), `${label}: stored order lines`);
          eq(scrub(B.mail), scrub(A.mail), `${label}: dealer confirmation email`);
          ok(A.mail.length >= 1, 'an email was rendered');
          const ha = await history(A.db.orders, A.db.order_items, slug), hb = await history(B.db.orders, B.db.order_items, slug);
          eq(hb, ha, `${label}: My Orders`);
          ok((ha.orders || []).length === 1 && ha.orders[0].total != null, 'My Orders shows the order with its total');
        }
      });
    }
    /* Version integrity, end to end on the real file. */
    const dup = (() => { const seen = {}; for (let i = 0; i < s.public.length; i++) { const c = s.public[i].code; if (c in seen) return [seen[c], i]; seen[c] = i; } return null; })();
    const bad = {
      'a non-commercial field edited (same codes, same row count)': () => { const p = copy(s.public); p[0].name = String(p[0].name) + ' (edited)'; return p; },
      'two rows swapped': () => { const p = copy(s.public); const [i, j] = dup || [0, 1]; [p[i], p[j]] = [p[j], p[i]]; return p; },
      'a row added (public file newer than the record)': () => copy(s.public).concat([{ manufacturer: slug, code: 'NEW-1', name: 'New' }]),
      'a row removed (public file older / record newer)': () => copy(s.public).slice(1),
    };
    for (const [why, mk] of Object.entries(bad)) {
      await t(`${slug}: ${why} → price_check and create refuse (503), nothing stored, nothing sent`, async () => {
        const W = world(slug, { file: mk(), commercial: [copy(rec)], mode: 'layers', full }); const C = orders(W);
        const lines = [{ manufacturer_slug: slug, items: codes.slice(0, 2).map(code => ({ code, qty: 1, unit: 1 })) }];
        const p = await call(C, { action: 'price_check', orders: copy(lines) });
        eq(p.status, 503, 'price_check'); ok(/catalog_version_not_seeded/.test(p.body.error), p.body.error);
        ok(!/"base_price"|"tiers"|"msrp"|"map"/.test(JSON.stringify(p.body)), 'commercial field in the refusal');
        const c = await call(C, { action: 'create', dealer: DEALER, orders: copy(lines) });
        eq(c.status, 503, 'create'); eq(W.db.orders.length + W.db.order_items.length, 0, 'stored'); eq(W.mail.length, 0, 'mail sent');
      });
    }
  }
  console.log(`\np0 order path: ${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
})();

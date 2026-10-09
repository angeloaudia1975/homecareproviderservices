/* SERVER PRICING — the final authority on what an order costs (Phase 2.7).

   The storefront prices a cart in the browser, and until now the order desk was sent whatever
   number the browser had: a saved cart re-priced nothing, and a modified page could post any
   price at all. This module computes the price on the server instead — and it does so by running
   the storefront's OWN product and pricing engine (_shop_engine.js, copied verbatim, with a test
   that fails the moment it drifts). There is no second pricing rule to keep in step: the layers,
   the colour fallback, the master record when a line is authoritative, the dealer's contract
   price, and quantity breaks on the family's combined quantity are all the shop's code.

   Every read is strict: a layer that cannot be read stops the pricing. An order is never priced
   from a partial catalog. */
const ENGINE = require("./_shop_engine.js");

const GOLDEN = new Set(["golden-technologies", "golden"]);
const isGolden = s => GOLDEN.has(String(s || ""));
const LIVE_QS = "status=in.(published,active)";
const enc = encodeURIComponent;

/* The catalog-feed wire shape, as homecareproviderservicesordering/netlify/functions/catalog-feed.js
   builds it (test/pricing-parity.test.js compares the two). */
function feedRows(rows) {
  const n = v => (v == null || v === "" ? null : Number(v));
  const out = [];
  (rows || []).forEach(r => {
    const o = { code: String(r.code) };
    if (r.option_label) o.option_label = r.option_label;
    if (n(r.base_price) != null) o.base_price = n(r.base_price);
    if (n(r.msrp) != null) o.msrp = n(r.msrp);
    if (r.msrp_auto === true) o.msrp_auto = true;
    else if (r.msrp_auto === false) o.msrp_auto = false;   // "no MSRP" is a fact, not an absence (2026-10-09)
    if (n(r.map) != null) o.map = n(r.map);
    if (Array.isArray(r.tiers) && r.tiers.length) {
      o.tiers = r.tiers
        .map(t => ({ min_qty: Number(t.min_qty), price: Number(t.price) }))
        .filter(t => isFinite(t.min_qty) && isFinite(t.price))
        .sort((a, b) => a.min_qty - b.min_qty);
      if (!o.tiers.length) delete o.tiers;
    }
    if (r.price_note) o.price_note = r.price_note;
    if (r.uom) o.uom = r.uom;
    if (r.hcpcs) o.hcpcs = r.hcpcs;
    if (n(r.case_qty) != null) o.case_qty = n(r.case_qty);
    out.push(o);
  });
  out.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return out;
}

/* Whether a migrated line prices from the record — catalog-feed.js's recordAuthority, copied
   (test/pricing-parity.test.js holds the two to the same answers). */
function recordAuthority(metaRows) {
  const m = Array.isArray(metaRows) && metaRows[0] ? metaRows[0] : null;
  if (!m) return { authoritative: false, note: "no manufacturer_meta row for this line" };
  if (m.record_resync_error)
    return { authoritative: false, note: "the record is behind the layers: " + String(m.record_resync_error) };
  if (m.record_authoritative !== true)
    return { authoritative: false, note: "this line still prices from the legacy layers" };
  return { authoritative: true, note: null };
}

/* Contract prices exactly as dealer-auth.js hands them to the shop: the master account's prices
   apply to its branches, a branch's own rows override. Keyed "slug::code". */
async function contractPrices(sb, dealerId) {
  const prices = {};
  if (!dealerId) return prices;
  const d = await sb("GET", `dealers?id=eq.${enc(dealerId)}&select=id,parent_id`);
  const rec = d && d[0];
  const ids = [dealerId]; if (rec && rec.parent_id) ids.push(rec.parent_id);
  const pr = await sb("GET", `dealer_contract_prices?dealer_id=in.(${ids.join(",")})&active=eq.true&select=dealer_id,manufacturer,code,price`);
  (pr || []).sort((a, b) => (a.dealer_id === dealerId ? 1 : 0) - (b.dealer_id === dealerId ? 1 : 0));
  for (const r of (pr || [])) if (r.manufacturer && r.code && r.price != null) prices[`${r.manufacturer}::${r.code}`] = Number(r.price);
  return prices;
}

/* One line's products, built by the shop's own mergeCatalogEdits with the server answering its
   reads. Returns { products, engine } — engine.unitPrice prices against the CART map given. */
async function lineProducts({ slug, sb, catalogFile, contentFile, contract, cart }) {
  const [file, metaRows] = await Promise.all([
    catalogFile(slug),
    sb("GET", `manufacturer_meta?slug=eq.${enc(slug)}&select=slug,enriched_only,category_map,record_authoritative,record_resync_error`),
  ]);
  const meta = (metaRows && metaRows[0]) || {};
  const failures = [];
  const shimFetch = async (url) => {
    const u = String(url);
    try {
      if (u.startsWith("https://engine.local/rest/v1/")) {
        let path = u.slice("https://engine.local/rest/v1/".length);
        /* The shop reads with the public key, which row-level security limits to pages that are
           not disabled; the service key is not limited, so the same filter is added here. */
        if (/^product_content\?/.test(path)) path += "&disabled=eq.false";
        const rows = await sb("GET", path);
        return { ok: true, status: 200, json: async () => rows || [] };
      }
      if (u.startsWith("/.netlify/functions/catalog-feed")) {
        const any = await sb("GET", `product_skus?manufacturer=eq.${enc(slug)}&select=code&limit=1`);
        const migrated = !!(any && any.length);
        const rows = migrated ? await sb("GET", `product_skus?manufacturer=eq.${enc(slug)}&status=eq.active&select=*&limit=10000`) : [];
        const auth = recordAuthority(metaRows);
        const authoritative = migrated && auth.authoritative;
        return { ok: true, status: 200, json: async () => ({ ok: true, manufacturer: slug, migrated, authoritative,
          authority_note: auth.note,
          skus: feedRows(rows), superseded: [], generated_at: new Date().toISOString() }) };
      }
      if (u.startsWith("./data/content/")) {
        /* The shop's static content fallback, read only when no live page exists. A missing file
           is a normal answer (404); a file that cannot be read is a failure. */
        const j = contentFile ? await contentFile(slug) : null;
        if (j == null) return { ok: false, status: 404, json: async () => null };
        return { ok: true, status: 200, json: async () => j };
      }
      throw new Error("unexpected engine read: " + u.slice(0, 120));
    } catch (e) { failures.push(String((e && e.message) || e)); throw e; }
  };
  const CONFIG = { SUPABASE_URL: "https://engine.local", SUPABASE_ANON: "server", CONTENT_APPROVED_ONLY: true };
  const state = { manufacturers: [{ slug, hasData: true, enrichedOnly: meta.enriched_only === true,
    categoryMap: (meta.category_map && typeof meta.category_map === "object") ? meta.category_map : null }] };
  const AUTH = { session: { access_token: "server" }, status: "approved", prices: contract || {} };
  const quiet = { log() {}, warn() {}, error() {} };
  const engine = new Function("fetch", "window", "console", "document", "CONFIG", "state", "AUTH", "PREVIEW", "CART",
    ENGINE.SOURCE + "\n;return { mergeCatalogEdits, unitPrice, CATALOG_SOURCE };")(shimFetch, {}, quiet, {}, CONFIG, state, AUTH, null, cart);
  const products = await engine.mergeCatalogEdits(slug, JSON.parse(JSON.stringify(file || [])));
  /* The shop forgives a failed read and carries on with what it has; an order may not. */
  if (failures.length) throw new Error("layer_unreadable: " + failures[0].slice(0, 300));
  const src = engine.CATALOG_SOURCE[slug] || {};
  return { products, engine, source: src.source || "layers" };
}

/* Price every line of every order. orders: [{manufacturer_slug, items:[{code, qty, unit?}]}].
   Returns { orders:[{manufacturer_slug, items:[{code, qty, unit, line_total, client_unit, changed,
   available, commercial}] , subtotal}], changed:boolean }. Golden orders are passed through
   untouched — Golden prices its own orders through its own commerce API. */
async function priceOrders({ orders, dealerId, sb, catalogFile, contentFile }) {
  const contract = await contractPrices(sb, dealerId);
  const cart = new Map();
  const bySlug = {};
  const slugs = [...new Set((orders || []).map(o => String(o.manufacturer_slug || o.manufacturer || "")).filter(s => s && !isGolden(s)))];
  for (const slug of slugs) bySlug[slug] = await lineProducts({ slug, sb, catalogFile, contentFile, contract, cart });
  /* The family quantity is the shop's: every cart line, priced from its CURRENT product. */
  const lines = [];
  (orders || []).forEach((o, oi) => {
    const slug = String(o.manufacturer_slug || o.manufacturer || "");
    (o.items || []).forEach((it, ii) => {
      const qty = Math.max(1, Math.round(Number(it.qty)) || 1);
      const L = bySlug[slug];
      /* A cart line is "manufacturer::code" in the shop. Where one code exists twice on a line
         (Access4U's SR3 and PRK are sold in two ramp families at two prices) the family the
         dealer chose decides; a code that cannot be told apart is not priced by guessing. */
      const same = L ? L.products.filter(x => String(x.code) === String(it.code)) : [];
      const fam = it.family == null ? null : String(it.family);
      const pick = fam != null ? same.filter(x => String(x.family || "") === fam) : same;
      const p = pick.length === 1 ? pick[0]
              : (pick.length > 1 && new Set(pick.map(x => x.base_price)).size === 1 ? pick[0] : null);
      if (p) cart.set(slug + "::" + p.code + "::" + oi + "::" + ii, { p, qty });
      lines.push({ oi, ii, slug, code: String(it.code), qty, p, client: it.unit == null ? null : Number(it.unit) });
    });
  });
  let changed = false;
  const out = (orders || []).map(o => Object.assign({}, o, { items: [] }));
  for (const l of lines) {
    const o = out[l.oi];
    if (isGolden(l.slug)) { o.items.push(Object.assign({}, orders[l.oi].items[l.ii])); continue; }
    /* Visible is not sellable: a discontinued product is shown for reference only. */
    if (!l.p || l.p._discontinued) {
      changed = true;
      o.items.push({ code: l.code, qty: l.qty, available: false, unit: null, line_total: null, client_unit: l.client, changed: true });
      continue;
    }
    const unit = Math.round(Number(bySlug[l.slug].engine.unitPrice(l.p, l.qty)) * 100) / 100;
    const diff = l.client == null || Math.abs(unit - l.client) >= 0.005;
    if (diff) changed = true;
    /* The contract price travels back too, so a browser holding a stale one from sign-in
       prices the next check the same way the server does instead of disagreeing forever. */
    const k = l.slug + "::" + l.p.code;
    /* The order unit is the server's too: a pack SKU (case_qty > 1) is priced and counted per pack. */
    const unitBits = {};
    if (l.p.uom) unitBits.uom = String(l.p.uom);
    if (Number(l.p.case_qty) > 1) unitBits.case_qty = Number(l.p.case_qty);
    o.items.push({ code: l.code, name: l.p.name, qty: l.qty, available: true, unit, ...unitBits,
      contract: contract[k] != null ? contract[k] : null,
      line_total: Math.round(unit * l.qty * 100) / 100, client_unit: l.client, changed: diff,
      commercial: { base_price: l.p.base_price, msrp: l.p.msrp, map: l.p.map, tiers: l.p.tiers || null,
                    group: l.p.group || "", manufacturer: l.slug, price_note: l.p.price_note || "" } });
  }
  out.forEach(o => { if (!isGolden(o.manufacturer_slug)) o.subtotal = Math.round(o.items.reduce((n, it) => n + (it.line_total || 0), 0) * 100) / 100; });
  return { orders: out, changed, contract_prices: Object.keys(contract).length };
}

/* The deployed catalog file and static content file, read from the storefront site. A missing
   file is a normal answer; any other failure stops the pricing. */
function remoteFiles(base) {
  const get = async (url, empty) => {
    const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
    if (r.status === 404) return empty;
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  };
  return {
    catalogFile: async slug => {
      const j = await get(`${base}/data/${encodeURIComponent(slug)}.json`, []);
      if (!Array.isArray(j)) throw new Error(`catalog file for ${slug} is not a list`);
      return j;
    },
    contentFile: slug => get(`${base}/data/content/${encodeURIComponent(slug)}.json`, null),
  };
}

module.exports = { priceOrders, lineProducts, contractPrices, feedRows, recordAuthority, isGolden, remoteFiles };

// golden-proxy — the Partner 360 dealer's ONLY route to Golden (Stage 1 eligibility, Stage 2 catalog + inventory).
// The browser never calls Golden and never holds an integration credential. This function:
//   1. identifies the signed-in dealer from their Partner 360 sign-in (Supabase JWT → approved dealer_users row)
//      or a staff "view as dealer" preview token (read-only role staff_preview);
//   2. maps HCPS's dealer to the canonical organisation (+ branch): a dealer row with parent_id is a BRANCH of
//      that parent (blueprint §3.2/§3.3);
//   3. asks Golden through the signed client (_golden_client.js) — Golden decides eligibility, prices and stock from
//      its own verified link and tables; HCPS only shows the answer and STORES NOTHING about Golden prices or stock
//      (every Supabase call here is a read — test-enforced).
// Switches (app_settings.phase2_flags, ON only when exactly true; missing/unreadable = OFF):
//   golden_p360_catalog        master switch for Golden inside Partner 360
//   golden_p360_pilot_dealers  array of HCPS dealer ids allowed while piloting (empty/missing = nobody)
// With the switch off the answer is { ok:true, enabled:false } and Golden is never called.
//   POST { action:"eligibility" | "catalog" | "inventory" | "family" | "config" | "quote" }
// quote (B4a, contract 1.4.0): POST { action:"quote", lines:[{sku,fabric,color,tier?,footrest?,qty}], split_order?, ship_to?:{id} }
//   → Golden POST /v1/quote. READ-ONLY: Golden prices every line and S&H; HCPS sends only the selection (never a price)
//   and passes back an allow-listed answer. Only a dealer whose Golden prices are visible gets amounts.
//   ship_to is { id } of one of Golden's own authorized ship-tos (action ship_to) — never a typed address.
// ship_to (B4b): → Golden GET /v1/ship-to — the addresses Golden holds for this dealer (a branch: only its own).
// validate_order (B4b): POST { action:"validate_order", idempotency_key (UUID v4, one per checkout attempt — never the
//   PO), quote_hash, lines[+reference_names], split_order?, ship_to:{id}, po_number?, contact:{name,phone,email?},
//   attention?, notes? } → Golden POST /v1/orders mode "validate". PLACES NOTHING (no order, reservation or email).
//   Golden re-prices and answers prices_changed with the new quote, or valid + the exact email previews. Allowed only
//   on the staff preview path, or when phase2_flags.golden_p360_checkout is exactly true (OFF).
// place_order (B6, contract 1.6.0): the SAME body and the SAME idempotency_key as the validate_order the dealer reviewed
//   → Golden POST /v1/orders mode "submit". GOLDEN places the order (one transaction with its idempotency record) and is
//   the only order of record — HCPS stores nothing. A retry with the same key replays Golden's first answer, so an
//   unknown outcome (timeout, 5xx, unreadable answer) is answered reason:"outcome_unknown", retry:true — the page retries
//   with the SAME key, never a new one. NEVER from a staff "view as dealer" token (any environment). Production needs
//   golden_p360_catalog + golden_p360_checkout + golden_p360_ordering (all exactly true, OFF) + the pilot list.
//   Preview environment: only a real dealer sign-in of a TEST dealership (dealers.is_test, and its head office) on a
//   Partner 360 deploy preview, behind phase2_flags.golden_p360_preview_orders (OFF) — Golden then places in TEST mode.
//
// Preview environment (Partner 360 deploy previews, for staff review): header `x-hcps-golden-env: preview` is honoured
// ONLY from a Partner 360 deploy-preview / branch address, for a staff "view as dealer" token, or (B6) a real dealer
// sign-in of a TEST dealership while phase2_flags.golden_p360_preview_orders is exactly true. It then
// talks to a Golden DEPLOY PREVIEW with the separate TEST key (_golden_client env "preview") — never production Golden,
// never the production key — and does not need the production switches. Anything else asking for preview is refused.
"use strict";
const { flags } = require("./_flags.js");
const GC = require("./_golden_client.js");

const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
// Same CORS as orders-api: authorization is the dealer's bearer token (no cookies), never the Origin.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, x-hcps-preview, x-hcps-golden-env",
  "access-control-allow-methods": "POST, OPTIONS" };
const json = (c, o) => ({ statusCode: c, headers: Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, CORS), body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
async function sbGet(path){ const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() }); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Partner 360 deploy previews and branch deploys (never the production storefront).
const ORDERING_PREVIEW_ORIGIN = /^https:\/\/(deploy-preview-\d+|(?!main--)[a-z0-9-]+)--hcpsonlineordering\.netlify\.app$/;   // never main-- (= production)
const ACTIONS = { eligibility: "/v1/eligibility", catalog: "/v1/catalog", inventory: "/v1/inventory", family: "/v1/catalog/family", config: "/v1/config", quote: "/v1/quote", ship_to: "/v1/ship-to", validate_order: "/v1/orders", place_order: "/v1/orders", history: "/v1/history", order: "/v1/orders/" };
const QUOTE_MAX_LINES = 30, QUOTE_MAX_QTY = 20;
const SHIP_ID_RE = /^(primary|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const IDEM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CFG_SKU_RE = /^PR\d{3}-[A-Z]{3}$/, CFG_COLOR_RE = /^[A-Z0-9]{3}$/, CFG_FABRICS = ["std","xover","brisa"], CFG_TIERS = ["standard","irheat","hvib","nirvana"];
const FAMILY_RE = /^[A-Z]{2}\d{3}[A-Z]?(?:-[A-Z0-9]{2,4})?$/;

// Only the fields the contract defines for a catalog product reach the browser (schema catalog_product).
const PRODUCT_KEYS = ["sku","family","family_name","name","category","subcategory","size_code","size_label","description","specs","zones",
  "class_ii","ribbon","color_note","badges","brochure_url","action","image","msrp","emap","sort"];
// Golden links only from Golden's own hosts (and the official document hosts Golden links to), never with a quote,
// space or angle bracket: the storefront puts photo URLs inside markup and onclick handlers.
const GOLDEN_HOSTS = /^https:\/\/(d3325uqufdmhie\.cloudfront\.net|cdn\.wdgtsrc\.com|goldenonlineordering\.netlify\.app|goldentech\.com|www\.goldentech\.com|www\.dropbox\.com\/scl\/fo\/|www\.flipsnack\.com\/oldforge\/|i\.ytimg\.com)/;
const httpsOrNull = v => (typeof v === "string" && GOLDEN_HOSTS.test(v) && !/["\s<>\\]/.test(v) && (!v.includes("'") || /^https:\/\/www\.dropbox\.com\//.test(v))) ? v : null;
function cleanProduct(p, pricesVisible){
  const o = {};
  for(const k of PRODUCT_KEYS) if(p[k] !== undefined) o[k] = p[k];
  o.image = httpsOrNull(p.image); o.brochure_url = httpsOrNull(p.brochure_url);
  for(const k of ["msrp","emap","sort"]) if(o[k] !== undefined && !(typeof o[k] === "number" && Number.isFinite(o[k]))) o[k] = null;
  for(const k of ["name","family","family_name","category","subcategory","size_code","size_label","description","zones","ribbon","color_note","action"]) if(o[k] != null && typeof o[k] !== "string") o[k] = null;
  if(o.badges != null && (typeof o.badges !== "object" || Array.isArray(o.badges))) o.badges = null;
  o.specs = Array.isArray(p.specs) ? p.specs.filter(x => typeof x === "string").slice(0, 12) : [];
  if(pricesVisible && (typeof p.dealer_price === "number" || p.dealer_price === null)){ o.dealer_price = p.dealer_price; o.price_source = p.price_source || null; }
  return o;
}

// One family's enriched detail (schema family_200 → `family`). Every field is rebuilt from an allow-list: strings
// stay strings, links must be https (videos only on youtube-nocookie), arrays are capped. Nothing else passes.
const str = (v, n) => (typeof v === "string" ? v.slice(0, n || 4000) : null);
const strs = (a, n, m) => (Array.isArray(a) ? a.filter(x => typeof x === "string").slice(0, m || 60).map(x => x.slice(0, n || 400)) : []);
const DOC_KINDS = ["sell_sheet","accessories_sheet","brochure","owners_manual","quick_start","option_manual","warranty","setup_instructions","document"];
function cleanFamily(f, pricesVisible){
  if(!f || typeof f !== "object") return null;
  const src = s => (s && typeof s === "object") ? { type: str(s.type, 200), url: httpsOrNull(s.url) } : null;
  const gallery = (Array.isArray(f.gallery) ? f.gallery : []).filter(g => g && httpsOrNull(g.url) && !/['"\s<>\\]/.test(g.url)).slice(0, 60).map(g => ({
    url: g.url, role: str(g.role, 40) || "product", skus: strs(g.skus, 40, 20), primary: g.primary === true, shared: g.shared === true,
    w: Number.isInteger(g.w) ? g.w : null, h: Number.isInteger(g.h) ? g.h : null, quality: str(g.quality, 20) }));
  let seenPrimary = false; gallery.forEach(g => { if(g.primary){ if(seenPrimary) g.primary = false; seenPrimary = true; } });
  const specs = f.specs && typeof f.specs === "object" ? f.specs : {};
  const cols = strs(specs.columns, 40, 20);
  const rows = (Array.isArray(specs.rows) ? specs.rows : []).slice(0, 120).filter(r => r && typeof r.label === "string" && r.values && typeof r.values === "object").map(r => {
    const v = {}; cols.forEach(c => { if(typeof r.values[c] === "string") v[c] = r.values[c].slice(0, 200); }); return { label: r.label.slice(0, 200), values: v, key: str(r.key, 40) }; });
  const unscoped = (Array.isArray(specs.website_unscoped) ? specs.website_unscoped : []).slice(0, 80).filter(r => r && typeof r.label === "string" && typeof r.value === "string").map(r => ({ label: r.label.slice(0, 200), value: r.value.slice(0, 200) }));
  const docs = (Array.isArray(f.documents) ? f.documents : []).filter(d => d && httpsOrNull(d.url) && DOC_KINDS.includes(d.kind)).slice(0, 40).map(d => ({
    kind: d.kind, title: str(d.title, 300) || "Golden document", url: d.url, format: str(d.format, 20), language: str(d.language, 8) || "en",
    pages: Number.isInteger(d.pages) ? d.pages : null, bytes: Number.isInteger(d.bytes) ? d.bytes : null,
    version: d.version && typeof d.version === "object" ? { revision: str(d.version.revision, 20), date: str(d.version.date, 20), basis: str(d.version.basis, 30) } : null,
    applies: str(d.applies, 300), note: str(d.note, 300), source: src(d.source) }));
  const videos = (Array.isArray(f.videos) ? f.videos : []).filter(v => v && /^[\w-]{11}$/.test(String(v.youtube_id))).slice(0, 20).map(v => ({
    youtube_id: v.youtube_id, title: str(v.title, 300), embed: "https://www.youtube-nocookie.com/embed/" + v.youtube_id,
    thumbnail: /^https:\/\/i\.ytimg\.com\//.test(String(v.thumbnail)) ? v.thumbnail : null, relevance: v.relevance === "product" ? "product" : "feature" }));
  const ft = f.features && typeof f.features === "object" ? f.features : {};
  const groups = Array.isArray(ft.groups) ? ft.groups.filter(g => g && typeof g.title === "string").slice(0, 8).map(g => ({ title: g.title.slice(0, 80), items: strs(g.items, 400, 40) })) : null;
  const compare = {}; Object.entries(f.compare && typeof f.compare === "object" ? f.compare : {}).slice(0, 30).forEach(([k, v]) => { if(/^[a-z_]{2,30}$/.test(k) && v && typeof v === "object"){ const o = { label: str(v.label, 120) }; cols.forEach(c => { if(typeof v[c] === "string") o[c] = v[c].slice(0, 120); }); compare[k] = o; } });
  return {
    family: str(f.family, 40), model: str(f.model, 20), name: str(f.name, 200), category: str(f.category, 80), subcategory: str(f.subcategory, 80),
    skus: (Array.isArray(f.skus) ? f.skus : []).filter(p => p && typeof p.sku === "string").map(p => cleanProduct(p, pricesVisible)),
    summary: str(f.summary, 2000), description: strs(f.description, 3000, 20), sell_sheet_description: str(f.sell_sheet_description, 3000), description_source: src(f.description_source),
    features: { standard: strs(ft.standard), optional: strs(ft.optional), accessories: strs(ft.accessories), benefits: strs(ft.benefits), groups,
      warranty_terms: Array.isArray(ft.warranty_terms) ? strs(ft.warranty_terms) : null, none_published: ft.none_published === true, source: src(ft.source) },
    specs: { columns: cols, rows, basis: str(specs.basis, 40), source: src(specs.source), website_unscoped: unscoped, website_unscoped_note: str(specs.website_unscoped_note, 300) },
    compare, gallery,
    fabrics: (Array.isArray(f.fabrics) ? f.fabrics : []).filter(x => x && typeof x.code === "string").slice(0, 40).map(x => ({ code: x.code.slice(0, 10), name: str(x.name, 80) || x.code, swatch: httpsOrNull(x.swatch), hex: /^#[0-9a-f]{6}$/i.test(String(x.hex)) ? x.hex : null })),
    documents: docs, videos, related: strs(f.related, 40, 20),
    page: f.page && httpsOrNull(f.page.url) ? { url: f.page.url, title: str(f.page.title, 200) } : null,
    enriched: f.enriched === true,
  };
}

// Golden's configurator answer (schema config_200 → `config`). Rebuilt from an allow-list: Golden decides every price,
// stock status, lead note and item #; HCPS only passes them on. Dealer prices only when Golden says prices are visible.
const num = v => (typeof v === "number" && Number.isFinite(v)) ? v : null;
const oneOf = (v, list) => list.includes(v) ? v : null;
const STATUS = ["in","low","out"];
function cleanConfig(c, pv, linked){
  if(!c || typeof c !== "object" || !CFG_SKU_RE.test(String(c.sku))) return null;
  const price = (o, k, v) => { if(pv && num(v) != null) o[k] = v; return o; };
  const qty = (o, v) => { if(linked && Number.isInteger(v)) o.qty = v; return o; };
  const noPrice = t => (typeof t === "string" && !pv) ? t.replace(/\s*\(?\+?\$[\d,.]+\)?/g, "").trim() : t;
  const out = {
    model: str(c.model, 20), rules_type: oneOf(c.rules_type, ["configurable","prebuilt","limited"]), sku: c.sku, tier: oneOf(c.tier, CFG_TIERS) || "standard",
    low_stock_threshold: Number.isInteger(c.low_stock_threshold) ? c.low_stock_threshold : 50,
    sizes: (Array.isArray(c.sizes) ? c.sizes : []).filter(x => x && CFG_SKU_RE.test(String(x.sku))).slice(0, 12).map(x =>
      price(qty({ sku: x.sku, code: str(x.code, 8), label: str(x.label, 40) || x.code, msrp: num(x.msrp), status: oneOf(x.status, ["in","out"]) }, x.qty), "dealer_price", x.dealer_price)),
    tabs: (Array.isArray(c.tabs) ? c.tabs : []).filter(t => t && CFG_FABRICS.includes(t.key)).map(t => price({ key: t.key, label: str(t.label, 40) || t.key,
      colors: (Array.isArray(t.colors) ? t.colors : []).filter(x => x && CFG_COLOR_RE.test(String(x.code))).slice(0, 40).map(x => qty({ code: x.code, name: str(x.name, 60) || x.code,
        hex: /^#[0-9a-f]{6}$/i.test(String(x.hex)) ? x.hex : null, swatch: httpsOrNull(x.swatch), status: oneOf(x.status, STATUS) || "out" }, x.qty)) }, "upcharge", t.upcharge)),
    tiers: { included: !!(c.tiers && c.tiers.included === true), included_text: str(c.tiers && c.tiers.included_text, 120),
      options: (c.tiers && Array.isArray(c.tiers.options) ? c.tiers.options : []).filter(o => o && CFG_TIERS.includes(o.key)).map(o => {
        const r = { key: o.key, msrp: num(o.msrp), prebuilt_status: o.prebuilt_status === "in" ? "in" : "none" }; if(linked && Number.isInteger(o.prebuilt)) r.prebuilt = o.prebuilt; return price(r, "upcharge", o.upcharge); }) },
    footrest: c.footrest && c.footrest.eligible === true ? price({ eligible: true, part: str(c.footrest.part, 20) }, "upcharge", c.footrest.upcharge) : { eligible: false },
  };
  const q = c.quote;
  if(q && q.ok === true && CFG_SKU_RE.test(String(q.sku))){
    out.quote = { ok: true, sku: q.sku, fabric: oneOf(q.fabric, CFG_FABRICS) || "std", color: CFG_COLOR_RE.test(String(q.color)) ? q.color : null, color_name: str(q.color_name, 60),
      tier: oneOf(q.tier, CFG_TIERS) || "standard", footrest: q.footrest === true, lead_note: str(q.lead_note, 200), in_stock: q.in_stock === true, custom: q.custom === true,
      item_no: /^[A-Z0-9-]{3,40}$/.test(String(q.item_no)) ? q.item_no : q.sku, item_no_resolved: q.item_no_resolved === true, upgrades: strs(q.upgrades, 120, 8).map(noPrice), details: noPrice(str(q.details, 400)) };
    if(pv){ if(num(q.unit_price) != null) out.quote.unit_price = q.unit_price; out.quote.breakdown = str(q.breakdown, 300); }
  }
  return out;
}

// Golden's quote answer (schema quote_200). Every field rebuilt from an allow-list; Golden decides every amount.
// HCPS shows it and STORES NOTHING. quote_hash is kept so Stage 4b can refuse an order whose prices changed.
const GROUPS = ["all","in_stock","build"];
function cleanQuote(g){
  const q = g && g.quote;
  if(!q || typeof q !== "object" || !Array.isArray(q.lines) || !q.totals || !/^[0-9a-f]{64}$/.test(String(q.quote_hash))) return null;
  const lines = q.lines.slice(0, QUOTE_MAX_LINES).filter(l => l && CFG_SKU_RE.test(String(l.sku)) && Number.isInteger(l.qty) && num(l.unit_price) != null && num(l.line_total) != null).map(l => ({
    line: Number.isInteger(l.line) ? l.line : null, sku: l.sku, qty: l.qty, fabric: oneOf(l.fabric, CFG_FABRICS) || "std",
    color: CFG_COLOR_RE.test(String(l.color)) ? l.color : null, color_name: str(l.color_name, 60), tier: oneOf(l.tier, CFG_TIERS) || "standard", footrest: l.footrest === true,
    unit_price: l.unit_price, line_total: l.line_total, details: str(l.details, 400), upgrades: strs(l.upgrades, 120, 8), breakdown: str(l.breakdown, 300), lead_note: str(l.lead_note, 200),
    in_stock: l.in_stock === true, custom: l.custom === true, item_no: /^[A-Z0-9-]{3,40}$/.test(String(l.item_no)) ? l.item_no : l.sku, item_no_resolved: l.item_no_resolved === true }));
  if(lines.length !== q.lines.length) return null;   // a line we cannot show faithfully = no quote, never a partial one
  const t = q.totals;
  for(const k of ["subtotal","sh_total","grand_total","sh_rate"]) if(num(t[k]) == null) return null;
  const totals = { subtotal: t.subtotal, sh_total: t.sh_total, grand_total: t.grand_total, sh_rate: t.sh_rate, sh_waived: t.sh_waived === true, split: t.split === true,
    shipments: (Array.isArray(t.shipments) ? t.shipments : []).filter(s => s && GROUPS.includes(s.group) && num(s.subtotal) != null && num(s.sh) != null).slice(0, 3).map(s => ({ group: s.group, subtotal: s.subtotal, sh: s.sh })) };
  return { lines, totals, freight: { included: false, note: str(q.freight && q.freight.note, 300) }, quote_hash: q.quote_hash };
}
function readQuoteBody(b){
  const ls = Array.isArray(b.lines) ? b.lines : null;
  if(!ls || !ls.length || ls.length > QUOTE_MAX_LINES) return null;
  const lines = [];
  for(const l of ls){
    if(!l || typeof l !== "object") return null;
    const sku = String(l.sku || "").trim().toUpperCase(), color = String(l.color || "").trim().toUpperCase();
    const fabric = String(l.fabric || "std").trim().toLowerCase(), tier = l.tier == null || l.tier === "" ? null : String(l.tier).trim().toLowerCase();
    const qty = Number(l.qty);
    if(!CFG_SKU_RE.test(sku) || !CFG_COLOR_RE.test(color) || !CFG_FABRICS.includes(fabric) || (tier !== null && !CFG_TIERS.includes(tier))) return null;
    if(!Number.isInteger(qty) || qty < 1 || qty > QUOTE_MAX_QTY || (l.footrest != null && typeof l.footrest !== "boolean")) return null;
    const o = { sku, fabric, color, qty }; if(tier) o.tier = tier; if(l.footrest === true) o.footrest = true;
    lines.push(o);   // nothing else from the browser is forwarded — never a price
  }
  const out = { lines, split_order: b.split_order === true };
  if(b.ship_to != null){
    const id = b.ship_to && typeof b.ship_to === "object" && !Array.isArray(b.ship_to) ? String(b.ship_to.id || "") : "";
    if(!SHIP_ID_RE.test(id)) return null;
    out.ship_to = { id };   // only the id of one of Golden's own records — never an address
  }
  return out;
}

// validate_order: the order fields Golden checks. Free text is rejected (not cleaned) when it holds markup or control
// characters, exactly as Golden does, so the dealer sees the problem instead of a silently changed order.
const TXT_BAD = /[<>\u0000-\u001F\u007F]/;
const TXT_INVISIBLE = /[\p{Cf}\u2028\u2029]/u;   // invisible / bidi format characters + line separators — the same set Golden refuses
const txt = (v, max, multiline) => {
  if(v == null || v === "") return "";
  if(typeof v !== "string") return null;
  const t = (multiline ? v.replace(/\r\n?/g, "\n") : v).trim();   // CRLF notes are normal line breaks (as Golden)
  if(t.length > max) return null;
  if(multiline ? /[<>\u0000-\u0009\u000B-\u001F\u007F]/.test(t) : TXT_BAD.test(t)) return null;
  if(TXT_INVISIBLE.test(t)) return null;
  return t;
};
function readValidateBody(b){
  const q = readQuoteBody(b);
  if(!q || !q.ship_to) return null;
  if(typeof b.quote_hash !== "string" || !/^[0-9a-f]{64}$/.test(b.quote_hash)) return null;
  const lines = q.lines.map((l, i) => {
    const raw = b.lines[i] || {}; const refs = [];
    if(raw.reference_names != null){
      if(!Array.isArray(raw.reference_names) || raw.reference_names.length > l.qty) return null;
      for(const n of raw.reference_names){ const t = txt(n, 40); if(t === null) return null; refs.push(t); }
      while(refs.length && !refs[refs.length - 1]) refs.pop();
    }
    return refs.length ? Object.assign({}, l, { reference_names: refs }) : l;
  });
  if(lines.some(l => l === null)) return null;
  const c = b.contact && typeof b.contact === "object" && !Array.isArray(b.contact) ? b.contact : null;
  if(!c) return null;
  const name = txt(c.name, 80), phone = txt(c.phone, 30), email = txt(c.email, 190);
  const po = txt(b.po_number, 30), attention = txt(b.attention, 60), notes = txt(b.notes, 500, true);
  if(!name || !phone || !/^[0-9+().\- xX]{7,30}$/.test(phone) || email === null || po === null || attention === null || notes === null) return null;
  if(po && !/^[A-Za-z0-9][A-Za-z0-9 \-_/#.]{0,29}$/.test(po)) return null;
  if(email && !/^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,120}\.[A-Za-z]{2,24}$/.test(email)) return null;
  const out = { mode: "validate", quote_hash: b.quote_hash, lines, ship_to: q.ship_to, contact: { name, phone } };
  if(email) out.contact.email = email;
  if(q.split_order) out.split_order = true;
  if(po) out.po_number = po;
  if(attention) out.attention = attention;
  if(notes) out.notes = notes;
  return out;
}
const cleanShip = x => (x && typeof x === "object" && SHIP_ID_RE.test(String(x.id))) ? { id: x.id, kind: oneOf(x.kind, ["primary","ship_location"]) || "ship_location",
  label: str(x.label, 80) || "Ship-to", address: str(x.address, 160) || "", city: str(x.city, 80) || "", state: str(x.state, 40) || "", zip: str(x.zip, 20) || "" } : null;
const reqId = v => (typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v)) ? v : null;   // Golden's request id, only in its known shape
const MAX_EMAIL_HTML = 400000;
// history / order (B5, contract 1.5.0): Golden's own order history + tracking. Allow-listed; amounts only when Golden
// says prices are visible. Never a contact, phone, email, note, street or ZIP (Golden does not send them either).
const ORDER_REF_RE = /^[PG][A-Za-z0-9-]{1,40}$/;
const HSTATUS = ["submitted","pending_review","acknowledged","processing","revised","partially_shipped","shipped","invoiced","completed","cancelled"];
const HEVENTS = ["submitted","booked","revised","invoiced","shipped","replacement","resubmitted"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = v => (typeof v === "string" && DAY_RE.test(v)) ? v : null;
function cleanHistoryOrder(o, pv){
  if(!o || typeof o !== "object" || !ORDER_REF_RE.test(String(o.order_ref)) || !HSTATUS.includes(o.status) || !["portal","golden","linked"].includes(o.source)) return null;
  const out = { order_ref: o.order_ref, source: o.source, status: o.status, placed_on: day(o.placed_on), po_number: str(o.po_number, 60) || "",
    so_numbers: strs(o.so_numbers, 40, 20), ship_to: { city: str(o.ship_to && o.ship_to.city, 80) || "", state: str(o.ship_to && o.ship_to.state, 40) || "" }, expected_date: day(o.expected_date),
    items: (Array.isArray(o.items) ? o.items : []).slice(0, 200).filter(i => i && typeof i.sku === "string" && i.sku).map(i => ({ sku: i.sku.slice(0, 40), description: str(i.description, 200) || "", qty: Number.isInteger(i.qty) ? i.qty : null })),
    tracking: (Array.isArray(o.tracking) ? o.tracking : []).slice(0, 20).filter(x => x && typeof x === "object").map(x => ({ so_number: str(x.so_number, 40) || "", carrier: str(x.carrier, 60) || "",
      tracking_number: (typeof x.tracking_number === "string" && /^[A-Za-z0-9 -]{0,80}$/.test(x.tracking_number)) ? x.tracking_number : "", ship_date: day(x.ship_date) })),
    lifecycle: (Array.isArray(o.lifecycle) ? o.lifecycle : []).slice(0, 50).filter(e => e && HEVENTS.includes(e.type)).map(e => ({ type: e.type, at: day(e.at), so_number: str(e.so_number, 40) || null, label: str(e.label, 160) || "" })) };
  if(pv && o.totals && typeof o.totals === "object") out.totals = { subtotal: num(o.totals.subtotal), freight: num(o.totals.freight), sh: num(o.totals.sh), total: num(o.totals.total) };
  return out;
}
// The order + quote Golden answered for THIS request (validate or placement): allow-listed, all-or-nothing.
function cleanOrderView(g, sentHash){
  const q = cleanQuote(g);
  const o = g && g.order;
  if(!q || !o || typeof o !== "object") return null;
  const ship = cleanShip(o.ship_to);
  if(!ship) return null;
  const raw = Array.isArray(o.lines) ? o.lines : [];
  if(raw.length > QUOTE_MAX_LINES || raw.length !== q.lines.length || raw.some(l => !l || !CFG_SKU_RE.test(String(l.sku)))) return null;   // all-or-nothing, as the quote
  if(String(q.quote_hash) !== String(sentHash)) return null;   // an answer for another quote is not this order
  const lines = raw.map(l => ({ sku: l.sku, reference_names: strs(l.reference_names, 40, QUOTE_MAX_QTY) }));
  return {
    order: { po_number: str(o.po_number, 30) || "", po_auto: o.po_auto === true, ship_to: ship,
      contact: { name: str(o.contact && o.contact.name, 80) || "", phone: str(o.contact && o.contact.phone, 30) || "", email: str(o.contact && o.contact.email, 190) || "" },
      attention: str(o.attention, 60) || "", notes: str(o.notes, 500) || "", delivery_type: "business", split_order: o.split_order === true, lines },
    quote: q,
  };
}
function cleanValidation(g, sentHash){
  if(!g || g.mode !== "validate" || g.valid !== true || typeof g.ordering_enabled !== "boolean") return null;
  const v = cleanOrderView(g, sentHash);
  const e = g.emails || {}, go = e.golden_order || {}, dc = e.dealer_confirmation;
  if(!v || typeof go.html !== "string" || go.html.length > MAX_EMAIL_HTML || typeof go.subject !== "string") return null;
  return {
    order: v.order, quote: v.quote, ordering_enabled: g.ordering_enabled, test_mode: g.test_mode === true,
    emails: {
      golden_order: { recipient: go.recipient === "test_recipient" ? "test_recipient" : "golden_order_desk", recipient_configured: go.recipient_configured === true, subject: go.subject.slice(0, 300), html: go.html },
      dealer_confirmation: dc && typeof dc === "object" && typeof dc.html === "string" && dc.html.length <= MAX_EMAIL_HTML
        ? { to: str(dc.to, 190) || "", subject: str(dc.subject, 300) || "", html: dc.html, text: str(dc.text, 4000) || "" } : null,
    },
  };
}

// Golden's placement answer (201): the order of record is Golden's; HCPS only shows it.
const PLACED_REF_RE = /^P\d{1,12}$/;
const NOTE_STATES = ["sent","failed","not_configured","suppressed","none"];
function cleanPlacement(g, sentHash){
  if(!g || g.mode !== "submit" || g.placed !== true || g.status !== "submitted" || !PLACED_REF_RE.test(String(g.order_ref))) return null;
  const v = cleanOrderView(g, sentHash);
  if(!v) return null;
  const n = g.notifications && typeof g.notifications === "object" ? g.notifications : null;
  return { order_ref: g.order_ref, status: "submitted", placed_at: str(g.placed_at, 40), test_mode: g.test_mode === true, order: v.order, quote: v.quote,
    notifications: n ? { order_desk: oneOf(n.order_desk, NOTE_STATES) || "failed", dealer_confirmation: oneOf(n.dealer_confirmation, NOTE_STATES) || "failed" } : null };
}

async function dealerFromToken(event){
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim(); if(!tok) return null;
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
  if(!ur.ok) return null;
  const u = await ur.json(); if(!u || !u.id) return null;
  const rows = await sbGet(`dealer_users?uid=eq.${encodeURIComponent(u.id)}&select=status,dealer_id`);
  const du = rows && rows[0];
  if(!du || du.status !== "approved" || !du.dealer_id) return null;
  return { dealer_id: du.dealer_id, actor: u.id, preview: false };
}
async function dealerFromPreview(event){
  const t = String(event.headers["x-hcps-preview"] || event.headers["X-HCPS-Preview"] || "").trim();
  if(!/^[0-9a-f]{48}$/.test(t)) return null;
  const rows = await sbGet(`dealer_preview_tokens?token=eq.${encodeURIComponent(t)}&select=dealer_id,expires_at`);
  const r = rows && rows[0]; if(!r || !r.dealer_id) return null;
  if(r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return null;
  return { dealer_id: r.dealer_id, actor: "staff-preview", preview: true };
}

// A TEST dealership: the dealer row AND its head office (when it is a branch) are marked dealers.is_test. Strict read.
async function testDealership(dealerId){
  const rows = await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=id,parent_id,is_test`);
  const d = rows && rows[0]; if(!d || d.is_test !== true) return false;
  if(!d.parent_id) return true;
  const p = await sbGet(`dealers?id=eq.${encodeURIComponent(d.parent_id)}&select=id,is_test`);
  return !!(p && p[0] && p[0].is_test === true);
}
// HCPS dealer row → canonical { sub_dealer (organisation), sub_branch }.
async function canonical(dealerId){
  const rows = await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=id,parent_id`);
  const d = rows && rows[0]; if(!d) return null;
  return d.parent_id ? { sub_dealer: d.parent_id, sub_branch: d.id } : { sub_dealer: d.id, sub_branch: null };
}

exports.handler = async (event) => {
  if(event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  try{
    if(!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok:false, error:"server not configured" });
    if(event.httpMethod !== "POST") return json(405, { ok:false, error:"method not allowed" });
    let b; try{ b = JSON.parse(event.body || "{}"); }catch{ return json(400, { ok:false, error:"bad JSON" }); }
    const action = b.action;
    if(!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return json(400, { ok:false, error:"unknown action" });
    const family = action === "family" ? String(b.family || "").trim().toUpperCase() : null;
    if(action === "family" && !FAMILY_RE.test(family)) return json(400, { ok:false, error:"bad family" });
    let cfgQuery = null;
    if(action === "config"){
      const sku = String(b.sku || "").trim().toUpperCase(), color = String(b.color || "").trim().toUpperCase();
      const fabric = String(b.fabric || "std").trim().toLowerCase(), tier = String(b.tier || "").trim().toLowerCase();
      if(!CFG_SKU_RE.test(sku) || (color && !CFG_COLOR_RE.test(color)) || !CFG_FABRICS.includes(fabric) || (tier && !CFG_TIERS.includes(tier))) return json(400, { ok:false, error:"bad configuration" });
      cfgQuery = { sku, fabric };
      if(color) cfgQuery.color = color;
      if(tier) cfgQuery.tier = tier;
      if(b.footrest === true) cfgQuery.footrest = "1";
    }
    let histQuery = null, histRef = null;
    if(action === "history"){
      histQuery = {};
      if(b.limit != null){ if(!Number.isInteger(b.limit) || b.limit < 1 || b.limit > 50) return json(400, { ok:false, error:"bad limit" }); histQuery.limit = String(b.limit); }
      if(b.before != null){ if(typeof b.before !== "string" || !ORDER_REF_RE.test(b.before)) return json(400, { ok:false, error:"bad before" }); histQuery.before = b.before; }
    }
    if(action === "order"){ if(typeof b.order_ref !== "string" || !ORDER_REF_RE.test(b.order_ref)) return json(400, { ok:false, error:"bad order" }); histRef = b.order_ref; }
    let quoteBody = null, idemKey = null;
    if(action === "quote"){ quoteBody = readQuoteBody(b); if(!quoteBody) return json(400, { ok:false, error:"bad quote" }); }
    if(action === "validate_order" || action === "place_order"){
      if(typeof b.idempotency_key !== "string" || !IDEM_RE.test(b.idempotency_key)) return json(400, { ok:false, error:"bad idempotency key" });
      idemKey = b.idempotency_key.toLowerCase();
      quoteBody = readValidateBody(b); if(!quoteBody) return json(400, { ok:false, error:"bad order" });
      if(action === "place_order") quoteBody.mode = "submit";   // the SAME body as the reviewed validation; only the mode differs
    }
    const ordering = action === "place_order";

    let who = null;
    try{ who = (await dealerFromToken(event)) || (await dealerFromPreview(event)); }
    catch(e){ return json(503, { ok:false, error:"sign-in could not be checked" }); }
    if(!who) return json(401, { ok:false, error:"unauthorized" });

    const hdr = k => String((event.headers || {})[k] || (event.headers || {})[k.toLowerCase()] || "");
    const wantsPreview = hdr("x-hcps-golden-env").trim().toLowerCase() === "preview";
    let envName = null, hcpsOrdering = false;   // may THIS sign-in place orders (HCPS's own switches)? Golden decides the rest.
    // A staff "view as dealer" token never places an order — in any environment.
    if(ordering && who.preview) return json(403, { ok:false, error:"preview_not_allowed" });
    if(wantsPreview){
      const origin = (hdr("origin") || hdr("Origin")).trim();
      if(!ORDERING_PREVIEW_ORIGIN.test(origin)) return json(403, { ok:false, error:"preview_not_allowed" });
      if(!who.preview){
        // A real dealer sign-in may use Golden's preview environment only for a TEST dealership, behind its own switch.
        let pf; try{ pf = await flags(sbGet); }catch(e){ return json(503, { ok:false, error:"switches could not be read" }); }
        if(pf.golden_p360_preview_orders !== true) return json(403, { ok:false, error:"preview_not_allowed" });
        let isTest = false;
        try{ isTest = await testDealership(who.dealer_id); }catch(e){ return json(503, { ok:false, error:"dealer could not be read" }); }
        if(!isTest) return json(403, { ok:false, error:"preview_not_allowed" });
      }
      if(!GC.configured("preview")) return json(200, { ok:true, enabled:false, preview:true, reason:"golden_preview_not_configured" });
      envName = "preview"; hcpsOrdering = !who.preview;
    } else {
      // A staff "view as dealer" token never reaches Golden's production ordering path (it is a preview of the dealer).
      // ... nor reads a real dealer's production order history (history / order are preview-environment only for staff).
      if(who.preview && (action === "validate_order" || action === "history" || action === "order")) return json(403, { ok:false, error:"preview_not_allowed" });
      const f = await flags(sbGet);
      const pilot = Array.isArray(f.golden_p360_pilot_dealers) ? f.golden_p360_pilot_dealers.map(String) : [];
      if(f.golden_p360_catalog !== true) return json(200, { ok:true, enabled:false, reason:"switched_off" });
      if((action === "validate_order" || ordering) && f.golden_p360_checkout !== true) return json(200, { ok:true, enabled:false, reason:"checkout_switched_off" });
      if(ordering && f.golden_p360_ordering !== true) return json(200, { ok:true, enabled:false, reason:"ordering_switched_off" });
      hcpsOrdering = !who.preview && f.golden_p360_checkout === true && f.golden_p360_ordering === true;
      if((action === "history" || action === "order") && f.golden_p360_history !== true) return json(200, { ok:true, enabled:false, reason:"history_switched_off" });
      who.pilot = pilot;
    }

    let c; try{ c = await canonical(who.dealer_id); }catch(e){ return json(503, { ok:false, error:"dealer could not be read" }); }
    if(!c || !UUID_RE.test(String(c.sub_dealer)) || (c.sub_branch && !UUID_RE.test(String(c.sub_branch)))) return json(200, { ok:true, enabled:false, reason:"dealer_not_found" });
    if(!envName && !who.pilot.includes(String(c.sub_dealer)) && !who.pilot.includes(String(who.dealer_id))) return json(200, { ok:true, enabled:false, reason:"not_in_pilot" });

    const role = who.preview ? "staff_preview" : (c.sub_branch ? "branch_user" : "dealer");
    const r = await GC.call({ method: (action === "quote" || action === "validate_order" || ordering) ? "POST" : "GET", path: histRef ? ACTIONS.order + encodeURIComponent(histRef) : ACTIONS[action], env: envName || undefined, query: quoteBody ? undefined : (family ? { family } : (cfgQuery || histQuery || undefined)), body: quoteBody || undefined, idempotencyKey: idemKey || undefined,
      delegation: { sub_dealer: c.sub_dealer, sub_branch: c.sub_branch, actor: who.actor, role } });
    const extra = envName ? { preview:true } : {};
    if(r.configured === false) return json(200, Object.assign({ ok:true, enabled:false, reason:"golden_not_configured" }, extra));
    if(!r.ok && action === "config" && r.status === 400 && r.error === "bad_request") return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"not_offered" }, extra));
    if(!r.ok && (action === "family" || action === "config") && r.status === 404) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"not_found" }, extra));
    if(!r.ok && action === "validate_order"){
      const g0 = r.json || {}, code = g0.error && g0.error.code;
      if(r.status === 409 && code === "prices_changed"){
        const q = cleanQuote(g0);
        return json(200, Object.assign({ ok:true, enabled:true, available:true, valid:false, reason:"prices_changed", idempotent_replay: g0.idempotent_replay === true, quote: q, request_id: reqId(g0.request_id) }, extra));
      }
      const map = { internal:"temporarily_unavailable", prices_not_visible:"prices_not_visible", idempotency_conflict:"idempotency_conflict", idempotency_in_progress:"idempotency_in_progress", pricing_unavailable:"pricing_unavailable", ordering_disabled:"ordering_disabled" };
      const msg = g0.error && typeof g0.error.message === "string" ? g0.error.message : "";
      if(r.status === 400 && code === "bad_request"){
        const field = /^(ship_to|po_required|po_number|attention|notes|contact\.(name|phone|email)|(reference_names|color|qty|sku|fabric|tier|footrest)@\d{1,2})$/.test(msg) ? msg : "order";
        return json(200, Object.assign({ ok:true, enabled:true, available:true, valid:false, reason:"invalid", field }, extra));
      }
      if(r.status === 404) return json(200, Object.assign({ ok:true, enabled:true, available:true, valid:false, reason:"not_found" }, extra));
      if(map[code]) return json(200, Object.assign({ ok:true, enabled:true, available: code !== "prices_not_visible", valid:false, reason: map[code], retry: code === "idempotency_in_progress" || (r.status === 503) }, extra));
    }
    if(ordering && !(r.ok && r.status === 201)){
      // Placement: only a DEFINITE refusal says "not placed". Anything else may have placed the order — the page retries
      // with the SAME key (Golden replays its first answer), never a new one.
      const g0 = r.json || {}, code = g0.error && g0.error.code;
      const base = { ok:true, enabled:true, available:true, placed:false };
      if(r.status === 409 && code === "prices_changed") return json(200, Object.assign(base, { reason:"prices_changed", new_attempt:true, idempotent_replay: g0.idempotent_replay === true, quote: cleanQuote(g0), request_id: reqId(g0.request_id) }, extra));
      const definite = { not_validated:"revalidate", validation_expired:"revalidate", idempotency_conflict:"idempotency_conflict", duplicate_po:"duplicate_po",
        ordering_disabled:"ordering_unavailable", ordering_not_enabled:"ordering_unavailable", ordering_not_permitted:"ordering_unavailable", branch_ordering_not_permitted:"ordering_unavailable",
        scope:"ordering_unavailable", prices_not_visible:"ordering_unavailable", not_linked:"ordering_unavailable", branch_not_permitted:"ordering_unavailable" };
      if(r.status === 400 && code === "bad_request"){
        const msg = g0.error && typeof g0.error.message === "string" ? g0.error.message : "";
        const field = /^(ship_to|po_required|po_number|attention|notes|contact\.(name|phone|email)|(reference_names|color|qty|sku|fabric|tier|footrest)@\d{1,2})$/.test(msg) ? msg : "order";
        return json(200, Object.assign(base, { reason:"invalid", field, new_attempt:true }, extra));
      }
      if(r.status >= 400 && r.status < 500 && definite[code]) return json(200, Object.assign(base, { reason: definite[code], new_attempt: definite[code] !== "ordering_unavailable" }, extra));
      if(r.status === 404 && code === "not_found") return json(200, Object.assign(base, { reason:"not_found", new_attempt:true }, extra));
      if(r.status === 409 && code === "pricing_unavailable") return json(200, Object.assign(base, { reason:"pricing_unavailable", new_attempt:true }, extra));
      if(r.ok) console.warn("golden-proxy: unexpected placement status", JSON.stringify({ status: r.status, env: envName || "production" }));
      else console.warn("golden-proxy: placement outcome unknown", JSON.stringify({ status: r.status, code: r.error, env: envName || "production" }));
      return json(200, Object.assign({ ok:true, enabled:true, available:true, placed:null, reason:"outcome_unknown", retry:true }, extra));
    }
    if(ordering){
      const p = cleanPlacement(r.json || {}, quoteBody.quote_hash);
      if(!p){ console.warn("golden-proxy: placement answer unreadable", JSON.stringify({ env: envName || "production" }));
        return json(200, Object.assign({ ok:true, enabled:true, available:true, placed:null, reason:"outcome_unknown", retry:true }, extra)); }
      return json(200, Object.assign({ ok:true, enabled:true, available:true, placed:true, idempotent_replay: (r.json || {}).idempotent_replay === true, request_id: reqId((r.json || {}).request_id) }, p, extra));
    }
    if(!r.ok && (action === "history" || action === "order")){
      const code = r.error, reasons = { history_not_enabled:"history_not_enabled", branch_history_not_permitted:"branch_history_not_permitted", not_linked:"not_linked", history_unavailable:"history_unavailable" };
      if(r.status === 404 && action === "order") return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"not_found" }, extra));
      if(reasons[code]) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason: reasons[code], retry: code === "history_unavailable" }, extra));
    }
    if(!r.ok && action === "ship_to" && r.status === 403 && (r.json && r.json.error && r.json.error.code) === "prices_not_visible") return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"prices_not_visible" }, extra));
    if(!r.ok && action === "quote"){
      // Golden decides: a dealer without visible Golden prices, a line Golden won't build, or no price → no quote.
      const msg0 = r.json && r.json.error && typeof r.json.error.message === "string" ? r.json.error.message : "";
      const reason = r.status === 403 && r.error === "prices_not_visible" ? "prices_not_visible" : r.status === 404 ? "not_found" : (r.status === 400 && msg0 === "ship_to") ? "ship_to_invalid" : r.status === 400 ? "not_offered"
        : (r.status === 503 && r.error === "pricing_unavailable") ? "pricing_unavailable" : null;
      const msg = r.json && r.json.error && typeof r.json.error.message === "string" ? r.json.error.message : "";
      const line = /@(\d{1,2})$/.test(msg) ? Number(msg.match(/@(\d{1,2})$/)[1]) : null;
      if(reason) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason, line }, extra));
    }
    if(!r.ok){
      // Never guess: Golden's answer is the only source. Show "not available right now". The precise reason
      // (e.g. a key or signature problem) is logged here, never sent to the dealer's browser.
      console.warn("golden-proxy: Golden refused or unreachable", JSON.stringify({ action, status: r.status, code: r.error, env: envName || "production" }));
      const branch = r.status === 403 && r.error === "branch_not_permitted";
      return json(200, Object.assign({ ok:true, enabled:true, available:false, reason: branch ? "branch_not_permitted" : "golden_unavailable" }, extra));
    }
    const g = r.json || {};
    if(action === "eligibility"){
      const caps = g.capabilities || {};
      return json(200, Object.assign({ ok:true, enabled:true, available:true,
        state: g.state, reason: g.reason || null,
        capabilities: { see_prices: caps.see_prices === true, order: caps.order === true && !who.preview, history: caps.history === true },
        order_route: who.preview ? null : (g.order_route || null),
        request_id: reqId(g.request_id) }, extra));
    }
    if(action === "catalog"){
      const pv = g.prices_visible === true;
      const products = (Array.isArray(g.products) ? g.products : []).filter(p => p && typeof p.sku === "string").map(p => cleanProduct(p, pv));
      return json(200, Object.assign({ ok:true, enabled:true, available:true, prices_visible: pv, linked: g.linked === true,
        as_of: g.as_of || null, etag: typeof g.etag === "string" ? g.etag : null, products, request_id: reqId(g.request_id) }, extra));
    }
    if(action === "family"){
      const pv = g.prices_visible === true;
      const fam = cleanFamily(g.family, pv);
      if(!fam) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"golden_unavailable" }, extra));
      return json(200, Object.assign({ ok:true, enabled:true, available:true, prices_visible: pv, linked: g.linked === true,
        enrichment_as_of: str(g.enrichment_as_of, 30), etag: typeof g.etag === "string" ? g.etag : null, family: fam, request_id: reqId(g.request_id) }, extra));
    }
    if(action === "config"){
      const pv = g.prices_visible === true;
      const cfg = cleanConfig(g.config, pv, g.linked === true);
      if(!cfg) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"golden_unavailable" }, extra));
      return json(200, Object.assign({ ok:true, enabled:true, available:true, prices_visible: pv, linked: g.linked === true, engine: /^[0-9a-f]{16}$/.test(String(g.engine)) ? g.engine : null,
        etag: typeof g.etag === "string" ? g.etag : null, config: cfg, request_id: reqId(g.request_id) }, extra));
    }
    if(action === "ship_to"){
      const list = (Array.isArray(g.ship_to) ? g.ship_to : []).slice(0, 50).map(cleanShip).filter(Boolean);
      return json(200, Object.assign({ ok:true, enabled:true, available:true, scope: g.scope === "branch" ? "branch" : "account", ship_to: list, request_id: reqId(g.request_id) }, extra));
    }
    if(action === "history" || action === "order"){
      const pv = g.prices_visible === true;
      if(action === "order"){
        const o = cleanHistoryOrder(g.order, pv);
        if(!o || o.order_ref !== histRef) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"golden_unavailable" }, extra));
        return json(200, Object.assign({ ok:true, enabled:true, available:true, prices_visible: pv, order: o, request_id: reqId(g.request_id) }, extra));
      }
      const raw = Array.isArray(g.orders) ? g.orders : null;
      const list = raw ? raw.slice(0, 50).map(o => cleanHistoryOrder(o, pv)) : null;
      if(!list || list.some(o => !o)) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"golden_unavailable" }, extra));   // all-or-nothing
      return json(200, Object.assign({ ok:true, enabled:true, available:true, prices_visible: pv, orders: list,
        next_before: (typeof g.next_before === "string" && ORDER_REF_RE.test(g.next_before)) ? g.next_before : null, request_id: reqId(g.request_id) }, extra));
    }
    if(action === "validate_order"){
      const v = cleanValidation(g, quoteBody.quote_hash);
      if(!v) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"golden_unavailable" }, extra));
      v.ordering_enabled = v.ordering_enabled === true && hcpsOrdering;   // the Place order button needs Golden AND HCPS
      return json(200, Object.assign({ ok:true, enabled:true, available:true, valid:true, idempotent_replay: g.idempotent_replay === true, request_id: reqId(g.request_id) }, v, extra));
    }
    if(action === "quote"){
      const q = cleanQuote(g);
      if(!q || g.ordering_enabled !== false) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"golden_unavailable" }, extra));
      return json(200, Object.assign({ ok:true, enabled:true, available:true, as_of: str(g.as_of, 40), engine: /^[0-9a-f]{16}$/.test(String(g.engine)) ? g.engine : null,
        sh_terms_checked: g.sh_terms_checked === true, ship_to_id: SHIP_ID_RE.test(String(g.ship_to_id)) ? g.ship_to_id : null, ordering_enabled: false, quote: q, request_id: reqId(g.request_id) }, extra));
    }
    // inventory
    const items = (Array.isArray(g.items) ? g.items : []).filter(i => i && typeof i.sku === "string" && ["in","low","out","on_request"].includes(i.status))
      .map(i => ({ sku: i.sku, status: i.status, qty: Number.isInteger(i.qty) ? i.qty : null }));
    return json(200, Object.assign({ ok:true, enabled:true, available:true, as_of: g.as_of || null, stale: g.stale !== false,
      low_stock_threshold: Number.isInteger(g.low_stock_threshold) ? g.low_stock_threshold : 50, items, request_id: reqId(g.request_id) }, extra));
  }catch(e){
    console.error("golden-proxy error", e && e.message);
    return json(500, { ok:false, error:"golden-proxy failed" });
  }
};

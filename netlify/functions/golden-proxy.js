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
//   POST { action:"eligibility" | "catalog" | "inventory" }
//
// Preview environment (Partner 360 deploy previews, for staff review): header `x-hcps-golden-env: preview` is honoured
// ONLY for a staff "view as dealer" token AND a request from a Partner 360 deploy-preview / branch address. It then
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
const ACTIONS = { eligibility: "/v1/eligibility", catalog: "/v1/catalog", inventory: "/v1/inventory", family: "/v1/catalog/family" };
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

    let who = null;
    try{ who = (await dealerFromToken(event)) || (await dealerFromPreview(event)); }
    catch(e){ return json(503, { ok:false, error:"sign-in could not be checked" }); }
    if(!who) return json(401, { ok:false, error:"unauthorized" });

    const hdr = k => String((event.headers || {})[k] || (event.headers || {})[k.toLowerCase()] || "");
    const wantsPreview = hdr("x-hcps-golden-env").trim().toLowerCase() === "preview";
    let envName = null;
    if(wantsPreview){
      const origin = (hdr("origin") || hdr("Origin")).trim();
      if(!who.preview || !ORDERING_PREVIEW_ORIGIN.test(origin)) return json(403, { ok:false, error:"preview_not_allowed" });
      if(!GC.configured("preview")) return json(200, { ok:true, enabled:false, preview:true, reason:"golden_preview_not_configured" });
      envName = "preview";
    } else {
      const f = await flags(sbGet);
      const pilot = Array.isArray(f.golden_p360_pilot_dealers) ? f.golden_p360_pilot_dealers.map(String) : [];
      if(f.golden_p360_catalog !== true) return json(200, { ok:true, enabled:false, reason:"switched_off" });
      who.pilot = pilot;
    }

    let c; try{ c = await canonical(who.dealer_id); }catch(e){ return json(503, { ok:false, error:"dealer could not be read" }); }
    if(!c || !UUID_RE.test(String(c.sub_dealer)) || (c.sub_branch && !UUID_RE.test(String(c.sub_branch)))) return json(200, { ok:true, enabled:false, reason:"dealer_not_found" });
    if(!envName && !who.pilot.includes(String(c.sub_dealer)) && !who.pilot.includes(String(who.dealer_id))) return json(200, { ok:true, enabled:false, reason:"not_in_pilot" });

    const role = who.preview ? "staff_preview" : (c.sub_branch ? "branch_user" : "dealer");
    const r = await GC.call({ method:"GET", path: ACTIONS[action], env: envName || undefined, query: family ? { family } : undefined,
      delegation: { sub_dealer: c.sub_dealer, sub_branch: c.sub_branch, actor: who.actor, role } });
    const extra = envName ? { preview:true } : {};
    if(r.configured === false) return json(200, Object.assign({ ok:true, enabled:false, reason:"golden_not_configured" }, extra));
    if(!r.ok && action === "family" && r.status === 404) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"not_found" }, extra));
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
        request_id: g.request_id || null }, extra));
    }
    if(action === "catalog"){
      const pv = g.prices_visible === true;
      const products = (Array.isArray(g.products) ? g.products : []).filter(p => p && typeof p.sku === "string").map(p => cleanProduct(p, pv));
      return json(200, Object.assign({ ok:true, enabled:true, available:true, prices_visible: pv, linked: g.linked === true,
        as_of: g.as_of || null, etag: typeof g.etag === "string" ? g.etag : null, products, request_id: g.request_id || null }, extra));
    }
    if(action === "family"){
      const pv = g.prices_visible === true;
      const fam = cleanFamily(g.family, pv);
      if(!fam) return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"golden_unavailable" }, extra));
      return json(200, Object.assign({ ok:true, enabled:true, available:true, prices_visible: pv, linked: g.linked === true,
        enrichment_as_of: str(g.enrichment_as_of, 30), etag: typeof g.etag === "string" ? g.etag : null, family: fam, request_id: g.request_id || null }, extra));
    }
    // inventory
    const items = (Array.isArray(g.items) ? g.items : []).filter(i => i && typeof i.sku === "string" && ["in","low","out","on_request"].includes(i.status))
      .map(i => ({ sku: i.sku, status: i.status, qty: Number.isInteger(i.qty) ? i.qty : null }));
    return json(200, Object.assign({ ok:true, enabled:true, available:true, as_of: g.as_of || null, stale: g.stale !== false,
      low_stock_threshold: Number.isInteger(g.low_stock_threshold) ? g.low_stock_threshold : 50, items, request_id: g.request_id || null }, extra));
  }catch(e){
    console.error("golden-proxy error", e && e.message);
    return json(500, { ok:false, error:"golden-proxy failed" });
  }
};

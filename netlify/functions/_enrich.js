/* MANUFACTURER CENTER — RELEASE B: PRODUCT ENRICHMENT (approved by Angelo 2026-10-11). PURE: no I/O here.
   Products → Auto-Enrich → Review Issues, for one line, by exception:
     1. planPages    — the line's ACTIVE commercial SKUs (product_skus; retired left out) proposed as product pages.
                       SKUs whose names differ only by shape / colour / side / size, and that point at the same
                       manufacturer page, share one page with an option picker; bundles and displays are never
                       merged and always ask for a grouping decision. Nothing is hard-coded per line.
     2. extractPage  — what a manufacturer page states, read deterministically from its HTML: title, model, MSRP,
                       description, feature bullets, specification pairs, warranty text (only if stated), documents,
                       videos, photos, links. Every fact keeps the exact source text it came from.
     3. pickSource   — a landing page that lists several products is followed to the product page that matches the
                       page's own words; a candidate that is a different kind of product (a seat-with-arms bundle for
                       an arms-only page) is refused, and the landing page itself is used, filtered to what it says
                       about this product.
     4. buildDraft   — the hidden draft: copy, features, specs, sizing and warranty from the source only (blank when
                       the source doesn't state it — never an AI default), category from the line's own catalog,
                       page grouping and options (presentation only — never a pricing family), photo candidates, and
                       field-level provenance. NOTHING commercial is written: prices, tiers/pooling, UOM/case qty,
                       MSRP/MAP, freight and commercial status stay in product_skus.
     5. classify     — one of six statuses per page: Conflict, Needs grouping decision, Needs content, Needs image,
                       Needs category, Ready — with every open issue, its evidence, a suggested fix and the one-click
                       choices. A content_resolution decision closes an issue; a held-back page stops blocking. */
"use strict";
const crypto = require("crypto");

const STATUSES = ["conflict", "needs_grouping", "needs_content", "needs_image", "needs_category", "ready"];
const STATUS_LABEL = { conflict: "Conflict", needs_grouping: "Needs grouping decision", needs_content: "Needs content",
  needs_image: "Needs image", needs_category: "Needs category", ready: "Ready", held_back: "Held back", not_enriched: "Not enriched yet", published: "Published" };
const VISIBLE = ["published", "active", "discontinued"];
const isVisibleRow = r => !!r && VISIBLE.indexOf(String(r.status || "")) >= 0 && !r.disabled;

/* ── words ─────────────────────────────────────────────────────────────────────────────────────── */
const VARIANT_DIMS = [
  ["Shape", ["round", "elongated"]],
  ["Color", ["white", "black", "gray", "grey", "biscuit", "bone", "almond", "beige", "tan", "blue", "navy", "red", "green", "pink", "purple", "silver", "chrome", "clear", "brown"]],
  ["Side", ["left", "right"]],
  ["Size", ["x-small", "xx-small", "small", "medium", "large", "x-large", "xx-large", "xs", "xl", "xxl", "petite", "regular", "tall", "short", "youth", "adult", "pediatric", "bariatric"]]
];
const BUNDLE_RE = /\b(display|program|kit|bundle|assortment|starter|floor stand|merchandis|planogram|pre-?pack)\b/i;
/* Kinds of product. A candidate page that is a different kind (names a kind the page doesn't) is a different product. */
const KIND_WORDS = ["seat", "arm", "arms", "bidet", "wash", "display", "ring", "cover", "lid", "rail", "rails", "bench", "chair", "commode",
  "frame", "cushion", "kit", "walker", "cane", "rollator", "wheelchair", "brace", "splint", "boot", "collar", "sling", "bar", "bars", "riser", "toilet"];
const STOP = new Set(["the", "a", "an", "and", "with", "of", "for", "in", "to", "on", "by", "set", "pack", "pk", "ea", "each", "case", "new", "w", "inch", "in.", "x", "s", "p", "never", "loosens"]);
const norm = s => String(s == null ? "" : s).replace(/[‘’]/g, "'").replace(/[“”″]/g, '"').replace(/\s+/g, " ").trim();
const up = s => String(s == null ? "" : s).trim().toUpperCase();
const codeNorm = s => up(s).replace(/[^A-Z0-9]/g, "");
function words(s){ return norm(s).toLowerCase().replace(/[®™©]/g, "").replace(/[^a-z0-9.\-\s"]/g, " ").replace(/"/g, " in ").split(/[\s\-_/]+/).map(w => w.replace(/^\.+|\.+$/g, "")).filter(Boolean); }
function sigWords(s){ return words(s).filter(w => !STOP.has(w) && !(w.length === 1 && !/\d/.test(w))); }
function slug(s, max){
  const full = norm(s).toLowerCase().replace(/[®™©]/g, "").replace(/["”]/g, "-in").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const m = max || 60; if(full.length <= m) return full;
  const cut = full.slice(0, m + 1), i = cut.lastIndexOf("-");
  return (i > 20 ? cut.slice(0, i) : full.slice(0, m)).replace(/-+$/g, "");
}

/* A SKU name split into its family stem and the variant words it carries ("Assurance Support Arms, Set of 2 — Gray" →
   stem "Assurance Support Arms, Set of 2", {Color:"Gray"}). */
function variantOf(name){
  let stem = " " + norm(name) + " ";
  const dims = {};
  for(const [dim, list] of VARIANT_DIMS){
    for(const w of list){
      const re = new RegExp("([\\s,(—–\\-/])(" + w.replace(/[-]/g, "\\-") + ")(?=[\\s,)—–\\-/.]|$)", "i");
      const m = re.exec(stem);
      if(m && !dims[dim]){ dims[dim] = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase(); stem = stem.slice(0, m.index) + m[1] + stem.slice(m.index + m[0].length); }
    }
  }
  stem = stem.replace(/\s*[—–]\s*$/g, "").replace(/\s+[—–-]\s+(?=[,)]|$)/g, " ").replace(/\(\s*\)/g, "").replace(/\s+,/g, ",").replace(/,\s*,/g, ",")
    .replace(/[\s,—–-]+$/g, "").replace(/\s{2,}/g, " ").trim();
  return { stem, dims };
}

/* ── 1. PROPOSE PAGES ──────────────────────────────────────────────────────────────────────────── */
/* ctx: { slug, records: product_skus rows, catalog: catalog-file rows, custom: custom_products rows, overrides:
   product_overrides rows, pages: product_content rows of the line }. Returns { pages, excluded, conflicts_live }. */
function planPages(ctx){
  const recs = (ctx.records || []);
  const cat = {}; (ctx.catalog || []).forEach(r => { if(r && r.code != null) cat[codeNorm(r.code)] = r; });
  const cus = {}; (ctx.custom || []).forEach(r => { if(r && r.code != null) cus[codeNorm(r.code)] = r; });
  const ovr = {}; (ctx.overrides || []).forEach(r => { if(r && r.code != null) ovr[codeNorm(r.code)] = (r.patch || {}); });
  const excluded = [], items = [];
  for(const r of recs){
    const k = r.code_norm || codeNorm(r.code);
    if((r.status || "active") !== "active"){ excluded.push({ code: r.code, why: "retired on the commercial record (" + (r.status || "inactive") + ")" }); continue; }
    const c = cat[k] || {}, u = cus[k] || {}, o = ovr[k] || {};
    const name = norm(o.name || u.name || c.name || r.option_label || r.code);
    const details = norm(c.details_url || u.details_url || "");
    items.push({ code: r.code, k, name, details_url: /^https?:\/\//i.test(details) ? details : "", details_note: /^https?:\/\//i.test(details) ? "" : details,
      category: norm(o.category || u.category || c.category || ""), subcategory: norm(o.subcategory || c.subcategory || ""),
      catalog_image: norm(o.image || u.image || c.image || ""), catalog_description: norm(o.description || u.description || c.description || ""),
      price_ok: Number(r.base_price) > 0, uom: r.uom || null, case_qty: r.case_qty || null, bundle: BUNDLE_RE.test(name) });
  }
  /* Existing pages that already list a SKU: a draft keeps its page key across re-runs; a live page means this SKU is
     already on the storefront (on a frozen line that page is protected — nothing here proposes over it). */
  const onPage = {};      // every page that lists a SKU (a live one is never hidden behind a draft that lists it too)
  (ctx.pages || []).forEach(p => (Array.isArray(p.skus) ? p.skus : []).forEach(s => { const kk = codeNorm(s && (s.sku || s.code)); if(kk) (onPage[kk] = onPage[kk] || []).push(p); }));
  const groups = new Map();
  for(const it of items){
    const v = variantOf(it.name);
    const key = it.bundle ? "bundle:" + it.k : (v.stem.toLowerCase() + "|" + it.details_url.toLowerCase().replace(/\/+$/, ""));
    if(!groups.has(key)) groups.set(key, { stem: v.stem, items: [] });
    groups.get(key).items.push(Object.assign(it, { dims: v.dims }));
  }
  const pages = [], used = new Set();
  for(const g of groups.values()){
    const multi = g.items.length > 1;
    const dimsUsed = {};
    if(multi) for(const [dim] of VARIANT_DIMS){
      const vals = g.items.map(i => i.dims[dim] || null);
      if(vals.every(Boolean) && new Set(vals).size === g.items.length) dimsUsed[dim] = vals;
      else if(vals.some(Boolean) && new Set(vals.filter(Boolean)).size > 1) dimsUsed[dim] = vals.map(x => x || "Standard");
    }
    const dimNames = Object.keys(dimsUsed);
    /* names that differ by something other than the variant words do not share a page */
    if(multi && !dimNames.length){ g.items.forEach(i => pages.push(singlePage(i))); continue; }
    if(!multi){ pages.push(singlePage(g.items[0])); continue; }
    const options = {}; dimNames.forEach(d => { options[d] = [...new Set(dimsUsed[d])]; });
    const name = g.stem;
    pages.push({ name, page_key: slug(name), bundle: false, group_reason: "names differ only by " + dimNames.join(" and ").toLowerCase() + (g.items[0].details_url ? " and point at the same manufacturer page" : ""),
      options, skus: g.items.map((i, n) => skuEntry(i, dimNames.map(d => dimsUsed[d][n]).join(" "))) });
  }
  function singlePage(i){ return { name: i.name, page_key: slug(i.name), bundle: i.bundle, group_reason: i.bundle ? "a display or bundle — never merged on its own; your call" : "one SKU",
    options: {}, skus: [skuEntry(i, "")] }; }
  function skuEntry(i, option){ return { code: i.code, name: i.name, option, details_url: i.details_url, details_note: i.details_note, category: i.category, subcategory: i.subcategory,
    catalog_image: i.catalog_image, catalog_description: i.catalog_description, price_ok: i.price_ok, uom: i.uom, case_qty: i.case_qty }; }
  /* stable keys: reuse the draft that already holds these SKUs; never two pages with one key */
  const live = [];
  for(const p of pages){
    const holders = [...new Set([].concat(...p.skus.map(s => onPage[codeNorm(s.code)] || [])))];
    const visible = holders.filter(isVisibleRow);
    /* Release D: this enrichment's own page, now published (same SKUs, same name or key) — not someone else's live page */
    const own = visible.find(h => (h.page_key === p.page_key || String(h.name || "") === p.name)
      && (Array.isArray(h.skus) ? h.skus : []).map(x => codeNorm(x && (x.sku || x.code))).sort().join("|") === p.skus.map(x => codeNorm(x.code)).sort().join("|"));
    if(own){ p.published = own.page_key; p.page_key = own.page_key; }
    else if(visible.length){ live.push({ page_key: p.page_key, codes: p.skus.map(s => s.code), live_pages: visible.map(h => h.page_key) }); p.live_page = visible[0].page_key; }
    const draft = own ? null : holders.find(h => !isVisibleRow(h));
    if(draft) p.page_key = draft.page_key;
    let key = p.page_key || "page", n = 2; while(used.has(key)) key = (p.page_key || "page") + "-" + (n++);
    p.page_key = key; used.add(key);
    p.existing = draft ? { page_key: draft.page_key, status: draft.status, draft_window: draft.draft_window == null ? null : draft.draft_window } : null;
  }
  pages.sort((a, b) => (a.bundle - b.bundle) || a.name.localeCompare(b.name));
  return { pages, excluded, live, active: items.length };
}

/* ── 2. READ A MANUFACTURER PAGE ───────────────────────────────────────────────────────────────── */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "–", mdash: "—",
  trade: "™", reg: "®", copy: "©", middot: "·", hellip: "…", deg: "°", frac12: "½", frac14: "¼", frac34: "¾", times: "×", prime: "′", Prime: "″" };
function decode(s){ return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/gi, (m, e) => {
  if(e[0] === "#"){ const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(n) && n > 0 ? String.fromCodePoint(n) : m; }
  return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m; }); }
function absUrl(u, base){ try{ const s = decode(String(u || "").trim()); if(!s || /^(data|javascript|mailto|tel):/i.test(s)) return ""; return new URL(s, base).href; }catch(e){ return ""; } }
const BLOCK = new Set(["p", "div", "li", "ul", "ol", "section", "article", "main", "aside", "tr", "td", "th", "dt", "dd", "dl", "table", "tbody", "thead", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6", "button", "label", "form", "figure", "figcaption", "blockquote", "header", "footer", "nav", "summary", "details"]);
/* The page as an ordered list of blocks: headings (with level), list items and text, in reading order. */
function blocksOf(html){
  let h = String(html || "").replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|svg|noscript|template|iframe|select)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(header|footer|nav)\b[\s\S]*?<\/\1>/gi, " ");
  const out = []; let buf = "", ctx = { type: "t", level: 0 }; const stack = [];
  const flush = () => { const t = norm(decode(buf)); if(t) out.push({ type: ctx.type, level: ctx.level, text: t }); buf = ""; };
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|([^<]+)/g; let m;
  while((m = re.exec(h))){
    if(m[3] != null){ buf += m[3]; continue; }
    const tag = m[2].toLowerCase(), close = m[1] === "/";
    if(!BLOCK.has(tag)) { buf += " "; continue; }
    flush();
    if(/^h[1-6]$/.test(tag) || tag === "li"){
      if(!close){ stack.push(ctx); ctx = tag === "li" ? { type: "li", level: 0 } : { type: "h", level: +tag[1] }; }
      else ctx = stack.pop() || { type: "t", level: 0 };
    }
  }
  flush();
  return out;
}
/* Sections: each heading owns the blocks after it, including deeper sub-headings ("Specifications" › "Measurements"). */
function sectionsOf(blocks){
  const secs = []; let open = [];
  for(const b of blocks){
    if(b.type === "h"){
      open = open.filter(s => s.level < b.level);
      const s = { heading: b.text, level: b.level, items: [] }; secs.push(s); open.forEach(o => o.items.push(b)); open.push(s);
    } else open.forEach(o => o.items.push(b));
  }
  return secs;
}
const DESC_H = /^(product\s+)?(description|overview|details|about( this| the)? product|product details)\b/i;
const FEAT_H = /\b(features?|benefits?|highlights|key features|why you'?ll love)\b/i;
const SPEC_H = /\b(specifications?|specs|technical|dimensions|measurements|product information|details & specs)\b/i;
const NOISE = /^(skip to content|read more|agree|learn more.*|add to (cart|compare)|compare|quantity|play video|share|print|close|menu|search|sign in|log in|\+|-|save|view all.*|shop now|buy now|where to buy|write a review)$/i;
const DOC_RE = /(spec(ification)? sheet|manual|instructions?|warranty|brochure|guide|catalog|sell sheet|data sheet|ifu)/i;
const IMG_SKIP = /(logo|icon|sprite|badge|flag|avatar|placeholder|spinner|loader|facebook|twitter|pinterest|instagram|youtube\.com\/vi|ytimg|\/tr\b|pixel|tracking|swatch|thumbnail-?nav|banner|payment|seal|stars?[-_]|rating)/i;

/* Specification pairs from every specifications-style section ("Specifications", "Measurements", "Dimensions"):
   "Label: value" in one block, or a label block ("Brand:", "Model No*") followed by its value block. */
function specsFrom(secs){
  const specs = [], seenLab = new Set();
  const push = (label, value, evidence) => { label = norm(label.replace(/\s*No\.?\s*\*?$/i, " No.").replace(/[:*]+$/, "")); value = norm(value);
    if(!label || !value || /^https?$/i.test(label) || value.length > 140 || NOISE.test(value) || seenLab.has(label.toLowerCase())) return;
    seenLab.add(label.toLowerCase()); specs.push({ label, value, evidence: norm(evidence) }); };
  for(const sec of secs.filter(s => SPEC_H.test(s.heading))){
    const items = sec.items.filter(b => b.type !== "h");
    for(let i = 0; i < items.length; i++){
      const t = items[i].text;
      const lab = /^([A-Za-z][A-Za-z0-9 ()/#.&'-]{0,38}?)\s*(?::|\*)\s*$/.exec(t);
      if(lab){ const nx = items[i + 1]; if(nx && !/^[A-Za-z][A-Za-z0-9 ()/#.&'-]{0,38}?\s*(?::|\*)\s*$/.test(nx.text)){ push(lab[1], nx.text, t + " " + nx.text); i++; } continue; }
      const multi = (t.match(/:\s/g) || []).length > 1;     // "Width: 20 in Height: 10 in" in one block — otherwise keep "Weight Capacity: 300 lbs" whole
      for(const part of (multi ? t.split(/\s{2,}|(?<=\d|in|lbs?|mm|cm|\))\s(?=[A-Z][A-Za-z ]{1,24}:\s)/) : [t])){
        const m = /^([A-Za-z][A-Za-z0-9 ()/#.&'-]{0,38}?)\s*:\s*(.{1,140})$/.exec(part.trim());
        if(m) push(m[1], m[2], part.trim());
      }
    }
  }
  return specs;
}

function extractPage(html, url){
  const raw = String(html || "");
  const title = norm(decode((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""));
  const meta = (p) => { const m = new RegExp("<meta[^>]+(?:property|name)=[\"']" + p + "[\"'][^>]*>", "i").exec(raw); return m ? norm(decode((m[0].match(/content=["']([^"']*)["']/i) || [])[1] || "")) : ""; };
  const blocks = blocksOf(raw), secs = sectionsOf(blocks);
  const text = norm(blocks.map(b => b.text).join(" "));
  /* JSON-LD Product, when the page carries one */
  let ld = null;
  for(const m of raw.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)){
    try{ const j = JSON.parse(m[1].trim()); const all = [].concat(j && j["@graph"] ? j["@graph"] : j);
      const p = all.find(x => x && /product/i.test(String(x["@type"] || ""))); if(p){ ld = p; break; } }catch(e){}
  }
  const modelM = /\bModel\s*(?:#|No\.?\s*\*?|Number)\s*:?\s*([A-Z0-9][A-Z0-9\-]{2,}(?:\s[0-9]{3})?)/i.exec(text);
  const model = modelM ? norm(modelM[1]) : (ld && (ld.sku || ld.mpn) ? norm(ld.sku || ld.mpn) : "");
  const msrpM = /\$\s?([0-9]{1,5}(?:,[0-9]{3})*(?:\.[0-9]{2})?)\s*(?:USD\s*)?MSRP\b/i.exec(text) || /\bMSRP\s*:?\s*\$\s?([0-9]{1,5}(?:\.[0-9]{2})?)/i.exec(text);
  const msrp = msrpM ? Number(msrpM[1].replace(/,/g, "")) : (ld && ld.offers && ld.offers.price ? Number(ld.offers.price) : null);
  const descSec = secs.find(s => DESC_H.test(s.heading));
  const featSecs = secs.filter(s => FEAT_H.test(s.heading) && !DESC_H.test(s.heading) && !SPEC_H.test(s.heading));
  const clean = t => t && t.length >= 3 && !NOISE.test(t);
  let description = "", bullets = [];
  if(descSec){
    const own = descSec.items.filter(b => b.type !== "h" || false);
    const stopAt = own.findIndex(b => b.type === "h");
    const until = stopAt < 0 ? own : own.slice(0, stopAt);
    description = until.filter(b => b.type === "t" && clean(b.text) && b.text.length >= 25).map(b => b.text).join(" ");
    bullets = until.filter(b => b.type === "li" && clean(b.text) && b.text.length <= 240).map(b => b.text);
  }
  if(!description && ld && ld.description) description = norm(decode(ld.description));
  const features = [...new Set(bullets.concat(...featSecs.map(s => s.items.filter(b => b.type === "li" && clean(b.text) && b.text.length <= 240).map(b => b.text))))];
  const specs = specsFrom(secs);
  /* warranty: only a sentence that states terms (a link called "Warranty" states nothing) */
  const sentences = text.split(/(?<=[.!?])\s+/);
  const warrantyS = sentences.find(s => /warrant/i.test(s) && /(year|lifetime|limited|months?|days?)/i.test(s) && s.length >= 20 && s.length <= 300);
  const anchors = [];
  for(const m of raw.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    const href = (m[1].match(/href=["']([^"']+)["']/i) || [])[1]; if(!href) continue;
    const abs = absUrl(href, url); if(!abs) continue;
    anchors.push({ href: abs, text: norm(decode(m[2].replace(/<[^>]+>/g, " "))) });
  }
  const docs = []; anchors.forEach(a => { if(DOC_RE.test(a.text) && (/\.pdf(\?|#|$)/i.test(a.href) || /\/assets\//i.test(a.href)) && !docs.some(d => d.url === a.href)) docs.push({ label: a.text.slice(0, 80), url: a.href }); });
  const videos = [];
  for(const m of raw.matchAll(/(?:youtube\.com\/(?:watch\?v=|embed\/|vi\/)|youtu\.be\/)([A-Za-z0-9_-]{6,15})/g)){ const v = "https://www.youtube.com/watch?v=" + m[1]; if(videos.indexOf(v) < 0) videos.push(v); }
  /* photos: every <img> source (src, lazy-load attributes, the largest srcset entry), og:image and JSON-LD images */
  const imgs = [];
  const addImg = (u, alt, from) => { const a = absUrl(u, url); if(!a || !/^https?:/i.test(a) || /\.svg(\?|$)/i.test(a) || IMG_SKIP.test(a)) return;
    const key = a.split("#")[0]; if(!imgs.some(x => x.url.split("#")[0] === key)) imgs.push({ url: a, alt: norm(decode(alt || "")), from }); };
  for(const m of raw.matchAll(/<img\b[^>]*>/gi)){
    const t = m[0], alt = (t.match(/\salt=["']([^"']*)["']/i) || [])[1] || "";
    const set = (t.match(/\s(?:data-srcset|srcset)=["']([^"']+)["']/i) || [])[1];
    let best = "";
    if(set){ const c = set.split(",").map(x => x.trim().split(/\s+/)).filter(x => x[0]).map(x => ({ u: x[0], w: parseInt(x[1], 10) || 0 })).sort((a, b) => b.w - a.w); if(c[0]) best = c[0].u; }
    const src = (t.match(/\s(?:data-src|data-lazy-src|data-original|data-zoom-image|data-large_image)=["']([^"']+)["']/i) || [])[1] || best || (t.match(/\ssrc=["']([^"']+)["']/i) || [])[1];
    if(src) addImg(src, alt, "img");
  }
  const og = meta("og:image"); if(og) addImg(og, "", "og");
  if(ld && ld.image) [].concat(ld.image).forEach(x => addImg(typeof x === "string" ? x : (x && x.url), "", "ld"));
  return { url, title, og_title: meta("og:title"), og_description: meta("og:description"), model, msrp, description, features, specs,
    warranty: warrantyS ? { text: norm(warrantyS), evidence: norm(warrantyS) } : null, documents: docs, videos, images: imgs,
    links: anchors, text, product: !!(model || specs.length >= 2 || ld), headings: secs.map(s => s.heading) };
}

/* ── 3. MATCH A SOURCE ─────────────────────────────────────────────────────────────────────────── */
function pageWords(page){ const w = new Set(); sigWords(page.name).forEach(x => w.add(x)); (page.skus || []).forEach(s => sigWords(s.name).forEach(x => w.add(x))); return w; }
const singular = w => w.replace(/s$/, "");
const pageKinds = page => [...new Set([...pageWords(page)].filter(w => KIND_WORDS.indexOf(w) >= 0 && w !== "toilet").map(singular))];
/* How well a candidate (its URL path and link text) describes this page: shared words, minus every KIND of product the
   candidate names that the page does not (a "seat with support arms" is not an arms-only product). */
function scoreCandidate(page, cand){
  const pw = pageWords(page), pk = new Set([...pw].map(singular));
  let path = ""; try{ path = new URL(cand.href).pathname; }catch(e){ path = cand.href; }
  const cw = new Set(sigWords(path.replace(/[-_/]+/g, " ") + " " + (cand.text || "")));
  let shared = 0; cw.forEach(w => { if(pw.has(w) || pk.has(singular(w))) shared++; });
  const kindsCand = [...cw].filter(w => KIND_WORDS.indexOf(w) >= 0).map(singular), kindsPage = [...pw].filter(w => KIND_WORDS.indexOf(w) >= 0).map(singular);
  const foreign = [...new Set(kindsCand.filter(k => kindsPage.indexOf(k) < 0 && !(k === "toilet" && kindsPage.indexOf("seat") >= 0)))];
  const missing = kindsPage.filter(k => kindsCand.indexOf(k) < 0 && k !== "toilet");
  return { score: shared - 2 * foreign.length - (missing.length ? 1 : 0), shared, foreign, missing };
}
/* The product pages a landing page links to (same site, not the page itself, not navigation). */
function productLinks(src){
  let host = ""; try{ host = new URL(src.url).host; }catch(e){}
  const self = String(src.url || "").replace(/[#?].*$/, "").replace(/\/+$/, "");
  const seen = new Set(), out = [];
  for(const a of src.links || []){
    let u; try{ u = new URL(a.href); }catch(e){ continue; }
    if(u.host !== host) continue;
    const clean = (u.origin + u.pathname).replace(/\/+$/, "");
    if(clean === self || seen.has(clean)) continue;
    const segs = u.pathname.split("/").filter(Boolean);
    if(segs.length < 2 && !/-/.test(segs[0] || "")) continue;               // "/p/", "/assurance/" style section roots
    if(sigWords(segs[segs.length - 1].replace(/-/g, " ")).length < 3) continue; // "/p/shop-by-bidet/" is navigation
    seen.add(clean); out.push({ href: u.origin + u.pathname, text: a.text });
  }
  return out;
}
function pickProductLink(page, landing){
  const scored = productLinks(landing).map(c => Object.assign({ cand: c }, scoreCandidate(page, c))).sort((a, b) => b.score - a.score || b.shared - a.shared);
  const best = scored[0], cands = scored.slice(0, 5).map(x => ({ href: x.cand.href, score: x.score, foreign: x.foreign }));
  if(best && best.score >= 3 && !best.foreign.length) return { href: best.cand.href, related: null, why: "the landing page's link that matches this page's words (" + best.shared + " shared, no other product kind)", candidates: cands };
  /* No page is this product. A bundle page that contains it (a "seat with support arms" for the arms) may still describe
     it: it is read for the sentences about THIS product only — never its photos, never its specifications. */
  const rel = scored.find(x => x.foreign.length && !x.missing.length && x.shared >= 2 && pageKinds(page).length);
  return { href: null, related: rel ? rel.cand.href : null, why: best ? "no linked product page is this product (best: " + best.cand.href + (best.foreign.length ? ", a " + best.foreign.join("/") + " product" : "") + ")" : "the landing page links to no product pages",
    candidates: cands };
}
/* From a landing page that covers several products, only what it says about THIS one: blocks that name this page's own
   kind or distinguishing words, and none that name another kind only. */
function relevantFromLanding(page, src, lineWords){
  const pw = pageWords(page);
  const distinct = [...pw].filter(w => KIND_WORDS.indexOf(w) >= 0 || (lineWords && !lineWords.has(w)));
  const keep = t => { const ws = new Set(sigWords(t)); return distinct.some(w => ws.has(w) || ws.has(singular(w)) || ws.has(w + "s")); };
  const blocks = blocksOf(src.html || "");
  const paras = blocks.filter(b => b.type === "t" && b.text.length >= 40 && !NOISE.test(b.text) && keep(b.text)).map(b => b.text);
  const lis = blocks.filter(b => b.type === "li" && b.text.length >= 8 && b.text.length <= 240 && !NOISE.test(b.text) && keep(b.text)).map(b => b.text);
  return { description: paras.slice(0, 3).join(" "), features: [...new Set(lis)].slice(0, 8), distinct };
}

/* Model-number specification rows: kept in provenance as the retail model, never shown as an unlabeled dealer spec. */
const RETAIL_MODEL_LABEL = /^(model(\s*(no\.?|number|#))?|item\s*(no\.?|number|#)|sku|upc)$/i;
/* Editorial cleanup of a manufacturer's first-person marketing wording into neutral dealer-facing language. It removes
   nothing factual and adds nothing: "our patented Dual Lock" → "Bemis's patented Dual Lock"; a sentence that is only
   first-person promotion ("We're EMPOWERING INDEPENDENCE with this ultimate clean package.") is dropped. */
function neutralize(text, brand){
  const b = (brand || "the manufacturer") + "\u2019s";
  const sentences = norm(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  const keep = sentences.filter(x => !(/^(we|we're|we are|we've)\b/i.test(x) && !/\d/.test(x)));
  return keep.join(" ").replace(/\bOur\b/g, b.charAt(0).toUpperCase() + b.slice(1)).replace(/\bour\b/g, b)
    .replace(/\bwe\b(?! are| have)/g, (brand || "the manufacturer")).replace(/\bWe\b/g, (brand || "The manufacturer")).replace(/\s{2,}/g, " ").trim();
}
/* ── 4. BUILD THE DRAFT ────────────────────────────────────────────────────────────────────────── */
const numbersIn = s => (String(s || "").match(/\d+(?:\.\d+)?/g) || []);
/* Facts in our catalog line that no source states (a "1000 lb" the page never mentions) — evidence for a Conflict. */
function unsupportedFacts(catalogText, sourceText){
  const facts = String(catalogText || "").match(/\d+(?:\.\d+)?\s*(?:-?\s*)?(?:lbs?|pounds?|in(?:ch(?:es)?)?\b|"|”|cm|mm|ft)/gi) || [];
  const st = norm(sourceText).toLowerCase();
  return facts.filter(f => { const n = numbersIn(f)[0]; return n && !new RegExp("(^|[^0-9.])" + n.replace(".", "\\.") + "(?![0-9])").test(st); }).map(norm);
}
/* Named features / systems in our catalog line ("Stay-Tite", "Dual Lock™", "the Super Grip system"). One the manufacturer's
   page never names — or shows only in badges while its product copy names a different system — is a source/content
   discrepancy for review, never silently chosen (Angelo 2026-10-11, Steadfast: Stay-Tite vs Snap 2 Secure). */
const NAME_STOP = /^(the|a|an|with|and|for|our|its|this|new)$/i;
const nameKey = t => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function namedTerms(text){
  const t = String(text || ""), out = [];
  let m; const tm = /([A-Z][\w-]*(?:\s+[A-Z0-9][\w-]*){0,3})\s*[\u2122\u00ae]/g; while((m = tm.exec(t))) out.push(m[1]);
  const sy = /((?:[A-Z][\w\u00b7-]*|\d+)(?:\s+(?:[A-Z][\w\u00b7-]*|\d+)){0,3})[\u2122\u00ae]?\s+(?:(?:[Ii]nstallation|[Ff]astening)(?:\s+[Ss]ystem)?|[Ss]ystem|[Hh]inge|[Tt]echnology|[Mm]echanism)\b/g;
  while((m = sy.exec(t))){ const w = m[1].split(/\s+/); while(w.length && NAME_STOP.test(w[0])) w.shift(); while(w.length && /^(installation|fastening|system)$/i.test(w[w.length - 1])) w.pop(); if(w.length && /[A-Za-z]/.test(w.join(""))) out.push(w.join(" ")); }
  const seen = new Set(); return out.map(norm).filter(x => x.length > 2 && !NAME_STOP.test(x) && !seen.has(nameKey(x)) && seen.add(nameKey(x)));
}
/* Named fastening / installation systems in a text ("Snap 2 Secure system", "the Stay-Tite installation system"). */
function systemNames(text){
  const out = [], seen = new Set(); let m;
  const sy = /((?:[A-Z][\w\u00b7-]*|\d+)(?:\s+(?:[A-Z][\w\u00b7-]*|\d+)){0,3})[\u2122\u00ae]?\s+(?:[Ii]nstallation\s+|[Ff]astening\s+)?(?:[Ss]ystem|[Hh]inge|[Mm]echanism)\b/g;
  while((m = sy.exec(String(text || "")))){ const w = m[1].split(/\s+/); while(w.length && NAME_STOP.test(w[0])) w.shift(); while(w.length && /^(installation|fastening|system)$/i.test(w[w.length - 1])) w.pop(); const x = norm(w.join(" ")); if(x && /[A-Za-z]/.test(x) && !seen.has(nameKey(x))){ seen.add(nameKey(x)); out.push(x); } }
  return out;
}
const firstSentences = (t, max) => { const s = norm(t).split(/(?<=[.!?])\s+/); let out = ""; for(const x of s){ if((out + " " + x).length > (max || 600) && out) break; out = (out ? out + " " : "") + x; } return out; };
/* Image candidates, in order: photos named after the source page's model, then photos whose file name describes this
   product, then each SKU's current catalog photo (what dealers see today — copied into HCPS storage, never linked). */
const PROMO_IMG = /(landing|banner|promo|hero|lifestyle|gallery|campaign|[-_]fb[-_.]|feature|benefit|thumbnail|badge|infographic)/i;
const isPromoUrl = u => { let f = ""; try{ f = decodeURIComponent(new URL(u).pathname.split("/").pop()); }catch(e){ f = String(u); } return PROMO_IMG.test(f); };
/* Image candidates, in order: photos named after the product page's model; an official manufacturer photo chosen for an
   option in Review Issues; each SKU's current dealer photo. A landing page's images are used only when there is no
   product page, and then never as the main photo (they are promo / banner art). Bundle pages give none. */
function imageCandidates(page, sources, orderingBase, skuImages){
  const out = [], seen = new Set(), chosen = skuImages || {};
  const add = (url, role, code, from, promo) => { const k = String(url).split(/[?#]/)[0] + "|" + role + "|" + (code || ""); if(!url || seen.has(k)) return; seen.add(k); out.push({ src: url, role, code: code || null, from, promo: !!promo }); };
  const hasProduct = sources.some(s => s && s.role === "product" && s.extract && s.extract.product);
  for(const s of sources){
    if(!s || !s.extract || s.role === "related" || (hasProduct && s.role !== "product")) continue;
    const ex = s.extract, modelTok = ex.model ? ex.model.split(/\s+/)[0].toUpperCase() : "";
    const named = modelTok ? ex.images.filter(i => i.url.toUpperCase().indexOf(modelTok) >= 0) : [];
    named.slice(0, 8).forEach(i => add(i.url, "gallery", null, "manufacturer product page (model " + ex.model + ")", isPromoUrl(i.url)));
    if(!named.length){
      const ranked = ex.images.map(i => { let f = ""; try{ f = decodeURIComponent(new URL(i.url).pathname.split("/").pop()); }catch(e){ f = i.url; }
        return Object.assign({ i }, scoreCandidate(page, { href: "https://x/" + f.replace(/\.[a-z]+$/i, ""), text: i.alt })); })
        .filter(x => x.score >= 1 && !x.foreign.length).sort((a, b) => b.score - a.score);
      ranked.slice(0, 4).forEach(x => add(x.i.url, "gallery", null, s.role === "landing" ? "manufacturer landing page (promo art — never the main photo)" : "manufacturer page", s.role === "landing" || isPromoUrl(x.i.url)));
    }
  }
  for(const sk of page.skus){
    const pick = chosen[codeNorm(sk.code)];
    if(pick){ add(pick.url, page.skus.length > 1 ? "sku" : "gallery", sk.code, "official manufacturer photo chosen in Review Issues" + (pick.why ? " (" + pick.why + ")" : ""), false); continue; }
    if(!sk.catalog_image) continue;
    const u = /^https?:/i.test(sk.catalog_image) ? sk.catalog_image : String(orderingBase || "").replace(/\/+$/, "") + (sk.catalog_image.startsWith("/") ? "" : "/") + sk.catalog_image;
    add(u, page.skus.length > 1 ? "sku" : "gallery", sk.code, "current catalog photo", false);
  }
  return out;
}
/* sources: [{ url, role:"product"|"landing", extract, html?, matched_by }]. decisions: resolutions for this page. */
function buildDraft(page, sources, opts){
  opts = opts || {};
  const now = opts.now || new Date().toISOString();
  const prod = sources.find(s => s && s.role === "product" && s.extract && s.extract.product) || null;
  const landing = sources.find(s => s && s.role === "landing" && s.extract) || null;
  const related = sources.find(s => s && s.role === "related" && s.extract) || null;
  const fields = {}, conflicts = [], notes = [];
  let description = "", features = [], specs = [], warranty = null, documents = [], videos = [];
  if(prod){
    const ex = prod.extract;
    description = firstSentences(ex.description, 700);
    if(description) fields.description = { source: "manufacturer page", url: prod.url, evidence: description };
    features = ex.features.slice(0, 10).map(f => ({ text: f, url: prod.url }));
    specs = ex.specs.filter(s => !/^(brand)$/i.test(s.label) && !RETAIL_MODEL_LABEL.test(s.label)).map(s => ({ label: s.label, value: s.value, url: prod.url, evidence: s.evidence }));
    if(ex.warranty) warranty = { text: ex.warranty.text, url: prod.url, evidence: ex.warranty.evidence };
    documents = ex.documents.slice(0, 8); videos = ex.videos.slice(0, 4);
    if(ex.model) notes.push((opts.brand || "Manufacturer") + " Retail Model " + ex.model + " (alias only — the HCPS SKU is the ordering code)");
  } else if(landing || related){
    /* Angelo 2026-10-11: a landing page or a bundle page may show that the product exists and what it fits, but it is
       never the standalone description or specification source for a component. They are recorded as evidence only. */
    if(related) notes.push("A Bemis bundle page includes it (" + related.url + ") — evidence it exists and fits; not used as its description.");
    if(landing) notes.push("The line's landing page mentions it (" + landing.url + ") — not product-specific; not used as its description.");
  }
  const srcText = [prod && prod.extract.text, landing && landing.extract.text, related && related.extract.text].filter(Boolean).join(" ");
  if(!description){
    let cd = page.skus.map(s => s.catalog_description).find(Boolean) || "";
    /* a figure in our catalog line that no manufacturer source states stays out of the draft until one does */
    const unsup = srcText ? unsupportedFacts(cd, srcText) : [];
    if(unsup.length) cd = norm(cd.split(/(?<=[.!?])\s+/).filter(x => !unsupportedFacts(x, srcText).length).join(" "));
    if(cd){ description = cd; fields.description = { source: "HCPS catalog line only (no product-specific manufacturer source)" + (unsup.length ? "; left out until a Bemis source confirms it: " + unsup.join(", ") : ""), url: null, evidence: cd }; }
  }
  if(prod){
    const n0 = description, f0 = features.map(f => f.text).join("|");
    description = neutralize(description, opts.brand);
    features = features.map(f => Object.assign({}, f, { text: neutralize(f.text, opts.brand) })).filter(f => f.text);
    if(fields.description) fields.description.evidence = n0;
    if(description !== n0 || features.map(f => f.text).join("|") !== f0) notes.push("Editorial: first-person manufacturer wording made neutral (no facts added or removed).");
  }
  if(features.length) fields.features = { source: prod ? "manufacturer page" : "manufacturer pages (the parts about this product)", url: features[0].url };
  if(specs.length) fields.specs = { source: "manufacturer page — stated values only", url: prod.url };
  fields.warranty = warranty ? { source: "manufacturer page", url: prod.url, evidence: warranty.evidence } : { source: "not stated by the source — left blank", url: null };
  const sizing = specs.filter(s => /\b(width|depth|height|length|bolt spread|weight|seat height|rise|size|fits|capacity|dimensions?)\b/i.test(s.label));
  /* Angelo 2026-10-11: a manufacturer website's retail price never creates a commercial conflict — commercial pricing comes
     only through Manufacturer Center sources. The page's retail model is kept as an alias in provenance, never as the
     dealer ordering code. Conflicts here are content facts only (a catalog figure no source states). */
  if(srcText){
    const un = [...new Set(page.skus.flatMap(s => unsupportedFacts(s.catalog_description, srcText)))];
    if(un.length) conflicts.push({ kind: "catalog_fact", title: "Your catalog line states " + un.join(", ") + " — the manufacturer's page doesn't",
      evidence: { page: "not stated on " + (prod || landing || related).url, record: page.skus.map(s => s.catalog_description).filter(Boolean)[0] || "" },
      suggestion: "Check the figure against the manufacturer's spec sheet. Nothing is published until you decide." });
  }
  if(prod){
    /* the product's own copy (description + features) vs the whole page (site badges, icon strips, links) */
    const copy = [prod.extract.description, (prod.extract.features || []).join(" ")].filter(Boolean).join(" ");
    const whole = [prod.extract.text, copy].filter(Boolean).join(" ");
    const theirs = systemNames(copy);
    const flagged = [];
    for(const n of [...new Set(page.skus.flatMap(s => namedTerms(s.catalog_description)))]){
      const inCopy = nameKey(copy).indexOf(nameKey(n)) >= 0, onPage = nameKey(whole).indexOf(nameKey(n)) >= 0;
      const rival = theirs.filter(x => nameKey(x) !== nameKey(n));
      if(!onPage) flagged.push({ n, why: "the manufacturer's page never names it" });
      else if(!inCopy && rival.length) flagged.push({ n, why: "the manufacturer's product copy says " + rival.map(x => "\u201c" + x + "\u201d").join(", ") + " (\u201c" + n + "\u201d appears only in the page's badges / icons)" });
    }
    if(flagged.length){
      const names = flagged.map(f => f.n);
      conflicts.push({ kind: "catalog_name", title: "Your catalog line says " + names.map(n => "\u201c" + n + "\u201d").join(", ") + " — " + flagged.map(f => f.why).join("; "),
        evidence: { page: flagged.map(f => f.n + ": " + f.why).join("; ") + " — " + prod.url, record: page.skus.map(s => s.catalog_description).filter(Boolean)[0] || "" },
        suggestion: "A source/content discrepancy for review. The draft copy uses only the manufacturer's words; the catalog line and the commercial record are not changed. Nothing is published until you decide." });
      notes.push("Source/content discrepancy: the HCPS catalog line names " + names.join(", ") + " — " + flagged.map(f => f.why).join("; ") + ". Flagged for review, not chosen.");
    }
  }
  const cat = page.skus.find(s => s.subcategory || s.category) || {};
  const row = {
    manufacturer: opts.slug, page_key: page.page_key, name: page.name, status: "pending_review",
    description: description || null, features: features.map(f => f.text), specs: specs.map(s => ({ label: s.label, value: s.value })),
    warranty: warranty ? warranty.text : null, category: cat.category || null, subcategory: cat.subcategory || null,
    options: page.options || {}, skus: page.skus.map(s => ({ sku: s.code, name: s.name, size: s.option || "", status: "active", disabled: false, image: "", images: [], source: "" })),
    sku_count: page.skus.length, source_url: (prod || landing || related || {}).url || null, documents: documents.map(d => ({ label: d.label, url: d.url })), videos,
    sizing_note: null, aliases: prod && prod.extract.model ? [prod.extract.model] : [],
    field_provenance: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.source + (v.url ? " — " + v.url : "")])
      .concat(cat.category ? [["category", "HCPS catalog (what dealers see today)"]] : [])
      .concat(prod && prod.extract.model ? [["retail_model", (opts.brand || "Manufacturer") + " Retail Model " + prod.extract.model + " — alias only; the HCPS SKU is the ordering code — " + prod.url]] : []))
  };
  const report = { v: 1, at: now, window: opts.window || null, sources: sources.filter(Boolean).map(s => ({ url: s.url, role: s.role, matched_by: s.matched_by || "", model: s.extract && s.extract.model || "" })),   // no retail price kept: it is not HCPS commercial data
    fields: Object.assign({}, fields, { features_list: features, specs_list: specs, sizing: sizing.map(s => s.label) }), conflicts, notes,
    group_reason: page.group_reason, bundle: !!page.bundle, image_candidates: imageCandidates(page, sources, opts.orderingBase, opts.skuImages), images: [], images_done: false, retail_models: prod && prod.extract.model ? [prod.extract.model] : [] };
  return { row, report };
}

/* Photos rehosted for a page: [{src, role, code, url (HCPS copy), sha, bytes, error?}] → the page's gallery, primary,
   per-SKU photos, and photos two option SKUs share byte for byte. */
/* The same picture in two sizes ("A84505T-000-P.jpg" and "A84505T-000-P__FillWzgwMCw4MDBd.jpg"): one photo. */
const photoStem = u => { let f = ""; try{ f = decodeURIComponent(new URL(u).pathname.split("/").pop()); }catch(e){ f = String(u || ""); }
  return f.replace(/\.[a-z0-9]+$/i, "").replace(/__[A-Za-z]+Wz[A-Za-z0-9=_-]*$/, "").replace(/[-_]\d{2,4}x\d{2,4}$/, "").toLowerCase(); };
function assembleImages(page, row, done){
  const ok = done.filter(d => d.url && !d.error);
  /* exact duplicates (same bytes) and resized copies of one photo collapse to the largest file */
  const groups = [];
  ok.filter(d => d.role === "gallery").forEach(d => {
    const g = groups.find(x => x.some(y => y.sha === d.sha || photoStem(y.src) === photoStem(d.src)));
    if(g) g.push(d); else groups.push([d]); });
  const uniq = groups.map(g => g.slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0]).map(d => Object.assign({}, d, { promo: groupPromo(groups, d) }));
  function groupPromo(gs, d){ const g = gs.find(x => x.indexOf(d) >= 0); return g ? g.every(y => y.promo) : !!d.promo; }
  const skuImg = {}; ok.filter(d => d.role === "sku").forEach(d => { skuImg[codeNorm(d.code)] = d; });
  let pool = uniq.slice();
  if(!pool.some(d => !d.promo)) ok.filter(d => d.role === "sku").forEach(d => { if(!pool.some(x => x.sha === d.sha)) pool.push(d); });
  /* banner / promo art is never the main photo: the first real product photo leads */
  /* Angelo 2026-10-11 (Steadfast): badge / banner / promo art is never dealer-facing at all — not the main photo, not
     a thumbnail. It stays in the report as withheld, so the evidence is kept. */
  const withheld = pool.filter(d => d.promo);
  pool = pool.filter(d => !d.promo);
  const lead = pool.length ? 0 : -1;
  const gallery = pool.map((d, n) => ({ url: d.url, primary: n === lead, caption: "", source: d.from || "rehosted" }));
  const skus = (row.skus || []).map(s => { const d = skuImg[codeNorm(s.sku)]; return Object.assign({}, s, { image: d ? d.url : "" }); });
  const bySha = {}; ok.filter(d => d.role === "sku").forEach(d => { (bySha[d.sha] = bySha[d.sha] || []).push(d.code); });
  const shared = Object.entries(bySha).filter(([, c]) => c.length > 1).map(([sha, codes]) => ({ sha: sha.slice(0, 16), codes }));
  return { images_gallery: gallery, image: lead >= 0 ? gallery[lead].url : null, skus, shared,
    promo_only: lead < 0 && withheld.length > 0, withheld_promo: withheld.map(d => ({ url: d.url, src: d.src, from: d.from || "" })), dropped_duplicates: ok.filter(d => d.role === "gallery").length - uniq.length,
    failed: done.filter(d => d.error).map(d => ({ src: d.src, error: d.error })) };
}

/* ── 5. CLASSIFY ───────────────────────────────────────────────────────────────────────────────── */
/* The resolution in force for each issue of a page: the latest content_resolution decision (a later one supersedes). */
function resolutionsFor(decisions, pageKey){
  const out = {};
  (decisions || []).filter(d => d && d.kind === "content_resolution" && d.field === "page:" + pageKey).sort((a, b) => a.id - b.id)
    .forEach(d => { const v = d.hcps_value || {}; if(v.issue) out[v.issue] = Object.assign({ id: d.id, reason: d.reason, by: d.decided_by }, v); });
  return out;
}
/* Official per-option photos chosen in Review Issues: the latest choice per SKU (they survive a re-run). */
function skuImageChoices(decisions, pageKey){
  const out = {};
  (decisions || []).filter(d => d && d.kind === "content_resolution" && d.field === "page:" + pageKey && d.hcps_value && d.hcps_value.choice === "use_source_image")
    .sort((a, b) => a.id - b.id).forEach(d => { out[codeNorm(d.hcps_value.code)] = { url: d.hcps_value.image_url, why: d.hcps_value.why || "", id: d.id }; });
  return out;
}
const CHOICES = {
  conflict: [{ id: "same_product", label: "Same product: use its copy and photos" }, { id: "different_product", label: "Different product: don't use this page" }],
  catalog_fact: [{ id: "keep_catalog_fact", label: "Our figure is right: keep it out of the page copy" }, { id: "use_source", label: "Use only what the manufacturer states" }],
  catalog_name: [{ id: "use_source", label: "Use the manufacturer's wording on the page" }, { id: "keep_catalog_name", label: "Our catalog term is right: keep it out of the page copy until the manufacturer confirms" }],
  needs_grouping: [{ id: "own_page", label: "Its own page under its category (suggested)" }, { id: "hidden_order_by_code", label: "Hidden from browsing; dealers order it by code" }],
  needs_content: [{ id: "rerun_with_source", label: "Add a source (web page or PDF) and re-run this page", needs: "source_url" }, { id: "hold_back", label: "Hold this page back (its SKUs stay as they are today)" }],
  needs_image: [{ id: "upload", label: "Upload a photo for it", action: "upload" }, { id: "use_source_image", label: "Use an official manufacturer photo for this option", needs: "image_url" }, { id: "keep_one_photo", label: "Keep one photo for both" }],
  needs_category: [{ id: "set_category", label: "Choose the category", needs: "category" }],
  /* Angelo 2026-10-11: a source hold. The page stays an unpublished draft, its issues stay open (listed, not blocking),
     and its SKUs keep their current catalog cards until the hold is lifted. */
  hold: [{ id: "hold_back", label: "Hold back for source review (its SKUs keep their current catalog cards)" }]
};
/* page: from planPages; row: its draft (product_content) or null; decisions: the line's decisions. */
function classify(page, row, decisions, opts){
  opts = opts || {};
  const res = resolutionsFor(decisions, page.page_key);
  const held = !!((res.hold && res.hold.choice === "hold_back") || (res.needs_content && res.needs_content.choice === "hold_back"));
  if(!row) return { status: held ? "held_back" : "not_enriched", label: STATUS_LABEL[held ? "held_back" : "not_enriched"], issues: [], resolutions: res, blocking: !held };
  if(page.published && isVisibleRow(row)) return { status: "published", label: STATUS_LABEL.published, issues: [], resolutions: res, blocking: false };
  const mc = (row.enrichment_flags && row.enrichment_flags.mc) || {};
  const issues = [];
  const add = (type, title, detail, extra) => issues.push(Object.assign({ type, title, detail, choices: CHOICES[type] || [] }, extra || {}));
  /* Conflict */
  for(const c of (mc.conflicts || [])){
    const key = c.kind === "catalog_fact" || c.kind === "catalog_name" ? c.kind : "conflict";
    const r = res[key];
    if(r && key === "conflict" && r.choice === "different_product" && mc.sources && mc.sources.some(s => s.url && r.source_url && s.url === r.source_url)) {
      add("needs_content", "Re-run without the manufacturer page you rejected", "You said " + r.source_url + " is a different product; re-run this page so its copy and photos come from another source.", { rerun: true, choices: CHOICES.needs_content });
      continue;
    }
    if(r) continue;
    add("conflict", c.title, c.suggestion, { evidence: c.evidence, kind: c.kind, choices: CHOICES[key], resolution_key: key, source_url: (mc.sources || [])[0] && mc.sources[0].url });
  }
  for(const s of (page.skus || [])) if(!s.price_ok)
    add("conflict", "No dealer price on the commercial record for " + s.code, "Ready needs a price on the commercial record. Prices are set in Manufacturer Center → Commercial & freight, never here.", { choices: [], kind: "no_price" });
  if(page.live_page) add("conflict", "Already on a live page: " + page.live_page, "These SKUs already appear on the storefront. A frozen line's live page is not changed by enrichment.", { choices: [], kind: "live" });
  /* Needs grouping decision */
  if(page.bundle && !res.needs_grouping) add("needs_grouping", "Where should it appear?", "A display or bundle is never merged with other pages on its own" + (page.skus[0] && page.skus[0].catalog_description ? ": \u201c" + norm(page.skus[0].catalog_description).slice(0, 200) + "\u201d" : "") + ".", {});
  /* Needs content */
  const desc = norm(row.description), feats = Array.isArray(row.features) ? row.features.length : 0;
  const anySource = (mc.sources || []).some(s => s.role === "product" || s.role === "landing" || s.role === "related");
  const noSource = !(mc.sources || []).some(s => s.role === "product");
  if(!issues.some(i => i.rerun)){   // a source hold keeps its content issues listed
    if(noSource && anySource) add("needs_content", "No product-specific manufacturer source", "Bemis's " + [...new Set((mc.sources || []).filter(s => s.role !== "product").map(s => s.role === "related" ? "bundle page" : "landing page"))].join(" and ") + " show it exists, but a landing or bundle page is never a component's standalone description or specification source. Add an official source for this product and re-run.", {});
    else if(noSource) add("needs_content", "No manufacturer page found", "Only your catalog line exists" + (desc ? ": “" + desc.slice(0, 160) + "”" : "") + ". That is too thin for a product page.", {});
    else if(desc.length < 80 || feats < 3) add("needs_content", "Too little from the source", "The source says too little about this product to make a page: " + [desc.length < 80 ? (desc.length ? "a " + desc.length + "-character description" : "no description") : "", feats < 3 ? (feats ? "only " + feats + " feature" + (feats === 1 ? "" : "s") : "no features") : ""].filter(Boolean).join(" and ") + ". Add a better source, or hold the page back.", {});
  }
  /* Needs image */
  const hasGallery = Array.isArray(row.images_gallery) && row.images_gallery.some(g => g && g.url) || !!row.image;
  if(mc.images_done || opts.imagesDone){
    if(!hasGallery && mc.image_promo_only) add("needs_image", "Only banner / promo art was found", "A promo graphic is never a product's main photo. Add an official product photo.", { choices: [CHOICES.needs_image[0]] });
    else if(!hasGallery && !(res.needs_image && res.needs_image.choice === "keep_one_photo")) add("needs_image", "No photo could be copied into HCPS storage", (mc.image_failures && mc.image_failures.length ? mc.image_failures.length + " photo(s) failed to copy. " : "") + "Upload one.", { choices: [CHOICES.needs_image[0]] });
    for(const sh of (mc.image_shared || [])) if(!(res.needs_image && res.needs_image.choice === "keep_one_photo"))
      add("needs_image", sh.codes.join(" and ") + " show the identical photo", "Both SKUs point at the same picture today. A dealer choosing one option would see the other.", { codes: sh.codes });
  } else if(!hasGallery) add("needs_image", "Photos not copied yet", "Auto-Enrich copies the photos into HCPS storage in its next step.", { pending: true, choices: [] });
  /* Needs category */
  if(!row.subcategory && !row.category && !(res.needs_category)) add("needs_category", "No category", "Choose where dealers will find it.", {});
  issues.forEach(i => { i.resolved = false; if(held) i.held = true; });
  let status = "ready";
  for(const s of STATUSES) if(issues.some(i => i.type === s)){ status = s; break; }
  if(held) status = "held_back";
  return { status, label: STATUS_LABEL[status], issues, resolutions: res, blocking: !held && status !== "ready", held };
}

/* What one resolution choice asks for — validated before anything is recorded. */
function resolutionProblem(issue, choice, value){
  const list = CHOICES[issue] || [];
  const c = list.find(x => x.id === choice);
  if(!c) return "“" + choice + "” is not a choice for " + issue;
  if(c.needs === "source_url" && !/^https?:\/\/[^\s]+$/i.test(String((value && value.source_url) || ""))) return "a source URL (http or https) is required";
  if(c.needs === "category" && !norm(value && (value.subcategory || value.category))) return "a category is required";
  if(c.needs === "image_url" && (!/^https:\/\/[^\s]+\.(jpe?g|png|webp)(\?[^\s]*)?$/i.test(String((value && value.image_url) || "")) || !norm(value && value.code))) return "an https photo address and the SKU it is for are required";
  return null;
}
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

module.exports = { STATUSES, STATUS_LABEL, VARIANT_DIMS, KIND_WORDS, variantOf, planPages, decode, blocksOf, sectionsOf, extractPage, productLinks,
  scoreCandidate, pickProductLink, relevantFromLanding, unsupportedFacts, namedTerms, systemNames, imageCandidates, buildDraft, assembleImages, resolutionsFor, CHOICES,
  classify, resolutionProblem, specsFrom, neutralize, skuImageChoices, photoStem, isPromoUrl, slug, codeNorm, isVisibleRow, sha256, sigWords };

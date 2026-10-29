#!/usr/bin/env node
/* HCPS Product Enrichment — batch engine for a whole manufacturer line (owner, 2026-10-27 19:22).
   Uses the SAME enrichment code as Manufacturer Center → Continue Product Enrichment (netlify/functions/_enrich.js):
   planPages (one page per product, variants as options), extractPage (the manufacturer's own words, specs, documents,
   photos), buildDraft (neutral copy, provenance, conflicts), assembleImages (gallery, primary, per-SKU photos, duplicates
   and promo art withheld) and classify (Ready / Needs … statuses). It writes the storefront's static content file
   (public/data/content/<slug>.json — the layer the shop and the order server already read when a line has no
   published product_content rows) and copies every photo into the storefront's own assets, so a preview deploy shows
   the finished catalog without touching production data.

   RE-RUNS ARE SAFE: page keys are kept from the previous file; a person's corrections in
   content-overrides/<slug>.json ({ "<page_key>": { "<field>": value, ... }, "_skus": {...} }) are applied LAST on every
   run and never overwritten; photos are named by their content hash, so nothing is duplicated.
   No prices are read or written (prices stay in the private commercial record).

   node scripts/catalog-enrich.js --line <slug> --shop <ordering repo> --sources <sources.json {SKU: url}>
        [--catalog <catalog json, default <shop>/public/data/<slug>.json>] [--brand "Name"] [--max-images 8] [--report <file>]
        [--refresh] (re-read pages already cached)  [--cache <dir>] */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
const E = require("../netlify/functions/_enrich.js");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes("--" + n);
const slug = arg("line"); const shop = arg("shop");
if(!slug || !shop) { console.error("usage: --line <slug> --shop <ordering repo> --sources <file>"); process.exit(2); }
const catalogPath = arg("catalog", path.join(shop, "public", "data", slug + ".json"));
const contentPath = path.join(shop, "public", "data", "content", slug + ".json");
const overridesPath = path.join(shop, "content-overrides", slug + ".json");
const assetsDir = path.join(shop, "public", "assets", "products", slug, "gallery");
const assetsUrl = "/assets/products/" + slug + "/gallery/";
const cacheDir = arg("cache", path.join(require("os").tmpdir(), "hcps-enrich-cache", slug));
const brand = arg("brand", slug);
const maxImages = Number(arg("max-images", 8));
const sources = arg("sources") ? JSON.parse(fs.readFileSync(arg("sources"), "utf8")) : {};
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } };
const codeNorm = s => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
fs.mkdirSync(cacheDir, { recursive: true }); fs.mkdirSync(assetsDir, { recursive: true });

/* ── fetch (curl: the workspace proxy; one read per URL, cached) ── */
function get(url, binary) {
  const f = path.join(cacheDir, sha(url).slice(0, 24) + (binary ? ".bin" : ".html"));
  if (fs.existsSync(f) && !flag("refresh")) return fs.readFileSync(f, binary ? null : "utf8");
  try {
    const out = execFileSync("curl", ["-sSL", "--max-time", "30", "--max-filesize", "12000000", "-A", "Mozilla/5.0 (HCPS catalog enrichment)", url], { maxBuffer: 1 << 26 });
    fs.writeFileSync(f, out); return binary ? out : out.toString("utf8");
  } catch (e) { return null; }
}
function imageInfo(buf) {
  if (!buf || buf.length < 1024) return null;
  const h = buf.slice(0, 12);
  if (h[0] === 0xff && h[1] === 0xd8) return "jpg";
  if (h.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (h.slice(0, 4).toString() === "RIFF" && h.slice(8, 12).toString() === "WEBP") return "webp";
  return null;
}
/* A photo is stored once, named by its bytes; a large one is resized to 1200 px (sharp when present, else as is). */
function store(buf, ext) {
  /* one storage rule for every image (scripts/_catalog_images_lib.js): ≤900 px, an opaque PNG becomes JPEG, named by
     the stored bytes — so a re-run stores the same file again under the same name, never a second copy */
  const r = require("./_catalog_images_lib.js").storeImage(buf, assetsDir, assetsUrl, { minSide: 0 });
  return r.error ? { url: null, error: r.error, bytes: buf.length, sha: sha(buf) } : { url: r.url, bytes: buf.length, sha: sha(buf) };
}

function shopifyProduct(u) {
  if (!/\/products\/[^/?#]+/.test(u)) return null;
  const j = get(u.split(/[?#]/)[0].replace(/\/+$/, "") + ".json");
  try { const p = JSON.parse(j).product; return p && p.title ? p : null; } catch (e) { return null; }
}

/* A Wix site (Access4U, …) renders its text as rich-text blocks whose font class says what each block is: font_0 the
   page title, font_2/3 the manufacturer's prose and bullet lines, font_4 a section subtitle ("Threshold Ramp (TR)"),
   font_8 that section's size lines. Its photos are wixstatic thumbnails whose original is the URL without "/v1/…".
   The page is rebuilt as plain Description / Features / Specifications HTML and read by the same extractPage.
   A fragment in the source URL (…/thresholdramps#tr) names ONE section of a family page: its size lines become the
   specifications, and a photo whose alt text names only ANOTHER section is left out (a SKU never takes another
   model's photo — RULE 11). The words are the manufacturer's own; nothing is invented. */
const isWix = html => /<meta[^>]+name="generator"[^>]+Wix/i.test(html || "") && /static\.wixstatic\.com/.test(html || "");
function wixPage(html, u) {
  const raw = String(html || "");
  const foot = raw.search(/<footer\b/i); const body = foot > 0 ? raw.slice(0, foot) : raw;
  const txt = s => s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/[​ ]/g, " ").replace(/\s+/g, " ").trim();
  const blocks = [];
  for (const m of body.matchAll(/<(p|h[1-6]|li)\b[^>]*class="[^"]*\bfont_(\d+)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = txt(m[3]); if (t) blocks.push({ font: +m[2], text: t });
  }
  const title = (blocks.find(b => b.font === 0) || {}).text || "";
  const prose = blocks.filter(b => b.font === 2 || b.font === 3);
  /* sections: a font_4 subtitle and the size lines (font_8) under it */
  const secs = [];
  for (const b of blocks) { if (b.font === 4) secs.push({ title: b.text, lines: [] }); else if (b.font === 8 && secs.length) secs[secs.length - 1].lines.push(b.text); }
  const frag = decodeURIComponent((u.split("#")[1] || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = s => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/s$/, "")));
  const tokenOf = s => ((/\(([A-Za-z0-9]{1,8})\)/.exec(s) || [])[1] || "").toLowerCase();
  const own = frag ? secs.find(s => tokenOf(s.title) === frag) || secs.find(s => words(s.title).has(frag.replace(/s$/, ""))) : null;
  /* no section named by the fragment: a page with ONE size table shares it; otherwise no section is guessed */
  const pick = !frag ? secs : own ? [own] : secs.length === 1 ? secs : [];
  const distinct = s => { const w = words(s.title); for (const o of secs) if (o !== s) for (const x of words(o.title)) w.delete(x); return w; };
  /* "Label: value" stays as written; a bare size line is labelled by its own unit words */
  const specLine = (line, sec) => {
    const c = /^([A-Za-z][A-Za-z ]{1,30}):\s*(.+)$/.exec(line); if (c) return [c[1], c[2]];
    const f = /^(.{1,40}?)\s+for\s+(.+)$/i.exec(line); if (f) return [f[1], f[2]];
    if (/\blong\b|\blength\b/i.test(line)) return ["Length", line];
    if (/\bwide\b|\bwidth\b/i.test(line)) return ["Width", line];
    if (/\brise\b/i.test(line)) return ["Rise", line];
    return [sec.title.replace(/\s*\([^)]*\)\s*$/, ""), line];
  };
  const specs = [];
  for (const s of pick) for (const l of s.lines) { const [a, b] = specLine(l, s); if (b && !specs.some(x => x[0] === a)) specs.push([a, b]); }
  /* description = the opening prose; the remaining prose lines are the manufacturer's own feature lines. With a
     section chosen, a line that names only ANOTHER section ("Mini Ramps have a small curb …") is not this product's. */
  const otherOnly = t => { if (!own) return false; const tw = words(t); const mine = [...distinct(own)].some(x => tw.has(x));
    return !mine && secs.some(o => o !== own && [...distinct(o)].some(x => tw.has(x))); };
  const long = prose.filter(b => b.text.length >= 25 && !otherOnly(b.text));
  const desc = []; let rest = long;
  while (rest.length && desc.length < 2 && (!desc.length || desc.join(" ").length < 80)) { desc.push(rest[0].text); rest = rest.slice(1); }
  const feats = rest.map(b => b.text).filter(t => t.length <= 240).concat(prose.filter(b => b.text.length < 25 && b.text.length >= 8 && !otherOnly(b.text)).map(b => b.text));
  /* photos: the originals of the content photos (no logo, award or tiny icon) */
  const others = secs.filter(s => s !== own);
  const imgs = [];
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const src = (m[0].match(/\ssrc="([^"]+)"/i) || [])[1] || ""; const alt = txt((m[0].match(/\salt="([^"]*)"/i) || [])[1] || "");
    const w = +((/\/w_(\d+),/.exec(src) || [])[1] || 0);
    if (!/static\.wixstatic\.com\/media\/[^/]+~mv2\./.test(src) || /logo|award/i.test(alt) || (w && w <= 40 && !alt)) continue;
    /* the original, served by Wix at a fixed size no wider than 1200 px (an original upload can exceed the fetch limit) */
    const orig = src.replace(/\/v1\/.*$/, ""); const full = orig + "/v1/fit/w_1200,h_1200,q_90/" + orig.split("/").pop();
    if (frag) {
      const aw = words(alt);
      const mineHit = own && [...distinct(own)].some(x => aw.has(x));
      const otherHit = others.some(o => [...distinct(o)].some(x => aw.has(x)));
      if (otherHit && !mineHit) continue;
      if (!own && others.some(o => [...words(o.title)].some(x => aw.has(x)))) continue;
    }
    if (!imgs.some(x => x.src === full)) imgs.push({ src: full, alt: alt || title });
  }
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const head = own ? own.title : title;
  const out = "<html><head><title>" + esc(head) + "</title></head><body><h1>" + esc(head) + "</h1>" +
    "<h2>Description</h2>" + desc.map(d => "<p>" + esc(d) + "</p>").join("") +
    (feats.length ? "<h2>Features</h2><ul>" + feats.map(f => "<li>" + esc(f) + "</li>").join("") + "</ul>" : "") +
    (specs.length ? "<h2>Specifications</h2>" + specs.map(s => "<p>" + esc(s[0]) + ": " + esc(s[1]) + "</p>").join("") : "") +
    imgs.map(i => '<img src="' + esc(i.src) + '" alt="' + esc(i.alt) + '">').join("") + "</body></html>";
  const ex = E.extractPage(out, u);
  ex.product = true;   // a manufacturer's own product / product-family page
  ex.wix = { section: own ? own.title : null, family: title };
  return ex;
}

/* ── 1. the line's products and the pages they form ── */
const catalog = readJson(catalogPath, []);
if (!Array.isArray(catalog) || !catalog.length) { console.error("no catalog rows at " + catalogPath); process.exit(2); }
const prev = readJson(contentPath, { pages: {} });
const overrides = readJson(overridesPath, {});
const records = catalog.map(r => ({ code: r.code, code_norm: codeNorm(r.code), status: "active", base_price: 1, uom: r.uom || null, case_qty: r.case_qty || null }));
/* a site's home page ("https://www.pedifix.com") is not a product page: it never sources a product nor groups SKUs */
const productUrl = u => /^https?:\/\/[^/]+\/[^#?\s]+/i.test(String(u || "")) ? u : "";
const cat2 = catalog.map(r => Object.assign({}, r, { details_url: productUrl(sources[r.code] || sources[codeNorm(r.code)] || r.details_url || "") }));
/* pages from the previous run keep their keys (drafts, never "live" here: the static file is the preview's own) */
const prevPages = Object.values(prev.pages || {}).map(p => Object.assign({}, p, { status: "pending_review" }));
const plan = E.planPages({ slug, records, catalog: cat2, pages: prevPages });

/* One manufacturer product page = one HCPS page: SKUs the source map points at the SAME official product page (its
   size / colour / pack variants) are options of one page, labelled by the manufacturer's own variant title. Bundles and
   displays are never merged (the engine's rule). */
{
  const byUrl = new Map();
  for (const pg of plan.pages) {
    /* the query is dropped; a fragment is kept — it names one section of a family page (see wixPage) */
    const urls = [...new Set(pg.skus.map(x => (x.details_url || "").replace(/\?[^#]*/, "").replace(/\/+(?=#|$)/, "")).filter(Boolean))];
    if (pg.bundle || urls.length !== 1) continue;
    if (!byUrl.has(urls[0])) byUrl.set(urls[0], []); byUrl.get(urls[0]).push(pg);
  }
  for (const [u, group] of byUrl) {
    if (group.length < 2) continue;
    const shop = shopifyProduct(u);
    const title = sku => { const v = shop && (shop.variants || []).find(x => codeNorm(x.sku) === codeNorm(sku)); return v && v.title && v.title !== "Default Title" ? v.title : ""; };
    const lead = group[0];
    /* without a manufacturer product title, the page is named by the words its SKUs' names share ("Assist Ramp No Rail") */
    const shared = (() => { const ns = group.flatMap(g => g.skus).map(x => String(x.name || "").split(/\s+/)); let i = 0;
      while (ns.every(n => n[i] && n[i].toLowerCase() === ns[0][i].toLowerCase() && !/\d/.test(n[i]))) i++; return ns[0].slice(0, i).join(" ").replace(/[,\-–]+$/, ""); })();
    const wixHtml = !shop ? get(u.split("#")[0]) : null;
    const wix = !!wixHtml && isWix(wixHtml); const section = wix ? (wixPage(wixHtml, u).wix || {}).section : null;
    /* (Wix family pages only — every other line keeps its lead SKU's name, as before) */
    lead.name = shop && shop.title ? shop.title.replace(/\s*\(#[^)]*\)\s*$/, "") : !wix ? lead.name : shared.split(" ").length >= 2 ? shared : section ||
      (String(lead.name).split(/\s+/).slice(0, Math.max(1, String(lead.name).split(/\s+/).findIndex(w => /\d/.test(w)))).join(" ").replace(/[,\-–]+$/, "") || lead.name);
    lead.skus = group.flatMap(g => g.skus).map(x => Object.assign({}, x, { option: title(x.code) || x.option || x.name }));
    lead.options = { Option: lead.skus.map(x => x.option) };
    lead.group_reason = "one manufacturer product page (" + u + ") lists these SKUs as its variants";
    group.slice(1).forEach(g => { g._merged = true; });
  }
  plan.pages = plan.pages.filter(pg => !pg._merged);
}

/* ── 2. enrich every page from its manufacturer source(s) ── */
const pages = {}, report = { line: slug, at: new Date().toISOString(), pages: [], statuses: {} };
for (const page of plan.pages) {
  const urls = [...new Set(page.skus.map(s => s.details_url).filter(Boolean))];
  const srcs = [];
  for (const u of urls) {
    const html = get(u.split("#")[0]);
    if (!html) { srcs.push(null); continue; }
    let ex = isWix(html) ? wixPage(html, u) : E.extractPage(html, u);
    /* A Shopify store (PediFix, …) publishes each product as JSON at <product url>.json: the manufacturer's own
       description, every product photo and the photo of each variant SKU. Its words go through the same extractPage. */
    const shop = shopifyProduct(u);
    if (shop) {
      const variantImgs = shop.images || [];
      const body = "<h2>Description</h2>" + String(shop.body_html || "");
      const imgs = variantImgs.map(im => '<img src="' + String(im.src).replace(/"/g, "") + '" alt="' + String(shop.title || "").replace(/"/g, "") + '">').join("");
      const ld = '<script type="application/ld+json">' + JSON.stringify({ "@type": "Product", name: shop.title, sku: ((shop.variants || [])[0] || {}).sku || "" }) + "</script>";
      const ex2 = E.extractPage("<html><head><title>" + shop.title + "</title>" + ld + "</head><body>" + body + imgs + "</body></html>", u);
      ex2.features = [...new Set((ex.features || []).concat(ex2.features || []))];
      ex2.specs = (ex2.specs || []).length ? ex2.specs : (ex.specs || []);
      if ((ex.description || "").length > (ex2.description || "").length) ex2.description = ex.description;
      ex2.text = ex.text + " " + ex2.text; ex2.links = ex.links; ex2.videos = [...new Set(ex.videos.concat(ex2.videos))]; ex2.documents = ex.documents.concat(ex2.documents);
      ex2.shopify = { variants: (shop.variants || []).map(v => ({ sku: v.sku, title: v.title, image: (variantImgs.find(im => im.id === v.image_id) || {}).src || "" })) };
      ex = ex2;
    }
    srcs.push({ url: u, role: ex.product ? "product" : "landing", extract: ex, matched_by: shop ? "official SKU source map (manufacturer product data)" : ex.wix ? "official SKU source map (manufacturer page" + (ex.wix.section ? ", section " + ex.wix.section : "") + ")" : "official SKU source map" });
  }
  const sources2 = srcs.filter(Boolean);
  /* the variant's own photo, from the manufacturer's product data, is that SKU's option photo */
  const skuImages = {};
  for (const sx of sources2) for (const v of ((sx.extract.shopify || {}).variants || [])) if (v.image && v.sku) skuImages[codeNorm(v.sku)] = { url: v.image, why: "the manufacturer's photo of this variant" };
  const { row, report: rep } = E.buildDraft(page, sources2, { slug, brand, orderingBase: "", skuImages });
  /* photos: the engine's candidates, copied into the storefront's assets */
  const done = [];
  let n = 0;
  for (const c of rep.image_candidates) {
    if (c.role === "gallery" && n >= maxImages) continue;
    let buf = null;
    if (/^https?:/i.test(c.src)) buf = get(c.src, true);
    else { const local = path.join(shop, "public", c.src.replace(/^\//, "")); if (fs.existsSync(local)) buf = fs.readFileSync(local); }
    const ext = imageInfo(buf);
    if (!ext) { done.push({ src: c.src, role: c.role, code: c.code, error: buf ? "not an image" : "could not be read" }); continue; }
    const s = store(buf, ext); if (!s.url) { done.push({ src: c.src, role: c.role, code: c.code, error: s.error }); continue; } if (c.role === "gallery") n++;
    done.push(Object.assign({ src: c.src, role: c.role, code: c.code, from: c.from, promo: c.promo }, s));
  }
  const img = E.assembleImages(page, row, done);
  const out = Object.assign({}, row, {
    status: "published", image: img.image || (row.skus[0] && catalog.find(r => codeNorm(r.code) === codeNorm(row.skus[0].sku)) || {}).image || null,
    images_gallery: img.images_gallery, skus: img.skus,
    enrichment_flags: { mc: Object.assign({}, rep, { images_done: true, image_failures: img.failed, image_shared: img.shared, image_promo_only: img.promo_only, image_withheld: img.withheld_promo }) },
  });
  /* the engine's own classification decides what the report calls Ready */
  const cls = E.classify(page, out, [], { imagesDone: true });
  /* a person's corrections win, every run */
  const ov = overrides[out.page_key] || {};
  for (const [k, v] of Object.entries(ov)) out[k] = v;
  out.enrichment_flags.mc.status = cls.status;
  pages[out.page_key] = out;
  report.statuses[cls.status] = (report.statuses[cls.status] || 0) + 1;
  report.pages.push({ page_key: out.page_key, name: out.name, skus: out.skus.map(s => s.sku), status: cls.status, issues: cls.issues.map(i => i.title),
    photos: (out.images_gallery || []).length, description: !!out.description, features: (out.features || []).length, specs: (out.specs || []).length,
    category: out.subcategory || out.category || "", source: out.source_url || null, overridden: Object.keys(ov) });
}

/* ── 2b. images: a person's approved images (overrides "_images") on every run, then the cleaning rules
   (site chrome, tiny / duplicate photos, real primary, option-photo rules) — scripts/_catalog_images_lib.js ── */
{
  const IL = require("./_catalog_images_lib.js");
  const log = IL.applyApproved(pages, overrides._images || {}, shop, {});
  IL.cleanPages(pages, shop, log);
  IL.applyRetired(pages, overrides._retired || {}, log);
  report.images = Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.length]));
}

/* ── 3. completeness: expected (catalog) vs completed ── */
const onPage = new Set(Object.values(pages).flatMap(p => p.skus.map(s => codeNorm(s.sku))));
const skuWithImage = new Set(Object.values(pages).flatMap(p => p.skus.filter(s => s.image || (p.images_gallery || []).length).map(s => codeNorm(s.sku))));
const ready = Object.values(pages).filter(p => p.enrichment_flags.mc.status === "ready");
report.completeness = {
  expected_skus: catalog.length, skus_on_pages: onPage.size, skus_with_photo: skuWithImage.size,
  pages: Object.keys(pages).length, pages_ready: ready.length,
  pages_with_2plus_photos: Object.values(pages).filter(p => (p.images_gallery || []).length >= 2).length,
  pages_with_description: Object.values(pages).filter(p => p.description).length,
  pages_with_specs: Object.values(pages).filter(p => (p.specs || []).length).length,
  categories: [...new Set(catalog.map(r => r.category).filter(Boolean))].length,
  categories_with_pages: [...new Set(Object.values(pages).map(p => p.category).filter(Boolean))].length,
  skus_missing_from_pages: catalog.filter(r => !onPage.has(codeNorm(r.code))).map(r => r.code),
};
const file = { meta: { line: slug, engine: "HCPS Product Enrichment (_enrich.js)", generated: report.at, sources: Object.keys(sources).length,
  note: "Generated by scripts/catalog-enrich.js. Corrections go in content-overrides/" + slug + ".json, never here." }, pages };
fs.mkdirSync(path.dirname(contentPath), { recursive: true });
fs.writeFileSync(contentPath, JSON.stringify(file, null, 1) + "\n");
if (arg("report")) fs.writeFileSync(arg("report"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(Object.assign({ line: slug, statuses: report.statuses }, report.completeness, { skus_missing_from_pages: report.completeness.skus_missing_from_pages.length })));

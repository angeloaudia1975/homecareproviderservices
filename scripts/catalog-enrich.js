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
  const name = sha(buf).slice(0, 20) + "." + ext; const file = path.join(assetsDir, name);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, buf);
    /* a photo wider than 1200 px is scaled down in place (ImageMagick when present); the original stays cached */
    try { execFileSync("convert", [file, "-resize", "1200x1200>", "-strip", "-quality", "86", file]); } catch (e) {}
  }
  return { url: assetsUrl + name, bytes: buf.length, sha: sha(buf) };
}

function shopifyProduct(u) {
  if (!/\/products\/[^/?#]+/.test(u)) return null;
  const j = get(u.split(/[?#]/)[0].replace(/\/+$/, "") + ".json");
  try { const p = JSON.parse(j).product; return p && p.title ? p : null; } catch (e) { return null; }
}

/* ── 1. the line's products and the pages they form ── */
const catalog = readJson(catalogPath, []);
if (!Array.isArray(catalog) || !catalog.length) { console.error("no catalog rows at " + catalogPath); process.exit(2); }
const prev = readJson(contentPath, { pages: {} });
const overrides = readJson(overridesPath, {});
const records = catalog.map(r => ({ code: r.code, code_norm: codeNorm(r.code), status: "active", base_price: 1, uom: r.uom || null, case_qty: r.case_qty || null }));
const cat2 = catalog.map(r => Object.assign({}, r, { details_url: sources[r.code] || sources[codeNorm(r.code)] || r.details_url || "" }));
/* pages from the previous run keep their keys (drafts, never "live" here: the static file is the preview's own) */
const prevPages = Object.values(prev.pages || {}).map(p => Object.assign({}, p, { status: "pending_review" }));
const plan = E.planPages({ slug, records, catalog: cat2, pages: prevPages });

/* One manufacturer product page = one HCPS page: SKUs the source map points at the SAME official product page (its
   size / colour / pack variants) are options of one page, labelled by the manufacturer's own variant title. Bundles and
   displays are never merged (the engine's rule). */
{
  const byUrl = new Map();
  for (const pg of plan.pages) {
    const urls = [...new Set(pg.skus.map(x => (x.details_url || "").replace(/[?#].*$/, "").replace(/\/+$/, "")).filter(Boolean))];
    if (pg.bundle || urls.length !== 1) continue;
    if (!byUrl.has(urls[0])) byUrl.set(urls[0], []); byUrl.get(urls[0]).push(pg);
  }
  for (const [u, group] of byUrl) {
    if (group.length < 2) continue;
    const shop = shopifyProduct(u);
    const title = sku => { const v = shop && (shop.variants || []).find(x => codeNorm(x.sku) === codeNorm(sku)); return v && v.title && v.title !== "Default Title" ? v.title : ""; };
    const lead = group[0];
    lead.name = shop && shop.title ? shop.title.replace(/\s*\(#[^)]*\)\s*$/, "") : lead.name;
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
    const html = get(u);
    if (!html) { srcs.push(null); continue; }
    let ex = E.extractPage(html, u);
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
    srcs.push({ url: u, role: ex.product ? "product" : "landing", extract: ex, matched_by: shop ? "official SKU source map (manufacturer product data)" : "official SKU source map" });
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
    const s = store(buf, ext); if (c.role === "gallery") n++;
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

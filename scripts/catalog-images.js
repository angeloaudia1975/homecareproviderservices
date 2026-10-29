#!/usr/bin/env node
/* HCPS Product Enrichment — images, for any manufacturer line (owner, 2026-10-27 "complete image recovery").
   Works on the storefront's static content file (public/data/content/<slug>.json) and assets, the same layer
   scripts/catalog-enrich.js writes; nothing here reads or writes a price.

   node scripts/catalog-images.js audit    --line <slug> --shop <ordering repo> [--out <file.json>]
        Per SKU, what a dealer is shown (SKU photo → page photo → catalog photo), its size, gallery count, and problems:
        no_photo, broken_file, unreadable, low_resolution, shared_across_products.
   node scripts/catalog-images.js clean    --line <slug> --shop <dir>
        Removes site chrome (cookie badges / icons repeated on many pages), tiny photos beside real ones, duplicate
        pictures; makes a real photo the primary; a photo given to every option becomes the page photo; an old small
        thumbnail no longer outranks the manufacturer's photo. (catalog-enrich runs the same step on every run.)
   node scripts/catalog-images.js import   --line <slug> --shop <dir> (--map <map.json> | --zip <file.zip> | --dir <folder>) [--dry-run]
        Imports verified images: map = {"SKU":[{url|file, source, note}], "_unresolved":{…}}; ZIP / folder = image files
        named by SKU ("RS1x36.jpg", "RS1x36_2.jpg", "RS1x36-side.png") or inside a folder named by the SKU. Every image
        is read, checked (real image, ≥300 px), resized to ≤900 px, stored once by its bytes, de-duplicated against the
        product's gallery, then recorded in content-overrides/<slug>.json "_images" (kept on every future run) and applied.
   node scripts/catalog-images.js discover --line <slug> --shop <dir> --site <https://manufacturer.com> --out <sources.json> [--existing <sources.json>] [--max-pages 1500]
        Finds the manufacturer's page for each SKU by crawling the site's product list (Shopify products.json, else the
        sitemaps) and looking for the exact SKU on each page; writes a SKU → page map for catalog-enrich. A SKU found on
        several pages is listed as ambiguous, never guessed.
   Every command prints a JSON summary. Re-runs never duplicate anything. */
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const L = require("./_catalog_images_lib.js");

const cmd = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes("--" + n);
const slug = arg("line"), shop = arg("shop");
if (!cmd || !slug || !shop) { console.error("usage: catalog-images.js audit|clean|import|discover --line <slug> --shop <ordering repo> …"); process.exit(2); }
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } };
const catalogPath = arg("catalog", path.join(shop, "public", "data", slug + ".json"));
const contentPath = path.join(shop, "public", "data", "content", slug + ".json");
const overridesPath = path.join(shop, "content-overrides", slug + ".json");
const assetsDir = path.join(shop, "public", "assets", "products", slug, "gallery");
const assetsUrl = "/assets/products/" + slug + "/gallery/";
const cacheDir = arg("cache", path.join(os.tmpdir(), "hcps-enrich-cache", slug));
fs.mkdirSync(cacheDir, { recursive: true });
const catalog = readJson(catalogPath, []);
const content = readJson(contentPath, { meta: {}, pages: {} });
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1) + "\n"); };

function get(url, binary) {
  const f = path.join(cacheDir, L.sha(url).slice(0, 24) + (binary ? ".bin" : ".html"));
  if (fs.existsSync(f) && !flag("refresh")) return fs.readFileSync(f, binary ? null : "utf8");
  try {
    const out = execFileSync("curl", ["-sSL", "--fail", "--max-time", "40", "--max-filesize", "26000000", "-A", "Mozilla/5.0 (HCPS catalog enrichment)", url], { maxBuffer: 1 << 27, stdio: ["ignore", "pipe", "ignore"] });
    fs.writeFileSync(f, out); return binary ? out : out.toString("utf8");
  } catch (e) { return null; }
}

if (cmd === "audit") {
  const a = L.audit(slug, catalog, content.pages || {}, shop, readJson(overridesPath, {})._retired);
  if (arg("out")) writeJson(arg("out"), a);
  console.log(JSON.stringify(a.summary));
}

else if (cmd === "clean") {
  const log = L.cleanPages(content.pages || {}, shop, {});
  writeJson(contentPath, content);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.length]))));
}

else if (cmd === "import") {
  const codes = catalog.map(r => r.code);
  const known = new Set(codes.map(L.codeNorm));
  const items = [];            // {sku, buf|null, from, source, note}
  const report = { imported: [], rejected: [], unmatched: [], unresolved: {} };
  if (arg("map")) {
    const map = readJson(arg("map"), null); if (!map) { console.error("cannot read " + arg("map")); process.exit(2); }
    Object.assign(report.unresolved, map._unresolved || {});
    for (const [sku, list] of Object.entries(map)) {
      if (sku.startsWith("_")) continue;
      const code = codes.find(c => L.codeNorm(c) === L.codeNorm(sku));
      if (!code) { report.unmatched.push({ sku, why: "not a SKU of this line" }); continue; }
      for (const it of list || []) {
        const loc = it.file || it.url || "";
        const buf = /^https?:/i.test(loc) ? get(loc, true) : fs.existsSync(loc) ? fs.readFileSync(loc) : null;
        items.push({ sku: code, buf, from: loc, source: it.source || loc, note: it.note || "" });
      }
    }
  }
  if (arg("zip") || arg("dir")) {
    let dir = arg("dir");
    if (arg("zip")) { dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcps-zip-")); execFileSync("unzip", ["-qq", "-o", arg("zip"), "-d", dir]); }
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name.startsWith("__MACOSX") ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
    const files = walk(dir).filter(f => /\.(jpe?g|png|webp|gif|tiff?|bmp)$/i.test(f) && !path.basename(f).startsWith("."))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const f of files) {
      const rel = path.relative(dir, f); const m = L.matchFileToSku(rel, codes);
      if (!m.sku) { report.unmatched.push({ file: rel, why: m.why }); continue; }
      items.push({ sku: m.sku, buf: fs.readFileSync(f), from: rel, source: "owner-supplied image (" + path.basename(arg("zip") || dir) + ": " + rel + ", matched by " + m.by + ")", note: "" });
    }
  }
  const overrides = readJson(overridesPath, {});
  const approved = overrides._images || {};
  for (const it of items) {
    if (!known.has(L.codeNorm(it.sku))) continue;
    if (!it.buf) { report.rejected.push({ sku: it.sku, from: it.from, why: "could not be downloaded or read" }); continue; }
    const s = flag("dry-run") ? (() => { const t = path.join(os.tmpdir(), "hcps-dry"); fs.writeFileSync(t, it.buf); const d = L.dims(t); return L.longSide(d) >= L.MIN_SIDE ? { url: "(dry run)", size: d.join("x") } : { error: L.longSide(d) ? "too small (" + d.join("x") + ")" : "not an image" }; })()
      : L.storeImage(it.buf, assetsDir, assetsUrl);
    if (s.error) { report.rejected.push({ sku: it.sku, from: it.from, why: s.error }); continue; }
    const list = approved[it.sku] = approved[it.sku] || [];
    if (!list.some(x => x.url === s.url)) list.push({ url: s.url, source: it.source, note: it.note });
    report.imported.push({ sku: it.sku, url: s.url, size: s.size, from: it.from });
  }
  if (!flag("dry-run")) {
    overrides._images = approved; writeJson(overridesPath, overrides);
    const log = L.applyApproved(content.pages || {}, approved, shop, {});
    L.cleanPages(content.pages || {}, shop, log);
    L.applyRetired(content.pages || {}, overrides._retired || {}, log);
    writeJson(contentPath, content);
    report.applied = Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.length]));
  }
  if (arg("report")) writeJson(arg("report"), report);
  console.log(JSON.stringify({ imported: report.imported.length, rejected: report.rejected.length, unmatched: report.unmatched.length, unresolved: Object.keys(report.unresolved).length, applied: report.applied || null }));
}

else if (cmd === "discover") {
  const site = String(arg("site") || "").replace(/\/+$/, ""); if (!/^https?:\/\//.test(site)) { console.error("--site https://… required"); process.exit(2); }
  const max = Number(arg("max-pages", 1500));
  const existing = readJson(arg("existing", ""), {});
  const found = {}, ambiguous = {};
  const codes = catalog.map(r => r.code);
  /* 1. Shopify: the store's product list names every variant SKU */
  let shopify = false;
  for (let pg = 1; pg <= 40; pg++) {
    const j = get(site + "/products.json?limit=250&page=" + pg); let list = null;
    try { list = JSON.parse(j).products; } catch (e) { break; }
    if (!list || !list.length) break; shopify = true;
    for (const p of list) for (const v of p.variants || []) { const c = codes.find(x => L.codeNorm(x) === L.codeNorm(v.sku)); if (c) (found[c] = found[c] || new Set()).add(site + "/products/" + p.handle); }
  }
  /* 2. otherwise the sitemaps: product-like pages, read once each, searched for the exact SKU */
  let pagesRead = 0;
  if (!shopify) {
    const seen = new Set(), queue = [site + "/sitemap_index.xml", site + "/sitemap.xml", site + "/product-sitemap.xml", site + "/wp-sitemap.xml"], urls = [];
    while (queue.length && seen.size < 80) {
      const sm = queue.shift(); if (seen.has(sm)) continue; seen.add(sm);
      const x = get(sm); if (!x || !/<(urlset|sitemapindex)/i.test(x)) continue;
      for (const m of x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) { const u = m[1].replace(/&amp;/g, "&"); if (/\.xml(\?|$)/i.test(u)) queue.push(u); else if (!/\.(jpe?g|png|webp|gif|pdf)(\?|$)/i.test(u)) urls.push(u); }
    }
    const productish = urls.filter(u => /product|\/p\/|item|shop/i.test(u));
    const list = (productish.length >= 10 ? productish : urls).slice(0, max);
    const strip = h => h.replace(/<script[\s\S]*?<\/script>/gi, m => /"sku"|application\/ld\+json/i.test(m) ? m : " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
    const pats = codes.map(c => ({ c, re: new RegExp("(^|[^A-Za-z0-9-])" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9])", "i") }));
    for (const u of list) {
      const h = get(u); if (!h) continue; pagesRead++;
      const t = strip(h);
      for (const { c, re } of pats) if (L.codeNorm(c).length >= 3 && re.test(t)) (found[c] = found[c] || new Set()).add(u);
    }
  }
  const out = Object.assign({}, existing);
  let added = 0;
  for (const c of codes) {
    if (out[c]) continue;
    const s = [...(found[c] || [])]; if (!s.length) continue;
    /* several pages name the SKU: the one whose address or title carries it, else ambiguous */
    const own = s.filter(u => L.codeNorm(u).includes(L.codeNorm(c)));
    const pick = s.length === 1 ? s[0] : own.length === 1 ? own[0] : null;
    if (pick) { out[c] = pick; added++; } else ambiguous[c] = s.slice(0, 6);
  }
  writeJson(arg("out"), out);
  const missing = codes.filter(c => !out[c] && !ambiguous[c]);
  if (arg("report")) writeJson(arg("report"), { ambiguous, missing });
  console.log(JSON.stringify({ mode: shopify ? "shopify" : "sitemap", pages_read: pagesRead, skus: codes.length, mapped: Object.keys(out).filter(k => codes.includes(k)).length, added, ambiguous: Object.keys(ambiguous).length, not_found: missing.length }));
}
/* prune: files in the line's gallery folder that no page, approved image or catalog row refers to any more
   (an earlier run's copy under an older name). --dry-run lists them. */
else if (cmd === "prune") {
  const refs = new Set();
  const add = u => { if (u && typeof u === "string" && u.startsWith(assetsUrl)) refs.add(u.slice(assetsUrl.length)); };
  JSON.stringify(content, (k, v) => { add(v); return v; });
  JSON.stringify(readJson(overridesPath, {}), (k, v) => { add(v); return v; });
  JSON.stringify(catalog, (k, v) => { add(v); return v; });
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const orphans = files.filter(f => !refs.has(f));
  if (!flag("dry-run")) for (const f of orphans) fs.unlinkSync(path.join(assetsDir, f));
  console.log(JSON.stringify({ files: files.length, referenced: files.length - orphans.length, removed: flag("dry-run") ? 0 : orphans.length, orphans: flag("dry-run") ? orphans.length : undefined }));
}
/* retire / restore: the owner's reversible removal of SKUs from the dealer catalog (see applyRetired).
   catalog-images retire --line <slug> --shop <dir> --skus A,B,C --reason "<why>" [--ref "<decision ref>"]
   catalog-images restore --line <slug> --shop <dir> --skus A,B */
else if (cmd === "retire" || cmd === "restore") {
  const list = String(arg("skus", "")).split(",").map(x => x.trim()).filter(Boolean);
  const codes = catalog.map(r => r.code);
  const unknown = list.filter(x => !codes.some(c => L.codeNorm(c) === L.codeNorm(x)));
  if (!list.length || unknown.length) { console.error(unknown.length ? "not SKUs of this line: " + unknown.join(", ") : "--skus required"); process.exit(2); }
  if (cmd === "retire" && !arg("reason")) { console.error("--reason required"); process.exit(2); }
  const overrides = readJson(overridesPath, {});
  overrides._retired = overrides._retired || {};
  for (const x of list) {
    const code = codes.find(c => L.codeNorm(c) === L.codeNorm(x));
    if (cmd === "retire") overrides._retired[code] = { reason: arg("reason"), decided: arg("decided", new Date().toISOString().slice(0, 10)), ref: arg("ref", "") };
    else delete overrides._retired[code];
  }
  writeJson(overridesPath, overrides);
  const log = L.applyRetired(content.pages || {}, overrides._retired, {});
  writeJson(contentPath, content);
  console.log(JSON.stringify({ retired_now: Object.keys(overrides._retired).length, changed: Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.length])) }));
}
else { console.error("unknown command " + cmd); process.exit(2); }

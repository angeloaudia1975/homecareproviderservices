#!/usr/bin/env node
/* Apply a line's parent-family rules (content-overrides/<slug>.json "_families") to its storefront content file.
   node scripts/catalog-families.js --line <slug> --shop <ordering repo> [--dry-run]
   Prints cards before / after, orderable SKUs, and any problem (a SKU on no page or two pages, a family whose axes
   cannot tell two SKUs apart, an axis that cannot be read). A problem stops the write. catalog-enrich runs the same
   step on every enrichment run, so a new price list keeps its families. See scripts/_catalog_families.js. */
const fs = require("fs"), path = require("path");
const F = require("./_catalog_families.js");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes("--" + n);
const slug = arg("line"), shop = arg("shop");
if (!slug || !shop) { console.error("usage: --line <slug> --shop <ordering repo> [--dry-run]"); process.exit(2); }
const rd = p => JSON.parse(fs.readFileSync(p, "utf8"));
const contentPath = path.join(shop, "public", "data", "content", slug + ".json");
const catalog = rd(path.join(shop, "public", "data", slug + ".json"));
const content = rd(contentPath);
const ov = fs.existsSync(path.join(shop, "content-overrides", slug + ".json")) ? rd(path.join(shop, "content-overrides", slug + ".json")) : {};
const retired = new Set(Object.keys(ov._retired || {}).map(s => s.toUpperCase().replace(/[^A-Z0-9]/g, "")));
const cards = pages => Object.values(pages).filter(p => (p.skus || []).some(s => !s.disabled && s.status !== "hidden")).length;
const before = cards(content.pages);
const { log, problems } = F.applyFamilies(content.pages, catalog, ov._families || [], {});
const orderable = catalog.filter(r => !retired.has(r.code.toUpperCase().replace(/[^A-Z0-9]/g, ""))).length;
const out = { line: slug, cards_before: before, cards_after: cards(content.pages), catalog_skus: catalog.length, orderable_skus: orderable,
  families: log.family || [], merged_pages: (log.page_merged || []).length, problems };
if (!problems.length && !flag("dry-run")) fs.writeFileSync(contentPath, JSON.stringify(content, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));
process.exit(problems.length ? 1 : 0);

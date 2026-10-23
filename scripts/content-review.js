#!/usr/bin/env node
/* Manufacturer CONTENT review — read-only CLI (Catalog Completion).
   Reads researched content (<mfr>-content.json) + our catalog SKU list (<mfr>-skus.json, code + name only — any price
   field is ignored) from a scratch folder, runs netlify/functions/_content_review.js, and writes a review package to an
   OUTPUT folder outside the repo: per-line JSON, one exceptions queue, image staging records and a review workbook.
   It writes nothing to Supabase, storage or the repo, publishes nothing and rehosts nothing. With --fetch-images it GETs
   each candidate image once (in memory: status, type, size, SHA-256, pixel size) — the bytes are never saved.

     node scripts/content-review.js --in <research dir> --out <output dir> [--fetch-images] [--only dalton,pedifix]

   Why a CLI and not an admin action: the researched copy is unverified and must not be committed or written to
   production, and an admin screen would need it stored server-side first. Once Angelo accepts a page's source, it goes
   through Manufacturer Center → Continue Product Enrichment (product_content drafts, product_content_sources,
   content_resolution / content_approval decisions) — the one content path. */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const CR = require(path.join(__dirname, "..", "netlify", "functions", "_content_review.js"));

const LINES = ["dalton", "pedifix", "access4u", "corsicana", "ohio-medical", "airavant-bongorx", "abm-respiratory-care"];
const SKU_ALIASES = { "abm-respiratory-care": ["abm"] };

function args(argv){
  const a = { fetch: false, only: null };
  for(let i = 0; i < argv.length; i++){
    const k = argv[i];
    if(k === "--in") a.in = argv[++i]; else if(k === "--out") a.out = argv[++i]; else if(k === "--fetch-images") a.fetch = true;
    else if(k === "--only") a.only = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if(k === "--concurrency") a.conc = Number(argv[++i]);
    else throw new Error("unknown argument " + k);
  }
  if(!a.in || !a.out) throw new Error("usage: --in <research dir> --out <output dir> [--fetch-images] [--only a,b]");
  const repo = path.resolve(__dirname, "..");
  if(path.resolve(a.out).startsWith(repo + path.sep) || path.resolve(a.out) === repo) throw new Error("refusing to write the review package inside the repository");
  return a;
}
function catalogFor(dir, slug){
  const files = fs.readdirSync(dir).filter(f => [slug].concat(SKU_ALIASES[slug] || []).some(p => f === p + "-skus.json" || (f.startsWith(p + "-") && f.endsWith("-skus.json"))));
  const seen = new Set(), rows = [];
  for(const f of files.sort()) for(const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) || []){
    if(!r || !r.code || seen.has(String(r.code))) continue; seen.add(String(r.code));
    rows.push({ code: String(r.code), name: r.name || "", section: r.section || "" }); // code + name only — never prices
  }
  return { rows, files };
}

async function fetchImage(url){
  const out = { fetched_at: new Date().toISOString() };
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
  try{
    const r = await fetch(url, { method: "GET", redirect: "follow", signal: ac.signal, headers: { "user-agent": "HCPS content review (read-only)" } });
    out.http_status = r.status; out.content_type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if(!r.ok){ out.error = "HTTP " + r.status; return out; }
    const buf = Buffer.from(await r.arrayBuffer());
    if(buf.length > 15 * 1024 * 1024){ out.error = "larger than 15 MB"; return out; }
    out.bytes = buf.length; out.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const d = CR.imageSize(buf); if(d){ out.width = d.width; out.height = d.height; }
    return out;
  }catch(e){ out.error = e.name === "AbortError" ? "timeout" : String(e.message || e); return out; }
  finally{ clearTimeout(t); }
}
async function fetchAll(urls, conc){
  const res = {}, list = [...new Set(urls)]; let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, conc || 6) }, async () => { while(i < list.length){ const u = list[i++]; res[u] = await fetchImage(u); } }));
  return res;
}

function sheet(XLSX, rows, cols){ const ws = XLSX.utils.json_to_sheet(rows, { header: cols }); ws["!cols"] = cols.map(c => ({ wch: Math.min(60, Math.max(10, c.length + 2)) })); return ws; }
const short = (s, n) => { s = s == null ? "" : String(s); return s.length > (n || 32000) ? s.slice(0, n || 32000) + "…" : s; };

async function main(){
  const a = args(process.argv.slice(2));
  fs.mkdirSync(a.out, { recursive: true });
  const lines = (a.only || LINES).filter(m => fs.existsSync(path.join(a.in, m + "-content.json")));
  const results = [], allEx = [], allImg = [];
  for(const m of lines){
    const research = JSON.parse(fs.readFileSync(path.join(a.in, m + "-content.json"), "utf8"));
    const cat = catalogFor(a.in, m);
    const L = CR.reviewLine(m, research, cat.rows);
    const urls = a.fetch ? L.pages.flatMap(p => p.image_urls).filter(u => CR.checkSource(m, u).ok) : [];
    const fetched = a.fetch ? await fetchAll(urls, a.conc) : {};
    const images = CR.stageImages(L, fetched);
    L.inputs = { research_file: m + "-content.json", sku_files: cat.files, retrieved: research.retrieved || null, generated_at: new Date().toISOString(), fetched_images: a.fetch };
    fs.writeFileSync(path.join(a.out, m + "-review.json"), JSON.stringify({ line: L, images }, null, 1));
    results.push(L); allEx.push(...L.exceptions); allImg.push(...images);
    const c = L.counts; console.log(m.padEnd(22), "SKUs", c.skus, "| ready", c.ready, "| review", c.needs_review, "| held", c.held,
      "| images", c.images.total, "fetched", c.images.fetched, "primary", c.images.primary_candidates);
  }
  const summary = results.map(L => Object.assign({ manufacturer: L.manufacturer }, L.counts));
  fs.writeFileSync(path.join(a.out, "exceptions.json"), JSON.stringify(allEx, null, 1));
  fs.writeFileSync(path.join(a.out, "images.json"), JSON.stringify(allImg, null, 1));
  fs.writeFileSync(path.join(a.out, "summary.json"), JSON.stringify(summary, null, 1));
  let XLSX = null; try{ XLSX = require("xlsx"); }catch(e){ console.log("xlsx not installed — workbook skipped (JSON written)"); }
  if(XLSX){
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, summary.map(s => ({ manufacturer: s.manufacturer, skus: s.skus, ready: s.ready, needs_review: s.needs_review, held: s.held,
      held_by_reason: JSON.stringify(s.held_by_reason), review_by_reason: JSON.stringify(s.review_by_reason), images: s.images.total, images_fetched: s.images.fetched,
      primary_candidates: s.images.primary_candidates })), ["manufacturer", "skus", "ready", "needs_review", "held", "held_by_reason", "review_by_reason", "images", "images_fetched", "primary_candidates"]), "Summary");
    const skuRows = results.flatMap(L => L.skus.map(s => ({ manufacturer: s.manufacturer, sku: s.sku, hcps_name: s.hcps_name, status: CR.STATUS_LABEL[s.status], page_key: s.page_key || "",
      holds: s.reasons.filter(r => r.level === "hold").map(r => r.code).join(", "), reviews: s.reasons.filter(r => r.level === "review").map(r => r.code).join(", "), source_url: s.source_url || "", discontinued: "no (never set by review)" })));
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, skuRows, ["manufacturer", "sku", "hcps_name", "status", "page_key", "holds", "reviews", "source_url", "discontinued"]), "SKUs");
    const pageRows = results.flatMap(L => L.pages.map(p => ({ manufacturer: p.manufacturer, page_key: p.page_key, family: p.family, skus: p.skus.join(", "), status: CR.STATUS_LABEL[p.status],
      source_url: p.source.url || "", source_role: p.source.role, fetched_at: p.source.fetched_at || "not recorded", description: short(p.draft.description), features: short(p.draft.features.join(" | ")),
      specs: short(Object.entries(p.draft.specs).map(([k, v]) => k + ": " + v).join(" | ")), warranty: p.draft.warranty || "(blank — not stated verbatim)", category_suggestion: p.draft.category_suggestion || "",
      retail_model_aliases: p.retail_models.map(r => r.label + " " + r.value).join(", "), reasons: p.reasons.map(r => r.code).join(", "), primary_image: p.primary_image || "" })));
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, pageRows, ["manufacturer", "page_key", "family", "skus", "status", "source_url", "source_role", "fetched_at", "description", "features", "specs", "warranty", "category_suggestion", "retail_model_aliases", "reasons", "primary_image"]), "Pages");
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, allEx.map(e => Object.assign({}, e, { evidence: short(e.evidence) })), ["manufacturer", "sku", "page_key", "kind", "level", "evidence", "source_ref", "decision_needed", "status"]), "Exceptions");
    XLSX.utils.book_append_sheet(wb, sheet(XLSX, allImg.map(i => Object.assign({}, i, { skus: i.skus.join(", ") })), ["id", "manufacturer", "page_key", "skus", "url", "host", "source_check", "classification", "promo_reason", "fetched", "fetch_note", "fetched_at", "http_status", "content_type", "bytes", "sha256", "width", "height", "duplicate_of", "rights_status", "rights_basis", "rehost"]), "Images");
    XLSX.writeFile(wb, path.join(a.out, "content-review.xlsx"));
  }
  console.log("written to", a.out);
}
if(require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });
module.exports = { catalogFor, args };

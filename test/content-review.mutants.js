/* Mutants for the manufacturer content review (_content_review.js). A clean control run must pass first; the CONTROL
   mutant (a comment only) must survive; every other edit must make test/content-review.test.js fail.
     node test/content-review.mutants.js */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const DIR = path.join(__dirname, "..", "netlify", "functions"), FILE = "_content_review.js", TEST = path.join(__dirname, "content-review.test.js");
const M = [
  { control: true, from: "/* Image rights actually recorded", to: "/* (control) Image rights actually recorded", why: "CONTROL: a comment only" },
  { from: "  if(onHost(h, o.site)) return", to: "  if(true) return", why: "any host accepted as official" },
  { from: "const onHost = (h, list) => (list || []).some(d => h === d || h.endsWith(\".\" + d));", to: "const onHost = (h, list) => (list || []).some(d => h.indexOf(d) >= 0);", why: "look-alike hosts accepted" },
  { from: "  if(onHost(h, o.cdn)) return { ok: true, host: h, role: \"official_cdn\", assets_only: true };", to: "  if(onHost(h, o.cdn)) return { ok: true, host: h, role: \"official_cdn\" };", why: "a CDN host treated as a product page" },
  { from: "  if(FROZEN.has(String(slug).toLowerCase())) throw", to: "  if(false) throw", why: "frozen line reviewed" },
  { from: "  if(!fam.product_url){\n    pageR.push(reason(\"not_found\"", to: "  if(!fam.product_url){\n    pageR.push(reason(\"low_confidence\"", why: "a family with no page not held" },
  { from: "    const rec = { manufacturer: slug, sku: c, hcps_name: names[c] || null, page_key: null, status: \"held\"", to: "    const rec = { manufacturer: slug, sku: c, hcps_name: names[c] || null, page_key: null, status: \"needs_review\"", why: "unresearched SKU not held" },
  { from: "page_key: null, status: \"held\", reasons, source_url: null, discontinued: false };", to: "page_key: null, status: \"held\", reasons, source_url: null, discontinued: true };", why: "a missing page marks discontinued" },
  { from: "      if(notFound.has(ENRICH.codeNorm(c))) own.push(", to: "      if(false) own.push(", why: "listed not_found ignored" },
  { from: "    const targets = named.length && kind === \"capacity_conflict\" ? named : codes;", to: "    const targets = named.length ? named : codes;", why: "warranty conflict held on the named code only" },
  { from: "    const targets = named.length && kind === \"capacity_conflict\" ? named : codes;", to: "    const targets = codes;", why: "a capacity conflict naming one code holds every model" },
  { from: "      if(caps.length && catLbs.some(n => !stated.includes(n)))", to: "      if(false)", why: "catalog capacity vs manufacturer not compared" },
  { from: "      if(caps.length && catLbs.some(n => !stated.includes(n)))", to: "      if(caps.length && catLbs.some(n => !caps.includes(n)))", why: "a secondary figure (safety limit) ignored" },
  { from: "if(/[A-Z0-9-]{4,}\\s*:/.test(t)) lbsIn(t).forEach(n => out.push(n)); else { const n = lbsIn(t)[0]; if(n != null) out.push(n); } };", to: "lbsIn(t).forEach(n => out.push(n)); };", why: "one statement's two figures read as a conflict" },
  { from: "const NOT_CAP_KEY = /", to: "const NOT_CAP_KEY = /^zzz$/i, NOT_CAP_KEY_WAS = /", why: "product / net weight read as capacity" },
  { from: "    if(codes.length === 1) pageR.push(reason(\"capacity_conflict\"", to: "    if(false) pageR.push(reason(\"capacity_conflict\"", why: "two capacities on a one-SKU page not held" },
  { from: "      if(sy.length && wy.some(y => !sy.includes(y))) addSku(c, reason(\"warranty_conflict\"", to: "      if(false) addSku(c, reason(\"warranty_conflict\"", why: "catalog warranty years vs stated not compared" },
  { from: "  if(/warrant/i.test(note)) return \"warranty_conflict\";", to: "", why: "warranty conflict note classified as spec" },
  { from: "  if(/stock|sold out|availability/i.test(note) && !/capacity|warrant|\\blbs?\\b/i.test(note)) return \"possibly_not_current\";", to: "", why: "a stock note held as a spec conflict" },
  { from: "      if(PARAPHRASE.test(desc)) pageR.push(", to: "      if(false) pageR.push(", why: "paraphrased copy used as draft" },
  { from: "        if(PARAPHRASE.test(v) || PARAPHRASE.test(k)) pageR.push(", to: "        if(false) pageR.push(", why: "paraphrased warranty published" },
  { from: "        if(ASSEMBLED.test(notes)) pageR.push(", to: "        if(false) pageR.push(", why: "assembled copy not reviewed" },
  { from: "    } else if(arr(fam.features).length || Object.keys(fam.specs || {}).length) pageR.push(reason(\"no_description\"", to: "    } else if(false) pageR.push(reason(\"no_description\"", why: "missing description not reviewed" },
  { from: "const OTC = /\\bOTC\\b|", to: "const OTC = /OTC|", why: "a code containing OTC flagged as a drug" },
  { from: "  if(OTC.test(all) || codes.some(c => OTC.test(ctx.names[c] || \"\"))) pageR.push(", to: "  if(false) pageR.push(", why: "OTC drug not held" },
  { from: "  if(REG.test(all) || codes.some(c => REG.test(ctx.names[c] || \"\"))) pageR.push(", to: "  if(false) pageR.push(", why: "CBD not held" },
  { from: "  if(MED_BED_VOID.test(all)) pageR.push(", to: "  if(false) pageR.push(", why: "medical-bed warranty void not held" },
  { from: "  if(FREIGHT_CLAIM.test(all)) pageR.push(", to: "  if(false) pageR.push(", why: "freight claim in copy allowed" },
  { from: "  if(IMG_RIGHTS.test(notes) || (THIRD.test(notes) && arr(fam.image_urls).length)) pageR.push(", to: "  if(false) pageR.push(", why: "image rights not held" },
  { from: "  sold_out_on_site: [HOLD,", to: "  sold_out_on_site: [REVIEW,", why: "sold out not held" },
  { from: "  possibly_not_current: [REVIEW,", to: "  possibly_not_current: [HOLD,", why: "possibly-not-current held (treated as discontinued)" },
  { from: "      if(RETAIL_LABEL.test(norm(k))){ retail.push(", to: "      if(false){ retail.push(", why: "retail model shown as a spec" },
  { from: "        draft.description = ENRICH.neutralize(desc, o.brand);", to: "        draft.description = norm(desc);", why: "first-person copy kept" },
  { from: "    else if(conf !== \"high\") pageR.push(", to: "    else if(false) pageR.push(", why: "medium confidence called Ready" },
  { from: "  if(RX.test(all)) pageR.push(", to: "  if(false) pageR.push(", why: "Rx device not reviewed" },
  { from: "  if(CLAIM.test(text)) pageR.push(", to: "  if(false) pageR.push(", why: "guarantee claim not reviewed" },
  { from: "    if(!c.ok) pageR.push(reason(\"rejected_source_link\"", to: "    if(false) pageR.push(reason(\"rejected_source_link\"", why: "dropped non-official link not noted" },
  { from: "    if(src.role === \"parent_company\") pageR.push(", to: "    if(false) pageR.push(", why: "successor source not reviewed" },
  { from: "  const level = f.level === \"blocker\" ? HOLD :", to: "  const level = f.level === \"blocker\" ? REVIEW :", why: "importer blocker downgraded" },
  { from: "function statusOf(reasons){ return reasons.some(r => r.level === HOLD) ? \"held\"", to: "function statusOf(reasons){ return false ? \"held\"", why: "a hold not held" },
  { from: "classification: !chk.ok ? \"rejected\" : promo ? \"promo\" : \"gallery\"", to: "classification: !chk.ok ? \"rejected\" : \"gallery\"", why: "promo art may be primary" },
  { from: "classification: !chk.ok ? \"rejected\" : promo ? \"promo\"", to: "classification: false ? \"rejected\" : promo ? \"promo\"", why: "non-official image accepted" },
  { from: "  let p = \"\"; try{ p = decodeURIComponent(new URL(url).pathname.split(\"/\").pop()); }", to: "  let p = \"\"; try{ p = decodeURIComponent(new URL(url).pathname); }", why: "a promo folder name marks product photos promo" },
  { from: "    const pick = mine.find(r => r.classification === \"gallery\" && !(r.width && Math.min(r.width, r.height) < 300));", to: "    const pick = mine.find(r => r.classification === \"gallery\");", why: "a tiny photo picked as primary" },
  { from: ".sort((a, b) => (b.bytes || 0) - (a.bytes || 0) ||", to: ".sort((a, b) => (a.bytes || 0) - (b.bytes || 0) ||", why: "the smaller duplicate kept" },
  { from: "  for(const g of groups.values()) if(g.length > 1){", to: "  for(const g of groups.values()) if(false){", why: "duplicates kept" },
  { from: "      if(rec.fetched && !/^image\\//.test(rec.content_type || \"\")){", to: "      if(false){", why: "a non-image accepted as a photo" },
  { from: "rights_status: rights ? \"recorded\" : \"pending\"", to: "rights_status: \"recorded\"", why: "rights claimed without a record" },
  { from: "sha256: fr && !fr.error ? fr.sha256 || null : null", to: "sha256: fr ? fr.sha256 || \"unknown\" : \"unknown\"", why: "an unfetched hash invented" },
  { from: "    if(!pick && page.source.official) add(mine.some(r => r.classification === \"promo\") ? \"no_primary_image\" : \"no_image\");", to: "", why: "a page without a photo called Ready" },
  { from: "        if(!chk.ok){ out.http_status = r.status; out.error = \"redirected off the official hosts", to: "        if(false){ out.http_status = r.status; out.error = \"redirected off the official hosts", why: "redirect target host not checked" },
  { from: "redirect: \"manual\", signal: ac.signal", to: "redirect: \"follow\", signal: ac.signal", why: "redirects followed automatically (final host never seen)" },
  { from: "  if(!first.ok){ out.error = \"not an official host", to: "  if(false){ out.error = \"not an official host", why: "first URL host not checked" },
  { from: "        if(hop >= MAX_REDIRECTS){", to: "        if(hop >= 1e9){", why: "no redirect limit" },
  { from: "        if(!/^https:/i.test(next) && /^https:/i.test(cur)){", to: "        if(false){", why: "https downgraded to http" },
  { from: "    if(Number.isFinite(declared) && declared > max){", to: "    if(false){", why: "declared size not capped" },
  { from: "        if(total > max){ try{ await rd.cancel(); }catch(e){}", to: "        if(false){ try{ await rd.cancel(); }catch(e){}", why: "streamed size not capped (lying Content-Length)" },
  { from: "      if(fr && fr.final_url && !checkSource(line.manufacturer, fr.final_url).ok){", to: "      if(false){", why: "an off-host final URL still staged" },
  { from: "rights_note: rights ? \"rights recorded for this line\" : \"candidate only — rights pending, not licensed or approved for use\",", to: "rights_note: \"licensed\",", why: "candidates described as licensed" },
];
function run(dir){ try{ execFileSync("node", [TEST], { stdio: "pipe", env: Object.assign({}, process.env, dir ? { CAT_ROOT: dir } : {}), timeout: 120000 }); return true; }catch(e){ return false; } }
if(!run(null)){ console.log("CONTROL FAILED: the suite does not pass on the clean tree"); process.exit(1); }
console.log("control: clean");
const src = fs.readFileSync(path.join(DIR, FILE), "utf8");
let killed = 0, survived = [], total = 0;
for(const m of M){
  if(src.split(m.from).length - 1 !== 1){ console.log("BAD ANCHOR", m.why); survived.push(m.why); continue; }
  const from = m.from, to = m.to;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "crm-"));
  for(const f of fs.readdirSync(DIR)) if(/\.js$/.test(f)) fs.copyFileSync(path.join(DIR, f), path.join(d, f));
  fs.writeFileSync(path.join(d, FILE), src.replace(from, to));
  const dead = !run(d); fs.rmSync(d, { recursive: true, force: true });
  if(m.control){ console.log(dead ? "  CONTROL KILLED (bad)" : "  control survived"); if(dead) survived.push("CONTROL"); continue; }
  total++; if(dead){ killed++; } else { survived.push(m.why); console.log("SURVIVED", m.why); }
}
console.log(`content-review mutants: ${killed}/${total} killed`);
process.exit(survived.length ? 1 : 0);

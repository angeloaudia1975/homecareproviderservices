/* CATALOG COMPLETION — MANUFACTURER CONTENT REVIEW (PURE: no I/O, no writes).
   Turns researched manufacturer content (scratch research files, NOT verified for publication) into review records a person
   works through BEFORE anything reaches Product Enrichment. It never writes product_content, product_content_sources,
   mfr_decisions or storage; it never publishes, rehosts or marks anything discontinued. It reuses Release B's helpers
   (_enrich.js: neutralize, isPromoUrl, photoStem, codeNorm, slug) so the review applies the same rules as Auto-Enrich:
     · manufacturer-official sources only — a source on any other host is REJECTED and none of its words are used;
     · the source's own words — paraphrased / summarised / assembled copy is never draft copy (needs re-copy);
     · neutral language (first-person promotion removed by _enrich.neutralize);
     · warranty and specs only as the source states them — a paraphrased warranty stays blank;
     · retail model / item / SKU / UPC rows are aliases in provenance, never dealer specs;
     · banner / promo / hero art is never the primary photo; photos are candidates only (rights pending, not rehosted);
     · a missing / sold-out page never marks a SKU discontinued (discontinued is always false here).
   The four FROZEN lines (Climbing Steps, Strongback, Ovation, Bemis) are refused outright.

   OUTPUTS
     page record  { manufacturer, page_key, family, skus[], status, reasons[], source, sources[], draft, provenance,
                    retail_models[], confidence, image_ids[] }
     sku record   { manufacturer, sku, hcps_name, page_key, status, reasons[], source_url, discontinued:false }
     image record { id, manufacturer, page_key, skus[], url, host, source_check, classification, promo_reason, fetched,
                    fetch_note, fetched_at, http_status, content_type, bytes, sha256, width, height, duplicate_of,
                    rights_status, rights_basis, rehost }
     status = "ready" | "needs_review" | "held"  (labels: Ready / Needs review / Held)

   COMMON EXCEPTION SCHEMA (shared with the catalog importer's review report — see fromImporterFlag):
     { manufacturer, sku, page_key, kind, level, evidence, source_ref, decision_needed, status }
       kind            reason code (e.g. capacity_conflict, warranty_conflict, no_dealer_price)
       level           "hold" (blocks — importer "blocker") | "review" (importer "warn") | "info"
       evidence        what was found, in plain words
       source_ref      URL / file locator the evidence comes from (null when none)
       decision_needed what a person has to decide (null for info)
       status          "open" until a recorded decision closes it (this module only ever emits "open")
*/
"use strict";
const path = require("path");
const ENRICH = require(path.join(process.env.CAT_ROOT || __dirname, "_enrich.js"));

const FROZEN = new Set(["climbing-steps", "strongback", "strongback-mobility", "ovation", "ovation-medical", "bemis"]);

/* Manufacturer-official hosts. site = the manufacturer's own site; cdn = the asset host its own pages serve from (images
   only, never copy); parent = parent / successor company (usable, always reviewed). Matched as host or sub-domain. */
const OFFICIAL = {
  "dalton": { brand: "Dalton", site: ["daltonmedical.com"], cdn: [], parent: [] },
  "pedifix": { brand: "PediFix", site: ["pedifix.com"], cdn: [], parent: [] },
  "access4u": { brand: "Access4U", site: ["rampsaccess4u.com", "access4uinc.com"], cdn: ["static.wixstatic.com"], parent: [] },
  "corsicana": { brand: "South Bay International", site: ["corsicanamattress.com"], cdn: [], parent: ["southbayinternational.com"],
    parent_note: "South Bay International acquired the Corsicana assets; no CorsicanaCare-branded source exists — successor-company content" },
  "ohio-medical": { brand: "GCE", site: ["ohiomedical.com", "gcegroup.com"], cdn: [], parent: ["esab.com"],
    parent_note: "GCE's parent company ESAB hosts some GCE documents" },
  "airavant-bongorx": { brand: "AirAvant Medical", site: ["bongorx.com", "airavantmedical.com"], cdn: ["cdn-brx2.b-cdn.net"], parent: [] },
  "abm-respiratory-care": { brand: "ABM Respiratory Care", site: ["abmrc.com"], cdn: [], parent: [] },
};
/* Image rights actually recorded for a line (none yet for these lines — every candidate stays "pending"). */
const RIGHTS = {};
/* Line-level exceptions that are not about one SKU's copy (recorded so the queue carries them; they do not block a page). */
const LINE_EXCEPTIONS = {
  "corsicana": [{ kind: "unsupported_claim", level: "hold", evidence: "Corsicana freight terms are TBD — no freight wording may appear in product content",
    decision_needed: "Freight terms are set in Manufacturer Center (freight terms), not in product copy" }],
};

const STATUS_LABEL = { ready: "Ready", needs_review: "Needs review", held: "Held" };
const HOLD = "hold", REVIEW = "review";
/* Every reason code this module emits, with its level and the decision it asks for. */
const REASONS = {
  non_official_source: [HOLD, "Use a manufacturer-official page (the researched page is not on the manufacturer's site)"],
  not_found: [HOLD, "Find the manufacturer's official page or keep the current catalog card — never mark discontinued from a missing page"],
  capacity_conflict: [HOLD, "Confirm the weight capacity with the manufacturer; no capacity is published until it is confirmed"],
  spec_conflict: [HOLD, "Confirm the conflicting specification with the manufacturer"],
  warranty_conflict: [HOLD, "Confirm the warranty with the manufacturer before any warranty is published"],
  unsupported_claim: [HOLD, "Decide whether the claim can appear at all; content may not state it unless the manufacturer does"],
  otc_drug_facts: [HOLD, "Copy the Drug Facts panel verbatim from the manufacturer's label/page before publishing"],
  regulatory_check: [HOLD, "Check state / marketplace rules for this ingredient before listing"],
  image_rights: [HOLD, "Confirm who owns the photos (third-party brand / other maker's files) before any photo is used"],
  sold_out_on_site: [HOLD, "Availability is a business decision — the manufacturer page shows it sold out; do NOT mark discontinued"],
  discontinued_on_site: [HOLD, "The manufacturer page says discontinued — confirm with the manufacturer before any status change"],
  successor_source: [REVIEW, "Confirm the successor company's page describes this exact product"],
  parent_source: [REVIEW, "Confirm the parent-company document applies to this product"],
  low_confidence: [REVIEW, "Confirm the match between our SKU and the manufacturer page"],
  medium_confidence: [REVIEW, "Confirm the match between our SKU and the manufacturer page"],
  paraphrased_copy: [REVIEW, "Re-copy the description verbatim from the manufacturer page (paraphrase is never draft copy)"],
  assembled_copy: [REVIEW, "Confirm the description is the manufacturer's own wording for this product"],
  paraphrased_warranty: [REVIEW, "Copy the warranty terms verbatim from the manufacturer, or leave the warranty blank"],
  no_description: [REVIEW, "Add the manufacturer's own description (none was captured)"],
  content_not_captured: [REVIEW, "The page exists on the manufacturer site; capture its content"],
  catalog_fact_unconfirmed: [REVIEW, "Our catalog name states a figure the manufacturer page does not — keep it out of the copy or confirm it"],
  capacity_by_model: [REVIEW, "The page states more than one capacity; confirm which applies to each model"],
  code_unconfirmed: [REVIEW, "Confirm our part number against the manufacturer's (the page does not show it)"],
  source_note: [REVIEW, "Research left a note to confirm before publishing"],
  rx_device: [REVIEW, "Prescription device: the Rx statement must be the manufacturer's own words"],
  claim_attribution: [REVIEW, "Manufacturer claim (guarantee / clinical / FDA wording) — keep only as the manufacturer's attributed words"],
  third_party_brand: [REVIEW, "The line resells another maker's product — that maker's page is the stronger source"],
  image_not_product_specific: [REVIEW, "The photo may show another product / a generic view — pick a product-specific photo"],
  no_image: [REVIEW, "No official product photo was found — ask for one or keep the current catalog photo"],
  no_primary_image: [REVIEW, "Only promo / banner art was found — it is never the main photo"],
  possibly_not_current: [REVIEW, "The manufacturer site may no longer list this — confirm; do NOT mark discontinued"],
  reseller_lead: [REVIEW, "Only a reseller says this — a reseller is never evidence"],
  rejected_source_link: [REVIEW, "A non-official link was dropped from the sources"],
};

const norm = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const hostOf = u => { try{ return new URL(String(u)).host.toLowerCase().replace(/^www\./, ""); }catch(e){ return ""; } };
const onHost = (h, list) => (list || []).some(d => h === d || h.endsWith("." + d));
const arr = v => Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
const isText = v => typeof v === "string" && norm(v) !== "";

function checkSource(slug, url){
  const o = OFFICIAL[slug], h = hostOf(url);
  if(!o) return { ok: false, host: h, role: "unknown_line", reason: "no official-source registry for this manufacturer" };
  if(!/^https?:\/\//i.test(String(url || "")) || !h) return { ok: false, host: h, role: "invalid", reason: "not a web address" };
  if(onHost(h, o.site)) return { ok: true, host: h, role: "official_site" };
  if(onHost(h, o.cdn)) return { ok: true, host: h, role: "official_cdn", assets_only: true };
  if(onHost(h, o.parent)) return { ok: true, host: h, role: "parent_company", note: o.parent_note || "" };
  return { ok: false, host: h, role: "rejected", reason: "not a manufacturer-official host" };
}

/* ── detectors ── */
const LB = /(\d{1,2},\d{3}|\d{2,4}(?:\.\d+)?)\s*-?\s*(?:lbs?\b\.?|pounds?\b|#(?=\s|$|,))/gi;
const lbsIn = s => { const out = []; let m; const re = new RegExp(LB.source, "gi"); while((m = re.exec(String(s || "")))) out.push(Number(m[1].replace(/,/g, ""))); return out; };
const CAP_KEY = /capacity|weight limit|safe working load|\bswl\b|max(imum)?\.?\s*(user\s*)?(weight|load)|user weight|weight rating|load rating|live load/i;
const NOT_CAP_KEY = /product weight|unit weight|item weight|shipping|weight \(by model\)|net weight|gross weight|^weight$/i;
function sourceCapacities(fam){
  const out = [];
  // one figure per statement — the first it states ("1100 lbs (1000 lb safety load limit)" is ONE statement, not two);
  // a statement listing values by model ("K2DK16F: 250 lb; …") contributes each model's figure
  const take = v => { const t = String(v || ""); if(/[A-Z0-9-]{4,}\s*:/.test(t)) lbsIn(t).forEach(n => out.push(n)); else { const n = lbsIn(t)[0]; if(n != null) out.push(n); } };
  for(const [k, v] of Object.entries(fam.specs || {})) if(CAP_KEY.test(k) && !NOT_CAP_KEY.test(k)) take(v);
  for(const f of arr(fam.features)) if(/capacity|weight limit|safe working load|supports up to|holds up to/i.test(f)) take(f);
  return [...new Set(out)];
}
/* Every lb figure any capacity statement mentions — used only to ask "does the manufacturer state our figure at all?" */
function statedCapacityLbs(fam){
  const out = [];
  for(const [k, v] of Object.entries(fam.specs || {})) if(CAP_KEY.test(k) && !NOT_CAP_KEY.test(k)) lbsIn(v).forEach(n => out.push(n));
  for(const f of arr(fam.features)) if(/capacity|weight limit|safe working load|supports up to|holds up to/i.test(f)) lbsIn(f).forEach(n => out.push(n));
  return [...new Set(out)];
}
const yearsNear = s => { const out = []; let m; const re = /(\d{1,2})\s*-?\s*(?:years?|yrs?)\b/gi; while((m = re.exec(String(s || "")))) out.push(Number(m[1])); return out; };
function catalogWarrantyYears(name){ return /warrant/i.test(name || "") ? [...new Set(yearsNear(name))] : []; }
const PARAPHRASE = /paraphras|summari[sz]ed|\(summary\)/i;
const ASSEMBLED = /assembled from|compiled from|combined from/i;
const OTC = /\bOTC\b|drug facts|active ingredients?|clotrimazole|tolnaftate|salicylic acid|undecylenic|miconazole|terbinafine|lidocaine|pramoxine|hydrocortisone|benzocaine/i;
const REG = /\bCBD\b|cannabidiol|\bhemp\b/i;
const MED_BED_VOID = /(medical|hospital)[^.]{0,40}bed[^.]{0,60}void|void[^.]{0,60}(medical|hospital)[^.]{0,20}bed/i;
const FREIGHT_CLAIM = /free (shipping|freight)|ships free|freight (tbd|to be determined)/i;
const RX = /\bRx\b|prescription|federal law restricts/i;
const CLAIM = /guarantee|doctor[- ]recommended|clinically (proven|tested)|\bcures?\b|FDA[- ](approved|cleared)/i;
const THIRD = /original manufacturer|is a reseller|resells|another brand|private-label|trademarks? of another|true manufacturer/i;
const IMG_RIGHTS = /confirm image rights|costcare|other maker'?s|another brand'?s (photo|image)|image rights/i;
const IMG_GENERIC = /generic|rather than the|not the accessory|image shows the .* (base|cart)|shows the [a-z]+ base with|may be generic|do not reuse/i;
const CONFIRM_NOTE = /confirm|verify|not (seen|mentioned|stated|listed|confirmed)|not on (the )?official|unconfirmed|could not be (read|fetched)|stated two ways|inconsistent|copy error/i;
const RETAIL_LABEL = /^(model(\s*(no\.?|number|#))?|item\s*(no\.?|number|#)|sku|upc|part\s*(no\.?|number|#))$/i;

function codesNamedIn(text, codes){ const t = String(text || "").toUpperCase(); return codes.filter(c => t.indexOf(String(c).toUpperCase()) >= 0); }
function conflictKind(note){
  if(/stock|sold out|availability/i.test(note) && !/capacity|warrant|\blbs?\b/i.test(note)) return "possibly_not_current";
  if(/warrant/i.test(note)) return "warranty_conflict";
  if(/capacity|\blbs?\b|weight cap|wt\.? cap|\bswl\b|safe working load/i.test(note)) return "capacity_conflict";
  return "spec_conflict";
}

function reason(code, evidence, sourceRef, extra){ const [level, decision] = REASONS[code]; return Object.assign({ code, level, evidence: norm(evidence), source_ref: sourceRef || null, decision_needed: decision }, extra || {}); }
function statusOf(reasons){ return reasons.some(r => r.level === HOLD) ? "held" : reasons.length ? "needs_review" : "ready"; }
function dedupe(reasons){ const seen = new Set(); return reasons.filter(r => { const k = r.code + "|" + (r.sku || ""); if(seen.has(k)) return false; seen.add(k); return true; }); }

/* ── one family (manufacturer page) → page record + its SKU-specific reasons ── */
function reviewFamily(slug, fam, ctx){
  const o = OFFICIAL[slug], codes = arr(fam.codes).map(String);
  const notes = norm(fam.notes), pageKey = slug + "-" + ENRICH.slug(fam.family || codes[0] || "page", 60);
  const pageR = [], skuR = {}; codes.forEach(c => { skuR[c] = []; });
  const addSku = (c, r) => { (skuR[c] = skuR[c] || []).push(r); };
  const src = checkSource(slug, fam.product_url);
  const fetchedAt = ctx.retrieved || null;
  const sources = [];
  for(const u of [...new Set([fam.product_url, ...arr(fam.source_urls), ...arr(fam.documents)].filter(Boolean))]){
    const c = checkSource(slug, u); sources.push({ url: u, host: c.host, role: c.role, ok: c.ok && !c.assets_only, kind: arr(fam.documents).includes(u) ? "document" : "page", fetched_at: fetchedAt });
    if(!c.ok) pageR.push(reason("rejected_source_link", "Dropped " + c.host + " (" + c.reason + ")", u));
  }
  const draft = { description: null, features: [], specs: {}, warranty: null, category_suggestion: null, documents: [] };
  const prov = {}, retail = [];
  const p = (field, extra) => Object.assign({ source_url: fam.product_url || null, source_host: src.host, fetched_at: fetchedAt,
    fetched_at_basis: fetchedAt ? "research capture date" : "not recorded in the research file", method: "research capture (not re-fetched)" }, extra || {});

  if(!fam.product_url){
    pageR.push(reason("not_found", "No official manufacturer page was found for this family", null));
  } else if(!src.ok || src.assets_only){
    pageR.push(reason("non_official_source", "Researched page " + (fam.product_url || "(none)") + " is " + (src.reason || "an asset host, not a product page"), fam.product_url));
  } else {
    if(src.role === "parent_company") pageR.push(reason(slug === "corsicana" ? "successor_source" : "parent_source", src.note || "Parent-company source", fam.product_url));
    if(slug === "corsicana" && src.role === "parent_company") { /* successor note already recorded */ }
    const desc = fam.description;
    if(isText(desc)){
      if(PARAPHRASE.test(desc)) pageR.push(reason("paraphrased_copy", "Captured description is marked as a paraphrase / summary", fam.product_url));
      else {
        draft.description = ENRICH.neutralize(desc, o.brand);
        prov.description = p({ verbatim: !ASSEMBLED.test(notes), editorial: draft.description !== norm(desc) ? "neutral-language cleanup" : null });
        if(ASSEMBLED.test(notes)) pageR.push(reason("assembled_copy", notes, fam.product_url));
      }
    } else if(arr(fam.features).length || Object.keys(fam.specs || {}).length) pageR.push(reason("no_description", "No description captured from " + src.host, fam.product_url));
    draft.features = arr(fam.features).map(f => ENRICH.neutralize(f, o.brand)).filter(Boolean);
    if(draft.features.length) prov.features = p({ verbatim: "manufacturer bullets as captured" });
    for(const [k, v] of Object.entries(fam.specs && typeof fam.specs === "object" && !Array.isArray(fam.specs) ? fam.specs : {})){
      if(RETAIL_LABEL.test(norm(k))){ retail.push({ label: norm(k), value: norm(v), source_url: fam.product_url }); continue; }
      if(/warrant/i.test(k)){
        if(PARAPHRASE.test(v) || PARAPHRASE.test(k)) pageR.push(reason("paraphrased_warranty", k + ": " + v, fam.product_url));
        else { draft.warranty = norm(v); prov.warranty = p({ verbatim: true, label: norm(k) }); }
        continue;
      }
      draft.specs[norm(k)] = norm(v);
    }
    if(Object.keys(draft.specs).length) prov.specs = p({ verbatim: "label: value as captured" });
    if(/warrant/i.test(notes) && PARAPHRASE.test(notes) && !draft.warranty) pageR.push(reason("paraphrased_warranty", "Warranty only known from a paraphrase in research notes — stays blank", fam.product_url));
    if(fam.category_suggestion){ draft.category_suggestion = norm(fam.category_suggestion); prov.category_suggestion = { basis: "research suggestion — the category comes from the line's own taxonomy on approval" }; }
    draft.documents = sources.filter(s => s.kind === "document" && s.ok).map(s => s.url);
    if(!draft.description && !draft.features.length && !Object.keys(draft.specs).length && !pageR.some(r => r.code === "paraphrased_copy"))
      pageR.push(reason("content_not_captured", "The page is on the manufacturer site but no content was captured", fam.product_url));
    const conf = String(fam.confidence || "").toLowerCase();
    if(conf === "low") pageR.push(reason("low_confidence", notes || "Research confidence low", fam.product_url));
    else if(conf !== "high") pageR.push(reason("medium_confidence", notes || "Research confidence " + (conf || "not stated"), fam.product_url));
  }
  // retail model aliases: manufacturer site SKUs that differ from ours
  for(const s of arr(fam.dalton_site_skus || fam.site_skus)) if(!codes.some(c => ENRICH.codeNorm(c) === ENRICH.codeNorm(s))) retail.push({ label: o.brand + " Retail Model", value: String(s), source_url: fam.product_url });
  if(Array.isArray(fam.codes_with_own_page)) codes.filter(c => !fam.codes_with_own_page.includes(c)).forEach(c => addSku(c, reason("code_unconfirmed", c + " has no page of its own on " + src.host, fam.product_url)));

  // ── holds and reviews from the evidence ──
  const text = [fam.description, ...arr(fam.features), ...Object.entries(fam.specs || {}).map(([k, v]) => k + ": " + v)].map(norm).join(" \n ");
  const all = text + " \n " + notes;
  const hasConflictNote = /conflict/i.test(notes);
  if(hasConflictNote){
    const kind = conflictKind(notes), named = codesNamedIn(notes, codes);
    const targets = named.length && kind === "capacity_conflict" ? named : codes;
    targets.forEach(c => addSku(c, reason(kind, notes, fam.product_url)));
    if(named.length && kind === "capacity_conflict") codes.filter(c => !named.includes(c)).forEach(c => addSku(c, reason("capacity_by_model", "Capacity on the page comes from " + named.join(", ") + "; confirm for " + c, fam.product_url)));
  }
  const caps = sourceCapacities(fam), stated = statedCapacityLbs(fam);
  for(const c of codes){
    const name = (ctx.names[c] || ""), catLbs = [...new Set(lbsIn(name))];
    if(catLbs.length && /cap|capacity|weight|wt\.?|load|bariatric/i.test(name)){
      if(caps.length && catLbs.some(n => !stated.includes(n))) addSku(c, reason("capacity_conflict", "Catalog name says " + catLbs.join("/") + " lb; manufacturer states " + caps.join("/") + " lb", fam.product_url));
      else if(!caps.length && !hasConflictNote) addSku(c, reason("catalog_fact_unconfirmed", "Catalog name says " + catLbs.join("/") + " lb; the manufacturer page states no capacity", fam.product_url));
    }
    const wy = catalogWarrantyYears(name);
    if(wy.length && !hasConflictNote){
      const sy = draft.warranty ? yearsNear(draft.warranty) : [];
      if(sy.length && wy.some(y => !sy.includes(y))) addSku(c, reason("warranty_conflict", "Catalog name says " + wy.join("/") + " yr; manufacturer warranty: " + draft.warranty, fam.product_url));
      else if(!sy.length) addSku(c, reason("catalog_fact_unconfirmed", "Catalog name states a " + wy.join("/") + "-year warranty; no manufacturer warranty captured", fam.product_url));
    }
  }
  if(caps.length > 1 && !hasConflictNote){
    if(codes.length === 1) pageR.push(reason("capacity_conflict", "The manufacturer page states " + caps.join(" and ") + " lb", fam.product_url));
    else pageR.push(reason("capacity_by_model", "The manufacturer page states " + caps.join(" / ") + " lb across models", fam.product_url));
  }
  if(OTC.test(all) || codes.some(c => OTC.test(ctx.names[c] || ""))) pageR.push(reason("otc_drug_facts", (all.match(OTC) || [""])[0] + " — OTC drug: Drug Facts must be verbatim", fam.product_url));
  if(REG.test(all) || codes.some(c => REG.test(ctx.names[c] || ""))) pageR.push(reason("regulatory_check", (all.match(REG) || ["CBD"])[0] + " ingredient", fam.product_url));
  if(MED_BED_VOID.test(all)) pageR.push(reason("unsupported_claim", "Manufacturer warranty is void when used as a medical / hospital bed — no medical-bed suitability claim may be made", fam.product_url));
  if(FREIGHT_CLAIM.test(all)) pageR.push(reason("unsupported_claim", "Freight wording in content: " + all.match(FREIGHT_CLAIM)[0], fam.product_url));
  if(RX.test(all)) pageR.push(reason("rx_device", (all.match(RX) || [""])[0], fam.product_url));
  if(CLAIM.test(text)) pageR.push(reason("claim_attribution", (text.match(CLAIM) || [""])[0], fam.product_url));
  if(THIRD.test(notes)) pageR.push(reason("third_party_brand", notes, fam.product_url));
  if(IMG_RIGHTS.test(notes) || (THIRD.test(notes) && arr(fam.image_urls).length)) pageR.push(reason("image_rights", notes, fam.product_url));
  if(IMG_GENERIC.test(notes)) pageR.push(reason("image_not_product_specific", notes, fam.product_url));
  if(notes && CONFIRM_NOTE.test(notes) && !hasConflictNote && !pageR.some(r => ["low_confidence", "medium_confidence", "assembled_copy", "third_party_brand"].includes(r.code)))
    pageR.push(reason("source_note", notes, fam.product_url));
  // site status (never discontinued from a missing page)
  for(const c of codes){
    const st = ctx.siteStatus[ENRICH.codeNorm(c)];
    if(st) addSku(c, reason(st.code, st.evidence, fam.product_url));
  }
  return { page_key: pageKey, family: fam.family, skus: codes, source: { url: fam.product_url || null, host: src.host, role: src.role, official: !!(src.ok && !src.assets_only), fetched_at: fetchedAt },
    sources, draft, // only filled from an official product page (the branch above); otherwise it stays empty
    provenance: Object.assign(prov, retail.length ? { retail_model: retail } : {}), retail_models: retail, confidence: fam.confidence || null,
    pageReasons: dedupe(pageR), skuReasons: skuR, image_urls: arr(fam.image_urls), notes };
}

/* Site-status flags (PediFix shape): code → reason. Keys or arrays name codes; nothing becomes "discontinued". */
function siteStatusMap(research, knownCodes){
  const out = {}, flags = research.site_status_flags || {}, known = new Map(knownCodes.map(c => [ENRICH.codeNorm(c), c]));
  const put = (code, why, evidence) => { const k = ENRICH.codeNorm(code); if(known.has(k) && !out[k]) out[k] = { code: why, evidence }; };
  const codesFromKey = key => String(key).split(/[\s\/,]+/).filter(t => known.has(ENRICH.codeNorm(t)));
  for(const [k, v] of Object.entries(flags.sold_out_on_site || {})) (Array.isArray(v) && v.length ? v : codesFromKey(k)).forEach(c => put(c, "sold_out_on_site", "Shown sold out on the manufacturer site: " + k));
  for(const v of arr(flags.explicitly_discontinued_on_site)) (typeof v === "string" ? codesFromKey(v) : arr(v && v.codes)).forEach(c => put(c, "discontinued_on_site", "Marked discontinued on the manufacturer site"));
  for(const [k, v] of Object.entries(flags.possibly_not_current_on_site || {})) codesFromKey(k).forEach(c => put(c, "possibly_not_current", k + ": " + v));
  for(const [k, v] of Object.entries(flags.reseller_lead_only || {})) codesFromKey(k).forEach(c => put(c, "reseller_lead", k + ": " + v));
  return out;
}

/* Researched line → { pages, skus, exceptions, counts }. research = <mfr>-content.json; catalog = <mfr>-skus.json rows
   ({code, name, ...} — any price fields are ignored and never copied). */
function reviewLine(slug, research, catalog){
  if(FROZEN.has(String(slug).toLowerCase())) throw new Error("frozen line refused: " + slug);
  if(!OFFICIAL[slug]) throw new Error("no official-source registry for " + slug);
  const fams = arr(research && research.families);
  const cat = arr(catalog).filter(r => r && r.code);
  const names = {}; cat.forEach(r => { names[String(r.code)] = norm(r.name); });
  const allCodes = [...new Set(cat.map(r => String(r.code)).concat(...fams.map(f => arr(f.codes).map(String))))];
  const ctx = { retrieved: research && research.retrieved || null, names, siteStatus: siteStatusMap(research || {}, allCodes) };
  const notFound = new Set(arr(research && research.not_found).flatMap(x => String(x).split(/\s*\/\s*/)).map(ENRICH.codeNorm));
  const nfNotes = (research && research.not_found_notes) || {};
  const pages = [], skus = [], bySku = new Map();
  for(const fam of fams){
    const r = reviewFamily(slug, fam, ctx);
    const page = { manufacturer: slug, page_key: r.page_key, family: r.family, skus: r.skus, source: r.source, sources: r.sources, draft: r.draft,
      provenance: r.provenance, retail_models: r.retail_models, confidence: r.confidence, notes: r.notes, image_urls: r.image_urls, image_ids: [] };
    for(const c of r.skus){
      const own = (r.skuReasons[c] || []).map(x => Object.assign({ sku: c }, x));
      if(notFound.has(ENRICH.codeNorm(c))) own.push(Object.assign({ sku: c }, reason("not_found", nfNoteFor(c, nfNotes) || "No official page for " + c + " in the research", r.source.url)));
      const reasons = dedupe(r.pageReasons.map(x => Object.assign({ sku: c }, x)).concat(own));
      const rec = { manufacturer: slug, sku: c, hcps_name: names[c] || null, page_key: r.page_key, status: statusOf(reasons), reasons, source_url: r.source.url, discontinued: false };
      if(bySku.has(c)){ const prev = bySku.get(c); prev.also_on = (prev.also_on || []).concat(r.page_key); continue; }
      bySku.set(c, rec); skus.push(rec);
    }
    page.reasons = dedupe(r.pageReasons.concat(...r.skus.map(c => (bySku.get(c) && bySku.get(c).page_key === r.page_key ? bySku.get(c).reasons : []).filter(x => !r.pageReasons.some(p => p.code === x.code)))));
    page.status = r.skus.length ? worst(r.skus.map(c => bySku.get(c)).filter(x => x && x.page_key === r.page_key).map(x => x.status).concat(statusOf(r.pageReasons))) : statusOf(r.pageReasons);
    pages.push(page);
  }
  for(const row of cat){
    const c = String(row.code); if(bySku.has(c)) continue;
    const reasons = [Object.assign({ sku: c }, reason("not_found", nfNoteFor(c, nfNotes) || "No manufacturer page matched " + c + " in the research", null))];
    const rec = { manufacturer: slug, sku: c, hcps_name: names[c] || null, page_key: null, status: "held", reasons, source_url: null, discontinued: false };
    bySku.set(c, rec); skus.push(rec);
  }
  const exceptions = [];
  for(const s of skus) for(const r of s.reasons) exceptions.push(exceptionOf(slug, s.sku, s.page_key, r));
  for(const e of LINE_EXCEPTIONS[slug] || []) exceptions.push({ manufacturer: slug, sku: null, page_key: null, kind: e.kind, level: e.level, evidence: e.evidence, source_ref: null, decision_needed: e.decision_needed, status: "open" });
  return { manufacturer: slug, pages, skus, exceptions, counts: counts(skus, pages) };
}
function nfNoteFor(code, notes){ for(const [k, v] of Object.entries(notes)) if(k.split(/[\s\/,]+/).some(t => ENRICH.codeNorm(t) === ENRICH.codeNorm(code)) || (k === "general" && new RegExp("(^|[^A-Z0-9-])" + code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^A-Z0-9-]|$)", "i").test(v))) return k === "general" ? "No page among the manufacturer's published products" : v; return null; }
const RANK = { ready: 0, needs_review: 1, held: 2 };
const worst = list => list.reduce((a, b) => RANK[b] > RANK[a] ? b : a, "ready");
function exceptionOf(manufacturer, sku, pageKey, r){
  return { manufacturer, sku, page_key: pageKey, kind: r.code, level: r.level, evidence: r.evidence, source_ref: r.source_ref, decision_needed: r.decision_needed, status: "open" };
}
/* The catalog importer's flag ({level: blocker|warn|info, code, detail, code_ref, locator}) in the common schema. */
function fromImporterFlag(manufacturer, f, sourceRef){
  const level = f.level === "blocker" ? HOLD : f.level === "warn" ? REVIEW : "info";
  return { manufacturer, sku: f.code_ref || null, page_key: null, kind: f.code, level, evidence: f.detail || "", source_ref: f.locator || sourceRef || null,
    decision_needed: level === "info" ? null : (f.detail || f.code), status: "open" };
}
function counts(skus, pages){
  const c = { skus: skus.length, ready: 0, needs_review: 0, held: 0, pages: pages.length, held_by_reason: {}, review_by_reason: {} };
  for(const s of skus){ c[s.status]++; const bucket = s.status === "held" ? c.held_by_reason : s.status === "needs_review" ? c.review_by_reason : null;
    if(bucket) for(const k of new Set(s.reasons.filter(r => s.status === "held" ? r.level === HOLD : true).map(r => r.code))) bucket[k] = (bucket[k] || 0) + 1; }
  return c;
}

/* ── images ── */
const PROMO_PATH = /(untitled-design|campaign|banner|promo|hero|lifestyle|infographic|badge|logo|icon)/i;
function promoReason(url){
  if(ENRICH.isPromoUrl(url)) return "file name marks promo / banner art";
  let p = ""; try{ p = decodeURIComponent(new URL(url).pathname.split("/").pop()); }catch(e){ p = String(url); }
  const m = p.match(PROMO_PATH); return m ? "path names promo art (" + m[1] + ")" : null;
}
/* fetched: optional map url → { http_status, content_type, bytes, sha256, width, height, fetched_at, error }. */
function stageImages(line, fetched){
  const out = [], f = fetched || {}, rights = RIGHTS[line.manufacturer] || null;
  for(const page of line.pages){
    let n = 0;
    for(const url of page.image_urls || []){
      const chk = checkSource(line.manufacturer, url), id = page.page_key + "#" + (++n);
      const fr = f[url] || null, promo = promoReason(url);
      const rec = { id, manufacturer: line.manufacturer, page_key: page.page_key, skus: page.skus, url, host: chk.host, source_check: chk.ok ? chk.role : "rejected",
        classification: !chk.ok ? "rejected" : promo ? "promo" : "gallery", promo_reason: promo, fetched: !!(fr && !fr.error && fr.sha256),
        fetch_note: !fr ? "not fetched" : fr.error ? "fetch failed: " + fr.error : "fetched (read-only, in memory)", fetched_at: fr && fr.fetched_at || null,
        http_status: fr ? fr.http_status || null : null, content_type: fr ? fr.content_type || null : null, bytes: fr ? fr.bytes || null : null,
        sha256: fr && !fr.error ? fr.sha256 || null : null, width: fr ? fr.width || null : null, height: fr ? fr.height || null : null, duplicate_of: null,
        rights_status: rights ? "recorded" : "pending", rights_basis: rights, rehost: "not rehosted — needs approval" };
      if(rec.fetched && !/^image\//.test(rec.content_type || "")){ rec.classification = "rejected"; rec.fetch_note = "not an image (" + (rec.content_type || "no type") + ")"; }
      out.push(rec); page.image_ids.push(id);
    }
  }
  // exact duplicates (same bytes) or the same photo at another size collapse onto the largest copy
  const groups = new Map();
  for(const r of out.filter(x => x.classification !== "rejected")){
    const k = r.manufacturer + "|" + (r.sha256 || "stem:" + ENRICH.photoStem(r.url).replace(/-(scaled|\d+x\d+)$/i, "").toLowerCase());
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  for(const g of groups.values()) if(g.length > 1){
    const keep = g.slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0) || ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
    g.filter(x => x !== keep && x.page_key === keep.page_key).forEach(x => { x.duplicate_of = keep.id; x.classification = "duplicate"; });
  }
  // primary: the first official, non-promo, non-duplicate photo of each page (large enough when its size is known)
  for(const page of line.pages){
    const mine = out.filter(r => r.page_key === page.page_key);
    const pick = mine.find(r => r.classification === "gallery" && !(r.width && Math.min(r.width, r.height) < 300));
    if(pick) pick.classification = "primary_candidate";
    page.primary_image = pick ? pick.id : null;
    const skuList = line.skus.filter(s => s.page_key === page.page_key);
    const add = code => { for(const s of skuList){ if(!s.reasons.some(r => r.code === code)){ const r = Object.assign({ sku: s.sku }, reason(code, code === "no_image" ? "No official product photo captured" : "Only promo / banner art captured", page.source.url));
      s.reasons.push(r); line.exceptions.push(exceptionOf(line.manufacturer, s.sku, s.page_key, r)); s.status = statusOf(s.reasons); } } };
    if(!pick && page.source.official) add(mine.some(r => r.classification === "promo") ? "no_primary_image" : "no_image");
    page.status = worst(skuList.map(s => s.status).concat(page.status));
  }
  line.counts = counts(line.skus, line.pages);
  line.counts.images = { total: out.length, fetched: out.filter(r => r.fetched).length, not_fetched: out.filter(r => !r.fetched).length,
    primary_candidates: out.filter(r => r.classification === "primary_candidate").length, promo: out.filter(r => r.classification === "promo").length,
    duplicates: out.filter(r => r.classification === "duplicate").length, rejected: out.filter(r => r.classification === "rejected").length,
    rights_pending: out.filter(r => r.rights_status === "pending").length };
  return out;
}

/* Image dimensions from the first bytes (JPEG / PNG / GIF / WebP); null when unknown. Pure. */
function imageSize(buf){
  if(!buf || buf.length < 24) return null;
  if(buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if(buf.toString("ascii", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if(buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP"){
    const t = buf.toString("ascii", 12, 16);
    if(t === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if(t === "VP8L" && buf.length >= 25){ const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    if(t === "VP8X" && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    return null;
  }
  if(buf[0] === 0xff && buf[1] === 0xd8){
    let i = 2;
    while(i + 9 < buf.length){
      if(buf[i] !== 0xff){ i++; continue; }
      const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
      if(m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

module.exports = { FROZEN, OFFICIAL, RIGHTS, REASONS, STATUS_LABEL, LINE_EXCEPTIONS, checkSource, reviewLine, stageImages, imageSize,
  fromImporterFlag, exceptionOf, statusOf, sourceCapacities, lbsIn, catalogWarrantyYears, promoReason, siteStatusMap };

/* CATALOG EXCEPTIONS QUEUE (2026-10-26, ordering #1, tracker homecareproviderservices#42). Pure: no database, no
   network, no writes. It sits on top of the launch-readiness matrix (_readiness.js launchMatrix) and adds the checks
   a reviewer works through line by line, grouped into eight categories:

     pricing  missing or unverified prices    an active master SKU with no dealer price, no master record yet,
                                               catalog codes missing from the master, parity errors, no accepted
                                               current price-list source (legacy-only or none)
     sku      SKU mismatches and duplicates   duplicate part numbers, rows without a part number, codes only in
                                               the master, a slug filed under another name (alias)
     units    variations, case packs, units  active SKUs with no unit of measure; a pack / case unit with no case
                                               quantity above 1
     content  descriptions / specifications  active SKUs on no visible product page; visible pages with a short
                                               description or fewer than three features
     images   images without verified rights rows with no image; image files that do not exist; visible pages with
                                               no main photo; gallery photos marked as a third-party source
     freight  freight / fulfillment gaps      no freight terms on the listing; terms not traced to a source/decision
     retired  discontinued or retired items   master SKUs retired / not offered / discontinued that a visible page
                                               still offers as orderable
     ready    ready for approval/publication  SKUs that are active, priced, on a visible page and carry a unit (a
                                               pack also its case quantity)

   NEVER a price: the input carries `priced` (true/false) per SKU, the output carries codes and counts only. Nothing
   here decides a fix; a frozen (Gold Standard) line is reported read-only so no bulk action ever touches it. */
const R = require("./_readiness.js");
const CC = require("./_catalog_corrections.js");

const VISIBLE = new Set(["published", "active", "discontinued"]);
const OFF = new Set(["retired", "not_listed", "discontinued", "hidden", "inactive"]);
const PACK_UOM = /\b(case|cs|pack|pk|box|bx|carton|ctn|bag|bundle|dozen|dz|roll|kit|pair|pr|set)\b|\d+\s*[- ]?\s*(pack|pk|ct|count)\b/i;
const norm = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
const CATS = ["pricing", "sku", "units", "content", "images", "freight", "retired", "ready"];
const LABELS = { pricing: "Missing or unverified prices", sku: "SKU mismatches and duplicates", units: "Variations, case packs and units",
  content: "Missing descriptions / specifications", images: "Images without verified rights", freight: "Freight / fulfillment gaps",
  retired: "Discontinued or retired items", ready: "Ready for approval and publication" };
/* Readiness checks → category. Anything unlisted stays in the line's "other" notes. */
const CHECK_CAT = {
  active_sku_without_price: "pricing", not_migrated: "pricing", catalog_codes_not_in_master: "pricing", parity_error: "pricing",
  record_not_authoritative: "pricing",
  catalog_duplicate_codes: "sku", catalog_rows_without_code: "sku", master_only_codes: "sku", slug_alias_applied: "sku",
  catalog_rows_without_image: "images", image_file_missing: "images",
  no_freight_terms: "freight",
};

/* A visible page has a photo when it has a main image, a chosen catalog-card image (not "none"), or any gallery
   photo — a grouped page (e.g. one card for two options) is shown by its card image, not page.image. */
function pagePhoto(p) {
  if (!p) return false;
  if (String(p.image || "").trim()) return true;
  if (p.card_image && String(p.card_image).trim() && p.card_image !== "none") return true;
  return (Array.isArray(p.images_gallery) ? p.images_gallery : []).some(g => g && String(g.url || g.src || g).trim());
}
function textLen(v) { return String(v == null ? "" : v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().length; }
function featureCount(v) {
  if (Array.isArray(v)) return v.filter(x => textLen(x && typeof x === "object" ? (x.text || x.title || "") : x) > 0).length;
  return String(v == null ? "" : v).split(/\n|<li\b/i).filter(s => textLen(s) > 0).length;
}

/* One line's own checks (the ones readiness does not make). */
function lineChecks(slug, skus, pages, meta, src) {
  const out = [];
  const add = (cat, severity, check, detail, codes) => out.push(Object.assign({ cat, severity, check, detail },
    codes && codes.length ? { codes: [...new Set(codes)].slice(0, 200), count: new Set(codes).size } : {}));
  const active = (skus || []).filter(s => s && !OFF.has(String(s.status || "active")));
  const visiblePages = (pages || []).filter(p => p && VISIBLE.has(String(p.status || "")) && p.disabled !== true);
  const onVisible = new Set(), offeredOn = new Map();
  for (const p of visiblePages) for (const e of Array.isArray(p.skus) ? p.skus : []) {
    const c = norm(e && (e.sku || e.code)); if (!c) continue;
    onVisible.add(c);
    if (e.disabled !== true && !["hidden", "discontinued"].includes(String(e.status || ""))) offeredOn.set(c, p.page_key);
  }

  // price: the current price-list source (Manufacturer Center register)
  if (active.length) {
    if (!src) add("pricing", "warn", "no_price_source", "no accepted price-list source on file for this line");
    else if (src.legacy) add("pricing", "info", "legacy_price_source", "the accepted price list is a legacy registration (received date not verified)");
  }
  // units
  const noUom = active.filter(s => !String(s.uom || "").trim()).map(s => s.code);
  if (noUom.length) add("units", "warn", "sku_without_unit", "active SKUs with no unit of measure (the card shows no order unit)", noUom);
  const packNoQty = active.filter(s => PACK_UOM.test(String(s.uom || "")) && !(Number(s.case_qty) > 1)).map(s => s.code);
  if (packNoQty.length) add("units", "warn", "pack_without_case_qty", "a pack / case unit with no case quantity above 1", packNoQty);
  // content
  const notOnPage = active.filter(s => !onVisible.has(norm(s.code))).map(s => s.code);
  if (notOnPage.length) add("content", "warn", "sku_not_on_visible_page", "active SKUs on no visible product page (catalog card only)", notOnPage);
  const thin = visiblePages.filter(p => textLen(p.description) < 80).map(p => p.page_key);
  if (thin.length) add("content", "warn", "short_description", "visible pages whose description is shorter than 80 characters", thin);
  const fewFeatures = visiblePages.filter(p => featureCount(p.features) < 3).map(p => p.page_key);
  if (fewFeatures.length) add("content", "info", "few_features", "visible pages with fewer than three feature bullets", fewFeatures);
  // images
  const noPhoto = visiblePages.filter(p => !pagePhoto(p)).map(p => p.page_key);
  if (noPhoto.length) add("images", "warn", "page_without_photo", "visible pages with no main photo", noPhoto);
  const thirdParty = visiblePages.filter(p => (Array.isArray(p.images_gallery) ? p.images_gallery : [])
    .some(g => g && /third.?party|reseller/i.test(String(g.source || "")))).map(p => p.page_key);
  if (thirdParty.length) add("images", "info", "third_party_photo", "visible pages using a photo recorded as a third-party / reseller source (check the approval is on file)", thirdParty);
  // freight
  if (active.length && meta && meta.freight_terms != null && !meta.freight_traced)
    add("freight", "warn", "freight_terms_untraced", "freight terms on the record are not traced to a source or decision");
  // retired still offered
  const offOffered = (skus || []).filter(s => s && OFF.has(String(s.status || "")) && offeredOn.has(norm(s.code))).map(s => s.code);
  if (offOffered.length) add("retired", "blocker", "retired_sku_offered", "master SKUs that are retired / not offered / discontinued but a visible page still offers them", offOffered);
  const offCount = (skus || []).filter(s => s && OFF.has(String(s.status || ""))).length;
  if (offCount) add("retired", "info", "retired_skus", offCount + " master SKU(s) retired, not offered or discontinued (kept as history, not orderable)");
  // ready
  const packGap = new Set(packNoQty);
  const ready = active.filter(s => s.priced === true && onVisible.has(norm(s.code)) && String(s.uom || "").trim() && !packGap.has(s.code)).map(s => s.code);
  if (ready.length) add("ready", "info", "sku_ready", "active, priced, on a visible page, with a unit (and a case quantity for a pack)", ready);
  return out;
}

/* input: the launchMatrix input, plus `sources` ({slug: current accepted price-list source or null}) and per-SKU
   `priced` booleans (never a price), and `reviews` (mfr_decisions rows of field catalog:*). Output: { categories, lines:[{slug,name,status,frozen,completion,counts,items}], totals }. */
function exceptionsQueue(input) {
  const i = input || {};
  const skus = (i.skus || []).map(s => Object.assign({}, s, { base_price: s.priced ? 1 : null }));
  const m = R.launchMatrix(Object.assign({}, i, { skus }));
  const names = Object.fromEntries((i.manufacturers || []).filter(x => x && x.slug).map(x => [x.slug, x.name || x.slug]));
  const by = (rows, k) => { const o = {}; for (const r of rows || []) if (r) (o[r[k]] = o[r[k]] || []).push(r); return o; };
  const S = by(skus, "manufacturer"), P = by(i.pages, "manufacturer");
  const meta = Object.fromEntries((i.meta || []).filter(x => x && x.slug).map(x => [x.slug, x]));
  const reviews = CC.latestReviews(i.reviews || []);
  const lines = m.lines.map(l => {
    const items = [];
    /* Codes whose visible product page carries a photo are not "rows without an image": the shop shows the page's. */
    const pagePhotoCodes = new Set();
    for (const p of P[l.slug] || []) if (p && VISIBLE.has(String(p.status || "")) && p.disabled !== true && pagePhoto(p))
      for (const e of Array.isArray(p.skus) ? p.skus : []) pagePhotoCodes.add(norm(e && (e.sku || e.code)));
    for (const e of l.exceptions || []) {
      const cat = CHECK_CAT[e.check]; if (!cat) continue;
      /* Batch 2: a duplicate part number whose latest recorded review accepts it (cross-listing, shared part,
         repeated record) is no longer open work — it is listed as a reviewed note. A conflict, or a review
         reopened later, stays counted. */
      if (e.check === "catalog_duplicate_codes" && Array.isArray(e.codes)) {
        const settled = e.codes.filter(c => CC.duplicateSettled(reviews, l.slug, c));
        const left = e.codes.filter(c => !settled.includes(c));
        if (settled.length) items.push({ cat, severity: "info", check: "duplicate_reviewed", codes: settled, count: settled.length,
          detail: "part numbers listed more than once, reviewed and recorded as intentional (" + settled.map(c => c + ": " +
            (CC.CLASSES[CC.reviewStatus(CC.reviewOf(reviews, l.slug, CC.FIELD.duplicate, c))] || "reviewed")).join("; ") + ")" });
        if (!left.length) continue;
        items.push(Object.assign({ cat }, e, { codes: left, count: Math.max(0, (e.count || e.codes.length) - settled.length) }));
        continue;
      }
      if (e.check === "catalog_rows_without_image" && Array.isArray(e.codes)) {
        const left = e.codes.filter(c => !pagePhotoCodes.has(norm(c)));
        if (!left.length) continue;
        items.push(Object.assign({ cat }, e, { codes: left, count: Math.max(0, (e.count || e.codes.length) - (e.codes.length - left.length)) }));
        continue;
      }
      items.push(Object.assign({ cat }, e));
    }
    items.push(...lineChecks(l.slug, S[l.slug] || [], P[l.slug] || [], meta[l.slug] || {}, (i.sources || {})[l.slug] || null));
    /* Recorded image review states ride along (the codes stay counted until a photo with rights is placed). */
    for (const x of items) if (x.cat === "images" && Array.isArray(x.codes)) {
      const st = {}; x.codes.forEach(c => { const d = CC.reviewOf(reviews, l.slug, CC.FIELD.image, c); const v = CC.reviewStatus(d); if (v && v !== "reopened") st[c] = v; });
      if (Object.keys(st).length) x.reviews = st;
    }
    /* Counted = work: blockers and warnings only (notes are shown, not counted) — except "ready", which is the
       count itself. A part number or page is counted ONCE per category however many checks name it; a check with
       no codes counts 1. */
    const counts = Object.fromEntries(CATS.map(c => {
      const its = items.filter(x => x.cat === c && (c === "ready" || x.severity !== "info"));
      const keys = new Set(); let n = 0;
      for (const x of its) {
        if (!Array.isArray(x.codes) || !x.codes.length) { n += 1; continue; }
        const hidden = Math.max(0, (x.count || x.codes.length) - x.codes.length);
        x.codes.forEach(code => keys.add(norm(code))); n += hidden;
      }
      return [c, n + keys.size];
    }));
    const blockers = items.filter(x => x.severity === "blocker").length;
    return { slug: l.slug, name: names[l.slug] || l.slug, status: l.status, completion: l.completion,
      frozen: !!(meta[l.slug] && meta[l.slug].frozen), gold_standard: !!l.gold_standard, blockers, counts, items };
  });
  const totals = Object.fromEntries(CATS.map(c => [c, lines.reduce((n, l) => n + l.counts[c], 0)]));
  return { categories: CATS.map(c => ({ key: c, label: LABELS[c] })), lines, totals, summary: m.summary };
}

module.exports = { exceptionsQueue, lineChecks, pagePhoto, CATS, LABELS, CHECK_CAT, PACK_UOM };

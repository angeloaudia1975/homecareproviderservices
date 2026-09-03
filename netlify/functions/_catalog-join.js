/**
 * THE JOIN, DEFINED ONCE.
 *
 * The Product Catalog stores one row per SKU (manufacturer + code). Product Content
 * Enrichment stores one row per product PAGE (manufacturer + page_key), with the SKUs it
 * covers held inside it as a list. Two different grains, and until now the only code that
 * knew how they meet lived inside the shop's own page file — which meant no admin screen
 * could answer the only question that matters: what will a dealer actually see?
 *
 * This module is that answer, in one place. The shop, the admin workspace and the status
 * sweep all run it, so they cannot disagree. If this file is wrong, everything is wrong
 * together and one fix corrects all three — which is the entire point.
 *
 * THE MASTER RECORD IS THE CATALOG SKU. An enrichment page does not create a product; it
 * describes products that already exist. Every row this module returns is a catalog SKU,
 * except the ones explicitly marked source:"page" — a SKU a page claims that the catalog
 * has never heard of, which is a defect to surface, not a product to sell.
 */

// A page reaches Partner 360 only in these states. 'approved' is INTERNAL sign-off and is
// deliberately not live — the shop has always applied this gate, so the admin must too.
const LIVE_STATUSES = ["published", "active"];

const upper = c => String(c == null ? "" : c).trim().toUpperCase();
// The join a person actually means: case-folded, punctuation-stripped. Used to FIND
// duplicates, never to merge them — that call stays with a person.
const normCode = c => upper(c).replace(/[^A-Z0-9]/g, "");
const arr = v => (Array.isArray(v) ? v : []);
const str = v => String(v == null ? "" : v).trim();

/* ── page index ───────────────────────────────────────────────────────────────
   Built once per manufacturer instead of per product, because the alternative is a
   scan of every page for every SKU and Ovation alone would make that 369 × 52. */
function indexPages(pages) {
  const bySku = {}, byGroup = {}, skuEntry = {}, all = [];
  const keys = Object.keys(pages || {});
  for (const k of keys) {
    const pg = pages[k];
    if (!pg) continue;
    all.push(k);
    // variant_group may hold ONE catalog group or a pipe-delimited list.
    const vg = pg.variant_group;
    if (vg) String(vg).split("|").forEach(g => { g = g.trim(); if (g && !byGroup[g]) byGroup[g] = k; });
    for (const sx of arr(pg.skus)) {
      const c = upper(sx && (sx.sku || sx.code));
      if (!c) continue;
      if (!bySku[c]) bySku[c] = k;      // first page to claim a SKU owns it
      if (!skuEntry[c]) skuEntry[c] = sx;
    }
  }
  return { bySku, byGroup, skuEntry, all };
}

/* IDENTITY IS DECLARED, NOT GUESSED. A page owns a SKU only where someone SAID so — its
   SKU list, or a variant group. Both are curated fields. Matching on image filename (the
   old third fallback) is what let one page silently steer a product it had never listed. */
function resolvePage(product, idx, pages) {
  const sKey = idx.bySku[upper(product && product.code)];
  if (sKey && pages[sKey]) return sKey;
  const g = str(product && product.group);
  const vKey = g && idx.byGroup[g];
  if (vKey && pages[vKey]) return vKey;
  return null;
}

const isLive = pg => !!pg && LIVE_STATUSES.indexOf(str(pg.status)) >= 0;

/* ── the join ─────────────────────────────────────────────────────────────────
   products : resolved catalog SKUs — the five price layers already applied by the caller.
              {code,name,group,category,subcategory,image,price,tiers,active,media_count}
   pages    : { page_key: product_content row } — ALL pages, not only live ones. The live
              gate is applied here, so the difference between "written" and "visible" is
              something this module can report instead of something nobody can see.
*/
function buildJoin(input) {
  const products = arr(input && input.products);
  const pages = (input && input.pages) || {};
  const categoryMap = (input && input.categoryMap) || null;
  const enrichedOnly = !!(input && input.enrichedOnly);

  const idx = indexPages(pages);
  const livePages = {};
  for (const k of idx.all) if (isLive(pages[k])) livePages[k] = pages[k];
  const liveIdx = indexPages(livePages);

  // Same-code duplicates: two catalog rows one human would call one product.
  const byNorm = {};
  for (const p of products) {
    const n = normCode(p && p.code);
    if (!n) continue;
    (byNorm[n] = byNorm[n] || []).push(str(p.code));
  }

  const rows = [], claimed = {};
  for (const p of products) {
    const code = str(p.code);
    const pageKey = resolvePage(p, idx, pages);
    const livePageKey = resolvePage(p, liveIdx, livePages);
    const pg = pageKey ? pages[pageKey] : null;
    if (pageKey) claimed[upper(code)] = true;

    // The enrichment record is the master for the things enrichment decides.
    let subcategory = str(p.subcategory);
    if (pg && str(pg.subcategory)) subcategory = str(pg.subcategory);
    let category = str(p.category);
    if (categoryMap && subcategory && !p.category_from_override) {
      const mapped = categoryMap[subcategory];
      if (mapped) category = String(mapped);
    }

    const gallery = pg ? arr(pg.images_gallery) : [];
    const prim = gallery.find(g => g && g.primary);
    const image = (prim && prim.url) || str(p.image) || (pg && str(pg.image)) || "";

    // THE LISTING GATE, exactly as the shop applies it: a SKU no LIVE page claims is not a
    // finished product on an enriched-only line, so it is not offered to dealers.
    const visible = p.active === false ? false : (enrichedOnly ? !!livePageKey : true);

    rows.push({
      source: "catalog",
      code, name: str(p.name), group: str(p.group),
      page_key: pageKey, live_page_key: livePageKey,
      page_status: pg ? str(pg.status) : "",
      page_name: pg ? str(pg.name) : "",
      category, subcategory,
      price: p.price == null ? null : p.price,
      tiers: arr(p.tiers),
      image,
      media_count: Number(p.media_count || 0) + gallery.length,
      has_description: !!(str(p.description) || (pg && str(pg.description))),
      has_features: !!(pg && arr(pg.features).length),
      active: p.active !== false,
      visible,
      duplicate_of: (byNorm[normCode(code)] || []).filter(c => c !== code),
      unlinked: !pageKey,
    });
  }

  // A page that lists a SKU the catalog has never heard of. It cannot be priced, cannot be
  // ordered, and no catalog screen will ever show it — so it is reported as its own row.
  for (const k of idx.all) {
    const pg = pages[k];
    for (const sx of arr(pg && pg.skus)) {
      const c = upper(sx && (sx.sku || sx.code));
      if (!c || claimed[c]) continue;
      if (rows.some(r => upper(r.code) === c)) continue;
      claimed[c] = true;
      rows.push({
        source: "page", code: str(sx.sku || sx.code), name: str(sx.name),
        page_key: k, live_page_key: isLive(pg) ? k : null,
        page_status: str(pg.status), page_name: str(pg.name),
        category: "", subcategory: str(pg.subcategory),
        price: null, tiers: [], image: "", media_count: 0,
        has_description: !!str(pg.description), has_features: !!arr(pg.features).length,
        active: true, visible: false, duplicate_of: [], unlinked: false, no_catalog_row: true,
      });
    }
  }

  return { rows, pages, live_page_keys: Object.keys(livePages), enriched_only: enrichedOnly };
}

/* ── the completion status ────────────────────────────────────────────────────
   DERIVED, NEVER STORED. A stored status is a status that can be wrong, and the platform
   already has one of those: Ovation reports 52 of 52 pages "published" while 85 priced SKUs
   are gated out of the shop. Computing it from the same data the shop reads means the answer
   cannot drift from what a dealer sees.

   First rule that matches wins, so every SKU sits in exactly ONE queue and the counts add up
   to the catalog. The order is the order the work has to happen in: you cannot sensibly
   enrich a product you are about to merge away, and you cannot publish one nobody priced. */
const STATUSES = [
  "possible_duplicate", "needs_sku_review", "needs_pricing", "needs_category",
  "needs_images", "needs_content", "ready_to_publish", "published",
];
const LABELS = {
  possible_duplicate: "Possible Duplicate", needs_sku_review: "Needs SKU Review",
  needs_pricing: "Needs Pricing", needs_category: "Needs Category",
  needs_images: "Needs Images", needs_content: "Needs Content",
  ready_to_publish: "Ready to Publish", published: "Published",
  retired: "Retired",
};

function statusFor(row, opts) {
  const o = opts || {};
  const categoryMap = o.categoryMap || null;
  const dealerCategories = arr(o.dealerCategories).map(String);
  const settled = o.settled || {};   // codes a person has already judged

  // Retired is not a work queue. A discontinued product keeps its order history and its
  // commissions — it is simply not for sale — so it is counted apart from the eight.
  if (row.active === false) return { status: "retired", why: "retired or hidden" };

  if (row.duplicate_of && row.duplicate_of.length && !settled[row.code])
    return { status: "possible_duplicate", why: "same part number as " + row.duplicate_of.join(", ") };

  if (row.no_catalog_row)
    return { status: "needs_sku_review", why: "listed on a page but no catalog record — cannot be priced or ordered" };
  if (row.unlinked)
    return { status: "needs_sku_review", why: "no enrichment page lists this SKU" };
  // Claims published, is not visible. The exact failure a stored status cannot catch.
  if (row.page_key && !row.live_page_key && LIVE_STATUSES.indexOf(row.page_status) >= 0)
    return { status: "needs_sku_review", why: "page is live but this SKU is not claimed by it" };

  if (row.price == null && !(row.tiers && row.tiers.length))
    return { status: "needs_pricing", why: "no price survives the catalog layers" };

  if (!row.category)
    return { status: "needs_category", why: "no category" };
  if (dealerCategories.length && dealerCategories.indexOf(row.category) < 0)
    return { status: "needs_category", why: '"' + row.category + '" is not a dealer-facing category' };
  if (row.subcategory && categoryMap && !categoryMap[row.subcategory])
    return { status: "needs_category", why: '"' + row.subcategory + '" is not mapped to a category' };

  if (!row.image && !row.media_count)
    return { status: "needs_images", why: "no image on the SKU or its page" };

  if (!row.has_description && !row.has_features)
    return { status: "needs_content", why: "page has no description and no features" };

  if (!row.live_page_key)
    return { status: "ready_to_publish", why: "complete — page is " + (row.page_status || "not published") };

  return { status: "published", why: "live and visible to dealers" };
}

/* Statuses for a whole manufacturer, plus the counts that make the board. */
function sweep(input) {
  const joined = buildJoin(input);
  const opts = {
    categoryMap: (input && input.categoryMap) || null,
    dealerCategories: arr(input && input.dealerCategories),
    settled: (input && input.settled) || {},
  };
  const counts = {}; STATUSES.forEach(s => { counts[s] = 0; }); counts.retired = 0;
  const rows = joined.rows.map(r => {
    const s = statusFor(r, opts);
    counts[s.status] = (counts[s.status] || 0) + 1;
    return Object.assign({}, r, { status: s.status, status_label: LABELS[s.status], why: s.why });
  });
  const total = rows.length;
  const done = counts.published;
  return {
    rows, counts, total,
    catalog_total: rows.filter(r => r.source === "catalog").length,
    no_catalog_row: rows.filter(r => r.no_catalog_row).length,
    enriched_only: joined.enriched_only,
    // Retired products are finished business, so they do not drag the percentage down.
    percent_published: total - counts.retired > 0
      ? Math.round((done / (total - counts.retired)) * 100) : 0,
  };
}

module.exports = {
  LIVE_STATUSES, STATUSES, LABELS,
  upper, normCode, indexPages, resolvePage, isLive,
  buildJoin, statusFor, sweep,
};

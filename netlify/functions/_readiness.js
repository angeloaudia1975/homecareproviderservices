/* Manufacturer LAUNCH READINESS — the go-live matrix (2026-10-23, master assignment
   homecareproviderservicesordering#1, workstream A). Pure: no database, no network, no writes.

   One question per line: how far is this manufacturer from being orderable by dealers, measured from what
   already exists — never from a flag someone has to remember to set. It sits ON TOP of the existing
   Manufacturer Center reads (mc_overview, status_sweep, the master record) and never keeps a copy of them.

   Five stages, each a measured fraction 0..1 (issue #1 A.4 — "existing in JSON / master migrated / enriched /
   dealer-visible / order-verified"):
     1 catalog   — rows in the catalog file (public/data/<slug>.json) that carry a part number. PRICES IN THAT FILE
                   ARE NEVER READ (owner review PR #34, 2026-10-23): the public file is legacy and its prices are due to
                   be removed, so removing them must not lower this score. Dealer prices are judged on the master record.
     2 master    — catalog codes that have a product_skus row; record_authoritative is reported, not scored
     3 enriched  — active SKUs claimed by a VISIBLE enrichment page (published / active / discontinued, not disabled)
     4 listed    — in manufacturers.json, hasData, not hidden, and at least one row. LISTED ONLY: it does not prove an
                   approved dealer sees prices, can check out, or that orders and My Orders work — that is launch_ready.
     5 verified  — a current Gold Standard (newest passing baseline/post run with a fingerprint — _mc.js goldStandardOf)
   completion = the mean of the five, rounded to a whole percent. A line with no catalog rows and no master rows
   is "no_data", never 0%-of-something-real and never "empty" when legacy rows exist somewhere else.
   launch_ready is a SEPARATE yes/no, never derived from the percentage: Gold Standard, no blocker, AND a passing dealer
   checkout verification for the line (`order_verified`, supplied by the dealer launch suite). Until that suite exists
   no line is launch_ready, whatever its percentage.

   Slugs: an alias (gce → ohio-medical) is applied ONLY when the caller passes it in `aliases`, and every alias
   applied is reported as an exception so a split / merge is never silent (issue #1 A — "plan explicit
   normalization rather than silently split or merge").

   Exceptions are facts with a severity: "blocker" stops activation, "warn" needs a look, "info" is context.
   Nothing here decides a fix. */

const VISIBLE = new Set(["published", "active", "discontinued"]);
const normCode = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
const pct = (n, d) => (d > 0 ? n / d : 0);
const round = f => Math.round(f * 100);

function pageClaims(pages) {
  const visible = new Set(), anyPage = new Set();
  for (const p of pages || []) {
    if (!p) continue;
    const vis = VISIBLE.has(String(p.status || "")) && p.disabled !== true;
    for (const s of Array.isArray(p.skus) ? p.skus : []) {
      const code = normCode(s && (s.sku || s.code));
      if (!code) continue;
      anyPage.add(code);
      if (vis && s.disabled !== true && s.status !== "hidden") visible.add(code);
    }
  }
  return { visible, anyPage };
}

/* One line. input:
   { slug, listing (manufacturers.json entry or null), catalog (rows or null = no file), skus (product_skus rows),
     pages (product_content rows), meta (manufacturer_meta row), gold_standard (goldStandardOf result or null),
     open_regression_fixes (number), alias_from (slug the rows were filed under, if an alias was applied) } */
function lineReadiness(input) {
  const i = input || {};
  const slug = String(i.slug || "");
  const ex = [];
  const add = (severity, check, detail, codes) => ex.push(Object.assign({ severity, check, detail }, codes && codes.length ? { codes: codes.slice(0, 50), count: codes.length } : {}));

  const catalog = Array.isArray(i.catalog) ? i.catalog : null;
  const rows = catalog || [];
  const skus = (i.skus || []).filter(Boolean);
  const active = skus.filter(r => r.status === "active");
  const activeCodes = new Set(active.map(r => normCode(r.code)));
  const listing = i.listing || null;
  const meta = i.meta || {};
  // What this run could actually read. An unmeasured layer is reported as unmeasured — never as empty.
  const measured = Object.assign({ master: true, pages: true, runs: true }, i.measured || {});

  // ---- stage 1: catalog file
  const fileCodes = new Map();
  for (const r of rows) { const c = normCode(r && r.code); if (c) fileCodes.set(c, (fileCodes.get(c) || 0) + 1); }
  const coded = rows.filter(r => normCode(r && r.code)).length;
  const dup = [...fileCodes].filter(([, n]) => n > 1).map(([c]) => c);
  if (dup.length) add("warn", "catalog_duplicate_codes", "the same part number appears more than once in the catalog file", dup);
  if (catalog && rows.length && coded < rows.length) add("warn", "catalog_rows_without_code", (rows.length - coded) + " catalog row(s) carry no part number");
  if (!catalog) add("info", "no_catalog_file", "no public/data catalog file for this line");

  // ---- stage 2: master record
  const fileCodeSet = new Set(fileCodes.keys());
  const migrated = [...fileCodeSet].filter(c => activeCodes.has(c) || skus.some(r => normCode(r.code) === c));
  const notInMaster = [...fileCodeSet].filter(c => !skus.some(r => normCode(r.code) === c));
  const masterOnly = [...activeCodes].filter(c => !fileCodeSet.has(c));
  if (!measured.master) {}
  else if (rows.length && !skus.length) add("blocker", "not_migrated", "catalog rows exist but no master record rows — legacy data, not empty");
  else if (notInMaster.length) add("warn", "catalog_codes_not_in_master", "catalog codes with no master record row", notInMaster);
  if (measured.master && masterOnly.length) add("info", "master_only_codes", "active master codes not in the catalog file (added rows / custom_products)", masterOnly);
  const noPrice = active.filter(r => !(Number(r.base_price) > 0)).map(r => normCode(r.code));
  if (noPrice.length) add("blocker", "active_sku_without_price", "active master SKUs with no dealer price — must stay unorderable", noPrice);
  if (skus.length && meta.record_authoritative !== true) add("warn", "record_not_authoritative", "master record exists but record_authoritative is OFF — the legacy layers still win");
  if (meta.record_resync_error) add("blocker", "parity_error", String(meta.record_resync_error).slice(0, 200));

  // ---- stage 3: enrichment
  const claims = pageClaims(i.pages);
  // Without the master record, the catalog file's codes stand in for "the SKUs that should have a page".
  const shouldHavePage = measured.master ? [...activeCodes] : [...fileCodeSet];
  const unclaimed = shouldHavePage.filter(c => !claims.visible.has(c));
  const deferred = (Array.isArray(meta.deferrals) ? meta.deferrals : []).some(d => /content|enrich|page/i.test(typeof d === "string" ? d : JSON.stringify(d)));
  if (measured.pages && shouldHavePage.length && unclaimed.length) add(deferred ? "info" : "warn", "active_skus_without_visible_page", (deferred ? "deferred by decision — " : "") + "active SKUs no visible enrichment page claims", unclaimed);

  // ---- images (catalog file is the fallback image authority)
  const noImage = rows.filter(r => r && !String(r.image || "").trim()).map(r => normCode(r.code));
  if (noImage.length) add("warn", "catalog_rows_without_image", "rows with no image (the shop shows the placeholder)", noImage);
  if (Array.isArray(i.missing_image_files) && i.missing_image_files.length) add("blocker", "image_file_missing", "image path set but the file does not exist — a broken image", i.missing_image_files);

  // ---- stage 4: listed (NOT dealer visibility — see launch_ready)
  const listed = !!listing && listing.hidden !== true;
  if (!listing) add(rows.length || skus.length ? "blocker" : "info", "not_listed", "not in manufacturers.json — dealers cannot reach it");
  else if (listing.hidden === true) add("info", "hidden", "listed but hidden");
  if (listing && listing.hasData === true && !rows.length && !skus.length) add("blocker", "listed_without_rows", "listed with hasData:true but nothing to show");
  if (listing && listing.hasData === false && (rows.length || skus.length)) add("warn", "rows_but_hasData_false", "rows exist but the listing says hasData:false");
  if (listing && !listing.freight && (rows.length || skus.length)) add("warn", "no_freight_terms", "no freight terms on the listing — the cart uses the generic rule");

  // ---- stage 5: verified
  const gs = i.gold_standard || null;
  if (gs && gs.later_failed) add("info", "later_runs_failed", gs.later_failed + " later verification attempt(s) failed and were rolled back — Gold Standard unchanged");
  if (Number(i.open_regression_fixes) > 0) add("warn", "open_regression_fix", i.open_regression_fixes + " regression fix(es) recorded and not yet carried out");
  if (i.alias_from) add("warn", "slug_alias_applied", "rows filed under '" + i.alias_from + "' were read as '" + slug + "' — normalization must be decided, not assumed");

  const base = rows.length || skus.length;
  const stages = {
    catalog: base ? pct(coded, rows.length || 0) : 0,
    master: !measured.master ? null : rows.length ? pct(migrated.length, fileCodeSet.size) : (skus.length ? 1 : 0),
    enriched: !measured.pages ? null : shouldHavePage.length ? pct(shouldHavePage.length - unclaimed.length, shouldHavePage.length) : 0,
    listed: listed && listing.hasData !== false && base ? 1 : 0,
    verified: !measured.runs ? null : gs ? 1 : 0,
  };
  const order = { blocker: 0, warn: 1, info: 2 };
  ex.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));
  const unmeasured = Object.keys(stages).filter(k => stages[k] == null);
  const vals = Object.values(stages).filter(v => v != null);
  const blocked = ex.some(e => e.severity === "blocker");
  const status = !base ? "no_data" : blocked ? "blocked" : unmeasured.length ? "partial_measurement" : gs ? "gold_standard" : "in_progress";
  const ov = i.order_verified === true;
  const launch_ready = status === "gold_standard" && ov;
  const launch_ready_reason = launch_ready ? "Gold Standard, no blocker, dealer checkout verified"
    : status !== "gold_standard" ? "not Gold Standard (" + status + ")"
    : "dealer checkout not verified (entitlement, authenticated prices, cart / freight, order record, emails, My Orders)";
  return {
    slug, name: (listing && listing.name) || slug, status, launch_ready, launch_ready_reason,
    // Completion is claimed only over a full measurement; a partial run reports the measured stages and says so.
    completion: base && !unmeasured.length ? round(vals.reduce((n, v) => n + v, 0) / 5) : (base ? null : 0),
    unmeasured,
    stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v == null ? null : round(v)])),
    counts: { catalog_rows: rows.length, master_rows: skus.length, master_active: active.length,
      record_authoritative: meta.record_authoritative === true, frozen: meta.frozen === true,
      visible_page_skus: shouldHavePage.length - unclaimed.length, pages: (i.pages || []).length },
    gold_standard: gs ? { id: gs.id, run_at: gs.run_at, fingerprint: gs.fingerprint, later_failed: gs.later_failed || 0 } : null,
    blockers: ex.filter(e => e.severity === "blocker").length,
    exceptions: ex,
  };
}

/* Every line: the union of listed slugs, catalog files and master rows, so a line that exists in only one
   layer still shows up. aliases = { fromSlug: toSlug } — explicit only. */
function launchMatrix(input) {
  const i = input || {};
  const aliases = i.aliases || {};
  const to = s => aliases[s] || s;
  const listings = new Map((i.manufacturers || []).filter(m => m && m.slug).map(m => [to(m.slug), m]));
  const files = {}, aliasFrom = {};
  for (const [s, rows] of Object.entries(i.catalogs || {})) { const t = to(s); if (t !== s) aliasFrom[t] = s; files[t] = (files[t] || []).concat(rows || []); }
  const by = (rows, k) => { const o = {}; for (const r of rows || []) { if (!r) continue; const t = to(r[k]); (o[t] = o[t] || []).push(r); } return o; };
  const skus = by(i.skus, "manufacturer"), pages = by(i.pages, "manufacturer");
  const meta = Object.fromEntries((i.meta || []).filter(m => m && m.slug).map(m => [to(m.slug), m]));
  const lines = i.lines || {};
  const slugs = [...new Set([...listings.keys(), ...Object.keys(files), ...Object.keys(skus), ...Object.keys(pages)])]
    .filter(s => !(i.exclude || []).includes(s)).sort();
  const out = slugs.map(s => lineReadiness({
    slug: s, listing: listings.get(s) || null, catalog: files[s] || null, skus: skus[s] || [], pages: pages[s] || [],
    meta: meta[s] || {}, gold_standard: (lines[s] || {}).gold_standard || null,
    open_regression_fixes: (lines[s] || {}).open_regression_fixes || 0,
    missing_image_files: (i.missing_images || {})[s] || [], alias_from: aliasFrom[s] || null, measured: i.measured,
    order_verified: (lines[s] || {}).order_verified === true }));
  const withData = out.filter(l => l.status !== "no_data");
  return {
    lines: out,
    summary: {
      lines: out.length, with_data: withData.length,
      gold_standard: out.filter(l => l.status === "gold_standard").length,
      blocked: out.filter(l => l.status === "blocked").length,
      in_progress: out.filter(l => l.status === "in_progress").length,
      partial_measurement: out.filter(l => l.status === "partial_measurement").length,
      no_data: out.filter(l => l.status === "no_data").length,
      // An equal-weight average of the stage percentages over the lines WITH data — always shown with its
      // denominator, never as "the platform is N% launch-ready" (owner review PR #34).
      average_stage_completion: withData.length && withData.every(l => l.completion != null)
        ? Math.round(withData.reduce((n, l) => n + l.completion, 0) / withData.length) : null,
      average_over_lines: withData.length,
      excluded_no_data: out.filter(l => l.status === "no_data").map(l => l.slug),
      launch_ready: out.filter(l => l.launch_ready).length,
      launch_ready_of: out.length,
    },
  };
}

module.exports = { lineReadiness, launchMatrix, normCode, VISIBLE };

/* Catalog import — the reusable core (master assignment homecareproviderservicesordering#1, workstream B; 2026-10-23).
   Pure: no database, no network, no writes. Adapters (_import_adapters.js) turn one manufacturer file into the
   normalized line below; this module validates it, compares it with what HCPS already has, and builds the review
   report. Nothing here stages, publishes or prices anything — staging goes through the EXISTING Manufacturer Center
   path (mc_register_source → mc_import_source_rows → mc_match → stage_record_source), with its two human gates.

   Normalized line (adapter output):
   { manufacturer, source: { file, sha256, title, effective_date, effective_date_status: stated|pending|not_stated,
       received_date }, terms: [{ kind, text, value? }],            // stated line-level rules, word for word
     rows: [{ code, name, description, size, category_hint, section,
              dealer_price, tiers: [{ min_qty, price, pool? }],      // tiers in the SELLING unit (CLAUDE.md §17)
              msrp, msrp_source: "stated" | "source_rule" | null,     // never invented; a stated rule is cited
              map,  map_source:  "stated" | "source_rule" | null,
              uom, case_qty, upc, options: [{ label, price_add }],
              dealer_price_scope: "dealer" | "named_account",         // a price quoted for ONE account is not a base price
              locator, flags: [{ level, code, detail }] }] }

   Rules carried from CLAUDE.md §17: one price is never derived from another (unit vs case); MAP/MSRP only where the
   source states them or states the rule; two dates (received vs manufacturer effective), never invent the effective
   date; a disagreement between the source and HCPS is reported, never resolved here. */

const normCode = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
const money = v => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const s = String(v).replace(/[\s,]/g, "").replace(/^\+/, "");
  if (!/^\$?-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s.replace("$", ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const clean = v => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const flag = (level, code, detail) => ({ level, code, detail });

/* Validate one normalized line. Returns a COPY with row flags added and line exceptions; never drops a row. */
function validateLine(line) {
  const L = JSON.parse(JSON.stringify(line || {}));
  L.rows = Array.isArray(L.rows) ? L.rows : [];
  const ex = [];
  const src = L.source || {};
  if (!src.sha256) ex.push(flag("blocker", "source_unhashed", "the source file has no SHA-256 — it cannot be registered"));
  if (src.effective_date_status !== "stated") ex.push(flag("info", "effective_date_not_stated", "no manufacturer effective date on the source — recorded as pending, never invented"));
  const seen = new Map();
  for (const r of L.rows) {
    r.flags = Array.isArray(r.flags) ? r.flags : [];
    r.code = clean(r.code);
    const k = normCode(r.code);
    if (!k) { r.flags.push(flag("blocker", "no_code", "row has no part number")); continue; }
    if (!(r.dealer_price > 0)) r.flags.push(flag("blocker", "no_dealer_price", "no dealer price on the source — cannot be orderable"));
    if (r.dealer_price_scope === "named_account") r.flags.push(flag("blocker", "named_account_price", "the price column is quoted for one named account, not a general dealer price — needs Angelo's decision"));
    const tiers = Array.isArray(r.tiers) ? r.tiers : [];
    for (let i = 1; i < tiers.length; i++) {
      if (!(tiers[i].min_qty > tiers[i - 1].min_qty)) r.flags.push(flag("blocker", "tier_order", "quantity breaks are not ascending"));
      if (tiers[i].price > tiers[i - 1].price + 0.005) r.flags.push(flag("warn", "tier_not_descending", "a higher quantity break costs more — kept exactly as published"));
    }
    if (tiers.length && r.dealer_price != null && Math.abs(tiers[0].price - r.dealer_price) >= 0.005) r.flags.push(flag("blocker", "qty1_mismatch", "the first break differs from the dealer price"));
    if (r.map != null && r.msrp != null && r.map > r.msrp + 0.005) r.flags.push(flag("warn", "map_above_msrp", "MAP is above MSRP on the source"));
    if (r.msrp != null && r.dealer_price != null && r.case_qty > 1 && r.msrp_source === "stated" && r.msrp < r.dealer_price / r.case_qty - 0.005) r.flags.push(flag("warn", "msrp_below_unit_cost", "MSRP is below the per-unit dealer cost — check the MSRP basis"));
    if (r.case_qty != null && !(Number.isInteger(r.case_qty) && r.case_qty >= 1)) r.flags.push(flag("blocker", "bad_case_qty", "case quantity is not a whole number"));
    if (seen.has(k)) {
      const first = seen.get(k);
      const same = first.dealer_price === r.dealer_price && JSON.stringify(first.tiers || []) === JSON.stringify(tiers) && first.msrp === r.msrp;
      r.flags.push(flag(same ? "warn" : "blocker", same ? "duplicate_in_source_same_price" : "duplicate_in_source_conflict",
        (same ? "listed twice in the source with the same price (" : "listed twice in the source with DIFFERENT figures (") + (first.locator || "") + " / " + (r.locator || "") + ")"));
      r.duplicate_of = first.locator || true;
    } else seen.set(k, r);
  }
  L.exceptions = ex;
  return L;
}

/* Compare the source with HCPS's existing rows for the line (catalog file rows, and optionally master rows with
   status + priced flag only). Matching is by normalized code; anything else is only a SUGGESTION. */
function compareLine(line, existing) {
  const L = line;
  const e = existing || {};
  const cat = (e.catalog || []).filter(Boolean);
  const master = (e.master || []).filter(Boolean);
  const byCat = new Map(); for (const r of cat) { const k = normCode(r.code); if (k) (byCat.get(k) || byCat.set(k, []).get(k)).push(r); }
  const byMaster = new Map(master.map(r => [normCode(r.code), r]));
  const srcKeys = new Set();
  const rows = [];
  for (const r of L.rows) {
    if (r.duplicate_of) continue;
    const k = normCode(r.code); if (!k) continue; srcKeys.add(k);
    const c = byCat.get(k) || [], m = byMaster.get(k) || null;
    const out = { code: r.code, status: c.length || m ? "matched" : "new", catalog_codes: c.map(x => x.code), master_status: m ? m.status : null, changes: [] };
    if (c.length > 1) out.changes.push({ field: "catalog", detail: "more than one catalog row has this part number" });
    const legacy = c[0];
    if (legacy) {
      // Legacy rows that hold both a list dealer price and a discounted base (Access4U tiers) are compared on the list price.
      const lp = money(legacy.dealer_price != null ? legacy.dealer_price : legacy.base_price);
      if (lp != null && r.dealer_price != null && Math.abs(lp - r.dealer_price) >= 0.005) out.changes.push({ field: "dealer_price", from: lp, to: r.dealer_price });
      const lm = money(legacy.msrp);
      if (r.msrp != null && lm != null && Math.abs(lm - r.msrp) >= 0.005) out.changes.push({ field: "msrp", from: lm, to: r.msrp });
      if (r.map != null && legacy.map != null && Math.abs(money(legacy.map) - r.map) >= 0.005) out.changes.push({ field: "map", from: money(legacy.map), to: r.map });
      if (r.map != null && legacy.map == null) out.changes.push({ field: "map", from: null, to: r.map });
      if (r.case_qty > 1 && Number(legacy.case_qty || legacy.qty_per_pack || 1) !== r.case_qty) out.changes.push({ field: "case_qty", from: legacy.case_qty || legacy.qty_per_pack || null, to: r.case_qty });
      if (!String(legacy.image || "").trim()) out.changes.push({ field: "image", detail: "no image on the catalog row" });
    }
    if (out.status === "matched" && out.changes.some(x => ["dealer_price", "msrp", "map", "case_qty"].includes(x.field))) out.status = "changed";
    if (out.status === "matched" && !out.changes.length) out.status = "unchanged";
    if (out.status === "new") out.suggestions = suggest(k, [...byCat.keys()]);
    rows.push(out);
  }
  const notInSource = [...byCat.keys()].filter(k => !srcKeys.has(k)).map(k => {
    const r = byCat.get(k)[0]; const m = byMaster.get(k);
    return { code: r.code, name: r.name || "", master_status: m ? m.status : null, suggestions: suggest(k, [...srcKeys]) };
  });
  const count = s => rows.filter(r => r.status === s).length;
  return { rows, not_in_source: notInSource,
    summary: { source_rows: L.rows.length, distinct: srcKeys.size, new: count("new"), changed: count("changed"), unchanged: count("unchanged"),
      matched_other: count("matched"), catalog_rows: cat.length, catalog_not_in_source: notInSource.length } };
}

/* A suggestion is only a hint for a person: same letters with a different separator / one character apart. */
function suggest(k, pool) {
  const out = [];
  for (const p of pool) {
    if (p === k) continue;
    if (p.replace(/0/g, "") === k.replace(/0/g, "") || lev(p, k) <= 1) out.push(p);
    if (out.length >= 3) break;
  }
  return out;
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/* The review report for one line: counts + every exception, blockers first. */
function report(line, comparison) {
  const rowFlags = [];
  for (const r of line.rows) for (const f of r.flags || []) rowFlags.push(Object.assign({ code_ref: r.code, locator: r.locator }, f));
  const order = { blocker: 0, warn: 1, info: 2 };
  const all = (line.exceptions || []).concat(rowFlags).sort((a, b) => order[a.level] - order[b.level] || a.code.localeCompare(b.code));
  const priced = line.rows.filter(r => r.dealer_price > 0 && !r.duplicate_of).length;
  return {
    manufacturer: line.manufacturer, source: line.source, terms: line.terms || [],
    counts: Object.assign({ priced, with_msrp: line.rows.filter(r => r.msrp != null && !r.duplicate_of).length,
      with_map: line.rows.filter(r => r.map != null && !r.duplicate_of).length,
      with_tiers: line.rows.filter(r => (r.tiers || []).length > 1 && !r.duplicate_of).length,
      with_options: line.rows.filter(r => (r.options || []).length && !r.duplicate_of).length,
      blockers: all.filter(f => f.level === "blocker").length, warnings: all.filter(f => f.level === "warn").length }, comparison ? comparison.summary : {}),
    exceptions: all,
    stage_ready: !all.some(f => f.level === "blocker"),
  };
}

/* The rows Manufacturer Center's mc_import_source_rows takes (price_imports shape): source facts only; every original
   column stays in raw. Built for review — sending them is a separate, gated step. */
function priceImportRows(line) {
  return line.rows.filter(r => !r.duplicate_of && normCode(r.code)).map(r => ({
    code: r.code, description: r.name || r.description || "", base_price: r.dealer_price ?? null,
    msrp: r.msrp_source === "stated" ? r.msrp ?? null : null, map: r.map_source === "stated" ? r.map ?? null : null,
    tiers: (r.tiers || []).length > 1 ? r.tiers.map(t => Object.assign({ min_qty: t.min_qty, price: t.price }, t.pool ? { pool: t.pool } : {})) : null,
    parsed_case_qty: r.case_qty ?? null,
    raw: Object.assign({}, r.raw || {}, { _locator: r.locator, _uom: r.uom ?? null, _section: r.section ?? null,
      _msrp_source: r.msrp_source ?? null, _map_source: r.map_source ?? null, _source_rule_msrp: r.msrp_source === "source_rule" ? r.msrp : null,
      _source_rule_map: r.map_source === "source_rule" ? r.map : null, _options: r.options || [], _price_scope: r.dealer_price_scope || "dealer" }),
  }));
}

module.exports = { normCode, money, clean, flag, validateLine, compareLine, report, priceImportRows, suggest };

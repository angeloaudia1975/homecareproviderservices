// HCPS ordering-platform ACCESS RULES (shared).
// Decides, for a dealer, which manufacturer lines they can order and how the Golden
// button behaves. Access is COMPANY-LEVEL: evaluate the governing account (the master
// HQ if the dealer is a branch, else the dealer itself); every branch inherits it.
//
//   your_accounts = eligible lines the dealer already has an account for
//   available     = eligible lines they don't have yet (prospect / "Available to you")
//   golden        = "Account" | "Prospect" | "None"  (drives the Golden Ordering Platform button)
//   ovation       = boolean (Ovation ordering access)
//
// Golden is NOT orderable here (separate Golden platform), so it never appears in
// your_accounts/available — it's surfaced only via `golden`.

const ALL_DEALERS = ["access4u", "airavant-bongorx", "corsicana", "yuwell"];   // every dealer
/* Yuwell (owner 2026-11-04 22:30 CT): a NEW manufacturer every dealer may review and shop without an account —
   shown under "Available to you — open a new account" until HCPS records the dealer's Yuwell account number
   after their dealer application. Dealers with an access grid get it from supabase/yuwell_activation.sql. */
const STATE_RULES  = { bemis: ["IN","KY","OH"], pedifix: ["KY","TN","GA"],
                       dalton: ["KY","TN"] };
const CLIMBING   = "climbing-steps";        // all dealers EXCEPT Mobility City
const STRONGBACK = "strongback-mobility";   // Exclusive Territory (below)
const OVATION    = "ovation-medical";       // per-account flag
// Retired lines (_retired_lines.js): never orderable, never offered as "available", whatever the account rows say.
const RETIRED = require("./_retired_lines.js");
const NOT_REPRESENTED = new Set(Object.keys(RETIRED.RETIRED_LINES));
// Golden is ordered on Golden's own platform, not inline here — so it is never an orderable
// line in your_accounts/available even if it's ticked in the admin grid. It's surfaced via `golden`.
const GOLDEN_SLUGS = new Set(["golden", "golden-technologies"]);

const INDIANAPOLIS_LAT = 39.7684;           // "south of Indianapolis" cutoff for IN
const OH_EXCLUSIVE = [/\byost\b/i, /med\s*mart/i, /\belumina\b/i];   // OH accounts in territory

function isMobilityCity(name){ return /mobility\s*city/i.test(name || ""); }

// Strongback's Exclusive Territory (also reusable): all KY/TN/GA; IN south of Indianapolis
// (needs a latitude — if unknown, conservatively excluded); OH only Yost / Med Mart / Elumina.
function inExclusiveTerritory(state, name, lat){
  const st = String(state || "").toUpperCase();
  if (st === "KY" || st === "TN" || st === "GA") return true;
  if (st === "IN") return (lat != null && isFinite(lat)) ? (Number(lat) < INDIANAPOLIS_LAT) : false;
  if (st === "OH") return OH_EXCLUSIVE.some(re => re.test(name || ""));
  return false;
}

// gov: governing account -> { state, business_name, golden_status, ovation_access, lat }
// ownedSlugs:   slugs the dealer already has an account NUMBER for (account_ref set)
// grantedSlugs: slugs ticked in the admin "Ordering Access" grid (dealer_manufacturers active=true)
//
// The admin grid is AUTHORITATIVE: whenever a dealer has at least one line ticked, the portal shows
// EXACTLY those lines (minus Golden / not-represented), overriding the territory rules — so "turn a
// line on and the dealer sees it" always holds, regardless of state or account status. Only when the
// grid is completely empty do we fall back to the territory rules, so dealers set up before the grid
// was used never silently go dark. (Golden is still surfaced separately via `golden`.)
/* GRID-ONLY (owner directive 2026-11-06 20:55 CT, §2): Dealer Manager is the ONLY source of ordering eligibility — no
   territory, geography, import history or account number substitutes. With opts.gridOnly the territory fallback is gone (a
   dealer with no grid sees no lines) and the Golden button follows the STORED Golden status only (no Kentucky "Prospect" by
   territory). Rolled out by the switch phase2_flags.grid_only_access after the impact report (dealers-api
   entitlement_impact) — the territory rules stay for rep prospecting (map / routes), never for ordering. */
function computeAccess(gov, ownedSlugs, grantedSlugs, opts){
  const gridOnly = !!(opts && opts.gridOnly);
  const owned = new Set([...(ownedSlugs || [])].filter(s => s && !RETIRED.isRetiredLine(s)));
  /* Grid vs territory is decided on the RAW grants (Golden aside), BEFORE retired lines are removed: a dealer
     whose only grant is a retired line (e.g. "ohio-medical") still has a grid, so they get exactly nothing —
     never the territory rules' full line-up (review 2026-11-04, finding 1). */
  const rawGrants = [...(grantedSlugs || [])].filter(s => s && !GOLDEN_SLUGS.has(String(s).trim().toLowerCase()));
  const hasGrid = rawGrants.length > 0;
  const granted = rawGrants.filter(s => !RETIRED.isRetiredLine(s));
  const st = String(gov.state || "").toUpperCase();
  const name = gov.business_name || "";

  let eligible;
  if (hasGrid || gridOnly) {
    // Explicit admin grants win — the dealer can order exactly what was ticked.
    eligible = new Set(granted);
  } else {
    // No explicit grants on file — compute from territory rules (prior behavior).
    eligible = new Set(ALL_DEALERS);
    if (!isMobilityCity(name)) eligible.add(CLIMBING);
    for (const [slug, states] of Object.entries(STATE_RULES)) if (states.includes(st)) eligible.add(slug);
    if (inExclusiveTerritory(st, name, gov.lat)) eligible.add(STRONGBACK);
    if (gov.ovation_access) eligible.add(OVATION);
  }
  [...eligible].forEach(s => { if (RETIRED.isRetiredLine(s)) eligible.delete(s); });
  GOLDEN_SLUGS.forEach(s => eligible.delete(s));   // Golden is never an inline orderable line

  const your_accounts = [...eligible].filter(s => owned.has(s)).sort();
  const available     = [...eligible].filter(s => !owned.has(s)).sort();

  // Golden status: a dealer with a current Golden account stays "Account". Otherwise, every
  // Kentucky dealer is treated as a Golden PROSPECT (HCPS actively develops Golden across KY),
  // so Golden shows as an approved territory line for them. Elsewhere, use the stored status.
  let golden = gov.golden_status || "None";
  if (!gridOnly && golden !== "Account" && st === "KY") golden = "Prospect";

  return {
    your_accounts,
    available,
    golden,
    ovation: !!gov.ovation_access,
  };
}

module.exports = { computeAccess, inExclusiveTerritory, isMobilityCity, ALL_DEALERS, STATE_RULES };

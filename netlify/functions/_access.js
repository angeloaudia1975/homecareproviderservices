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

const ALL_DEALERS = ["access4u", "airavant-bongorx", "corsicana"];      // every dealer
const STATE_RULES  = { bemis: ["IN","KY","OH"], pedifix: ["KY","TN","GA"], gce: ["IN","KY","TN","OH"] };
const CLIMBING   = "climbing-steps";        // all dealers EXCEPT Mobility City
const STRONGBACK = "strongback-mobility";   // Exclusive Territory (below)
const OVATION    = "ovation-medical";       // per-account flag
const NOT_REPRESENTED = new Set(["complete-medical-supplies"]);
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
function computeAccess(gov, ownedSlugs, grantedSlugs){
  const owned = new Set([...(ownedSlugs || [])].filter(s => s && !NOT_REPRESENTED.has(s)));
  const granted = [...(grantedSlugs || [])].filter(s => s && !NOT_REPRESENTED.has(s) && !GOLDEN_SLUGS.has(s));
  const st = String(gov.state || "").toUpperCase();
  const name = gov.business_name || "";

  let eligible;
  if (granted.length) {
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
  NOT_REPRESENTED.forEach(s => eligible.delete(s));
  GOLDEN_SLUGS.forEach(s => eligible.delete(s));   // Golden is never an inline orderable line

  const your_accounts = [...eligible].filter(s => owned.has(s)).sort();
  const available     = [...eligible].filter(s => !owned.has(s)).sort();

  // Golden status: a dealer with a current Golden account stays "Account". Otherwise, every
  // Kentucky dealer is treated as a Golden PROSPECT (HCPS actively develops Golden across KY),
  // so Golden shows as an approved territory line for them. Elsewhere, use the stored status.
  let golden = gov.golden_status || "None";
  if (golden !== "Account" && st === "KY") golden = "Prospect";

  return {
    your_accounts,
    available,
    golden,
    ovation: !!gov.ovation_access,
  };
}

module.exports = { computeAccess, inExclusiveTerritory, isMobilityCity, ALL_DEALERS, STATE_RULES };

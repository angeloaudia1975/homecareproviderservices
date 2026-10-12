/* Ship-To branch resolution — ONE resolver for the report importers (CLAUDE.md §18, Ship-To Correction & Branch
   Assignment, agreed 2026-10-11). Given the candidate dealers for a report line (one dealer, or the members of a dealer
   family found by account number or name) and the line's ship-to evidence, it answers WHICH branch and WHY.

   Two modes:
     strict  — the automated path. Assigns only on reliable evidence; otherwise answers needs_review with the reason and
               the suggestions. It NEVER falls back to the headquarters or the first branch.
     legacy  — the existing manual import. Picks exactly what pickBranch() always picked (ZIP → city → ship-to name →
               HQ / first), so nothing a person already relies on changes — but labels every pick with its basis and
               flags the questionable ones (HQ fallback, a ZIP shared by two branches, a city / name guess) so the
               preview can show them.

   Reliable evidence, in order (strict):
     0. (Phase C) states are compared as codes ("Indiana" = IN); identity comes from makeMatcher, the Sales Report
        Import's own account-number / name rule
     1. a VERIFIED mapping for this manufacturer + account number + ship-to key (the ship-to id, or street + ZIP) —
        never an account number alone for a family with several branches
     1b. a ZIP → branch assignment saved in Commission Review (app_settings zipmap:<slug>, RULE 6), only inside the
        corporate it was saved for (strict only — the manual import's legacy picks never change)
     2. exactly one candidate (a dealer without branches)
     3. a ship-to ZIP that matches exactly ONE branch
     4. a normalised street address that matches exactly ONE branch
   Suggestions only (never assigned automatically): a unique city, a ship-to name equal to a branch name, the HQ.
   Corporate / drop-ship is an answer only when a verified mapping says so (scope "corporate").
   Pure functions: no database, no network. */
const SUF = /\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm = n => String(n || "").toUpperCase().replace(/HEALTH ?CARE/g, "HEALTHCARE").replace(/[.,'&/#-]/g, " ").replace(SUF, " ").replace(/\s+/g, " ").trim();
const znorm = z => { const m = String(z || "").match(/\d{5}/); return m ? m[0] : ""; };
const ABBR = { STREET: "ST", ST: "ST", AVENUE: "AVE", AVE: "AVE", ROAD: "RD", RD: "RD", DRIVE: "DR", DR: "DR", BOULEVARD: "BLVD", BLVD: "BLVD",
  LANE: "LN", LN: "LN", HIGHWAY: "HWY", HWY: "HWY", PARKWAY: "PKWY", PKWY: "PKWY", SUITE: "STE", STE: "STE", NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" };
const naddr = a => String(a || "").toUpperCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean).map(w => ABBR[w] || w).join(" ").trim();
const ncity = c => String(c || "").toUpperCase().replace(/[^A-Z ]/g, "").replace(/\s+/g, " ").trim();
const nref = r => String(r || "").trim().toLowerCase();
// US state: "Indiana" / "IN" / "in." → "IN" (manufacturer files spell states out; dealers hold the code).
const STATES = { ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE",
  "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS",
  KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS",
  MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA",
  "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY", "PUERTO RICO": "PR" };
const nstate = s => { const u = String(s || "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim(); return STATES[u] || u; };

// The ship-to key a verified mapping is remembered under: the manufacturer's own ship-to id when the report gives one,
// otherwise the delivery street + ZIP. Null when neither exists (nothing that narrow can be remembered).
function shipKey(row) {
  const id = String(row.ship_to_id || "").trim();
  if (id) return "id:" + id.toLowerCase();
  const a = naddr(row.ship_address), z = znorm(row.ship_zip);
  return a && z ? `addr:${a}|${z}` : null;
}

function resolveBranch(cands, row, opts) {
  opts = opts || {};
  const mode = opts.mode === "legacy" ? "legacy" : "strict";
  cands = (cands || []).filter(Boolean);
  const out = (dealer, basis, extra) => Object.assign({ dealer_id: dealer ? dealer.id : null, basis, review: false, questionable: false, suggestions: [] }, extra || {});
  if (!cands.length) return out(null, "unmatched");
  const ids = new Set(cands.map(d => d.id));
  // 1. A verified mapping (strict and legacy alike: a person already decided this one).
  const key = shipKey(row), ref = nref(row.account_ref);
  if (key && Array.isArray(opts.mappings)) {
    const hit = opts.mappings.find(m => !m.retired_at && nref(m.account_ref) === ref && m.ship_key === key && (m.scope === "corporate" || ids.has(m.dealer_id)));
    if (hit) {
      const d = cands.find(c => c.id === hit.dealer_id) || { id: hit.dealer_id };
      return out(d, hit.scope === "corporate" ? "corporate_confirmed" : "verified_mapping", { mapping_id: hit.id || null });
    }
  }
  // 1b. Strict only: a ZIP → branch assignment a person saved in Commission Review (app_settings zipmap:<slug>,
  //     RULE 6 — "ZIP is the master key"). One scoped to a corporate applies only inside that corporate's family;
  //     an unscoped one only to a dealer already among the candidates.
  if (mode === "strict" && opts.zipmap && typeof opts.zipmap === "object") {
    const z = znorm(row.ship_zip), ent = z ? opts.zipmap[z] : null;
    const d0 = ent && (typeof ent === "string" ? ent : ent.d), c0 = ent && typeof ent === "object" ? ent.c : null;
    if (d0) {
      const root = id => (typeof opts.rootOf === "function" ? opts.rootOf(id) : null) || id;
      const roots = new Set(cands.map(c => root(c.id)));
      if (c0 ? roots.has(c0) : ids.has(d0)) return out(cands.find(c => c.id === d0) || { id: d0 }, "zip_assignment");
    }
  }
  // 2. One candidate.
  if (cands.length === 1) return out(cands[0], "single");
  const zip = znorm(row.ship_zip), addr = naddr(row.ship_address), city = ncity(row.ship_city), name = dnorm(row.ship_name);
  const zipHits = zip ? cands.filter(d => znorm(d.zip) === zip) : [];
  const addrHits = addr ? cands.filter(d => naddr(d.address) === addr) : [];
  const cityHits = city ? cands.filter(d => ncity(d.city) === city && (!row.ship_state || !d.state || nstate(d.state) === nstate(row.ship_state))) : [];
  const nameHits = name ? cands.filter(d => dnorm(d.business_name) === name) : [];
  const hq = cands.find(d => !d.parent_id) || null;
  const sugg = [];
  const add = (list, basis) => { for (const d of list) if (!sugg.some(s => s.dealer_id === d.id)) sugg.push({ dealer_id: d.id, name: d.business_name || null, basis }); };
  add(zipHits, "zip"); add(addrHits, "address"); add(cityHits, "city"); add(nameHits, "ship_name");

  if (mode === "legacy") {
    // Exactly the old pickBranch order and choice; only the labels are new.
    let d = zipHits[0];
    if (d) return out(d, zipHits.length === 1 ? "zip" : "zip_shared", { questionable: zipHits.length > 1, suggestions: zipHits.length > 1 ? sugg : [] });
    const c0 = dnorm(row.ship_city);                      // the old matcher compared cities with dnorm — kept exactly
    d = c0 && cands.find(c => dnorm(c.city) === c0);
    if (d) return out(d, "city", { questionable: true, suggestions: sugg });
    d = name && cands.find(c => dnorm(c.business_name) === name);
    if (d) return out(d, "ship_name", { questionable: true, suggestions: sugg });
    if (hq) add([hq], "hq");
    return out(hq || cands[0], hq ? "hq_fallback" : "first_fallback", { questionable: true, suggestions: sugg });
  }
  // 3 / 4. Strict: a unique ZIP, then a unique street address.
  if (zipHits.length === 1) return out(zipHits[0], "zip");
  if (zipHits.length > 1) return out(null, null, { review: true, reason: "zip_shared", suggestions: sugg });
  if (addrHits.length === 1) return out(addrHits[0], "address");
  if (hq) add([hq], "hq");
  const noShip = !zip && !addr && !city && !name && !String(row.ship_to_id || "").trim();
  const billingOnly = noShip && (row.bill_zip || row.bill_address);
  return out(null, null, { review: true, suggestions: sugg,
    reason: billingOnly ? "billing_address_only" : noShip ? "no_ship_to" : (zip || addr) ? "new_location" : "weak_evidence" });
}

// Who the report line is: the dealer family found by account number (per manufacturer) or by name / alias — EXACTLY
// the Sales Report Import's rule (sales-import-api buildResolver uses this same function): number first, then name;
// a reused-number manufacturer (NAME_FIRST) name first. One account hit expands to its whole family so the branch
// can be chosen; several hits stay as they are. Pure: built from rows the caller read.
function makeMatcher(p) {
  const dealers = p.dealers || [], byId = new Map();
  for (const d of dealers) byId.set(d.id, d);
  const rootOf = id => { const d = byId.get(id); return (d && d.parent_id) ? d.parent_id : id; };
  const familyByRoot = new Map();
  for (const d of dealers) { const r = rootOf(d.id); (familyByRoot.get(r) || familyByRoot.set(r, []).get(r)).push(d); }
  const refToIds = new Map();
  for (const x of (p.accounts || [])) { const k = nref(x.account_ref); if (!k) continue; (refToIds.get(k) || refToIds.set(k, []).get(k)).push(x.dealer_id); }
  const norm2id = new Map(); for (const d of dealers) norm2id.set(dnorm(d.business_name), d.id);
  for (const a of (p.aliases || [])) { if (a && a.alias_norm && !norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm, a.dealer_id); }
  const family = id => familyByRoot.get(rootOf(id)) || [byId.get(id)].filter(Boolean);
  const byName = row => { if (!row.company) return null; const id = norm2id.get(dnorm(row.company)); return id ? family(id) : null; };
  const byRef = row => { const ref = nref(row.account_ref);
    if (ref && refToIds.has(ref)) { const cands = refToIds.get(ref).map(i => byId.get(i)).filter(Boolean); return cands.length === 1 ? family(cands[0].id) : cands; }
    return null; };
  const candidates = row => (p.nameFirst ? (byName(row) || byRef(row)) : (byRef(row) || byName(row))) || [];
  return { candidates, byId, rootOf, family };
}

module.exports = { resolveBranch, makeMatcher, shipKey, _internal: { dnorm, znorm, naddr, ncity, nstate, nref } };

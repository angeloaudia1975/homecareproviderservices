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
     1. a VERIFIED mapping for this manufacturer + account number + ship-to key (the ship-to id, or street + ZIP) —
        never an account number alone for a family with several branches
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
  // 2. One candidate.
  if (cands.length === 1) return out(cands[0], "single");
  const zip = znorm(row.ship_zip), addr = naddr(row.ship_address), city = ncity(row.ship_city), name = dnorm(row.ship_name);
  const zipHits = zip ? cands.filter(d => znorm(d.zip) === zip) : [];
  const addrHits = addr ? cands.filter(d => naddr(d.address) === addr) : [];
  const cityHits = city ? cands.filter(d => ncity(d.city) === city && (!row.ship_state || !d.state || String(d.state).toUpperCase() === String(row.ship_state).toUpperCase())) : [];
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

module.exports = { resolveBranch, shipKey, _internal: { dnorm, znorm, naddr, ncity } };

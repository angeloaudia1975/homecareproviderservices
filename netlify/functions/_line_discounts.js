/* A DEALER'S LINE DISCOUNT (owner policy, Angelo 2026-10-27; first line: Access4U).

   A line that prints a STANDARD dealer list (the product's `dealer_price`) prices each dealer at that list less the
   dealer's own discount for the line — 10, 15, 20 or another approved rate. New dealers have no row and pay the line's
   default purchase price (`base_price`, which already IS the default discount, 15% on Access4U). Only the purchase
   price moves; MSRP and MAP are never read or written here. A per-SKU contract price is an absolute override that the
   engine checks FIRST, so a rate is never stacked on it.

   Rows live in dealer_line_discounts (supabase/dealer_line_discounts.sql, RULE 19: RLS on, no policies, service role
   only). The master account's rate applies to its branches; a branch's own row overrides it — the contract-price rule.

   Reads are strict: any failure throws (the caller treats the dealer's prices as unknown), EXCEPT a table that does
   not exist yet, which can only mean no rate was ever set (before the migration is run). */
const RATE_MIN = 0, RATE_MAX = 100;
const MISSING = /PGRST205|42P01|does not exist|Could not find the table/i;
function validRate(v) {
  if (v === null || v === undefined || v === "") return false;
  const n = Number(v);
  return isFinite(n) && n > RATE_MIN && n < RATE_MAX && Math.round(n * 100) === n * 100;
}
/* The purchase price at a rate, from the list in cents (628 at 15% = 533.80 exactly). */
function ratePrice(list, rate) {
  const l = Number(list), r = Number(rate);
  if (!isFinite(l) || l <= 0 || !validRate(r)) return null;
  return Math.round(Number((l * (100 - r)).toFixed(6))) / 100;
}
/* sb(method, path) → rows (throws on error). Returns { "slug": pct } for the dealer (branch over master). */
async function lineRates(sb, dealerId, parentId) {
  const rates = {};
  if (!dealerId) return rates;
  const ids = [dealerId]; if (parentId && parentId !== dealerId) ids.push(parentId);
  let rows;
  try { rows = await sb("GET", `dealer_line_discounts?dealer_id=in.(${ids.join(",")})&active=eq.true&select=dealer_id,manufacturer,discount_pct`); }
  catch (e) { if (MISSING.test(String((e && e.message) || e))) return rates; throw e; }
  if (!Array.isArray(rows)) throw new Error("line discounts: unexpected response");
  rows.slice().sort((a, b) => (a.dealer_id === dealerId ? 1 : 0) - (b.dealer_id === dealerId ? 1 : 0))
    .forEach(r => { if (r && r.manufacturer && validRate(r.discount_pct)) rates[r.manufacturer] = Number(r.discount_pct); });
  return rates;
}
module.exports = { lineRates, ratePrice, validRate, MISSING };

/* NEW MANUFACTURER ACCOUNT NOTICE (owner, C3-06 2026-11-05).
   A dealer may shop and order a new line before it has that manufacturer's account (Yuwell: every dealer may order;
   the account is opened after the dealer application). The order is NEVER blocked for it — HCPS is told instead:
   "New Yuwell Manufacturer Account Required" on the dealer's confirmation, the HCPS intake email and Order Review.
   "Has an account" = the dealer's own active dealer_manufacturers row carries an account number — the same test
   dealer-auth uses for "Your accounts" vs "Available to you". */
const NOTICE_LINES = { yuwell: "Yuwell" };

function noticeFor(slug, name) {
  if (!Object.prototype.hasOwnProperty.call(NOTICE_LINES, slug)) return null;
  return `New ${name || NOTICE_LINES[slug]} Manufacturer Account Required`;
}

/* rows: dealer_manufacturers rows {dealer_id, manufacturer, account_ref, active}. Returns the slugs (of `slugs`) for
   which this dealer has NO account number. */
function missingAccounts(rows, dealerId, slugs) {
  const has = new Set((rows || []).filter(r => r && String(r.dealer_id) === String(dealerId) && r.active !== false
    && String(r.account_ref == null ? "" : r.account_ref).trim()).map(r => String(r.manufacturer)));
  return (slugs || []).filter(s => Object.prototype.hasOwnProperty.call(NOTICE_LINES, s) && !has.has(s));
}

/* Read the rows for the dealers/lines that can carry a notice. A read that fails is reported as `unknown` — the order
   still stands and HCPS is asked to check the account by hand (never a silent "has an account"). */
async function readRows(sb, dealerIds) {
  const ids = [...new Set((dealerIds || []).filter(Boolean).map(String))];
  const lines = Object.keys(NOTICE_LINES);
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map(encodeURIComponent).join(",");
    const rows = await sb("GET", `dealer_manufacturers?dealer_id=in.(${chunk})&manufacturer=in.(${lines.join(",")})&select=dealer_id,manufacturer,account_ref,active`);
    out.push(...(rows || []));
  }
  return out;
}

module.exports = { NOTICE_LINES, noticeFor, missingAccounts, readRows };

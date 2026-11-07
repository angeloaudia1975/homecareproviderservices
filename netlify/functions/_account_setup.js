/* PENDING MANUFACTURER ACCOUNT SETUP (owner directive 2026-11-06 17:40 CT).
   Ordering authorization (Dealer Manager) and manufacturer account setup are separate facts. A dealer approved for a line may
   always shop it and submit an order; when HCPS has no manufacturer account identifier on file for that line — on the
   ordering location or its head office (identifiers are organization-level) — the order is RECORDED and held as
   "pending_account_setup": HCPS reviews the dealer's application and opens the account, then releases the same order (no
   re-entry). It is never sent to a manufacturer before that. Any recorded identifier (number, name, username) counts —
   whether or not HCPS has marked it verified, and whether or not a manufacturer report has confirmed it. Golden orders are
   placed with Golden and never held here. Strict: a read that fails throws — the caller holds the order (fail closed). */
'use strict';
const GOLDEN = new Set(['golden', 'golden-technologies']);
const STATUS = 'pending_account_setup';
const LABEL = 'Pending Manufacturer Account Setup';
const enc = encodeURIComponent;

/* slugs (non-Golden) of `slugs` for which neither the dealer nor its head office has an identifier on file */
async function missingIdentifiers(sb, dealerId, slugs) {
  const want = [...new Set((slugs || []).map(String).filter((s) => s && !GOLDEN.has(s)))];
  if (!want.length) return [];
  const d = await sb('GET', `dealers?id=eq.${enc(dealerId)}&select=id,parent_id`);
  const ids = [String(dealerId)]; if (d && d[0] && d[0].parent_id) ids.push(String(d[0].parent_id));
  const rows = await sb('GET', `dealer_manufacturers?dealer_id=in.(${ids.map(enc).join(',')})&manufacturer=in.(${want.map(enc).join(',')})&select=dealer_id,manufacturer,account_ref`);
  if (!Array.isArray(rows)) throw new Error('account identifiers: unexpected response');
  const has = new Set(rows.filter((r) => String(r.account_ref == null ? '' : r.account_ref).trim()).map((r) => String(r.manufacturer)));
  return want.filter((s) => !has.has(s));
}
function holdMessage(name) {
  return `${LABEL}: HCPS needs a ${name || 'manufacturer'} account for your business before this order can be placed. Your order is saved — complete the ${name || 'manufacturer'} application in the Account Setup Center and HCPS will release it once the account is open. Prices are pending confirmation until then.`;
}
/* the identifiers could not be read: the order is held all the same (fail closed) and says why */
function uncheckedMessage(name) {
  return `${LABEL}: HCPS could not confirm your ${name || 'manufacturer'} account just now, so this order is saved and held until HCPS checks it. Nothing else is needed from you unless HCPS asks for an application. Prices are pending confirmation until then.`;
}
module.exports = { STATUS, LABEL, missingIdentifiers, holdMessage, uncheckedMessage, GOLDEN };

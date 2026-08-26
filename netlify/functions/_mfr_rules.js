// ============================================================================
// Shared importer rules — one source of truth for both the Sales Report importer
// (sales-import-api.js) and the Commission importer (commissions-api.js).
//
// NAME_FIRST: manufacturers whose customer/account NUMBERS are reused across
// DIFFERENT dealers (e.g. PediFix — a single number can belong to two separate
// Quipt-owned dealers). For these, a report line is resolved to a dealer by NAME
// first, then by number, so a shared number can never misroute the sale.
//
// STANDARD RULE (applies to every manufacturer): when a report carries a reliable
// dealer account number, the importer captures it onto the matched dealer's
// manufacturer relationship — setting it when blank, confirming it when it matches,
// and FLAGGING (never silently overwriting) when it differs. See
// _accountorg.reconcileAccountRef. To exclude a manufacturer whose "number" is not a
// real account identifier (e.g. an order number), add its slug to NO_ACCOUNT_CAPTURE.
// ============================================================================
const NAME_FIRST = new Set(["pedifix"]);
const NO_ACCOUNT_CAPTURE = new Set([]);   // slugs whose report "number" is NOT a dealer account #

module.exports = { NAME_FIRST, NO_ACCOUNT_CAPTURE };

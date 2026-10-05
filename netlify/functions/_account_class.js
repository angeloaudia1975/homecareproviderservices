// Account class (Phase 2, add-on approved 2026-10-05) — what kind of account a dealer record is, set by
// President/Admin only (dealers-api set_account_class). It decides ONE thing: whether the account can
// raise Morning Brief relationship signals. It never changes ownership, rep scope, permissions,
// Dealer 360 visibility, or anything else about the account. Existing records stay blank, and blank
// is eligible, so nothing drops out of the brief until someone classifies it on purpose. Nothing is
// ever inferred from the company name.
const CLASSES = ["dealer", "prospect", "manufacturer", "vendor", "service_provider", "internal", "other", "not_relevant"];
const LABELS = { dealer: "Dealer", prospect: "Prospect", manufacturer: "Manufacturer", vendor: "Vendor / supplier",
  service_provider: "Service provider", internal: "Internal", other: "Other", not_relevant: "Not relevant" };
// No relationship signals for these. Blank, dealer, prospect and other stay eligible.
const SIGNAL_EXCLUDED = ["manufacturer", "vendor", "service_provider", "internal", "not_relevant"];
const isClass = v => CLASSES.includes(v);
const signalEligible = v => !v || !SIGNAL_EXCLUDED.includes(String(v));
module.exports = { CLASSES, LABELS, SIGNAL_EXCLUDED, isClass, signalEligible };

/* RETIRED MANUFACTURER LINES (owner decisions; one list, read by every gate on this site).

   A retired line is never listed, never priced and never ordered — whoever asks, whatever they are entitled to.
   This is deliberately separate from entitlements: the database keeps every historical dealer_manufacturers row
   (account numbers, active flags) untouched, so a dealer whose row still says "ohio-medical" must not be able to
   reach Ohio Medical just because a catalog file or a manufacturers.json entry reappears under either identifier.

   Both spellings of a retired line are listed (the storefront's legacy "gce" and the database's canonical
   "ohio-medical"), so correcting the identifier on either side can never re-open the line. Removing a line
   from here is the ONLY way back, and needs the owner's explicit decision.

   The same list lives in the ordering site (homecareproviderservicesordering/netlify/functions/_retired_lines.js);
   test/retired-lines.test.js in each repo checks the two are identical. */
"use strict";

const RETIRED_LINES = Object.freeze({
  "complete-medical-supplies": "Complete Medical Supplies is no longer an HCPS partner (owner, 2026-10-23).",
  "ohio-medical": "Ohio Medical / GCE is no longer an HCPS partner; Yuwell replaces it (owner, 2026-11-04).",
  "gce": "Ohio Medical / GCE is no longer an HCPS partner; Yuwell replaces it (owner, 2026-11-04).",
});

function norm(slug) { return String(slug == null ? "" : slug).trim().toLowerCase(); }
function isRetiredLine(slug) { return Object.prototype.hasOwnProperty.call(RETIRED_LINES, norm(slug)); }
function retiredReason(slug) { return isRetiredLine(slug) ? RETIRED_LINES[norm(slug)] : null; }

module.exports = { RETIRED_LINES, isRetiredLine, retiredReason };

// NEUTRALIZED — the Dealer Resource Library is now sourced ENTIRELY from
// src/_data/documents.json, which is the admin-managed single source of record.
//
// This file previously seeded ~73 generic placeholder documents. Because Eleventy
// deep-merges every data file that shares the `documents` basename, those seeds
// were concatenated onto the 46 real admin records (46 + 73 = 119 cards) and every
// card fell back to the first manufacturer in the list. Emptying this export ends
// that collision so the page renders exactly the 46 real records from the JSON.
//
// Do NOT re-add seed data here. Add or edit documents in the admin tool (which
// writes documents.json). Manufacturer identity + product category are resolved
// centrally from manufacturers.json via the `manuById` / `resourceCat` filters.
module.exports = {};

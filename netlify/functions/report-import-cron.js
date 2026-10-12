// MI Phase E — hourly automatic import of registered Strongback order exports (Angelo, 2026-10-12 18:40 CT).
// Does NOTHING unless app_settings.phase2_flags.mi_auto_import is exactly true AND supabase/mi_e_auto_import.sql is
// installed. Only manufacturers ENROLLED in MI-1a for sales reports (today: Strongback). A report is imported only when
// every check passes on the fresh, strict path (Ship-To, corrections, MI-1a dry run, duplicates, quarantine, lanes);
// anything else is logged once and waits for the President (Ship-To Review → Import check). See shipto-review-api.js.
const { runAutoImport } = require("./shipto-review-api.js");
exports.handler = async () => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) return { statusCode: 200, body: JSON.stringify({ skipped: "not configured" }) };
    return { statusCode: 200, body: JSON.stringify(await runAutoImport()) };
  } catch (e) { return { statusCode: 500, body: String((e && e.message) || e).slice(0, 500) }; }
};

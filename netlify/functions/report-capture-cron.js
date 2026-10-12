// MI Inbox Automation, Phase B — hourly capture of manufacturer report email into Report History (see _report_capture.js).
// Does NOTHING unless app_settings.phase2_flags.mi_report_capture is exactly true (the database checks it again on
// every write). Registers files only: no import, no acceptance, no publication, no email sent.
const { flagOn } = require("./_flags.js");
const { runCapture, liveDeps } = require("./_report_capture.js");
exports.handler = async () => {
  const env = process.env;
  try {
    if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID || !env.GRAPH_CLIENT_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE)
      return { statusCode: 200, body: JSON.stringify({ skipped: "not configured" }) };
    const deps = liveDeps(env);
    if (!(await flagOn(p => deps.db.get(p), "mi_report_capture"))) return { statusCode: 200, body: JSON.stringify({ skipped: "switch_off" }) };
    const boxes = await deps.db.get("mfr_report_capture_state?select=mailbox&order=mailbox");
    const internal = [...new Set(String(env.GRAPH_MAILBOXES || "").split(/[,\s]+/).map(s => s.trim().toLowerCase().split("@")[1]).filter(Boolean))];
    const out = [];
    for (const b of boxes || []) out.push(await runCapture({ mailbox: b.mailbox, budget_ms: 22000 / Math.max(1, boxes.length), internal_domains: internal }, deps));
    return { statusCode: 200, body: JSON.stringify({ ran: true, runs: out }) };
  } catch (e) { return { statusCode: 500, body: String((e && e.message) || e).slice(0, 500) }; }
};

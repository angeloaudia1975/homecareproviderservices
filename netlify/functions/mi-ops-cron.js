// MI — hourly operations at :50 (after capture :20 and the automatic import :40), in its own invocation so neither part
// competes with the import for the scheduled-function time limit:
//   1. dealer intelligence: registered dealer reports imported + published (mfr-intel-api.js runAutoIntel; switch
//      mi_intel_publish), Dealer 360 showing only verified matches;
//   2. notifications to Angelo (_mi_notify.js): the hour's activity (only when something happened), the daily digest and
//      the monthly reconciliation on the 15th. Mail goes through the existing Microsoft Graph app (GRAPH_* env), from
//      GRAPH_SENDER to MI_NOTIFY_TO (default angelo@homecareproviderservices.us).
const N = require("./_mi_notify.js");
const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const G_TENANT = process.env.GRAPH_TENANT_ID, G_CLIENT = process.env.GRAPH_CLIENT_ID, G_SECRET = process.env.GRAPH_CLIENT_SECRET;
const FROM = process.env.GRAPH_SENDER || "angelo@homecareproviderservices.us";
const TO = process.env.MI_NOTIFY_TO || "angelo@homecareproviderservices.us";
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
async function sbGet(p) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H() }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json(); }
async function sbGetAll(base, order) {
  const PAGE = 1000; let from = 0, out = [];
  for (;;) { const sep = base.includes("?") ? "&" : "?"; const rows = await sbGet(`${base}${sep}order=${order}&limit=${PAGE}&offset=${from}`);
    out = out.concat(rows); if (rows.length < PAGE) return out; from += PAGE; }
}
async function saveState(value) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, { method: "POST",
    headers: { ...H(), "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "mi_notify_state", value, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error(`state not saved: ${r.status} ${(await r.text()).slice(0, 200)}`);
}
let _tok = null;
async function graphToken() {
  if (_tok) return _tok;
  const body = new URLSearchParams({ client_id: G_CLIENT, client_secret: G_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetch(`https://login.microsoftonline.com/${G_TENANT}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error("graph_token: " + ((j && j.error_description) || r.status));
  return (_tok = j.access_token);
}
async function sendMail({ to, subject, html }) {
  const tok = await graphToken();
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM)}/sendMail`, { method: "POST",
    headers: { Authorization: "Bearer " + tok, "content-type": "application/json" },
    body: JSON.stringify({ message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }) });
  return r.ok;
}
function notifier() {
  return N.make({ sbGet, sbGetAll, saveState, sendMail, to: TO, dashboard: () => require("./mfr-reports-api.js").dashboardData({}) });
}

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE) return { statusCode: 200, body: JSON.stringify({ skipped: "not configured" }) };
  const out = {};
  try { out.dealer_intelligence = await require("./mfr-intel-api.js").runAutoIntel(); }
  catch (e) { out.dealer_intelligence = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
  try { const r = await notifier().run(); out.notifications = { ok: r.ok, sent: r.sent, error: r.error, counts: r.counts }; }
  catch (e) { out.notifications = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
  console.log("mi-ops-cron " + JSON.stringify({ intel: out.dealer_intelligence && { ok: out.dealer_intelligence.ok, published: out.dealer_intelligence.published, held: out.dealer_intelligence.held, skipped: out.dealer_intelligence.skipped }, notifications: out.notifications }));
  return { statusCode: 200, body: JSON.stringify(out) };
};
exports.notifier = notifier;

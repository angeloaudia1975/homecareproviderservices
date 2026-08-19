// HCPS Dealer Hub — service & scheduling request intake (public, no auth, like the contact form).
// A dealer picks a service (training, consultation, technical support, showroom review…), remote or
// in-person, and a preferred date/time. We record the request DURABLY in service_requests so it
// becomes a trackable Dealer 360 touch point, then best-effort notify the HCPS team. The admin
// scheduling console then assigns a rep, creates the Outlook (Graph) event + Zoho task, links the
// dealer, and moves the request through scheduled → completed → follow-up.
//
//   POST { action:"request", service, service_key?, mode?, preferred_date?, preferred_time?,
//          alt_date?, company, name, email, phone?, state?, manufacturer?, notes?, company_website? }
//     -> { ok, id, message }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const G_TENANT = process.env.GRAPH_TENANT_ID, G_CLIENT = process.env.GRAPH_CLIENT_ID, G_SECRET = process.env.GRAPH_CLIENT_SECRET;
const NOTIFY_TO = process.env.SCHEDULE_NOTIFY_TO || process.env.CONTACT_NOTIFY_TO || "info@homecareproviderservices.us";
const NOTIFY_FROM = process.env.GRAPH_SENDER || "angelo@homecareproviderservices.us";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (s, n) => { s = String(s == null ? "" : s).trim(); return s ? s.slice(0, n || 500) : null; };
const dateOr = v => { const s = String(v || "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function sbInsert(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/service_requests`, { method: "POST", headers: { ...H(), "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const j = await r.json().catch(() => null);
  return j && j[0];
}

async function graphToken() {
  const body = new URLSearchParams({ client_id: G_CLIENT, client_secret: G_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetch(`https://login.microsoftonline.com/${G_TENANT}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("graph token " + r.status);
  return (await r.json()).access_token;
}
// Best-effort internal notification — never blocks the request if Graph isn't configured.
async function notify(req) {
  if (!G_TENANT || !G_CLIENT || !G_SECRET) return;
  const rows = [["Service", req.service], ["Mode", req.mode], ["Preferred date", req.preferred_date], ["Preferred time", req.preferred_time],
    ["Alternate date", req.alt_date], ["Company", req.company], ["Contact", req.contact_name], ["Email", req.email], ["Phone", req.phone],
    ["State", req.state], ["Manufacturer", req.manufacturer]].filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#6b7280;font-size:13px">${esc(k)}</td><td style="padding:3px 0;font-weight:600;font-size:13px">${esc(v)}</td></tr>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
    <h2 style="color:#2B4071;margin:0 0 4px">New Dealer Hub service request</h2>
    <p style="color:#5b6672;font-size:13px;margin:0 0 12px">A dealer requested a service/appointment from the Dealer Hub.</p>
    <table style="border-collapse:collapse;margin:0 0 14px">${rows}</table>
    ${req.notes ? `<p style="font-size:13px"><b>Notes:</b> ${esc(req.notes)}</p>` : ""}
    <p style="color:#9aa4ae;font-size:11px;margin:14px 0 0">Request ${esc(req.id)} · assign a rep and schedule in the HCPS console.</p></div>`;
  const msg = { message: { subject: `Dealer Hub: ${req.service} — ${req.company || req.contact_name || "request"}`,
    body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: NOTIFY_TO } }],
    replyTo: req.email && EMAIL_RE.test(req.email) ? [{ emailAddress: { address: req.email } }] : undefined }, saveToSentItems: false };
  try {
    const tok = await graphToken();
    await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(NOTIFY_FROM)}/sendMail`, { method: "POST", headers: { Authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(msg) });
  } catch (e) { /* non-fatal */ }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "Scheduling isn't configured yet." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad JSON" }); }
  if (b.company_website) return json(200, { ok: true });   // honeypot: silently accept + drop

  const service = clip(b.service, 120);
  const company = clip(b.company, 160);
  const name = clip(b.name || b.contact_name, 120);
  const email = clip(b.email, 160);
  if (!service) return json(400, { error: "Please choose a service." });
  if (!company || !name || !email || !EMAIL_RE.test(email)) return json(400, { error: "Please provide company, contact name, and a valid email." });

  const row = {
    service, service_key: clip(b.service_key, 60),
    mode: (b.mode === "remote" || b.mode === "in_person") ? b.mode : null,
    preferred_date: dateOr(b.preferred_date), preferred_time: clip(b.preferred_time, 40), alt_date: dateOr(b.alt_date),
    company, contact_name: name, email, phone: clip(b.phone, 40), state: clip(b.state, 24),
    manufacturer: clip(b.manufacturer, 120), notes: clip(b.notes, 2000),
    status: "requested", source: "dealer-hub",
  };
  let saved;
  try { saved = await sbInsert(row); }
  catch (e) {
    if (/relation|does not exist|service_requests/i.test(String(e.message || e))) return json(200, { ok: false, error: "tables_missing", message: "Scheduling isn't switched on yet — run supabase/service_requests.sql." });
    return json(500, { error: "Couldn't save your request. Please email " + NOTIFY_TO + "." });
  }
  await notify({ ...row, id: saved && saved.id });
  return json(200, { ok: true, id: saved && saved.id,
    message: "Request received. A HCPS representative will confirm your appointment and send a calendar invite shortly." });
};

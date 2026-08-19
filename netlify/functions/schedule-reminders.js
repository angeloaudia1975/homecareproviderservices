// HCPS Dealer Hub — automatic appointment reminders (Netlify scheduled function; see netlify.toml).
// Runs hourly. For every SCHEDULED service request with a real appointment instant (calendar.start_utc),
// it emails the dealer (cc the assigned rep) a day-before and a same-day reminder — each sent at most
// once, tracked in the service_requests.reminders jsonb, so re-runs never double-send. Best-effort and
// self-gating: does nothing unless GRAPH_* is configured. Turn off with SCHEDULE_REMINDERS=off.
//
// Tiers (hours before start):  "24h" fires ~22–26h out · "2h" fires ~0–3h out.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const G_TENANT = process.env.GRAPH_TENANT_ID, G_CLIENT = process.env.GRAPH_CLIENT_ID, G_SECRET = process.env.GRAPH_CLIENT_SECRET;
const NOTIFY_FROM = process.env.GRAPH_SENDER || "angelo@homecareproviderservices.us";
const REPLY_TO = process.env.SCHEDULE_NOTIFY_TO || process.env.CONTACT_NOTIFY_TO || "info@homecareproviderservices.us";

const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const ok = o => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

async function sbGet(path) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbPatch(path, body) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...H(), "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); }

async function graphToken() {
  const body = new URLSearchParams({ client_id: G_CLIENT, client_secret: G_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetch(`https://login.microsoftonline.com/${G_TENANT}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error("graph_token:" + ((j && j.error_description) || r.status)); return j.access_token;
}
async function sendMail(tok, { to, cc, subject, html }) {
  const msg = { message: { subject, body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }],
    ccRecipients: (cc && EMAIL_RE.test(cc)) ? [{ emailAddress: { address: cc } }] : undefined,
    replyTo: EMAIL_RE.test(REPLY_TO) ? [{ emailAddress: { address: REPLY_TO } }] : undefined }, saveToSentItems: false };
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(NOTIFY_FROM)}/sendMail`, { method: "POST", headers: { Authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(msg) });
  return r.ok;
}

function reminderHtml(req, tier) {
  const when = (req.calendar && req.calendar.when_text) || (req.preferred_date + (req.preferred_time ? " · " + req.preferred_time : ""));
  const lead = tier === "24h" ? "This is a friendly reminder of your appointment with HomeCare Provider Services tomorrow." : "Your appointment with HomeCare Provider Services is coming up shortly.";
  const modeTxt = req.mode === "remote" ? "Remote / virtual" : req.mode === "in_person" ? "In person" : "";
  const rows = [["Service", req.service], ["When", when], ["Format", modeTxt], ["Your HCPS rep", req.rep_name]].filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-size:13px">${esc(k)}</td><td style="padding:3px 0;font-weight:700;font-size:13px;color:#1b2733">${esc(v)}</td></tr>`).join("");
  return `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
    <h2 style="color:#2B4071;margin:0 0 6px">Appointment reminder</h2>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 12px">${lead}</p>
    <table style="border-collapse:collapse;margin:0 0 14px">${rows}</table>
    ${req.calendar && req.calendar.web_link ? `<p style="font-size:12.5px;margin:0 0 12px">A calendar invite was sent when we booked this — it's on your calendar.</p>` : ""}
    <p style="font-size:12.5px;line-height:1.6;color:#6b7280;margin:0">Need to reschedule or have a question? Just reply to this email and we'll take care of it.</p>
    <p style="font-size:12px;color:#9aa4ae;margin:14px 0 0">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.</p></div>`;
}

exports.handler = async () => {
  try {
    if (String(process.env.SCHEDULE_REMINDERS || "").toLowerCase() === "off") return ok({ skipped: "reminders off" });
    if (!SUPABASE_URL || !SERVICE_ROLE) return ok({ skipped: "supabase env not set" });
    if (!G_TENANT || !G_CLIENT || !G_SECRET) return ok({ skipped: "graph env not set" });

    let rows;
    try { rows = await sbGet(`service_requests?status=eq.scheduled&select=id,service,mode,rep_name,email,contact_name,company,preferred_date,preferred_time,calendar,reminders&limit=1000`); }
    catch (e) { if (/relation|does not exist|service_requests/i.test(String(e.message || e))) return ok({ skipped: "table missing" }); throw e; }

    const now = Date.now();
    let sent24 = 0, sent2 = 0, checked = 0;
    let tok = null;
    for (const r of rows || []) {
      const startUtc = r.calendar && r.calendar.start_utc; if (!startUtc) continue;
      const startMs = Date.parse(startUtc); if (isNaN(startMs)) continue;
      const hrs = (startMs - now) / 3600000;
      if (hrs < -1) continue;   // already past
      checked++;
      const done = (r.reminders && typeof r.reminders === "object") ? { ...r.reminders } : {};
      let tier = null;
      if (hrs > 2 && hrs <= 26 && !done["24h"]) tier = "24h";
      else if (hrs > -1 && hrs <= 3 && !done["2h"]) tier = "2h";
      if (!tier) continue;
      const to = r.email; if (!to || !EMAIL_RE.test(to)) continue;
      if (!tok) tok = await graphToken();
      let good = false;
      try { good = await sendMail(tok, { to, cc: r.calendar && r.calendar.mailbox, subject: `Reminder: ${r.service} with HCPS${r.calendar && r.calendar.when_text ? " — " + r.calendar.when_text : ""}`, html: reminderHtml(r, tier) }); } catch (e) {}
      if (good) {
        done[tier] = new Date().toISOString();
        try { await sbPatch(`service_requests?id=eq.${encodeURIComponent(r.id)}`, { reminders: done, updated_at: new Date().toISOString() }); } catch (e) {}
        if (tier === "24h") sent24++; else sent2++;
      }
    }
    return ok({ ran: true, checked, sent_day_before: sent24, sent_same_day: sent2 });
  } catch (e) { return { statusCode: 500, body: String(e && e.message || e) }; }
};

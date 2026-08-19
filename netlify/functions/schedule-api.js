// HCPS Dealer Hub — scheduling engine: PUBLIC self-booking (verified dealers) + ADMIN console (staff auth).
//
// Self-booking: a KNOWN dealer (email matches our records) picks a meeting type, we detect their time zone,
// show only open 30-minute slots (windows minus blocked dates, existing bookings, and the rep's busy time),
// and on selection we book instantly — create the Outlook event on the assigned rep's calendar, invite the
// dealer, email both a confirmation, record it in Dealer 360, tie it to the dealer/contact/rep, and let the
// hourly reminder cron send the 24-hour reminder. Availability is configurable per meeting type:
//   • online  — fixed Central hours + a Zoom link
//   • field   — on-site, in the DEALER's local time zone
// Double-booking is prevented by a partial unique index on (owner_email, start_at) plus a live slot re-check.
//
//   -- PUBLIC (no staff auth) --
//   POST { action:"verify_dealer", email }                          -> { ok, matched, dealer_id, company, contact_name, rep_display }
//   POST { action:"slots", email, meeting_type, tz?, days? }        -> { ok, meeting_type, tz, location_type, zoom_link, rep_display, days:[{date,dayname,slots:[{label,start_utc}]}] }
//   POST { action:"book", email, meeting_type, start_utc, name, company?, phone?, notes?, tz? } -> { ok, id, when_text, zoom_link, message }
//   POST { action:"request", ... }                                  -> { ok, id, message }   (legacy preferred-time request)
//
//   -- ADMIN (staff Bearer token) --
//   queue · assign · complete · cancel · reopen · set_dealer · search_dealers · get_availability · set_availability · upcoming

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const G_TENANT = process.env.GRAPH_TENANT_ID, G_CLIENT = process.env.GRAPH_CLIENT_ID, G_SECRET = process.env.GRAPH_CLIENT_SECRET;
const NOTIFY_TO = process.env.SCHEDULE_NOTIFY_TO || process.env.CONTACT_NOTIFY_TO || "info@homecareproviderservices.us";
const NOTIFY_FROM = process.env.GRAPH_SENDER || "angelo@homecareproviderservices.us";
const SCHED_TZ_IANA = process.env.SCHEDULE_TZ_IANA || "America/Chicago";       // Central (online meetings)
const REMINDER_MIN = Number(process.env.SCHEDULE_REMINDER_MIN || 60);          // Outlook pop-up before start
const LEAD_HOURS = Number(process.env.SCHEDULE_LEAD_HOURS || 2);               // min notice for self-booking
const HORIZON_DAYS = Number(process.env.SCHEDULE_HORIZON_DAYS || 28);          // how far out slots are offered
const DAYNAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYSHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const zohoLib = require("./_zoho.js");

// Seed availability — editable in the admin console (stored in app_settings 'schedule_availability').
// windows: { weekday(0=Sun..6=Sat) : [[startMinute, endMinute], ...] } in the meeting type's clock.
const DEFAULT_AVAILABILITY = {
  default_owner_email: NOTIFY_FROM,
  meeting_types: {
    online: {
      label: "Online meeting (Zoom)", location_type: "online",
      tz_mode: "fixed", tz: SCHED_TZ_IANA, tz_label: "Central",
      zoom_link: "https://us02web.zoom.us/j/8568376484",
      duration_min: 30, slot_min: 30,
      windows: { "1": [[720, 810]], "2": [[600, 900]], "5": [[600, 900]] }   // Mon 12:00–1:30, Tue 10–3, Fri 10–3
    },
    field: {
      label: "Field visit (on-site)", location_type: "onsite",
      tz_mode: "dealer",
      duration_min: 30, slot_min: 30,
      windows: { "3": [[540, 960]], "4": [[540, 960]] }                       // Wed, Thu 9:00–4:00
    }
  },
  blocked_dates: []
};

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (s, n) => { s = String(s == null ? "" : s).trim(); return s ? s.slice(0, n || 500) : null; };
const dateOr = v => { const s = String(v || "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const isAdminRole = me => ["president", "admin", "owner"].includes(String(me && me.role || "").toLowerCase());

async function sbGet(path) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method, path, body, extra) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...H(), "content-type": "application/json", ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined }); if (!r.ok) { const t = await r.text(); const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; e.bodyText = t; throw e; } const t = await r.text(); return t ? JSON.parse(t) : null; }
async function sbInsertReq(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/service_requests`, { method: "POST", headers: { ...H(), "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(row) });
  const t = await r.text();
  if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${t}`); e.status = r.status; e.bodyText = t; throw e; }
  const j = t ? JSON.parse(t) : null; return j && j[0];
}

// ---- Staff auth (same pattern as crm-api / routes-api) ----
async function whoami(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim();
  if (tok) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
      if (r.ok) {
        const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase();
        if (email) { const s = await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(() => []); const su = s && s[0];
          if (su && su.active !== false) return { role: su.role || "rep", rep_name: su.rep_name || "", name: su.name || email, email }; }
      }
    } catch (e) {}
    return null;
  }
  const need = process.env.ANALYTICS_TOKEN, got = event.headers["x-analytics-token"] || "";
  if (need && got === need) return { role: "president", rep_name: "", name: "Admin", email: "" };
  return null;
}

// ---- Microsoft Graph — app-only, same creds as routes-api / email-sync ----
async function graphToken() {
  const body = new URLSearchParams({ client_id: G_CLIENT, client_secret: G_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetch(`https://login.microsoftonline.com/${G_TENANT}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error("graph_token:" + ((j && j.error_description) || r.status)); return j.access_token;
}
async function graphReq(tok, method, path, body) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, { method, headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body != null ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) {} return { ok: r.ok, status: r.status, json: j, text: t };
}
const graphEnv = () => !!(G_TENANT && G_CLIENT && G_SECRET);
async function graphSend(tok, msg) { await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(NOTIFY_FROM)}/sendMail`, { method: "POST", headers: { Authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(msg) }); }
// Normalize a Graph UTC dateTime (often 7 fractional digits, timeZone "UTC") to ms.
function msUTC(dt) { if (!dt) return NaN; let s = String(dt); if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s = s.replace(/\.\d+$/, "") + "Z"; return Date.parse(s); }
// Owner busy blocks from their real Outlook calendar (best-effort; empty on any failure).
async function graphBusy(tok, mailbox, fromISO, toISO) {
  try {
    const res = await graphReq(tok, "POST", `/users/${encodeURIComponent(mailbox)}/calendar/getSchedule`,
      { schedules: [mailbox], startTime: { dateTime: fromISO, timeZone: "UTC" }, endTime: { dateTime: toISO, timeZone: "UTC" }, availabilityViewInterval: 30 });
    const items = res.ok && res.json && res.json.value && res.json.value[0] && res.json.value[0].scheduleItems;
    if (!Array.isArray(items)) return [];
    return items.map(it => ({ start: msUTC(it.start && it.start.dateTime), end: msUTC(it.end && it.end.dateTime) })).filter(x => x.start && x.end);
  } catch (e) { return []; }
}

// ---- Dealer resolve ----
const SUF = /\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm = n => String(n || "").toUpperCase().replace(/HEALTH ?CARE/g, "HEALTHCARE").replace(/[.,'&/#-]/g, " ").replace(SUF, " ").replace(/\s+/g, " ").trim();
async function resolveDealerId(company, state) {
  const name = String(company || "").trim(); if (!name) return null;
  const first = name.replace(/[%_]/g, " ").trim().split(/\s+/)[0] || name;
  let cand = [];
  try { cand = await sbGet(`dealers?business_name=ilike.*${encodeURIComponent(first)}*&select=id,business_name,state,zip,is_test&limit=60`); } catch (e) { return null; }
  cand = (cand || []).filter(x => !x.is_test);
  const key = dnorm(name);
  let hits = cand.filter(x => dnorm(x.business_name) === key);
  if (hits.length > 1 && state) { const st = String(state).toUpperCase().slice(0, 2); const nn = hits.filter(x => String(x.state || "").toUpperCase().slice(0, 2) === st); if (nn.length) hits = nn; }
  return hits.length === 1 ? hits[0].id : null;
}
// Match a dealer by a contact email (the "known dealer" gate). Returns the dealer + contact + rep, or null.
async function verifyDealerByEmail(email) {
  const e = String(email || "").trim().toLowerCase(); if (!EMAIL_RE.test(e)) return null;
  let dealerId = null, contactName = null;
  try {
    const cts = await sbGet(`dealer_contacts?email=ilike.${encodeURIComponent(e)}&select=dealer_id,name,email&limit=5`);
    const c = (cts || [])[0]; if (c) { dealerId = c.dealer_id; contactName = c.name; }
  } catch (e2) {}
  if (!dealerId) { // fallback: some installs keep an email on the dealer row
    try { const ds = await sbGet(`dealers?email=ilike.${encodeURIComponent(e)}&select=id&limit=2`); if (ds && ds[0]) dealerId = ds[0].id; } catch (e2) {}
  }
  if (!dealerId) return null;
  let dealer = null; try { const d = await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=id,business_name,rep_name,state,is_test&limit=1`); dealer = d && d[0]; } catch (e2) {}
  if (!dealer || dealer.is_test) return null;
  return { dealer_id: dealer.id, company: dealer.business_name, contact_name: contactName, rep_name: dealer.rep_name || null, state: dealer.state || null };
}
// Resolve the calendar owner (assigned rep, else the default scheduler).
async function resolveOwner(dealer, cfg) {
  const fallback = cfg.default_owner_email || NOTIFY_FROM;
  if (dealer && dealer.rep_name) {
    try {
      const s = await sbGet(`staff_users?rep_name=eq.${encodeURIComponent(dealer.rep_name)}&select=email,name,rep_name,active&limit=1`);
      const su = s && s[0];
      if (su && su.email && EMAIL_RE.test(su.email) && su.active !== false) return { owner_email: su.email.toLowerCase(), rep_name: su.rep_name || dealer.rep_name, rep_display: (su.name || su.rep_name || dealer.rep_name) };
    } catch (e) {}
    return { owner_email: fallback, rep_name: dealer.rep_name, rep_display: dealer.rep_name };
  }
  return { owner_email: fallback, rep_name: null, rep_display: "your HCPS team" };
}

// ---- Time helpers ----
function parseTime(t) {
  const s = String(t || "").trim().toLowerCase(); if (!s) return null;
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (!m) { m = s.match(/^(\d{1,2})\s*(am|pm)/); if (m) m = [m[0], m[1], "00", m[2]]; }
  if (!m) return null;
  let h = parseInt(m[1], 10); const mm = parseInt(m[2] || "0", 10); const ap = m[3];
  if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mm > 59) return null;
  return { h, m: mm };
}
function nextDay(ymd) { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d + 1)); return dt.toISOString().slice(0, 10); }
function weekdayOf(dateStr) { const [y, mo, d] = String(dateStr).split("-").map(Number); return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }
function tzOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = dtf.formatToParts(instant).reduce((a, x) => (a[x.type] = x.value, a), {});
  const hh = p.hour === "24" ? "00" : p.hour;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +hh, +p.minute, +p.second) - instant.getTime();
}
function zonedToUtcISO(dateStr, h, mi, tz) {
  const [y, mo, d] = String(dateStr).split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  return new Date(guess - tzOffsetMs(new Date(guess), tz || SCHED_TZ_IANA)).toISOString();
}
const to12 = (h, m) => { const ap = h < 12 ? "AM" : "PM"; let hh = h % 12; if (hh === 0) hh = 12; return `${hh}:${String(m).padStart(2, "0")} ${ap}`; };
const validTz = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; } };
// Short tz abbreviation (e.g., CDT) for display.
function tzAbbr(tz, atMs) {
  try { const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(atMs || Date.now())).find(p => p.type === "timeZoneName"); return s ? s.value : ""; } catch (e) { return ""; }
}
function describeWindows(windows) {
  const order = [1, 2, 3, 4, 5, 6, 0]; const parts = [];
  for (const wd of order) { const w = windows && windows[String(wd)]; if (!w || !w.length) continue;
    const seg = w.map(([a, b]) => `${to12(Math.floor(a / 60), a % 60)}–${to12(Math.floor(b / 60), b % 60)}`).join(", ");
    parts.push(`${DAYSHORT[wd]} ${seg}`); }
  return parts.join(" · ");
}

// ---- Availability config ----
async function getAvailabilityConfig() {
  let saved = null;
  try { const rows = await sbGet("app_settings?key=eq.schedule_availability&select=value"); saved = rows && rows[0] && rows[0].value; } catch (e) {}
  if (!saved || typeof saved !== "object") return JSON.parse(JSON.stringify(DEFAULT_AVAILABILITY));
  const cfg = JSON.parse(JSON.stringify(DEFAULT_AVAILABILITY));
  cfg.default_owner_email = saved.default_owner_email || cfg.default_owner_email;
  cfg.blocked_dates = Array.isArray(saved.blocked_dates) ? saved.blocked_dates.filter(dateOr) : cfg.blocked_dates;
  for (const k of Object.keys(cfg.meeting_types)) {
    if (saved.meeting_types && saved.meeting_types[k]) {
      const s = saved.meeting_types[k], t = cfg.meeting_types[k];
      if (s.windows && typeof s.windows === "object") t.windows = s.windows;
      if (s.zoom_link != null) t.zoom_link = s.zoom_link;
      if (s.label) t.label = s.label;
      if (typeof s.duration_min === "number") t.duration_min = s.duration_min;
      if (typeof s.slot_min === "number") t.slot_min = s.slot_min;
      if (s.tz) t.tz = s.tz;
    }
  }
  return cfg;
}
async function setAvailabilityConfig(value) {
  await sbSend("POST", "app_settings?on_conflict=key", { key: "schedule_availability", value, updated_at: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" });
}

// ---- Slot engine ----
async function bookedStartSet(ownerEmail, fromISO, toISO) {
  const set = new Set();
  try {
    const rows = await sbGet(`service_requests?owner_email=eq.${encodeURIComponent(ownerEmail)}&status=eq.scheduled&start_at=gte.${encodeURIComponent(fromISO)}&start_at=lte.${encodeURIComponent(toISO)}&select=start_at`);
    for (const r of rows || []) { const ms = Date.parse(r.start_at); if (!isNaN(ms)) set.add(ms); }
  } catch (e) {}
  return set;
}
async function buildAvailability({ type, cfg, dealerTz, ownerEmail, horizon }) {
  const mt = cfg.meeting_types[type]; if (!mt) return { error: "bad_type" };
  const tz = mt.tz_mode === "dealer" ? (validTz(dealerTz) ? dealerTz : SCHED_TZ_IANA) : (mt.tz || SCHED_TZ_IANA);
  const dur = mt.duration_min || 30, step = mt.slot_min || 30;
  const now = Date.now();
  const blocked = new Set(cfg.blocked_dates || []);
  const base = new Date();
  const start0 = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  const HZ = Math.min(60, horizon || HORIZON_DAYS);
  const fromISO = new Date(now).toISOString();
  const toISO = new Date(start0 + (HZ + 1) * 86400000).toISOString();
  const booked = await bookedStartSet(ownerEmail, fromISO, toISO);
  let busy = [];
  if (graphEnv()) { try { const tok = await graphToken(); busy = await graphBusy(tok, ownerEmail, fromISO, toISO); } catch (e) {} }
  const minStart = now + LEAD_HOURS * 3600000;
  const days = [];
  for (let i = 0; i < HZ; i++) {
    const d = new Date(start0 + i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    if (blocked.has(dateStr)) continue;
    const wd = d.getUTCDay();
    const wins = mt.windows && mt.windows[String(wd)];
    if (!wins || !wins.length) continue;
    const slots = [];
    for (const [a, b] of wins) for (let m = a; m + dur <= b; m += step) {
      const h = Math.floor(m / 60), mi = m % 60;
      const startUtc = zonedToUtcISO(dateStr, h, mi, tz);
      const sMs = Date.parse(startUtc); if (sMs < minStart) continue;
      if (booked.has(sMs)) continue;
      const eMs = sMs + dur * 60000;
      if (busy.some(bz => sMs < bz.end && eMs > bz.start)) continue;
      slots.push({ label: to12(h, mi), start_utc: startUtc, end_utc: new Date(eMs).toISOString() });
    }
    if (slots.length) days.push({ date: dateStr, weekday: wd, dayname: DAYNAME[wd], slots });
  }
  return { tz, tz_abbr: tzAbbr(tz), location_type: mt.location_type, label: mt.label, zoom_link: mt.location_type === "online" ? (mt.zoom_link || null) : null, duration_min: dur, days };
}

// ---- Notifications ----
async function notify(req) {
  if (!graphEnv()) return;
  const rows = [["Service", req.service], ["Mode", req.mode], ["Preferred date", req.preferred_date], ["Preferred time", req.preferred_time],
    ["Alternate date", req.alt_date], ["Company", req.company], ["Contact", req.contact_name], ["Email", req.email], ["Phone", req.phone],
    ["State", req.state], ["Manufacturer", req.manufacturer]].filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#6b7280;font-size:13px">${esc(k)}</td><td style="padding:3px 0;font-weight:600;font-size:13px">${esc(v)}</td></tr>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
    <h2 style="color:#2B4071;margin:0 0 4px">New Dealer Hub service request</h2>
    <table style="border-collapse:collapse;margin:6px 0 14px">${rows}</table>
    ${req.notes ? `<p style="font-size:13px"><b>Notes:</b> ${esc(req.notes)}</p>` : ""}
    <p style="color:#9aa4ae;font-size:11px">Request ${esc(req.id)} · assign a rep and schedule in the HCPS console.</p></div>`;
  try { const tok = await graphToken(); await graphSend(tok, { message: { subject: `Dealer Hub: ${req.service} — ${req.company || req.contact_name || "request"}`,
    body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: NOTIFY_TO } }],
    replyTo: req.email && EMAIL_RE.test(req.email) ? [{ emailAddress: { address: req.email } }] : undefined }, saveToSentItems: false }); } catch (e) {}
}
// Booking confirmation to the dealer (cc the rep/owner).
async function sendConfirmation(tok, { to, cc, req, whenText, zoom, tzAbbrev }) {
  const isOnline = req.location_type === "online";
  const rowsArr = [["Meeting", req.service], ["When", whenText], ["Format", isOnline ? "Online (Zoom)" : "Field visit (on-site)"], ["With", req.rep_name || "your HCPS team"]];
  if (isOnline && zoom) rowsArr.push(["Join link", `<a href="${esc(zoom)}">${esc(zoom)}</a>`]);
  if (req.notes) rowsArr.push(["Notes", req.notes]);
  const rows = rowsArr.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-size:13px;white-space:nowrap">${esc(k)}</td><td style="padding:3px 0;font-weight:700;font-size:13px;color:#1b2733">${k === "Join link" ? v : esc(v)}</td></tr>`).join("");
  const html = `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
    <h2 style="color:#2B4071;margin:0 0 6px">Your appointment is booked ✓</h2>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 12px">Thanks${req.contact_name ? ", " + esc(req.contact_name) : ""}! Here are your details. A calendar invite is on its way — accept it to add the appointment to your calendar.</p>
    <table style="border-collapse:collapse;margin:0 0 14px">${rows}</table>
    <p style="font-size:12.5px;line-height:1.6;color:#6b7280;margin:0">Need to change or cancel? Just reply to this email. We'll also send a reminder 24 hours before.</p>
    <p style="font-size:12px;color:#9aa4ae;margin:14px 0 0">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.</p></div>`;
  const msg = { message: { subject: `Confirmed: ${req.service} — ${whenText}`, body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }], ccRecipients: (cc && EMAIL_RE.test(cc)) ? [{ emailAddress: { address: cc } }] : undefined,
    replyTo: EMAIL_RE.test(NOTIFY_TO) ? [{ emailAddress: { address: NOTIFY_TO } }] : undefined }, saveToSentItems: false };
  try { await graphSend(tok, msg); return true; } catch (e) { return false; }
}

// ---- Zoho (best-effort) ----
async function zohoConnect() {
  if (!zohoLib.hasCreds()) return null;
  let cfg = null; try { const rows = await sbGet("app_settings?key=eq.zoho_auth&select=value"); cfg = rows && rows[0] && rows[0].value; } catch (e) { return null; }
  if (!cfg || !cfg.refresh_token) return null;
  const at = await zohoLib.accessToken(cfg.refresh_token);
  if (!at.ok) return null;
  return { token: at.access_token, apiDomain: (cfg.api_domain || at.api_domain || "https://www.zohoapis.com").replace(/\/+$/, "") };
}
async function zohoTask(req, subject, desc, dueDate) {
  try {
    const c = await zohoConnect(); if (!c) return null;
    const rec = { Subject: String(subject || "HCPS appointment").slice(0, 255), Status: "Not Started" };
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || ""))) rec.Due_Date = dueDate;
    if (desc) rec.Description = String(desc).slice(0, 30000);
    if (req.company) {
      try {
        const sr = await zohoLib.zoho("GET", c.apiDomain, c.token, `/crm/v8/Accounts/search?criteria=${encodeURIComponent(`(Account_Name:equals:${req.company})`)}`);
        const acc = sr && sr.ok && sr.json && Array.isArray(sr.json.data) && sr.json.data[0] && sr.json.data[0].id;
        if (acc) { rec.What_Id = acc; rec.$se_module = "Accounts"; }
      } catch (e) {}
    }
    const r = await zohoLib.zoho("POST", c.apiDomain, c.token, "/crm/v8/Tasks", { data: [rec] });
    const ok = r && r.ok && r.json && Array.isArray(r.json.data) && r.json.data[0] && r.json.data[0].code === "SUCCESS";
    const id = ok && r.json.data[0].details && r.json.data[0].details.id;
    return ok ? { task_id: id, linked: !!rec.What_Id } : null;
  } catch (e) { return null; }
}

// ---- Dealer 360 ----
async function logActivity(dealer_id, subject, detail, contact_email, actor) {
  if (!dealer_id) return;
  try { await sbSend("POST", "dealer_activity", { dealer_id, kind: "meeting", subject: clip(subject, 300), detail: clip(detail, 4000) || null,
    contact_email: contact_email && EMAIL_RE.test(contact_email) ? contact_email : null, actor: actor || null, created_at: new Date().toISOString() }, { Prefer: "return=minimal" }); } catch (e) {}
}
async function addFollowupTask(dealer_id, title, detail, due, assigned_rep, created_by) {
  if (!dealer_id) return null;
  try {
    const row = { dealer_id, title: clip(title, 200), detail: clip(detail, 2000),
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(due || "")) ? due : null,
      priority: "normal", source: "scheduling", assigned_rep: assigned_rep || null, created_by: created_by || null, status: "open" };
    const ins = await sbSend("POST", "dealer_tasks", row, { Prefer: "return=representation" });
    return (ins && ins[0]) || row;
  } catch (e) { return null; }
}

async function getReq(id) { const r = await sbGet(`service_requests?id=eq.${encodeURIComponent(id)}&select=*&limit=1`); return r && r[0]; }
async function patchReq(id, patch) { patch.updated_at = new Date().toISOString(); const r = await sbSend("PATCH", `service_requests?id=eq.${encodeURIComponent(id)}`, patch, { Prefer: "return=representation" }); return (r && r[0]) || null; }

// Create the Outlook event for a booking on the owner's calendar (dealer invited). Returns {calendar}|{error}.
async function createBookingEvent(tok, { ownerEmail, req, startUtc, endUtc, tz, isOnline, zoom }) {
  const startMs = Date.parse(startUtc);
  const [y, mo, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(startMs)).split("-");
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(startMs));
  const hmE = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(Date.parse(endUtc)));
  const startLocal = `${y}-${mo}-${d}T${hm}:00`, endLocal = `${y}-${mo}-${d}T${hmE}:00`;
  const where = isOnline ? "Online — Zoom" : (req.company ? `Field visit — ${req.company}${req.state ? ", " + req.state : ""}` : "Field visit");
  const bodyHtml = `<div style="font-family:Arial,sans-serif;font-size:13px;color:#1b2733">
    <p><b>${esc(req.service)}</b></p>
    <p>Dealer: <b>${esc(req.company || "")}</b><br>Contact: ${esc(req.contact_name || "")} · ${esc(req.email || "")}${req.phone ? " · " + esc(req.phone) : ""}</p>
    ${isOnline && zoom ? `<p>Join Zoom: <a href="${esc(zoom)}">${esc(zoom)}</a></p>` : ""}
    ${req.notes ? `<p>Notes: ${esc(req.notes)}</p>` : ""}
    <p style="color:#9aa4ae;font-size:11px">Booked by the dealer via the HCPS Dealer Hub.</p></div>`;
  const ev = {
    subject: `HCPS ${isOnline ? "online" : "field"}: ${req.service} — ${req.company || req.contact_name || "Dealer"}`,
    body: { contentType: "HTML", content: bodyHtml },
    start: { dateTime: startLocal, timeZone: tz }, end: { dateTime: endLocal, timeZone: tz },
    location: { displayName: where }, isReminderOn: true, reminderMinutesBeforeStart: REMINDER_MIN,
    isOnlineMeeting: false, responseRequested: true,
    attendees: (req.email && EMAIL_RE.test(req.email)) ? [{ emailAddress: { address: req.email, name: req.contact_name || req.company || "" }, type: "required" }] : []
  };
  if (isOnline && zoom) ev.location = { displayName: `Zoom — ${zoom}` };
  const res = await graphReq(tok, "POST", `/users/${encodeURIComponent(ownerEmail)}/events`, ev);
  if (res.ok && res.json && res.json.id) {
    const abbr = tzAbbr(tz, startMs);
    const localLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(startMs));
    return { calendar: { mailbox: ownerEmail, event_id: res.json.id, web_link: res.json.webLink || null, start: startLocal, end: endLocal, start_utc: startUtc, end_utc: endUtc, tz, when_text: `${localLabel}${abbr ? " " + abbr : ""}`, invited: !!ev.attendees.length, zoom_link: isOnline ? zoom : null, updated_at: new Date().toISOString() } };
  }
  if (res.status === 403) return { error: "calendar_denied" };
  return { error: "calendar_error", detail: String((res.json && res.json.error && res.json.error.message) || res.text || "").slice(0, 180) };
}

// ============================ PUBLIC SELF-BOOKING ============================
async function publicVerify(b) {
  const email = clip(b.email, 160);
  if (!email || !EMAIL_RE.test(email)) return json(400, { ok: false, error: "bad_email", message: "Enter a valid email." });
  const d = await verifyDealerByEmail(email);
  if (!d) return json(200, { ok: true, matched: false, message: "We couldn't match that email to a dealer account. Use the request form below and we'll confirm a time for you." });
  const cfg = await getAvailabilityConfig();
  const owner = await resolveOwner(d, cfg);
  return json(200, { ok: true, matched: true, dealer_id: d.dealer_id, company: d.company, contact_name: d.contact_name, rep_display: owner.rep_display });
}
async function publicSlots(b) {
  const email = clip(b.email, 160);
  const type = clip(b.meeting_type, 24);
  if (!email || !EMAIL_RE.test(email)) return json(400, { ok: false, error: "bad_email" });
  const cfg = await getAvailabilityConfig();
  if (!type || !cfg.meeting_types[type]) return json(400, { ok: false, error: "bad_type", message: "Choose a meeting type." });
  const d = await verifyDealerByEmail(email);
  if (!d) return json(200, { ok: false, error: "not_verified", message: "That email isn't linked to a dealer account yet." });
  const owner = await resolveOwner(d, cfg);
  const av = await buildAvailability({ type, cfg, dealerTz: clip(b.tz, 60), ownerEmail: owner.owner_email, horizon: b.days });
  if (av.error) return json(400, { ok: false, error: av.error });
  return json(200, { ok: true, meeting_type: type, label: av.label, location_type: av.location_type, tz: av.tz, tz_abbr: av.tz_abbr, zoom_link: av.zoom_link, duration_min: av.duration_min, rep_display: owner.rep_display, company: d.company, contact_name: d.contact_name, days: av.days });
}
async function publicBook(b) {
  const email = clip(b.email, 160);
  const type = clip(b.meeting_type, 24);
  const startUtc = clip(b.start_utc, 40);
  const name = clip(b.name || b.contact_name, 120);
  if (!email || !EMAIL_RE.test(email)) return json(400, { ok: false, error: "bad_email", message: "Enter a valid email." });
  const cfg = await getAvailabilityConfig();
  const mt = cfg.meeting_types[type];
  if (!mt) return json(400, { ok: false, error: "bad_type", message: "Choose a meeting type." });
  if (!startUtc || isNaN(Date.parse(startUtc))) return json(400, { ok: false, error: "bad_time", message: "Pick a time." });
  const d = await verifyDealerByEmail(email);
  if (!d) return json(200, { ok: false, error: "not_verified", message: "That email isn't linked to a dealer account." });
  const owner = await resolveOwner(d, cfg);

  // Re-check the slot is still genuinely available (windows, blocked, lead time, conflicts, busy).
  const av = await buildAvailability({ type, cfg, dealerTz: clip(b.tz, 60), ownerEmail: owner.owner_email });
  const slot = (av.days || []).flatMap(x => x.slots).find(s => Date.parse(s.start_utc) === Date.parse(startUtc));
  if (!slot) return json(200, { ok: false, error: "slot_taken", message: "That time was just taken or is no longer open. Please pick another slot." });

  const isOnline = mt.location_type === "online";
  const tz = mt.tz_mode === "dealer" ? (validTz(b.tz) ? b.tz : SCHED_TZ_IANA) : (mt.tz || SCHED_TZ_IANA);
  const topic = clip(b.topic, 120);
  const serviceName = topic ? `${topic} (${mt.label})` : mt.label;
  const req = { service: serviceName, service_key: type, company: d.company, contact_name: name || d.contact_name, email,
    phone: clip(b.phone, 40), notes: clip(b.notes, 2000), state: d.state, location_type: mt.location_type, rep_name: owner.rep_display };

  // Insert first (the partial unique index on owner_email+start_at is the real double-booking guard).
  let saved;
  try {
    saved = await sbInsertReq({
      service: serviceName, service_key: type, meeting_type: type, mode: isOnline ? "remote" : "in_person",
      company: d.company, contact_name: req.contact_name, email, phone: req.phone, state: d.state, notes: req.notes,
      dealer_id: d.dealer_id, rep_name: owner.rep_display, owner_email: owner.owner_email,
      start_at: startUtc, end_at: slot.end_utc, timezone: tz, location_type: mt.location_type,
      status: "scheduled", source: "dealer-selfbook", reminders: {},
    });
  } catch (e) {
    if (String(e.bodyText || e.message || "").match(/23505|duplicate key|unique/i)) return json(200, { ok: false, error: "slot_taken", message: "That time was just booked. Please choose another slot." });
    if (/relation|does not exist|service_requests|column/i.test(String(e.bodyText || e.message || ""))) return json(200, { ok: false, error: "tables_missing", message: "Scheduling isn't fully switched on yet — run supabase/service_requests.sql." });
    return json(500, { ok: false, error: "save_failed", message: "Couldn't save the booking. Please try again." });
  }

  // Calendar event + invite + confirmation (best-effort; the booking already exists).
  let calendar = null, when_text = slot.label, calWarn = null;
  if (graphEnv()) {
    try {
      const tok = await graphToken();
      const made = await createBookingEvent(tok, { ownerEmail: owner.owner_email, req, startUtc, endUtc: slot.end_utc, tz, isOnline, zoom: mt.zoom_link });
      if (made.calendar) { calendar = made.calendar; when_text = made.calendar.when_text || when_text;
        await sendConfirmation(tok, { to: email, cc: owner.owner_email, req: { ...req, notes: req.notes }, whenText: when_text, zoom: mt.zoom_link, tzAbbrev: calendar.tz });
      } else { calWarn = made.error === "calendar_denied" ? "calendar_denied" : "calendar_error"; }
    } catch (e) { calWarn = "graph_error"; }
  }
  await patchReq(saved.id, { calendar: calendar || { start_utc: startUtc, end_utc: slot.end_utc, tz, when_text } });

  // Dealer 360 + Zoho (best-effort).
  await logActivity(d.dealer_id, `Appointment booked — ${mt.label}`, `${when_text} · ${isOnline ? "Online (Zoom)" : "Field visit"} · with ${owner.rep_display}. Self-booked via Dealer Hub.`, email, "Dealer Hub");
  const zt = await zohoTask({ company: d.company }, `HCPS ${mt.label} — ${d.company || ""}`.trim(), `Self-booked ${when_text} with ${owner.rep_display}. ${isOnline ? "Zoom." : "Field visit."}`, dateOr(startUtc.slice(0, 10)));
  if (zt) { try { await patchReq(saved.id, { zoho: { ...zt, at: new Date().toISOString() } }); } catch (e) {} }

  return json(200, { ok: true, id: saved.id, when_text, zoom_link: isOnline ? mt.zoom_link : null,
    message: `You're booked for ${when_text}. A calendar invite and confirmation email are on their way${isOnline ? " with your Zoom link" : ""}.`,
    calendar_ok: !!calendar, warning: calWarn });
}

// ============================ ADMIN ACTIONS ============================
async function adminHandler(me, b) {
  if (b.action === "queue") {
    const status = clip(b.status, 20);
    const filt = status && status !== "all" ? `&status=eq.${encodeURIComponent(status)}` : "";
    const requests = await sbGet(`service_requests?select=*${filt}&order=created_at.desc&limit=500`).catch(() => []);
    const all = status ? await sbGet(`service_requests?select=status`).catch(() => []) : requests;
    const counts = {}; for (const r of all) counts[r.status || "requested"] = (counts[r.status || "requested"] || 0) + 1;
    let reps = [];
    try { reps = await sbGet(`staff_users?active=neq.false&select=email,name,rep_name,role&order=name.asc`); }
    catch (e) { try { reps = await sbGet(`staff_users?select=email,name,rep_name,role&order=name.asc`); } catch (e2) {} }
    reps = (reps || []).filter(r => r.email && EMAIL_RE.test(r.email));
    const cfg = await getAvailabilityConfig();
    const online = cfg.meeting_types.online.windows, field = cfg.meeting_types.field.windows;
    return json(200, { ok: true, requests, reps, counts, graph: graphEnv(), availability: { text: describeWindows(online) + " (Central) · Field visits " + describeWindows(field) + " (dealer-local)", tz: "CT", online_windows: online, field_windows: field } });
  }

  if (b.action === "search_dealers") {
    const q = clip(b.q, 80); if (!q || q.length < 2) return json(200, { ok: true, dealers: [] });
    let rows = [];
    try { rows = await sbGet(`dealers?business_name=ilike.*${encodeURIComponent(q)}*&select=id,business_name,city,state,is_test&order=business_name.asc&limit=25`); } catch (e) {}
    return json(200, { ok: true, dealers: (rows || []).filter(d => !d.is_test) });
  }

  if (b.action === "set_dealer") {
    if (!b.id) return json(400, { error: "id required" });
    const req = await getReq(b.id); if (!req) return json(404, { error: "not found" });
    const out = await patchReq(b.id, { dealer_id: b.dealer_id ? String(b.dealer_id) : null });
    return json(200, { ok: true, request: out });
  }

  // Manual schedule of a request (rep books it from the console).
  if (b.action === "assign") {
    if (!b.id) return json(400, { error: "id required" });
    const repEmail = clip(b.rep_email, 160);
    if (!repEmail || !EMAIL_RE.test(repEmail)) return json(400, { error: "A rep with a valid work email is required to book the appointment." });
    const req = await getReq(b.id); if (!req) return json(404, { error: "not found" });
    const cfg = await getAvailabilityConfig();
    const date = dateOr(b.date) || req.preferred_date;
    const timeText = clip(b.time, 40) || req.preferred_time;
    const mode = (b.mode === "remote" || b.mode === "in_person") ? b.mode : req.mode;
    const isOnline = mode !== "in_person";
    const mt = isOnline ? cfg.meeting_types.online : cfg.meeting_types.field;

    // Validate against the configured windows unless overridden.
    if (date && !b.override_hours) {
      const tm = parseTime(timeText);
      const wins = mt.windows[String(weekdayOf(date))];
      const dur = 30;
      const okslot = tm && wins && wins.some(([a, x]) => { const s = tm.h * 60 + tm.m; return s >= a && s + dur <= x; });
      if (!okslot) return json(200, { ok: false, error: "outside_hours", message: `That time is outside ${mt.label} hours (${describeWindows(mt.windows)}${isOnline ? " Central" : ""}). Pick a slot inside a window or check “book outside standard hours.”` });
    }

    let dealer_id = b.dealer_id ? String(b.dealer_id) : (req.dealer_id || await resolveDealerId(req.company, req.state));
    const tz = isOnline ? (mt.tz || SCHED_TZ_IANA) : (validTz(req.timezone) ? req.timezone : SCHED_TZ_IANA);

    let calendar = req.calendar && typeof req.calendar === "object" ? { ...req.calendar } : {};
    let calMsg = null, calWarn = null, start_utc = null, end_utc = null, when_text = null;
    const tm = parseTime(timeText);
    if (date && tm) { start_utc = zonedToUtcISO(date, tm.h, tm.m, tz); end_utc = new Date(Date.parse(start_utc) + 30 * 60000).toISOString(); }

    if (!graphEnv()) { calWarn = "Outlook isn't configured (GRAPH_* env) — appointment saved without a calendar event."; }
    else if (!date || !tm) { calWarn = "Set a date and time to create the Outlook event."; }
    else {
      try {
        const tok = await graphToken();
        if (calendar.mailbox && calendar.event_id) { try { await graphReq(tok, "DELETE", `/users/${encodeURIComponent(calendar.mailbox)}/events/${encodeURIComponent(calendar.event_id)}`); } catch (e) {} }
        const reqLike = { service: req.service, company: req.company, contact_name: req.contact_name, email: req.email, phone: req.phone, notes: req.notes, state: req.state };
        const made = await createBookingEvent(tok, { ownerEmail: repEmail, req: reqLike, startUtc: start_utc, endUtc: end_utc, tz, isOnline, zoom: isOnline ? mt.zoom_link : null });
        if (made.calendar) { calendar = made.calendar; when_text = made.calendar.when_text; calMsg = "Outlook event created on " + repEmail + " · dealer invited";
          if (b.invite_dealer !== false) { try { await sendConfirmation(tok, { to: req.email, cc: repEmail, req: { ...reqLike, rep_name: clip(b.rep_name, 120) || repEmail, location_type: mt.location_type }, whenText: when_text, zoom: isOnline ? mt.zoom_link : null }); } catch (e) {} }
        } else if (made.error === "calendar_denied") { calWarn = "Outlook denied the write — grant Calendars.ReadWrite (admin consent) in Azure, then re-assign."; }
        else { calWarn = "Outlook error: " + (made.detail || ""); }
      } catch (e) { calWarn = "Couldn't reach Outlook: " + String(e.message || e).slice(0, 120); }
    }

    let zoho = req.zoho && typeof req.zoho === "object" ? { ...req.zoho } : {};
    if (!zoho.task_id) { const zt = await zohoTask(req, `HCPS ${req.service} — ${req.company || ""}`.trim(), `Scheduled with ${clip(b.rep_name, 120) || repEmail}${date ? " on " + date : ""}${timeText ? " " + timeText : ""}.`, date); if (zt) zoho = { ...zoho, ...zt, at: new Date().toISOString() }; }

    let out;
    try {
      out = await patchReq(b.id, { status: "scheduled", rep_name: clip(b.rep_name, 120) || req.rep_name || repEmail,
        preferred_date: date || req.preferred_date, preferred_time: timeText || req.preferred_time, mode: mode || req.mode,
        meeting_type: isOnline ? "online" : "field", owner_email: repEmail, dealer_id: dealer_id || null,
        start_at: start_utc, end_at: end_utc, timezone: tz, location_type: mt.location_type, calendar, zoho, reminders: {} });
    } catch (e) {
      if (String(e.bodyText || e.message || "").match(/23505|duplicate key|unique/i)) return json(200, { ok: false, error: "slot_taken", message: `${clip(b.rep_name, 120) || repEmail} already has an appointment at that time. Pick another slot.` });
      throw e;
    }
    await logActivity(dealer_id, `Appointment scheduled — ${req.service}`, `Assigned to ${out.rep_name}${when_text ? " · " + when_text : (date ? " · " + date : "")}. Scheduled from the console.`, req.email, me.name || me.email);
    return json(200, { ok: true, request: out, calendar: { ok: !!calMsg, message: calMsg || calWarn }, zoho: { ok: !!zoho.task_id }, dealer_linked: !!dealer_id });
  }

  if (b.action === "complete") {
    if (!b.id) return json(400, { error: "id required" });
    const req = await getReq(b.id); if (!req) return json(404, { error: "not found" });
    const notes = clip(b.completed_notes, 4000);
    const patch = { status: "completed", completed_notes: notes || req.completed_notes || null };
    if (clip(b.followup)) patch.followup = clip(b.followup, 2000);
    const out = await patchReq(b.id, patch);
    await logActivity(req.dealer_id, `Meeting completed — ${req.service}`, (notes ? notes + " " : "") + `(Rep: ${req.rep_name || "—"})`, req.email, me.name || me.email);
    let task = null;
    if (b.create_task && clip(b.followup)) task = await addFollowupTask(req.dealer_id, `Follow-up: ${req.service} — ${req.company || ""}`.trim(), clip(b.followup, 2000), dateOr(b.followup_due), req.rep_name, me.name || me.email);
    return json(200, { ok: true, request: out, task });
  }

  if (b.action === "cancel") {
    if (!b.id) return json(400, { error: "id required" });
    const req = await getReq(b.id); if (!req) return json(404, { error: "not found" });
    if (graphEnv() && req.calendar && req.calendar.mailbox && req.calendar.event_id) { try { const tok = await graphToken(); await graphReq(tok, "DELETE", `/users/${encodeURIComponent(req.calendar.mailbox)}/events/${encodeURIComponent(req.calendar.event_id)}`); } catch (e) {} }
    const out = await patchReq(b.id, { status: "cancelled", calendar: null, start_at: null });
    return json(200, { ok: true, request: out });
  }

  if (b.action === "reopen") {
    if (!b.id) return json(400, { error: "id required" });
    const out = await patchReq(b.id, { status: "requested", start_at: null });
    return json(200, { ok: true, request: out });
  }

  // -- Availability management --
  if (b.action === "get_availability") {
    const cfg = await getAvailabilityConfig();
    return json(200, { ok: true, config: cfg, describe: { online: describeWindows(cfg.meeting_types.online.windows), field: describeWindows(cfg.meeting_types.field.windows) } });
  }
  if (b.action === "set_availability") {
    if (!isAdminRole(me)) return json(403, { error: "Admin only" });
    const inc = b.config || {};
    const cfg = await getAvailabilityConfig();
    if (inc.default_owner_email && EMAIL_RE.test(inc.default_owner_email)) cfg.default_owner_email = inc.default_owner_email.toLowerCase();
    if (Array.isArray(inc.blocked_dates)) cfg.blocked_dates = [...new Set(inc.blocked_dates.filter(dateOr))].sort();
    const sanitizeWindows = w => { const out = {}; for (const k of ["0", "1", "2", "3", "4", "5", "6"]) { const arr = w && w[k]; if (Array.isArray(arr)) { const clean = arr.map(p => [Math.max(0, Math.min(1440, +p[0] || 0)), Math.max(0, Math.min(1440, +p[1] || 0))]).filter(p => p[1] > p[0]); if (clean.length) out[k] = clean; } } return out; };
    if (inc.meeting_types) for (const k of ["online", "field"]) if (inc.meeting_types[k]) {
      const s = inc.meeting_types[k], t = cfg.meeting_types[k];
      if (s.windows) t.windows = sanitizeWindows(s.windows);
      if (k === "online" && typeof s.zoom_link === "string") t.zoom_link = clip(s.zoom_link, 400) || "";
    }
    await setAvailabilityConfig(cfg);
    return json(200, { ok: true, config: cfg, describe: { online: describeWindows(cfg.meeting_types.online.windows), field: describeWindows(cfg.meeting_types.field.windows) } });
  }
  // -- Upcoming appointments --
  if (b.action === "upcoming") {
    const nowISO = new Date().toISOString();
    let rows = [];
    try { rows = await sbGet(`service_requests?status=eq.scheduled&start_at=gte.${encodeURIComponent(nowISO)}&select=*&order=start_at.asc&limit=300`); } catch (e) {}
    return json(200, { ok: true, appointments: rows });
  }

  return json(400, { error: "unknown action" });
}

// ============================ ENTRY ============================
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "Scheduling isn't configured yet." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad JSON" }); }

  const ADMIN = new Set(["queue", "assign", "complete", "cancel", "reopen", "set_dealer", "search_dealers", "get_availability", "set_availability", "upcoming"]);
  if (ADMIN.has(b.action)) {
    const me = await whoami(event);
    if (!me) return json(401, { error: "unauthorized" });
    try { return await adminHandler(me, b); }
    catch (e) {
      if (/relation|does not exist|service_requests|column/i.test(String(e.bodyText || e.message || e))) return json(200, { ok: false, error: "tables_missing", message: "Run supabase/service_requests.sql first (it adds the new columns too)." });
      return json(500, { error: "Server error: " + String(e.message || e).slice(0, 160) });
    }
  }

  // -------- PUBLIC --------
  if (b.company_website) return json(200, { ok: true });   // honeypot
  try {
    if (b.action === "verify_dealer") return await publicVerify(b);
    if (b.action === "slots") return await publicSlots(b);
    if (b.action === "book") return await publicBook(b);
  } catch (e) {
    if (/relation|does not exist|service_requests|column/i.test(String(e.bodyText || e.message || e))) return json(200, { ok: false, error: "tables_missing", message: "Scheduling isn't switched on yet — run supabase/service_requests.sql." });
    return json(500, { ok: false, error: "server", message: "Something went wrong. Please email " + NOTIFY_TO + "." });
  }

  // -------- Legacy preferred-time request (fallback for unverified dealers) --------
  const service = clip(b.service, 120);
  const company = clip(b.company, 160);
  const name = clip(b.name || b.contact_name, 120);
  const email = clip(b.email, 160);
  if (!service) return json(400, { error: "Please choose a service." });
  if (!company || !name || !email || !EMAIL_RE.test(email)) return json(400, { error: "Please provide company, contact name, and a valid email." });
  const row = { service, service_key: clip(b.service_key, 60), mode: (b.mode === "remote" || b.mode === "in_person") ? b.mode : null,
    preferred_date: dateOr(b.preferred_date), preferred_time: clip(b.preferred_time, 40), alt_date: dateOr(b.alt_date),
    company, contact_name: name, email, phone: clip(b.phone, 40), state: clip(b.state, 24),
    manufacturer: clip(b.manufacturer, 120), notes: clip(b.notes, 2000), status: "requested", source: "dealer-hub" };
  let saved;
  try { saved = await sbInsertReq(row); }
  catch (e) {
    if (/relation|does not exist|service_requests|column/i.test(String(e.bodyText || e.message || e))) return json(200, { ok: false, error: "tables_missing", message: "Scheduling isn't switched on yet — run supabase/service_requests.sql." });
    return json(500, { error: "Couldn't save your request. Please email " + NOTIFY_TO + "." });
  }
  await notify({ ...row, id: saved && saved.id });
  return json(200, { ok: true, id: saved && saved.id, message: "Request received. A HCPS representative will confirm your appointment and send a calendar invite shortly." });
};

// HCPS Dealer Hub — service & scheduling: PUBLIC intake (no auth) + ADMIN scheduling console (staff auth).
// A dealer picks a service (training, consultation, technical support, showroom review…), remote or
// in-person, and a preferred date/time. We record the request DURABLY in service_requests so it
// becomes a trackable Dealer 360 touch point, then best-effort notify the HCPS team. The admin
// scheduling console then assigns a rep, creates the Outlook (Graph) event + Zoho task, links the
// dealer, logs it to Dealer 360, and moves the request through scheduled → completed → follow-up.
//
//   -- PUBLIC (no auth, like the contact form) --
//   POST { action:"request", service, service_key?, mode?, preferred_date?, preferred_time?,
//          alt_date?, company, name, email, phone?, state?, manufacturer?, notes?, company_website? }
//     -> { ok, id, message }
//
//   -- ADMIN (staff Bearer token required) --
//   POST { action:"queue", status? }                 -> { ok, requests:[...], reps:[...], counts:{...} }
//   POST { action:"assign", id, rep_email, rep_name?, date?, time?, duration_min?, mode?,
//          dealer_id?, invite_dealer?, location?, note? }   -> { ok, request, calendar, zoho }
//   POST { action:"complete", id, completed_notes?, followup?, followup_due?, create_task? } -> { ok, request }
//   POST { action:"cancel", id, reason? }             -> { ok, request }
//   POST { action:"reopen", id }                      -> { ok, request }
//   POST { action:"set_dealer", id, dealer_id }       -> { ok, request }   (link/unlink Dealer 360)
//   POST { action:"search_dealers", q }               -> { ok, dealers:[...] }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const G_TENANT = process.env.GRAPH_TENANT_ID, G_CLIENT = process.env.GRAPH_CLIENT_ID, G_SECRET = process.env.GRAPH_CLIENT_SECRET;
const NOTIFY_TO = process.env.SCHEDULE_NOTIFY_TO || process.env.CONTACT_NOTIFY_TO || "info@homecareproviderservices.us";
const NOTIFY_FROM = process.env.GRAPH_SENDER || "angelo@homecareproviderservices.us";
// Windows time-zone name Graph understands; HCPS is Eastern. Override with SCHEDULE_TIMEZONE if needed.
const SCHED_TZ = process.env.SCHEDULE_TIMEZONE || "Eastern Standard Time";
const zohoLib = require("./_zoho.js");

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (s, n) => { s = String(s == null ? "" : s).trim(); return s ? s.slice(0, n || 500) : null; };
const dateOr = v => { const s = String(v || "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function sbGet(path) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method, path, body, extra) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...H(), "content-type": "application/json", ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t = await r.text(); return t ? JSON.parse(t) : null; }
async function sbInsert(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/service_requests`, { method: "POST", headers: { ...H(), "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const j = await r.json().catch(() => null);
  return j && j[0];
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

// ---- Microsoft Graph (Outlook calendar write) — app-only, same creds as routes-api / email-sync ----
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

// ---- Dealer name normalizer + resolver (mirrors crm-api / federation-events) ----
const SUF = /\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm = n => String(n || "").toUpperCase().replace(/HEALTH ?CARE/g, "HEALTHCARE").replace(/[.,'&/#-]/g, " ").replace(SUF, " ").replace(/\s+/g, " ").trim();
// Best-effort: match a request's company (optionally narrowed by state/zip) to one dealer row.
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

// ---- Time parsing: (date, timeText) -> {isAllDay, start, end} in SCHED_TZ ----
function parseTime(t) {
  const s = String(t || "").trim().toLowerCase(); if (!s) return null;
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?/); // 2:00 pm / 14:00
  if (!m) { m = s.match(/^(\d{1,2})\s*(am|pm)/); if (m) m = [m[0], m[1], "00", m[2]]; }
  if (!m) return null;
  let h = parseInt(m[1], 10); const mm = parseInt(m[2] || "0", 10); const ap = m[3];
  if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mm > 59) return null;
  return { h, m: mm };
}
function windowFor(date, timeText, durMin) {
  const d = dateOr(date); if (!d) return null;
  const tm = parseTime(timeText);
  const p2 = n => String(n).padStart(2, "0");
  if (!tm) return { isAllDay: true, start: `${d}T00:00:00`, end: `${d}T00:00:00`, allDayDate: d };
  const dur = Math.max(15, Math.min(480, Number(durMin) || 60));
  const startMin = tm.h * 60 + tm.m; const endMin = startMin + dur;
  const eh = Math.floor(endMin / 60) % 24, em = endMin % 60;
  return { isAllDay: false, start: `${d}T${p2(tm.h)}:${p2(tm.m)}:00`, end: `${d}T${p2(eh)}:${p2(em)}:00` };
}
function nextDay(ymd) { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d + 1)); return dt.toISOString().slice(0, 10); }

// ---- Best-effort internal notification of a new request (public intake) ----
async function notify(req) {
  if (!graphEnv()) return;
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

// ---- Zoho: best-effort follow-up Task linked to the dealer's Account (non-fatal) ----
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
    // Try to link the Task to the dealer's Zoho Account by exact name.
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

// ---- Dealer 360 timeline: drop a meeting activity (+ optional follow-up task) ----
async function logActivity(dealer_id, subject, detail, contact_email, actor) {
  if (!dealer_id) return;
  try {
    await sbSend("POST", "dealer_activity", { dealer_id, kind: "meeting", subject: clip(subject, 300), detail: clip(detail, 4000) || null,
      contact_email: contact_email && EMAIL_RE.test(contact_email) ? contact_email : null, actor: actor || null, created_at: new Date().toISOString() }, { Prefer: "return=minimal" });
  } catch (e) { /* non-fatal — timeline is best-effort */ }
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
async function patchReq(id, patch) {
  patch.updated_at = new Date().toISOString();
  const r = await sbSend("PATCH", `service_requests?id=eq.${encodeURIComponent(id)}`, patch, { Prefer: "return=representation" });
  return (r && r[0]) || null;
}

// ============================ ADMIN ACTIONS ============================
async function adminHandler(me, b) {
  // -- Queue: all requests + rep options + status counts --
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
    return json(200, { ok: true, requests, reps, counts, graph: graphEnv() });
  }

  // -- Search dealers to link one manually --
  if (b.action === "search_dealers") {
    const q = clip(b.q, 80); if (!q || q.length < 2) return json(200, { ok: true, dealers: [] });
    let rows = [];
    try { rows = await sbGet(`dealers?business_name=ilike.*${encodeURIComponent(q)}*&select=id,business_name,city,state,is_test&order=business_name.asc&limit=25`); } catch (e) {}
    return json(200, { ok: true, dealers: (rows || []).filter(d => !d.is_test) });
  }

  // -- Link / unlink a dealer to a request (Dealer 360) --
  if (b.action === "set_dealer") {
    if (!b.id) return json(400, { error: "id required" });
    const req = await getReq(b.id); if (!req) return json(404, { error: "not found" });
    const dealer_id = b.dealer_id ? String(b.dealer_id) : null;
    const out = await patchReq(b.id, { dealer_id });
    return json(200, { ok: true, request: out });
  }

  // -- Assign a rep + book the Outlook appointment (+ Zoho task + Dealer 360 log) --
  if (b.action === "assign") {
    if (!b.id) return json(400, { error: "id required" });
    const repEmail = clip(b.rep_email, 160);
    if (!repEmail || !EMAIL_RE.test(repEmail)) return json(400, { error: "A rep with a valid work email is required to book the appointment." });
    const req = await getReq(b.id); if (!req) return json(404, { error: "not found" });

    const date = dateOr(b.date) || req.preferred_date;
    const timeText = clip(b.time, 40) || req.preferred_time;
    const mode = (b.mode === "remote" || b.mode === "in_person") ? b.mode : req.mode;
    const win = date ? windowFor(date, timeText, b.duration_min) : null;

    // Resolve dealer (explicit pick wins; else best-effort match) so it lands in Dealer 360.
    let dealer_id = b.dealer_id ? String(b.dealer_id) : (req.dealer_id || await resolveDealerId(req.company, req.state));

    // --- Outlook calendar event on the rep's mailbox ---
    let calendar = req.calendar && typeof req.calendar === "object" ? { ...req.calendar } : {};
    let calMsg = null, calWarn = null;
    if (!graphEnv()) { calWarn = "Outlook isn't configured (GRAPH_* env vars) — appointment saved without a calendar event."; }
    else if (!win) { calWarn = "No date on file yet — set a date to create the Outlook event."; }
    else {
      const where = mode === "remote" ? "Remote / virtual" : (clip(b.location, 200) || (req.company ? `${req.company}${req.state ? ", " + req.state : ""}` : "In person"));
      const bodyHtml = `<div style="font-family:Arial,sans-serif;font-size:13px;color:#1b2733">
        <p><b>${esc(req.service)}</b>${mode ? " · " + esc(mode === "remote" ? "Remote" : "In person") : ""}</p>
        <p>Dealer: <b>${esc(req.company || "")}</b><br>Contact: ${esc(req.contact_name || "")} · ${esc(req.email || "")}${req.phone ? " · " + esc(req.phone) : ""}</p>
        ${req.manufacturer ? `<p>Manufacturer: ${esc(req.manufacturer)}</p>` : ""}
        ${req.notes ? `<p>Notes: ${esc(req.notes)}</p>` : ""}
        ${clip(b.note, 1000) ? `<p>Rep note: ${esc(clip(b.note, 1000))}</p>` : ""}
        <p style="color:#9aa4ae;font-size:11px">HCPS Dealer Hub request ${esc(req.id)}</p></div>`;
      const ev = { subject: `HCPS: ${req.service} — ${req.company || req.contact_name || "Dealer"}`,
        body: { contentType: "HTML", content: bodyHtml }, location: { displayName: where } };
      if (win.isAllDay) { ev.isAllDay = true; ev.start = { dateTime: win.allDayDate + "T00:00:00.0000000", timeZone: SCHED_TZ }; ev.end = { dateTime: nextDay(win.allDayDate) + "T00:00:00.0000000", timeZone: SCHED_TZ }; }
      else { ev.isAllDay = false; ev.start = { dateTime: win.start, timeZone: SCHED_TZ }; ev.end = { dateTime: win.end, timeZone: SCHED_TZ }; }
      // Only invite the dealer (sends a meeting invite) when the operator explicitly opts in.
      if (b.invite_dealer && req.email && EMAIL_RE.test(req.email)) {
        ev.attendees = [{ emailAddress: { address: req.email, name: req.contact_name || req.company || "" }, type: "required" }];
        ev.responseRequested = true;
      }
      try {
        const tok = await graphToken();
        const sameMailbox = calendar.mailbox && String(calendar.mailbox).toLowerCase() === repEmail.toLowerCase();
        let res;
        if (sameMailbox && calendar.event_id) {
          res = await graphReq(tok, "PATCH", `/users/${encodeURIComponent(repEmail)}/events/${encodeURIComponent(calendar.event_id)}`, ev);
          if (res.status === 404) res = await graphReq(tok, "POST", `/users/${encodeURIComponent(repEmail)}/events`, ev);
        } else {
          // Rep changed (or first booking) — remove the old event on the old mailbox, then create fresh.
          if (calendar.mailbox && calendar.event_id) { try { await graphReq(tok, "DELETE", `/users/${encodeURIComponent(calendar.mailbox)}/events/${encodeURIComponent(calendar.event_id)}`); } catch (e) {} }
          res = await graphReq(tok, "POST", `/users/${encodeURIComponent(repEmail)}/events`, ev);
        }
        if (res.ok && res.json && res.json.id) {
          calendar = { mailbox: repEmail, event_id: res.json.id, web_link: res.json.webLink || null, start: ev.start.dateTime, end: ev.end.dateTime, invited: !!ev.attendees, updated_at: new Date().toISOString() };
          calMsg = "Outlook event created on " + repEmail + (ev.attendees ? " · dealer invited" : "");
        } else if (res.status === 403) { calWarn = "Outlook denied the write — grant the Graph app Calendars.ReadWrite (admin consent) in Azure, then re-assign."; }
        else { calWarn = "Outlook error: " + String((res.json && res.json.error && res.json.error.message) || res.text || "").slice(0, 180); }
      } catch (e) { calWarn = "Couldn't reach Outlook: " + String(e.message || e).slice(0, 120); }
    }

    // --- Zoho follow-up task (best-effort) ---
    let zoho = req.zoho && typeof req.zoho === "object" ? { ...req.zoho } : {};
    if (!zoho.task_id) {
      const zt = await zohoTask(req, `HCPS ${req.service} — ${req.company || ""}`.trim(),
        `Scheduled with ${clip(b.rep_name, 120) || repEmail}${date ? " on " + date : ""}${timeText ? " " + timeText : ""}. Mode: ${mode || "—"}.`, date);
      if (zt) zoho = { ...zoho, ...zt, at: new Date().toISOString() };
    }

    // --- Persist the scheduled request ---
    const patch = {
      status: "scheduled", rep_name: clip(b.rep_name, 120) || req.rep_name || repEmail,
      preferred_date: date || req.preferred_date, preferred_time: timeText || req.preferred_time,
      mode: mode || req.mode, dealer_id: dealer_id || null, calendar, zoho,
    };
    const out = await patchReq(b.id, patch);

    // --- Dealer 360 timeline ---
    await logActivity(dealer_id, `Appointment scheduled — ${req.service}`,
      `Assigned to ${patch.rep_name}${date ? " · " + date : ""}${timeText ? " " + timeText : ""}${mode ? " · " + (mode === "remote" ? "Remote" : "In person") : ""}. Requested via Dealer Hub.`,
      req.email, me.name || me.email);

    return json(200, { ok: true, request: out, calendar: { ok: !!calMsg, message: calMsg || calWarn }, zoho: { ok: !!zoho.task_id }, dealer_linked: !!dealer_id });
  }

  // -- Complete: notes + move to CRM history + optional follow-up task --
  if (b.action === "complete") {
    if (!b.id) return json(400, { error: "id required" });
    const req = await getReq(b.id); if (!req) return json(404, { error: "not found" });
    const notes = clip(b.completed_notes, 4000);
    const patch = { status: "completed", completed_notes: notes || req.completed_notes || null };
    if (clip(b.followup)) patch.followup = clip(b.followup, 2000);
    const out = await patchReq(b.id, patch);

    await logActivity(req.dealer_id, `Training completed — ${req.service}`,
      (notes ? notes + " " : "") + `(Rep: ${req.rep_name || "—"})`, req.email, me.name || me.email);
    let task = null;
    if (b.create_task && clip(b.followup)) {
      task = await addFollowupTask(req.dealer_id, `Follow-up: ${req.service} — ${req.company || ""}`.trim(), clip(b.followup, 2000), dateOr(b.followup_due), req.rep_name, me.name || me.email);
    }
    return json(200, { ok: true, request: out, task });
  }

  // -- Cancel: mark cancelled + remove the Outlook event if one exists --
  if (b.action === "cancel") {
    if (!b.id) return json(400, { error: "id required" });
    const req = await getReq(b.id); if (!req) return json(404, { error: "not found" });
    if (graphEnv() && req.calendar && req.calendar.mailbox && req.calendar.event_id) {
      try { const tok = await graphToken(); await graphReq(tok, "DELETE", `/users/${encodeURIComponent(req.calendar.mailbox)}/events/${encodeURIComponent(req.calendar.event_id)}`); } catch (e) {}
    }
    const out = await patchReq(b.id, { status: "cancelled", calendar: null });
    return json(200, { ok: true, request: out });
  }

  // -- Reopen a cancelled/completed request back to the queue --
  if (b.action === "reopen") {
    if (!b.id) return json(400, { error: "id required" });
    const out = await patchReq(b.id, { status: "requested" });
    return json(200, { ok: true, request: out });
  }

  return json(400, { error: "unknown action" });
}

// ============================ ENTRY ============================
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "Scheduling isn't configured yet." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad JSON" }); }

  const ADMIN = new Set(["queue", "assign", "complete", "cancel", "reopen", "set_dealer", "search_dealers"]);
  if (ADMIN.has(b.action)) {
    const me = await whoami(event);
    if (!me) return json(401, { error: "unauthorized" });
    try { return await adminHandler(me, b); }
    catch (e) {
      if (/relation|does not exist|service_requests/i.test(String(e.message || e))) return json(200, { ok: false, error: "tables_missing", message: "Run supabase/service_requests.sql first." });
      return json(500, { error: "Server error: " + String(e.message || e).slice(0, 160) });
    }
  }

  // -------- PUBLIC intake (no auth) --------
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

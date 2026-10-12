// MI-1b — Manufacturer Report History (Connect 360 · Sales Data & Analytics). Authorized for development by
// Angelo 2026-10-10; see CLAUDE.md §18. Registers the files manufacturers send — order/sales exports,
// commission statements, dealer-intelligence reports — on the Manufacturer Center register (mfr_sources),
// keeps the original file in the PRIVATE bucket mfr-sources, and records every decision in mfr_source_events.
//
// It never imports anything: no monthly_sales, commission, dealer, alias, contact, task, deal or Zoho write.
// Registering or accepting a dealer report never publishes it (publication is a separate step that needs
// MI-1c intelligence, which does not exist yet — the database refuses it).
//
// Who: president / admin / owner only (Connect 360 staff sign-in, RULE 9). Reps and Relations: 403.
// The acting person is ALWAYS the verified sign-in, never a field in the request.
//
//   POST {action:"list", manufacturer?}                                   → manufacturers, reports, events
//   POST {action:"register", manufacturer, kind, title?, file_name, content_base64, received_date,
//         prepared_date?, period_start:"YYYY-MM", period_end:"YYYY-MM", supersedes_id?, supersede_reason?, note?}
//   POST {action:"decide", id, decision:"accepted"|"rejected", reason?}
//   POST {action:"publication", id, publication:"publish"|"withdraw", reason?}
//   POST {action:"link_batch", id, batch_id}
//   POST {action:"download", id}                                          → short-lived signed URL (2 minutes)
//   POST {action:"orphans"}  → READ-ONLY: stored report files no register record points to (see below)
//
// NOT in MI-1b: Sales Report Import and Commission Report Import do not register their files here yet. That is a
// later, separately approved unit; until then this register holds only the files a person registers on the page.
//
// Files stored before a database refusal. Register stores the file FIRST (so a record never points at a missing
// file), then asks the database. If the database refuses (e.g. a dealer report for a period that already has one),
// the file stays in the private bucket at its hash-named path, unregistered, and the reply says so
// (file_stored:true + storage_path). It is harmless — private, and reused as-is if the same file is registered
// later. "orphans" lists every such file: a path under reports/ that no mfr_sources row names. Nothing here
// deletes a file. A person may remove one only after re-checking, right before deleting, that no record names
// that exact path (a registration of the same file may be in flight) — that cleanup is not automated.
const crypto = require("crypto");
const { flagOn } = require("./_flags.js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET = "mfr-sources";
const ADMIN = new Set(["president", "admin", "owner"]);
const KINDS = ["sales_export", "commission_statement", "dealer_report"];
const MAX_BYTES = 4 * 1024 * 1024;   // a Netlify function request is capped near 6 MB; base64 adds a third
// The extension decides the stored type; the bytes must agree (a renamed file is refused).
const TYPES = {
  pdf:  { mime: "application/pdf", sniff: b => b.slice(0, 5).toString("latin1") === "%PDF-" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sniff: b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  xls:  { mime: "application/vnd.ms-excel", sniff: b => b.slice(0, 8).toString("hex") === "d0cf11e0a1b11ae1" },
  csv:  { mime: "text/csv", sniff: b => !b.includes(0) },
};
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const e = encodeURIComponent;

async function sbGet(p) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H() }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json(); }
async function sbGetAll(base, order) {
  const PAGE = 1000; let from = 0, out = [];
  for (;;) { const sep = base.includes("?") ? "&" : "?"; const rows = await sbGet(`${base}${sep}order=${order}&limit=${PAGE}&offset=${from}`);
    out = out.concat(rows); if (rows.length < PAGE) return out; from += PAGE; }
}
// RPC: the database function is the authority. Its refusal (mi1b_… / a constraint name) is passed on as a code.
async function rpc(fn, p) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...H(), "content-type": "application/json" }, body: JSON.stringify({ p }) });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch (x) { body = { message: text }; }
  if (r.ok) return { ok: true, body };
  const msg = String((body && body.message) || text || "").slice(0, 500);
  const m = msg.match(/\b(mi1b_[a-z_]+|mfr_report_guard)\b/) || msg.match(/constraint "([a-z0-9_]+)"/) || msg.match(/\b(duplicate key)\b/);
  return { ok: false, status: r.status, code: m ? m[1].replace(/ /g, "_") : "database_error", message: msg };
}
const refusal = rr => json(/^mi1b_(bad|actor|received|reason|supersede)|report_shape|catalog_shape|publication|batch_link/.test(rr.code) ? 422 : (rr.status >= 500 ? 502 : 409),
  { error: rr.code, message: rr.message });

async function whoami(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim(); if (!tok) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null; const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase(); if (!email) return null;
    const s = await sbGet(`staff_users?email=eq.${e(email)}&select=email,role,active,name`); const su = s && s[0];
    if (!su || su.active === false) return null;
    return { email, role: su.role || "rep", name: su.name || email };
  } catch (x) { return null; }
}

// Dates. Today in Chicago (where HCPS works) — a received date can't be in the future.
const today = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })).toISOString().slice(0, 10);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const monthStart = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || "") ? m + "-01" : null;
const monthEnd = m => { if (!monthStart(m)) return null; const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const clean = (v, n) => { const s = v == null ? "" : String(v).trim(); return s ? s.slice(0, n) : null; };

const SRC_COLS = "id,manufacturer,kind,title,file_name,file_sha256,file_size,content_type,received_date,prepared_date,prepared_date_status," +
  "report_period_start,report_period_end,status,accepted_by,accepted_at,decided_reason,supersedes_id,supersede_reason,publication_status," +
  "published_at,published_by,import_batch_id,note,created_at,created_by";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "cache-control": "no-store" } };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "not_configured" });
  const me = await whoami(event);
  if (!me) return json(401, { error: "sign_in_required" });
  if (!ADMIN.has(me.role)) return json(403, { error: "management_only", message: "Manufacturer report history is for President / Admin." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (x) { return json(400, { error: "bad_json" }); }
  const actor = me.email;

  if (b.action === "list") {
    const mfr = clean(b.manufacturer, 80);
    let manufacturers, reports, events = [];
    try {
      [manufacturers, reports] = await Promise.all([
        sbGetAll("manufacturers?select=slug,name", "slug"),
        sbGetAll(`mfr_sources?kind=in.(${KINDS.join(",")})${mfr ? `&manufacturer=eq.${e(mfr)}` : ""}&select=${SRC_COLS}`, "id.desc")]);
      const ids = reports.map(r => r.id);
      for (let i = 0; i < ids.length; i += 200)
        events = events.concat(await sbGetAll(`mfr_source_events?source_id=in.(${ids.slice(i, i + 200).join(",")})&select=id,source_id,action,actor,reason,detail,at`, "id"));
    } catch (x) { return json(503, { error: "unreadable", message: "Report history could not be read just now: " + String(x.message || x).slice(0, 200) }); }
    const bySrc = {}; for (const ev of events) (bySrc[ev.source_id] = bySrc[ev.source_id] || []).push(ev);
    return json(200, { ok: true, kinds: KINDS, max_bytes: MAX_BYTES, manufacturers, reports: reports.map(r => ({ ...r, events: bySrc[r.id] || [] })) });
  }

  if (b.action === "register") {
    const mfr = clean(b.manufacturer, 80), kind = String(b.kind || ""), fileName = clean(b.file_name, 200);
    if (!mfr || KINDS.indexOf(kind) < 0) return json(422, { error: "mi1b_bad_kind", message: "Choose the manufacturer and what kind of report this is." });
    if (!fileName) return json(422, { error: "file_name_required" });
    const ext = (fileName.match(/\.([a-z0-9]+)$/i) || [])[1]; const T = ext && TYPES[ext.toLowerCase()];
    if (!T) return json(422, { error: "file_type_not_allowed", message: "Only PDF, XLSX, XLS or CSV report files are kept." });
    if (typeof b.content_base64 !== "string" || !b.content_base64) return json(422, { error: "file_required" });
    const bytes = Buffer.from(b.content_base64, "base64");
    if (!bytes.length) return json(422, { error: "file_empty" });
    if (bytes.length > MAX_BYTES) return json(413, { error: "file_too_large", message: `Files up to ${MAX_BYTES / 1048576} MB.` });
    if (!T.sniff(bytes)) return json(422, { error: "file_type_mismatch", message: `The file's contents are not a .${ext.toLowerCase()} file.` });
    const received = String(b.received_date || ""), prepared = b.prepared_date ? String(b.prepared_date) : null;
    if (!isDate(received)) return json(422, { error: "mi1b_received_date_required", message: "Enter the date HCPS received the file." });
    if (received > today()) return json(422, { error: "received_in_future", message: "The received date can't be in the future." });
    if (prepared !== null && (!isDate(prepared) || prepared > received))
      return json(422, { error: "bad_prepared_date", message: "The manufacturer's prepared date must be a real date on or before the received date — or left empty when the report doesn't state one." });
    const ps = monthStart(b.period_start), pe = monthEnd(b.period_end);
    if (!ps || !pe || ps > pe) return json(422, { error: "mi1b_bad_period", message: "Enter the months the report covers (from ≤ to)." });
    if (ps > received) return json(422, { error: "mi1b_bad_period", message: "The report period can't start after the file was received." });
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const storagePath = `reports/${mfr}/${kind}/${sha}.${ext.toLowerCase()}`;
    // Idempotence first: the same file for this manufacturer is never stored or registered twice.
    let existing, mrow;
    try {
      [existing, mrow] = await Promise.all([
        sbGet(`mfr_sources?manufacturer=eq.${e(mfr)}&file_sha256=eq.${sha}&select=${SRC_COLS}`),
        sbGet(`manufacturers?slug=eq.${e(mfr)}&select=slug`)]);
    } catch (x) { return json(503, { error: "unreadable", message: String(x.message || x).slice(0, 200) }); }
    if (existing && existing[0]) {
      if (existing[0].kind !== kind) return json(409, { error: "mi1b_hash_registered_as_other_kind",
        message: `This exact file is already registered for this manufacturer as ${existing[0].kind} (record ${existing[0].id}).`, report: existing[0] });
      return json(200, { ok: true, existing: true, report: existing[0], message: `Already registered (record ${existing[0].id}) — nothing new was stored.` });
    }
    if (!(mrow && mrow[0])) return json(422, { error: "unknown_manufacturer" });
    // Keep the original file (private bucket). The path is the file's own hash, so an earlier, interrupted
    // attempt that already stored it holds exactly these bytes.
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, { method: "POST",
      headers: { ...H(), "content-type": T.mime, "x-upsert": "false", "cache-control": "no-store" }, body: bytes });
    if (!up.ok) {
      const t = (await up.text()).slice(0, 300);
      if (!(up.status === 409 || /already exists|Duplicate/i.test(t))) return json(502, { error: "upload_failed", message: "The file could not be stored, so nothing was registered: " + t });
    }
    const rr = await rpc("hcps_mfr_report_register", { manufacturer: mfr, kind, title: clean(b.title, 200) || fileName, file_name: fileName,
      file_sha256: sha, storage_path: storagePath, file_size: bytes.length, content_type: T.mime, received_date: received, prepared_date: prepared || "",
      report_period_start: ps, report_period_end: pe, supersedes_id: b.supersedes_id != null && b.supersedes_id !== "" ? String(parseInt(b.supersedes_id, 10)) : "",
      supersede_reason: clean(b.supersede_reason, 1000) || "", note: clean(b.note, 1000) || "", actor });
    if (!rr.ok) { const out = refusal(rr); const o = JSON.parse(out.body);
      o.file_stored = true; o.storage_path = storagePath;
      o.file_note = "The original is kept privately but is NOT registered. Registering the same file later reuses it; nothing else uses it.";
      out.body = JSON.stringify(o); return out; }
    let rep = null; try { rep = (await sbGet(`mfr_sources?id=eq.${parseInt(rr.body.id, 10)}&select=${SRC_COLS}`))[0] || null; } catch (x) {}
    return json(200, { ok: true, existing: !!rr.body.existing, id: rr.body.id, report: rep, file_sha256: sha });
  }

  if (b.action === "decide") {
    const id = parseInt(b.id, 10); if (!(id > 0)) return json(400, { error: "id_required" });
    const rr = await rpc("hcps_mfr_report_decide", { id, decision: String(b.decision || ""), reason: clean(b.reason, 1000) || "", actor });
    return rr.ok ? json(200, rr.body) : refusal(rr);
  }
  if (b.action === "publication") {
    const id = parseInt(b.id, 10); if (!(id > 0)) return json(400, { error: "id_required" });
    // Publishing manufacturer dealer intelligence is OFF until a separately approved publishing phase turns the switch
    // phase2_flags.mi_intel_publish to exactly true (MI-1c review, 2026-10-11). An unreadable switch = off. The database
    // refuses it too (trigger mfr_sources_publication_gate), whatever path a write takes. Withdrawing is not gated.
    if (String(b.publication || "") === "publish" && !(await flagOn(sbGet, "mi_intel_publish")))
      return json(403, { error: "publication_not_authorized", message: "Publishing manufacturer dealer intelligence is not authorized yet. Accepted and imported reports stay unpublished until the publishing phase is approved." });
    const rr = await rpc("hcps_mfr_report_publication", { id, action: String(b.publication || ""), reason: clean(b.reason, 1000) || "", actor });
    return rr.ok ? json(200, rr.body) : refusal(rr);
  }
  if (b.action === "link_batch") {
    const id = parseInt(b.id, 10), bid = String(b.batch_id || "");
    if (!(id > 0) || !/^[0-9a-f-]{36}$/i.test(bid)) return json(400, { error: "id_and_batch_required" });
    const rr = await rpc("hcps_mfr_report_link_batch", { id, batch_id: bid, actor });
    return rr.ok ? json(200, rr.body) : refusal(rr);
  }
  if (b.action === "download") {
    const id = parseInt(b.id, 10); if (!(id > 0)) return json(400, { error: "id_required" });
    let row; try { row = (await sbGet(`mfr_sources?id=eq.${id}&kind=in.(${KINDS.join(",")})&select=id,storage_path,file_name`))[0]; }
    catch (x) { return json(503, { error: "unreadable" }); }
    if (!row || !row.storage_path) return json(404, { error: "not_found" });
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${row.storage_path}`, { method: "POST",
      headers: { ...H(), "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 120 }) });
    if (!r.ok) return json(502, { error: "sign_failed" });
    const s = await r.json(); const signed = s.signedURL || s.signedUrl;
    if (!signed) return json(502, { error: "sign_failed" });
    return json(200, { ok: true, url: `${SUPABASE_URL}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}&download=${e(row.file_name || "report")}`, expires_in: 120 });
  }
  if (b.action === "orphans") {
    // Read-only. Walk reports/<manufacturer>/<kind>/ and compare with every report record's storage_path.
    const list = async prefix => { let out = [], offset = 0;
      for (;;) { const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, { method: "POST", headers: { ...H(), "content-type": "application/json" },
          body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }) });
        if (!r.ok) throw new Error(`storage list ${r.status}`); const rows = await r.json();
        out = out.concat(rows); if (rows.length < 1000) return out; offset += 1000; } };
    let files = [], rows;
    try {
      for (const m of (await list("reports/")).filter(x => !x.id))
        for (const k of (await list(`reports/${m.name}/`)).filter(x => !x.id && KINDS.indexOf(x.name) >= 0))
          for (const f of (await list(`reports/${m.name}/${k.name}/`)).filter(x => x.id))
            files.push({ path: `reports/${m.name}/${k.name}/${f.name}`, size: f.metadata && f.metadata.size, created_at: f.created_at });
      rows = await sbGetAll(`mfr_sources?storage_path=like.reports%2F*&select=id,storage_path`, "id");
    } catch (x) { return json(503, { error: "unreadable", message: "Could not compare the stored files with the register: " + String(x.message || x).slice(0, 200) }); }
    const named = new Set(rows.map(r => r.storage_path));
    return json(200, { ok: true, stored: files.length, registered: files.filter(f => named.has(f.path)).length,
      orphans: files.filter(f => !named.has(f.path)), note: "Read-only. Nothing is deleted here." });
  }
  // ── MI Inbox Automation, Phase B: what the capture found (read-only) and a person's decisions on its queue ──
  if (b.action === "capture_status") {
    try {
      const [state, runs, profiles, items, flags] = await Promise.all([
        sbGet("mfr_report_capture_state?select=mailbox,checkpoint_at,overlap_minutes,lock_until,last_run_at,last_ok_at,last_error&order=mailbox"),
        sbGet("mfr_report_capture_runs?select=id,mailbox,started_at,finished_at,checkpoint_before,checkpoint_after,complete,counts,error&order=id.desc&limit=15"),
        sbGet("mfr_report_profiles?select=id,code,manufacturer,kind,label,status,auto_register,auto_import,rules,note&order=status,manufacturer,id"),
        sbGetAll("mfr_report_items?select=state,attention,resolved_at", "id"),
        sbGet("app_settings?key=eq.phase2_flags&select=value")]);
      const by = {}; let open = 0;
      for (const i of items) { by[i.state] = (by[i.state] || 0) + 1; if (i.attention && !i.resolved_at) open++; }
      const f = (flags && flags[0] && flags[0].value) || {};
      return json(200, { ok: true, switch_on: f.mi_report_capture === true, state, runs, profiles, counts: by, needs_attention: open });
    } catch (x) { return json(503, { error: "capture_not_installed_or_unreadable", message: String(x.message || x).slice(0, 300) }); }
  }
  if (b.action === "inbox" || b.action === "attention") {
    const mfr = clean(b.manufacturer, 80), st = clean(b.status, 30), per = /^\d{4}-\d{2}$/.test(b.period || "") ? b.period : null;
    const q = (clean(b.q, 120) || "").toLowerCase();
    const days = Math.min(Math.max(parseInt(b.days, 10) || 120, 1), 800);
    const since = new Date(Date.now() - days * 864e5).toISOString();
    let msgs, items, sources = [];
    try {
      if (b.action === "attention") {
        items = await sbGetAll("mfr_report_items?attention=not.is.null&resolved_at=is.null&select=*", "id");
        const ids = [...new Set(items.map(i => i.message_id))]; msgs = [];
        for (let k = 0; k < ids.length; k += 200) msgs = msgs.concat(await sbGet(`mfr_report_messages?id=in.(${ids.slice(k, k + 200).join(",")})&select=*`));
      } else {
        msgs = await sbGetAll(`mfr_report_messages?received_at=gte.${e(since)}${mfr ? `&manufacturer=eq.${e(mfr)}` : ""}&select=*`, "received_at.desc");
        items = [];
        const ids = msgs.map(m => m.id);
        for (let k = 0; k < ids.length; k += 200) items = items.concat(await sbGet(`mfr_report_items?message_id=in.(${ids.slice(k, k + 200).join(",")})&select=*&order=id`));
      }
      const sids = [...new Set(items.map(i => i.source_id).filter(Boolean))];
      for (let k = 0; k < sids.length; k += 200) sources = sources.concat(await sbGet(`mfr_sources?id=in.(${sids.slice(k, k + 200).join(",")})&select=id,title,status,kind,report_period_start,report_period_end,publication_status`));
    } catch (x) { return json(503, { error: "unreadable", message: "The capture inbox could not be read just now: " + String(x.message || x).slice(0, 200) }); }
    const src = new Map(sources.map(r => [r.id, r]));
    const byMsg = new Map(msgs.map(m => [m.id, { ...m, items: [] }]));
    for (const i of items) { const m = byMsg.get(i.message_id); if (m) m.items.push({ ...i, source: i.source_id ? src.get(i.source_id) || null : null }); }
    let list = [...byMsg.values()];
    const inPeriod = i => !per || (i.period_start && i.period_start.slice(0, 7) <= per && i.period_end && i.period_end.slice(0, 7) >= per);
    list = list.filter(m => (!mfr || m.manufacturer === mfr || m.items.some(i => i.manufacturer === mfr))
      && (!st || m.items.some(i => i.state === st || (st === "attention" && i.attention && !i.resolved_at)))
      && (!per || m.items.some(inPeriod))
      && (!q || [m.subject, m.from_address, m.from_name, ...m.items.map(i => i.file_name)].some(v => String(v || "").toLowerCase().includes(q))));
    list.sort((x, y) => String(y.received_at).localeCompare(String(x.received_at)));
    const total = list.length, off = Math.max(parseInt(b.offset, 10) || 0, 0), lim = Math.min(Math.max(parseInt(b.limit, 10) || 100, 1), 300);
    return json(200, { ok: true, total, offset: off, messages: list.slice(off, off + lim) });
  }
  if (b.action === "resolve") {
    const id = parseInt(b.item_id, 10); if (!(id > 0)) return json(400, { error: "item_id_required" });
    const act = String(b.decision || "");
    if (["dismiss", "ignore", "retry"].indexOf(act) < 0) return json(400, { error: "bad_decision" });
    const reason = clean(b.reason, 1000); if (!reason || reason.length < 3) return json(422, { error: "reason_required", message: "Say why — it is kept in the audit trail." });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hcps_mfr_capture_resolve`, { method: "POST", headers: { ...H(), "content-type": "application/json" },
      body: JSON.stringify({ p: { item_id: id, action: act, reason, actor: "staff:" + actor } }) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (x) { j = { message: t }; }
    if (r.ok) return json(200, j);
    const code = (String((j && j.message) || "").match(/\bcapture_[a-z_]+/) || ["database_error"])[0];
    return json(/capture_(nothing|cannot)/.test(code) ? 409 : /capture_(reason|actor|bad)/.test(code) ? 422 : 502, { error: code, message: String((j && j.message) || t).slice(0, 300) });
  }
  // Phase D: READ-ONLY trial of a manufacturer's report profiles over the mailbox history — what activation WOULD register.
  // GET-only Graph reads; nothing is stored, registered or recorded. Paged by cursor (each call stays inside its budget).
  if (b.action === "profile_trial") {
    const slug = clean(b.manufacturer, 80); if (!slug) return json(400, { error: "manufacturer_required" });
    const from = isDate(b.from) ? b.from : "2025-10-01", to = isDate(b.to) ? b.to : "2026-12-31";
    const [profiles, srcs, state] = await Promise.all([
      sbGet(`mfr_report_profiles?manufacturer=eq.${e(slug)}&status=in.(active,draft)&select=id,code,manufacturer,kind,label,status,rules,auto_register&order=id`),
      sbGetAll(`mfr_sources?manufacturer=eq.${e(slug)}&file_sha256=not.is.null&select=id,kind,file_sha256`, "id"),
      sbGet("mfr_report_capture_state?select=mailbox&order=mailbox&limit=1")]);
    if (!profiles.length) return json(404, { error: "no_profiles", message: "This manufacturer has no report profile." });
    const known = {}; for (const s2 of srcs) known[s2.file_sha256] = { id: s2.id, kind: s2.kind };
    const { liveDeps } = require("./_report_capture.js");
    const T = require("./_profile_trial.js");
    let r; try { r = await T.trial({ slug, profiles, mailbox: (state[0] || {}).mailbox, from, to, cursor: b.cursor, seen: Array.isArray(b.seen) ? b.seen.slice(0, 2000) : [],
      budget_ms: b.budget_ms, known }, liveDeps(process.env)); }
    catch (x) { return json(503, { error: "trial_failed", message: String(x.message || x).slice(0, 300), throttled: !!x.throttled }); }
    return json(200, { ok: true, read_only: true, manufacturer: slug, window: [from, to],
      profiles: profiles.map(p => ({ code: p.code, kind: p.kind, status: p.status, label: p.label, expected: (p.rules || {}).expected || null })), ...r });
  }

  // Phase D: the Manufacturer Intelligence dashboard (read-only) — arrivals, missing periods, import status, pending work,
  // and the monthly reconciliation (previous month, ready on the 15th; late reports keep processing).
  if (b.action === "dashboard") {
    try {
      const CC = require("./_commission_coverage.js"), D = require("./_mi_dashboard.js");
      const [profiles, sources, items, mfrs, cfg, rows] = await Promise.all([
        sbGet("mfr_report_profiles?select=id,code,manufacturer,kind,label,status,rules&order=manufacturer,id"),
        sbGetAll("mfr_sources?kind=in.(sales_export,commission_statement,dealer_report)&select=id,manufacturer,kind,title,status,received_date,report_period_start,report_period_end,import_batch_id,publication_status", "id"),
        sbGetAll("mfr_report_items?select=id,manufacturer,kind,state,attention,resolved_at,period_start,period_end,profile_id", "id"),
        sbGet("manufacturers?select=slug,name"),
        sbGet("app_settings?key=eq.commission_config&select=value"),
        sbGetAll("monthly_sales?select=id,manufacturer,period,source,external_ref,line_type,amount,commission,billed_amount", "id")]);
      const v = cfg && cfg[0] && cfg[0].value; const ssr = v && Array.isArray(v.statement_sales_reports) ? v.statement_sales_reports : CC.DEFAULT_STATEMENT_SALES_REPORTS;
      const cov = CC.coverage(rows, { statement_sales_reports: ssr }).detail;
      const shipto = { held: Math.max(0, parseInt(b.shipto_held, 10) || 0), needs_review: Math.max(0, parseInt(b.shipto_needs_review, 10) || 0) };
      return json(200, Object.assign({ ok: true, read_only: true }, D.build({ today: today(), months: b.months, profiles, sources, items, coverage: cov, manufacturers: mfrs, shipto })));
    } catch (x) { return json(503, { error: "unreadable", message: "The dashboard could not read its data just now: " + String(x.message || x).slice(0, 200) }); }
  }

  if (b.action === "capture_now") {
    // A person may run the hourly capture now (e.g. to verify the rollout). Same switch, same lease, same rules.
    if (!(await flagOn(sbGet, "mi_report_capture"))) return json(403, { error: "capture_switch_off", message: "Automatic report capture is switched off." });
    try {
      const { runCapture, liveDeps } = require("./_report_capture.js");
      const deps = liveDeps(process.env);
      const boxes = await sbGet("mfr_report_capture_state?select=mailbox&order=mailbox");
      const internal = [...new Set(String(process.env.GRAPH_MAILBOXES || "").split(/[,\s]+/).map(x => x.trim().toLowerCase().split("@")[1]).filter(Boolean))];
      const runs = []; for (const x of boxes) runs.push(await runCapture({ mailbox: x.mailbox, budget_ms: 20000 / Math.max(1, boxes.length), internal_domains: internal }, deps));
      return json(200, { ok: true, runs });
    } catch (x) { return json(502, { error: "capture_failed", message: String(x.message || x).slice(0, 300) }); }
  }
  return json(400, { error: "unknown_action" });
};
// For tests only.
exports._internals = { TYPES, monthEnd, isDate, MAX_BYTES };

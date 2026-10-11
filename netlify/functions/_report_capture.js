/* MI Inbox Automation — Phase B: automatic capture of manufacturer report email (CLAUDE.md §18, approved 2026-10-11).
   One run = one mailbox, one lease, one time budget:
     1. begin        take the mailbox lease (database refuses when phase2_flags.mi_report_capture is not exactly true)
     2. retries      re-process queued exceptions that are due (durable retry queue, backoff in the database)
     3. discovery    list ALL folders from (checkpoint − overlap) to the run's start, oldest first, following paging;
                     every report email is recorded, each attachment (or a body-only report) handled on its own:
                       download → SHA-256 → read-only content inspection → profile match → period → register / classify
                       / exception. A failure becomes a queued exception and never blocks later email.
     4. finish       move the checkpoint to the last email that is accounted for (the database refuses anything later),
                     release the lease, write the run row.
   Registration = MI-1b's own register (hcps_mfr_report_register through hcps_mfr_capture_register): the original file
   goes to the private bucket at reports/<mfr>/<kind>/<sha>.<ext>; the same file already registered is LINKED to that
   record — never a duplicate. Nothing here imports, accepts, publishes, edits dealers / contacts / deals or sends mail.
   Every Graph call is a GET (the shared client from _report_inventory.js). */
const crypto = require("crypto");
const INV = require("./_report_inventory.js").shared;

const KINDS = ["sales_export", "commission_statement", "dealer_report"];
const KIND_LABEL = { sales_export: "order / sales export", commission_statement: "commission statement", dealer_report: "dealer report" };
const MIME = { pdf: "application/pdf", csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel", eml: "message/rfc822" };
const MAX_BYTES = 15e6;
const ACTOR = "system:report-capture";

const pad2 = n => String(n).padStart(2, "0");
const lastDay = ym => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const chicagoDate = iso => new Date(new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago" })).toISOString().slice(0, 10);
const prevMonth = ym => { let [y, m] = ym.split("-").map(Number); m--; if (!m) { m = 12; y--; } return `${y}-${pad2(m)}`; };
const domainOf = a => { const m = String(a || "").toLowerCase().match(/@([^>\s]+)$/); return m ? m[1] : ""; };
const safeRe = s => { try { return new RegExp(s, "i"); } catch (e) { return null; } };

/* ── Profiles ────────────────────────────────────────────────────────────── */
function senderOk(profile, from) {
  const s = (profile.rules && profile.rules.senders) || {};
  const addr = String(from || "").toLowerCase(), dom = domainOf(addr);
  return (s.domains || []).map(x => x.toLowerCase()).includes(dom) || (s.addresses || []).map(x => x.toLowerCase()).includes(addr)
    || (s.forwarders || []).map(x => x.toLowerCase()).includes(addr);
}
// Does this file satisfy the profile's file-name, format and content rules? (reader results are passed in)
function fileOk(profile, att) {
  const r = profile.rules || {};
  // A body-only report (the email itself is the source file) fits only a profile that allows one.
  if (att.format === "eml") return r.body_only ? { ok: true } : { ok: false, why: "body-only report" };
  if (r.formats && r.formats.length && !r.formats.includes(att.format)) return { ok: false, why: `format ${att.format || "unknown"}` };
  if (r.file_name) { const re = safeRe(r.file_name); if (!re || !re.test(att.name || "")) return { ok: false, why: "file name" }; }
  const c = r.content || {};
  const sig = new Set(att.signals || []);
  if ((c.pdf_signals_all || []).some(x => !sig.has(x))) return { ok: false, why: "PDF text" };
  const cols = new Set((att.sheets || []).flatMap(s => s.columns || []));
  if ((c.columns_all || []).some(x => !cols.has(x))) return { ok: false, why: "columns" };
  if ((c.columns_any || []).length && !(c.columns_any || []).some(x => cols.has(x))) return { ok: false, why: "columns" };
  if ((c.columns_none || []).some(x => cols.has(x))) return { ok: false, why: "columns" };
  const names = (att.sheets || []).map(s => String(s.name || "").toLowerCase());
  if ((c.sheet_names_any || []).length && !(c.sheet_names_any || []).some(n => names.includes(String(n).toLowerCase()))) return { ok: false, why: "sheet names" };
  if (c.reader === "strongback-dealer-report" && !(att.reader && att.reader.ok)) return { ok: false, why: "not a Strongback dealer report" };
  return { ok: true };
}

/* ── Period: the report's own evidence first; the received date only as the last, labelled fallback ── */
function periodOf(profile, att, msg) {
  const order = ((profile.rules || {}).period || {}).order || ["file_name", "content", "subject"];
  const P = (profile.rules || {}).period || {};
  const received = msg.received_at;
  const one = (ym, basis, extra) => ({ start: ym + "-01", end: lastDay(ym), basis, ...(extra || {}) });
  const found = {};
  const iso = String(att.name || "").match(/(?:^|[^0-9])(20\d\d)[-_ .](0[1-9]|1[0-2])(?![0-9])/);
  if (iso) found.file_name = one(`${iso[1]}-${iso[2]}`, "file_name");
  const yymm = String(att.name || "").match(/^(\d\d)(0[1-9]|1[0-2])\b/);
  if (yymm) found.file_name_yymm = one(`20${yymm[1]}-${yymm[2]}`, "file_name");
  if ((att.text_periods || []).length === 1) found.content = one(att.text_periods[0], "content");
  if (att.date_range) found.content_dates = { start: att.date_range.min + "-01", end: lastDay(att.date_range.max), basis: "content_dates" };
  if (att.reader && att.reader.ok && att.reader.period) found.reader = one(att.reader.period, "report");
  let subj = INV.periodGuess(msg.subject || "", received);
  if (subj && P.subject_year === "from_received") subj = INV.periodGuess(String(msg.subject || "").replace(/\b20\d\d\b/g, ""), received);
  if (subj) {
    const ps = subj.periods; const cum = !!(subj.cumulative && P.cumulative);
    const end = ps[ps.length - 1];
    found.subject = { start: (cum ? end.slice(0, 4) + "-01" : ps[0]) + "-01", end: lastDay(end), basis: "subject", cumulative: cum,
      combined: ps.length > 1 };
  }
  if (received) found.received_prior_month = one(prevMonth(chicagoDate(received).slice(0, 7)), "received_date_rule");
  // A file name and the file's own text that disagree are a conflict for a person, never a guess.
  if (found.file_name && found.content && found.file_name.start !== found.content.start)
    return { conflict: `file name says ${found.file_name.start.slice(0, 7)}, the report text says ${found.content.start.slice(0, 7)}` };
  for (const k of order) if (found[k]) return found[k];
  return null;
}

/* ── Content: read-only, in memory. Returns derived signals only. ───────── */
// The months covered by the date column(s) of a sales export (the most reliable period for an order export).
function dateRange(buf, asText) {
  try {
    const X = INV.xlsx();
    const wb = asText ? X.read(buf.toString("utf8"), { type: "string", sheetRows: 20000, cellDates: true })
                      : X.read(buf, { type: "buffer", sheetRows: 20000, cellDates: true, cellFormula: false, cellHTML: false, bookVBA: false });
    const months = [];
    for (const name of wb.SheetNames.slice(0, 3)) {
      const rows = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: null, raw: true });
      let hi = -1, cols = [];
      rows.slice(0, 15).forEach((r, i) => { const c = (r || []).map((h, j) => /date/i.test(String(h || "")) && String(h || "").length < 40 ? j : -1).filter(j => j >= 0);
        if (hi < 0 && c.length) { hi = i; cols = c; } });
      if (hi < 0) continue;
      for (const r of rows.slice(hi + 1)) for (const j of cols) {
        const v = r && r[j]; let d = null;
        if (v instanceof Date) d = v; else if (typeof v === "number" && v > 30000 && v < 80000) d = new Date(Date.UTC(1899, 11, 30) + v * 864e5);
        else if (typeof v === "string") { const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/) || null; if (m) d = new Date(Date.UTC(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]));
          else if (/^\d{4}-\d{2}-\d{2}/.test(v)) d = new Date(v.slice(0, 10) + "T12:00:00Z"); }
        if (d && !isNaN(d) && d.getUTCFullYear() > 2000 && d.getUTCFullYear() < 2100) months.push(d.toISOString().slice(0, 7));
      }
    }
    if (!months.length) return null;
    months.sort();
    return { min: months[0], max: months[months.length - 1], n: months.length };
  } catch (e) { return null; }
}

async function inspect(buf, name, deps) {
  const att = { name, sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  const kindOf = INV.magic(buf);
  if (kindOf === "pdf") {
    att.format = "pdf";
    try { Object.assign(att, await INV.pdfSignals(buf)); } catch (e) { att.unreadable = String(e.message || e).slice(0, 160); }
  } else if (kindOf === "zip" || kindOf === "ole") {
    try { att.sheets = INV.sheetSignals(buf, false); att.format = kindOf === "zip" ? "xlsx" : "xls"; att.date_range = dateRange(buf, false); }
    catch (e) { att.format = kindOf === "zip" ? "zip" : "ole"; }
  } else if (kindOf === "text") {
    att.format = /\.csv$/i.test(name || "") ? "csv" : "text";
    if (att.format === "csv") { try { att.sheets = INV.sheetSignals(buf, true).slice(0, 1); att.rows = Math.max(0, INV.countLines(buf) - 1); att.date_range = dateRange(buf, true); }
      catch (e) { att.unreadable = String(e.message || e).slice(0, 160); } }
  } else att.format = kindOf;
  att.suggested = INV.classifyContent(att) || INV.classifyName(name);
  return att;
}

// The MI-1c reader, only when a candidate profile asks for it (lazy: parsing a 17-page PDF costs a few seconds).
async function readDealerReport(buf, deps) {
  try {
    const parse = deps.parseDealerReport ? await deps.parseDealerReport(buf)
      : require("./_strongback_report.js").parseReport(await require("./_strongback_layout.js").extractLayout(buf));
    return { ok: !!(parse && parse.header && parse.header.through_month), period: parse.header.through_month || null,
      prepared_date: parse.header.prepared_date || null, errors: (parse.errors || []).length };
  } catch (e) { return { ok: false, why: String(e.code || e.message || e).slice(0, 120) }; }
}

/* ── Decision for one inspected file ─────────────────────────────────────── */
// Returns {outcome:'register'|'classified'|'exception', profile?, period?, attention?, detail?}
function decide(att, msg, profiles, who) {
  if (att.unreadable && !att.format) return { outcome: "exception", attention: "unreadable", detail: att.unreadable };
  const cands = profiles.filter(p => p.status !== "retired" && (!who.slug || p.manufacturer === who.slug) && senderOk(p, msg.from_address));
  const passes = cands.filter(p => fileOk(p, att).ok);
  const kinds = [...new Set(passes.map(p => p.kind))];
  if (kinds.length > 1) return { outcome: "exception", attention: "ambiguous_profile", detail: "matches " + passes.map(p => p.code).join(", ") };
  if (passes.length) {
    const prof = passes.find(p => p.status === "active") || passes[0];
    const per = periodOf(prof, att, msg);
    if (prof.status !== "active") return { outcome: "classified", profile: prof, period: per && !per.conflict ? per : null,
      detail: "profile not active (draft) — shown, not registered" };
    if (!per) return { outcome: "exception", attention: "period_unknown", profile: prof, detail: "the report does not state its period" };
    if (per.conflict) return { outcome: "exception", attention: "period_conflict", profile: prof, detail: per.conflict };
    return { outcome: prof.auto_register ? "register" : "classified", profile: prof, period: per, detail: null };
  }
  const reportLike = KINDS.includes(att.suggested);
  if (!reportLike) return { outcome: "classified", detail: att.suggested ? `${att.suggested} — not a report for Report History` : "not a report" };
  if (!who.slug) return { outcome: "exception", attention: "unknown_sender", detail: `${domainOf(msg.from_address) || msg.from_address} is not a known manufacturer` };
  const same = cands.filter(p => p.kind === att.suggested && p.status === "active");
  if (same.length) return { outcome: "exception", attention: "format_changed",
    detail: same.map(p => `${p.code}: ${fileOk(p, att).why}`).join("; ") };
  return { outcome: "exception", attention: "unidentified_type", detail: `looks like a ${KIND_LABEL[att.suggested]}; no profile for it` };
}

/* ── The run ─────────────────────────────────────────────────────────────── */
async function runCapture(o, deps) {
  const now = deps.now || Date.now;
  const started = now();
  const budget = Math.min(Math.max(+o.budget_ms || 22000, 3000), 25000);
  const deadline = started + budget, soft = deadline - Math.min(4000, Math.floor(budget / 3));
  const mailbox = String(o.mailbox || "").toLowerCase();
  const token = o.token || crypto.randomBytes(16).toString("hex");
  const counts = { listed: 0, candidates: 0, recorded: 0, registered: 0, linked: 0, classified: 0, exceptions: 0, retried: 0, skipped_settled: 0 };
  const b = await deps.db.rpc("hcps_mfr_capture_begin", { mailbox, token, lease_seconds: Math.ceil(budget / 1000) + 30 });
  if (b.busy) return { ok: true, busy: true, mailbox };
  const runId = b.run_id;
  const g = INV.graphClient(deps, deadline);
  const mb = encodeURIComponent(mailbox);
  const [profiles, mfrs] = await Promise.all([deps.db.get("mfr_report_profiles?status=in.(active,draft)&select=*&order=id"), deps.db.get("manufacturers?select=slug,name")]);
  const nameOf = s => ((mfrs || []).find(m => m.slug === s) || {}).name || s;
  const nameRes = (mfrs || []).filter(m => m && m.name && String(m.name).trim().length >= 5)
    .map(m => [new RegExp("\\b" + String(m.name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i"), m.slug]);
  const ctx = { internalDomains: o.internal_domains || [], tableNames: t => { for (const [re, s] of nameRes) if (re.test(t || "")) return s; return null; } };
  const bodyProfileFor = slug => profiles.some(p => p.manufacturer === slug && p.rules && p.rules.body_only);
  const RPC = (fn, p) => deps.db.rpc(fn, Object.assign({ mailbox, token, run_id: runId }, p));
  let error = null, complete = false, checkpoint = null, stopped = false, watermark = null, watermarkMoved = false;
  const KNOWN = new Map();

  // One item, start to finish. Throws only for "stop the run" (time budget / throttling).
  async function processItem(item, msg, who) {
    if (now() > soft) { const e = new Error("budget"); e.code = "budget"; throw e; }
    if (item.part === "listing") {          // the attachment list could not be read: read it again and record the items
      let items;
      try { items = await listItems({ id: msg.graph_id, hasAttachments: true, subject: msg.subject }, who); }
      catch (e) { if (e.code === "budget") throw e; return RPC("hcps_mfr_capture_fail", { item_id: item.id, attention: "listing_failed", detail: e.message }); }
      const rec = await RPC("hcps_mfr_capture_record", { message: dbMsg(msg), items: items.map(strip), relist: true });
      return processRecorded(rec, items, msg, who);
    }
    let buf, name = item.file_name || "";
    if (item.part === "body") {
      let body;
      try { body = await g.get(`/users/${mb}/messages/${encodeURIComponent(msg.graph_id)}?$select=body`, { prefer: ['outlook.body-content-type="text"'] }); }
      catch (e) { if (e.code === "budget") throw e; return RPC("hcps_mfr_capture_fail", { item_id: item.id, attention: "attachment_failed", detail: "body: " + e.message }); }
      const t = String((body.body && body.body.content) || "");
      const amounts = (t.match(/\$\s?\d[\d,]*(\.\d\d)?/g) || []).length, comm = (t.match(/commi?ss?ion/gi) || []).length;
      if (!(amounts >= 1 && (comm >= 1 || /commi?ss?ion/i.test(msg.subject || "")))) {
        counts.classified++;
        return RPC("hcps_mfr_capture_classify", { item_id: item.id, outcome: "classified", suggested: "not_a_report", manufacturer: who.slug || "",
          detail: "the email body holds no commission figures" });
      }
      // A body-only report: the original message (MIME) is the source file.
      try { buf = await g.get(`/users/${mb}/messages/${encodeURIComponent(msg.graph_id)}/$value`, { raw: true }); }
      catch (e) { if (e.code === "budget") throw e; return RPC("hcps_mfr_capture_fail", { item_id: item.id, attention: "attachment_failed", detail: "message source: " + e.message }); }
      name = (String(msg.subject || "report").replace(/[^\w .\-()&]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "report") + ".eml";
      const att = { name, format: "eml", sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length, suggested: "commission_statement",
        body: { amounts, commission_terms: comm } };
      return finishItem(item, msg, who, att, buf, profiles.filter(p => p.rules && p.rules.body_only));
    }
    if ((item.size || 0) > MAX_BYTES) return RPC("hcps_mfr_capture_fail", { item_id: item.id, attention: "too_large", retryable: false,
      detail: `${item.size} bytes — larger than ${MAX_BYTES / 1e6} MB; download it from Outlook and register it on the Register tab` });
    try { buf = await g.get(`/users/${mb}/messages/${encodeURIComponent(msg.graph_id)}/attachments/${encodeURIComponent(item.graph_attachment_id)}/$value`, { raw: true }); }
    catch (e) { if (e.code === "budget") throw e; return RPC("hcps_mfr_capture_fail", { item_id: item.id, attention: "attachment_failed", detail: e.message }); }
    const att = await inspect(buf, name, deps);
    // The MI-1c reader runs only if a candidate profile needs it.
    if (att.format === "pdf" && profiles.some(p => p.rules && p.rules.content && p.rules.content.reader === "strongback-dealer-report"
        && (!who.slug || p.manufacturer === who.slug) && senderOk(p, msg.from_address))) att.reader = await readDealerReport(buf, deps);
    return finishItem(item, msg, who, att, buf, profiles);
  }

  async function finishItem(item, msg, who, att, buf, profs) {
    const d = decide(att, msg, profs, who);
    const base = { item_id: item.id, sha256: att.sha256, format: att.format, suggested: att.suggested || "",
      signals: { signals: att.signals || [], text_periods: att.text_periods || [], sheets: (att.sheets || []).map(s => ({ name: s.name, columns: s.columns })),
        rows: att.rows, pages: att.pages, date_range: att.date_range || null, reader: att.reader ? { ok: att.reader.ok, errors: att.reader.errors } : undefined,
        body: att.body || undefined, bytes: att.bytes },
      manufacturer: (d.profile && d.profile.manufacturer) || who.slug || "", profile_id: d.profile ? String(d.profile.id) : "", kind: d.profile ? d.profile.kind : "",
      period_start: d.period ? d.period.start : "", period_end: d.period ? d.period.end : "", period_basis: d.period ? d.period.basis : "",
      cumulative: d.period && d.period.cumulative ? "true" : "", prepared_date: (att.reader && att.reader.prepared_date) || "", detail: d.detail || "" };
    if (d.outcome === "exception") { counts.exceptions++; return RPC("hcps_mfr_capture_classify", Object.assign(base, { outcome: "exception", attention: d.attention })); }
    const c = await RPC("hcps_mfr_capture_classify", Object.assign(base, { outcome: "classified" }));
    if (c.unchanged) return c;
    if (d.outcome === "classified") { counts.classified++; return c; }
    // Register: keep the original first (private bucket, hash-named, never overwritten), then the register itself.
    const ext = att.format === "eml" ? "eml" : att.format;
    const prof = d.profile;
    const storagePath = `reports/${prof.manufacturer}/${prof.kind}/${att.sha256}.${ext}`;
    // Already registered (e.g. record 7): the register links it — the original is not stored a second time.
    const have = await deps.db.get(`mfr_sources?manufacturer=eq.${encodeURIComponent(prof.manufacturer)}&file_sha256=eq.${att.sha256}&select=id,kind`);
    if (!(have && have[0] && have[0].kind === prof.kind))
    try { await deps.storage.upload(storagePath, buf, MIME[ext] || "application/octet-stream"); }
    catch (e) { counts.exceptions++; return RPC("hcps_mfr_capture_fail", { item_id: item.id, attention: "storage_failed", detail: String(e.message || e).slice(0, 300) }); }
    const periodLabel = d.period.start.slice(0, 7) === d.period.end.slice(0, 7) ? d.period.start.slice(0, 7) : `${d.period.start.slice(0, 7)} to ${d.period.end.slice(0, 7)}`;
    const r = await RPC("hcps_mfr_capture_register", { item_id: item.id, register: {
      manufacturer: prof.manufacturer, kind: prof.kind, title: `${nameOf(prof.manufacturer)} — ${KIND_LABEL[prof.kind]} ${periodLabel}`.slice(0, 200),
      file_name: att.name.slice(0, 200), file_sha256: att.sha256, storage_path: storagePath, file_size: buf.length, content_type: MIME[ext],
      received_date: chicagoDate(msg.received_at), prepared_date: (att.reader && att.reader.prepared_date) || "",
      report_period_start: d.period.start, report_period_end: d.period.end, supersedes_id: "", supersede_reason: "",
      note: `Captured automatically from Outlook (${mailbox}): ${msg.from_address} · "${String(msg.subject || "").slice(0, 200)}" · received ${msg.received_at}`.slice(0, 1000) } });
    if (r.state === "registered") counts.registered++; else if (r.state === "linked") counts.linked++; else if (r.state === "exception") counts.exceptions++;
    return r;
  }

  function msgRow(m, who) {
    const f = (m.from && m.from.emailAddress) || {};
    return { internet_message_id: m.internetMessageId, graph_id: m.id, web_link: m.webLink || null, received_at: m.receivedDateTime,
      from_address: String(f.address || "").toLowerCase(), from_name: f.name || "", subject: m.subject || "", folder: m.folder || null,
      manufacturer: who.slug || "", match_basis: who.basis || "", has_attachments: !!m.hasAttachments };
  }
  // The items of one email: each non-image file attachment on its own; a body item when a body-only report is possible.
  async function listItems(m, who) {
    const items = []; let n = 0;
    if (m.hasAttachments) {
      const j = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`);
      for (const a of j.value || []) {
        const type = String(a["@odata.type"] || "");
        if (/^image\//i.test(a.contentType || "") || (a.isInline && !/fileAttachment/i.test(type))) continue;
        if (/^image\//i.test(a.contentType || "")) continue;
        n++;
        const kind = /fileAttachment/i.test(type) ? "file" : /itemAttachment/i.test(type) ? "item" : "reference";
        items.push({ item_key: `att:${n}:${String(a.name || "").slice(0, 120)}:${a.size || 0}`, part: "attachment", ordinal: n, file_name: a.name || "",
          content_type: a.contentType || "", size: a.size || 0, _graph: a.id, _kind: kind });
      }
    }
    const reportFiles = items.filter(x => x._kind === "file" && (INV.classifyName(x.file_name) || /\.(pdf|csv|xlsx?)$/i.test(x.file_name)));
    if (!reportFiles.length && (bodyProfileFor(who.slug) || !who.slug) && /commi?ss?ion/i.test(m.subject || ""))
      items.push({ item_key: "body", part: "body", ordinal: 0, file_name: null, content_type: "text/plain", size: null });
    return items;
  }

  const strip = ({ _graph, _kind, _err, ...x }) => x;
  const dbMsg = m => ({ internet_message_id: m.internet_message_id, graph_id: m.graph_id, web_link: m.web_link, received_at: m.received_at,
    from_address: m.from_address, from_name: m.from_name, subject: m.subject, folder: m.folder, manufacturer: m.manufacturer || "",
    match_basis: m.match_basis || "", has_attachments: m.has_attachments });
  const folders = new Map();
  async function folderName(id) {
    if (!id) return null; if (folders.has(id)) return folders.get(id);
    let n = null; try { n = (await g.get(`/users/${mb}/mailFolders/${encodeURIComponent(id)}?$select=displayName`)).displayName || null; }
    catch (e) { if (e.code === "budget") throw e; }
    folders.set(id, n); return n;
  }
  // Work every item of a recorded email that is still 'discovered'. An item that alone used up most of a run is
  // queued as an exception (so it can never hold back the email after it), then the run stops.
  async function processRecorded(rec, items, msg, who) {
    const byKey = new Map((items || []).map(x => [x.item_key, x]));
    for (const it of rec.items) { const src = byKey.get(it.item_key); if (src) { it.graph_attachment_id = src._graph; it._kind = src._kind; it._err = src._err; } }
    for (const it of rec.items) {
      if (it.state !== "discovered") { counts.skipped_settled++; continue; }
      if (it.part === "listing") { counts.exceptions++; await RPC("hcps_mfr_capture_fail", { item_id: it.id, attention: "listing_failed", detail: String(it._err || "the attachment list could not be read").slice(0, 300) }); continue; }
      if (it.part === "attachment" && it._kind && it._kind !== "file") {
        counts.exceptions++;
        await RPC("hcps_mfr_capture_fail", { item_id: it.id, attention: "cloud_attachment", retryable: false,
          detail: it._kind === "item" ? "an attached email — open it in Outlook" : "a cloud link — download the file and register it" });
        continue;
      }
      if (it.part === "attachment" && !it.graph_attachment_id) {
        counts.exceptions++;
        await RPC("hcps_mfr_capture_fail", { item_id: it.id, attention: "attachment_failed", detail: "the attachment is no longer on the email" }); continue;
      }
      try { await processItem(it, msg, who); }
      catch (e) {
        if (e.code === "budget" && !watermarkMoved) {     // the run's FIRST email did not fit: queue the item, move on next run
          counts.exceptions++;
          await RPC("hcps_mfr_capture_fail", { item_id: it.id, attention: "attachment_failed", detail: "could not be processed within one run (" + String(e.message || "time") + ")" });
        }
        throw e;
      }
    }
  }

  async function handleMessage(m) {
    const who = INV.identify({ from: m.from, subject: m.subject }, ctx);
    if (who.internal) return true;                                     // HCPS's own sends / forwards: not reports
    const subj = m.subject || "";
    let candidate = false;
    if (who.slug) candidate = INV.REPORT_WORDS.test(subj) || (m.hasAttachments && who.basis === "sender_domain");
    else candidate = INV.STRONG_WORDS.test(subj);
    if (!candidate) return true;
    const known = KNOWN.get(m.internetMessageId);
    if (known && known.items_listed && !(known.items || []).some(x => x.state === "discovered")) { counts.skipped_settled++; return true; }
    // A manufacturer's attachment mail without report words is recorded only when a file name looks like a report.
    let items = null;
    if (who.slug && !INV.REPORT_WORDS.test(subj)) {
      try { items = await listItems(m, who); } catch (e) { if (e.code === "budget") throw e; items = [{ item_key: "listing", part: "listing", ordinal: 0, file_name: null, _err: e.message }]; }
      const reportish = items.some(x => x.part === "listing" || KINDS.includes(INV.classifyName(x.file_name)));
      if (!reportish) return true;
    }
    counts.candidates++;
    const msg = msgRow(m, who);
    msg.folder = await folderName(m.parentFolderId);
    let rec = await RPC("hcps_mfr_capture_record", { message: msg, items: null });
    if (!rec.items_listed) {
      if (!items) { try { items = await listItems(m, who); } catch (e) { if (e.code === "budget") throw e; items = [{ item_key: "listing", part: "listing", ordinal: 0, file_name: null, _err: e.message }]; } }
      rec = await RPC("hcps_mfr_capture_record", { message: msg, items: items.map(strip) });
      counts.recorded++;
    } else if (rec.items.some(it => it.state === "discovered" && it.part === "attachment") && !items) {
      items = await listItems(m, who);                 // re-read the Graph attachment ids of the items still to do
    }
    await processRecorded(rec, items, msg, who);
    return true;
  }

  try {
    // 2. Retries due (oldest first). A retry re-reads the email by its stored locator.
    const due = await deps.db.get(`mfr_report_items?state=eq.exception&retryable=eq.true&resolved_at=is.null&next_retry_at=lte.${new Date(now()).toISOString()}`
      + `&select=*,msg:mfr_report_messages!inner(*)&msg.mailbox=eq.${encodeURIComponent(mailbox)}&order=next_retry_at&limit=10`);
    for (const it of due || []) {
      if (now() > soft) break;
      const m = it.msg; const who = { slug: m.manufacturer || null, basis: m.match_basis };
      const msg = Object.assign({}, m);
      if (it.part === "attachment") {
        try { const j = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.graph_id)}/attachments?$select=id,name,contentType,size,isInline`);
          const ord = (j.value || []).filter(a => !/^image\//i.test(a.contentType || ""));
          const a = ord.find(x => `${String(x.name || "").slice(0, 120)}:${x.size || 0}` === it.item_key.split(":").slice(2).join(":"));
          if (!a) { await RPC("hcps_mfr_capture_fail", { item_id: it.id, attention: "attachment_failed", detail: "the attachment is no longer on the email" }); counts.retried++; continue; }
          it.graph_attachment_id = a.id;
        } catch (e) { if (e.code === "budget") throw e; await RPC("hcps_mfr_capture_fail", { item_id: it.id, attention: "attachment_failed", detail: e.message }); counts.retried++; continue; }
      }
      await processItem(it, msg, who); counts.retried++;
    }

    // 3. Discovery: everything received from (checkpoint − overlap) up to this run's start, oldest first.
    const runStart = new Date(started).toISOString();
    const from = new Date(Date.parse(b.checkpoint_at) - (b.overlap_minutes || 360) * 60000).toISOString();
    const filter = `receivedDateTime ge ${from} and receivedDateTime lt ${runStart}`;
    let path = `/users/${mb}/messages?$select=id,internetMessageId,subject,from,receivedDateTime,hasAttachments,parentFolderId,isDraft,webLink`
      + `&$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime asc&$top=100`;
    // Emails already accounted for in this window are skipped without touching Graph again.
    const KNOWNROWS = await deps.db.get(`mfr_report_messages?mailbox=eq.${encodeURIComponent(mailbox)}&received_at=gte.${encodeURIComponent(from)}`
      + `&select=internet_message_id,items_listed,items:mfr_report_items(state)`);
    for (const r of KNOWNROWS || []) KNOWN.set(r.internet_message_id, r);
    outer: while (path) {
      const j = await g.get(path);
      for (const m of j.value || []) {
        counts.listed++;
        if (watermarkMoved && now() > soft) { stopped = true; break outer; }   // every run handles at least one email
        if (m.isDraft) { watermark = m.receivedDateTime; watermarkMoved = true; continue; }
        await handleMessage(m);
        watermark = m.receivedDateTime; watermarkMoved = true;
      }
      path = j["@odata.nextLink"] || null;
    }
    if (!stopped && !path) { complete = true; checkpoint = runStart; }
    else checkpoint = watermark;
  } catch (e) {
    if (e.code !== "budget") error = String(e.message || e).slice(0, 500);
    else stopped = true;
    checkpoint = watermark;          // every email before it was accounted for
  }
  // 4. Finish: the database refuses a checkpoint past anything unaccounted; then we keep the old one.
  let fin;
  try { fin = await RPC("hcps_mfr_capture_finish", { checkpoint_at: checkpoint, complete, counts, error: error || "" }); }
  catch (e) {
    error = (error ? error + " · " : "") + String(e.message || e).slice(0, 300);
    fin = await RPC("hcps_mfr_capture_finish", { checkpoint_at: null, complete: false, counts, error });
  }
  return { ok: !error, mailbox, run_id: runId, complete, stopped_by_budget: stopped, checkpoint_before: b.checkpoint_at,
    checkpoint_after: fin && fin.checkpoint_at, counts, error, graph_calls: g.calls() };
}

/* The live wiring: Supabase with the service role (server-only), the existing Graph app's token (email-sync-api). */
function liveDeps(env) {
  const URL = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE;
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const { graphToken } = require("./email-sync-api.js");
  return {
    getToken: force => graphToken(!!force),
    fetch: (u, o) => fetch(u, o),
    db: {
      async get(path) { const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json(); },
      async rpc(fn, p) {
        const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ p }) });
        const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { message: t }; }
        if (!r.ok) { const e = new Error(`${fn}: ${String((j && j.message) || t).slice(0, 300)}`); e.status = r.status; throw e; }
        return j;
      },
    },
    storage: {
      async upload(path, bytes, mime) {
        const r = await fetch(`${URL}/storage/v1/object/mfr-sources/${path}`, { method: "POST",
          headers: { ...H, "content-type": mime, "x-upsert": "false", "cache-control": "no-store" }, body: bytes });
        if (r.ok) return true;
        const t = (await r.text()).slice(0, 300);
        if (r.status === 409 || /already exists|Duplicate/i.test(t)) return true;     // the same hash-named file is already kept
        throw new Error(`storage ${r.status}: ${t}`);
      },
    },
  };
}

module.exports = { runCapture, liveDeps, _internal: { senderOk, fileOk, periodOf, decide, inspect, dateRange, readDealerReport, chicagoDate, MAX_BYTES } };

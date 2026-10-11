/* MI Inbox Automation — Phase A: READ-ONLY manufacturer report inventory.
   Lists one mailbox's messages (all folders) for a window, keeps the ones that come from a known manufacturer
   (or look like a report from an unknown sender), and describes each report attachment: name, type, size, SHA-256,
   the format actually found inside it and a suggested classification. Email-body-only reports (Climbing Steps) are
   detected from the body's SIGNALS — the body itself is never returned.

   Read-only by construction: every Graph call made here is a GET (the token request is made by the caller's
   getToken). Nothing is written anywhere, no message is marked read or moved, no importer is called. Bytes are
   held in memory only for hashing and inspection, then dropped. The response carries metadata and derived signals
   only — never attachment contents, body text or raw column headers (headers are reduced to a fixed vocabulary).

   Nothing is ever dropped silently: a month that could not be listed, a message not yet inspected (time budget —
   a resumable cursor is returned), an attachment too large or unreadable, are all reported as incomplete. */
const crypto = require("crypto");

const GRAPH = "https://graph.microsoft.com/v1.0";

/* Known manufacturer sender domains (Phase A discovery + the manufacturers table). A domain is evidence of WHO sent
   it; the subject/attachment decides whether it is a report. */
const DOMAINS = {
  "strongbackmobility.com": "strongback-mobility",
  "ohiomedical.com": "ohio-medical",
  "access4uinc.com": "access4u",
  "airavant.com": "airavant-bongorx",
  "bongorx.com": "airavant-bongorx",
  "climbingsteps.com": "climbing-steps",
  "bemismfg.com": "bemis",
  "completemedical.com": "complete-medical-supplies",
  "ovationmed.com": "ovation-medical",
  "pedifix.com": "pedifix",
  "goldentech.com": "golden-technologies",
  "corsicanamattress.com": "corsicana",
  "daltonmedical.com": "dalton",
};
/* Subject patterns that identify a manufacturer's report even from a relay address (Bemis sends from a fax service). */
const SUBJECT_PATTERNS = [
  { re: /COMMISSION REPORT for Rep\/Month/i, slug: "bemis" },
];
/* Names as they appear in subjects / file names (forwards, unknown relays). Distinctive words only. */
const NAMES = [
  [/\bstrong ?back\b/i, "strongback-mobility"],
  [/\bohio medical\b|\bGCE\b/i, "ohio-medical"],
  [/\baccess ?4 ?u\b/i, "access4u"],
  [/\bair ?avant\b|\bbongo ?rx\b/i, "airavant-bongorx"],
  [/\bclimbing steps\b/i, "climbing-steps"],
  [/\bbemis\b/i, "bemis"],
  [/\bcomplete medical\b/i, "complete-medical-supplies"],
  [/\bovation\b/i, "ovation-medical"],
  [/\bpedi ?fix\b/i, "pedifix"],
  [/\bgolden tech/i, "golden-technologies"],
  [/\bcorsicana\b/i, "corsicana"],
  [/\bdalton medical\b/i, "dalton"],
  [/\bABM respiratory\b/i, "abm-respiratory-care"],
];
const REPORT_WORDS = /commission|\bcomm\b|sales (report|summary)|monthly sales|\bytd\b|statement|price ?list|pricing|dealer (overview|report)|\breport\b|orders? (export|report)/i;
const STRONG_WORDS = /commission|sales report|price ?list|dealer (overview|report)/i;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:\s*,?\s*(20\d\d))?/gi;

const domainOf = a => { const m = String(a || "").toLowerCase().match(/@([^>\s]+)$/); return m ? m[1] : ""; };
const pad2 = n => String(n).padStart(2, "0");

/* ── Manufacturer identification ─────────────────────────────────────────── */
function nameSlug(text) { for (const [re, slug] of NAMES) if (re.test(text || "")) return slug; return null; }
function identify(msg, ctx) {
  const from = String((msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || "").toLowerCase();
  const dom = domainOf(from);
  const subject = msg.subject || "";
  const internal = ctx.internalDomains.includes(dom);
  if (DOMAINS[dom]) return { slug: DOMAINS[dom], basis: "sender_domain", internal };
  for (const p of SUBJECT_PATTERNS) if (p.re.test(subject)) return { slug: p.slug, basis: "subject_pattern", internal };
  // A forward from inside HCPS, or an unknown relay: the manufacturer's name in the subject.
  const s = nameSlug(subject) || ctx.tableNames(subject);
  if (s) return { slug: s, basis: internal ? "forwarded_subject_name" : "subject_name", internal };
  return { slug: null, basis: null, internal };
}

/* ── Period guess from text (subject, file name) ─────────────────────────── */
function periodGuess(text, receivedISO) {
  const t = String(text || "");
  const rec = new Date(receivedISO || Date.now());
  const ry = rec.getUTCFullYear(), rm = rec.getUTCMonth() + 1;
  const iso = t.match(/\b(20\d\d)[-_ /.](0[1-9]|1[0-2])\b/);
  const periods = [];
  if (iso) periods.push(`${iso[1]}-${iso[2]}`);
  MON_RE.lastIndex = 0; let m; const found = [];
  while ((m = MON_RE.exec(t))) {
    const word = m[1].toLowerCase().slice(0, 3);
    if (word === "may" && m[1] !== "May" && !m[2]) continue;      // "you may" is not a month
    const mi = MONTHS.findIndex(x => x.startsWith(word)) + 1; if (!mi) continue;
    found.push({ mi, year: m[2] ? +m[2] : null });
  }
  // "November and December 2025": a trailing year applies to the months listed before it.
  let lastYear = null;
  for (let i = found.length - 1; i >= 0; i--) { if (found[i].year) lastYear = found[i].year; else if (lastYear) found[i].year = lastYear; }
  for (const f of found) {
    const y = f.year || (f.mi > rm ? ry - 1 : ry);
    const p = `${y}-${pad2(f.mi)}`; if (!periods.includes(p)) periods.push(p);
  }
  if (!periods.length) return null;
  return { periods: periods.sort(), cumulative: /\b(through|thru|ytd|year to date)\b/i.test(t), basis: iso ? "date_in_text" : "month_name" };
}

/* ── Column vocabulary — raw headers are NEVER returned, only these features ── */
const VOCAB = [
  ["commission", /commission|\bcomm\b|comm\s*(%|\$|amt|rate)/i],
  ["order", /\border\b|sales ?order|\bso\b ?(#|no|num)|\bpo\b/i],
  ["invoice", /invoice|\binv\b/i],
  ["sku", /\bsku\b|item ?(#|no|num|code)?$|part ?(#|no|num)|model|product ?code|\bcode\b/i],
  ["product", /product|description|item name|\bitem\b/i],
  ["qty", /\bqty\b|quantity|units|\bpcs\b/i],
  ["amount", /amount|total|\bsales\b|extended|\bnet\b|\bprice\b|revenue|\bsubtotal\b/i],
  ["customer", /customer|dealer|account name|sold ?to|bill ?to|company|\bname\b/i],
  ["account", /account|acct|cust(omer)? ?(#|no|num|id)/i],
  ["ship_to", /ship/i],
  ["zip", /\bzip\b|postal/i],
  ["date", /date|period|month/i],
  ["payment", /payment|\bpaid\b|check|deposit/i],
  ["price_list", /msrp|\bmap\b|list price|dealer (cost|price)|case cost|unit cost/i],
];
function features(header) {
  const out = new Set();
  for (const h of header) { const s = String(h == null ? "" : h).trim(); if (!s || s.length > 60) continue;
    for (const [k, re] of VOCAB) if (re.test(s)) out.add(k); }
  return [...out].sort();
}
function bestHeader(rows) {
  let best = [], bestN = 0;
  for (const r of (rows || []).slice(0, 15)) { const f = features(r || []); if (f.length > bestN) { best = f; bestN = f.length; } }
  return best;
}

/* ── Format detection + read-only inspection ─────────────────────────────── */
let _XLSX = null; function xlsx() { if (!_XLSX) _XLSX = require("xlsx"); return _XLSX; }
let _pdf = null;
function pdfjs() {
  if (!_pdf) {
    const warn = console.warn, log = console.log; console.warn = () => {}; console.log = () => {};
    try {
      globalThis.pdfjsWorker = require("pdfjs-dist/legacy/build/pdf.worker.js");   // static: the bundler must see it
      _pdf = require("pdfjs-dist/legacy/build/pdf.js");
    } finally { console.warn = warn; console.log = log; }
  }
  return _pdf;
}
function magic(buf) {
  const b = buf.subarray(0, 8);
  if (b.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "zip";
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "ole";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b.slice(0, 4).toString("latin1") === "GIF8") return "gif";
  const head = buf.subarray(0, 4096); let printable = 0;
  for (const c of head) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160) printable++;
  return head.length && printable / head.length > 0.95 ? "text" : "binary";
}
async function pdfSignals(buf) {
  const lib = pdfjs();
  const warn = console.warn, log = console.log; console.warn = () => {}; console.log = () => {};
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(buf), disableWorker: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    let text = "";
    for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
      const tc = await (await doc.getPage(n)).getTextContent();
      text += " " + tc.items.map(i => i.str || "").join(" ");
    }
    text = text.replace(/\s+/g, " ");
    const sig = [];
    if (/cash basis/i.test(text)) sig.push("cash_basis");
    if (/commission/i.test(text)) sig.push("commission");
    if (/dealer (overview|report)|report overview/i.test(text)) sig.push("dealer_overview");
    if (/\bprepared\b/i.test(text)) sig.push("prepared_date");
    if (/price ?list|\bmsrp\b|dealer (cost|price)/i.test(text)) sig.push("price_list");
    if (/\binvoice\b/i.test(text)) sig.push("invoice");
    if (/\bpayment\b|\bpaid\b/i.test(text)) sig.push("payment");
    if (/quickbooks|intuit/i.test(text) || /commissions\s*[-–]\s*cash basis/i.test(text)) sig.push("quickbooks");
    if (/order (number|#|no)|\bsku\b|\bqty\b/i.test(text)) sig.push("order_lines");
    const pg = periodGuess(text.slice(0, 2000), null);
    return { pages: doc.numPages, signals: sig, text_periods: pg ? pg.periods.slice(0, 6) : [] };
  } finally { console.warn = warn; console.log = log; try { if (doc) await doc.destroy(); } catch (x) {} }
}
function sheetSignals(buf, asText) {
  const X = xlsx();
  const wb = asText ? X.read(buf.toString("utf8"), { type: "string", sheetRows: 40, raw: true })
                    : X.read(buf, { type: "buffer", sheetRows: 40, cellFormula: false, cellHTML: false, cellText: false, bookVBA: false });
  const sheets = [];
  for (const name of wb.SheetNames.slice(0, 8)) {
    const rows = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: "" });
    sheets.push({ name: String(name).slice(0, 60), columns: bestHeader(rows) });
  }
  return sheets;
}
function countLines(buf) { let n = 0; for (const l of buf.toString("utf8").split(/\r?\n/)) if (l.trim()) n++; return n; }

/* What the content says it is. Content beats file name beats subject. */
function classifyContent(a) {
  if (a.format === "pdf") {
    const s = new Set(a.signals || []);
    if (s.has("dealer_overview")) return "dealer_report";
    if (s.has("commission")) return "commission_statement";
    if (s.has("price_list")) return "price_list";
    if (s.has("order_lines")) return "sales_export";
    if (s.has("invoice")) return "other";
    return null;
  }
  if (a.sheets && a.sheets.length) {
    const all = new Set(a.sheets.flatMap(x => x.columns));
    const names = a.sheets.map(x => x.name.toLowerCase());
    if (names.some(n => /current month payment|commission/.test(n)) || all.has("commission")) return "commission_statement";
    if (all.has("price_list") && !all.has("customer") && !all.has("order") && !all.has("invoice")) return "price_list";
    if ((all.has("order") || all.has("invoice")) && (all.has("sku") || all.has("product")) && (all.has("qty") || all.has("amount"))) return "sales_export";
    if (all.has("price_list")) return "price_list";
    return null;
  }
  return null;
}
function classifyName(text) {
  const t = String(text || "");
  if (/dealer (overview|report)|report[_ ]overview/i.test(t)) return "dealer_report";
  if (/commission/i.test(t)) return "commission_statement";
  if (/price ?list|pricing|pricelist/i.test(t)) return "price_list";
  if (/invoice|statement of account|remittance/i.test(t)) return "other";
  if (/\border|sales (report|summary)|monthly sales|\bytd\b/i.test(t)) return "sales_export";
  return null;
}

/* ── Graph (GET only) with throttling and a time budget ──────────────────── */
class Budget extends Error { constructor(m) { super(m); this.code = "budget"; } }
function graphClient(deps, deadline) {
  const now = deps.now || Date.now;
  let calls = 0;
  async function get(path, opt) {
    opt = opt || {};
    for (let attempt = 0; ; attempt++) {
      if (now() > deadline) throw new Budget("time budget reached");
      const tok = await deps.getToken(attempt > 0 && opt._authRetry);
      const url = path.startsWith("http") ? path : GRAPH + path;
      const prefer = ['IdType="ImmutableId"'].concat(opt.prefer || []).join(", ");
      calls++;
      const r = await deps.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${tok}`, Prefer: prefer } });
      if (r.status === 429 || r.status === 503 || r.status === 504) {
        const ra = Math.max(1, parseInt((r.headers && r.headers.get && r.headers.get("retry-after")) || "2", 10) || 2) * 1000;
        if (attempt >= 3 || now() + ra > deadline) { const e = new Budget(`throttled by Microsoft Graph (HTTP ${r.status}, retry after ${ra / 1000}s)`); e.throttled = true; throw e; }
        await (deps.sleep || (ms => new Promise(f => setTimeout(f, ms))))(ra);
        continue;
      }
      if (r.status === 401 && attempt === 0) { opt._authRetry = true; continue; }
      if (!r.ok) { let msg = ""; try { const j = await r.json(); msg = (j.error && j.error.message) || ""; } catch (e) {}
        const e = new Error(`Graph ${r.status}: ${msg}`.slice(0, 200)); e.status = r.status; throw e; }
      if (opt.raw) return Buffer.from(await r.arrayBuffer());
      return r.json();
    }
  }
  return { get, calls: () => calls };
}

/* ── The inventory ───────────────────────────────────────────────────────── */
async function inventory(o, deps) {
  const now = deps.now || Date.now;
  const started = now();
  const budget = Math.min(Math.max(+o.budget_ms || 8000, 2000), 22000);
  const deadline = started + budget;
  const soft = deadline - Math.min(1500, budget / 4);          // stop starting new work here
  const maxBytes = Math.min(Math.max(+o.max_attachment_bytes || 15e6, 1e5), 25e6);
  const g = graphClient(deps, deadline);
  const mb = encodeURIComponent(o.mailbox);
  const ctx = { internalDomains: o.internal_domains || [], tableNames: o.tableNames || (() => null) };

  // 1. List the window, every folder, oldest first (new mail lands at the END, so a cursor stays valid).
  const filter = `receivedDateTime ge ${o.from} and receivedDateTime lt ${o.to}`;
  let path = `/users/${mb}/messages?$select=id,internetMessageId,subject,from,receivedDateTime,hasAttachments,parentFolderId,isDraft`
    + `&$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime asc&$top=500`;
  const listed = []; let pages = 0;
  try {
    while (path) {
      const j = await g.get(path);
      for (const m of j.value || []) listed.push(m);
      pages++; path = j["@odata.nextLink"] || null;
    }
  } catch (e) {
    return { ok: true, done: false, listing: { complete: false, pages, scanned: listed.length, error: e.message, throttled: !!e.throttled },
      incomplete: [{ scope: "window", reason: `listing not finished: ${e.message} — run the window again or split it` }],
      messages: [], unidentified: [], graph_calls: g.calls() };
  }

  // 2. Keep manufacturer reports (and report-like mail from unknown senders).
  const keep = [], skipped = {};
  for (const m of listed) {
    if (m.isDraft) continue;
    const who = identify(m, ctx);
    const subj = m.subject || "";
    if (who.slug) {
      // A manufacturer's report-worded mail is inspected in full; its other mail WITH attachments is listed too
      // (names only; a file is downloaded only when its name looks like a report), so nothing report-like hides
      // behind an unhelpful subject. Mail without attachments and without report words is only counted.
      if (REPORT_WORDS.test(subj) || who.basis !== "sender_domain") keep.push({ m, who, deep: true });
      else if (m.hasAttachments) keep.push({ m, who, deep: false });
      else skipped[who.slug] = (skipped[who.slug] || 0) + 1;
    } else if (!who.internal && STRONG_WORDS.test(subj)) keep.push({ m, who, deep: true });
  }

  // 3. Resume where the last call stopped.
  const cur = o.cursor || null; let start = 0;
  if (cur) {
    start = Math.max(0, parseInt(cur.skip, 10) || 0);
    if (start > keep.length || (start > 0 && keep[start - 1].m.id !== cur.last_id))
      return { ok: false, error: "window_changed", message: "The window changed since the last call (a message was moved or deleted). Run this window again from the start." };
  }

  // 4. Inspect, oldest first, until the time budget runs out.
  const folderName = new Map();
  async function folder(id) {
    if (!id) return null; if (folderName.has(id)) return folderName.get(id);
    let n = null; try { n = (await g.get(`/users/${mb}/mailFolders/${encodeURIComponent(id)}?$select=displayName`)).displayName || null; }
    catch (e) { if (e.code === "budget") throw e; n = null; }
    folderName.set(id, n); return n;
  }
  const out = [], unidentified = [], incomplete = [];
  let i = start;
  for (; i < keep.length; i++) {
    if (now() > soft) break;
    const { m, who, deep } = keep[i];
    let rec;
    try { rec = await inspectMessage(m, who, g, mb, maxBytes, folder, now, soft, deep); }
    catch (e) {
      if (e.code !== "budget") throw e;
      if (i > start) break;                          // the next call resumes here
      // Even the first message of this call did not fit: report it as not inspected and move on, so a cursor
      // always advances (the message is listed, with the reason — never dropped).
      const from = (m.from && m.from.emailAddress) || {};
      rec = { received: m.receivedDateTime, folder: null, manufacturer: who.slug, match: who.basis, from: String(from.address || "").toLowerCase(),
        from_name: from.name || "", subject: m.subject || "", internet_message_id: m.internetMessageId || null, report_worded: !!deep,
        attachments: [], inline_skipped: 0, body: null, classification: "unknown", classified_by: null, period_guess: periodGuess(m.subject, m.receivedDateTime),
        incomplete: [`not inspected: ${e.message} — inspect this message on its own`] };
    }
    (who.slug ? out : unidentified).push(rec);
  }
  // Duplicates inside this answer: the same message filed in two folders, the same file sent twice.
  const seenMsg = new Map(), seenFile = new Map();
  for (const r of out.concat(unidentified).sort((a, b) => String(a.received).localeCompare(String(b.received)))) {
    if (r.internet_message_id) { if (seenMsg.has(r.internet_message_id)) r.duplicate_of_message = { folder: seenMsg.get(r.internet_message_id) }; else seenMsg.set(r.internet_message_id, r.folder); }
    for (const a of r.attachments) if (a.sha256) {
      if (seenFile.has(a.sha256)) a.same_file_as = seenFile.get(a.sha256); else seenFile.set(a.sha256, { internet_message_id: r.internet_message_id, name: a.name });
    }
  }
  const done = i >= keep.length;
  if (!done) incomplete.push({ scope: "window", reason: `time budget — ${keep.length - i} message(s) not inspected yet; call again with the cursor` });
  for (const r of out.concat(unidentified)) for (const x of r.incomplete || []) incomplete.push({ scope: "message", internet_message_id: r.internet_message_id, reason: x });
  return {
    ok: true, done, window: { from: o.from, to: o.to }, mailbox: o.mailbox,
    listing: { complete: true, pages, scanned: listed.length },
    matched_total: keep.length, inspected: { from: start, to: i },
    cursor: done ? null : { skip: i, last_id: i > 0 ? keep[i - 1].m.id : null },
    messages: out, unidentified, not_reports_by_manufacturer: skipped, incomplete, graph_calls: g.calls(),
  };
}

async function inspectMessage(m, who, g, mb, maxBytes, folder, now, soft, deep) {
  const from = (m.from && m.from.emailAddress) || {};
  const rec = {
    received: m.receivedDateTime, folder: await folder(m.parentFolderId),
    manufacturer: who.slug, match: who.basis, from: String(from.address || "").toLowerCase(), from_name: from.name || "",
    subject: m.subject || "", internet_message_id: m.internetMessageId || null, report_worded: !!deep,
    attachments: [], inline_skipped: 0, body: null, incomplete: [],
  };
  if (m.hasAttachments) {
    const j = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`);
    for (const a of j.value || []) {
      const kind = /fileAttachment/i.test(a["@odata.type"] || "") ? "file" : /itemAttachment/i.test(a["@odata.type"] || "") ? "item" : "reference";
      if (a.isInline && kind === "file" && /^image\//i.test(a.contentType || "")) { rec.inline_skipped++; continue; }
      const att = { name: a.name || "", content_type: a.contentType || "", size: a.size || 0, inline: !!a.isInline, kind,
        sha256: null, format: null, classification: null, basis: null };
      if (kind !== "file") { att.note = kind === "item" ? "attached email/item — not inspected" : "cloud link — not downloaded"; att.classification = classifyName(att.name); att.basis = att.classification ? "file_name" : null; rec.attachments.push(att); continue; }
      if (!deep && !/^(commission_statement|sales_export|price_list|dealer_report)$/.test(classifyName(att.name) || "")) {
        att.note = "listed only — not a report-worded email and the file name doesn't look like a report"; att.classification = classifyName(att.name); att.basis = att.classification ? "file_name" : null; rec.attachments.push(att); continue; }
      if ((a.size || 0) > maxBytes) { att.note = `too large to inspect here (${a.size} bytes)`; rec.incomplete.push(`attachment "${att.name}" not hashed: larger than ${maxBytes} bytes`); att.classification = classifyName(att.name); att.basis = att.classification ? "file_name" : null; rec.attachments.push(att); continue; }
      if (now() > soft) { const e = new Error("budget"); e.code = "budget"; throw e; }
      let buf;
      try { buf = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}/$value`, { raw: true }); }
      catch (e) { if (e.code === "budget") throw e; att.note = "download failed: " + e.message; rec.incomplete.push(`attachment "${att.name}" could not be read: ${e.message}`); rec.attachments.push(att); continue; }
      att.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      att.bytes = buf.length;
      const kindOf = magic(buf);
      try {
        if (kindOf === "pdf") { att.format = "pdf"; Object.assign(att, await pdfSignals(buf)); }
        else if (kindOf === "zip" || kindOf === "ole") {
          try { att.sheets = sheetSignals(buf, false); att.format = kindOf === "zip" ? "xlsx" : "xls"; }
          catch (e) { att.format = kindOf === "zip" ? "zip (not a workbook)" : "ole (not a workbook)"; }
        } else if (kindOf === "text") {
          att.format = /\.csv$/i.test(att.name) || /csv/i.test(att.content_type) ? "csv" : "text";
          if (att.format === "csv") { att.sheets = sheetSignals(buf, true).slice(0, 1); att.rows = Math.max(0, countLines(buf) - 1); }
        } else att.format = kindOf;
      } catch (e) { att.note = "content could not be inspected: " + String(e.message || e).slice(0, 120); rec.incomplete.push(`attachment "${att.name}" content not inspected: ${String(e.message || e).slice(0, 120)}`); }
      buf = null;
      const byContent = classifyContent(att);
      if (byContent) { att.classification = byContent; att.basis = "content"; }
      else { att.classification = classifyName(att.name); att.basis = att.classification ? "file_name" : null; }
      if (att.format && /^(png|jpeg|gif)$/.test(att.format)) { att.classification = "image"; att.basis = "content"; }
      rec.attachments.push(att);
    }
  }
  const docs = rec.attachments.filter(a => a.classification && a.classification !== "image");
  if (deep && !docs.length && /commission|sales|report|statement/i.test(rec.subject)) {
    // Body-only report (Climbing Steps): read the body as text, keep SIGNALS only.
    if (now() > soft) { const e = new Error("budget"); e.code = "budget"; throw e; }
    try {
      const b = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.id)}?$select=body`, { prefer: ['outlook.body-content-type="text"'] });
      const t = String((b.body && b.body.content) || "");
      const amounts = (t.match(/\$\s?\d[\d,]*(\.\d\d)?/g) || []).length;
      const comm = (t.match(/commission/gi) || []).length;
      const lines = t.split(/\r?\n/).filter(l => /\$\s?\d/.test(l)).length;
      rec.body = { checked: true, amounts, commission_terms: comm, amount_lines: lines, chars: t.length,
        looks_like_report: amounts >= 1 && (comm >= 1 || /commission/i.test(rec.subject)) };
    } catch (e) { if (e.code === "budget") throw e; rec.body = { checked: false }; rec.incomplete.push("body could not be read: " + e.message); }
  }
  // Message-level suggestion: strongest attachment by content, else by name, else the body, else the subject.
  const rank = a => (a.basis === "content" ? 2 : a.basis === "file_name" ? 1 : 0);
  const best = docs.slice().sort((a, b) => rank(b) - rank(a))[0];
  if (best) { rec.classification = best.classification; rec.classified_by = best.basis === "content" ? "attachment_content" : "attachment_name"; }
  else if (rec.body && rec.body.looks_like_report) { rec.classification = "commission_statement"; rec.classified_by = "email_body"; }
  else if (deep) { rec.classification = classifyName(rec.subject) || "unknown"; rec.classified_by = "subject"; }
  else { rec.classification = "not_a_report"; rec.classified_by = "no_report_signal"; }
  rec.subject_suggests = classifyName(rec.subject);
  rec.period_guess = periodGuess([rec.subject].concat(rec.attachments.map(a => a.name)).join(" | "), rec.received);
  return rec;
}

module.exports = { inventory, _internal: { identify, periodGuess, features, classifyContent, classifyName, magic, sheetSignals, pdfSignals, DOMAINS } };

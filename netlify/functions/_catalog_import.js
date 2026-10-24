/* Catalog import — the reusable core (master assignment homecareproviderservicesordering#1, workstream B; 2026-10-23).
   Pure: no database, no network, no writes. Adapters (_import_adapters.js) turn one manufacturer file into the
   normalized line below; this module validates it, compares it with what HCPS already has, and builds the review
   report. Nothing here stages, publishes or prices anything — staging goes through the EXISTING Manufacturer Center
   path (mc_register_source → mc_import_source_rows → mc_match → stage_record_source), with its two human gates.

   Normalized line (adapter output):
   { manufacturer, source: { file, sha256, title, effective_date, effective_date_status: stated|pending|not_stated,
       received_date }, terms: [{ kind, text, value? }],            // stated line-level rules, word for word
     rows: [{ code, name, description, size, category_hint, section,
              dealer_price, tiers: [{ min_qty, price, pool? }],      // tiers in the SELLING unit (CLAUDE.md §17)
              msrp, msrp_source: "stated" | "source_rule" | null,     // never invented; a stated rule is cited
              map,  map_source:  "stated" | "source_rule" | null,
              uom, case_qty, upc, options: [{ label, price_add }],
              dealer_price_scope: "dealer" | "named_account",         // a price quoted for ONE account is not a base price
              locator, flags: [{ level, code, detail }] }] }

   Rules carried from CLAUDE.md §17: one price is never derived from another (unit vs case); MAP/MSRP only where the
   source states them or states the rule; two dates (received vs manufacturer effective), never invent the effective
   date; a disagreement between the source and HCPS is reported, never resolved here. */

const crypto = require("crypto");
const normCode = c => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
const money = v => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const s = String(v).replace(/[\s,]/g, "").replace(/^\+/, "");
  if (!/^\$?-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s.replace("$", ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const clean = v => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const flag = (level, code, detail) => ({ level, code, detail });

/* Validate one normalized line. Returns a COPY with row flags added and line exceptions; never drops a row. */
function validateLine(line) {
  const L = JSON.parse(JSON.stringify(line || {}));
  L.rows = Array.isArray(L.rows) ? L.rows : [];
  const ex = [];
  const src = L.source || {};
  if (!src.sha256) ex.push(flag("blocker", "source_unhashed", "the source file has no SHA-256 — it cannot be registered"));
  if (src.effective_date_status !== "stated") ex.push(flag("info", "effective_date_not_stated", "no manufacturer effective date on the source — recorded as pending, never invented"));
  const seen = new Map();
  for (const r of L.rows) {
    r.flags = Array.isArray(r.flags) ? r.flags : [];
    r.code = clean(r.code);
    const k = normCode(r.code);
    if (!k) { r.flags.push(flag("blocker", "no_code", "row has no part number")); continue; }
    if (!(r.dealer_price > 0)) r.flags.push(flag("blocker", "no_dealer_price", "no dealer price on the source — cannot be orderable"));
    // The dealer price must be the figure PRINTED on the source, to the cent: no discount, markup or rounding is ever
    // applied on the way in (Dalton: the corrected list exactly as printed — never an extra 5%).
    if (r.raw && r.raw.printed_price != null && String(r.raw.printed_price).trim() !== "" && money(r.raw.printed_price) !== r.dealer_price)
      r.flags.push(flag("blocker", "price_not_as_printed", "the dealer price " + r.dealer_price + " is not the printed figure " + r.raw.printed_price));
    if (r.dealer_price_scope === "named_account") r.flags.push(flag("blocker", "named_account_price", "the price column is quoted for one named account, not a general dealer price — needs Angelo's decision"));
    const tiers = Array.isArray(r.tiers) ? r.tiers : [];
    for (let i = 1; i < tiers.length; i++) {
      if (!(tiers[i].min_qty > tiers[i - 1].min_qty)) r.flags.push(flag("blocker", "tier_order", "quantity breaks are not ascending"));
      if (tiers[i].price > tiers[i - 1].price + 0.005) r.flags.push(flag("warn", "tier_not_descending", "a higher quantity break costs more — kept exactly as published"));
    }
    if (tiers.length && r.dealer_price != null && Math.abs(tiers[0].price - r.dealer_price) >= 0.005) r.flags.push(flag("blocker", "qty1_mismatch", "the first break differs from the dealer price"));
    if (r.map != null && r.msrp != null && r.map > r.msrp + 0.005) r.flags.push(flag("warn", "map_above_msrp", "MAP is above MSRP on the source"));
    if (r.msrp != null && r.dealer_price != null && r.case_qty > 1 && r.msrp_source === "stated" && r.msrp < r.dealer_price / r.case_qty - 0.005) r.flags.push(flag("warn", "msrp_below_unit_cost", "MSRP is below the per-unit dealer cost — check the MSRP basis"));
    if (r.case_qty != null && !(Number.isInteger(r.case_qty) && r.case_qty >= 1)) r.flags.push(flag("blocker", "bad_case_qty", "case quantity is not a whole number"));
    if (seen.has(k)) {
      const first = seen.get(k);
      const same = first.dealer_price === r.dealer_price && JSON.stringify(first.tiers || []) === JSON.stringify(tiers) && first.msrp === r.msrp;
      r.flags.push(flag(same ? "warn" : "blocker", same ? "duplicate_in_source_same_price" : "duplicate_in_source_conflict",
        (same ? "listed twice in the source with the same price (" : "listed twice in the source with DIFFERENT figures (") + (first.locator || "") + " / " + (r.locator || "") + ")"));
      r.duplicate_of = first.locator || true;
    } else seen.set(k, r);
  }
  L.exceptions = ex;
  return L;
}

/* Compare the source with HCPS's existing rows for the line (catalog file rows, and optionally master rows with
   status + priced flag only). Matching is by normalized code; anything else is only a SUGGESTION. */
function compareLine(line, existing) {
  const L = line;
  const e = existing || {};
  const cat = (e.catalog || []).filter(Boolean);
  const master = (e.master || []).filter(Boolean);
  const byCat = new Map(); for (const r of cat) { const k = normCode(r.code); if (k) (byCat.get(k) || byCat.set(k, []).get(k)).push(r); }
  const byMaster = new Map(master.map(r => [normCode(r.code), r]));
  const srcKeys = new Set();
  const rows = [];
  for (const r of L.rows) {
    if (r.duplicate_of) continue;
    const k = normCode(r.code); if (!k) continue; srcKeys.add(k);
    const c = byCat.get(k) || [], m = byMaster.get(k) || null;
    const out = { code: r.code, status: c.length || m ? "matched" : "new", catalog_codes: c.map(x => x.code), master_status: m ? m.status : null, changes: [] };
    if (c.length > 1) out.changes.push({ field: "catalog", detail: "more than one catalog row has this part number" });
    const legacy = c[0];
    if (legacy) {
      // Legacy rows that hold both a list dealer price and a discounted base (Access4U tiers) are compared on the list price.
      const lp = money(legacy.dealer_price != null ? legacy.dealer_price : legacy.base_price);
      if (lp != null && r.dealer_price != null && Math.abs(lp - r.dealer_price) >= 0.005) out.changes.push({ field: "dealer_price", from: lp, to: r.dealer_price });
      const lm = money(legacy.msrp);
      if (r.msrp != null && lm != null && Math.abs(lm - r.msrp) >= 0.005) out.changes.push({ field: "msrp", from: lm, to: r.msrp });
      if (r.map != null && legacy.map != null && Math.abs(money(legacy.map) - r.map) >= 0.005) out.changes.push({ field: "map", from: money(legacy.map), to: r.map });
      if (r.map != null && legacy.map == null) out.changes.push({ field: "map", from: null, to: r.map });
      if (r.case_qty > 1 && Number(legacy.case_qty || legacy.qty_per_pack || 1) !== r.case_qty) out.changes.push({ field: "case_qty", from: legacy.case_qty || legacy.qty_per_pack || null, to: r.case_qty });
      if (!String(legacy.image || "").trim()) out.changes.push({ field: "image", detail: "no image on the catalog row" });
    }
    if (out.status === "matched" && out.changes.some(x => ["dealer_price", "msrp", "map", "case_qty"].includes(x.field))) out.status = "changed";
    if (out.status === "matched" && !out.changes.length) out.status = "unchanged";
    if (out.status === "new") out.suggestions = suggest(k, [...byCat.keys()]);
    rows.push(out);
  }
  const notInSource = [...byCat.keys()].filter(k => !srcKeys.has(k)).map(k => {
    const r = byCat.get(k)[0]; const m = byMaster.get(k);
    return { code: r.code, name: r.name || "", master_status: m ? m.status : null, suggestions: suggest(k, [...srcKeys]) };
  });
  const count = s => rows.filter(r => r.status === s).length;
  return { rows, not_in_source: notInSource,
    summary: { source_rows: L.rows.length, distinct: srcKeys.size, new: count("new"), changed: count("changed"), unchanged: count("unchanged"),
      matched_other: count("matched"), catalog_rows: cat.length, catalog_not_in_source: notInSource.length } };
}

/* A suggestion is only a hint for a person: same letters with a different separator / one character apart. */
function suggest(k, pool) {
  const out = [];
  for (const p of pool) {
    if (p === k) continue;
    if (p.replace(/0/g, "") === k.replace(/0/g, "") || lev(p, k) <= 1) out.push(p);
    if (out.length >= 3) break;
  }
  return out;
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/* The review report for one line: counts + every exception, blockers first. */
function report(line, comparison) {
  const rowFlags = [];
  for (const r of line.rows) for (const f of r.flags || []) rowFlags.push(Object.assign({ code_ref: r.code, locator: r.locator }, f));
  const order = { blocker: 0, warn: 1, info: 2 };
  const all = (line.exceptions || []).concat(rowFlags).sort((a, b) => order[a.level] - order[b.level] || a.code.localeCompare(b.code));
  const priced = line.rows.filter(r => r.dealer_price > 0 && !r.duplicate_of).length;
  return {
    manufacturer: line.manufacturer, source: line.source, terms: line.terms || [],
    counts: Object.assign({ priced, with_msrp: line.rows.filter(r => r.msrp != null && !r.duplicate_of).length,
      with_map: line.rows.filter(r => r.map != null && !r.duplicate_of).length,
      with_tiers: line.rows.filter(r => (r.tiers || []).length > 1 && !r.duplicate_of).length,
      with_options: line.rows.filter(r => (r.options || []).length && !r.duplicate_of).length,
      blockers: all.filter(f => f.level === "blocker").length, warnings: all.filter(f => f.level === "warn").length }, comparison ? comparison.summary : {}),
    exceptions: all,
    stage_ready: !all.some(f => f.level === "blocker"),
  };
}

/* The rows Manufacturer Center's mc_import_source_rows takes (price_imports shape): source facts only; every original
   column stays in raw, with the source provenance on EVERY row (raw._provenance: file, sha256, received date,
   manufacturer effective date — null when the source does not state one, never invented). The case quantity goes as
   case_qty_text, the field mc_import_source_rows parses (MC.parseCaseQty). Built for review — sending them is a
   separate, gated step, and only for a stageable package (buildPackage). */
/* HCPS's received date for a source, with its basis (PR #35 review 2026-10-24; tightened on the PR #39 review). Three
   bases, never mixed — each needs its own anchored evidence, and every hash it names must equal the imported file's:
   · mailbox_attachment_match (VERIFIED) — the manufacturer's email: the exact message (internetMessageId), the mailbox,
     the attachment's name, its SHA-256, Outlook's received timestamp (its Chicago date = the date) and the capture that
     read it (evidence_ref, captured_by). A mismatched hash means the date is NOT assigned (a corrected / re-saved
     file is a different file).
   · hcps_intake_verified (VERIFIED) — a separate HCPS intake record for THIS file: its record reference (intake_ref, e.g.
     an mfr_sources / capture item id), the intake timestamp (its Chicago date = the date), the file SHA-256 and who.
   · hcps_intake_attested (NOT verified) — a person's own statement (attested_by + note + the file SHA-256), recorded as
     such: the line stays blocked (received_attested) until a recorded decision accepts it.
   A bare date (legacy --received) is kept but has no basis (received_unverified). Dates must be real calendar dates and
   never in the future; the received date is never the manufacturer's effective date. Only references and hashes are
   kept — never a subject, body or other message content. */
const RECEIPT_BASES = ["mailbox_attachment_match", "hcps_intake_verified", "hcps_intake_attested"];
const VERIFIED_BASES = ["mailbox_attachment_match", "hcps_intake_verified"];
const SHA_RE = /^[0-9a-f]{64}$/;
const chicagoDate = iso => { const d = new Date(iso); if (isNaN(d)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); };
function calendarDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || "")); if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}
function applyReceipt(line, ev, opts) {
  if (ev == null || ev === "") return line;
  const s = line.source = line.source || {};
  const today = (opts && opts.today) || chicagoDate(new Date().toISOString());
  const checkDate = (d, what) => {
    if (!calendarDate(d)) throw new Error(what + " must be a real calendar date YYYY-MM-DD");
    if (String(d) > String(today)) throw new Error(what + " " + d + " is in the future (today " + today + ")");
  };
  if (typeof ev === "string") {
    checkDate(ev, "received date");
    s.received_date = ev; s.received_basis = null; s.received_evidence = null; return line;
  }
  checkDate(ev.date, "received evidence date");
  if (!RECEIPT_BASES.includes(ev.basis)) throw new Error("received evidence basis must be one of " + RECEIPT_BASES.join(", "));
  const need = (k) => { const v = clean(ev[k]); if (!v) throw new Error(ev.basis + " needs " + k); return v; };
  const sha = (k) => { const v = String(need(k)).toLowerCase(); if (!SHA_RE.test(v)) throw new Error(ev.basis + ": " + k + " must be a SHA-256 (64 hex)"); return v; };
  const stamp = (k) => { const v = need(k); if (!/T\d{2}:\d{2}/.test(v) || !/(Z|[+-]\d{2}:?\d{2})$/.test(v) || !chicagoDate(v))
    throw new Error(ev.basis + ": " + k + " must be an ISO timestamp with a time zone"); const cd = chicagoDate(v);
    if (cd !== ev.date) throw new Error(ev.basis + ": " + k + " is " + cd + " in Chicago, not the stated date " + ev.date); return v; };
  let evidence, fileHash;
  if (ev.basis === "mailbox_attachment_match") {
    const mid = need("message_id"); if (!/^<[^<>\s]+@[^<>\s]+>$/.test(mid)) throw new Error("mailbox_attachment_match: message_id must be the email's internetMessageId (<…@…>)");
    const mbx = need("mailbox"); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mbx)) throw new Error("mailbox_attachment_match: mailbox must be an email address");
    fileHash = sha("attachment_sha256");
    evidence = { basis: ev.basis, verified: true, mailbox: mbx.toLowerCase(), message_id: mid, attachment_name: need("attachment_name"),
      attachment_id: clean(ev.attachment_id) || null, attachment_sha256: fileHash, received_at: stamp("received_at"),
      evidence_ref: need("evidence_ref"), captured_by: need("captured_by") };
  } else if (ev.basis === "hcps_intake_verified") {
    fileHash = sha("file_sha256");
    evidence = { basis: ev.basis, verified: true, intake_ref: need("intake_ref"), intake_at: stamp("intake_at"), file_sha256: fileHash,
      verified_by: need("verified_by") };
  } else {
    fileHash = sha("file_sha256");
    evidence = { basis: ev.basis, verified: false, file_sha256: fileHash, attested_by: need("attested_by"), note: need("note") };
  }
  if (fileHash !== String(s.sha256 || "").toLowerCase()) {
    s.received_date = null; s.received_basis = null; s.received_evidence = null;
    s.received_mismatch = Object.assign({ date_not_assigned: ev.date, source_sha256: s.sha256 || null }, evidence);
    return line;
  }
  s.received_date = ev.date; s.received_basis = ev.basis; s.received_evidence = evidence; delete s.received_mismatch;
  return line;
}
function provenanceOf(line) {
  const s = line.source || {};
  return { file: s.file || null, sha256: s.sha256 || null, received_date: s.received_date || null,
    received_basis: s.received_date && RECEIPT_BASES.includes(s.received_basis) ? s.received_basis : null,
    received_evidence: s.received_date && RECEIPT_BASES.includes(s.received_basis) ? s.received_evidence || null : null,
    received_verified: !!(s.received_date && VERIFIED_BASES.includes(s.received_basis)),
    effective_date: s.effective_date_status === "stated" ? s.effective_date || null : null,
    effective_date_status: s.effective_date_status === "stated" ? "stated" : (s.effective_date_status === "pending" ? "pending" : "not_stated") };
}
function priceImportRows(line) {
  const prov = provenanceOf(line);
  return line.rows.filter(r => !r.duplicate_of && normCode(r.code)).map(r => ({
    code: r.code, description: r.name || r.description || "", base_price: r.dealer_price ?? null,
    msrp: r.msrp_source === "stated" ? r.msrp ?? null : null, map: r.map_source === "stated" ? r.map ?? null : null,
    tiers: (r.tiers || []).length > 1 ? r.tiers.map(t => Object.assign({ min_qty: t.min_qty, price: t.price }, t.pool ? { pool: t.pool } : {})) : null,
    case_qty_text: r.case_qty > 1 ? String(r.case_qty) : null,
    raw: Object.assign({}, r.raw || {}, { _locator: r.locator, _uom: r.uom ?? null, _case_qty: r.case_qty ?? null, _section: r.section ?? null,
      _msrp_source: r.msrp_source ?? null, _map_source: r.map_source ?? null, _source_rule_msrp: r.msrp_source === "source_rule" ? r.msrp : null,
      _source_rule_map: r.map_source === "source_rule" ? r.map : null, _options: r.options || [], _price_scope: r.dealer_price_scope || "dealer",
      _provenance: prov }),
  }));
}

/* The rows stage_record_source takes (Manufacturer Center safe staging, _mc.js planStage). A field the source does
   not state is LEFT OUT — never sent as null — so the record keeps it (an explicit null would be a "would clear").
   status is never sent: listing a SKU does not change its status, and a SKU the source omits is never in the rows,
   so nothing is retired by omission. MSRP / MAP only where STATED; a source-rule figure is not a stated value. */
function stageRows(line) {
  const prov = provenanceOf(line);
  return line.rows.filter(r => !r.duplicate_of && normCode(r.code)).map(r => {
    const o = { code: r.code };
    if (r.dealer_price != null) o.base_price = r.dealer_price;
    if ((r.tiers || []).length > 1) o.tiers = r.tiers.map(t => Object.assign({ min_qty: t.min_qty, price: t.price }, t.pool ? { pool: t.pool } : {}));
    if (r.msrp_source === "stated" && r.msrp != null) o.msrp = r.msrp;
    if (r.map_source === "stated" && r.map != null) o.map = r.map;
    if (r.uom) o.uom = r.uom;
    if (r.case_qty != null) o.case_qty = r.case_qty;
    o._provenance = prov;
    return o;
  });
}

/* ── Lines the importer refuses, and slug aliases ─────────────────────────────────────────────────────────────
   Frozen Gold Standard lines change only through a regression_fix or a new source in Manufacturer Center — never
   through this importer. Complete Medical Supplies is no longer an HCPS partner (Angelo, 2026-10-23). */
const FROZEN_LINES = ["bemis", "climbing-steps", "ovation-medical", "strongback-mobility"];
const REFUSED_LINES = { "complete-medical-supplies": "Complete Medical Supplies is no longer an HCPS partner and is being removed from ordering — nothing is staged for it",
  "complete-medical": "Complete Medical Supplies is no longer an HCPS partner and is being removed from ordering — nothing is staged for it" };
const SLUG_ALIASES = { gce: "ohio-medical" };          // legacy slug → canonical (CLAUDE.md §6)
const CATALOG_FILE_SLUG = { "ohio-medical": "gce" };    // the storefront file is still public/data/gce.json
const canonicalSlug = s => { const k = clean(s).toLowerCase(); return SLUG_ALIASES[k] || k; };
const catalogFileSlug = s => { const c = canonicalSlug(s); return CATALOG_FILE_SLUG[c] || c; };
const slugAliases = s => { const c = canonicalSlug(s); return [c].concat(Object.keys(SLUG_ALIASES).filter(a => SLUG_ALIASES[a] === c)); };
function lineRefusal(slug, frozen) {
  const c = canonicalSlug(slug);
  if (FROZEN_LINES.includes(c) || (frozen || []).map(canonicalSlug).includes(c))
    return { kind: "line_frozen", detail: c + " is a frozen Gold Standard line — the importer never stages it (a change needs a regression_fix or a new source in Manufacturer Center)" };
  if (REFUSED_LINES[c]) return { kind: "activation_hold", detail: REFUSED_LINES[c] };
  return null;
}

/* ── Deterministic per-SKU before / after ─────────────────────────────────────────────────────────────────────
   Every field, for every SKU on the source AND every HCPS SKU the source leaves out. before = what HCPS has
   (catalog layer, master record for status / unit); after = what staging this source would leave (a field the
   source does not state is kept: change "not_stated"). Stable order (normalized code, then code); no clock, no
   random; identical inputs give byte-identical JSON and CSV (beforeAfterHash). */
const BA_FIELDS = ["name", "dealer_price", "tiers", "msrp", "map", "uom", "case_qty", "status"];
const tierText = t => {
  if (Array.isArray(t)) return t.length ? t.map(x => `${x.min_qty != null ? x.min_qty : x.minQty}+:${money(x.price)}${x.pool ? "(" + x.pool + ")" : ""}`).join(" ") : null;
  if (t && typeof t === "object") { const k = Object.keys(t).sort((a, b) => Number(a) - Number(b)); return k.length ? "legacy " + k.map(x => `${x}:${money(t[x])}`).join(" ") : null; }
  return null;
};
const nz = v => (v === undefined || v === "" ? null : v);
function beforeOf(c, m) {
  if (!c && !m) return null;
  c = c || {};
  return { name: nz(clean(c.name)) , dealer_price: money(c.dealer_price != null ? c.dealer_price : c.base_price),
    tiers: tierText(c.tiers) || tierText(c.tier_prices), msrp: money(c.msrp), map: money(c.map),
    uom: nz(m && m.uom != null ? m.uom : c.uom), case_qty: (m && m.case_qty != null ? m.case_qty : (c.case_qty != null ? c.case_qty : (c.qty_per_pack != null ? Number(c.qty_per_pack) : null))),
    status: m ? m.status || null : (c.active === false ? "inactive" : "listed (no master record)") };
}
function afterStated(r) {
  return { name: nz(clean(r.name)), dealer_price: r.dealer_price ?? null, tiers: (r.tiers || []).length > 1 ? tierText(r.tiers) : null,
    msrp: r.msrp_source === "stated" ? r.msrp ?? null : null, map: r.map_source === "stated" ? r.map ?? null : null,
    uom: nz(r.uom), case_qty: r.case_qty ?? null, status: null };
}
function beforeAfter(line, existing) {
  const e = existing || {};
  const byCat = new Map(), byMaster = new Map();
  for (const r of (e.catalog || []).filter(Boolean)) { const k = normCode(r.code); if (k && !byCat.has(k)) byCat.set(k, r); }
  for (const r of (e.master || []).filter(Boolean)) { const k = normCode(r.code); if (k && !byMaster.has(k)) byMaster.set(k, r); }
  const rows = [], seen = new Set();
  for (const r of line.rows) {
    if (r.duplicate_of) continue;
    const k = normCode(r.code); if (!k || seen.has(k)) continue; seen.add(k);
    const b = beforeOf(byCat.get(k), byMaster.get(k)), a = afterStated(r), fields = {};
    for (const f of BA_FIELDS) {
      const was = b ? b[f] ?? null : null; let now = a[f];
      let change;
      if (f === "status") { now = b ? was : "active (new record)"; change = b ? "not_stated" : "added"; }
      else if (now == null) { now = was; change = "not_stated"; }
      else if (was == null) change = "added";
      else change = String(was) === String(now) ? "unchanged" : "changed";
      fields[f] = { before: was, after: now, change };
    }
    const priced = ["dealer_price", "tiers", "msrp", "map", "uom", "case_qty"].some(f => fields[f].change === "changed" || (b && fields[f].change === "added"));
    rows.push({ key: k, code: r.code, row_kind: !b ? "new" : priced ? "changed" : "unchanged", fields });
  }
  const keys = new Set([...byCat.keys(), ...byMaster.keys()]);
  for (const k of keys) {
    if (seen.has(k)) continue;
    const c = byCat.get(k), m = byMaster.get(k), b = beforeOf(c, m), fields = {};
    for (const f of BA_FIELDS) fields[f] = { before: b[f] ?? null, after: b[f] ?? null, change: "not_on_source" };
    rows.push({ key: k, code: (c || m).code, row_kind: "not_on_source_preserved", fields });
  }
  rows.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
  const count = kd => rows.filter(r => r.row_kind === kd).length;
  return { manufacturer: canonicalSlug(line.manufacturer), source: provenanceOf(line), fields: BA_FIELDS,
    summary: { rows: rows.length, new: count("new"), changed: count("changed"), unchanged: count("unchanged"), not_on_source_preserved: count("not_on_source_preserved") },
    rows: rows.map(r => ({ code: r.code, row_kind: r.row_kind, fields: r.fields })) };
}
const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function beforeAfterCsv(ba) {
  const head = ["code", "row_kind"].concat(...ba.fields.map(f => [f + "_before", f + "_after", f + "_change"]));
  return [head.join(",")].concat(ba.rows.map(r => [r.code, r.row_kind].concat(...ba.fields.map(f => [r.fields[f].before, r.fields[f].after, r.fields[f].change])).map(csvCell).join(","))).join("\n") + "\n";
}
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const beforeAfterJson = ba => JSON.stringify(ba, null, 2) + "\n";
const beforeAfterHash = ba => sha256(beforeAfterJson(ba)) + ":" + sha256(beforeAfterCsv(ba));

/* ── Exceptions queue ─────────────────────────────────────────────────────────────────────────────────────────
   One machine-readable record per open question: { id, manufacturer, sku, kind, evidence, source_ref,
   required_decision, status: open|held|resolved, blocking }. A blocking exception stops THIS line from being
   staged; it never stops another manufacturer. "held" = kept as it is until the evidence arrives (preserved legacy
   SKUs, content claims) and does not block price import. A decision recorded by a person (decisions[id]) can
   resolve an open exception; a frozen or refused line can never be resolved here. */
const KIND = {   // row flag → exception kind, required decision, whether it blocks staging
  named_account_price: ["named_account_price", "Is this column a general dealer price? It is quoted for one named account and is never staged as general pricing without Angelo's decision.", true],
  proposed_variant_code: ["proposed_code", "Confirm the part number with the manufacturer; the code shown is a proposal, never invented into the catalog.", true],
  pack_in_text: ["pack_qty_check", "Confirm whether the printed price is per each or per pack/case, and the order unit + case quantity.", true],
  case_qty_unverified: ["case_qty_unverified", "Confirm the case quantity and that the price is per case before it becomes the order unit.", true],
  freight_tbd: ["unsupported_claim", "Freight is 'TBD' on the source: confirm the freight terms with the manufacturer before any freight rule is set.", false],
  minimum_order_qty: ["unsupported_claim", "The source states a minimum order quantity the storefront cannot enforce — decide how to present it.", false],
  source_note: ["source_note", "Read the manufacturer's note on this row and decide whether it changes anything.", false],
  tier_not_descending: ["source_anomaly", "A higher quantity break costs more on the source; kept exactly as published — confirm with the manufacturer.", false],
  map_above_msrp: ["source_anomaly", "MAP is above MSRP on the source — confirm with the manufacturer.", false],
  msrp_below_unit_cost: ["source_anomaly", "MSRP is below the per-unit dealer cost — confirm the MSRP basis.", false],
  duplicate_in_source_same_price: ["source_duplicate", "Listed twice with the same figures — informational.", false],
  ocr_unconfirmed: ["ocr_unconfirmed", "Confirm the transcribed value against the page image.", false],
};
const OTC_CLAIM = /antifungal|anti-fungal|salicylic|clotrimazole|tolnaftate|undecylenic|lidocaine|analgesic|\bcures?\b|\btreats?\b/i;
const MED_BED = /hospital[- ]bed|medical[- ]bed|bed[- ]sore|pressure (ulcer|injur)|clinically/i;
const capacityOf = t => { const m = String(t || "").match(/(\d[\d,]*)\s*(?:LB|LBS|lb|lbs)\.?\s*(?:weight\s*)?capacity/i); return m ? Number(m[1].replace(/,/g, "")) : null; };
function exceptionsFor(line, comparison, ctx) {
  ctx = ctx || {};
  const mfr = canonicalSlug(line.manufacturer), out = [];
  const add = (sku, kind, evidence, source_ref, required_decision, blocking, status) =>
    out.push({ manufacturer: mfr, sku: sku || null, kind, evidence, source_ref: source_ref || null, required_decision, status: status || (blocking ? "open" : "held"), blocking: !!blocking });
  const src = line.source || {};
  const sref = src.file || null;
  const refusal = lineRefusal(mfr, ctx.frozen);
  if (refusal) {   // a refused line gets exactly one exception: the refusal (its rows are never parsed or queued)
    add(null, refusal.kind, refusal.detail, sref, refusal.kind === "line_frozen" ? "None here — use Manufacturer Center (regression_fix or a new source)." : "None — the line is not staged.", true);
    for (const x of out) x.id = x.kind + ":" + mfr + ":-:" + sha256(x.evidence).slice(0, 8);
    return out;
  }
  for (const e of line.exceptions || []) {
    if (e.level === "blocker") add(null, e.code, e.detail, sref, "Resolve before staging.", true);
  }
  if (src.received_mismatch) add(null, "received_date_mismatch", `received date ${src.received_mismatch.date_not_assigned} NOT assigned: the evidence file ` +
    `${src.received_mismatch.attachment_name || src.received_mismatch.intake_ref || "(evidence)"} (sha256 ${String(src.received_mismatch.attachment_sha256 || src.received_mismatch.file_sha256).slice(0, 12)}…) is not the imported file ` +
    `(sha256 ${String(src.received_mismatch.source_sha256 || "").slice(0, 12)}…)`, sref,
    "Find the email that carried THIS file (same SHA-256), or record a separately verified HCPS intake date for it.", true);
  else if (src.received_date && !RECEIPT_BASES.includes(src.received_basis)) add(null, "received_unverified", `received date ${src.received_date} has no recorded basis`, sref,
    "Record how the date is known: the email attachment's SHA-256 matching this file, or a separately verified HCPS intake (who + how).", true);
  else if (src.received_basis === "hcps_intake_attested") add(null, "received_attested", `received date ${src.received_date} is attested by ${(src.received_evidence || {}).attested_by || "a person"}, not verified`, sref,
    "Find the email or HCPS intake record that proves when THIS file arrived, or record a decision (who + why) to accept the attestation.", true);
  if (!src.received_date) add(null, "provenance_incomplete", "no HCPS received date for the source file — Manufacturer Center registers a source only with its received date", sref, "Give the date HCPS received the file (the email's received time); never invented.", true);
  // A source that is not the current list is never staged as current without the manufacturer's written confirmation.
  const year = Number(ctx.today ? String(ctx.today).slice(0, 4) : new Date().getUTCFullYear());
  const effYear = src.effective_date ? Number(String(src.effective_date).slice(0, 4)) : null;
  const titleYears = (String(src.title || "") + " " + String(src.file || "")).match(/\b20\d\d\b/g) || [];
  const srcYear = effYear || (titleYears.length ? Math.max(...titleYears.map(Number)) : null);
  if (srcYear != null && srcYear < year && !(ctx.confirmations || {}).current_source)
    add(null, "not_current_source", `the source is dated ${srcYear} (${src.title || src.file}); it is not called ${year} or current without the manufacturer's written confirmation`, sref,
      "Obtain the manufacturer's written confirmation that this list is current, or a current list.", true);
  for (const r of line.rows) {
    for (const f of r.flags || []) {
      const k = KIND[f.code];
      if (k) { add(r.code, k[0], f.detail, r.locator, k[1], k[2]); continue; }
      if (f.level === "blocker") add(r.code, f.code, f.detail, r.locator, "Resolve before staging.", true);
    }
    const text = [r.name, r.description, r.section].join(" ");
    if (/warrant/i.test(text)) add(r.code, "warranty_conflict", "warranty terms are part of the source's product text: \"" + clean(r.name).slice(0, 160) + "\"", r.locator,
      "Confirm the warranty terms against the manufacturer's warranty document before any warranty content is published.", false);
    if (OTC_CLAIM.test(text)) add(r.code, "unsupported_claim", "OTC drug / treatment wording in the product text — held until evidenced by the manufacturer's labelling", r.locator,
      "Confirm the claim against the manufacturer's drug-facts label before it appears in content.", false);
    if (MED_BED.test(text)) add(r.code, "unsupported_claim", "medical / clinical suitability wording in the product text — held until evidenced", r.locator,
      "Confirm the claim with the manufacturer before it appears in content.", false);
  }
  if (comparison) {
    const byCode = new Map((ctx.catalog || []).map(c => [normCode(c.code), c]));
    for (const r of comparison.rows) {
      if (r.status === "new" && (r.suggestions || []).length)
        add(r.code, "uncertain_part_number", "not in the HCPS catalog; close to existing " + r.suggestions.join(", ") + " — possibly the same item with a typo", null,
          "Confirm with the manufacturer whether this is a new item or an existing code; nothing is merged or renamed automatically.", true);
    }
    for (const n of comparison.not_in_source || [])
      add(n.code, "legacy_not_on_source", "an HCPS SKU the source does not list — PRESERVED, status unchanged (" + (n.master_status || "no master record") + "); never retired by omission", null,
        "Decide with the manufacturer whether it is still offered; any retirement is a separate, approved Manufacturer Center action.", false);
    for (const r of line.rows) {
      if (r.duplicate_of) continue;
      const c = byCode.get(normCode(r.code)); if (!c) continue;
      const legacyTiers = (c.tier_prices && Object.keys(c.tier_prices).length) || (Array.isArray(c.tiers) && c.tiers.length > 1) ||
        (c.dealer_price != null && c.base_price != null && money(c.base_price) < money(c.dealer_price));
      if (legacyTiers && !((r.tiers || []).length > 1))
        add(r.code, "discount_unverified", "HCPS holds an older discount/tier structure (" + (tierText(c.tier_prices) || tierText(c.tiers) || ("base " + money(c.base_price))) + ") that the source does not state — kept only as history", r.locator,
          "Confirm the current discount terms with the manufacturer; an old structure is never assumed to apply to the new list.", false);
      const sc = capacityOf(r.name + " " + (r.description || "")), cc = capacityOf((c.name || "") + " " + (c.description || ""));
      if (sc != null && cc != null && sc !== cc)
        add(r.code, "capacity_conflict", `the source states ${sc} lb capacity; the HCPS catalog states ${cc} lb`, r.locator, "Confirm the weight capacity with the manufacturer.", false);
      const img = String(c.image || "").trim();
      if (img && !/^\/assets\//.test(img) && !/supabase|homecareproviderservices/.test(img))
        add(r.code, "image_rights", "the catalog photo is hosted outside HCPS (" + img.slice(0, 120) + ") — licence not recorded", null, "Confirm the image licence, then rehost it.", false);
    }
  }
  for (const h of ctx.holds || []) if (canonicalSlug(h.manufacturer) === mfr)
    add(h.sku || null, h.kind, h.evidence, h.source_ref || null, h.required_decision || "Hold until evidenced.", !!h.blocking);
  // stable ids + order; recorded decisions resolve open (non-refusal) exceptions
  for (const x of out) x.id = x.kind + ":" + mfr + ":" + (x.sku ? normCode(x.sku) : "-") + ":" + sha256(x.evidence).slice(0, 8);
  const seen = new Set(), list = [];
  for (const x of out) { if (seen.has(x.id)) continue; seen.add(x.id); list.push(x); }
  const dec = ctx.decisions || {};
  for (const x of list) {
    const d = dec[x.id];
    if (!d) continue;   // (a refused line never reaches here: it returned above with its refusal only)
    if (d.status === "resolved" && d.decided_by && d.reason) { x.status = "resolved"; x.blocking = false; x.decision = { decided_by: d.decided_by, reason: d.reason, value: d.value ?? null }; }
  }
  const lvl = x => (x.blocking ? 0 : x.status === "held" ? 1 : 2);
  list.sort((a, b) => lvl(a) - lvl(b) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

/* ── The package: stop on any blocker ─────────────────────────────────────────────────────────────────────────
   A line with ANY blocking exception is not stageable and gets NO import rows at all (handoff null) — the safer
   choice: a file of rows marked "do not use" can still be pasted; rows that were never written cannot. The review
   (before/after, exceptions) is always produced. A stageable package carries the exact Manufacturer Center
   payloads: register facts, mc_import_source_rows and stage_record_source (dry run first, gate 1 — source_id is
   filled in only after the file is registered and accepted). */
function buildPackage(line, comparison, ctx) {
  ctx = ctx || {};
  const mfr = canonicalSlug(line.manufacturer);
  const exceptions = exceptionsFor(line, comparison, ctx);
  const ba = beforeAfter(line, { catalog: ctx.catalog || [], master: ctx.master || [] });
  const blocking = exceptions.filter(x => x.blocking);
  const stageable = blocking.length === 0;
  const prov = provenanceOf(line);
  return { manufacturer: mfr, stageable,
    withheld_reason: stageable ? null : blocking.length + " blocking exception(s) — no import rows were produced for this line",
    counts: { blocking: blocking.length, held: exceptions.filter(x => x.status === "held").length, resolved: exceptions.filter(x => x.status === "resolved").length, total: exceptions.length },
    before_after_sha256: beforeAfterHash(ba), before_after: ba, exceptions,
    handoff: !stageable ? null : {
      register: { manufacturer: mfr, kind: "price_list", file_name: prov.file, sha256: prov.sha256, received_date: prov.received_date,
        manufacturer_effective_date: prov.effective_date, effective_date_status: prov.effective_date_status === "stated" ? "stated" : "pending" },
      mc_import_source_rows: { action: "mc_import_source_rows", manufacturer: mfr, source_id: null, rows: priceImportRows(line) },
      stage_record_source: { action: "stage_record_source", manufacturer: mfr, source_id: null, source_file: prov.file, dry_run: true, rows: stageRows(line) },
    } };
}

module.exports = { normCode, money, clean, flag, validateLine, compareLine, report, priceImportRows, stageRows, provenanceOf, suggest,
  FROZEN_LINES, REFUSED_LINES, canonicalSlug, catalogFileSlug, slugAliases, lineRefusal, beforeAfter, beforeAfterCsv, beforeAfterJson, beforeAfterHash,
  exceptionsFor, buildPackage, sha256, applyReceipt, RECEIPT_BASES, VERIFIED_BASES, calendarDate };

/* Ship-To review (Phase C, CLAUDE.md §18 "Ship-To Correction & Branch Assignment"). Pure: no database, no network.

   Given a report's canonical rows (from _report_rows.js), the dealer matcher, the verified mappings, the saved ZIP
   assignments and the corrections saved for this report, it answers — per ORDER, never per invoice line — which HCPS
   branch the order belongs to and why, or why it needs a person:

     resolved      a reliable answer from the strict resolver (verified mapping, ZIP assignment, one dealer, a unique
                   ZIP / street inside the family)
     corrected     a person chose the branch (the latest version of their correction for this order)
     needs_review  no reliable answer: shared ZIP, new location, billing address only, no ship-to, weak evidence,
                   lines of one order that disagree, or no dealer found for the company / account at all

   The report is "ready" only when no order needs review; otherwise it is "held" as a whole (no partial import).
   Corrections are an OVERLAY: the reported values are never changed — the corrected ship-to and the chosen branch sit
   beside them, and the corrected export appends HCPS columns to the original ones. */
const crypto = require("crypto");
const SH = require("./_shipto.js");
const { znorm, naddr, nref } = SH._internal;

const SHIP_FIELDS = ["ship_name", "ship_address", "ship_city", "ship_state", "ship_zip", "ship_to_id"];
const REPORTED = ["company", "account_ref", ...SHIP_FIELDS, "bill_address", "bill_city", "bill_state", "bill_zip"];
const num = v => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : null; };
const r2 = n => Math.round(n * 100) / 100;
const lineAmount = r => { const la = num(r.line_amount); if (la != null) return la; return r2((num(r.unit_price) || 0) * (num(r.qty) || 0)); };

// Group lines into orders. A line without an order number is its own order (keyed by its line in the file).
function groupOrders(rows) {
  const m = new Map();
  for (const r of rows) {
    const on = String(r.order_number || "").trim();
    const key = on ? "o:" + on : "l:" + r.line;
    (m.get(key) || m.set(key, []).get(key)).push(r);
  }
  return [...m.entries()].map(([order_key, lines]) => ({ order_key, order_number: String(lines[0].order_number || "").trim() || null, lines }));
}

// What the file says about the order, and whether its lines agree on it.
function reportedOf(lines) {
  const first = lines[0], rep = {};
  for (const k of REPORTED) rep[k] = String(first[k] == null ? "" : first[k]).trim();
  const sig = r => [nref(r.account_ref), String(r.company || "").trim().toUpperCase(), znorm(r.ship_zip), naddr(r.ship_address), String(r.ship_to_id || "").trim().toLowerCase()].join("|");
  const mixed = new Set(lines.map(sig)).size > 1;
  return { reported: rep, mixed };
}

// A fingerprint of the order AS READ (every original cell of every line) — a correction is tied to exactly what the
// person saw; if the stored file somehow differed, the correction would not silently apply.
function orderFingerprint(lines) {
  return crypto.createHash("sha256").update(JSON.stringify(lines.map(l => [l.line, l.raw]))).digest("hex").slice(0, 32);
}

// The families (root dealer ids) an order's account number belongs to for this manufacturer; empty = nothing can be
// remembered for this order (no account number, or one HCPS has no record of).
function rememberRoots(matcher, reported) {
  const ref = nref(reported && reported.account_ref);
  if (!ref || !SH.shipKey(reported) || !matcher || typeof matcher.accountRoots !== "function") return [];
  return [...matcher.accountRoots(ref)];
}

/* rows: canonical rows · ctx: { matcher (SH.makeMatcher), mappings:[…this manufacturer…], zipmap, corrections:[…this report…] }
   → { status:"ready"|"held"|"empty", counts, totals, orders:[…] } */
function buildReview(rows, ctx) {
  ctx = ctx || {};
  const latest = new Map();
  for (const c of (ctx.corrections || [])) { const p = latest.get(c.order_key); if (!p || c.version > p.version) latest.set(c.order_key, c); }
  const orders = groupOrders(rows || []).map(o => {
    const { reported, mixed } = reportedOf(o.lines);
    const amount = r2(o.lines.reduce((s, l) => s + lineAmount(l), 0));
    const fp = orderFingerprint(o.lines);
    const cands = ctx.matcher ? ctx.matcher.candidates(reported) : [];
    const base = { order_key: o.order_key, order_number: o.order_number, lines: o.lines.length, file_lines: o.lines.map(l => l.line),
      amount, date: String(o.lines[0].date || "").trim(), reported, fingerprint: fp, ship_key: SH.shipKey(reported),
      candidates: cands.map(c => ({ dealer_id: c.id, name: c.business_name || null, branch: !!c.parent_id, root: c.parent_id || c.id, city: c.city || null, state: c.state || null, zip: c.zip || null, address: c.address || null })),
      // A choice may be REMEMBERED (reused for later orders) only with an account number that this manufacturer's
      // records tie to the chosen dealer's family, and a ship-to key — rememberRoots lists those families.
      remember_roots: rememberRoots(ctx.matcher, reported) };
    const cor = latest.get(o.order_key);
    if (cor) {
      if (cor.order_fingerprint !== fp) return Object.assign(base, { status: "needs_review", reason: "correction_stale", correction: cor, dealer_id: null, basis: null, suggestions: [] });
      return Object.assign(base, { status: "corrected", dealer_id: cor.dealer_id, basis: cor.scope === "corporate" ? "corporate_confirmed" : "person", correction: cor, suggestions: [] });
    }
    if (mixed) return Object.assign(base, { status: "needs_review", reason: "mixed_lines", dealer_id: null, basis: null, suggestions: [] });
    if (!cands.length) return Object.assign(base, { status: "needs_review", reason: "no_dealer_match", dealer_id: null, basis: null, suggestions: [] });
    const r = SH.resolveBranch(cands, reported, { mode: "strict", mappings: ctx.mappings || [], zipmap: ctx.zipmap || null,
      rootOf: ctx.matcher && ctx.matcher.rootOf, accountRoots: ctx.matcher && ctx.matcher.accountRoots });
    if (r.review || !r.dealer_id) return Object.assign(base, { status: "needs_review", reason: r.reason || "weak_evidence", dealer_id: null, basis: null, suggestions: r.suggestions || [] });
    return Object.assign(base, { status: "resolved", dealer_id: r.dealer_id, basis: r.basis, mapping_id: r.mapping_id || null, suggestions: [] });
  });
  const counts = { orders: orders.length, lines: (rows || []).length, resolved: 0, corrected: 0, needs_review: 0 };
  const byReason = {};
  for (const o of orders) { counts[o.status]++; if (o.status === "needs_review") byReason[o.reason] = (byReason[o.reason] || 0) + 1; }
  const total = r2(orders.reduce((s, o) => s + o.amount, 0)), held = r2(orders.filter(o => o.status === "needs_review").reduce((s, o) => s + o.amount, 0));
  return { status: !orders.length ? "empty" : counts.needs_review ? "held" : "ready", counts, needs_review_by_reason: byReason,
    totals: { amount: total, amount_needing_review: held }, orders };
}

// The corrected report: the ORIGINAL columns and cells untouched, HCPS columns appended. CSV text.
const CSV_COLS = ["HCPS Status", "HCPS Branch", "HCPS Branch ID", "HCPS Basis", "HCPS Corrected Ship Name", "HCPS Corrected Ship Address",
  "HCPS Corrected Ship City", "HCPS Corrected Ship State", "HCPS Corrected Ship ZIP", "HCPS Correction"];
const cell = v => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function correctedCsv(headers, rows, review, nameOf) {
  const byLine = new Map();
  for (const o of review.orders) for (const ln of o.file_lines) byLine.set(ln, o);
  const out = [headers.concat(CSV_COLS).map(cell).join(",")];
  for (const r of rows) {
    const o = byLine.get(r.line) || {}; const c = o.correction || null;
    const extra = [o.status || "", o.dealer_id ? (nameOf(o.dealer_id) || "") : "", o.dealer_id || "", o.basis || o.reason || "",
      c ? c.ship_name || "" : "", c ? c.ship_address || "" : "", c ? c.ship_city || "" : "", c ? c.ship_state || "" : "", c ? c.ship_zip || "" : "",
      c ? `v${c.version} · ${c.actor} · ${c.created_at || ""} · ${c.reason || ""}` : ""];
    const raw = headers.map((_, i) => r.raw[i] == null ? "" : r.raw[i]);
    out.push(raw.concat(extra).map(cell).join(","));
  }
  return out.join("\r\n") + "\r\n";
}

/* Shadow validation against HISTORY (read-only): orders already in monthly_sales, with the branch HCPS booked them to
   (manual imports, incl. hand-corrected reports), run through the strict resolver as the automated path would. The
   booked branch is the BASELINE; nothing is ever written.
   Source lanes are kept apart (Angelo, 2026-10-11 22:09) with the MI-1a rule (hcps_ms_is_commission_lane):
     sales_report  source = 'sales_report'
     commission    source = 'commission', or legacy rows with no source AND no external_ref
     other         anything else
   A commission line is never counted as a sales-report transaction; each lane has its own counts, and an order that
   appears in two lanes booked to different branches is reported as a lane disagreement.
   history rows: { invoice_no, customer_name, customer_ref, ship_*, dealer_id, amount, period, source, external_ref }
   → { orders, same, held, different, unmatched_history, mixed_history, by_lane:{…}, lane_disagreements, list:[…] }.
   "different" must be zero before automation. */
const LANES = ["sales_report", "commission", "other"];
function laneOf(h) {
  const src = h.source == null ? null : String(h.source);
  if (src === "sales_report") return "sales_report";
  if (src === "commission" || (src == null && (h.external_ref == null))) return "commission";
  return "other";
}
function shadow(history, ctx) {
  const rows = (history || []).map((h, i) => ({ line: i + 1, raw: [], order_number: h.invoice_no || "", company: h.customer_name || "", account_ref: h.customer_ref || "",
    ship_name: h.ship_name || "", ship_address: h.ship_address || "", ship_city: h.ship_city || "", ship_state: h.ship_state || "", ship_zip: h.ship_zip || "",
    line_amount: h.amount, date: h.period || "", _dealer: h.dealer_id || null, _period: String(h.period || "").slice(0, 7), _lane: laneOf(h), _id: h.id == null ? null : h.id }));
  const m = new Map();
  for (const r of rows) { const k = r._lane + "|" + (r._period || "") + "|" + (String(r.order_number).trim() || "l" + r.line); (m.get(k) || m.set(k, []).get(k)).push(r); }
  const blank = () => ({ lines: 0, orders: 0, same: 0, held: 0, different: 0, unmatched_history: 0, mixed_history: 0, held_reasons: {} });
  const res = Object.assign(blank(), { by_lane: {}, lane_disagreements: 0, list: [] });
  for (const l of LANES) res.by_lane[l] = blank();
  const bookedByTxn = new Map();      // period|invoice → { lane → booked dealer }
  for (const [k, lines] of m) {
    const lane = lines[0]._lane, L = res.by_lane[lane];
    L.orders++; L.lines += lines.length; res.orders++; res.lines += lines.length;
    const booked = new Set(lines.map(l => l._dealer || ""));
    const r = buildReview(lines, { matcher: ctx.matcher, mappings: ctx.mappings, zipmap: ctx.zipmap }).orders;
    const strict = r.length === 1 ? r[0] : null;
    const was = booked.size === 1 ? [...booked][0] : null;
    const row = { key: k, lane, period: lines[0]._period, invoice: String(lines[0].order_number || "").trim() || null, company: lines[0].company,
      account_ref: lines[0].account_ref, ship_zip: lines[0].ship_zip, ship_city: lines[0].ship_city, lines: lines.length,
      amount: r2(lines.reduce((s, l) => s + (num(l.line_amount) || 0), 0)), booked: was, strict: strict ? strict.dealer_id : null,
      basis: strict ? (strict.basis || strict.reason) : "split", row_ids: lines.map(l => l._id).filter(x => x != null) };
    let outcome;
    if (booked.size > 1) outcome = "mixed_history";
    else if (!was) outcome = "unmatched_history";
    else if (!strict || strict.status === "needs_review") { outcome = "held"; const why = strict ? strict.reason : "split";
      L.held_reasons[why] = (L.held_reasons[why] || 0) + 1; res.held_reasons[why] = (res.held_reasons[why] || 0) + 1; }
    else outcome = strict.dealer_id === was ? "same" : "different";
    row.outcome = outcome; L[outcome]++; res[outcome]++;
    if (outcome !== "same") res.list.push(row);
    if (row.invoice && was) { const t = row.period + "|" + row.invoice; (bookedByTxn.get(t) || bookedByTxn.set(t, {}).get(t))[lane] = was; }
  }
  res.lane_disagreement_list = [];
  for (const [t, by] of bookedByTxn) { const vals = Object.values(by); if (vals.length > 1 && new Set(vals).size > 1) { res.lane_disagreements++; res.lane_disagreement_list.push({ txn: t, booked: by }); } }
  return res;
}

module.exports = { buildReview, groupOrders, orderFingerprint, correctedCsv, shadow, laneOf, rememberRoots, lineAmount, SHIP_FIELDS, CSV_COLS };

/* Phase D — the SOURCE-AWARE import check (Angelo, 2026-10-12 12:43 CT). Pure: no database, no network.

   The automatic path will start from a REGISTERED order export (MI-1b register), never from rows a browser sends:
     stored original → canonical rows (_report_rows.js) → Ship-To review (_shipto_review.js: the STRICT resolver plus the
     saved, verified correction overlays) → MI-1a rows → hcps_sales_report_apply with apply:false (a dry run).
   A report with ANY order whose branch is unresolved is HELD as a whole: no MI-1a rows are built for it at all.

   This module builds the MI-1a rows and judges eligibility. It never decides to write: automatic financial posting is
   OFF, and nothing in Phase D sends apply:true. The manual Sales Report Import (sales-import-api.js) is untouched; its
   mapRow is copied here VERBATIM and test/source-import.test.js fails if the two ever differ. */
const clean = (v, n) => { const s = (v == null ? "" : String(v)).trim(); return s ? s.slice(0, n || 400) : null; };
const num = v => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : null; };
const period = d => { const s = String(d || ""); const m = s.match(/(\d{4})-(\d{2})/); if (m) return m[1] + "-" + m[2] + "-01"; const dt = new Date(s); return isNaN(dt) ? null : (dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-01"); };
const dateOnly = d => { const s = String(d || ""); const m = s.match(/\d{4}-\d{2}-\d{2}/); if (m) return m[0]; const dt = new Date(s); return isNaN(dt) ? null : dt.toISOString().slice(0, 10); };
const r2 = n => Math.round(n * 100) / 100;

// <verbatim:mapRow> — sales-import-api.js mapRow, unchanged (drift-tested).
function mapRow(slug, rate, source_file, row, idx){
  const qty=num(row.qty)||0, up=num(row.unit_price);
  const amount=Math.round(((row.line_amount!=null&&row.line_amount!=="")?(num(row.line_amount)||0):((up||0)*qty))*100)/100;
  const commission=Math.round(amount*rate*100)/100;
  const order=clean(row.order_number,60);
  const code=clean(row.product_code,80), name=clean(row.product_name,200)||code;
  const ext=`${slug}|${order||"na"}|${(code||name||"").slice(0,40)}|${idx}`;
  return {
    manufacturer:slug, period:period(row.date), order_date:dateOnly(row.date),
    invoice_no:order, product_code:code, product_name:name, qty,
    amount, commission, commission_rate:rate,
    customer_name:clean(row.company,180), customer_ref:clean(row.account_ref,80),
    ship_city:clean(row.ship_city,80), ship_state:clean(row.ship_state,40), ship_zip:clean(row.ship_zip,20),
    line_type:amount>0?"sale":"collateral", source:"sales_report", external_ref:ext,
    source_file:source_file||null, imported_at:new Date().toISOString()
  };
}
// </verbatim:mapRow>

/* The commission rate an automatic import may use. Only a rate the manufacturer's existing sales-report history states
   with ONE value (the rate a person has always imported this manufacturer at) — never a guess. */
function rateFromHistory(rates) {
  const set = [...new Set((rates || []).map(r => num(r)).filter(r => r != null && r > 0 && r < 1))];
  return set.length === 1 ? { rate: set[0], basis: "history_single_rate" } : { rate: null, basis: set.length ? "history_mixed_rates" : "no_history", rates: set };
}

/* review: RV.buildReview(...) result · rows: the canonical rows · opts: { slug, rate, source_file, repOf? }
   → { status, held_orders, orders, mi_rows, totals } — mi_rows is EMPTY unless every order is resolved or corrected. */
function plan(review, rows, opts) {
  opts = opts || {};
  const status = review && review.status || "empty";
  const held = (review.orders || []).filter(o => o.status === "needs_review")
    .map(o => ({ order_key: o.order_key, order_number: o.order_number, reason: o.reason, amount: o.amount, company: o.reported && o.reported.company }));
  if (status !== "ready") return { status, held_orders: held, orders: [], mi_rows: [], totals: { lines: (rows || []).length, amount: review.totals ? review.totals.amount : 0 } };
  const byLine = new Map((rows || []).map(r => [r.line, r]));
  const mi_rows = [], orders = [];
  let idx = 0;
  for (const o of review.orders) {
    const cor = o.status === "corrected" ? (o.correction || {}) : null;
    let amt = 0, com = 0;
    for (const ln of o.file_lines) {
      const src = byLine.get(ln); if (!src) continue;
      // The overlay: the person's corrected ship-to (when given) sits on top of the file's values; the file never changes.
      const row = Object.assign({}, src);
      if (cor) for (const k of ["ship_name", "ship_city", "ship_state", "ship_zip"]) if (cor[k]) row[k] = cor[k];
      const rec = mapRow(opts.slug, opts.rate, opts.source_file, row, idx++);
      delete rec.external_ref;                                   // the MI-1a function keys every line itself
      rec.dealer_id = o.dealer_id; rec.rep_name = typeof opts.repOf === "function" ? (opts.repOf(o.dealer_id) || null) : null;
      amt += rec.amount; com += rec.commission; mi_rows.push(rec);
    }
    orders.push({ order_key: o.order_key, order_number: o.order_number, date: o.date, status: o.status, basis: o.basis, dealer_id: o.dealer_id,
      lines: o.lines, amount: r2(amt), commission: r2(com), company: o.reported.company, account_ref: o.reported.account_ref,
      ship_city: o.reported.ship_city, ship_state: o.reported.ship_state, ship_zip: o.reported.ship_zip,
      correction_version: cor ? cor.version : null });
  }
  return { status, held_orders: [], orders, mi_rows,
    totals: { lines: mi_rows.length, amount: r2(mi_rows.reduce((s, r) => s + r.amount, 0)), commission: r2(mi_rows.reduce((s, r) => s + r.commission, 0)) } };
}

/* Is this report financially eligible for import? Every blocker needs a person; cautions are shown, never blocking.
   Inputs (all read-only facts): plan, enrolled, rate, v2 (dry-run result or {refused}), existing (monthly_sales rows of
   the file's order numbers, any lane), quarantined (quarantine rows for the same orders), statements (registered
   commission statements covering the file's months), commissionLaneRows (commission-lane rows in those months). */
/* Phase E (Angelo, 2026-10-12 18:40 CT): findings split three ways.
     blockers   — never imported, approved or not (fix the cause: Ship-To, MI-1a refusal, collisions, rate, lanes…)
     approvals  — genuine financial exceptions the President may approve for THIS exact plan: existing orders change,
                  a cross-lane match, a paid / locked month, and a quarantined month whose rows he has disposed
                  "keep quarantined" while releasing this one registered export to be considered on its own
     cautions   — shown, never blocking
   eligible = no blocker and no approval item → may be imported automatically (when the switch is on);
   approvable = no blocker, ≥ 1 approval item → waits for the President's approval of this exact plan. */
const APPROVABLE = new Set(["changes_existing_orders", "cross_lane_duplicate", "paid_period", "quarantine_released"]);
function verdict(f) {
  const B = [], C = [];
  const block = (code, text, extra) => B.push(Object.assign({ code, text }, extra || {}));
  const caution = (code, text, extra) => C.push(Object.assign({ code, text }, extra || {}));
  const p = f.plan || {};
  if (p.status === "held") block("ship_to_review", `${p.held_orders.length} order(s) need a Ship-To decision — the report is held as a whole.`);
  if (p.status === "empty") block("empty_report", "The file holds no order lines.");
  if (!f.enrolled) block("not_enrolled", "This manufacturer is not enrolled in MI-1a for sales reports — only the manual import applies.");
  if (!(f.rate && f.rate.rate)) block("rate_unknown", "No single commission rate in this manufacturer's sales-report history; a person must set it.");
  const v2 = f.v2 || null;
  if (v2 && v2.refused) block("mi1a_refused", `MI-1a refused the dry run: ${v2.code}`, { message: v2.message });
  if (v2 && !v2.refused) {
    const o = v2.orders || {};
    if ((v2.semantic_collisions || []).length) block("semantic_collision", `${v2.semantic_collisions.length} order number(s) look like two different orders.`);
    if (v2.cross_lane_matches > 0) block("cross_lane_duplicate", `${v2.cross_lane_matches} line(s) match commission-statement lines already in HCPS.`);
    if (v2.needs_paid_approval) block("paid_period", `Touches month(s) holding a commission statement or a lock: ${(v2.locked_months_touched || []).join(", ")}.`);
    if ((o.changed || 0) > 0) block("changes_existing_orders", `${o.changed} order(s) already in HCPS would change.`);
    if ((o.retire || 0) > 0) block("retires_orders", `${o.retire} order(s) would be retired.`);
    if ((v2.missing_from_file || []).length) caution("orders_missing_from_file", `${v2.missing_from_file.length} HCPS order(s) in the same date range are not in this file (left as they are; never retired automatically).`);
    if ((v2.nonfinancial_differences || []).length) caution("nonfinancial_differences", `${v2.nonfinancial_differences.length} name / ship-to difference(s) — HCPS attribution is kept.`);
  }
  const q = f.quarantined || [];
  if (q.length) block("previously_quarantined", `${q.length} quarantined row(s) carry the same order numbers (${[...new Set(q.map(x => x.invoice_no))].join(", ")}). They are never converted into sales automatically.`);
  const qp = (f.quarantinedPeriod || []).filter(x => !q.some(y => y.id === x.id));
  if (qp.length) {
    // A disposition releases ONLY the export it names, ONLY while the quarantined rows are exactly the ones disposed of
    // (same ids, same fingerprint). The rows themselves stay quarantined — permanently — and are never converted.
    const months = [...new Set(qp.map(x => String(x.period).slice(0, 7)))];
    const disp = f.dispositions || [];
    const released = months.every(mo => { const d = disp.find(x => String(x.period).slice(0, 7) === mo);
      const ids = qp.filter(x => String(x.period).slice(0, 7) === mo).map(x => Number(x.id));
      return d && d.disposition === "keep_quarantined" && Number(d.release_source_id) === Number(f.sourceId) && d.fp_current === d.quarantine_fp
        && ids.every(id => (d.quarantine_ids || []).map(Number).includes(id)); });
    const files = [...new Set(qp.map(x => x.source_file).filter(Boolean))].join(", ") || "no file name";
    if (released) block("quarantine_released", `${qp.length} quarantined row(s) of ${months.join(", ")} (${files}) are kept quarantined permanently by your disposition; this registered export was released to be considered on its own. Importing it still needs your approval.`,
      { dispositions: disp.filter(d => months.includes(String(d.period).slice(0, 7))).map(d => d.id) });
    else block("quarantined_period", `${qp.length} quarantined row(s) are on file for the same month(s) (${months.join(", ")}, ${files}). That month's quarantined data is never converted into sales automatically — Angelo decides.` +
      (disp.some(d => months.includes(String(d.period).slice(0, 7))) ? " A disposition exists for the month, but it does not release this file or the quarantined rows have changed since it was recorded." : ""));
  }
  const ex = f.existing || [];
  const otherLanes = ex.filter(r => r.lane !== "sales_report");
  if (otherLanes.length) block("other_lane_rows", `${otherLanes.length} row(s) with these order numbers are in another lane (${[...new Set(otherLanes.map(r => r.lane))].join(", ")}).`);
  for (const s of (f.statements || [])) caution("statement_registered", `A commission statement is registered for ${s.period} (record #${s.id}, ${s.status}${s.imported ? "" : ", not imported"}). Its figures stay in the commission lane; when it is imported the cross-lane check compares it with these sales.`, { source_id: s.id });
  if ((f.commissionLaneRows || 0) > 0) caution("commission_lane_rows", `${f.commissionLaneRows} commission-lane row(s) exist in the same month(s).`);
  if (f.rate && f.rate.rate) caution("rate_basis", `Commission computed at ${r2(f.rate.rate * 100)}% — the single rate in this manufacturer's sales-report history.`);
  const blockers = B.filter(b => !APPROVABLE.has(b.code)), approvals = B.filter(b => APPROVABLE.has(b.code));
  return { eligible: blockers.length === 0 && approvals.length === 0, approvable: blockers.length === 0 && approvals.length > 0,
    blockers, approvals, cautions: C, automatic_posting: f.automaticPosting || "off" };
}

/* The exact plan an approval covers: the source file, every MI-1a row (minus its import timestamp), the dry run's order
   counts and the approval items. Any change → another hash → the approval no longer applies. */
function planHash(o) {
  const crypto = require("crypto");
  const rows = (o.rows || []).map(r => { const x = Object.assign({}, r); delete x.imported_at; return Object.keys(x).sort().map(k => [k, x[k]]); });
  const v = o.v2 || {}, ord = v.orders || {};
  const body = JSON.stringify({ source_id: Number(o.source_id), sha256: o.sha256 || "", rows,
    orders: ["new", "unchanged", "changed", "retire"].map(k => Number(ord[k] || 0)), cross_lane: Number(v.cross_lane_matches || 0),
    locked: (v.locked_months_touched || []).slice().sort(), approvals: (o.approvals || []).map(a => a.code).sort() });
  return crypto.createHash("sha256").update(body).digest("hex");
}

module.exports = { plan, verdict, planHash, mapRow, rateFromHistory, APPROVABLE };

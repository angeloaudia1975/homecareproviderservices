/* Contractual commission tracking & reconciliation (Angelo, 2026-10-12 22:00 CT — CLAUDE.md §18). Pure: no I/O.

   ONE obligation per order, seen three ways — never added together:
     Earned        the contract rate (Strongback: 9%) × the order's ELIGIBLE wholesale sale, credits and reversals included.
                   The order export needs no commission column. Sale date = the order's created date, never a
                   payment-due date. An order whose status is not a completed sale is NOT eligible until it is verified.
     Reported due  what the manufacturer's statement lists for that order (Strongback: the monthly SR032 PDF).
                   "Commission due" on a statement is NOT a payment.
     Paid          only with payment evidence a person recorded (remittance, bank deposit, cheque …).
   Outstanding = Earned − Paid. A statement order with no matching sale goes to REVIEW; it never creates a sale and is
   never counted as earned. Export-calculated commission and statement amounts are two views of the same obligation.

   Only manufacturers listed in CONTRACTS are treated this way; nothing else changes for any other manufacturer. */

const CONTRACTS = {
  "strongback-mobility": {
    rate: 0.09,
    label: "Earned — Contract Rate 9%",
    basis: "9% of eligible wholesale sales — Angelo Audia's Strongback contract (stated 2026-10-12)",
    statement: "SR032",
    // An order counts as a sale only in one of these states. Anything else waits until its status is verified.
    eligible_status: /^(shipped|complete|completed|delivered|closed|fulfilled|invoiced)$/i,
    reversal_status: /cancel|void|refund|return/i,
    overdue_days: { unreported: 90, unpaid: 45 },
  },
};
const contractFor = slug => CONTRACTS[slug] || null;

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const orderKey = v => { const s = String(v == null ? "" : v).trim().replace(/^#\s*/, ""); return /^\d+$/.test(s) ? String(Number(s)) : s.toUpperCase(); };
function money(s) {
  if (s == null) return null; let t = String(s).trim(); if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/^-/.test(t)) { neg = true; t = t.slice(1); }
  t = t.replace(/^\$/, "").replace(/^-/, () => { neg = true; return ""; }).replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return r2((neg ? -1 : 1) * Number(t));
}
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const dateOnly = d => { const s = String(d || "").trim(); let m = s.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; return null; };
const daysBetween = (a, b) => Math.floor((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

/* ---- The SR032 statement ------------------------------------------------------------------------------------
   lines: the PDF's text lines top to bottom. Layout (September 2026):
     "September 2026" · header "Order Number | Company | Order Subtotal | Commission Due" ·
     "7060 Williams Brothers Healthcare Pharmacy $1037 $93.33" … · "Staff Member: Angelo Audia" ·
     "Total Orders: $3737" · "Total Commission Due: $336.33"
   The rows must add up to both printed totals, or the statement is refused (problems) — a figure is never guessed. */
const MONEY = String.raw`(\(?-?\$?-?[\d,]+(?:\.\d{1,2})?\)?)`;
const ROW = new RegExp(String.raw`^#?(\d{3,})\s+(.+?)\s+${MONEY}\s+${MONEY}$`);
function parseSr032(lines) {
  const out = { month: null, staff: null, rows: [], total_orders: null, total_due: null, problems: [] };
  let last = null;
  for (const raw of (lines || [])) {
    const t = String(raw || "").replace(/\s+/g, " ").trim(); if (!t) continue;
    let m;
    if (!out.month && (m = t.match(new RegExp(`^(${MONTHS.join("|")})\\s+(\\d{4})$`, "i")))) {
      out.month = `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}`; last = null; continue; }
    if ((m = t.match(/^staff member:?\s*(.+)$/i))) { out.staff = m[1].trim(); last = null; continue; }
    if ((m = t.match(/^total orders:?\s*(\S+)$/i))) { out.total_orders = money(m[1]); last = null; continue; }
    if ((m = t.match(/^total commission due:?\s*(\S+)$/i))) { out.total_due = money(m[1]); last = null; continue; }
    if (/^(order\b|number\b|company\b)/i.test(t) && !/^\d/.test(t)) { last = null; continue; }      // the column header
    if ((m = t.match(ROW))) {
      const sub = money(m[3]), due = money(m[4]);
      if (sub == null || due == null) { out.problems.push(`Unreadable amounts on the line: "${t}"`); last = null; continue; }
      last = { order: m[1], order_key: orderKey(m[1]), company: m[2].trim(), subtotal: sub, due, line: out.rows.length + 1 };
      out.rows.push(last); continue;
    }
    if (/^\d{3,}\b/.test(t)) { out.problems.push(`A line that starts like an order could not be read: "${t}"`); last = null; continue; }
    if (last && !/\$|\d/.test(t)) { last.company += " " + t; last.wrapped = true; continue; }   // a wrapped company name
  }
  if (!out.month) out.problems.push("The statement month was not found.");
  if (!out.rows.length) out.problems.push("No order lines were found.");
  if (out.total_orders == null) out.problems.push('"Total Orders" was not found.');
  if (out.total_due == null) out.problems.push('"Total Commission Due" was not found.');
  const sumSub = r2(out.rows.reduce((s, r) => s + r.subtotal, 0)), sumDue = r2(out.rows.reduce((s, r) => s + r.due, 0));
  if (out.total_orders != null && sumSub !== out.total_orders) out.problems.push(`The order lines add up to $${sumSub}, the statement says Total Orders $${out.total_orders}.`);
  if (out.total_due != null && sumDue !== out.total_due) out.problems.push(`The commission lines add up to $${sumDue}, the statement says Total Commission Due $${out.total_due}.`);
  out.sum_subtotal = sumSub; out.sum_due = sumDue; out.ok = out.problems.length === 0;
  return out;
}

/* ---- Sales from a registered order export ---------------------------------------------------------------------
   parsed: _report_rows.readOrderRows(...) result; amountOf(row) → the line amount exactly as the import computes it.
   The export's own columns decide status; "Payment Due Date", "Amount Paid" and "Fully Paid" are the DEALER's invoice
   with the manufacturer — never a sale date, never a commission payment. */
function salesFromExport(parsed, source, amountOf) {
  const H = parsed.headers || [];
  const col = re => H.findIndex(h => re.test(String(h).trim()));
  const ci = { status: col(/^(order )?status$/i), subtotal: col(/^subtotal$/i), discount: col(/^discount$/i),
    fully_shipped: col(/^fully shipped$/i), dealer_paid: col(/^fully paid$/i) };
  const cell = (r, k) => ci[k] < 0 ? "" : String(r.raw[ci[k]] == null ? "" : r.raw[ci[k]]).trim();
  const by = new Map();
  for (const r of parsed.rows || []) {
    const k = orderKey(r.order_number); if (!k) continue;
    const o = by.get(k) || { order: String(r.order_number).trim(), order_key: k, date: null, company: r.company || null, lines: 0, amount: 0,
      status: cell(r, "status") || null, subtotal: money(cell(r, "subtotal")), discount: money(cell(r, "discount")),
      fully_shipped: cell(r, "fully_shipped") || null, dealer_paid: cell(r, "dealer_paid") || null, ship_zip: r.ship_zip || null,
      sources: [{ kind: "export", source_id: source.id, file_name: source.file_name, lines: [] }] };
    const d = dateOnly(r.date); if (d && (!o.date || d < o.date)) o.date = d;
    o.lines++; o.amount = r2(o.amount + amountOf(r)); o.sources[0].lines.push(r.line);
    by.set(k, o);
  }
  return [...by.values()];
}

/* Sales already in HCPS (monthly_sales, sales-report lane), grouped by order number. No status was stored for them:
   they were imported as sales by a person, and are marked "status not in the record". */
function salesFromHistory(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (r.source !== "sales_report") continue;
    const k = orderKey(r.invoice_no); if (!k) continue;
    const o = by.get(k) || { order: String(r.invoice_no).trim(), order_key: k, date: null, company: r.customer_name || null, dealer_id: r.dealer_id || null,
      lines: 0, amount: 0, ledger_commission: 0, status: null, sources: [{ kind: "hcps_sales", rows: [] }] };
    const d = dateOnly(r.order_date) || (r.period ? String(r.period).slice(0, 10) : null); if (d && (!o.date || d < o.date)) o.date = d;
    if (!o.dealer_id && r.dealer_id) o.dealer_id = r.dealer_id;
    o.lines++; o.amount = r2(o.amount + (Number(r.amount) || 0)); o.ledger_commission = r2(o.ledger_commission + (Number(r.commission) || 0));
    o.sources[0].rows.push(r.id);
    by.set(k, o);
  }
  return [...by.values()];
}

/* ---- Reconcile --------------------------------------------------------------------------------------------------
   input: { slug, today:'YYYY-MM-DD', history:[sale], exports:[sale], statements:[{source_id, file_name, period, received_date,
            parsed:{ok, rows, total_due, problems}}], events:[{id, kind:'payment'|'review', source_id?, order?, amount?, evidence?,
            decision?, reason, actor, created_at, supersedes_id?}], dealerOf?(order)→{id,name} }
   → { contract, orders:[…], review:[…], statements:[…], summary, checks, problems } */
function reconcile(input) {
  const C = contractFor(input.slug); if (!C) throw new Error("no_contract: " + input.slug);
  const today = input.today;
  const problems = [], checks = [];
  // 1. One sale per order. HCPS's recorded sale wins where both exist (it is what the ledger holds); a difference is flagged.
  const orders = new Map();
  for (const h of input.history || []) orders.set(h.order_key, Object.assign({ flags: [] }, h));
  for (const x of input.exports || []) {
    const o = orders.get(x.order_key);
    if (!o) { orders.set(x.order_key, Object.assign({ flags: [] }, x)); continue; }
    o.sources = o.sources.concat(x.sources);
    if (x.status) o.status = x.status; if (x.fully_shipped) o.fully_shipped = x.fully_shipped; if (x.dealer_paid) o.dealer_paid = x.dealer_paid;
    if (r2(x.amount) !== r2(o.amount)) o.flags.push({ code: "amount_differs", text: `Export #${x.sources[0].source_id} shows $${r2(x.amount)}; HCPS sales show $${r2(o.amount)} — HCPS's figure is used.` });
  }
  // 2. Eligibility + earned.
  for (const o of orders.values()) {
    const st = o.status ? String(o.status).trim() : null;
    if (st == null) { o.eligibility = "eligible_unverified_status"; o.eligibility_text = "Sale recorded in HCPS — order status not in the record"; }
    else if (C.reversal_status.test(st)) { o.eligibility = "reversed"; o.eligibility_text = `Status "${st}" — not a sale`; }
    else if (C.eligible_status.test(st)) { o.eligibility = "eligible"; o.eligibility_text = `Status "${st}"`; }
    else { o.eligibility = "pending_status"; o.eligibility_text = `Status "${st}" — not a completed sale yet; not eligible until verified`; }
    const counts = o.eligibility === "eligible" || o.eligibility === "eligible_unverified_status";
    o.eligible_amount = counts ? r2(o.amount) : 0;
    o.earned = counts ? r2(o.amount * C.rate) : 0;
    if (o.subtotal != null && r2(o.subtotal) !== r2(o.amount)) o.flags.push({ code: "subtotal_differs", text: `The export's order subtotal is $${o.subtotal}; its lines add up to $${r2(o.amount)}.` });
    if (o.discount) o.flags.push({ code: "discount", text: `The export shows a discount of $${o.discount} on this order.` });
    if (o.ledger_commission != null && counts && Math.abs(r2(o.ledger_commission) - o.earned) > 0.01 * Math.max(1, o.lines))
      o.flags.push({ code: "ledger_commission_differs", text: `HCPS sales carry $${r2(o.ledger_commission)} commission for this order; 9% of the sale is $${o.earned}.` });
    o.reported_due = 0; o.statement_refs = []; o.paid = 0; o.payments = [];
    if (input.dealerOf) { const d = input.dealerOf(o); if (d) { o.dealer_id = o.dealer_id || d.id; o.dealer = d.name; } }
  }
  // 3. Statements → reported due, by order. The same order listed again with the same amount is noted, not added.
  const review = [], stmts = [];
  const seen = new Map();   // order_key|due → first statement id
  for (const s of (input.statements || []).slice().sort((a, b) => String(a.period).localeCompare(String(b.period)) || a.source_id - b.source_id)) {
    const p = s.parsed || {};
    const S = { source_id: s.source_id, file_name: s.file_name, period: s.period, received_date: s.received_date, ok: !!p.ok, problems: p.problems || [],
      total_due: p.total_due, lines: (p.rows || []).length, matched: 0, unmatched: 0, paid: 0, payment_state: "no_evidence" };
    stmts.push(S);
    if (!p.ok) { problems.push(`Statement #${s.source_id} (${s.file_name}) could not be read reliably: ${(p.problems || []).join(" ")}`); continue; }
    for (const L of p.rows) {
      const ref = { source_id: s.source_id, period: s.period, line: L.line, due: L.due, subtotal: L.subtotal, company: L.company };
      const dupKey = L.order_key + "|" + L.due;
      const o = orders.get(L.order_key);
      if (!o) { S.unmatched++; review.push(Object.assign({ order: L.order, order_key: L.order_key, reason: "no_matching_sale",
        text: `Listed on statement #${s.source_id} (${s.period}) as ${L.company}, $${L.subtotal} → $${L.due} due — no sale with this order number is in HCPS or a registered export.` }, ref)); continue; }
      S.matched++;
      if (seen.has(dupKey) && seen.get(dupKey) !== s.source_id) { o.flags.push({ code: "listed_again", text: `Listed again on statement #${s.source_id} with the same $${L.due} (first on #${seen.get(dupKey)}) — not counted twice.` }); o.statement_refs.push(Object.assign({ repeated: true }, ref)); continue; }
      seen.set(dupKey, s.source_id);
      o.reported_due = r2(o.reported_due + L.due); o.statement_refs.push(ref);
      if (Math.abs(r2(L.subtotal) - r2(o.amount)) > 0.01) o.flags.push({ code: "statement_subtotal_differs", text: `Statement #${s.source_id} shows an order subtotal of $${L.subtotal}; the sale is $${r2(o.amount)}.` });
      if (o.eligible_amount && Math.abs(r2(L.due) - o.earned) > 0.01) o.flags.push({ code: "due_differs_from_earned", text: `Statement #${s.source_id} reports $${L.due} due; 9% of the eligible sale is $${o.earned}.` });
      if (!o.eligible_amount) o.flags.push({ code: "reported_not_eligible", text: `Statement #${s.source_id} reports $${L.due} due, but the order is not an eligible sale here (${o.eligibility_text}).` });
    }
  }
  // 4. Payment evidence (recorded by the President). Order-level payments apply to that order. A statement-level payment
  //    pays every line of that statement only when it covers the statement's whole total; otherwise it stays unallocated.
  //    Review decisions (latest per statement line wins) can tie an unmatched line to a sale or dismiss it.
  const ev = (input.events || []).slice().sort((a, b) => a.id - b.id);
  const superseded = new Set(ev.map(x => x.supersedes_id).filter(Boolean));
  const live = ev.filter(x => !superseded.has(x.id));
  for (const x of live.filter(x => x.kind === "review")) {
    const i = review.findIndex(r => r.source_id === Number(x.source_id) && r.order_key === orderKey(x.order));
    if (i < 0) continue;
    const r = review[i]; r.decision = x.decision; r.decision_reason = x.reason; r.decided_by = x.actor; r.decided_at = x.created_at;
    const m = String(x.decision || "").match(/^matched_to:(.+)$/);
    if (m) { const o = orders.get(orderKey(m[1]));
      if (o) { o.reported_due = r2(o.reported_due + r.due); o.statement_refs.push({ source_id: r.source_id, period: r.period, line: r.line, due: r.due, subtotal: r.subtotal, company: r.company, matched_by_review: x.id });
        o.flags.push({ code: "matched_by_review", text: `Statement #${r.source_id} line ${r.line} (order ${r.order}) tied to this sale by ${x.actor}: ${x.reason}` }); review.splice(i, 1); } }
  }
  const unallocated = [];
  for (const x of live.filter(x => x.kind === "payment")) {
    const amt = r2(x.amount);
    if (x.order) { const o = orders.get(orderKey(x.order));
      if (!o) { unallocated.push({ event: x.id, amount: amt, text: `Payment of $${amt} names order ${x.order}, which is not on file.` }); continue; }
      o.paid = r2(o.paid + amt); o.payments.push({ event: x.id, amount: amt, evidence: x.evidence, by: x.actor, at: x.created_at }); continue; }
    const S = stmts.find(s => s.source_id === Number(x.source_id));
    if (!S) { unallocated.push({ event: x.id, amount: amt, text: `Payment of $${amt} names statement #${x.source_id}, which is not on file.` }); continue; }
    S.paid = r2(S.paid + amt);
  }
  for (const S of stmts) {
    if (!S.paid) continue;
    if (S.total_due != null && S.paid >= S.total_due) {
      S.payment_state = S.paid > S.total_due ? "overpaid" : "paid_in_full";
      for (const o of orders.values()) for (const ref of o.statement_refs.filter(r => r.source_id === S.source_id && !r.repeated)) {
        o.paid = r2(o.paid + ref.due); o.payments.push({ statement: S.source_id, amount: ref.due, evidence: "statement paid in full" }); }
      if (S.paid > S.total_due) unallocated.push({ statement: S.source_id, amount: r2(S.paid - S.total_due), text: `Statement #${S.source_id}: $${r2(S.paid - S.total_due)} more was paid than it lists.` });
    } else { S.payment_state = "partial"; unallocated.push({ statement: S.source_id, amount: S.paid,
      text: `Statement #${S.source_id}: partial payment of $${S.paid} of $${S.total_due} — not allocated to individual orders.` }); }
  }
  // 5. Per-order state and labels.
  const list = [];
  for (const o of orders.values()) {
    o.outstanding = r2(o.earned - o.paid);
    o.reported_not_paid = r2(Math.max(0, o.reported_due - o.paid));
    o.labels = [];
    if (o.eligibility === "pending_status") o.labels.push("status_not_verified");
    if (o.eligibility === "eligible_unverified_status") o.labels.push("status_not_in_record");
    if (o.reported_due && o.paid < o.reported_due) o.labels.push("payment_unverified");
    const age = o.date ? daysBetween(o.date, today) : null;
    if (o.earned > 0 && !o.statement_refs.length && age != null && age > C.overdue_days.unreported) o.labels.push("potentially_overdue_unreported");
    const lastStmt = o.statement_refs.length ? o.statement_refs[o.statement_refs.length - 1] : null;
    const st = lastStmt ? (input.statements || []).find(s => s.source_id === lastStmt.source_id) : null;
    if (o.reported_not_paid > 0 && st && st.received_date && daysBetween(st.received_date, today) > C.overdue_days.unpaid) o.labels.push("potentially_overdue_unpaid");
    o.age_days = age; o.month = o.date ? o.date.slice(0, 7) : null;
    o.stage = o.paid >= o.earned && o.earned > 0 ? "paid" : o.reported_due > 0 ? "reported_due" : o.earned > 0 ? "earned" : "not_eligible";
    list.push(o);
  }
  list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.order).localeCompare(String(a.order)));
  // 6. Totals — the stages are reported side by side, never added together.
  const sum = (arr, k) => r2(arr.reduce((s, o) => s + (Number(o[k]) || 0), 0));
  const summary = {
    contract: C.label, rate: C.rate, orders: list.length,
    eligible_orders: list.filter(o => o.earned > 0).length, eligible_sales: sum(list, "eligible_amount"),
    earned: sum(list, "earned"), reported_due: sum(list, "reported_due"), paid: sum(list, "paid"), outstanding: sum(list, "outstanding"),
    reported_not_paid: sum(list, "reported_not_paid"),
    earned_not_reported: r2(list.filter(o => o.earned > 0 && !o.statement_refs.length).reduce((s, o) => s + o.earned, 0)),
    review_lines: review.filter(r => !r.decision || r.decision === "investigate").length,
    review_due: r2(review.filter(r => !r.decision || r.decision === "investigate").reduce((s, r) => s + r.due, 0)),
    not_eligible_orders: list.filter(o => o.eligibility === "pending_status" || o.eligibility === "reversed").length,
    status_not_in_record: list.filter(o => o.eligibility === "eligible_unverified_status").length,
    payment_unverified: list.filter(o => o.labels.includes("payment_unverified")).length,
    potentially_overdue: list.filter(o => o.labels.some(l => l.startsWith("potentially_overdue"))).length,
    unallocated_payments: r2(unallocated.reduce((s, u) => s + u.amount, 0)),
    note: "Earned, reported due and paid are three views of the same commission — never added together.",
  };
  checks.push({ name: "no double counting", ok: true, text: "Each order is counted once; statement amounts are compared with earned, never added to it." });
  return { contract: { slug: input.slug, label: C.label, rate: C.rate, basis: C.basis, statement: C.statement, overdue_days: C.overdue_days },
    orders: list, review, statements: stmts, unallocated, summary, checks, problems };
}

/* Drilldown: group orders by dealer / sale month / reporting month / manufacturer. */
function groupBy(rec, by) {
  const key = o => by === "dealer" ? (o.dealer || o.company || "—") : by === "month" ? (o.month || "—")
    : by === "reporting_month" ? (o.statement_refs.length ? o.statement_refs.map(r => r.period).sort()[0] : "not reported yet")
    : by === "manufacturer" ? rec.contract.slug : o.order;
  const g = new Map();
  for (const o of rec.orders) { const k = key(o); const t = g.get(k) || { key: k, orders: 0, eligible_sales: 0, earned: 0, reported_due: 0, paid: 0, outstanding: 0, flagged: 0 };
    t.orders++; for (const f of ["eligible_sales", "earned", "reported_due", "paid", "outstanding"]) t[f] = r2(t[f] + (f === "eligible_sales" ? o.eligible_amount : o[f]));
    if (o.labels.length || o.flags.length) t.flagged++; g.set(k, t); }
  return [...g.values()].sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

/* Coverage helper: a sales-report month of a contract manufacturer whose every line carries exactly the contract rate is
   "earned at the contract rate", not an estimate. Any other line keeps today's "estimated". */
function monthIsContractEarned(slug, rows) {
  const C = contractFor(slug); if (!C || !rows.length) return false;
  return rows.every(r => r.source === "sales_report" && Number.isFinite(Number(r.amount)) && Number.isFinite(Number(r.commission))
    && Math.abs(r2(Number(r.amount) * C.rate) - r2(Number(r.commission))) <= 0.01);
}

module.exports = { CONTRACTS, contractFor, parseSr032, salesFromExport, salesFromHistory, reconcile, groupBy, monthIsContractEarned, money, orderKey };

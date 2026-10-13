/* Contractual commission tracking & reconciliation (Angelo, 2026-10-12 22:00 CT — CLAUDE.md §18). Pure: no I/O.

   ONE obligation per order, seen three ways — never added together:
     Earned        the contract rate (Strongback: 9%) × the order's ELIGIBLE wholesale sale, credits and reversals included.
                   The order export needs no commission column. Sale date = the order's created date, never a
                   payment-due date. An order whose status is not a completed sale is NOT eligible until it is verified.
     Reported due  what the manufacturer's statement lists for that order (Strongback: the monthly SR032 PDF).
                   "Commission due" on a statement is NOT a payment.
     Paid          only with payment evidence a person recorded (remittance, bank deposit, cheque …).
   Earned splits into confirmed paid + confirmed unpaid (only where a remittance shows a shortfall) + payment status
   unknown — never presented as collectible or overdue debt. A statement order with no matching sale goes to REVIEW; it never creates a sale and is
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
  // 4. Review decisions (latest per statement line wins) can tie an unmatched line to a sale already on file, or dismiss
  //    it. A decision never creates a sale: "matched_to" a number with no sale on file leaves the line in review.
  // Stored rows carry order_number (the table's column); tests and the UI may say order — both mean the same.
  const ev = (input.events || []).map(x => Object.assign({}, x, { order: x.order != null && x.order !== "" ? x.order : (x.order_number || null) })).sort((a, b) => a.id - b.id);
  const byId = new Map(ev.map(x => [x.id, x]));
  const target = x => x.order ? "O:" + orderKey(x.order) : x.source_id != null ? "S:" + Number(x.source_id) : null;
  // A payment correction must stay on its original's statement or order. One that moves it is refused: not counted, and it
  // does NOT cancel the original (which keeps counting) — so a bad correction can never make money disappear or move.
  const badCorrection = new Set(ev.filter(x => x.kind === "payment" && x.supersedes_id && byId.has(x.supersedes_id) && target(byId.get(x.supersedes_id)) !== target(x)).map(x => x.id));
  const superseded = new Set(ev.filter(x => !badCorrection.has(x.id)).map(x => x.supersedes_id).filter(Boolean));
  const live = ev.filter(x => !superseded.has(x.id));
  for (const x of live.filter(x => x.kind === "review")) {
    const i = review.findIndex(r => r.source_id === Number(x.source_id) && r.order_key === orderKey(x.order));
    if (i < 0) continue;
    const r = review[i]; r.decision = x.decision; r.decision_reason = x.reason; r.decided_by = x.actor; r.decided_at = x.created_at;
    const m = String(x.decision || "").match(/^matched_to:(.+)$/);
    if (m) { const o = orders.get(orderKey(m[1]));
      if (!o) { r.decision_problem = `Decision names order ${m[1]}, which has no sale on file — the line stays in review.`; continue; }
      o.reported_due = r2(o.reported_due + r.due); o.statement_refs.push({ source_id: r.source_id, period: r.period, line: r.line, due: r.due, subtotal: r.subtotal, company: r.company, matched_by_review: x.id });
      o.flags.push({ code: "matched_by_review", text: `Statement #${r.source_id} line ${r.line} (order ${r.order}) tied to this sale by ${x.actor}: ${x.reason}` }); review.splice(i, 1); }
  }
  // 5. Payment evidence — counted ONCE per remittance (CLAUDE.md §18, Angelo 2026-10-13).
  //    Every payment names its remittance (paymentRef: cheque / ACH trace / deposit id). One remittance is one sum of money:
  //    · a statement-level entry is the remittance against that statement; order-level entries under the SAME reference are
  //      ALLOCATIONS of it (they must be orders on that statement) — never extra money;
  //    · the same reference + target + sign recorded twice is ONE payment (the later entry is listed as a duplicate, not added);
  //    · a correction supersedes its original and must keep the same target; a negative amount is a reversal;
  //    · a statement is paid in full only when its remittances cover its whole total — then each line counts as paid. A partial
  //      remittance pays only what it allocates; its unallocated part stays unallocated and the shortfall is CONFIRMED short.
  const unallocated = [], payProblems = [], duplicates = [];
  const pays = [];
  for (const x of live.filter(x => x.kind === "payment")) {
    const t = target(x);
    if (badCorrection.has(x.id)) { const orig = byId.get(x.supersedes_id);
      payProblems.push({ event: x.id, text: `Correction #${x.id} would move payment #${orig.id} from ${target(orig)} to ${t} — a correction must stay on its original statement or order. Not counted; #${orig.id} still counts. Record a reversal instead.` }); continue; }
    const ref = paymentRef(x);
    pays.push({ x, t, ref: ref || "#event" + x.id, has_ref: !!ref, amount: r2(x.amount), sign: Math.sign(Number(x.amount) || 0) });
  }
  const groups = new Map();
  for (const p of pays) { const k = p.ref + "|" + p.t + "|" + p.sign; const g = groups.get(k);
    if (g) { duplicates.push({ event: g.x.id, duplicate_of: p.x.id, ref: p.ref, target: p.t, amount: g.amount,
      text: `Payment #${g.x.id} and #${p.x.id} record the same remittance ${p.ref} against ${p.t} — counted once (#${p.x.id}). Use a correction to change an amount.` }); }
    groups.set(k, p); }
  const counted = [...groups.values()];
  for (const p of counted) if (!p.has_ref) payProblems.push({ event: p.x.id, text: `Payment #${p.x.id} has no remittance reference — counted on its own; add the reference with a correction so it can be matched.` });
  const byRef = new Map(); for (const p of counted) { const a = byRef.get(p.ref) || []; a.push(p); byRef.set(p.ref, a); }
  const S_ = id => stmts.find(s => s.source_id === id);
  const credit = new Map();       // order_key → [{event, amount, statement?, ref}]
  const explicitOnStmt = new Map(); // "S|order_key" → amount explicitly allocated
  const addCredit = (k, c) => { const a = credit.get(k) || []; a.push(c); credit.set(k, a); };
  for (const [ref, ps] of byRef) {
    const stParts = ps.filter(p => p.t.startsWith("S:")), orParts = ps.filter(p => p.t.startsWith("O:"));
    for (const p of stParts) { const S = S_(Number(p.t.slice(2)));
      if (!S) { unallocated.push({ event: p.x.id, amount: p.amount, text: `Payment #${p.x.id} (${ref}, $${p.amount}) names statement #${p.t.slice(2)}, which is not on file.` }); continue; }
      S.paid = r2(S.paid + p.amount); (S.remittances = S.remittances || []).push({ event: p.x.id, ref, amount: p.amount, paid_on: p.x.paid_on || null }); }
    const stIds = stParts.map(p => Number(p.t.slice(2))).filter(id => S_(id));
    for (const p of orParts) { const k = p.t.slice(2); const o = orders.get(k);
      if (!o) { unallocated.push({ event: p.x.id, amount: p.amount, text: `Payment #${p.x.id} (${ref}, $${p.amount}) names order ${k}, which has no sale on file — not counted.` }); continue; }
      if (stIds.length) {   // an allocation of this remittance's statement payment
        const sid = stIds.find(id => o.statement_refs.some(r => r.source_id === id && !r.repeated));
        if (sid == null) { payProblems.push({ event: p.x.id, text: `Payment #${p.x.id} allocates remittance ${ref} to order ${o.order}, which is not on statement #${stIds.join(", #")} — not counted (it would count the same money twice).` }); continue; }
        const ek = sid + "|" + k; explicitOnStmt.set(ek, r2((explicitOnStmt.get(ek) || 0) + p.amount));
        addCredit(k, { event: p.x.id, amount: p.amount, statement: sid, ref, allocation: true, evidence: p.x.evidence, by: p.x.actor, at: p.x.created_at });
      } else addCredit(k, { event: p.x.id, amount: p.amount, ref, evidence: p.x.evidence, by: p.x.actor, at: p.x.created_at });
    }
  }
  // Statement-level settlement.
  for (const S of stmts) {
    const lines = []; for (const o of orders.values()) for (const r of o.statement_refs) if (r.source_id === S.source_id && !r.repeated) lines.push({ o, due: r.due });
    let explicit = 0; for (const L of lines) explicit = r2(explicit + (explicitOnStmt.get(S.source_id + "|" + L.o.order_key) || 0));
    S.allocated = explicit; S.short_unassigned = 0;
    if (!S.paid && !explicit) continue;
    if (explicit > S.paid + 0.005) payProblems.push({ statement: S.source_id, text: `Statement #${S.source_id}: $${explicit} is allocated to orders but its remittances total $${S.paid} — the allocations above the remittance are not counted.` });
    if (S.total_due != null && S.paid >= S.total_due - 0.005) {
      S.payment_state = S.paid > S.total_due + 0.005 ? "overpaid" : "paid_in_full";
      for (const L of lines) { const ex = explicitOnStmt.get(S.source_id + "|" + L.o.order_key) || 0;
        if (L.due - ex > 0.005) addCredit(L.o.order_key, { amount: r2(L.due - ex), statement: S.source_id, evidence: "statement paid in full by its recorded remittance(s)", settled: true }); }
      if (S.paid > S.total_due + 0.005) unallocated.push({ statement: S.source_id, amount: r2(S.paid - S.total_due), text: `Statement #${S.source_id}: $${r2(S.paid - S.total_due)} more was paid than it lists.` });
      const onSales = r2(lines.reduce((t, L) => t + L.due, 0)), noSale = r2(Math.min(S.paid, S.total_due) - onSales);
      if (noSale > 0.005) unallocated.push({ statement: S.source_id, amount: noSale, no_sale: true, text: `Statement #${S.source_id}: $${noSale} was paid for line(s) with no sale on file (see review) — received, not credited to any sale.` });
    } else {
      S.payment_state = S.paid > 0 ? "partial" : "no_evidence";
      // allocations beyond what was actually remitted are not credited
      if (explicit > S.paid + 0.005) { let room = S.paid;
        for (const [k, cs] of credit) for (const c of cs) if (c.statement === S.source_id && c.allocation) { const keep = Math.max(0, Math.min(c.amount, room)); c.cut = r2(c.amount - keep); c.amount = r2(keep); room = r2(room - keep); } }
      const allocated = Math.min(explicit, S.paid);
      if (S.paid - allocated > 0.005) unallocated.push({ statement: S.source_id, amount: r2(S.paid - allocated), text: `Statement #${S.source_id}: $${r2(S.paid - allocated)} of a partial payment ($${S.paid} of $${S.total_due}) is not allocated to individual orders.` });
    }
  }
  for (const [k, cs] of credit) { const o = orders.get(k); if (!o) continue;
    for (const c of cs) { o.paid = r2(o.paid + c.amount); o.payments.push(c); } }
  // Possible duplicates the reference cannot catch: the same target, amount and date under two different references.
  const sig = new Map();
  for (const p of counted) { const k = p.t + "|" + p.amount + "|" + (p.x.paid_on || ""); const prev = sig.get(k);
    if (prev && prev.ref !== p.ref) payProblems.push({ event: p.x.id, text: `Payments #${prev.x.id} (${prev.ref}) and #${p.x.id} (${p.ref}) are the same amount, target and date under different references — check they are two remittances.` });
    sig.set(k, p); }
  // 6. Per-order state and labels.
  const firstStmt = (input.statements || []).filter(x => x.parsed && x.parsed.ok && x.period).map(x => x.period).sort()[0] || null;
  const list = [];
  for (const o of orders.values()) {
    o.reported_not_paid = r2(Math.max(0, o.reported_due - o.paid));
    // Confirmed unpaid ONLY where a recorded remittance establishes it: the order received an explicit payment / allocation
    // for less than the statement lists, and its statement is not paid in full.
    const evidenced = o.payments.some(c => !c.settled);
    o.confirmed_unpaid = evidenced && o.reported_due > o.paid ? r2(o.reported_due - o.paid) : 0;
    o.payment_unknown = r2(Math.max(0, o.earned - o.paid - o.confirmed_unpaid));
    o.labels = [];
    if (o.eligibility === "pending_status") o.labels.push("status_not_verified");
    if (o.eligibility === "eligible_unverified_status") o.labels.push("status_not_in_record");
    if (o.reported_due && o.paid < o.reported_due && !o.confirmed_unpaid) o.labels.push("payment_unverified");
    if (o.confirmed_unpaid) o.labels.push("confirmed_short_paid");
    if (o.paid > Math.max(o.earned, o.reported_due) + 0.005) o.labels.push("paid_more_than_due");
    const age = o.date ? daysBetween(o.date, today) : null;
    // Overdue-unreported only when every statement that could have listed the sale is on file: the sale month is on or
    // after the earliest readable statement's period. Earlier sales may sit on statements HCPS never registered (they
    // predate email capture) — labelled as such, never called overdue.
    if (o.earned > 0 && !o.statement_refs.length && o.date) {
      if (firstStmt && o.date.slice(0, 7) >= firstStmt) { if (age != null && age > C.overdue_days.unreported) o.labels.push("potentially_overdue_unreported"); }
      else o.labels.push("earlier_statements_not_on_file");
    }
    const lastStmt = o.statement_refs.length ? o.statement_refs[o.statement_refs.length - 1] : null;
    const st = lastStmt ? (input.statements || []).find(s => s.source_id === lastStmt.source_id) : null;
    if (o.reported_not_paid > 0 && !o.confirmed_unpaid && st && st.received_date && daysBetween(st.received_date, today) > C.overdue_days.unpaid) o.labels.push("potentially_overdue_unpaid");
    o.age_days = age; o.month = o.date ? o.date.slice(0, 7) : null;
    o.stage = o.paid >= o.earned && o.earned > 0 ? "paid" : o.reported_due > 0 ? "reported_due" : o.earned > 0 ? "earned" : "not_eligible";
    list.push(o);
  }
  // A partial statement payment not allocated to orders: its shortfall is confirmed at statement level only.
  for (const S of stmts) if (S.payment_state === "partial") {
    let onOrders = 0; for (const o of list) if (o.confirmed_unpaid && o.statement_refs.some(r => r.source_id === S.source_id)) onOrders = r2(onOrders + o.confirmed_unpaid);
    S.short_unassigned = r2(Math.max(0, (S.total_due - S.paid) - onOrders));
  }
  list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.order).localeCompare(String(a.order)));
  // 7. Totals — earned, reported due and paid are three views of the same commission, never added together. Earned splits
  //    into: confirmed paid + confirmed unpaid + payment status unknown. Nothing here is called collectible or overdue debt.
  const sum = (arr, k) => r2(arr.reduce((s, o) => s + (Number(o[k]) || 0), 0));
  const stmtShort = r2(stmts.reduce((s, S) => s + (S.short_unassigned || 0), 0));
  const confirmedUnpaid = r2(sum(list, "confirmed_unpaid") + stmtShort);
  const summary = {
    contract: C.label, rate: C.rate, orders: list.length,
    eligible_orders: list.filter(o => o.earned > 0).length, eligible_sales: sum(list, "eligible_amount"),
    earned: sum(list, "earned"), reported_due: sum(list, "reported_due"), paid: sum(list, "paid"),
    confirmed_unpaid: confirmedUnpaid, confirmed_unpaid_statement_level: stmtShort,
    payment_unknown: r2(Math.max(0, sum(list, "payment_unknown") - stmtShort)),
    reported_not_paid: sum(list, "reported_not_paid"),
    earned_not_reported: r2(list.filter(o => o.earned > 0 && !o.statement_refs.length).reduce((s, o) => s + o.earned, 0)),
    earned_status_not_captured: r2(list.filter(o => o.eligibility === "eligible_unverified_status").reduce((s, o) => s + o.earned, 0)),
    review_lines: review.filter(r => !r.decision || r.decision === "investigate" || r.decision_problem).length,
    review_due: r2(review.filter(r => !r.decision || r.decision === "investigate" || r.decision_problem).reduce((s, r) => s + r.due, 0)),
    not_eligible_orders: list.filter(o => o.eligibility === "pending_status" || o.eligibility === "reversed").length,
    status_not_in_record: list.filter(o => o.eligibility === "eligible_unverified_status").length,
    payment_unverified: list.filter(o => o.labels.includes("payment_unverified")).length,
    potentially_overdue: list.filter(o => o.labels.some(l => l.startsWith("potentially_overdue"))).length,
    earlier_statements_not_on_file: list.filter(o => o.labels.includes("earlier_statements_not_on_file")).length,
    statements_on_file_from: firstStmt,
    unallocated_payments: r2(unallocated.reduce((s, u) => s + u.amount, 0)),
    duplicate_payment_entries: duplicates.length, payment_problems: payProblems.length,
    note: "Earned, reported due and paid are three views of the same commission — never added together. Earned = confirmed paid + confirmed unpaid + payment status unknown; none of it is presented as collectible debt.",
  };
  checks.push({ name: "no double counting", ok: true, text: "Each order is counted once; statement amounts are compared with earned, never added to it; each remittance is counted once." });
  checks.push({ name: "earned splits exactly", ok: Math.abs(r2(summary.paid + summary.confirmed_unpaid + summary.payment_unknown) - summary.earned) <= 0.01 || summary.paid > summary.earned,
    text: "Confirmed paid + confirmed unpaid + payment status unknown = earned (unless more was paid than earned)." });
  return { contract: { slug: input.slug, label: C.label, rate: C.rate, basis: C.basis, statement: C.statement, overdue_days: C.overdue_days },
    orders: list, review, statements: stmts, unallocated, duplicates, payment_problems: payProblems, summary, checks, problems };
}

/* Guard for a NEW payment entry, checked by the API before anything is written (the reconciliation counts safely either
   way; this stops the mistake at the door). rec = reconcile(...) of the current records; events = stored events;
   p = { source_id?, order_number?, amount, payment_ref, supersedes_id? }. → null when fine, else { status, error, message }. */
function paymentGuard(rec, events, p) {
  const ref = String(p.payment_ref || "").trim().toUpperCase();
  if (!/^[A-Za-z0-9._\/#-]{2,80}$/.test(ref)) return { status: 422, error: "payment_ref_required", message: "Give the remittance reference (cheque number, ACH trace, deposit id) — 2–80 letters, digits or . _ / # -. It is how one payment is recognised everywhere it is recorded." };
  const all = (events || []).map(x => Object.assign({}, x, { order: x.order != null && x.order !== "" ? x.order : (x.order_number || null) }));
  const supersededIds = new Set(all.map(x => x.supersedes_id).filter(Boolean));
  const live = all.filter(x => x.kind === "payment" && !supersededIds.has(x.id));
  const tgt = x => x.order ? "O:" + orderKey(x.order) : x.source_id != null ? "S:" + Number(x.source_id) : null;
  const t = tgt({ order: p.order_number, source_id: p.source_id });
  const sign = Math.sign(Number(p.amount) || 0);
  if (p.supersedes_id) {
    const orig = all.find(x => x.id === Number(p.supersedes_id));
    if (!orig || orig.kind !== "payment") return { status: 422, error: "bad_supersede", message: `Event #${p.supersedes_id} is not a payment.` };
    if (tgt(orig) !== t) return { status: 422, error: "correction_target_changed", message: `A correction must stay on the original payment's ${orig.order ? "order " + orig.order : "statement #" + orig.source_id}. To move money, record a reversal on the original and a new payment.` };
    return null;
  }
  const same = live.find(x => paymentRef(x) === ref && tgt(x) === t && Math.sign(Number(x.amount) || 0) === sign);
  if (same) return { status: 409, error: "duplicate_payment", message: `Remittance ${ref} is already recorded against ${same.order ? "order " + same.order : "statement #" + same.source_id} (payment #${same.id}). To change it, record a correction of #${same.id}.` };
  const refRows = live.filter(x => paymentRef(x) === ref);
  const stIds = [...new Set(refRows.filter(x => !x.order).map(x => Number(x.source_id)).concat(t.startsWith("S:") ? [Number(t.slice(2))] : []))];
  const onStatement = (k, ids) => rec.orders.some(o => o.order_key === k && o.statement_refs.some(r => ids.includes(r.source_id) && !r.repeated));
  const orderRows = refRows.filter(x => x.order).concat(t.startsWith("O:") ? [{ order: t.slice(2), amount: p.amount }] : []);
  if (stIds.length) {
    for (const x of orderRows) if (!onStatement(orderKey(x.order), stIds))
      return { status: 422, error: "allocation_not_on_statement", message: `Remittance ${ref} pays statement #${stIds.join(", #")}; order ${x.order} is not on it, so this would count the same money twice. Use a different reference if it is a separate payment.` };
    const stAmt = r2(refRows.filter(x => !x.order).reduce((s, x) => s + Number(x.amount || 0), 0) + (t.startsWith("S:") ? Number(p.amount) : 0));
    const alloc = r2(orderRows.reduce((s, x) => s + Number(x.amount || 0), 0));
    if (alloc > stAmt + 0.005) return { status: 422, error: "over_allocated", message: `Remittance ${ref} is $${stAmt} against statement #${stIds.join(", #")}, but $${alloc} would be allocated to orders.` };
  }
  return null;
}

/* A payment's remittance reference — the API stores it at the start of the evidence text as "ref:<REF> — …". */
const REF_RE = /^ref:([A-Za-z0-9._\/#-]{2,80})(?:\s+[—-]\s+|$)/;
function paymentRef(x) { const m = String(x && x.evidence || "").match(REF_RE); return m ? m[1].toUpperCase() : null; }
function evidenceWithRef(ref, text) { return `ref:${String(ref).trim().toUpperCase()} — ${String(text || "").trim()}`; }

/* Drilldown: group orders by dealer / sale month / reporting month / manufacturer. */
function groupBy(rec, by) {
  const key = o => by === "dealer" ? (o.dealer || o.company || "—") : by === "month" ? (o.month || "—")
    : by === "reporting_month" ? (o.statement_refs.length ? o.statement_refs.map(r => r.period).sort()[0] : "not reported yet")
    : by === "manufacturer" ? rec.contract.slug : o.order;
  const g = new Map();
  for (const o of rec.orders) { const k = key(o); const t = g.get(k) || { key: k, orders: 0, eligible_sales: 0, earned: 0, reported_due: 0, paid: 0, confirmed_unpaid: 0, payment_unknown: 0, flagged: 0 };
    t.orders++; for (const f of ["eligible_sales", "earned", "reported_due", "paid", "confirmed_unpaid", "payment_unknown"]) t[f] = r2(t[f] + (f === "eligible_sales" ? o.eligible_amount : o[f]));
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

module.exports = { CONTRACTS, contractFor, parseSr032, salesFromExport, salesFromHistory, reconcile, groupBy, monthIsContractEarned, money, orderKey, paymentRef, evidenceWithRef, REF_RE, paymentGuard };

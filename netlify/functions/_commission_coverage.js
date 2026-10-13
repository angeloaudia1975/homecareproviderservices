// ONE definition of "a commission report was received / entered" + the import gate that keeps blank
// statements out (RULE, Angelo 2026-10-10 — see CLAUDE.md §14). Pure: no I/O, used by commissions-api
// (coverage grid, analyze, import) and by the tests.
//
//  • A manufacturer-month is RECEIVED only when it holds validated statement data: a commission-lane row
//    that carries an explicit commission figure (an open invoice has none). 0 counts (a
//    documented zero-dollar statement); NULL / blank never does and is never treated as $0.
//  • Sales-report rows carry a commission computed as amount × the rate typed in: an ESTIMATE, reported
//    separately — unless the manufacturer's sales report is its own commission statement
//    (statement_sales_reports, RULE 14).
//  • A month whose commission-lane rows hold no commission figure is INCOMPLETE: "not received / not
//    entered", with the reason, so a blank import can never turn a month green.
//  • A month with valid statement lines AND lines missing a commission figure is PARTIAL ("Received —
//    incomplete, requires review", with the count) — never an unqualified green (Angelo 2026-10-10).
//  • Kept apart, per month: valid statement lines · explicit $0 commission · missing commission · open
//    (unpaid) invoices · sales-report estimates. A missing figure is never turned into 0.

// RULE 14 exception, PROVISIONAL (Angelo 2026-10-10): these lines' sales report is treated as their commission
// statement until the manufacturer file is verified. Months that rest on it are marked provisional, never plain
// green. The evidence recorded here is what the data shows — not a verification.
const DEFAULT_STATEMENT_SALES_REPORTS = ["pedifix", "ovation-medical"];
const STATEMENT_SALES_REPORT_EVIDENCE = {
  "pedifix": "PROVISIONAL — RULE 14 says PediFix's report is also its commission statement. Production check 2026-10-10: all 172 PediFix rows come from one Sales Report Import file (PediFix_ALL_2025-2026.csv), and every commission equals amount x 10% (the rate typed at import) — computed by HCPS, not read from a statement. Not verified against a PediFix commission statement.",
  "ovation-medical": "PROVISIONAL — RULE 14 says Ovation's report is also its commission statement. No Ovation rows are on file (2026-10-10), so nothing rests on this exception yet. Not verified.",
};

// A real number, explicitly given. "" / null / undefined / "abc" are NOT numbers; "0" and 0 are.
function isNum(v){
  if(v === null || v === undefined) return false;
  if(typeof v === "number") return Number.isFinite(v);
  const s = String(v).replace(/[$,\s]/g, "");
  if(s === "" || s === "-" || s === ".") return false;
  return Number.isFinite(Number(s));
}
const isCommissionLane = r => r.source === "commission" ||
  ((r.source === null || r.source === undefined || r.source === "") && (r.external_ref === null || r.external_ref === undefined || r.external_ref === ""));
const isInvoiceLine = r => String(r.line_type || "").trim().toLowerCase() === "invoice";
// An OPEN invoice (GCE / Access4u ledger): billed, commission not paid yet. AirAvant statements also say
// "Invoice" in their Type column but carry the sale and the commission — those are statement lines.
const isOpenInvoice = r => isInvoiceLine(r) && !isNum(r.commission) && !isNum(r.amount);
const monthOf = r => String(r.period || "").slice(0, 7);
// Contract-rate manufacturers (Angelo 2026-10-12, CLAUDE.md §18): a sales-report month whose every line carries exactly
// the contract rate is "Earned — Contract Rate", not an estimate. Every other manufacturer is unchanged.
const CT = require("./_contract_commission.js");

function statementSet(opts){
  const list = opts && Array.isArray(opts.statement_sales_reports) ? opts.statement_sales_reports : DEFAULT_STATEMENT_SALES_REPORTS;
  return new Set(list.map(s => String(s).trim()).filter(Boolean));
}

// Validated statement evidence for its month.
function rowIsStatement(r, stmtSR){
  if(isCommissionLane(r)) return isNum(r.commission);
  if(r.source === "sales_report" && stmtSR && stmtSR.has(r.manufacturer)) return isNum(r.commission);
  return false;
}
// Sales-report rows whose commission is computed at a typed-in rate (not a statement).
const rowIsEstimate = (r, stmtSR) => r.source === "sales_report" && !(stmtSR && stmtSR.has(r.manufacturer)) && isNum(r.amount);

// rows: [{manufacturer, period, source, external_ref, line_type, amount, commission, billed_amount}]
// → { received:{slug:[YYYY-MM]}, partial:{slug:[{period, statement_rows, missing_rows, reason}]},
//     estimated:{slug:[YYYY-MM]}, incomplete:{slug:[{period, rows, reason}]}, provisional:{slug:[YYYY-MM]},
//     detail:{slug:{YYYY-MM:{status, statement_rows, zero_commission_rows, missing_commission_rows, open_invoices,
//     estimate_rows, provisional}}} }
// A month has exactly one status: partial / provisional / received / incomplete / estimated (in that order).
// `received` holds VERIFIED statement months only. `provisional` lists every month resting only on the RULE 14
// sales-report exception (status "provisional", or "partial" with detail.provisional) — never in `received`.
// summary = month counts per status.
function coverage(rows, opts){
  const stmtSR = statementSet(opts);
  const m = new Map();   // slug|YYYY-MM -> tally
  for(const r of (rows || [])){
    const p = monthOf(r); if(!r || !r.manufacturer || !/^\d{4}-\d{2}$/.test(p)) continue;
    const k = r.manufacturer + "|" + p;
    const t = m.get(k) || { slug:r.manufacturer, p, stmt:0, laneStmt:0, zero:0, est:0, lane:0, blank:0, invoice:0, noComm:0, zeroSale:0 };
    if(rowIsStatement(r, stmtSR)){ t.stmt++; if(isCommissionLane(r)) t.laneStmt++; if(Number(String(r.commission).replace(/[$,\s]/g, "")) === 0) t.zero++; }
    else if(rowIsEstimate(r, stmtSR)){ t.est++; if(CT.contractFor(r.manufacturer)) (t.estRows || (t.estRows = [])).push(r); }
    if(isCommissionLane(r)){
      t.lane++;
      if(isNum(r.commission)) {}
      else if(isOpenInvoice(r) && isNum(r.billed_amount)) t.invoice++;
      else if(!isNum(r.amount) && !isNum(r.billed_amount)) t.blank++;
      else if(isNum(r.amount) && Number(String(r.amount).replace(/[$,\s]/g, "")) === 0) t.zeroSale++;
      else t.noComm++;
    }
    m.set(k, t);
  }
  const received = {}, partial = {}, estimated = {}, incomplete = {}, provisional = {}, earned = {}, detail = {};
  // Month counts by status — `received` = verified statements only; provisional months are counted apart.
  const summary = { received:0, provisional:0, partial:0, incomplete:0, estimated:0, earned_contract:0 };
  const add = (o, slug, v) => (o[slug] || (o[slug] = [])).push(v);
  const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  for(const t of [...m.values()].sort((a, b) => (a.slug + a.p).localeCompare(b.slug + b.p))){
    const missing = t.blank + t.noComm + t.zeroSale;
    const why = [];
    if(t.blank) why.push(`${pl(t.blank, "blank row", "blank rows")} (no amount, no commission)`);
    if(t.noComm) why.push(`${pl(t.noComm, "row", "rows")} with sales but no commission figure`);
    if(t.zeroSale) why.push(`${pl(t.zeroSale, "row", "rows")} with a $0 sale and no commission figure`);
    const inv = t.invoice ? `${pl(t.invoice, "open invoice", "open invoices")} (commission not yet paid)` : "";
    const prov = t.stmt > 0 && t.laneStmt === 0;          // rests only on the RULE 14 sales-report exception
    let status;
    if(t.stmt > 0 && missing > 0){ status = "partial"; add(partial, t.slug, { period:t.p, statement_rows:t.stmt, missing_rows:missing, reason:why.join("; ") }); }
    // A provisional month is NOT a verified receipt (Angelo 2026-10-10): it is reported apart from `received`
    // and never counted in received totals.
    else if(t.stmt > 0 && prov){ status = "provisional"; }
    else if(t.stmt > 0){ status = "received"; add(received, t.slug, t.p); }
    else if(t.lane > 0){ status = "incomplete"; add(incomplete, t.slug, { period:t.p, rows:t.lane, reason:why.concat(inv ? [inv] : []).join("; ") }); }
    else if(t.est > 0 && CT.monthIsContractEarned(t.slug, t.estRows || [])){ status = "earned_contract"; add(earned, t.slug, t.p); }
    else if(t.est > 0){ status = "estimated"; add(estimated, t.slug, t.p); }
    else continue;
    if(prov) add(provisional, t.slug, t.p);
    summary[status]++;
    (detail[t.slug] || (detail[t.slug] = {}))[t.p] = { status, statement_rows:t.stmt, zero_commission_rows:t.zero,
      missing_commission_rows:missing, open_invoices:t.invoice, estimate_rows:t.est, provisional:prov };
  }
  return { received, partial, estimated, incomplete, provisional, earned, detail, summary };
}

// ---- Import gate -------------------------------------------------------------------------------------
// rows = mapped rows as mapRows writes them ({amount, commission, billed_amount, line_type, ...}).
// opts.mapped_fields = the targets the person mapped (column-mapped files); opts.ledger = true for the
// parsed ledger formats (Access4u / GCE), which have no column mapping.
const FIELD_LABEL = { amount:"Sales amount ($)", commission:"Commission ($)", billed_amount:"Billed amount (open invoices)" };

function validateStatement(rows, opts){
  opts = opts || {};
  const list = Array.isArray(rows) ? rows : [];
  const missingMap = [];
  if(!opts.ledger && Array.isArray(opts.mapped_fields)){
    const mf = new Set(opts.mapped_fields);
    for(const f of ["amount", "commission"]) if(!mf.has(f)) missingMap.push(f);
  }
  const missing = { amount:0, commission:0, billed_amount:0 }, examples = [];
  let withCommission = 0;
  list.forEach((r, i) => {
    const need = isOpenInvoice(r) ? ["billed_amount"] : ["amount", "commission"];
    for(const f of need){ if(!isNum(r[f])){ missing[f]++; if(examples.length < 12) examples.push({ row:i + 1, field:f, customer:r.customer_name || null, line_type:r.line_type || null }); } }
    if(isNum(r.commission)) withCommission++;
  });
  // A field missing on EVERY non-open-invoice row was not mapped (or the column is empty), whatever the client said.
  const nonInv = list.filter(r => !isOpenInvoice(r)).length;
  for(const f of ["amount", "commission"]) if(nonInv > 0 && missing[f] === nonInv && !missingMap.includes(f)) missingMap.push(f);
  const problems = [];
  if(!list.length) problems.push("The file has no rows.");
  if(missingMap.length) problems.push(`Not mapped (or empty): ${missingMap.map(f => FIELD_LABEL[f]).join(" and ")}. A commission statement must give the sales amount and the commission for every line.`);
  for(const f of ["amount", "commission", "billed_amount"]) if(missing[f] && !missingMap.includes(f))
    problems.push(`${missing[f]} row${missing[f] === 1 ? "" : "s"} have no ${FIELD_LABEL[f]} value. Blank values are never counted as $0 — fix the file (enter 0 where the statement says 0) and load it again.`);
  if(list.length && !withCommission && !missingMap.includes("commission"))
    problems.push("No line in this file carries a commission figure, so it is not a commission statement. An order or sales export belongs in Sales Report Import.");
  if(!problems.length) return { ok:true };
  return { ok:false, error:"statement_incomplete",
    message:"Nothing was written. " + problems.join(" "),
    missing_mappings:missingMap, missing, examples, rows:list.length };
}

// ---- Learned alias target ----------------------------------------------------------------------------
// An alias names a COMPANY. Store it on the family root unless the name itself names the chosen branch
// (its own business name, or its city). dealers: [{id, business_name, city, parent_id}].
function aliasTarget(dealers, chosenId, rawName, dnorm){
  const byId = new Map((dealers || []).map(d => [d.id, d]));
  const d = byId.get(chosenId);
  if(!d) return { dealer_id:chosenId, scope:"unknown" };
  if(!d.parent_id || !byId.has(d.parent_id)) return { dealer_id:d.id, scope:"company" };
  const n = dnorm(rawName), own = dnorm(d.business_name), city = dnorm(d.city || "");
  const namesBranch = n === own || (city.length >= 3 && (" " + n + " ").includes(" " + city + " "));
  if(namesBranch) return { dealer_id:d.id, scope:"branch" };
  return { dealer_id:d.parent_id, scope:"company", moved_from:d.id };
}

module.exports = { DEFAULT_STATEMENT_SALES_REPORTS, STATEMENT_SALES_REPORT_EVIDENCE, isNum, isCommissionLane, isInvoiceLine, isOpenInvoice, rowIsStatement, rowIsEstimate,
  coverage, validateStatement, aliasTarget, FIELD_LABEL };

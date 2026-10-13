// MI — automatic processing of REGISTERED commission statements (Angelo, 2026-10-13 11:54 CT; CLAUDE.md §18 OPERATIONAL
// ACTIVATION). Runs inside report-import-cron after the order-export run. Every write goes through the EXISTING guarded
// importer, hcps_commission_file_apply (MI-1a: whole file, one transaction, its own duplicate / cross-lane / paid-period /
// existing-month checks), with the importer's own mapping (commissions-api internals) and the page's own readers
// (_commission_rows.js). Nothing is guessed and no safeguard is bypassed:
//
//   * already linked by hand   — a commission batch imported from the SAME file name after the record was registered
//                                is linked to the record (no write to monthly_sales).
//   * Strongback (contract)    — the SR032 PDF is statement evidence only: it is read and checked (lines add up to both
//                                printed totals, month = register), the record is accepted, and the Commission
//                                Reconciliation shows it as "reported due". It is NEVER posted to monthly_sales.
//   * already in HCPS          — the importer finds every month already holding statement lines IDENTICAL to this file
//                                (same lines, any file name): recorded as already imported, nothing written.
//   * clean                    — the dry run (no decisions) has no problem, every dealer line is matched, no branch is
//                                held, no ZIP is ambiguous: the record is accepted, the file is applied, the result must
//                                equal the dry run (else the batch is rolled back), and the batch is linked to the record
//                                (else rolled back). Account numbers are then maintained the way the manual v2 import does.
//   * anything else            — an exception for Angelo (decision needed for a month already on file, unmatched dealers,
//                                incomplete statement, no saved column mapping, PDF / body report, multi-month file,
//                                unreadable or changed file). Logged once per plan; nothing written.
//
// Every outcome is a row in mfr_auto_import_log (actor system:auto-import). detail.lane = "commission"; detail.code
// says what happened; detail.final = true means the record needs nothing more and is not looked at again.
const crypto = require("crypto");
const CR = require("./_commission_rows.js");
const CT = require("./_contract_commission.js");

const ACTOR = "system:auto-import";
const COLS = "id,manufacturer,kind,title,file_name,file_sha256,storage_path,received_date,report_period_start,report_period_end,status,import_batch_id,created_at";
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : (v && typeof v === "object")
  ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v === undefined ? null : v);
const e = encodeURIComponent;
const ym = d => String(d || "").slice(0, 7);
const R2 = n => Math.round((Number(n) || 0) * 100) / 100;

function make(deps) {
  const { sbGet, sbGetAll, sbGetOptional, rpc, fetchObject, ci, flagOn } = deps;
  const now = deps.now || (() => Date.now());

  async function log(src, outcome, p) {
    const r = await rpc("hcps_mfr_auto_import_log", { source_id: String(src.id), outcome, plan_hash: p.plan_hash || "", approval_id: "",
      batch_id: p.batch_id || "", actor: ACTOR, detail: Object.assign({ lane: "commission", kind: src.kind, sha: src.file_sha256 }, p.detail || {}) });
    if (!r.ok) throw new Error("the auto-import log could not be written: " + r.message);
  }
  async function accept(src, reason) {
    if (src.status !== "received") return { ok: true };
    const r = await rpc("hcps_mfr_report_decide", { id: String(src.id), decision: "accepted", actor: ACTOR, reason });
    if (r.ok) src.status = "accepted";
    return r;
  }

  // One record. Returns { outcome, code, final, plan_hash?, batch_id?, detail }.
  async function one(src) {
    const slug = src.manufacturer, period = ym(src.report_period_start), base = { file_name: src.file_name, period };
    const held = (code, message, extra) => ({ outcome: "held", code, final: false, detail: Object.assign({ code, message }, base, extra || {}) });

    // A by-hand import of this same file name, made after the record was registered: link it, nothing else.
    const batches = await sbGetAll(`mfr_report_batches?manufacturer=eq.${e(slug)}&lane=eq.commission&status=eq.imported&source_file=eq.${e(src.file_name)}&select=id,created_at,row_count,total_commission`, "created_at");
    const after = batches.filter(b => new Date(b.created_at) > new Date(src.created_at));
    if (after.length === 1) {
      const acc = await accept(src, "Accepted: this statement was imported by hand from the same file in Commission Report Import.");
      if (!acc.ok) return held("accept_refused", acc.message);
      const ln = await rpc("hcps_mfr_report_link_batch", { id: String(src.id), batch_id: after[0].id, actor: ACTOR });
      if (!ln.ok) return held("link_refused", ln.message, { batch_id: after[0].id });
      return { outcome: "imported", code: "linked_manual_import", final: true, batch_id: after[0].id,
        detail: Object.assign({ code: "linked_manual_import", message: "Imported by hand from this file; the batch is now linked to the register record.", rows: after[0].row_count, commission: after[0].total_commission }, base) };
    }
    if (after.length > 1) return held("several_manual_imports", `${after.length} by-hand imports carry this file name — which one belongs to the record is a person's call.`);

    if (!src.storage_path || !src.file_sha256) return held("no_stored_file", "The register has no stored file for this record.");
    let bytes; try { bytes = await fetchObject(src.storage_path); } catch (x) { return held("file_unreadable", "The stored file could not be read: " + String(x.message || x).slice(0, 160)); }
    if (sha256(bytes) !== src.file_sha256) return held("file_changed", "The stored file does not match the SHA-256 on record — nothing is read from it.");
    const ext = (String(src.storage_path).match(/\.([a-z0-9]+)$/i) || [])[1] || "";

    // Strongback (contract commission): the SR032 is statement evidence only.
    if (CT.contractFor(slug)) {
      if (ext.toLowerCase() !== "pdf") return held("not_a_statement_pdf", `A ${CT.contractFor(slug).statement} statement is a PDF; this file is .${ext}.`);
      let lines; try { const L = await deps.extractLayout(bytes); lines = L.pages.flatMap(p => p.lines.map(l => l.text)); }
      catch (x) { return held("unreadable", String(x.message || x).slice(0, 200)); }
      const s = CT.parseSr032(lines);
      if (!s.ok) return held("statement_problems", "The statement could not be read cleanly.", { problems: s.problems });
      if (period && s.month !== period) return held("period_mismatch", `The statement says ${s.month}; the register says ${period}.`);
      const acc = await accept(src, `Accepted automatically: ${s.rows.length} order line(s) add up to the printed Total Orders $${s.total_orders} and Total Commission Due $${s.total_due}. Statement evidence (reported due) only — never posted to monthly_sales (contract rule).`);
      if (!acc.ok) return held("accept_refused", acc.message);
      return { outcome: "refused", code: "statement_evidence", final: true, detail: Object.assign({ code: "statement_evidence",
        message: `Read: ${s.rows.length} order line(s), Total Orders $${s.total_orders}, Total Commission Due $${s.total_due}. Shown as reported due on the Commission Reconciliation; earned stays the contract rate and paid needs payment evidence. Never posted to monthly_sales.`,
        lines: s.rows.length, total_orders: s.total_orders, total_due: s.total_due }, base) };
    }

    if (!period || ym(src.report_period_end || src.report_period_start) !== period)
      return held("multi_month_statement", "The record covers more than one month. Which month each line belongs to is a person's call — import it by hand in Commission Report Import.");
    const tplRow = (await sbGet(`app_settings?key=eq.${e("ctpl:" + slug)}&select=value`))[0];
    const rd = CR.readStatement(bytes, ext, slug, (tplRow && tplRow.value) || null);
    if (rd.error) return held(rd.error, rd.message);
    const ctx = await ci.buildCtx(slug);
    const b = { ledger: rd.ledger, mapped_fields: rd.mapped_fields };
    const gate = ci.statementGate(b, slug, period, false, src.file_name, rd.rows, ctx);
    if (!gate.ok) return held("statement_incomplete", gate.message || "The statement is incomplete.", { gate: { error: gate.error, missing_mappings: gate.missing_mappings, missing: gate.missing, examples: (gate.examples || []).slice(0, 10), rows: gate.rows } });
    const { months, allOut } = ci.commissionMonths(slug, period, false, src.file_name, rd.rows, ctx);
    const review = ci.mapRows(slug, period + "-01", src.file_name, rd.rows, ctx).review;
    const dry = await rpc("hcps_commission_file_apply", { manufacturer: slug, source_file: src.file_name, apply: false, months, decisions: {} });
    if (!dry.ok) return held(dry.code || "dry_run_refused", dry.message);
    const d = dry.body || {};
    const strip = months.map(m => ({ period: m.period, rows: m.rows.map(r => { const o = Object.assign({}, r); delete o.imported_at; return o; }) }));
    const plan_hash = sha256(stable({ source_id: src.id, sha: src.file_sha256, months: strip, dry: { months: d.months, problems: d.problems, will_write: d.will_write } }));
    const facts = { reader: rd.reader, rows: rd.rows.length, amount: R2((d.will_write || {}).amount), commission: R2((d.will_write || {}).commission),
      matched: review.matched, unmatched_count: review.unmatched_count, held_rows: review.held_rows, ambiguous_zips: (review.ambiguous_zips || []).length,
      months: (d.months || []).map(m => ({ month: m.month, rows: m.rows, amount: m.amount, commission: m.commission, existing_files: m.existing_files, identical_to: m.identical_to, needs_decision: m.needs_decision, needs_paid_approval: m.needs_paid_approval, cross_lane_matches: m.cross_lane_matches })) };
    const probs = d.problems || [];

    if (probs.length) {
      // A month already holding a statement also reports paid_period_change; with identical lines nothing is written, so
      // neither problem applies. Any other problem (cross-lane, control total, ...) is never waived.
      const sameAsOnFile = probs.every(p => p.error === "decision_required" || p.error === "paid_period_change") && (d.months || []).length > 0
        && (d.months || []).every(m => m.needs_decision && (m.identical_to || []).length > 0);   // EVERY month already holds these exact lines
      if (sameAsOnFile) {
        const files = [...new Set((d.months || []).flatMap(m => m.identical_to || []))];
        const acc = await accept(src, `Accepted: identical to statement lines already in HCPS (${files.join(", ")}). Nothing written.`);
        if (!acc.ok) return held("accept_refused", acc.message);
        return { outcome: "refused", code: "already_in_hcps", final: true, plan_hash, detail: Object.assign({ code: "already_in_hcps",
          message: `Already in HCPS: every line is identical to the statement already imported as ${files.join(", ")}. Nothing written.`, identical_to: files }, facts, base) };
      }
      return { outcome: "needs_approval", code: "needs_decision", final: false, plan_hash, detail: Object.assign({ code: "needs_decision",
        message: "The importer needs your decision before anything is written: " + probs.map(p => `${p.month}: ${p.error.replace(/_/g, " ")}`).join("; ") + ". Open Commission Report Import with this file.", problems: probs }, facts, base) };
    }
    if (review.unmatched_count || review.held_rows || (review.ambiguous_zips || []).length) {
      return { outcome: "held", code: "dealers_need_review", final: false, plan_hash, detail: Object.assign({ code: "dealers_need_review",
        message: [review.unmatched_count ? `${review.unmatched_count} dealer name(s) not matched` : "", review.held_rows ? `${review.held_rows} line(s) for a branch not on file` : "",
          (review.ambiguous_zips || []).length ? `${review.ambiguous_zips.length} ZIP(s) shared by several branches` : ""].filter(Boolean).join("; ") + ". Match them in Commission Report Import; the next run imports it.",
        unmatched: (review.unmatched || []).slice(0, 25).map(u => ({ name: u.name, account: u.account, count: u.count, amount: u.total_amount })),
        unknown_branches: (review.unknown_branches || []).slice(0, 25).map(u => ({ corporate: u.corporate_name, ship_name: u.ship_name, ship_zip: u.ship_zip, count: u.count })) }, facts, base) };
    }

    // Clean: accept → apply → verify → link.
    const acc = await accept(src, "Accepted for automatic commission import: the importer's dry run found nothing to decide and every dealer line is matched.");
    if (!acc.ok) return held("accept_refused", acc.message);
    const ap = await rpc("hcps_commission_file_apply", { manufacturer: slug, source_file: src.file_name, apply: true, actor: ACTOR, months, decisions: {}, approve_paid: false, approve_reason: "" });
    if (!ap.ok) return { outcome: "refused", code: ap.code || "apply_refused", final: false, plan_hash, detail: Object.assign({ code: ap.code || "apply_refused", message: ap.message }, facts, base) };
    const res = ap.body || {};
    if (res.noop || !res.batch_id) return { outcome: "refused", code: "nothing_to_import", final: false, plan_hash, detail: Object.assign({ code: "nothing_to_import", message: "The importer found nothing to write." }, facts, base) };
    const ww = res.will_write || {}, dw = d.will_write || {};
    const rollback = async (code, message) => {
      const rb = await rpc("hcps_import_batch_rollback", { batch_id: res.batch_id, actor: ACTOR });
      return { outcome: rb.ok ? "rolled_back" : "error", code, final: false, plan_hash, batch_id: res.batch_id,
        detail: Object.assign({ code, message: message + (rb.ok ? " Rolled back." : " ROLLBACK FAILED: " + rb.message) }, facts, base) };
    };
    if (Number(ww.rows) !== Number(dw.rows) || R2(ww.commission) !== R2(dw.commission) || R2(ww.amount) !== R2(dw.amount))
      return rollback("result_differs", "The import did not match the checked dry run.");
    const ln = await rpc("hcps_mfr_report_link_batch", { id: String(src.id), batch_id: res.batch_id, actor: ACTOR });
    if (!ln.ok) return rollback("link_refused", "The batch could not be linked to its register record (" + ln.message + ").");
    // Account numbers, exactly as the manual v2 import maintains them (set when blank, confirm, flag a difference).
    const acct = { set: 0, conflicts: [] };
    if (!(ctx.orderLines && ctx.orderLines.has(slug)) && !ci.NO_ACCOUNT_CAPTURE.has(slug)) {
      const byDealer = new Map();
      for (const o of allOut) { if (!o.dealer_id) continue;
        const ref = ci.NAME_AS_ACCOUNT.has(slug) ? String(o.customer_name || "").trim() : String(o.customer_ref || "").trim();
        const s = byDealer.get(o.dealer_id) || new Set(); if (ref) s.add(ref); byDealer.set(o.dealer_id, s); }
      for (const [dealerId, set] of byDealer) { const refs = [...set];
        if (refs.length > 1) { acct.conflicts.push({ dealer_id: dealerId, reason: "report_lists_multiple_numbers", values: refs }); continue; }
        try { const r = await ci.orgAccounts.reconcileAccountRef(slug, dealerId, refs[0] || "", { apply: true });
          if (r.status === "set") acct.set++; else if (r.status === "conflict") acct.conflicts.push({ dealer_id: dealerId, existing: r.existing, incoming: r.incoming, reason: "differs_from_record" });
        } catch (x) { acct.conflicts.push({ dealer_id: dealerId, reason: "account_check_failed" }); } }
    }
    return { outcome: "imported", code: "imported", final: true, plan_hash, batch_id: res.batch_id, detail: Object.assign({ code: "imported",
      message: `Imported automatically: ${ww.rows} line(s), $${R2(ww.amount)} sales, $${R2(ww.commission)} commission, as batch ${res.batch_id}.`, accounts: acct }, facts, base) };
  }

  // All open records. budgetMs bounds the run (a scheduled function has about 30 seconds); the rest waits for the next hour.
  async function processAll(opts) {
    const budget = (opts && opts.budgetMs) || 18000, t0 = now();
    if (!(await flagOn("mi_commission_v2"))) return { ok: true, skipped: "switch_off" };
    const srcs = await sbGetAll(`mfr_sources?kind=eq.commission_statement&status=in.(received,accepted)&import_batch_id=is.null&select=${COLS}`, "id");
    if (!srcs.length) return { ok: true, ran: true, results: [] };
    const logs = (await sbGetOptional(`mfr_auto_import_log?source_id=in.(${srcs.map(s => s.id).join(",")})&select=id,source_id,outcome,plan_hash,batch_id,detail&order=id.desc`)) || [];
    const out = [];
    for (const src of srcs) {
      const last = logs.find(l => Number(l.source_id) === Number(src.id) && l.detail && l.detail.lane === "commission");
      if (last && last.detail.final && last.detail.sha === src.file_sha256) continue;
      // A rolled-back or failed write is never retried automatically (no hourly apply-then-rollback loop): a person looks first.
      if (last && (last.outcome === "rolled_back" || (last.outcome === "error" && last.batch_id)) && last.detail.sha === src.file_sha256) continue;
      if (now() - t0 > budget) { out.push({ source_id: src.id, outcome: "deferred" }); continue; }
      let r;
      try { r = await one(src); }
      catch (x) { r = { outcome: "error", code: "error", final: false, detail: { code: "error", message: String(x.message || x).slice(0, 300), file_name: src.file_name } }; }
      const changed = !last || last.outcome !== r.outcome || (last.plan_hash || "") !== (r.plan_hash || "") || (last.detail || {}).code !== r.code;
      if (changed) await log(src, r.outcome, { plan_hash: r.plan_hash, batch_id: r.batch_id, detail: Object.assign({ final: !!r.final }, r.detail) });
      out.push({ source_id: src.id, manufacturer: src.manufacturer, outcome: r.outcome, code: r.code, batch_id: r.batch_id || null, logged: changed });
    }
    return { ok: true, ran: true, results: out };
  }
  return { processAll, one };
}

module.exports = { make, ACTOR };

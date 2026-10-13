/* Contractual commission reconciliation — the READ side (CLAUDE.md §18, Angelo 2026-10-12 22:00 CT).
   Gathers, read-only: the manufacturer's sales already in HCPS (monthly_sales, sales-report lane), its registered order
   exports (stored originals, SHA-256 re-checked), its registered commission statements (stored PDFs, SHA-256 re-checked,
   read with the same server-side PDF reader MI-1c uses) and the President's payment / review evidence (Phase F table,
   when installed). Hands them to _contract_commission.reconcile. Writes nothing, anywhere.

   deps = { sbGet(path), sbGetAll(path, order), sbGetOptional(path) → rows | null when the table is not installed,
            fetchObject(storage_path) → Buffer, today() → 'YYYY-MM-DD', extractLayout?, readOrderRows?, mapRow? } */
const crypto = require("crypto");
const CT = require("./_contract_commission.js");
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const e = encodeURIComponent;

async function load(slug, deps) {
  const C = CT.contractFor(slug); if (!C) { const x = new Error("no_contract"); x.code = "no_contract"; throw x; }
  const RR = deps.readOrderRows ? { readOrderRows: deps.readOrderRows } : require("./_report_rows.js");
  const mapRow = deps.mapRow || require("./_source_import.js").mapRow;
  const extractLayout = deps.extractLayout || (b => require("./_strongback_layout.js").extractLayout(b));
  const [hist, laneRows, sources, events] = await Promise.all([
    deps.sbGetAll(`monthly_sales?manufacturer=eq.${e(slug)}&source=eq.sales_report&select=id,invoice_no,order_date,period,amount,commission,dealer_id,customer_name,source`, "id"),
    deps.sbGetAll(`monthly_sales?manufacturer=eq.${e(slug)}&or=(source.eq.commission,and(source.is.null,external_ref.is.null))&select=id,period,amount,commission,invoice_no`, "id"),
    deps.sbGetAll(`mfr_sources?manufacturer=eq.${e(slug)}&kind=in.(sales_export,commission_statement)&status=in.(received,accepted)&select=id,kind,title,file_name,file_sha256,storage_path,received_date,report_period_start,report_period_end,status,import_batch_id`, "id"),
    deps.sbGetOptional(`mfr_commission_events?manufacturer=eq.${e(slug)}&select=*&order=id`)]);
  const problems = [];
  const read = async s => {
    if (!s.storage_path || !s.file_sha256) return { error: "no stored file" };
    let bytes; try { bytes = await deps.fetchObject(s.storage_path); } catch (x) { return { error: "the stored file could not be read" }; }
    if (sha256(bytes) !== s.file_sha256) return { error: "the stored file does not match its SHA-256 — nothing read from it" };
    return { bytes };
  };
  const exports = [], statements = [], exportInfo = [];
  for (const s of sources.filter(x => x.kind === "sales_export")) {
    const f = await read(s);
    if (f.error) { problems.push(`Order export #${s.id} (${s.file_name}): ${f.error}.`); continue; }
    const fmt = (String(s.storage_path).match(/\.(csv|xlsx|xls)$/) || [])[1];
    let parsed; try { parsed = RR.readOrderRows(f.bytes, fmt); } catch (x) { problems.push(`Order export #${s.id}: ${String(x.message || x).slice(0, 200)}`); continue; }
    const sales = CT.salesFromExport(parsed, s, row => mapRow(slug, 0, s.file_name, row, 0).amount);
    exports.push(...sales); exportInfo.push({ source: s, sales });
  }
  for (const s of sources.filter(x => x.kind === "commission_statement")) {
    const base = { source_id: s.id, file_name: s.file_name, period: String(s.report_period_start || "").slice(0, 7), received_date: s.received_date };
    const f = await read(s);
    if (f.error) { statements.push(Object.assign(base, { parsed: { ok: false, problems: [f.error], rows: [] } })); continue; }
    if (!/\.pdf$/i.test(s.storage_path)) { statements.push(Object.assign(base, { parsed: { ok: false, problems: [`Not an ${C.statement} PDF.`], rows: [] } })); continue; }
    let lines; try { const L = await extractLayout(f.bytes); lines = L.pages.flatMap(p => p.lines.map(l => l.text)); }
    catch (x) { statements.push(Object.assign(base, { parsed: { ok: false, problems: [String(x.message || x).slice(0, 200)], rows: [] } })); continue; }
    const parsed = CT.parseSr032(lines);
    if (parsed.ok && parsed.month && base.period && parsed.month !== base.period) { parsed.ok = false; parsed.problems.push(`The statement says ${parsed.month}; the register says ${base.period}.`); }
    statements.push(Object.assign(base, { parsed }));
  }
  const history = CT.salesFromHistory(hist);
  const ids = [...new Set(hist.map(r => r.dealer_id).filter(Boolean))];
  const dealers = ids.length ? await deps.sbGet(`dealers?id=in.(${ids.map(e).join(",")})&select=id,business_name`) : [];
  const names = new Map(dealers.map(d => [d.id, d.business_name]));
  const rec = CT.reconcile({ slug, today: deps.today(), history, exports, statements, events: events || [],
    dealerOf: o => o.dealer_id && names.get(o.dealer_id) ? { id: o.dealer_id, name: names.get(o.dealer_id) } : null });
  rec.problems = problems.concat(rec.problems);
  rec.evidence_store = events === null ? "not_installed" : "installed";
  rec.groups = { dealer: CT.groupBy(rec, "dealer"), month: CT.groupBy(rec, "month"), reporting_month: CT.groupBy(rec, "reporting_month"), manufacturer: CT.groupBy(rec, "manufacturer") };
  // Financial preview of POSTING (nothing is posted here). Posting = importing a not-yet-imported order export into the
  // sales-report lane (its commission column = the contract rate, i.e. EARNED). Statements are never posted to
  // monthly_sales: that would put the same commission in the ledger twice.
  const inLedger = new Set(history.map(h => h.order_key));
  rec.posting_preview = {
    exports: exportInfo.filter(x => !x.source.import_batch_id).map(x => {
      const fresh = x.sales.filter(o => !inLedger.has(o.order_key));
      const eligible = fresh.map(o => rec.orders.find(r => r.order_key === o.order_key)).filter(Boolean);
      return { source_id: x.source.id, file_name: x.source.file_name, period: String(x.source.report_period_start || "").slice(0, 7),
        orders: fresh.length, lines: fresh.reduce((s, o) => s + o.lines, 0), amount: Math.round(fresh.reduce((s, o) => s + o.amount, 0) * 100) / 100,
        earned: Math.round(eligible.reduce((s, o) => s + o.earned, 0) * 100) / 100,
        not_eligible: eligible.filter(o => !o.earned && o.amount).map(o => ({ order: o.order, why: o.eligibility_text })),
        already_in_hcps: x.sales.length - fresh.length };
    }),
    statements_posted: false,
    statements_note: `${C.statement} statements stay out of monthly_sales: the same commission is already there as earned on the sale. They are reconciled here as "reported due".`,
    commission_lane_rows: laneRows.length,
    commission_lane_warning: laneRows.length ? `${laneRows.length} commission-lane row(s) for this manufacturer are already in monthly_sales — they would be a second copy of earned commission; review before posting.` : null,
  };
  return rec;
}

module.exports = { load };

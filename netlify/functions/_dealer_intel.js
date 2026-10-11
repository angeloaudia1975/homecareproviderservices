// MI-1c — shared logic for manufacturer dealer intelligence: which parser reads which manufacturer's report, the
// recorded match holds, the import payload (snapshots + observations with SOURCE-POSITION keys), and the read-only
// comparison with HCPS records shown in the preview. Nothing here writes anything.
const { matchDealers } = require("./_dealer_intel_match.js");
const { isCommissionLane } = require("./_commission_coverage.js");

// One parser per manufacturer report format. A manufacturer without one is refused, never guessed.
const PARSERS = { "strongback-mobility": () => require("./_strongback_report.js") };

// Recorded holds (owner decisions that stop a match, e.g. Wyatt's Pharmacy — CLAUDE.md RULE 18) live in ONE place: the
// database table mfr_intel_holds, which the import and the match decision enforce. The API reads them (strictly) and
// passes them in; there is no second copy here.

const OBS_KINDS = ["contact_person", "product_line", "told_us", "contact_log", "offer"];

// Parse + matches → the payload hcps_mfr_intel_import takes. Every observation carries its printed position.
function buildPayload({ source, parse, matches, actor }) {
  const byRow = new Map(matches.map(m => [m.row_no, m]));
  const summary = { matched: 0, review: 0, unmatched: 0, held: 0 };
  const dealers = [], observations = [];
  for (const r of parse.dealers) {
    const m = byRow.get(r.row_no); if (!m) throw new Error(`no match proposal for row ${r.row_no}`);
    summary[m.status]++;
    const pg = r.detail_page;
    dealers.push({
      row_no: r.row_no, position_key: `table:${r.pos}`, detail_position_key: pg ? `page:${pg.pos}` : null,
      printed_name: r.name, printed_city: r.city, printed_state_text: r.state_text, printed_state: r.state,
      group_heading: pg ? pg.group : null, tier: r.tier, trend: r.trend,
      l12m_text: r.l12m_text, l12m_amount: r.l12m, prior12_text: pg ? pg.prior12_text : null, prior12_amount: pg ? pg.prior12 : null,
      month_text: r.month_text, month_amount: r.month_amount, last_order_text: r.last_order_text, last_order_date: r.last_order_date,
      ergosteel_text: r.ergosteel_text, ergosteel: pg ? pg.detail.ergosteel : null,
      floor_text: r.floor_text, floor: pg ? pg.detail.floor : null,
      raw: { table: { name: r.name, city_text: r.city_text, tier: r.tier, trend: r.trend, l12m: r.l12m_text, month: r.month_text,
               last_order: r.last_order_text, ergosteel: r.ergosteel_text, floor: r.floor_text, pos: r.pos },
             page: pg ? { name: pg.name, city_text: pg.city_text, tier_text: pg.tier_text, trend: pg.trend, bought: pg.bought_text,
               group: pg.group, last_order_text: pg.detail.last_order ? pg.detail.last_order.text : null, pos: pg.pos } : null },
      match: { status: m.status, dealer_id: m.dealer_id, method: m.method,
        evidence: { reasons: m.reasons, candidates: m.candidates, sales_unattributed: m.sales_unattributed } },
    });
    if (!pg) continue;
    const d = pg.detail;
    for (const c of d.contacts) observations.push({ row_no: r.row_no, kind: "contact_person", position_key: c.pos, observed_on: null,
      text: c.lines.join(" · "), structured: { name: c.name, title: c.title, phones: c.phones, emails: c.emails, role: c.role, lines: c.lines },
      review_state: c.role === "dealer_contact" ? "proposed" : null });
    if (d.last_order) for (const l of d.last_order.lines) observations.push({ row_no: r.row_no, kind: "product_line", position_key: l.pos,
      observed_on: d.last_order.date, text: l.text, structured: { name: l.name, code: l.code, class: l.class, order: d.last_order.text } });
    if (d.told_us) observations.push({ row_no: r.row_no, kind: "told_us", position_key: d.told_us.pos,
      observed_on: d.told_us.dates.length === 1 ? d.told_us.dates[0] : null, text: d.told_us.text, structured: { dates: d.told_us.dates } });
    for (const e of d.contact_log) observations.push({ row_no: r.row_no, kind: "contact_log", position_key: e.pos, observed_on: e.date,
      text: `${e.date} ${e.channel}: ${e.text}`, structured: { channel: e.channel, note: e.text } });
  }
  for (const o of parse.offers) observations.push({ row_no: null, kind: "offer", position_key: o.pos, observed_on: null, text: o.text,
    structured: { where: o.where, status: "unverified manufacturer text — no pricing or campaign action" } });
  return {
    source_id: source.id, file_sha256: source.file_sha256, actor, parser_version: parse.parser,
    period_start: `${parse.header.through_month}-01`, period_end: monthEnd(parse.header.through_month),
    prepared_date: parse.header.prepared_date, owner_printed: parse.header.owner,
    header: { ...parse.header, kpis: parse.kpis, sections: parse.sections, figures: parse.figures, table: parse.table, groups: parse.groups.map(g => ({ heading: g.heading, count: g.count, description: g.description, pos: g.pos })) },
    checks: parse.checks, errors: parse.errors, match_summary: summary, dealers, observations,
  };
}
function monthEnd(ym) { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

// Which lane a monthly_sales row belongs to. The reconciliation with the manufacturer's invoiced figures uses ONLY the
// sales-report lane (order exports: source = 'sales_report'). Commission statements (the commission lane, the same test
// as SQL hcps_ms_is_commission_lane) and any other source are shown SEPARATELY and never added in: a commission
// statement can describe the very transactions a sales export already holds, so adding lanes would double-count.
function laneOf(r) {
  if (r.source === "sales_report") return "sales_report";
  if (isCommissionLane(r)) return "commission";
  return "other:" + r.source;
}
const LANE_LABEL = { sales_report: "Sales Report Import (order exports)", commission: "Commission Report Import (statements)" };
const r2 = n => Math.round(n * 100) / 100;
const moneyKey = v => Math.round(Number(v || 0) * 100);

// Read-only comparison of a report with HCPS records (the preview). Strongback's figures and HCPS's are shown side by
// side; neither is adjusted, and a difference is a fact to look at, not an error. Nothing here writes or moves a row.
function differences({ parse, matches, hcps, manufacturer }) {
  const end = monthEnd(parse.header.through_month);
  const startDate = new Date(end + "T00:00:00Z"); startDate.setUTCMonth(startDate.getUTCMonth() - 11); startDate.setUTCDate(1);
  const start = startDate.toISOString().slice(0, 10), monthStart = `${parse.header.through_month}-01`;
  const D = new Map((hcps.dealers || []).map(d => [d.id, d]));
  const allRows = hcps.sales_rows || [];
  const salesRows = allRows.filter(s => laneOf(s) === "sales_report");
  const otherRows = allRows.filter(s => laneOf(s) !== "sales_report");
  const inWin = (r, a, b) => { const p = String(r.period || "").slice(0, 10); return p >= a && p <= b; };
  // A row of another lane that looks like a sales-report transaction (same month, quantity and amount; same dealer
  // when both carry one) — the cross-lane duplicate test of MI-1a. Counted, never removed.
  const sameTxn = (o, s) => String(o.period || "").slice(0, 7) === String(s.period || "").slice(0, 7) && moneyKey(o.amount) === moneyKey(s.amount)
    && (o.qty == null || s.qty == null || Number(o.qty) === Number(s.qty)) && (!o.dealer_id || !s.dealer_id || o.dealer_id === s.dealer_id);
  const lanesIn = (rows, a, b) => {
    const by = new Map();
    for (const o of rows.filter(x => inWin(x, a, b))) {
      const l = laneOf(o); const t = by.get(l) || { lane: l, label: LANE_LABEL[l] || `other source "${l.slice(6)}"`, rows: 0, amount: 0, commission: 0, same_as_sales_report: 0 };
      t.rows++; t.amount += Number(o.amount || 0); if (o.commission != null && o.commission !== "") t.commission += Number(o.commission);
      if (salesRows.some(s => sameTxn(o, s))) t.same_as_sales_report++;
      by.set(l, t);
    }
    return [...by.values()].map(t => ({ ...t, amount: r2(t.amount), commission: r2(t.commission),
      note: "Shown separately — never added to the sales figure" + (t.same_as_sales_report ? `; ${t.same_as_sales_report} row(s) look like the same transaction as a sales-report line` : "") }));
  };
  const perDealer = matches.map(m => {
    const r = parse.dealers.find(x => x.row_no === m.row_no);
    const ids = m.dealer_id ? [m.dealer_id] : m.candidates.map(c => c.dealer_id);
    return { row_no: m.row_no, printed_name: m.printed_name, status: m.status, dealers: ids.map(id => {
      const d = D.get(id) || {}; const rows = salesRows.filter(s => s.dealer_id === id);
      const l12 = rows.filter(s => inWin(s, start, end)); const amt = l12.reduce((a, s) => a + Number(s.amount || 0), 0);
      const last = rows.map(s => s.order_date || String(s.period || "").slice(0, 10)).filter(Boolean).sort().pop() || null;
      const other = lanesIn(otherRows.filter(s => s.dealer_id === id), start, end);
      const dm = (hcps.dealer_manufacturers || []).find(x => x.dealer_id === id && x.manufacturer === manufacturer);
      const items = [];
      if (d.city && r.city && String(d.city).toLowerCase() !== String(r.city).toLowerCase()) items.push(`HCPS city ${d.city}, ${d.state || "?"} · printed ${r.city}, ${r.state || r.state_text || "?"}`);
      if (Math.round(amt * 100) !== Math.round((r.l12m || 0) * 100)) items.push(`last 12 months: HCPS Strongback sales-report lines $${amt.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${l12.length} lines) · Strongback reports ${r.l12m_text} invoiced`);
      for (const o of other) items.push(`${o.label}: ${o.rows} row(s), $${o.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} in the same 12 months — shown separately, not added`);
      if (r.last_order_date && last && last !== r.last_order_date) items.push(`last order: HCPS ${last} · Strongback ${r.last_order_date}`);
      if (parse.header.owner && d.rep_name && d.rep_name !== parse.header.owner) items.push(`HCPS rep ${d.rep_name} · report addressed to ${parse.header.owner} (HCPS ownership is not changed)`);
      if (!dm) items.push(`no ${manufacturer} line on the HCPS dealer record`);
      else if (dm.active === false) items.push(`${manufacturer} line on the HCPS record is inactive`);
      return { dealer_id: id, business_name: d.business_name || null, city: d.city || null, state: d.state || null,
        hcps_rep: d.rep_name || null, hcps_l12m: r2(amt), hcps_l12m_lines: l12.length, hcps_last_order: last, other_lanes_l12m: other,
        account_ref: dm ? dm.account_ref || null : null, differences: items };
    }) };
  });
  const sum = (a, b) => r2(salesRows.filter(s => inWin(s, a, b)).reduce((x, s) => x + Number(s.amount || 0), 0));
  const cnt = (a, b) => salesRows.filter(s => inWin(s, a, b)).length;
  const k = parse.kpis || [];
  const reconciliation = [
    { what: `${parse.header.through_text}`, strongback_text: k[0] ? k[0].value_text : null, strongback: k[0] ? k[0].value : null,
      hcps: sum(monthStart, end), hcps_lines: cnt(monthStart, end), other_lanes: lanesIn(otherRows, monthStart, end),
      hcps_note: "HCPS sales-report lines (Sales Report Import), this manufacturer, this month. Commission statements and other sources are listed separately and never added." },
    { what: k[3] ? k[3].label : "last 12 months", strongback_text: k[3] ? k[3].value_text : null, strongback: k[3] ? k[3].value : null,
      hcps: sum(start, end), hcps_lines: cnt(start, end), other_lanes: lanesIn(otherRows, start, end),
      hcps_note: `HCPS sales-report lines ${start} to ${end}. Commission statements and other sources are listed separately and never added.` },
  ].map(x => ({ ...x, gap: x.strongback === null ? null : r2(x.strongback - x.hcps),
    note: "Strongback reports what it invoiced the dealer; HCPS holds the order lines it has imported. Neither side is adjusted." }));
  return { window: { start, end }, dealers: perDealer, reconciliation };
}

// The manufacturer's prepared date: what the report prints vs what the MI-1b register holds. Never an upload or
// received date, never invented. Anything but "both stated and equal" or "both not stated" is a mismatch, which blocks
// the import (the database refuses it too: mi1c_prepared_date_mismatch).
function preparedDateCheck(parse, src) {
  const pdf = parse.header.prepared_date || null, reg = src.prepared_date || null;
  const regStatus = src.prepared_date_status || (reg ? "stated" : "not_stated");
  const ok = pdf === reg && (regStatus === "stated") === !!reg;
  const shown = v => v || "not stated";
  return { ok, status: ok ? (pdf ? "agrees" : "not_stated_both") : "mismatch", pdf: pdf, pdf_text: parse.header.prepared_text || null,
    register: reg, register_status: regStatus,
    message: ok ? (pdf ? `The report prints prepared ${parse.header.prepared_text}; the register says ${reg}.` : "Neither the report nor the register states a prepared date.")
      : `MISMATCH — the report prints prepared ${pdf ? `${parse.header.prepared_text || pdf} (${pdf})` : "nothing (not stated)"}, the register says ${shown(reg)}. Correct the register entry (or the file) before importing; nothing is accepted as the same source record.` };
}

// Everything a preview needs, from the parse and the HCPS evidence. Pure.
// held: the recorded holds of this manufacturer (mfr_intel_holds rows), read strictly by the caller.
function preview({ manufacturer, parse, hcps, held }) {
  if (!Array.isArray(held)) throw new Error("preview needs the recorded holds (an array, read from mfr_intel_holds)");
  const matches = matchDealers({ rows: parse.dealers, hcps, held });
  const counts = { matched: 0, review: 0, unmatched: 0, held: 0 };
  for (const m of matches) counts[m.status]++;
  return { matches, counts, diff: differences({ parse, matches, hcps, manufacturer }) };
}

module.exports = { PARSERS, OBS_KINDS, buildPayload, differences, preparedDateCheck, laneOf, preview, monthEnd };

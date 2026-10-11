// MI-1c — shared logic for manufacturer dealer intelligence: which parser reads which manufacturer's report, the
// recorded match holds, the import payload (snapshots + observations with SOURCE-POSITION keys), and the read-only
// comparison with HCPS records shown in the preview. Nothing here writes anything.
const { matchDealers } = require("./_dealer_intel_match.js");

// One parser per manufacturer report format. A manufacturer without one is refused, never guessed.
const PARSERS = { "strongback-mobility": () => require("./_strongback_report.js") };

// Recorded business decisions that stop a match being made (CLAUDE.md RULE 18, Angelo 2026-10-10):
// "Wyatt's Pharmacy → Weaver Medical Equipment Metro stays unchanged until the business relationship is confirmed;
//  no merge, no reassignment; ambiguous manufacturer intelligence for it is held for review."
const HELD = {
  "strongback-mobility": [
    { name: "Wyatt's Pharmacy Inc", reason: "Held by Angelo's decision (2026-10-10): the relationship between Wyatt's Pharmacy and Weaver Medical Equipment Metro is unconfirmed — no match, merge or reassignment until it is confirmed." },
  ],
};

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

// Read-only comparison of a report with HCPS records (the preview). Strongback's figures and HCPS's are shown side by
// side; neither is adjusted, and a difference is a fact to look at, not an error.
function differences({ parse, matches, hcps, manufacturer }) {
  const end = monthEnd(parse.header.through_month);
  const startDate = new Date(end + "T00:00:00Z"); startDate.setUTCMonth(startDate.getUTCMonth() - 11); startDate.setUTCDate(1);
  const start = startDate.toISOString().slice(0, 10), monthStart = `${parse.header.through_month}-01`;
  const D = new Map((hcps.dealers || []).map(d => [d.id, d]));
  const salesRows = hcps.sales_rows || [];
  const inWin = (r, a, b) => { const p = String(r.period || "").slice(0, 10); return p >= a && p <= b; };
  const perDealer = matches.map(m => {
    const r = parse.dealers.find(x => x.row_no === m.row_no);
    const ids = m.dealer_id ? [m.dealer_id] : m.candidates.map(c => c.dealer_id);
    return { row_no: m.row_no, printed_name: m.printed_name, status: m.status, dealers: ids.map(id => {
      const d = D.get(id) || {}; const rows = salesRows.filter(s => s.dealer_id === id);
      const l12 = rows.filter(s => inWin(s, start, end)); const amt = l12.reduce((a, s) => a + Number(s.amount || 0), 0);
      const last = rows.map(s => s.order_date || String(s.period || "").slice(0, 10)).filter(Boolean).sort().pop() || null;
      const dm = (hcps.dealer_manufacturers || []).find(x => x.dealer_id === id && x.manufacturer === manufacturer);
      const items = [];
      if (d.city && r.city && String(d.city).toLowerCase() !== String(r.city).toLowerCase()) items.push(`HCPS city ${d.city}, ${d.state || "?"} · printed ${r.city}, ${r.state || r.state_text || "?"}`);
      if (Math.round(amt * 100) !== Math.round((r.l12m || 0) * 100)) items.push(`last 12 months: HCPS Strongback sales $${amt.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${l12.length} lines) · Strongback reports ${r.l12m_text} invoiced`);
      if (r.last_order_date && last && last !== r.last_order_date) items.push(`last order: HCPS ${last} · Strongback ${r.last_order_date}`);
      if (parse.header.owner && d.rep_name && d.rep_name !== parse.header.owner) items.push(`HCPS rep ${d.rep_name} · report addressed to ${parse.header.owner} (HCPS ownership is not changed)`);
      if (!dm) items.push(`no ${manufacturer} line on the HCPS dealer record`);
      else if (dm.active === false) items.push(`${manufacturer} line on the HCPS record is inactive`);
      return { dealer_id: id, business_name: d.business_name || null, city: d.city || null, state: d.state || null,
        hcps_rep: d.rep_name || null, hcps_l12m: Math.round(amt * 100) / 100, hcps_l12m_lines: l12.length, hcps_last_order: last,
        account_ref: dm ? dm.account_ref || null : null, differences: items };
    }) };
  });
  const sum = (a, b) => Math.round(salesRows.filter(s => inWin(s, a, b)).reduce((x, s) => x + Number(s.amount || 0), 0) * 100) / 100;
  const k = parse.kpis || [];
  const reconciliation = [
    { what: `${parse.header.through_text}`, strongback_text: k[0] ? k[0].value_text : null, strongback: k[0] ? k[0].value : null,
      hcps: sum(monthStart, end), hcps_note: "HCPS monthly_sales, this manufacturer, this month (all lanes as stored)" },
    { what: k[3] ? k[3].label : "last 12 months", strongback_text: k[3] ? k[3].value_text : null, strongback: k[3] ? k[3].value : null,
      hcps: sum(start, end), hcps_note: `HCPS monthly_sales ${start} to ${end}` },
  ].map(x => ({ ...x, gap: x.strongback === null ? null : Math.round((x.strongback - x.hcps) * 100) / 100,
    note: "Strongback reports what it invoiced the dealer; HCPS holds the lines it has imported. Neither side is adjusted." }));
  return { window: { start, end }, dealers: perDealer, reconciliation };
}

// Everything a preview needs, from the parse and the HCPS evidence. Pure.
function preview({ manufacturer, parse, hcps }) {
  const matches = matchDealers({ rows: parse.dealers, hcps, held: HELD[manufacturer] || [] });
  const counts = { matched: 0, review: 0, unmatched: 0, held: 0 };
  for (const m of matches) counts[m.status]++;
  return { matches, counts, diff: differences({ parse, matches, hcps, manufacturer }) };
}

module.exports = { PARSERS, HELD, OBS_KINDS, buildPayload, differences, preview, monthEnd };

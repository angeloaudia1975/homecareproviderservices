// MI-1c — Manufacturer Dealer Intelligence API (Connect 360 › Sales Data & Analytics › Dealer Intelligence Import).
// Management only (president / admin / owner, Connect 360 staff sign-in). Every action is POST {action, …}.
//
//   sources                       → dealer reports registered in MI-1b (mfr_sources) and whether each is imported
//   preview  {source_id}          → reads the STORED original (checks its SHA-256 against the register), parses it on
//                                   the server, matches every printed dealer against HCPS evidence, and shows what an
//                                   import would store — extraction, match evidence, unresolved items, differences
//                                   from HCPS records, reconciliation. Writes NOTHING. Returns preview_hash.
//   import   {source_id, preview_hash}
//                                 → recomputes the preview on the server (never trusts the page) and, only when it is
//                                   still exactly what the operator reviewed (same hash) and has no parse errors, calls
//                                   hcps_mfr_intel_import: one transaction, idempotent.
//   report   {source_id}          → the imported snapshots, observations and audit trail.
//   decide   {snapshot_id, decision, dealer_id?, reason, expected_version}
//                                 → one person's match decision (hcps_mfr_intel_match). A dealer held by a recorded owner
//                                   decision (mfr_intel_holds, e.g. Wyatt's Pharmacy) is refused here (423) AND by the
//                                   database — the standard workflow never changes it.
//   dealer_search {q}             → HCPS dealers by name, to choose a match by hand (read-only).
//
// What this never does (MI-1c authorization, 2026-10-11): create, merge, re-parent or re-assign a dealer; write an
// alias, a contact, a task, an opportunity, a campaign, a price, a discount or anything to Zoho; touch monthly_sales or
// commissions; register or publish a report (that is MI-1b's Report History, and publishing is gated off — see
// mfr-reports-api.js and the database trigger mfr_sources_publication_gate).
const crypto = require("crypto");
const DI = require("./_dealer_intel.js");
const { holdKey } = require("./_dealer_intel_match.js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUCKET = "mfr-sources";
const ADMIN = new Set(["president", "admin", "owner"]);

const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const e = encodeURIComponent;
async function sbGet(p) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H() }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json(); }
async function sbGetAll(base, order) {
  const PAGE = 1000; let from = 0, out = [];
  for (;;) { const sep = base.includes("?") ? "&" : "?"; const rows = await sbGet(`${base}${sep}order=${order}&limit=${PAGE}&offset=${from}`);
    out = out.concat(rows); if (rows.length < PAGE) return out; from += PAGE; }
}
async function rpc(fn, p) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...H(), "content-type": "application/json" }, body: JSON.stringify({ p }) });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch (x) { body = { message: text }; }
  if (r.ok) return { ok: true, body };
  const msg = String((body && body.message) || text || "").slice(0, 500);
  const m = msg.match(/\b(mi1c_[a-z_]+|mi1c_guard)\b/) || msg.match(/constraint "([a-z0-9_]+)"/);
  return { ok: false, status: r.status, code: m ? m[1] : "database_error", message: msg };
}
const refusal = rr => json(/^mi1c_(stale)/.test(rr.code) ? 409 : rr.code === "mi1c_held_locked" ? 423 : /^mi1c_/.test(rr.code) ? 422 : (rr.status >= 500 ? 502 : 409), { error: rr.code, message: rr.message });

async function whoami(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim(); if (!tok) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null; const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase(); if (!email) return null;
    const s = await sbGet(`staff_users?email=eq.${e(email)}&select=email,role,active,name`); const su = s && s[0];
    if (!su || su.active === false) return null;
    return { email, role: su.role || "rep", name: su.name || email };
  } catch (x) { return null; }
}

const SRC_COLS = "id,manufacturer,kind,title,file_name,file_sha256,storage_path,received_date,prepared_date,prepared_date_status,report_period_start,report_period_end,status,publication_status,created_at";
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
// The payload hash the SQL stores: sha256 of the payload without the actor — computed the same way here so the
// operator's preview can be tied to the import.
const stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : (v && typeof v === "object")
  ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v === undefined ? null : v);
const previewHash = p => sha256(stable({ ...p, actor: undefined }));

// Everything the preview needs. Reads are strict: an unreadable source of evidence stops the preview (503), it is
// never treated as "no evidence".
async function buildPreview(sourceId, actor) {
  const src = (await sbGet(`mfr_sources?id=eq.${sourceId}&select=${SRC_COLS}`))[0];
  if (!src) return { status: 404, body: { error: "not_found" } };
  if (src.kind !== "dealer_report") return { status: 422, body: { error: "mi1c_not_a_dealer_report", message: "Only a dealer-intelligence report is imported here." } };
  const P = DI.PARSERS[src.manufacturer];
  if (!P) return { status: 422, body: { error: "no_parser", message: `There is no dealer-report reader for ${src.manufacturer} yet — nothing is guessed.` } };
  if (!src.storage_path || !src.file_sha256) return { status: 422, body: { error: "no_stored_file" } };
  const fr = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${src.storage_path}`, { headers: H() });
  if (!fr.ok) return { status: 502, body: { error: "file_unreadable", message: `The stored original could not be read (${fr.status}).` } };
  const bytes = Buffer.from(await fr.arrayBuffer());
  if (sha256(bytes) !== src.file_sha256) return { status: 409, body: { error: "file_changed", message: "The stored file does not match the SHA-256 on record — nothing is read from it." } };
  let parse;
  try { const { extractLayout } = require("./_strongback_layout.js"); parse = P().parseReport(await extractLayout(bytes)); }
  catch (x) { return { status: 422, body: { error: x.code || "unreadable_report", message: String(x.message || x).slice(0, 400) } }; }
  const m = e(src.manufacturer);
  const [dealers, aliases, salesRows, prev, dms, staff, imported, held] = await Promise.all([
    sbGetAll("dealers?select=id,business_name,city,state,parent_id,is_test,active,account_class,rep_email,rep_name", "id"),
    sbGetAll("dealer_aliases?select=alias_norm,dealer_id", "alias_norm"),
    sbGetAll(`monthly_sales?manufacturer=eq.${m}&select=customer_name,ship_city,ship_state,dealer_id,amount,qty,commission,period,order_date,source,external_ref,line_type`, "id"),
    sbGetAll(`mfr_dealer_snapshots?manufacturer=eq.${m}&match_status=eq.matched&match_method=in.(manual,previous_confirmed)&source_id=neq.${src.id}&select=printed_name,printed_city,dealer_id,matched_by,matched_at,source_id`, "id"),
    sbGetAll(`dealer_manufacturers?manufacturer=eq.${m}&select=dealer_id,manufacturer,active,account_ref`, "dealer_id"),
    sbGetAll("staff_users?select=email,name", "email"),
    sbGet(`mfr_intel_reports?source_id=eq.${src.id}&select=id,imported_by,imported_at,match_summary,content_hash`),
    sbGetAll(`mfr_intel_holds?manufacturer=eq.${m}&select=printed_name,name_key,reason,decided_by,decided_on`, "id"),
  ]);
  const staffName = new Map(staff.map(s => [String(s.email).toLowerCase(), s.name]));
  for (const d of dealers) d.rep_name = (d.rep_email && staffName.get(String(d.rep_email).toLowerCase())) || d.rep_name || null;
  // Name evidence for the matcher comes from the sales-report lane only (order exports) — the same lane the
  // reconciliation uses, so a commission statement of the same orders never doubles a count.
  const agg = new Map();
  for (const s of salesRows.filter(x => DI.laneOf(x) === "sales_report")) { const k = [s.customer_name || "", s.ship_city || "", s.ship_state || "", s.dealer_id || ""].join("|");
    const a = agg.get(k) || { customer_name: s.customer_name, ship_city: s.ship_city, ship_state: s.ship_state, dealer_id: s.dealer_id, n: 0, amount: 0 };
    a.n++; a.amount += Number(s.amount || 0); agg.set(k, a); }
  const hcps = { dealers, aliases, sales: [...agg.values()], sales_rows: salesRows, previous: prev.map(p => ({ ...p, decided_by: p.matched_by })), dealer_manufacturers: dms };
  const pv = DI.preview({ manufacturer: src.manufacturer, parse, hcps, held });
  const payload = DI.buildPayload({ source: src, parse, matches: pv.matches, actor });
  return { status: 200, src, parse, pv, payload, imported: imported[0] || null, held, prepared: DI.preparedDateCheck(parse, src) };
}

// What the operator reviews: every printed dealer with its extraction, proposal, evidence and differences.
function previewBody(b) {
  const { src, parse, pv, payload, imported, held, prepared } = b;
  const diffBy = new Map(pv.diff.dealers.map(d => [d.row_no, d]));
  const unresolved = [];
  const dealers = parse.dealers.map(r => {
    const m = pv.matches.find(x => x.row_no === r.row_no), pg = r.detail_page, d = pg ? pg.detail : null;
    const notExtracted = [];
    if (pg) {
      if (!d.contacts.length) notExtracted.push("contact people");
      if (!d.last_order || !d.last_order.date) notExtracted.push("last-order date (printed: " + (d.last_order ? d.last_order.text : "nothing") + ")");
      if (d.ergosteel && d.ergosteel.status === "unrecognised") notExtracted.push("ErgoSteel wording");
      if (d.floor && d.floor.status === "unrecognised") notExtracted.push("chair-on-the-floor wording");
    } else notExtracted.push("no dealer page in the report (table only)");
    if (m.status !== "matched") unresolved.push({ row_no: r.row_no, printed_name: r.name, status: m.status, why: m.reasons });
    return { row_no: r.row_no, printed: { name: r.name, city: r.city, state: r.state, state_text: r.state_text, tier: r.tier, trend: r.trend,
        l12m: r.l12m_text, prior12: pg ? pg.prior12_text : null, month: r.month_text, last_order: r.last_order_text, ergosteel: r.ergosteel_text,
        floor: r.floor_text, group: pg ? pg.group : null, position: r.pos, page_position: pg ? pg.pos : null },
      page: d ? { contacts: d.contacts, last_order: d.last_order, ergosteel: d.ergosteel, floor: d.floor, told_us: d.told_us, contact_log: d.contact_log } : null,
      match: m, differences: diffBy.get(r.row_no) || null, not_extracted: notExtracted };
  });
  if (!prepared.ok) unresolved.unshift({ row_no: null, printed_name: null, status: "prepared_date_mismatch", why: [prepared.message] });
  for (const w of parse.warnings) unresolved.push({ row_no: null, printed_name: null, status: "warning", why: [w.detail] });
  return { ok: true, source: src, already_imported: imported, parser: parse.parser,
    header: parse.header, kpis: parse.kpis, sections: parse.sections, figures: parse.figures, table: parse.table,
    groups: parse.groups.map(g => ({ heading: g.heading, count: g.count, description: g.description })), offers: parse.offers,
    checks: parse.checks, errors: parse.errors, warnings: parse.warnings, counts: pv.counts, prepared_date: prepared,
    holds: held.map(h => ({ printed_name: h.printed_name, reason: h.reason, decided_by: h.decided_by, decided_on: h.decided_on })),
    observations: payload.observations.reduce((a, o) => (a[o.kind] = (a[o.kind] || 0) + 1, a), {}),
    reconciliation: pv.diff.reconciliation, window: pv.diff.window, dealers, unresolved,
    preview_hash: previewHash(payload),
    note: "Preview only — nothing has been written. Strongback's figures are shown as printed and are never added to HCPS sales or commissions." };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: { "cache-control": "no-store" } };
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "not_configured" });
  const me = await whoami(event);
  if (!me) return json(401, { error: "sign_in_required" });
  if (!ADMIN.has(me.role)) return json(403, { error: "management_only", message: "Dealer intelligence import is for President / Admin." });
  let b; try { b = JSON.parse(event.body || "{}"); } catch (x) { return json(400, { error: "bad_json" }); }
  const actor = me.email;

  try {
    if (b.action === "sources") {
      const [srcs, reps] = await Promise.all([
        sbGetAll(`mfr_sources?kind=eq.dealer_report&select=${SRC_COLS}`, "id.desc"),
        sbGetAll("mfr_intel_reports?select=id,source_id,imported_by,imported_at,match_summary,dealer_count", "id")]);
      const bySrc = new Map(reps.map(r => [r.source_id, r]));
      return json(200, { ok: true, readers: Object.keys(DI.PARSERS), sources: srcs.map(s => ({ ...s, has_reader: !!DI.PARSERS[s.manufacturer], imported: bySrc.get(s.id) || null })) });
    }
    if (b.action === "preview" || b.action === "import") {
      const id = parseInt(b.source_id, 10); if (!(id > 0)) return json(400, { error: "source_id_required" });
      const pb = await buildPreview(id, actor);
      if (pb.status !== 200) return json(pb.status, pb.body);
      const body = previewBody(pb);
      if (b.action === "preview") return json(200, body);
      if (pb.src.status !== "accepted") return json(422, { error: "mi1c_not_accepted", message: `Accept the report in Report History first (it is ${pb.src.status}).` });
      if (!pb.prepared.ok) return json(422, { error: "mi1c_prepared_date_mismatch", message: pb.prepared.message, prepared_date: pb.prepared });
      if (body.errors.length) return json(422, { error: "mi1c_parse_errors", message: `The report has ${body.errors.length} reading error(s); nothing is imported.`, errors: body.errors });
      if (!b.preview_hash || b.preview_hash !== body.preview_hash)
        return json(409, { error: "preview_changed", message: "What would be imported has changed since the preview was shown (HCPS records or matches moved). Review the preview again.", preview_hash: body.preview_hash });
      const rr = await rpc("hcps_mfr_intel_import", pb.payload);
      return rr.ok ? json(200, { ...rr.body, counts: body.counts }) : refusal(rr);
    }
    if (b.action === "report") {
      const id = parseInt(b.source_id, 10); if (!(id > 0)) return json(400, { error: "source_id_required" });
      const [rep, snaps, obs, evs] = await Promise.all([
        sbGet(`mfr_intel_reports?source_id=eq.${id}&select=*`),
        sbGetAll(`mfr_dealer_snapshots?source_id=eq.${id}&select=*`, "row_no"),
        sbGetAll(`mfr_dealer_observations?source_id=eq.${id}&select=*`, "id"),
        sbGetAll(`mfr_intel_events?source_id=eq.${id}&select=*`, "id")]);
      if (!rep[0]) return json(404, { error: "not_imported" });
      const holds = await sbGetAll(`mfr_intel_holds?manufacturer=eq.${e(rep[0].manufacturer)}&select=printed_name,reason,decided_by,decided_on`, "id");
      for (const x of snaps) { const h = holds.find(h => holdKey(h.printed_name) === holdKey(x.printed_name)); x.held_locked = !!h; if (h) x.hold = h; }
      const ids = [...new Set(snaps.flatMap(s => [s.dealer_id, ...((s.match_evidence && s.match_evidence.candidates) || []).map(c => c.dealer_id)]).filter(Boolean))];
      let dealers = [];
      for (let i = 0; i < ids.length; i += 100) dealers = dealers.concat(await sbGet(`dealers?id=in.(${ids.slice(i, i + 100).join(",")})&select=id,business_name,city,state,parent_id`));
      return json(200, { ok: true, report: rep[0], snapshots: snaps, observations: obs, events: evs, dealers, holds });
    }
    if (b.action === "decide") {
      const sid = parseInt(b.snapshot_id, 10); if (!(sid > 0)) return json(400, { error: "snapshot_id_required" });
      const dealer = b.dealer_id ? String(b.dealer_id) : "";
      if (dealer && !/^[0-9a-f-]{36}$/i.test(dealer)) return json(400, { error: "bad_dealer_id" });
      // A recorded hold is never changed through this workflow (the database refuses it too).
      const snap = (await sbGet(`mfr_dealer_snapshots?id=eq.${sid}&select=id,manufacturer,printed_name`))[0];
      if (!snap) return json(404, { error: "mi1c_no_snapshot" });
      const holds = await sbGetAll(`mfr_intel_holds?manufacturer=eq.${e(snap.manufacturer)}&select=printed_name,reason`, "id");
      const hold = holds.find(h => holdKey(h.printed_name) === holdKey(snap.printed_name));
      if (hold) return json(423, { error: "mi1c_held_locked", message: `"${snap.printed_name}" is held by a recorded owner decision and cannot be changed here. ${hold.reason}` });
      const rr = await rpc("hcps_mfr_intel_match", { snapshot_id: sid, decision: String(b.decision || ""), dealer_id: dealer,
        reason: String(b.reason || "").slice(0, 1000), actor, expected_version: b.expected_version == null ? null : parseInt(b.expected_version, 10) });
      return rr.ok ? json(200, rr.body) : refusal(rr);
    }
    if (b.action === "dealer_search") {
      const qq = String(b.q || "").replace(/[^A-Za-z0-9 '&.-]/g, " ").trim().slice(0, 60);
      if (qq.length < 2) return json(200, { ok: true, dealers: [] });
      const rows = await sbGet(`dealers?business_name=ilike.*${e(qq)}*&or=(is_test.is.null,is_test.is.false)&select=id,business_name,city,state,parent_id&order=business_name&limit=25`);
      return json(200, { ok: true, dealers: rows });
    }
  } catch (x) {
    return json(503, { error: "unreadable", message: "Could not read what this needs just now: " + String(x.message || x).slice(0, 200) });
  }
  return json(400, { error: "unknown_action" });
};
exports._internals = { previewHash, stable };

// MI — the hourly automatic import (:40). Two parts, each gated by its own switch and safeguards:
//   1. Phase E order exports (Angelo, 2026-10-12): registered Strongback order exports — imported only when every check
//      passes on the fresh, strict path (Ship-To, corrections, MI-1a dry run, duplicates, quarantine, lanes); anything
//      else is logged once and waits for the President (Ship-To Review → Import check). See shipto-review-api.js.
//   2. Commission statements (Angelo, 2026-10-13 11:54 CT): registered commission statements through the existing
//      guarded importer (hcps_commission_file_apply), only when mi_commission_v2 is on. See _commission_auto.js.
// The two parts run one after the other; a failure in one never stops the other.
const { runAutoImport } = require("./shipto-review-api.js");
const CA = require("./_commission_auto.js");
const { flagOn } = require("./_flags.js");

const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
const NOT_INSTALLED = /PGRST205|42P01|Could not find the table|does not exist/i;
async function sbGet(p) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H() }); if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`); return r.json(); }
async function sbGetAll(base, order) {
  const PAGE = 1000; let from = 0, out = [];
  for (;;) { const sep = base.includes("?") ? "&" : "?"; const rows = await sbGet(`${base}${sep}order=${order}&limit=${PAGE}&offset=${from}`);
    out = out.concat(rows); if (rows.length < PAGE) return out; from += PAGE; }
}
async function sbGetOptional(p) { try { return await sbGet(p); } catch (x) { if (NOT_INSTALLED.test(String(x.message))) return null; throw x; } }
async function rpc(fn, p) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...H(), "content-type": "application/json" }, body: JSON.stringify({ p }) });
  const text = await r.text(); let body; try { body = JSON.parse(text); } catch (x) { body = { message: text }; }
  if (r.ok) return { ok: true, body };
  const msg = String((body && body.message) || text || "").slice(0, 600);
  const m = msg.match(/\b(mi1a_[a-z_]+|mi1b_[a-z_]+|mi_e_[a-z_]+)\b/);
  return { ok: false, status: r.status, code: m ? m[1] : "database_error", message: msg };
}
async function fetchObject(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/mfr-sources/${path}`, { headers: H() });
  if (!r.ok) throw new Error(`storage ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
function commissionDeps() {
  return { sbGet, sbGetAll, sbGetOptional, rpc, fetchObject, flagOn: name => flagOn(sbGet, name),
    ci: require("./commissions-api.js").internal,
    extractLayout: b => require("./_strongback_layout.js").extractLayout(b) };
}

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE) return { statusCode: 200, body: JSON.stringify({ skipped: "not configured" }) };
  const out = {};
  try { out.order_exports = await runAutoImport(); } catch (e) { out.order_exports = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
  try { out.commission_statements = await CA.make(commissionDeps()).processAll({ budgetMs: 15000 }); }
  catch (e) { out.commission_statements = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
  return { statusCode: 200, body: JSON.stringify(out) };
};
exports.commissionDeps = commissionDeps;

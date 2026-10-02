// HCPS — creating opportunities from an approved meeting (Phase 1).
//
// Approved opportunities go into the EXISTING opportunities table with the existing stages and
// probabilities (identified → contacted → quoted → won / lost), so the Pipeline page, the forecast
// and the Zoho mapping are unchanged — Zoho sync reads named columns only and never sees the new
// ones (manufacturer, product, quantity, contact, origin).
//
// Rows carry (origin_type, origin_id, origin_key) and are inserted with "ignore duplicates" against
// the unique index on those three columns, so replaying an approval creates each deal once.
//
//   createOpportunities(list, ctx) -> { created:[rows], skipped:n }
//   ctx = { sbGet, sbSend, me, origin:{type,id}, source?, mfrName?:{slug:name} }

const STAGES = ["identified", "contacted", "quoted", "won", "lost"];
const STAGE_PROB = { identified: 0.1, contacted: 0.3, quoted: 0.6, won: 1, lost: 0 };
const OPEN_STAGES = ["identified", "contacted", "quoted"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

const clean = (v, n) => { const s = (v == null ? "" : String(v)).trim(); return s ? s.slice(0, n) : null; };
const num = v => { if(v == null || v === "") return null; const n = Number(String(v).replace(/[$,\s]/g, "")); return Number.isFinite(n) && n >= 0 ? n : null; };

function oppRow(o, ctx){
  o = o || {}; ctx = ctx || {};
  const me = ctx.me || {};
  const stage = OPEN_STAGES.includes(String(o.stage || "").toLowerCase()) ? String(o.stage).toLowerCase() : "identified";
  const slug = clean(o.manufacturer, 80);
  const mfrName = (ctx.mfrName && slug && ctx.mfrName[slug]) || null;
  const qty = num(o.quantity);
  const now = new Date().toISOString();
  const key = clean(o.origin_key || o.key, 80);
  return {
    dealer_id: clean(o.dealer_id || ctx.dealer_id, 80),
    title: clean(o.title, 200),
    line: clean(o.line, 120) || mfrName,
    manufacturer: mfrName ? slug : null,          // only a KNOWN manufacturer slug is stored
    product: clean(o.product, 160),
    quantity: qty,
    value: num(o.value) || 0,
    probability: STAGE_PROB[stage],
    stage,
    status: "open",
    expected_close: ISO.test(String(o.expected_close || "")) ? String(o.expected_close) : null,
    contact_id: clean(o.contact_id, 80),          // the caller has already checked it is this dealer's contact
    next_step: clean(o.next_step, 300),
    next_step_date: ISO.test(String(o.next_step_date || "")) ? String(o.next_step_date) : null,
    owner_rep: me.rep_name || null,
    owner_email: String(me.email || "").toLowerCase() || null,
    source: clean(ctx.source, 40) || "visit",
    notes: clean(o.notes, 2000),
    created_by: me.name || me.email || null,
    updated_at: now,
    updated_by: me.email || me.name || null,
    origin_type: ctx.origin ? clean(ctx.origin.type, 40) : null,
    origin_id: ctx.origin ? clean(ctx.origin.id, 80) : null,
    origin_key: key && KEY_RE.test(key) ? key : null,
  };
}

async function createOpportunities(list, ctx){
  const rows = (list || []).map(o => oppRow(o, ctx)).filter(r => r.dealer_id && r.title);
  if(!rows.length) return { created: [], skipped: 0 };
  const keyed = rows.every(r => r.origin_type && r.origin_id && r.origin_key);
  if(!keyed) throw new Error("opportunities from a visit need an origin key");
  try{
    const ins = await ctx.sbSend("POST", "opportunities?on_conflict=origin_type,origin_id,origin_key", rows,
                                 { Prefer: "resolution=ignore-duplicates,return=representation" });
    const created = Array.isArray(ins) ? ins : [];
    return { created, skipped: rows.length - created.length };
  }catch(e){
    if(!/42P10|ON CONFLICT/i.test(String(e && e.message || e))) throw e;
    const have = await ctx.sbGet(`opportunities?origin_type=eq.${encodeURIComponent(rows[0].origin_type)}&origin_id=eq.${encodeURIComponent(rows[0].origin_id)}&select=origin_key`).catch(() => []);
    const seen = new Set((have || []).map(x => String(x.origin_key)));
    const fresh = rows.filter(r => !seen.has(String(r.origin_key)));
    if(!fresh.length) return { created: [], skipped: rows.length };
    const ins = await ctx.sbSend("POST", "opportunities", fresh, { Prefer: "return=representation" });
    const created = Array.isArray(ins) ? ins : [];
    return { created, skipped: rows.length - created.length };
  }
}

module.exports = { createOpportunities, oppRow, STAGES, STAGE_PROB, OPEN_STAGES };

// golden-proxy — the Partner 360 dealer's ONLY route to Golden (Stage 1: eligibility).
// The browser never calls Golden and never holds an integration credential. This function:
//   1. identifies the signed-in dealer from their Partner 360 sign-in (Supabase JWT → approved dealer_users row)
//      or a staff "view as dealer" preview token (read-only role staff_preview);
//   2. maps HCPS's dealer to the canonical organisation (+ branch): a dealer row with parent_id is a BRANCH of
//      that parent (blueprint §3.2/§3.3);
//   3. asks Golden through the signed client (_golden_client.js) — Golden decides eligibility from its own
//      verified link; HCPS only shows the answer and stores NOTHING about Golden prices or stock.
// Switches (app_settings.phase2_flags, ON only when exactly true; missing/unreadable = OFF):
//   golden_p360_catalog        master switch for Golden inside Partner 360
//   golden_p360_pilot_dealers  array of HCPS dealer ids allowed while piloting (empty/missing = nobody)
// With the switch off the answer is { ok:true, enabled:false } and Golden is never called.
//   POST { action:"eligibility" }
"use strict";
const { flags } = require("./_flags.js");
const GC = require("./_golden_client.js");

const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
// Same CORS as orders-api: authorization is the dealer's bearer token (no cookies), never the Origin.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, x-hcps-preview",
  "access-control-allow-methods": "POST, OPTIONS" };
const json = (c, o) => ({ statusCode: c, headers: Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, CORS), body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
async function sbGet(path){ const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() }); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function dealerFromToken(event){
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim(); if(!tok) return null;
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
  if(!ur.ok) return null;
  const u = await ur.json(); if(!u || !u.id) return null;
  const rows = await sbGet(`dealer_users?uid=eq.${encodeURIComponent(u.id)}&select=status,dealer_id`);
  const du = rows && rows[0];
  if(!du || du.status !== "approved" || !du.dealer_id) return null;
  return { dealer_id: du.dealer_id, actor: u.id, preview: false };
}
async function dealerFromPreview(event){
  const t = String(event.headers["x-hcps-preview"] || event.headers["X-HCPS-Preview"] || "").trim();
  if(!/^[0-9a-f]{48}$/.test(t)) return null;
  const rows = await sbGet(`dealer_preview_tokens?token=eq.${encodeURIComponent(t)}&select=dealer_id,expires_at`);
  const r = rows && rows[0]; if(!r || !r.dealer_id) return null;
  if(r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return null;
  return { dealer_id: r.dealer_id, actor: "staff-preview", preview: true };
}

// HCPS dealer row → canonical { sub_dealer (organisation), sub_branch }.
async function canonical(dealerId){
  const rows = await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=id,parent_id`);
  const d = rows && rows[0]; if(!d) return null;
  return d.parent_id ? { sub_dealer: d.parent_id, sub_branch: d.id } : { sub_dealer: d.id, sub_branch: null };
}

exports.handler = async (event) => {
  if(event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  try{
    if(!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok:false, error:"server not configured" });
    if(event.httpMethod !== "POST") return json(405, { ok:false, error:"method not allowed" });
    let b; try{ b = JSON.parse(event.body || "{}"); }catch{ return json(400, { ok:false, error:"bad JSON" }); }
    if(b.action !== "eligibility") return json(400, { ok:false, error:"unknown action" });

    let who = null;
    try{ who = (await dealerFromToken(event)) || (await dealerFromPreview(event)); }
    catch(e){ return json(503, { ok:false, error:"sign-in could not be checked" }); }
    if(!who) return json(401, { ok:false, error:"unauthorized" });

    const f = await flags(sbGet);
    const pilot = Array.isArray(f.golden_p360_pilot_dealers) ? f.golden_p360_pilot_dealers.map(String) : [];
    if(f.golden_p360_catalog !== true) return json(200, { ok:true, enabled:false, reason:"switched_off" });

    let c; try{ c = await canonical(who.dealer_id); }catch(e){ return json(503, { ok:false, error:"dealer could not be read" }); }
    if(!c || !UUID_RE.test(String(c.sub_dealer)) || (c.sub_branch && !UUID_RE.test(String(c.sub_branch)))) return json(200, { ok:true, enabled:false, reason:"dealer_not_found" });
    if(!pilot.includes(String(c.sub_dealer)) && !pilot.includes(String(who.dealer_id))) return json(200, { ok:true, enabled:false, reason:"not_in_pilot" });

    const role = who.preview ? "staff_preview" : (c.sub_branch ? "branch_user" : "dealer");
    const r = await GC.call({ method:"GET", path:"/v1/eligibility", delegation: { sub_dealer: c.sub_dealer, sub_branch: c.sub_branch, actor: who.actor, role } });
    if(r.configured === false) return json(200, { ok:true, enabled:false, reason:"golden_not_configured" });
    if(!r.ok){
      // Never guess: Golden's answer is the only source. Show "not available right now". The precise reason
      // (e.g. a key or signature problem) is logged here, never sent to the dealer's browser.
      console.warn("golden-proxy: Golden refused or unreachable", JSON.stringify({ status: r.status, code: r.error }));
      return json(200, { ok:true, enabled:true, available:false, reason: "golden_unavailable" });
    }
    const g = r.json || {};
    const caps = g.capabilities || {};
    return json(200, { ok:true, enabled:true, available:true,
      state: g.state, reason: g.reason || null,
      capabilities: { see_prices: caps.see_prices === true, order: caps.order === true && !who.preview, history: caps.history === true },
      order_route: who.preview ? null : (g.order_route || null),
      request_id: g.request_id || null });
  }catch(e){
    console.error("golden-proxy error", e && e.message);
    return json(500, { ok:false, error:"golden-proxy failed" });
  }
};

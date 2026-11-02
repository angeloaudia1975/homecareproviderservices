// golden-links-api — Connect 360 "Golden Partner Links" (Stage 1 of the Golden ⇄ Partner 360 integration).
// Golden decides which HCPS dealer is which Golden account. HCPS can only PROPOSE a link; a Golden admin
// verifies or revokes it on Golden's side (goldenonlineordering…/admin/integration-links.html). This API:
//   POST { action:"status" }                 president/admin/owner: is the Golden connection configured + healthy?
//   POST { action:"candidates" }             accounts seen on Golden events, with the HCPS dealer they resolved to
//   POST { action:"links" }                  HCPS's mirror of proposals and their last-known Golden state
//   POST { action:"propose", dealer_id, golden_dealer_id, customer_no?, method, note? }
//                                            send a proposal to Golden (switch golden_p360_links must be ON)
//   POST { action:"refresh", dealer_id }     ask Golden for that dealer's current state (read-only on Golden)
// Staff Bearer token (Connect 360 sign-in, RULE 9). Management roles only — linking an account is an
// account-assignment decision, never a rep action (RULE 16). Nothing here writes Golden data; the mirror
// table golden_dealer_links is HCPS's own record of what it proposed and what Golden last said.
"use strict";
const { flags } = require("./_flags.js");
const GC = require("./_golden_client.js");

const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c, o) => ({ statusCode: c, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` });
async function sbGet(path){ const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() }); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method, path, body, extra){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...H(), "content-type": "application/json", ...(extra || {}) }, body: body != null ? JSON.stringify(body) : undefined });
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const ADMIN = new Set(["president", "admin", "owner"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,79}$/;
const METHODS = new Set(["account_number", "federation_event", "manual"]);

async function whoami(event){
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim(); if(!tok) return null;
  try{
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
    if(!r.ok) return null; const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase(); if(!email) return null;
    const s = await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,active,name`);
    const su = s && s[0];
    if(su && su.active !== false) return { role: String(su.role || "rep").toLowerCase(), email, name: su.name || email };
  }catch(e){}
  return null;
}

exports.handler = async (event) => {
  try{
    if(!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok:false, error:"Supabase env vars not set" });
    if(event.httpMethod !== "POST") return json(405, { ok:false, error:"method not allowed" });
    const me = await whoami(event); if(!me) return json(401, { ok:false, error:"unauthorized" });
    if(!ADMIN.has(me.role)) return json(403, { ok:false, error:"management only" });
    let b; try{ b = JSON.parse(event.body || "{}"); }catch{ return json(400, { ok:false, error:"bad JSON" }); }

    if(b.action === "status"){
      const f = await flags(sbGet);
      if(!GC.configured()) return json(200, { ok:true, configured:false, switch_on: f.golden_p360_links === true });
      const r = await GC.call({ method:"GET", path:"/v1/health" });
      return json(200, { ok:true, configured:true, switch_on: f.golden_p360_links === true, golden_reachable: r.ok,
        golden_status: r.ok ? "ok" : (r.error || "unavailable"), capabilities: r.ok && r.json ? r.json.capabilities : null });
    }

    if(b.action === "candidates"){
      // Golden events already carry the Golden slug + account number and the HCPS dealer they resolved to.
      const ev = await sbGet("federation_events?source_system=eq.golden&status=eq.processed&dealer_id=not.is.null&external_dealer_id=not.is.null"
        + "&select=dealer_id,external_dealer_id,customer_no,received_at&order=received_at.desc&limit=5000");
      const seen = new Map();
      for(const e of (ev || [])){ const k = e.dealer_id + "|" + e.external_dealer_id; if(!seen.has(k)) seen.set(k, { dealer_id: e.dealer_id, golden_dealer_id: e.external_dealer_id, customer_no: e.customer_no || null, last_event: e.received_at, events: 0 }); seen.get(k).events++; }
      const ids = [...new Set([...seen.values()].map(x => x.dealer_id))];
      const dealers = {};
      for(let i = 0; i < ids.length; i += 100){
        const chunk = ids.slice(i, i + 100);
        const rows = await sbGet(`dealers?id=in.(${chunk.map(encodeURIComponent).join(",")})&select=id,business_name,hcps_account,parent_id,city,state,is_test`);
        (rows || []).forEach(d => { dealers[d.id] = d; });
      }
      const links = await sbGet("golden_dealer_links?select=hcps_dealer_id,golden_dealer_id,status,golden_state");
      const linkBy = {}; (links || []).forEach(l => { linkBy[l.hcps_dealer_id + "|" + l.golden_dealer_id] = l; });
      const out = [...seen.values()].map(c => {
        const d = dealers[c.dealer_id] || {};
        return Object.assign(c, { name: d.business_name || "", city: d.city || "", state: d.state || "", is_test: !!d.is_test,
          is_branch: !!d.parent_id, parent_id: d.parent_id || null,
          account_matches: !!(d.hcps_account && c.customer_no && String(d.hcps_account).trim() === String(c.customer_no).trim()),
          link: linkBy[c.dealer_id + "|" + c.golden_dealer_id] || null });
      }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return json(200, { ok:true, candidates: out });
    }

    if(b.action === "links"){
      const rows = await sbGet("golden_dealer_links?select=*&order=proposed_at.desc&limit=1000");
      return json(200, { ok:true, links: rows || [] });
    }

    if(b.action === "propose"){
      const f = await flags(sbGet);
      if(f.golden_p360_links !== true) return json(503, { ok:false, error:"switched_off", message:"Golden linking is switched off." });
      const dealerId = String(b.dealer_id || ""), golden = String(b.golden_dealer_id || "").trim().toLowerCase();
      if(!UUID_RE.test(dealerId)) return json(400, { ok:false, error:"dealer_id required" });
      if(!SLUG_RE.test(golden)) return json(400, { ok:false, error:"golden_dealer_id required" });
      if(!METHODS.has(b.method)) return json(400, { ok:false, error:"method must be account_number, federation_event or manual" });
      const note = b.note == null ? null : String(b.note).slice(0, 500);
      if(b.method === "manual" && !note) return json(400, { ok:false, error:"a note is required for a manual proposal" });
      const d = await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=id,parent_id,hcps_account,is_test`);
      if(!d || !d[0]) return json(404, { ok:false, error:"dealer not found" });
      if(d[0].parent_id) return json(400, { ok:false, error:"link the organisation (HQ), not a branch", parent_id: d[0].parent_id });
      const customerNo = b.customer_no == null || b.customer_no === "" ? null : String(b.customer_no).trim().slice(0, 40);
      const r = await GC.call({ method:"POST", path:"/v1/identity/assign",
        body: { golden_dealer_id: golden, hcps_dealer_id: dealerId, customer_no: customerNo, evidence: { method: b.method, note } },
        delegation: { sub_dealer: dealerId, sub_branch: null, actor: me.email, role: "hcps_staff" } });
      if(r.configured === false) return json(503, { ok:false, error:"golden_not_configured" });
      if(!r.ok) return json(r.status && r.status < 500 ? r.status : 502, { ok:false, error: r.error || "golden_refused", message: r.json && r.json.error && r.json.error.message || null });
      const g = r.json || {};
      await sbSend("POST", "golden_dealer_links?on_conflict=hcps_dealer_id,golden_dealer_id", [{
        hcps_dealer_id: dealerId, golden_dealer_id: golden, customer_no: customerNo, golden_link_id: g.link_id || null,
        status: g.status === "verified" ? "verified" : "proposed", proposed_by: me.email, evidence_method: b.method, note,
      }], { Prefer: "resolution=merge-duplicates,return=minimal" });
      return json(200, { ok:true, result: g.result, status: g.status, link_id: g.link_id });
    }

    if(b.action === "refresh"){
      const dealerId = String(b.dealer_id || "");
      if(!UUID_RE.test(dealerId)) return json(400, { ok:false, error:"dealer_id required" });
      const r = await GC.call({ method:"GET", path:"/v1/eligibility", delegation: { sub_dealer: dealerId, sub_branch: null, actor: me.email, role: "staff_preview" } });
      if(r.configured === false) return json(503, { ok:false, error:"golden_not_configured" });
      if(!r.ok) return json(502, { ok:false, error: r.error || "golden_unavailable" });
      const g = r.json || {};
      const state = g.state === "none" ? (g.reason === "golden_account_inactive" ? "inactive" : "not_verified") : "verified";
      await sbSend("PATCH", `golden_dealer_links?hcps_dealer_id=eq.${encodeURIComponent(dealerId)}`,
        { golden_state: state, capabilities: g.capabilities || null, checked_at: new Date().toISOString(), status: state === "verified" ? "verified" : undefined },
        { Prefer: "return=minimal" });
      return json(200, { ok:true, state, capabilities: g.capabilities || null });
    }

    return json(400, { ok:false, error:"unknown action" });
  }catch(e){
    console.error("golden-links-api", e && e.message);
    return json(500, { ok:false, error:"golden-links-api failed" });
  }
};

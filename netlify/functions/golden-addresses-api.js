// golden-addresses-api — B7 (owner directive 2026-11-05): the dealer's Golden shipping address book in Partner 360.
// HCPS is the ship-to system of record. The book is per GOLDEN ACCOUNT NUMBER (_golden_addresses.js): every HCPS
// location that carries the same Golden number shares it; unrelated accounts never see each other's addresses.
// Dealers add, edit and remove saved addresses themselves — no HCPS approval. Each sign-in has its OWN default ship-to.
//
//   POST + Bearer <dealer jwt> (or a staff "view as dealer" token: list only, no default, no writes)
//     { action:"list" }                       → { entries:[...], default_ref, default_stale, preselect, locations }
//     { action:"save", ref?:"gs:<uuid>", address:{ name, address, address2?, city, state, zip, phone? }, make_default? }
//                                             → { entry }   (validated with Golden's own rules — contract 1.8.0 §4i)
//     { action:"remove", ref:"gs:<uuid>" }    → { removed:true }   (kept, marked removed — never hard-deleted)
//     { action:"set_default", ref }           → { default_ref }    (only an address in this account's book)
// Switches (phase2_flags, exactly true): golden_p360_account_gate AND golden_p360_hcps_shipto. Off → { enabled:false }.
// Writes touch ONLY golden_ship_addresses / golden_ship_defaults (supabase/golden_b7_shipto.sql, RULE 19 locked).
"use strict";
const { flags } = require("./_flags.js");
const GA = require("./_golden_addresses.js");

const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, x-hcps-preview", "access-control-allow-methods": "POST, OPTIONS" };
const json = (c, o) => ({ statusCode: c, headers: Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, CORS), body: JSON.stringify(o) });
const H = () => ({ apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "content-type": "application/json" });
const enc = encodeURIComponent;

async function sbGet(path){ const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H() }); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sbSend(method, path, body, prefer){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: Object.assign(H(), { Prefer: prefer || "return=representation" }), body: body == null ? undefined : JSON.stringify(body) });
  if(!r.ok) throw new Error(`Supabase ${r.status}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

async function whoFrom(event){
  const hdr = k => String((event.headers || {})[k] || (event.headers || {})[k.toLowerCase()] || "");
  const tok = hdr("authorization").replace(/^Bearer\s+/i, "").trim();
  if(tok){
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${tok}` } });
    if(!ur.ok) return null;
    const u = await ur.json(); if(!u || !u.id) return null;
    const du = (await sbGet(`dealer_users?uid=eq.${enc(u.id)}&select=status,dealer_id`))[0];
    if(!du || du.status !== "approved" || !du.dealer_id) return null;
    return { dealer_id: du.dealer_id, uid: u.id, preview: false };
  }
  const t = hdr("x-hcps-preview").trim();
  if(!/^[0-9a-f]{48}$/.test(t)) return null;
  const r = (await sbGet(`dealer_preview_tokens?token=eq.${enc(t)}&select=dealer_id,expires_at`))[0];
  if(!r || !r.dealer_id || (r.expires_at && new Date(r.expires_at).getTime() < Date.now())) return null;
  return { dealer_id: r.dealer_id, uid: null, preview: true };
}
async function isTestDealership(dealerId){
  const d = (await sbGet(`dealers?id=eq.${enc(dealerId)}&select=id,parent_id,is_test`))[0];
  if(!d || d.is_test !== true) return false;
  if(!d.parent_id) return true;
  const p = (await sbGet(`dealers?id=eq.${enc(d.parent_id)}&select=is_test`))[0];
  return !!(p && p.is_test === true);
}

// The default for this sign-in: the saved one when it is still in the book and usable; otherwise none (a removed or no
// longer authorized default forces a new choice). Pre-select only when the destination is unambiguous.
function chooseDefault(entries, savedRef){
  const usable = entries.filter(e => e.usable);
  const hit = savedRef ? usable.find(e => e.ref === savedRef) : null;
  return { default_ref: hit ? hit.ref : null, default_stale: !!(savedRef && !hit), preselect: hit ? hit.ref : (!savedRef && usable.length === 1 ? usable[0].ref : null) };
}

exports.handler = async (event) => {
  if(event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  try{
    if(!SUPABASE_URL || !SERVICE_ROLE) return json(500, { ok:false, error:"server not configured" });
    if(event.httpMethod !== "POST") return json(405, { ok:false, error:"method not allowed" });
    let b; try{ b = JSON.parse(event.body || "{}"); }catch{ return json(400, { ok:false, error:"bad JSON" }); }
    if(!["list","save","remove","set_default"].includes(b.action)) return json(400, { ok:false, error:"unknown action" });

    let who; try{ who = await whoFrom(event); }catch(e){ return json(503, { ok:false, error:"sign-in could not be checked" }); }
    if(!who) return json(401, { ok:false, error:"unauthorized" });
    const f = await flags(sbGet);
    if(f.golden_p360_catalog !== true || f.golden_p360_account_gate !== true || f.golden_p360_hcps_shipto !== true) return json(200, { ok:true, enabled:false, reason:"switched_off" });
    if(who.preview && b.action !== "list") return json(403, { ok:false, error:"preview_not_allowed" });

    let a, includeTest;
    try{ a = await GA.accountFor(sbGet, who.dealer_id); includeTest = await isTestDealership(who.dealer_id); }
    catch(e){ return json(503, { ok:false, error:"account could not be read" }); }
    if(!a.ok) return json(200, { ok:true, enabled:false, reason: a.reason });
    const acct = a.acct;
    const load = async () => GA.book(sbGet, acct, { includeTest });
    const savedDefault = async () => who.uid ? ((await sbGet(`golden_ship_defaults?user_uid=eq.${enc(who.uid)}&account_no=eq.${enc(acct)}&select=ref`))[0] || {}).ref || null : null;

    if(b.action === "list"){
      let bk, d; try{ [bk, d] = await Promise.all([load(), savedDefault()]); }catch(e){ return json(503, { ok:false, error:"addresses could not be read" }); }
      return json(200, Object.assign({ ok:true, enabled:true, entries: bk.entries, locations: bk.locations, can_edit: !who.preview }, chooseDefault(bk.entries, d)));
    }

    if(b.action === "save"){
      const v = GA.validate(b.address);
      if(!v.ok) return json(400, { ok:false, error:"invalid", field: v.field });
      const now = new Date().toISOString();
      let row;
      try{
        if(b.ref != null){
          const m = /^gs:([0-9a-f-]{36})$/.exec(String(b.ref));
          if(!m) return json(400, { ok:false, error:"not_editable" });
          // Only a saved address of THIS account that is not removed — matched in the write itself.
          const r = await sbSend("PATCH", `golden_ship_addresses?id=eq.${enc(m[1])}&account_no=eq.${enc(acct)}&removed_at=is.null`,
            Object.assign({}, v.value, { updated_at: now, updated_by: who.uid }));
          row = Array.isArray(r) ? r[0] : null;
          if(!row) return json(404, { ok:false, error:"not_found" });
        } else {
          const live = await sbGet(`golden_ship_addresses?account_no=eq.${enc(acct)}&removed_at=is.null&select=id&limit=201`);
          if(live.length >= 200) return json(409, { ok:false, error:"too_many_addresses" });
          const r = await sbSend("POST", "golden_ship_addresses", Object.assign({}, v.value, { account_no: acct, created_by: who.uid, created_dealer: who.dealer_id, created_at: now, updated_at: now }));
          row = Array.isArray(r) ? r[0] : r;
        }
      }catch(e){ return json(503, { ok:false, error:"address could not be saved" }); }
      const ref = `gs:${row.id}`;
      if(b.make_default === true){
        try{ await sbSend("POST", "golden_ship_defaults?on_conflict=user_uid,account_no", { user_uid: who.uid, account_no: acct, ref, updated_at: now }, "resolution=merge-duplicates,return=minimal"); }
        catch(e){ return json(503, { ok:false, error:"default could not be saved", saved_ref: ref }); }
      }
      let bk; try{ bk = await load(); }catch(e){ return json(200, { ok:true, enabled:true, saved_ref: ref }); }
      return json(200, { ok:true, enabled:true, entry: bk.entries.find(x => x.ref === ref) || null, saved_ref: ref });
    }

    if(b.action === "remove"){
      const m = /^gs:([0-9a-f-]{36})$/.exec(String(b.ref || ""));
      if(!m) return json(400, { ok:false, error:"not_removable" });   // location addresses are managed in the Account Center
      try{
        const r = await sbSend("PATCH", `golden_ship_addresses?id=eq.${enc(m[1])}&account_no=eq.${enc(acct)}&removed_at=is.null`, { removed_at: new Date().toISOString(), removed_by: who.uid });
        if(!Array.isArray(r) || !r[0]) return json(404, { ok:false, error:"not_found" });
      }catch(e){ return json(503, { ok:false, error:"address could not be removed" }); }
      return json(200, { ok:true, enabled:true, removed:true });
    }

    // set_default
    const ref = String(b.ref || "");
    if(!GA.REF_RE.test(ref)) return json(400, { ok:false, error:"bad ref" });
    let bk; try{ bk = await load(); }catch(e){ return json(503, { ok:false, error:"addresses could not be read" }); }
    const e = bk.entries.find(x => x.ref === ref && x.usable);
    if(!e) return json(404, { ok:false, error:"not_found" });
    try{ await sbSend("POST", "golden_ship_defaults?on_conflict=user_uid,account_no", { user_uid: who.uid, account_no: acct, ref, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal"); }
    catch(e2){ return json(503, { ok:false, error:"default could not be saved" }); }
    return json(200, { ok:true, enabled:true, default_ref: ref });
  }catch(e){
    console.error("golden-addresses-api", e && e.message);
    return json(500, { ok:false, error:"internal" });
  }
};
exports._test = { chooseDefault };

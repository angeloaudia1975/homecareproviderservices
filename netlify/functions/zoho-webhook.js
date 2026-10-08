// HCPS ⇄ Zoho — INBOUND webhook receiver (Zoho CRM → Dealer 360).
// Zoho workflow rules call this endpoint the instant a Contact / Account / Deal changes.
// v1 is capture-safe: it authenticates the caller, records the event to zoho_sync_log and
// queues it in zoho_sync_queue (direction 'in', status 'pending'), and returns 200 fast — so
// you can wire and TEST webhooks in Zoho today and watch them land on the health dashboard.
// It does NOT yet auto-apply field changes; that step comes with the locked field-ownership
// map so inbound writes can never overwrite Dealer-360-owned data.
//
// Phase 2F-3 — credential and payload:
//  • The credential is the HTTP request header `x-hcps-secret`, checked against ZOHO_WEBHOOK_HEADER_SECRET.
//    That secret is accepted ONLY in the header — never in the URL or the body.
//  • ZOHO_WEBHOOK_SECRET is the retired secret. While it is still set in Netlify it is accepted the old way
//    (a `secret` / `x-hcps-secret` parameter), so the three Zoho webhooks can be moved over one at a time.
//    Deleting it from Netlify (and redeploying) ends the old way for good.
//  • Zoho may send its fields in the URL query, a form body (urlencoded or multipart), or JSON. They are
//    normalized at ONE boundary (normalize below) into module, record id, Modified_Time, Modified_By,
//    Account_Name and Email; everything is sanitized (_zoho_log.js redact) before it is stored or logged.
//  • Each receipt records HOW the event arrived (content type, which keys came in the query vs the body,
//    which way it authenticated) — names only, never values — so delivery problems can be diagnosed.
//    A rejected call that presented a credential, or looks like a Zoho event, is recorded the same way (at most
//    20 an hour) with the reason it was refused.

const crypto = require("crypto");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
// Phase 2F-1: the database answer is no longer ignored. {ok,status,body}: a refused write is visible
// to the caller, which records it as a failure row (see below) instead of dropping it.
async function sbSend(method,path,body,extra){ try{ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); const t=await r.text(); let j=null; try{ j=t?JSON.parse(t):null; }catch(e){ j={raw:t}; } return {ok:r.ok,status:r.status,body:j}; }catch(e){ return {ok:false,status:0,body:{message:String(e&&e.message||e)}}; } }
// Phase 2F-1 (security): nothing that looks like a credential is ever stored or logged (see _zoho_log.js).
const ZL = require("./_zoho_log.js");
const why = res => { const b=(res&&res.body)||{}; return [b.code, b.message||b.msg||b.error||(b.raw&&String(b.raw).slice(0,300))].filter(Boolean).join(": ")||("http "+((res&&res.status)||0)); };
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||500):null; };

// ---------- 2F-3: one normalization boundary ----------
const dec = s => { try{ return decodeURIComponent(String(s).replace(/\+/g," ")); }catch(e){ return String(s); } };
function parseUrlEncoded(s){ const o={}; for(const pair of String(s).split("&")){ if(!pair) continue; const i=pair.indexOf("="); const k=dec(i<0?pair:pair.slice(0,i)).trim(); if(k) o[k]=i<0?"":dec(pair.slice(i+1)); } return o; }
function parseMultipart(s, ct){
  const m=/boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct||""); if(!m) return {};
  const o={};
  for(const part of String(s).split("--"+(m[1]||m[2]))){
    const at=part.search(/\r?\n\r?\n/); if(at<0) continue;
    const head=part.slice(0,at), name=/\bname="([^"]*)"/i.exec(head);
    if(!name || /\bfilename=/i.test(head)) continue;
    o[name[1]]=part.slice(at).replace(/^\r?\n\r?\n/,"").replace(/\r?\n$/,"");
  }
  return o;
}
// JSON: top-level values; a lookup ({name,id}) becomes its name; a Zoho-style {data:[{…}]} is read too.
function flatJson(j){
  const o={}; const take=(src)=>{ for(const [k,v] of Object.entries(src||{})){ if(v==null) continue;
    if(typeof v!=="object") o[k]=String(v); else if(!Array.isArray(v) && (v.name!=null||v.id!=null)) o[k]=String(v.name!=null?v.name:v.id); } };
  take(j); const d=Array.isArray(j.data)?j.data[0]:(j.data&&typeof j.data==="object"?j.data:null); if(d) take(d);
  return o;
}
function parseBody(text, ct){
  if(!text) return {kind:"none", params:{}};
  const t=String(ct||"").toLowerCase();
  if(t.includes("json") || /^\s*\{/.test(text)){
    try{ const j=JSON.parse(text); if(j && typeof j==="object" && !Array.isArray(j)) return {kind:"json", params:flatJson(j)}; }catch(e){}
    if(t.includes("json")) return {kind:"json_unreadable", params:{}};
  }
  if(t.includes("multipart/form-data")) return {kind:"multipart", params:parseMultipart(text, ct)};
  if(/[=&]/.test(text)) return {kind:t.includes("x-www-form-urlencoded")?"form":"form_untyped", params:parseUrlEncoded(text)};
  return {kind:"unreadable", params:{}};
}
const keyOf = k => String(k||"").toLowerCase().replace(/[^a-z0-9$]/g,"");
const FIELDS = {
  module:["module","$module","modulename"],
  id:["id","recordid","entityid","zohoid"],
  modified_time:["modifiedtime"],
  modified_by:["modifiedby"],
  account:["accountname","account"],
  email:["email"],
};
// The module's own id key ("Deal Id" on a Deals event) is used only when no generic id came; another module's
// id (a Deal's "Account Id") is never taken as the record id.
const OWN_ID = { deals:"dealid", accounts:"accountid", contacts:"contactid" };
function pick(params){ const byKey={}; for(const [k,v] of Object.entries(params)) if(byKey[keyOf(k)]==null) byKey[keyOf(k)]=v;
  const has=k=>byKey[k]!=null && String(byKey[k]).trim()!=="";
  const out={}; for(const [f,keys] of Object.entries(FIELDS)) for(const k of keys){ if(has(k)){ out[f]=byKey[k]; break; } }
  if(out.id==null){ const own=OWN_ID[String(out.module||"").trim().toLowerCase()];
    if(own && has(own)) out.id=byKey[own];
    else if(!own){ const any=Object.values(OWN_ID).filter(has); if(any.length===1) out.id=byKey[any[0]]; } }
  return out; }
// Key NAMES only (never values). A long token-like name (a value sent as a bare key) is not kept.
const names = o => Object.keys(o||{}).slice(0,30).map(k=>{ k=String(k); return (k.length>40 || /^[A-Za-z0-9+\/=_.~-]{24,}$/.test(k)) ? "[long-key]" : k; });
// The ONE boundary: query + body (urlencoded / multipart / JSON, base64 or not) → params, and a description
// of how the call arrived (names only).
function normalize(event){
  const headers={}; for(const [k,v] of Object.entries(event.headers||{})) headers[String(k).toLowerCase()]=v;
  const ct=String(headers["content-type"]||"");
  let text=event.body||"";
  if(text && event.isBase64Encoded){ try{ text=Buffer.from(String(text),"base64").toString("utf8"); }catch(e){ text=""; } }
  const query=Object.assign({}, event.queryStringParameters||{});
  const body=parseBody(String(text||""), ct);
  const params=Object.assign({}, query, body.params);                 // a body value wins over the same query key
  const shape={ content_type: ct.split(";")[0].trim()||null, base64: !!event.isBase64Encoded, body: body.kind,
    query_keys: names(query), body_keys: names(body.params), hcps_header: !!headers["x-hcps-secret"] };
  return { headers, params, shape };
}
// ---------- 2F-3: authentication ----------
const same=(a,b)=>{ if(!a||!b) return false; const x=Buffer.from(String(a)), y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); };
function authenticate(headers, params){
  const NEW=process.env.ZOHO_WEBHOOK_HEADER_SECRET||"", OLD=process.env.ZOHO_WEBHOOK_SECRET||"";
  const header=String(headers["x-hcps-secret"]||"");
  let param=""; for(const [k,v] of Object.entries(params)){ const kk=keyOf(k); if(kk==="secret"||kk==="xhcpssecret"){ param=String(v||""); break; } }
  if(NEW && same(header,NEW)) return {ok:true, via:"header"};
  if(OLD && same(param,OLD)) return {ok:true, via:"legacy_param"};
  if(OLD && same(header,OLD)) return {ok:true, via:"legacy_header"};
  const presented = header&&param ? "header+param" : header ? "header" : param ? "param" : "none";
  const reason = presented==="none" ? "no credential"
    : (NEW && same(param,NEW)) ? "the current secret was sent as a parameter, not in the x-hcps-secret header"
    : (!NEW && !OLD) ? "no webhook secret is configured on the server"
    : "the credential did not match";
  return {ok:false, presented, reason};
}
// A rejected call is recorded (names only, never values), at most 20 an hour, when it presented a credential
// or looks like a Zoho event (it names a module or a record id) — so a misconfigured Zoho webhook is visible.
async function recordRejected(auth, n){
  if(auth.presented==="none"){ const g=pick(ZL.redact(n.params)); if(!g.module && !g.id) return; }
  try{
    const since=new Date(Date.now()-3600e3).toISOString();
    const r=await sbSend("GET",`zoho_sync_log?select=id&direction=eq.in&action=eq.auth&created_at=gte.${encodeURIComponent(since)}&limit=20`);
    if(r.ok && Array.isArray(r.body) && r.body.length>=20) return;
    const f=pick(ZL.redact(n.params));
    await ZL.writeLog([ZL.failRow({direction:"in",entity:(clean(f.module,40)||"webhook").toLowerCase(),entity_id:clean(f.id,60),action:"auth",phase:"webhook_auth",
      msg:"webhook call rejected (401): "+auth.reason, extra:{presented:auth.presented, shape:n.shape}})]);
  }catch(e){}
}

exports.handler = async (event)=>{
  try{
    // Zoho may probe with GET; answer OK so the endpoint validates.
    if(event.httpMethod==="GET") return json(200,{ok:true, service:"zoho-webhook", ready:true});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});

    const n=normalize(event);
    const auth=authenticate(n.headers, n.params);
    if(!auth.ok){ await recordRejected(auth, n); return json(401,{ok:false,error:"unauthorized"}); }   // no details leak

    // From here on only the cleaned copy is used: no credential reaches the log, the queue or a summary.
    const safe=ZL.redact(n.params);
    const f=pick(safe);
    const module=clean(f.module,40)||"Unknown";
    const recordId=clean(f.id,60);
    const email=clean(f.email,200);
    const account=clean(f.account,200);
    const summary=[module, recordId?("#"+recordId):"", account||email||""].filter(Boolean).join(" ").slice(0,300);

    // Best-effort dealer tag (for dashboard grouping) — resolve by contact email, else leave null.
    let dealer_id=null; const fails=[];
    if(email){ const r=await sbSend("GET",`dealer_contacts?email=eq.${encodeURIComponent(email.toLowerCase())}&select=dealer_id&limit=1`);
      if(r.ok && Array.isArray(r.body) && r.body[0]) dealer_id=r.body[0].dealer_id;
      else if(!r.ok) fails.push({phase:"webhook_dealer",action:"read",msg:"the dealer lookup for this event failed: "+why(r)}); }

    // Log it (history + dashboard counts): the summary plus what Zoho sent about the change and how it arrived.
    // Sanitized field by field (redact), THEN serialized — so the stored detail is always valid JSON.
    const detail=JSON.stringify(ZL.redact({ summary, modified_time:clean(f.modified_time,60), modified_by:clean(f.modified_by,120), accepted_via:auth.via, shape:n.shape }));
    const lg=await sbSend("POST","zoho_sync_log",{direction:"in",entity:module.toLowerCase(),entity_id:recordId,dealer_id,action:"webhook",result:"ok",detail,zoho_id:recordId},{Prefer:"return=minimal"});
    if(!lg.ok) console.error("zoho-webhook: receipt not logged:", ZL.scrubString(why(lg)));
    // The queue write is unchanged (repairing it is a later unit) — if it is refused, that is recorded as a
    // failure row with the database's reason, instead of being dropped.
    const qr=await sbSend("POST","zoho_sync_queue?on_conflict=direction,entity,entity_id",
      {direction:"in",entity:module.toLowerCase(),entity_id:recordId,dealer_id,op:"upsert",payload:safe,status:"pending",zoho_id:recordId,updated_at:new Date().toISOString()},
      {Prefer:"resolution=merge-duplicates,return=minimal"});
    if(!qr.ok) fails.push({phase:"webhook_queue",action:"queue",msg:"the event was received but not queued: "+why(qr),extra:{http:qr.status}});
    if(fails.length) await ZL.writeLog(fails.map(x=>ZL.failRow(Object.assign({direction:"in",entity:module.toLowerCase(),entity_id:recordId,dealer_id,zoho_id:recordId},x))));

    return json(200,{ok:true, received:summary});
  }catch(e){
    // Always 200 to avoid Zoho retry storms; the failure is logged best-effort.
    try{ await ZL.writeLog([ZL.failRow({direction:"in",entity:"webhook",action:"webhook",phase:"webhook",msg:String(e&&e.stack||e&&e.message||e)})]); }catch(_){}
    return json(200,{ok:false});
  }
};
// Exposed for the tests only.
exports._normalize = normalize; exports._pick = pick;

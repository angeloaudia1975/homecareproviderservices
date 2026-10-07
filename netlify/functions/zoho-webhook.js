// HCPS ⇄ Zoho — INBOUND webhook receiver (Zoho CRM → Dealer 360).
// Zoho workflow rules call this endpoint the instant a Contact / Account / Deal changes.
// v1 is capture-safe: it authenticates the caller, records the event to zoho_sync_log and
// queues it in zoho_sync_queue (direction 'in', status 'pending'), and returns 200 fast — so
// you can wire and TEST webhooks in Zoho today and watch them land on the health dashboard.
// It does NOT yet auto-apply field changes; that step comes with the locked field-ownership
// map so inbound writes can never overwrite Dealer-360-owned data.
//
// Setup: create a webhook in Zoho pointing here with ?secret=<ZOHO_WEBHOOK_SECRET>. Include a
// `module` parameter (Contacts/Accounts/Deals) and identifying fields (id, Email, Account Name).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SECRET = process.env.ZOHO_WEBHOOK_SECRET || "";
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
// Phase 2F-1: the database answer is no longer ignored. {ok,status,body}: a refused write is visible
// to the caller, which records it as a failure row (see below) instead of dropping it.
async function sbSend(method,path,body,extra){ try{ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); const t=await r.text(); let j=null; try{ j=t?JSON.parse(t):null; }catch(e){ j={raw:t}; } return {ok:r.ok,status:r.status,body:j}; }catch(e){ return {ok:false,status:0,body:{message:String(e&&e.message||e)}}; } }
// Phase 2F-1 (security): nothing that looks like a credential is ever stored or logged — the
// ?secret= used to authenticate the call, any secret/token/auth-named field, and any value that
// contains one of this deployment's secrets (see _zoho_log.js).
const ZL = require("./_zoho_log.js");
const why = res => { const b=(res&&res.body)||{}; return [b.code, b.message||b.msg||b.error||(b.raw&&String(b.raw).slice(0,300))].filter(Boolean).join(": ")||("http "+((res&&res.status)||0)); };
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||500):null; };

function parseParams(event){
  const q=event.queryStringParameters||{};
  const ct=String((event.headers&&(event.headers["content-type"]||event.headers["Content-Type"]))||"").toLowerCase();
  let bodyParams={};
  const raw=event.body||"";
  if(raw){
    if(ct.includes("application/json")){ try{ bodyParams=JSON.parse(raw); }catch(e){} }
    else { // x-www-form-urlencoded (Zoho's default for webhooks)
      try{ for(const pair of raw.split("&")){ const i=pair.indexOf("="); if(i<0) continue; const k=decodeURIComponent(pair.slice(0,i).replace(/\+/g," ")); const v=decodeURIComponent(pair.slice(i+1).replace(/\+/g," ")); bodyParams[k]=v; } }catch(e){}
    }
  }
  return { ...q, ...bodyParams };
}

exports.handler = async (event)=>{
  try{
    // Zoho may probe with GET; answer OK so the endpoint validates.
    if(event.httpMethod==="GET") return json(200,{ok:true, service:"zoho-webhook", ready:true});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});

    const p=parseParams(event);
    const secret=p.secret || p["x-hcps-secret"] || p["X-HCPS-Secret"] || (event.headers&&(event.headers["x-hcps-secret"]||event.headers["X-HCPS-Secret"])) || "";
    if(!SECRET || secret!==SECRET){ // reject unauthenticated callers, but don't leak details
      return json(401,{ok:false,error:"unauthorized"});
    }

    // From here on only the cleaned copy is used: the secret never reaches the log, the queue or a summary.
    const safe=ZL.redact(p);
    const module=clean(safe.module||safe.Module||safe.$module||safe.moduleName,40)||"Unknown";
    const recordId=clean(safe.id||safe.recordId||safe.entity_id||safe.Id||safe.ID,60);
    const email=clean(safe.Email||safe.email,200);
    const account=clean(safe["Account Name"]||safe.Account_Name||safe.account_name||safe.Account||safe.accountName,200);
    const summary=[module, recordId?("#"+recordId):"", account||email||""].filter(Boolean).join(" ").slice(0,300);

    // Best-effort dealer tag (for dashboard grouping) — resolve by contact email, else leave null.
    let dealer_id=null; const fails=[];
    if(email){ const r=await sbSend("GET",`dealer_contacts?email=eq.${encodeURIComponent(email.toLowerCase())}&select=dealer_id&limit=1`);
      if(r.ok && Array.isArray(r.body) && r.body[0]) dealer_id=r.body[0].dealer_id;
      else if(!r.ok) fails.push({phase:"webhook_dealer",action:"read",msg:"the dealer lookup for this event failed: "+why(r)}); }

    // Log it (history + dashboard counts) and queue it for later, ownership-safe application.
    const lg=await sbSend("POST","zoho_sync_log",{direction:"in",entity:module.toLowerCase(),entity_id:recordId,dealer_id,action:"webhook",result:"ok",detail:summary,zoho_id:recordId},{Prefer:"return=minimal"});
    if(!lg.ok) console.error("zoho-webhook: receipt not logged:", ZL.scrubString(why(lg)));
    // The queue write is unchanged (Phase 2F-1 is observability only) — but if it is refused, that is now
    // recorded as a failure row with the database's reason, instead of being dropped.
    const qr=await sbSend("POST","zoho_sync_queue?on_conflict=direction,entity,entity_id",
      {direction:"in",entity:module.toLowerCase(),entity_id:recordId,dealer_id,op:"upsert",payload:safe,status:"pending",zoho_id:recordId,updated_at:new Date().toISOString()},
      {Prefer:"resolution=merge-duplicates,return=minimal"});
    if(!qr.ok) fails.push({phase:"webhook_queue",action:"queue",msg:"the event was received but not queued: "+why(qr),extra:{http:qr.status}});
    if(fails.length) await ZL.writeLog(fails.map(f=>ZL.failRow(Object.assign({direction:"in",entity:module.toLowerCase(),entity_id:recordId,dealer_id,zoho_id:recordId},f))));

    return json(200,{ok:true, received:summary});
  }catch(e){
    // Always 200 to avoid Zoho retry storms; the failure is logged best-effort.
    try{ await ZL.writeLog([ZL.failRow({direction:"in",entity:"webhook",action:"webhook",phase:"webhook",msg:String(e&&e.stack||e&&e.message||e)})]); }catch(_){}
    return json(200,{ok:false});
  }
};

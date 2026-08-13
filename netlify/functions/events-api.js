// HCPS intent capture — the ordering portal posts per-dealer behavior here.
// The point weight for each event is assigned SERVER-SIDE from automation_config
// so the client can never inflate its own intent. Only signed-in dealers are
// logged (we resolve dealer_id from the caller's Supabase JWT); anonymous hits
// are accepted and ignored so the portal never has to branch on auth state.
//
//   POST { action:"track", events:[{ type, manufacturer?, product?, meta? }] }
//        + Authorization: Bearer <dealer JWT>
//   -> { ok:true, logged:N }
//
// Allowed types: login | product_view | product_view_repeat | pricing_view |
//                order_page | order_started | email_open | email_click
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const CORS={
  "access-control-allow-origin":"*",
  "access-control-allow-methods":"POST, OPTIONS",
  "access-control-allow-headers":"content-type, authorization",
};
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null;
}
const { ALLOWED_EVENTS, weightFor, getConfig } = require("./_intent.js");
const P = require("./_platform.js");

// Resolve the signed-in dealer from their Supabase JWT (same shape dealer-auth uses).
async function callerFromToken(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,""); if(!tok) return null;
  const ur=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
  if(!ur.ok) return null; const u=await ur.json();
  const rows=await sb("GET",`dealer_users?uid=eq.${u.id}&select=status,dealer_id`).catch(()=>[]);
  const du=rows&&rows[0];
  if(!du||!du.dealer_id) return null;
  if(du.status!=="approved") return null;   // only score real, approved dealers
  return { uid:u.id, dealer_id:du.dealer_id };
}
const clip=(s,n)=>{ s=String(s==null?"":s).trim(); return s?s.slice(0,n):null; };

exports.handler=async(event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"method not allowed"});
    let b; try{ b=JSON.parse(event.body||"{}"); }catch{ return json(400,{error:"bad JSON"}); }
    if(b.action!=="track") return json(400,{error:"unknown action"});

    // Not signed in → accept silently so the portal fires-and-forgets without branching.
    const c=await callerFromToken(event);
    if(!c) return json(200,{ok:true,logged:0});

    // Accept one event or a small batch.
    const list=Array.isArray(b.events)?b.events : (b.event?[b.event] : (b.type?[{type:b.type,manufacturer:b.manufacturer,product:b.product,meta:b.meta}] : []));
    if(!list.length) return json(200,{ok:true,logged:0});
    const cfg=await getConfig();
    // Stamp the operating env so test/dev activity never contaminates production
    // intelligence: 'test' for flagged accounts, otherwise the current platform mode.
    const st=await P.getState();
    let isTest=false; try{ const d=await sb("GET",`dealers?id=eq.${encodeURIComponent(c.dealer_id)}&select=is_test`); isTest=!!(d&&d[0]&&d[0].is_test); }catch(e){}
    const env=P.envFor(st.mode,isTest);
    const nowIso=new Date().toISOString();
    const rows=[]; const svc=[];
    for(const e of list.slice(0,25)){    // hard cap per call — no floods
      const type=String(e&&e.type||"").trim();
      // Dealer-Services partner interest (CardChamp etc.) — kept OUT of intent_events so it
      // never pollutes manufacturer intent, and stored per-dealer for partner reporting.
      if(type.indexOf("service_")===0){
        const service=clip((e.meta&&e.meta.service)||type.replace(/^service_/,"").replace(/_click$/,""),40)||"cardchamp";
        svc.push({ service, dealer_id:c.dealer_id, event_type:type,
          source:clip(e.source,20)||"ordering", surface:clip(e.meta&&(e.meta.Surface||e.meta.surface),60),
          env, meta:(e.meta&&typeof e.meta==="object")?e.meta:{}, occurred_at:nowIso });
        continue;
      }
      if(!ALLOWED_EVENTS.includes(type)) continue;
      rows.push({
        dealer_id:c.dealer_id,
        manufacturer:clip(e.manufacturer||e.slug,60),
        product_code:clip(e.product||e.product_code||e.code,60),
        event_type:type,
        weight:weightFor(type,cfg),        // server-side; client value ignored
        source:clip(e.source,20)||"ordering",
        env,
        meta:(e.meta&&typeof e.meta==="object")?e.meta:{},
        occurred_at:nowIso
      });
    }
    if(svc.length){ try{ await sb("POST","partner_activity",svc,{Prefer:"return=minimal"}); }catch(e){/* table may not exist yet */} }
    if(!rows.length) return json(200,{ok:true,logged:svc.length});
    try{ await sb("POST","intent_events",rows,{Prefer:"return=minimal"}); }
    catch(e){ return json(200,{ok:false,logged:svc.length,error:"log failed"}); }
    return json(200,{ok:true,logged:rows.length+svc.length});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

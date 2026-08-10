// HCPS campaign click tracker + safe redirect.
// Campaign CTA links point here so a dealer's click on a prospecting/reorder email
// flows straight back into intent_events (event_type email_click). We then 302 to the
// real destination. This is what lets "a prospecting campaign hand a warm lead to a rep":
// the click raises the dealer's intent score, and the nightly/hourly intent engine does
// the rest.
//
//   GET /.netlify/functions/click?d=<dealer_id>&m=<manufacturer_slug>&c=<campaign_id>&u=<encoded target URL>
//
// - d is a dealer UUID merged per-recipient by the ESP (falls back to an anonymous click
//   if it isn't merged — the redirect still works, we just can't score it).
// - u is validated against an allowlist of HCPS hosts so this can never be an open redirect.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const ORDERING=process.env.ORDERING_BASE||"https://hcpsonlineordering.netlify.app";
const SITE=process.env.SITE_BASE||"https://homecareproviderservices.netlify.app";
const P=require("./_platform.js");
const { getConfig, weightFor } = require("./_intent.js");
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`,"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null;
}
// Only ever redirect to our own portal or marketing site.
function safeTarget(u){
  try{ const dec=decodeURIComponent(u||""); if(!dec) return null;
    const url=new URL(dec); const allow=[new URL(ORDERING).host,new URL(SITE).host];
    return allow.includes(url.host) ? url.toString() : null;
  }catch(e){ return null; }
}
function redirect(to){ return {statusCode:302,headers:{Location:to,"cache-control":"no-store"},body:""}; }

exports.handler=async(event)=>{
  const q=(event && event.queryStringParameters) || {};
  const target=safeTarget(q.u) || ORDERING;              // default to the portal home if u is missing/foreign
  // Log the click as intent — best-effort; a logging hiccup never blocks the redirect.
  try{
    const d=String(q.d||"").trim();
    if(SUPABASE_URL && SERVICE_ROLE && UUID_RE.test(d)){
      const cfg=await getConfig();
      const st=await P.getState();
      let isTest=false; try{ const dl=await sb("GET",`dealers?id=eq.${encodeURIComponent(d)}&select=is_test`); isTest=!!(dl&&dl[0]&&dl[0].is_test); }catch(e){}
      const env=P.envFor(st.mode,isTest);
      await sb("POST","intent_events",[{
        dealer_id:d,
        manufacturer:(q.m?String(q.m).slice(0,60):null),
        product_code:null,
        event_type:"email_click",
        weight:weightFor("email_click",cfg),
        source:"campaign",
        env,
        meta:{campaign_id:(q.c?String(q.c).slice(0,60):null),via:"click"},
        occurred_at:new Date().toISOString()
      }],{Prefer:"return=minimal"});
    }
  }catch(e){/* swallow — redirect regardless */}
  return redirect(target);
};

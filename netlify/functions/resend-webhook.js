// HCPS — Resend engagement webhook. Closes the loop: when a dealer OPENS or
// CLICKS an automated email, that engagement flows back into the intent score
// (email_open +1, email_click +4, weights from config). Recipient is mapped to
// a dealer via the email_sends ledger the engine already writes on every send.
//
// SETUP (one-time):
//   1. Set RESEND_WEBHOOK_SECRET in Netlify (the "whsec_..." signing secret Resend
//      shows when you create the webhook).
//   2. In Resend → Webhooks, add an endpoint pointing at:
//        https://homecareproviderservices.org/.netlify/functions/resend-webhook
//      subscribed to  email.opened  and  email.clicked.
// Requests are rejected unless the Svix signature verifies, so the endpoint is
// not an open ingress.
const crypto=require("crypto");
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sb(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null; }
const { getConfig, weightFor } = require("./_intent.js");
const ok=o=>({statusCode:200,headers:{"content-type":"application/json"},body:JSON.stringify(o)});

// Svix signature check (Resend signs webhooks with Svix). Verifies HMAC-SHA256 of
// "<id>.<timestamp>.<body>" against the whsec_ secret, constant-time.
function verifySvix(secret,id,ts,sigHeader,body){
  if(!secret||!id||!ts||!sigHeader) return false;
  try{
    const key=Buffer.from(String(secret).replace(/^whsec_/,""),"base64");
    const expected=crypto.createHmac("sha256",key).update(`${id}.${ts}.${body}`).digest("base64");
    const exp=Buffer.from(expected);
    return String(sigHeader).split(" ").some(part=>{
      const s=part.split(",")[1]; if(!s) return false;
      const b=Buffer.from(s);
      return b.length===exp.length && crypto.timingSafeEqual(b,exp);
    });
  }catch(e){ return false; }
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=="POST") return {statusCode:405,body:"POST only"};
    if(!SUPABASE_URL||!SERVICE_ROLE) return {statusCode:500,body:"Supabase env not set"};
    const secret=process.env.RESEND_WEBHOOK_SECRET;
    if(!secret) return {statusCode:401,body:"webhook secret not configured"};
    const hdr=k=>event.headers[k]||event.headers[k.toLowerCase()]||"";
    const body=event.body||"";
    if(!verifySvix(secret,hdr("svix-id"),hdr("svix-timestamp"),hdr("svix-signature"),body)) return {statusCode:401,body:"bad signature"};
    let ev; try{ ev=JSON.parse(body); }catch{ return {statusCode:400,body:"bad json"}; }

    const TYPE={ "email.opened":"email_open", "email.clicked":"email_click" };
    const type=TYPE[ev&&ev.type];
    if(!type) return ok({ignored:(ev&&ev.type)||"unknown"});   // delivered/bounced/etc — not scored here
    const data=ev.data||{};
    const to=(Array.isArray(data.to)?data.to[0]:data.to)||data.email||"";
    const addr=String(to).trim().toLowerCase();
    if(!addr) return ok({ignored:"no recipient"});

    // recipient -> most recent send -> dealer
    const sends=await sbGet(`email_sends?contact_email=ilike.${encodeURIComponent(addr)}&order=sent_at.desc&limit=1&select=dealer_id`).catch(()=>[]);
    const dealer_id=sends&&sends[0]&&sends[0].dealer_id;
    if(!dealer_id) return ok({ignored:"no dealer match"});

    // dedupe: count each send's open/click once
    const emailId=data.email_id||data.id||null;
    if(emailId){
      const dup=await sbGet(`intent_events?event_type=eq.${type}&meta->>email_id=eq.${encodeURIComponent(emailId)}&select=id&limit=1`).catch(()=>[]);
      if(dup&&dup[0]) return ok({dedup:true});
    }
    const cfg=await getConfig();
    const row={dealer_id,event_type:type,weight:weightFor(type,cfg),source:"email",
      meta:{email_id:emailId,link:(data.click&&data.click.link)||null},occurred_at:new Date().toISOString()};
    try{ await sb("POST","intent_events",row,{Prefer:"return=minimal"}); }catch(e){ return ok({error:"log failed"}); }
    return ok({logged:type,dealer_id});
  }catch(e){ return {statusCode:500,body:String(e&&e.message||e)}; }
};

// HCPS ordering portal — dealer login backend (email + password, self-serve + approval).
//   POST {action:"register", email, password}  -> create account (pending) if email is on file
//   POST {action:"me"}  + Authorization: Bearer <jwt>  -> {status, dealer, lines} for signed-in dealer
// Login itself (email+password -> JWT) is done client-side against Supabase Auth with the anon key;
// this function never sees a password except at registration. Service-role, server-side only.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,
    headers:{...H(),"content-type":"application/json",...(extra||{})},
    body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); const j=t?JSON.parse(t):null;
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return j;
}
const rpc=(fn,args)=>sb("POST",`rpc/${fn}`,args);
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const { computeAccess } = require("./_access.js");

// ---- Email via Resend (same service the ordering portal uses for order emails) ----
// Requires RESEND_API_KEY in this site's Netlify env (the homecareproviderservices.us domain
// is already verified in Resend, so the same key works here). If it's not set, we skip the
// send silently so registration/approval never break.
const MAIL_FROM = process.env.HCPS_MAIL_FROM || "HCPS Partner Portal <orders@homecareproviderservices.us>";
const REGISTER_NOTIFY_TO = process.env.REGISTER_NOTIFY_TO || "angelo@homecareproviderservices.us";
const PORTAL_URL = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const ADMIN_LOGINS_URL = "https://homecareproviderservices.netlify.app/admin/dealers.html#logins";
async function sendMail({to,subject,html,text,replyTo}){
  const apiKey=process.env.RESEND_API_KEY;
  if(!apiKey){ console.error("RESEND_API_KEY not set — skipping email:",subject); return {ok:false,skipped:true}; }
  const toList=(Array.isArray(to)?to:String(to||"").split(",")).map(s=>String(s).trim()).filter(Boolean);
  if(!toList.length) return {ok:false,skipped:true};
  const payload={from:MAIL_FROM,to:toList,subject,html,text};
  if(replyTo&&EMAIL_RE.test(String(replyTo))) payload.reply_to=replyTo;
  try{
    const res=await fetch("https://api.resend.com/emails",{method:"POST",
      headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(!res.ok){ console.error("Resend error",res.status,await res.text().catch(()=>"")); return {ok:false}; }
    return {ok:true};
  }catch(e){ console.error("Resend send failed",e&&e.message); return {ok:false}; }
}
const esc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
// Same normalized key the map's geocoder uses, to look up a dealer's latitude
// (needed for Strongback's "south of Indianapolis" territory rule).
function qkey(a){
  const parts=[a.address,a.city,[a.state,a.zip].filter(Boolean).join(" ")].map(x=>String(x||"").trim()).filter(Boolean);
  return parts.join(", ").toLowerCase().replace(/\s+/g," ").trim();
}

// Verify the caller's Supabase JWT and resolve their dealer login. Returns null if not signed in.
async function callerFromToken(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,""); if(!tok) return null;
  const ur=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
  if(!ur.ok) return null; const u=await ur.json();
  const rows=await sb("GET",`dealer_users?uid=eq.${u.id}&select=status,dealer_id,email`).catch(()=>[]);
  const du=rows&&rows[0];
  return {uid:u.id, email:(du&&du.email)||u.email, dealer_id:(du&&du.dealer_id)||null, status:(du&&du.status)||"none"};
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"method not allowed"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    if(b.action==="register"){
      const email=String(b.email||"").trim().toLowerCase(), password=String(b.password||"");
      const company=String(b.company||"").trim();
      if(!EMAIL_RE.test(email)) return json(200,{ok:false,code:"bad_email",message:"Enter a valid email address."});
      if(password.length<8) return json(200,{ok:false,code:"weak",message:"Password must be at least 8 characters."});
      if(!company) return json(200,{ok:false,code:"no_company",message:"Enter your company / business name so HCPS can match your account."});
      // Open registration: anyone may register. If the email is already on file we auto-link
      // the dealer; otherwise it stays unlinked for HCPS to assign on approval.
      let dealer_id=null;
      try{ dealer_id = await rpc("dealer_by_email",{p_email:email}); }catch(e){ dealer_id=null; }
      // create the Supabase auth user
      const r=await fetch(`${SUPABASE_URL}/auth/v1/admin/users`,{method:"POST",
        headers:{...H(),"content-type":"application/json"},
        body:JSON.stringify({email,password,email_confirm:true})});
      const au=await r.json().catch(()=>({}));
      if(!r.ok){
        const msg=String(au.msg||au.message||"").toLowerCase();
        if(r.status===422||r.status===409||msg.includes("already")) return json(200,{ok:false,code:"exists",message:"An account already exists for that email. Try signing in or resetting your password."});
        return json(500,{error:`auth ${r.status}: ${JSON.stringify(au)}`});
      }
      const uid=au.id||au.user?.id;
      const row={uid,email,dealer_id,status:"pending",
        req_company:company||null, req_contact:String(b.contact||"").trim()||null, req_phone:String(b.phone||"").trim()||null,
        req_address:String(b.address||"").trim()||null, req_city:String(b.city||"").trim()||null,
        req_state:String(b.state||"").trim()||null, req_zip:String(b.zip||"").trim()||null};
      await sb("POST","dealer_users",row,{Prefer:"resolution=merge-duplicates,return=minimal"});
      // Notify HCPS that a new dealer registered so they can review + set up the account.
      try{
        const loc=[String(b.city||"").trim(),String(b.state||"").trim()].filter(Boolean).join(", ");
        const rowsHtml=[["Company",company],["Contact",String(b.contact||"").trim()],["Email",email],
          ["Phone",String(b.phone||"").trim()],["Address",String(b.address||"").trim()],["City / State",loc],
          ["ZIP",String(b.zip||"").trim()],["Matched to a dealer on file?",dealer_id?"Yes — auto-linked":"No — needs assignment"]]
          .filter(([,v])=>v).map(([k,v])=>`<tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px">${esc(k)}</td><td style="padding:4px 0;font-weight:600;font-size:13px">${esc(v)}</td></tr>`).join("");
        await sendMail({
          to:REGISTER_NOTIFY_TO, replyTo:email,
          subject:`New dealer registration — ${company}`,
          html:`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
            <h2 style="color:#2B4071;margin:0 0 4px">New dealer registration</h2>
            <p style="color:#5b6672;font-size:13px;margin:0 0 12px">Someone just registered for the HCPS Partner Portal and is waiting for review.</p>
            <table style="border-collapse:collapse;margin:0 0 16px">${rowsHtml}</table>
            <a href="${ADMIN_LOGINS_URL}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px;font-size:14px">Review &amp; set up in Dealer Manager →</a>
            <p style="color:#9aa4ae;font-size:11px;margin:16px 0 0">HCPS Partner Portal (beta) · they stay locked out until you approve them.</p></div>`,
          text:`New dealer registration — ${company}\nContact: ${b.contact||""}\nEmail: ${email}\nPhone: ${b.phone||""}\nLocation: ${loc}\nMatched on file: ${dealer_id?"yes":"no"}\n\nReview: ${ADMIN_LOGINS_URL}`
        });
      }catch(e){ console.error("register notify failed",e&&e.message); }
      const message = dealer_id
        ? "Registration received — we matched your email to an HCPS account. It’s pending approval; you’ll be able to order once approved."
        : "Registration received — your request is pending HCPS review. HCPS will link it to your dealer account and approve you.";
      return json(200,{ok:true,status:"pending",matched:!!dealer_id,message});
    }

    if(b.action==="me"){
      const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
      const tok=auth.replace(/^Bearer\s+/i,"");
      if(!tok) return json(200,{ok:true,status:"anon"});
      // verify the caller's JWT and get their uid/email
      const ur=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(!ur.ok) return json(200,{ok:true,status:"anon"});
      const u=await ur.json(); const uid=u.id;
      const rows=await sb("GET",`dealer_users?uid=eq.${uid}&select=status,dealer_id,email`);
      const du=rows&&rows[0];
      if(!du) return json(200,{ok:true,status:"none",email:u.email});
      if(du.status!=="approved") return json(200,{ok:true,status:du.status,email:du.email});
      // approved -> return dealer profile + entitled lines for gating + cart prefill
      let dealer=null, lines=[], access=null, prices={};
      if(du.dealer_id){
        const d=await sb("GET",`dealers?id=eq.${du.dealer_id}&select=id,business_name,hcps_account,contact_name,email,phone,address,city,state,zip,parent_id,golden_status,ovation_access,golden_url`);
        dealer=d&&d[0]?{id:d[0].id,name:d[0].business_name,hcps_account:d[0].hcps_account||"",contact_name:d[0].contact_name||"",
          email:d[0].email||du.email,phone:d[0].phone||"",address:d[0].address||"",city:d[0].city||"",state:d[0].state||"",zip:d[0].zip||""}:null;
        const dm=await sb("GET",`dealer_manufacturers?dealer_id=eq.${du.dealer_id}&active=eq.true&select=manufacturer,account_ref`);
        lines=(dm||[]).map(x=>({slug:x.manufacturer,account:x.account_ref||""}));
        // company-level access decision (a branch inherits its HQ's territory)
        try{
          const self=d[0];
          let gov=self;
          if(self.parent_id){ const p=await sb("GET",`dealers?id=eq.${self.parent_id}&select=business_name,address,city,state,zip`); if(p&&p[0]) gov=p[0]; }
          let lat=null;
          try{ const q=qkey(gov); if(q){ const gc=await sb("GET",`geocache?q=eq.${encodeURIComponent(q)}&ok=eq.true&select=lat&limit=1`); if(gc&&gc[0]) lat=gc[0].lat; } }catch(e){}
          access=computeAccess(
            {state:gov.state||self.state, business_name:gov.business_name||self.business_name, lat,
             golden_status:self.golden_status||"None", ovation_access:!!self.ovation_access},
            // "Your accounts" = lines the dealer actually has an account NUMBER for; lines that
            // are merely granted in the admin grid (no account_ref) show as "Available to you".
            (dm||[]).filter(x=>x.account_ref&&String(x.account_ref).trim()).map(x=>x.manufacturer));
          if(access) access.golden_url = self.golden_url || "";   // this dealer's specific Golden portal path
        }catch(e){}
        // Per-product contract prices (company-level): the governing/master account's prices
        // apply to all its branches; a branch's own rows override. Keyed "slug::code" for the
        // portal's unitPrice(). Read with service_role (table has no public RLS policy).
        try{
          const rec=d&&d[0]; const ids=[du.dealer_id]; if(rec&&rec.parent_id) ids.push(rec.parent_id);
          const pr=await sb("GET",`dealer_contract_prices?dealer_id=in.(${ids.join(",")})&active=eq.true&select=dealer_id,manufacturer,code,price`).catch(()=>[]);
          // apply the master's rows first, then the dealer's own so branch overrides win
          (pr||[]).sort((a,b)=>(a.dealer_id===du.dealer_id?1:0)-(b.dealer_id===du.dealer_id?1:0));
          for(const r of (pr||[])){ if(r.manufacturer&&r.code&&r.price!=null) prices[`${r.manufacturer}::${r.code}`]=Number(r.price); }
        }catch(e){}
        // attach stored shipping / billing addresses (if any) so the "My account" editor can prefill
        if(dealer){
          try{
            const addrs=await sb("GET",`dealer_addresses?dealer_id=eq.${du.dealer_id}&select=address,city,state,zip,label,pri`).catch(()=>[]);
            const pick=re=>{const a=(addrs||[]).find(x=>re.test(String(x.label||"")));return a?{address:a.address||"",city:a.city||"",state:a.state||"",zip:a.zip||""}:null;};
            dealer.shipping=pick(/ship/i)||{address:dealer.address,city:dealer.city,state:dealer.state,zip:dealer.zip};
            dealer.billing=pick(/bill/i)||null;
            // full list of locations on file so the cart can offer a "ship to" picker
            dealer.addresses=(addrs||[]).sort((a,b)=>(b.pri||1)-(a.pri||1))
              .map(a=>({address:a.address||"",city:a.city||"",state:a.state||"",zip:a.zip||"",label:a.label||""}))
              .filter(a=>a.address||a.city);
          }catch(e){}
        }
      }
      // saved cart (persists across logout/login until ordered or cleared)
      let cart=null;
      try{ const cr=await sb("GET",`dealer_carts?uid=eq.${uid}&select=cart`); if(cr&&cr[0]&&cr[0].cart&&Array.isArray(cr[0].cart.items)&&cr[0].cart.items.length) cart=cr[0].cart; }catch(e){}
      return json(200,{ok:true,status:"approved",email:du.email,dealer,lines,access,cart,prices});
    }

    // ---- persistent cart ----
    if(b.action==="save_cart"){
      const c=await callerFromToken(event); if(!c) return json(401,{ok:false,error:"not signed in"});
      const cart=(b.cart&&typeof b.cart==="object")?b.cart:{items:[]};
      if(!Array.isArray(cart.items)) cart.items=[];
      await sb("POST","dealer_carts?on_conflict=uid",
        {uid:c.uid,dealer_id:c.dealer_id,email:c.email,cart,updated_at:new Date().toISOString()},
        {Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true});
    }
    if(b.action==="clear_cart"){
      const c=await callerFromToken(event); if(!c) return json(401,{ok:false,error:"not signed in"});
      await sb("DELETE",`dealer_carts?uid=eq.${c.uid}`,null,{Prefer:"return=minimal"}).catch(()=>{});
      return json(200,{ok:true});
    }

    // ---- login activity ----
    if(b.action==="session_start"){
      const c=await callerFromToken(event); if(!c) return json(401,{ok:false,error:"not signed in"});
      const ins=await sb("POST","dealer_sessions",
        {uid:c.uid,dealer_id:c.dealer_id,email:c.email,login_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),user_agent:String(b.ua||"").slice(0,300)||null},
        {Prefer:"return=representation"});
      return json(200,{ok:true,session_id:(ins&&ins[0]&&ins[0].id)||null});
    }
    if(b.action==="session_ping"){
      const c=await callerFromToken(event); if(!c) return json(401,{ok:false,error:"not signed in"});
      if(b.session_id) await sb("PATCH",`dealer_sessions?id=eq.${encodeURIComponent(b.session_id)}&uid=eq.${c.uid}`,{last_seen_at:new Date().toISOString()},{Prefer:"return=minimal"}).catch(()=>{});
      return json(200,{ok:true});
    }

    // A signed-in dealer requests changes to their own account. We DON'T touch the
    // dealer record — we queue the request for HCPS to approve in the admin.
    if(b.action==="request_profile_change"){
      const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
      const tok=auth.replace(/^Bearer\s+/i,"");
      if(!tok) return json(401,{ok:false,error:"not signed in"});
      const ur=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(!ur.ok) return json(401,{ok:false,error:"session expired — sign in again"});
      const u=await ur.json(); const uid=u.id;
      const rows=await sb("GET",`dealer_users?uid=eq.${uid}&select=status,dealer_id,email`);
      const du=rows&&rows[0];
      if(!du||du.status!=="approved") return json(200,{ok:false,message:"Your account isn't active yet."});
      const c=b.changes||{};
      const S=v=>{v=String(v==null?"":v).trim();return v.slice(0,200);};
      const changes={};
      ["contact_name","phone"].forEach(k=>{ if(c[k]!=null) changes[k]=S(c[k]); });
      if(c.email!=null){ const e=S(c.email).toLowerCase(); if(e&&!EMAIL_RE.test(e)) return json(200,{ok:false,message:"Enter a valid email address."}); changes.email=e; }
      const addr=(pfx)=>{ const o={}; ["address","city","state","zip"].forEach(k=>{ if(c[pfx+"_"+k]!=null) o[k]=S(c[pfx+"_"+k]); }); return Object.keys(o).length?o:null; };
      const ship=addr("ship"), bill=addr("bill");
      if(ship) changes.shipping=ship;
      if(bill) changes.billing=bill;
      if(!Object.keys(changes).length) return json(200,{ok:false,message:"No changes to submit."});
      await sb("POST","dealer_change_requests",{
        dealer_id:du.dealer_id||null, uid, email:du.email, changes, status:"pending",
        created_at:new Date().toISOString()
      },{Prefer:"return=minimal"});
      return json(200,{ok:true,message:"Thanks — your changes were sent to HCPS for approval. They'll take effect once approved."});
    }

    return json(400,{error:"unknown action"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};

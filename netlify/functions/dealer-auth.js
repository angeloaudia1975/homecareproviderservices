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
      let dealer=null, lines=[];
      if(du.dealer_id){
        const d=await sb("GET",`dealers?id=eq.${du.dealer_id}&select=id,business_name,hcps_account,contact_name,email,phone,address,city,state,zip`);
        dealer=d&&d[0]?{id:d[0].id,name:d[0].business_name,hcps_account:d[0].hcps_account||"",contact_name:d[0].contact_name||"",
          email:d[0].email||du.email,phone:d[0].phone||"",address:d[0].address||"",city:d[0].city||"",state:d[0].state||"",zip:d[0].zip||""}:null;
        const dm=await sb("GET",`dealer_manufacturers?dealer_id=eq.${du.dealer_id}&active=eq.true&select=manufacturer,account_ref`);
        lines=(dm||[]).map(x=>({slug:x.manufacturer,account:x.account_ref||""}));
        // attach stored shipping / billing addresses (if any) so the "My account" editor can prefill
        if(dealer){
          try{
            const addrs=await sb("GET",`dealer_addresses?dealer_id=eq.${du.dealer_id}&select=address,city,state,zip,label`).catch(()=>[]);
            const pick=re=>{const a=(addrs||[]).find(x=>re.test(String(x.label||"")));return a?{address:a.address||"",city:a.city||"",state:a.state||"",zip:a.zip||""}:null;};
            dealer.shipping=pick(/ship/i)||{address:dealer.address,city:dealer.city,state:dealer.state,zip:dealer.zip};
            dealer.billing=pick(/bill/i)||null;
          }catch(e){}
        }
      }
      return json(200,{ok:true,status:"approved",email:du.email,dealer,lines});
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

// HCPS admin — staff accounts, roles & login. Service-role, server-side. No npm deps.
//
//   POST {action:"login", email, password}      -> { ok, token, profile }   (bootstrap + first-login-sets-password)
//   POST {action:"me"} + Authorization: Bearer   -> { ok, profile }
//   President-only (Bearer of a president):
//     {action:"list_users"} -> { users }
//     {action:"add_user", email, name, role, rep_name, can_travel}
//     {action:"update_user", email, patch:{name,role,rep_name,can_travel,active}}
//     {action:"remove_user", email}   (soft: active=false)
//
// Login (password -> JWT) is exchanged server-side with the anon key if present,
// else the service-role key. Set SUPABASE_ANON_KEY in Netlify env if login errors.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ANON = process.env.SUPABASE_ANON_KEY || SERVICE_ROLE;

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
const ROLES=["president","rep","relations"];

async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }

async function tokenGrant(email,password){
  try{
    const r=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:"POST",headers:{apikey:ANON,"content-type":"application/json"},body:JSON.stringify({email,password})});
    const j=await r.json().catch(()=>({}));
    if(r.ok && j.access_token) return {ok:true,access_token:j.access_token};
    return {ok:false,status:r.status,error:(j.error_description||j.msg||j.error||"")};
  }catch(e){ return {ok:false,error:String(e.message||e)}; }
}
async function adminCreateUser(email,password){
  try{
    const r=await fetch(`${SUPABASE_URL}/auth/v1/admin/users`,{method:"POST",headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`,"content-type":"application/json"},body:JSON.stringify({email,password,email_confirm:true})});
    const t=await r.text();
    if(r.ok) return {ok:true};
    if(r.status===422||r.status===409||/already|exists|registered|been/i.test(t)) return {ok:false,exists:true};
    return {ok:false,error:`auth ${r.status}: ${t}`};
  }catch(e){ return {ok:false,error:String(e.message||e)}; }
}
async function emailFromToken(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}}); if(!r.ok) return null; const u=await r.json(); return (u&&u.email)?String(u.email).toLowerCase():null; }catch(e){ return null; }
}
async function getStaff(email){ const rows=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); return (rows&&rows[0])||null; }
function pubProfile(s){ return s?{email:s.email,name:s.name||"",role:s.role||"rep",rep_name:s.rep_name||"",can_travel:!!s.can_travel,active:s.active!==false}:null; }
async function caller(event){ const email=await emailFromToken(event); if(!email) return null; const s=await getStaff(email); return (s&&s.active!==false)?s:null; }

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    if(event.httpMethod!=="POST") return json(405,{error:"method not allowed"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    // tables present?
    try{ await sbGet("staff_users?select=email&limit=1"); }
    catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run staff.sql in Supabase, then reload."}); }

    if(b.action==="login"){
      const email=String(b.email||"").trim().toLowerCase(), password=String(b.password||"");
      if(!email||!password) return json(200,{ok:false,message:"Enter your email and password."});
      let staff=await getStaff(email);
      const all=await sbGet("staff_users?select=email").catch(()=>[]);
      const empty=(all||[]).length===0;
      if(!staff && !empty) return json(200,{ok:false,message:"No staff account for that email — ask your administrator to add you."});
      if(staff && staff.active===false) return json(200,{ok:false,message:"Your access has been turned off. Contact the President."});

      let g=await tokenGrant(email,password);
      if(!g.ok){
        if(password.length<8) return json(200,{ok:false,message:"First sign-in sets your password — use at least 8 characters."});
        const c=await adminCreateUser(email,password);
        if(c.exists) return json(200,{ok:false,message:"Incorrect password."});
        if(!c.ok) return json(200,{ok:false,message:c.error||"Could not sign in."});
        g=await tokenGrant(email,password);
      }
      if(!g.ok) return json(200,{ok:false,message:"Could not sign in — check your email and password."});

      if(!staff){ // bootstrap first user as president
        staff={email,name:(String(b.name||"").trim()||email.split("@")[0]),role:"president",rep_name:null,can_travel:true,active:true};
        await sbSend("POST","staff_users?on_conflict=email",staff,{Prefer:"resolution=merge-duplicates,return=minimal"});
      }
      return json(200,{ok:true,token:g.access_token,profile:pubProfile(staff)});
    }

    if(b.action==="me"){
      const s=await caller(event); if(!s) return json(200,{ok:false,message:"not signed in"});
      return json(200,{ok:true,profile:pubProfile(s)});
    }

    // ---- President-only management ----
    const me=await caller(event);
    if(!me) return json(401,{error:"not signed in"});
    if(me.role!=="president") return json(403,{error:"President only"});

    if(b.action==="list_users"){
      const users=await sbGet("staff_users?select=*&order=role,name").catch(()=>[]);
      return json(200,{ok:true,users:(users||[]).map(pubProfile)});
    }
    if(b.action==="add_user"){
      const email=String(b.email||"").trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(200,{ok:false,message:"Enter a valid email."});
      const role=ROLES.includes(b.role)?b.role:"rep";
      const row={email,name:String(b.name||"").trim()||email.split("@")[0],role,rep_name:(b.rep_name||"").trim()||null,can_travel:role==="president"?true:!!b.can_travel,active:true};
      await sbSend("POST","staff_users?on_conflict=email",row,{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true,profile:pubProfile(row)});
    }
    if(b.action==="update_user"){
      const email=String(b.email||"").trim().toLowerCase(); if(!email) return json(400,{error:"email required"});
      if(email===me.email && b.patch && (b.patch.role&&b.patch.role!=="president" || b.patch.active===false))
        return json(200,{ok:false,message:"You can't remove your own President access."});
      const p=b.patch||{}; const patch={};
      if("name" in p) patch.name=String(p.name||"").trim()||null;
      if("role" in p && ROLES.includes(p.role)) patch.role=p.role;
      if("rep_name" in p) patch.rep_name=(String(p.rep_name||"").trim())||null;
      if("can_travel" in p) patch.can_travel=!!p.can_travel;
      if("active" in p) patch.active=!!p.active;
      if(!Object.keys(patch).length) return json(200,{ok:true});
      await sbSend("PATCH",`staff_users?email=eq.${encodeURIComponent(email)}`,patch,{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }
    if(b.action==="remove_user"){
      const email=String(b.email||"").trim().toLowerCase(); if(!email) return json(400,{error:"email required"});
      if(email===me.email) return json(200,{ok:false,message:"You can't remove yourself."});
      await sbSend("PATCH",`staff_users?email=eq.${encodeURIComponent(email)}`,{active:false},{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }
    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

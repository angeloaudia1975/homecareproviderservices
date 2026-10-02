// HCPS admin — staff accounts, roles & login. Service-role, server-side. No npm deps.
//
//   POST {action:"login", email, password}      -> { ok, token, profile }
//     A staff record alone never lets anyone choose its password. New staff get an emailed
//     setup link (add_user); forgotten passwords get the same HCPS-branded link.
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
    if(r.ok && j.access_token) return {ok:true,access_token:j.access_token,refresh_token:j.refresh_token,expires_in:j.expires_in};
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
// Same lookup, but a database error is an error — sign-in must never treat "couldn't read the
// staff table" as "this person isn't staff" or, worse, "the table is empty".
async function getStaffStrict(email){ const rows=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`); return (rows&&rows[0])||null; }

/* ONE WAY TO GIVE SOMEONE A PASSWORD: a single-use link to their own inbox.
   Used for new staff (kind "invite"), the President's reset button and the public "forgot"
   form. The link is minted with the admin API and sent by HCPS (password-reset.js), always
   to the fixed /admin/reset.html — a redirect supplied by the browser is never used, because
   whoever controls the redirect receives a live recovery token.
   If the person has no login yet, one is created first with a long random password that
   nobody ever sees; the link is how they set their own. */
const PR=require("./password-reset.js")._internals;
async function sendStaffLink(email, kind){
  const throwaway=require("crypto").randomBytes(32).toString("hex");
  const c=await adminCreateUser(email, throwaway);
  if(!c.ok && !c.exists) return {ok:false, message:"Couldn't prepare the account: "+String(c.error||"").slice(0,140)};
  const g=await PR.generateRecoveryLink(email, PR.PORTALS.staff.redirect);
  if(!g.ok) return {ok:false, message:g.status===429?"Too many links requested just now — wait a few minutes and try again.":`Couldn't create the link (${g.status}).`};
  const sent=await PR.sendViaResend(email, PR.template(PR.PORTALS.staff, g.link, kind));
  if(!sent.ok) return {ok:false, message:`Couldn't send the email (${sent.status}).`};
  return {ok:true};
}

// ---- Impersonation ("View as Rep") ----
// Mint a real, rep-scoped session for an admin WITHOUT the rep's password, using Supabase's
// admin magic-link generator + verify. The admin endpoint returns the link/OTP directly, so NO
// email is sent to the rep. The rep must already have an auth account (i.e. have signed in at
// least once) — brand-new reps who've never logged in can't be viewed until they do.
async function adminGenerateLink(email){
  try{
    const r=await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`,{method:"POST",headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`,"content-type":"application/json"},body:JSON.stringify({type:"magiclink",email})});
    const t=await r.text(); let j={}; try{ j=JSON.parse(t); }catch(e){}
    if(!r.ok) return {ok:false,status:r.status,text:t};
    const p=(j&&j.properties)||j||{};
    return {ok:true, hashed:(p.hashed_token||j.hashed_token||""), otp:(p.email_otp||j.email_otp||"")};
  }catch(e){ return {ok:false,error:String(e.message||e)}; }
}
async function verifyMagic(g,email){
  // Try token_hash (self-contained) first, then OTP + email. Returns a session JSON or null.
  const attempts=[];
  if(g.hashed) attempts.push({type:"magiclink",token_hash:g.hashed});
  if(g.otp)    attempts.push({type:"magiclink",token:g.otp,email});
  for(const body of attempts){
    try{
      const r=await fetch(`${SUPABASE_URL}/auth/v1/verify`,{method:"POST",headers:{apikey:ANON,"content-type":"application/json"},body:JSON.stringify(body)});
      const j=await r.json().catch(()=>({}));
      if(r.ok && j.access_token) return j;
    }catch(e){}
  }
  return null;
}
function pubProfile(s){ return s?{email:s.email,name:s.name||"",role:s.role||"rep",rep_name:s.rep_name||"",can_travel:!!s.can_travel,active:s.active!==false,email_signature:s.email_signature||""}:null; }
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
      let staff, empty;
      try{
        staff=await getStaffStrict(email);
        const any=await sbGet("staff_users?select=email&limit=1");
        empty=(any||[]).length===0;
      }catch(e){ return json(200,{ok:false,message:"Sign-in is unavailable right now. Please try again in a minute."}); }
      /* Bootstrapping the very first President only happens on a brand-new install, and only for
         the address named in STAFF_BOOTSTRAP_EMAIL — never for whoever signs in first. */
      const boot=String(process.env.STAFF_BOOTSTRAP_EMAIL||"").trim().toLowerCase();
      const mayBootstrap = !staff && empty && !!boot && email===boot;
      if(!staff && !mayBootstrap) return json(200,{ok:false,message:"No staff account for that email — ask your administrator to add you."});
      if(staff && staff.active===false) return json(200,{ok:false,message:"Your access has been turned off. Contact the President."});

      /* NO "FIRST SIGN-IN SETS YOUR PASSWORD". That rule let anyone who knew the email of a staff
         member who hadn't signed in yet choose their password and walk in as them. A password is
         now set only through the emailed link, so a failed sign-in is just a failed sign-in. */
      const g=await tokenGrant(email,password);
      if(!g.ok) return json(200,{ok:false,message:"Incorrect email or password. New to HCPS Sales? Use the link in your invitation email to set your password, or choose “Forgot password?” to get a new one."});

      if(!staff){ // bootstrap first user as president (named in STAFF_BOOTSTRAP_EMAIL, empty table only)
        staff={email,name:(String(b.name||"").trim()||email.split("@")[0]),role:"president",rep_name:null,can_travel:true,active:true};
        await sbSend("POST","staff_users?on_conflict=email",staff,{Prefer:"resolution=merge-duplicates,return=minimal"});
      }
      return json(200,{ok:true,token:g.access_token,refresh:g.refresh_token,expires_in:g.expires_in,profile:pubProfile(staff)});
    }

    // Silent session renewal. The browser trades its rotating refresh token for a fresh
    // 1-hour access token so staff aren't signed out mid-work. The refresh token itself is
    // the credential here (no Bearer needed). We re-derive + re-check the staff account so a
    // deactivated user can't keep renewing. Supabase rotates the refresh token on each use,
    // so we hand back the new one (falling back to the old if none is returned).
    if(b.action==="refresh"){
      const rt=String(b.refresh_token||"").trim();
      if(!rt) return json(200,{ok:false,message:"missing refresh token"});
      let j;
      try{
        const r=await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,{method:"POST",headers:{apikey:ANON,"content-type":"application/json"},body:JSON.stringify({refresh_token:rt})});
        j=await r.json().catch(()=>({}));
        if(!r.ok || !j.access_token) return json(200,{ok:false,message:"session expired"});
      }catch(e){ return json(200,{ok:false,message:"could not renew session"}); }
      let email=null;
      try{ const u=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${j.access_token}`}}); if(u.ok){ const uj=await u.json(); email=uj&&uj.email&&String(uj.email).toLowerCase(); } }catch(e){}
      const staff=email?await getStaff(email):null;
      if(!staff || staff.active===false) return json(200,{ok:false,message:"account inactive"});
      return json(200,{ok:true,token:j.access_token,refresh:j.refresh_token||rt,expires_in:j.expires_in,profile:pubProfile(staff)});
    }

    // Public config for the reset page. Returns ONLY the publishable anon key (never the
    // service_role). If SUPABASE_ANON_KEY isn't set, the reset page shows a helpful message.
    if(b.action==="public_config"){
      return json(200,{ok:true,url:SUPABASE_URL,anon:process.env.SUPABASE_ANON_KEY||""});
    }

    // Forgot password: email a Supabase recovery link — but only if the address is a known,
    // active staff member. Always returns the same message so we never reveal which emails exist.
    if(b.action==="forgot"){
      const email=String(b.email||"").trim().toLowerCase();
      // b.redirect_to is deliberately ignored: the link always lands on /admin/reset.html.
      const generic={ok:true,message:"If that email is a staff account, a reset link is on its way. Check your inbox (and spam)."};
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(200,{ok:false,message:"Enter a valid email."});
      const s=await getStaff(email);
      if(!s || s.active===false) return json(200,generic);   // don't reveal non-accounts
      try{ await sendStaffLink(email,"reset"); }catch(e){}
      return json(200,generic);
    }

    if(b.action==="me"){
      const s=await caller(event); if(!s) return json(200,{ok:false,message:"not signed in"});
      return json(200,{ok:true,profile:pubProfile(s)});
    }

    /* Favorites belong to EVERY signed-in staff member, not just the President —
       a rep personalising their own dashboard is the whole point. So this sits above
       the management gate, and reads the caller's identity from their session. */
    const meAny=await caller(event);
    if(meAny && (b.action==="my_favorites" || b.action==="save_favorites")){
      const me=meAny;
      /* ── Personal favorites ──────────────────────────────────────────────────
       A user's own pinned tools. Self-only by construction: the caller's identity comes
       from their session, never from the request body, so nobody can read or rewrite
       someone else's shortcuts by passing an email. */
      if(b.action==="my_favorites"){
      const s2=await getStaff(me.email);
      const fav=(s2&&Array.isArray(s2.favorites))?s2.favorites:[];
      return json(200,{ok:true,favorites:fav});
    }
      if(b.action==="save_favorites"){
      const list=Array.isArray(b.favorites)?b.favorites:null;
      if(!list) return json(400,{error:"favorites must be an array"});
      /* Only in-app admin pages, de-duplicated, capped. A favorite becomes a link on a
         dashboard, so it is never a place to accept an arbitrary URL — an off-site href
         here would turn someone's own dashboard into a phishing surface. */
      const clean=[]; const seen=new Set();
      for(const raw of list){
        const h=String(raw||"").trim();
        if(!/^\/admin\/[A-Za-z0-9._~-]+\.html(#[A-Za-z0-9._~-]*)?$/.test(h)) continue;
        if(h.indexOf("..")>=0) continue;
        const k=h.toLowerCase(); if(seen.has(k)) continue;
        seen.add(k); clean.push(h);
        if(clean.length>=24) break;
      }
      await sbSend("PATCH",`staff_users?email=eq.${encodeURIComponent(String(me.email).toLowerCase())}`,
        {favorites:clean},{Prefer:"return=minimal"});
      return json(200,{ok:true,favorites:clean});
    }

    }

    // ---- President-only management ----
    const me=meAny;
    if(!me) return json(401,{error:"not signed in"});
    if(me.role!=="president") return json(403,{error:"President only"});

    if(b.action==="list_users"){
      const users=await sbGet("staff_users?select=*&order=role,name").catch(()=>[]);
      return json(200,{ok:true,users:(users||[]).map(pubProfile)});
    }

    // View as Rep — return a real rep session to the President's browser, audit-logged. President-only.
    if(b.action==="impersonate"){
      const email=String(b.email||"").trim().toLowerCase();
      if(!email) return json(400,{error:"email required"});
      if(email===me.email) return json(200,{ok:false,message:"You're already signed in as yourself."});
      const target=await getStaff(email);
      if(!target || target.active===false) return json(200,{ok:false,message:"That teammate isn't an active staff account."});
      if(target.role==="president") return json(200,{ok:false,message:"View-as is for reps and staff — not other President accounts."});
      const g=await adminGenerateLink(email);
      const sess=g.ok ? await verifyMagic(g,email) : null;
      if(!sess || !sess.access_token){
        return json(200,{ok:false,message:`${target.name||email} needs to finish setting up their account (from their invitation email) before you can view their portal.`});
      }
      // Audit — best effort; never blocks the session.
      try{ await sbSend("POST","impersonation_log",{admin_email:me.email,admin_name:me.name||me.email,target_email:email,target_name:target.name||email,action:"start",user_agent:String(event.headers["user-agent"]||"").slice(0,300)},{Prefer:"return=minimal"}); }catch(e){}
      return json(200,{ok:true,token:sess.access_token,refresh:sess.refresh_token,expires_in:sess.expires_in,
        profile:pubProfile(target),
        impersonation:{by:me.email,by_name:me.name||me.email,at:new Date().toISOString()}});
    }
    // Log the end of a View-as session (called after the admin session is restored, so `me` is the admin).
    if(b.action==="impersonate_end"){
      try{ await sbSend("POST","impersonation_log",{admin_email:me.email,admin_name:me.name||me.email,target_email:String(b.email||"").trim().toLowerCase()||null,target_name:String(b.target_name||"").trim()||null,action:"end",user_agent:String(event.headers["user-agent"]||"").slice(0,300)},{Prefer:"return=minimal"}); }catch(e){}
      return json(200,{ok:true});
    }
    // President-only view of the audit trail (most recent first).
    if(b.action==="impersonation_log"){
      const rows=await sbGet("impersonation_log?select=*&order=created_at.desc&limit=100").catch(()=>[]);
      return json(200,{ok:true,rows:rows||[]});
    }
    /* Admin-triggered password reset. Deliberately a RESET LINK and not "set this
       person's password": the rep chooses their own secret and the admin never sees or
       types it, so a shared credential can't end up in a text message and nobody has to
       trust that it was changed afterwards. The public "forgot" action stays vague about
       whether an account exists (it is unauthenticated); this one is President-only and
       therefore answers plainly, because a useless "if that email exists…" is exactly
       what makes an admin unsure whether the thing worked. */
    if(b.action==="send_reset"){
      const email=String(b.email||"").trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(200,{ok:false,message:"Enter a valid email."});
      const target=await getStaff(email);
      if(!target) return json(200,{ok:false,message:`No staff account with the email ${email}. Add them under Staff first.`});
      if(target.active===false) return json(200,{ok:false,message:`${target.name||email} is deactivated. Restore their access before sending a reset.`});
      // b.redirect_to is ignored on purpose: the link always lands on /admin/reset.html.
      let sent;
      try{ sent=await sendStaffLink(email,"reset"); }
      catch(e){ return json(200,{ok:false,message:"Couldn't send the reset email: "+String(e.message||e).slice(0,140)}); }
      if(!sent.ok) return json(200,{ok:false,message:sent.message});
      /* Recorded in the same audit trail as View-as: an admin causing a change to
         somebody else's sign-in should leave a trace, even a benign one. */
      try{ await sbSend("POST","impersonation_log",{admin_email:me.email,admin_name:me.name||me.email,
        target_email:email,target_name:target.name||email,action:"password_reset_sent",
        user_agent:String(event.headers["user-agent"]||"").slice(0,300)},{Prefer:"return=minimal"}); }catch(e){}
      return json(200,{ok:true,to:email,name:target.name||email,
        message:`Reset link sent to ${email}. It expires in about an hour — they set their own password, and you never see it.`});
    }

    if(b.action==="add_user"){
      const email=String(b.email||"").trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(200,{ok:false,message:"Enter a valid email."});
      const role=ROLES.includes(b.role)?b.role:"rep";
      const row={email,name:String(b.name||"").trim()||email.split("@")[0],role,rep_name:(b.rep_name||"").trim()||null,can_travel:role==="president"?true:!!b.can_travel,active:true};
      await sbSend("POST","staff_users?on_conflict=email",row,{Prefer:"resolution=merge-duplicates,return=minimal"});
      /* The new person sets their own password from an emailed link. Nobody — the President
         included — ever chooses, sees or types it. */
      let invite;
      try{ invite=await sendStaffLink(email,"invite"); }catch(e){ invite={ok:false,message:String(e.message||e).slice(0,140)}; }
      try{ await sbSend("POST","impersonation_log",{admin_email:me.email,admin_name:me.name||me.email,target_email:email,target_name:row.name,action:invite.ok?"invite_sent":"invite_failed",user_agent:String(event.headers["user-agent"]||"").slice(0,300)},{Prefer:"return=minimal"}); }catch(e){}
      return json(200,{ok:true,profile:pubProfile(row),invite_sent:!!invite.ok,
        message: invite.ok
          ? `Added. A setup link is on its way to ${email} — they choose their own password from it.`
          : `Added, but the setup email didn't go out (${invite.message}). Use 🔑 Reset password on their row to send it again.`});
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
      if("email_signature" in p) patch.email_signature=String(p.email_signature||"").slice(0,2000)||null;
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

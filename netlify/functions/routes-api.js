// HCPS sales-rep route planning — OpenRouteService proxy + saved routes.
// Service-role, server-side. The ORS API key stays here (never in the browser).
//
//   POST {action:"optimize", home, stops:[{lat,lng}], round_trip}  -> {order:[idx...]}
//   POST {action:"directions", coords:[[lng,lat]...]}              -> {geometry, distance_m, duration_s, legs}
//   POST {action:"save_route", ...route}                            -> {id}
//   POST {action:"list_routes"}                                     -> {routes:[...]}
//   POST {action:"get_route", id}                                   -> {route}
//   POST {action:"delete_route", id}                                -> {ok}
//   All require a staff Bearer token. Reps see only their own saved routes.
//
// Set the free OpenRouteService key in Netlify env as ORS_API_KEY (or OPENROUTESERVICE_API_KEY).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORS_KEY = process.env.ORS_API_KEY || process.env.OPENROUTESERVICE_API_KEY || "";
const { computeAccess } = require("./_access.js");
const { dnorm } = require("./_scope.js");
const NORM_BUY={ bongo:"airavant-bongorx", airavant:"airavant-bongorx", "golden":"golden-technologies", "ohio-medical":"gce" };
const normBuy=s=>{ s=String(s||"").toLowerCase().trim(); return NORM_BUY[s]||s; };
const pretty=s=>String(s||"").split("-").map(w=>w?w[0].toUpperCase()+w.slice(1):w).join(" ");
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const MAIL_FROM = process.env.HCPS_MAIL_FROM || "HCPS Partner Portal <orders@homecareproviderservices.us>";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const P = require("./_platform.js");
const esc2 = s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
function prettyDate(s){ try{ const p=String(s).split("-").map(Number); const d=new Date(p[0],p[1]-1,p[2]); return d.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"}); }catch(e){ return String(s||""); } }
async function sendMail({to,subject,html,text,replyTo}){
  const key=process.env.RESEND_API_KEY; if(!key) return {ok:false,skipped:true};
  try{ const p={from:MAIL_FROM,to:[to],subject,html,text}; if(replyTo&&EMAIL_RE.test(String(replyTo))) p.reply_to=replyTo;
    const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(p)}); return {ok:r.ok};
  }catch(e){ return {ok:false}; }
}
function visitEmail(to,d,dateStr,repName,repEmail){
  const name=esc2(d.business_name||d.contact_name||"there");
  const when=dateStr?prettyDate(dateStr):"";
  const html=`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
    <h2 style="color:#2B4071;margin:0 0 4px">We'll be in your area${when?", "+esc2(when):""}</h2>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 12px">Hi ${name}, this is ${esc2(repName)} with HomeCare Provider Services. I'm planning to be near you${when?" on <b>"+esc2(when)+"</b>":" soon"} and would love to stop by — catch up on how things are going, share what's new, and make sure your lines and pricing are set up the way you need them.</p>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 12px">If there's a good time that works, just reply and let me know. If it's not a good week, no problem — we'll find another time.</p>
    <a href="${ORDERING_BASE}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;font-size:14px">Browse your portal &rarr;</a>
    <p style="font-size:12.5px;color:#6b7280;margin:16px 0 0">${esc2(repName)}${repEmail?` · <a href="mailto:${esc2(repEmail)}" style="color:#2B4071">${esc2(repEmail)}</a>`:""}<br>HomeCare Provider Services</p></div>`;
  const text=`We'll be in your area${when?", "+when:""}\n\nHi ${d.business_name||d.contact_name||"there"}, this is ${repName} with HomeCare Provider Services. I'm planning to be near you${when?" on "+when:" soon"} and would love to stop by. Reply with a good time and I'll make it work.\n\n${repName}${repEmail?" · "+repEmail:""}\nHomeCare Provider Services`;
  return {to,subject:`HCPS will be in your area${when?" — "+when:""}`,html,text,replyTo:repEmail};
}
// ---- visit follow-up (Phase 4) ----
function followupList(v){ if(Array.isArray(v)) return v.map(x=>String(x)); if(v==null) return []; return String(v).split(/\r?\n|;/).map(s=>s.trim()).filter(Boolean); }
function firstFew(s){ return String(s||"").split(/[,;\n]/)[0].split(/\s+/).slice(0,4).join(" "); }
// Compose a readable CRM note from a structured field-visit report (Scheduled Routes).
function visitNotesSummary(f){
  f=f||{}; const arr=v=>Array.isArray(v)?v.filter(Boolean).join(", "):String(v||"").trim(); const L=[];
  if(f.purpose) L.push(`Purpose: ${f.purpose}`);
  if(arr(f.manufacturers)) L.push(`Manufacturers discussed: ${arr(f.manufacturers)}`);
  if(arr(f.products)) L.push(`Products presented: ${arr(f.products)}`);
  if(arr(f.interest)) L.push(`Interested in: ${arr(f.interest)}`);
  if(f.concerns) L.push(`Questions/concerns: ${f.concerns}`);
  if(f.competitive) L.push(`Competitive: ${f.competitive}`);
  if(arr(f.opportunities)) L.push(`Opportunities: ${arr(f.opportunities)}`);
  if(arr(f.followups)) L.push(`Follow-ups: ${arr(f.followups)}`);
  if(f.next_action) L.push(`Next action: ${f.next_action}${f.next_action_date?` (by ${f.next_action_date})`:""}`);
  if(f.notes) L.push(`Notes: ${f.notes}`);
  return L.join("\n")||null;
}
function buildFollowup(dealerName,repName,details){
  const parts=[];
  parts.push(`Hi ${dealerName||"there"},`);
  parts.push(`Thank you for taking the time to meet — it was great to connect and talk through how things are going.`);
  const b=[];
  if(details.products) b.push(`Products we discussed: ${details.products}`);
  if(details.pricing) b.push(`Pricing: ${details.pricing}`);
  if(details.samples) b.push(`Samples to send over: ${details.samples}`);
  if(details.opportunities) b.push(`Lines/opportunities to explore: ${details.opportunities}`);
  if(details.orders_expected) b.push(`Order we talked about: ${details.orders_expected}`);
  const fups=followupList(details.follow_ups);
  if(fups.length) b.push(`Next steps on my side: ${fups.join("; ")}`);
  if(b.length){ parts.push("To recap what we covered:"); parts.push(b.map(x=>"• "+x).join("\n")); }
  if(details.next_visit) parts.push(`I'll plan to check back in around ${prettyDate(details.next_visit)}.`);
  parts.push(`If anything comes up in the meantime, just reply here or give me a call — always happy to help.`);
  parts.push(`Best,\n${repName}\nHomeCare Provider Services`);
  const subject=`Great connecting${details.products?` about ${firstFew(details.products)}`:""} — HCPS follow-up`;
  return {subject,body:parts.join("\n\n")};
}
function followupHtml(text,repName){
  const safe=esc2(text).replace(/\n/g,"<br>");
  return `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px;font-size:13.5px;line-height:1.6">${safe}<p style="font-size:12px;color:#9aa4ae;margin:18px 0 0">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.</p></div>`;
}
async function fetchJson(url){ const r=await fetch(url); if(!r.ok) throw new Error("fetch "+r.status); return r.json(); }
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }

// ---- Microsoft Graph (Outlook calendar write) — app-only, same creds as email-sync ----
const G_TENANT=process.env.GRAPH_TENANT_ID, G_CLIENT=process.env.GRAPH_CLIENT_ID, G_SECRET=process.env.GRAPH_CLIENT_SECRET;
async function graphToken(){
  const body=new URLSearchParams({client_id:G_CLIENT,client_secret:G_SECRET,scope:"https://graph.microsoft.com/.default",grant_type:"client_credentials"});
  const r=await fetch(`https://login.microsoftonline.com/${G_TENANT}/oauth2/v2.0/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
  const j=await r.json().catch(()=>({})); if(!r.ok||!j.access_token) throw new Error("graph_token:"+((j&&j.error_description)||r.status)); return j.access_token;
}
async function graphReq(tok,method,path,body){
  const r=await fetch(`https://graph.microsoft.com/v1.0${path}`,{method,headers:{Authorization:`Bearer ${tok}`,"content-type":"application/json"},body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); let j={}; try{ j=t?JSON.parse(t):{}; }catch(e){} return {ok:r.ok,status:r.status,json:j,text:t};
}

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email,
            can_travel:!!su.can_travel, home_base:su.home_base||null}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:"",can_travel:true,home_base:null};
  return null;
}

/* ─────────────────────── Who may see a route ───────────────────────────────
   A route has two people attached to it: the one who BUILT it (owner_email) and the
   one it is FOR (assigned_to_email). Only the first existed before, which is why a
   route the president planned for a rep was invisible to that rep — his portal asked
   for routes owned by him, and he owned none of them. The route was never related to
   him at all; his credentials were fine.

   Viewing and managing are deliberately different rights. A rep works a route assigned
   to them — opens it, drives it, files visit reports. Renaming, re-planning or deleting
   it stays with the person who built it, so an assignment can never be silently
   rewritten or destroyed by the field. */
const emailEq=(a,b)=>!!a&&!!b&&String(a).toLowerCase().trim()===String(b).toLowerCase().trim();
const isBoss = me => String(me&&me.role||"").toLowerCase()==="president";
const canViewRoute = (me,r) => isBoss(me) || emailEq(r&&r.owner_email,me.email) || emailEq(r&&r.assigned_to_email,me.email);
const canManageRoute = (me,r) => isBoss(me) || emailEq(r&&r.owner_email,me.email);
// PostgREST filter for "mine": owned by me OR assigned to me.
const mineFilter = me => { const e=String(me.email||"~none~").toLowerCase();
  return `or=(owner_email.eq.${encodeURIComponent(e)},assigned_to_email.eq.${encodeURIComponent(e)})`; };

/* A rep's map must never start from someone else's house. The start point is resolved
   in this order and never falls back to the creator: whatever the route itself records,
   then the viewing rep's own saved default. If neither exists the map asks rather than
   guessing — an unset start is a question, not a licence to use the admin's address. */
function resolveHomeBase(route, me){
  const rb=route&&route.home_base;
  if(rb && isFinite(rb.lat) && isFinite(rb.lng)) return {...rb, source:"route"};
  const mb=me&&me.home_base;
  if(mb && isFinite(mb.lat) && isFinite(mb.lng)) return {...mb, source:"my_default"};
  return null;
}

// ---- OpenRouteService ----
async function orsPost(url, body){
  const r=await fetch(url,{method:"POST",headers:{Authorization:ORS_KEY,"content-type":"application/json","Accept":"application/json, application/geo+json"},body:JSON.stringify(body)});
  const t=await r.text(); let j=null; try{ j=t?JSON.parse(t):null; }catch(e){}
  if(!r.ok) throw new Error(`ORS ${r.status}: ${(j&&j.error&&(j.error.message||JSON.stringify(j.error)))||t||""}`.slice(0,300));
  return j;
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    // ---------- Routing engine (OpenRouteService) ----------
    if(b.action==="optimize" || b.action==="directions"){
      if(!ORS_KEY) return json(200,{ok:false,need_key:true,message:"Routing isn't set up yet — add your free OpenRouteService key as ORS_API_KEY in Netlify."});

      if(b.action==="optimize"){
        const home=b.home&&isFinite(b.home.lat)&&isFinite(b.home.lng)?b.home:null;
        const stops=(Array.isArray(b.stops)?b.stops:[]).filter(s=>isFinite(s.lat)&&isFinite(s.lng));
        if(stops.length<2) return json(200,{ok:true,order:stops.map((_,i)=>i)});   // nothing to optimize
        const start = home ? [home.lng,home.lat] : [stops[0].lng,stops[0].lat];
        const vehicle = {id:1, profile:"driving-car", start};
        if(b.round_trip!==false) vehicle.end = start;   // return to home base
        const jobs = stops.map((s,i)=>({id:i+1, location:[s.lng,s.lat]}));
        let j; try{ j=await orsPost("https://api.openrouteservice.org/optimization",{jobs,vehicles:[vehicle]}); }
        catch(e){ return json(200,{ok:false,message:String(e.message||e)}); }
        const steps=(j&&j.routes&&j.routes[0]&&j.routes[0].steps)||[];
        const order=steps.filter(s=>s.type==="job"&&s.id!=null).map(s=>s.id-1);
        return json(200,{ok:true,order:order.length?order:stops.map((_,i)=>i)});
      }

      // directions: coords already in [lng,lat] visiting order (incl. home at ends if desired)
      const coords=(Array.isArray(b.coords)?b.coords:[]).filter(c=>Array.isArray(c)&&c.length===2&&isFinite(c[0])&&isFinite(c[1]));
      if(coords.length<2) return json(400,{error:"need at least 2 coordinates"});
      let j; try{ j=await orsPost("https://api.openrouteservice.org/v2/directions/driving-car/geojson",{coordinates:coords}); }
      catch(e){ return json(200,{ok:false,message:String(e.message||e)}); }
      const f=j&&j.features&&j.features[0];
      const geom=f&&f.geometry&&f.geometry.coordinates||[];
      const sum=(f&&f.properties&&f.properties.summary)||{};
      const legs=((f&&f.properties&&f.properties.segments)||[]).map(s=>({distance_m:s.distance,duration_s:s.duration}));
      return json(200,{ok:true,geometry:geom,distance_m:sum.distance||0,duration_s:sum.duration||0,legs});
    }

    // ---------- Saved routes ----------
    if(b.action==="save_route"){
      const name=String(b.name||"").trim(); if(!name) return json(400,{error:"name required"});
      /* A route built BY a rep is theirs; a route built by the president is for whoever
         they name. Recording that at save time is what stops a route existing under the
         admin account with no relationship to the person meant to drive it. */
      let asgEmail=null, asgRep=null;
      if(isBoss(me)){
        if(b.assigned_to_email!=null){
          asgEmail=String(b.assigned_to_email||"").toLowerCase().trim()||null;
          if(asgEmail){ const su=await sbGet(`staff_users?email=eq.${encodeURIComponent(asgEmail)}&select=email,rep_name,name,active`).catch(()=>[]);
            const u=su&&su[0];
            if(!u||u.active===false) return json(400,{error:"That rep is not an active staff user"});
            asgRep=u.rep_name||u.name||null; }
        }
      } else { asgEmail=me.email||null; asgRep=me.rep_name||null; }
      const row={
        owner_email:me.email||null, rep_name:me.rep_name||null, name,
        scheduled_date:(b.scheduled_date&&String(b.scheduled_date).trim())||null,
        home_base:b.home_base||null, round_trip:b.round_trip!==false,
        stops:Array.isArray(b.stops)?b.stops:[],
        distance_m:isFinite(b.distance_m)?b.distance_m:null, duration_s:isFinite(b.duration_s)?b.duration_s:null,
        geometry:b.geometry||null, notes:(b.notes!=null?String(b.notes):null),
        updated_at:new Date().toISOString(),
      };
      if(asgEmail){ row.assigned_to_email=asgEmail; row.assigned_to_rep=asgRep;
        row.assigned_at=new Date().toISOString(); row.assigned_by=me.email||me.name||null; }
      if(b.id){
        const cur=await sbGet(`rep_routes?id=eq.${encodeURIComponent(b.id)}&select=owner_email,assigned_to_email`).catch(()=>[]);
        const own=cur&&cur[0]; if(!own) return json(404,{error:"route not found"});
        if(!canManageRoute(me,own)) return json(403,{error:canViewRoute(me,own)
          ? "This route is assigned to you but owned by whoever planned it — ask them to change it."
          : "not your route"});
        // Re-saving must not silently drop an existing assignment.
        if(!asgEmail && own.assigned_to_email){ delete row.assigned_to_email; delete row.assigned_to_rep; }
        await sbSend("PATCH",`rep_routes?id=eq.${encodeURIComponent(b.id)}`,row,{Prefer:"return=minimal"});
        return json(200,{ok:true,id:b.id});
      }
      const ins=await sbSend("POST","rep_routes",row,{Prefer:"return=representation"});
      return json(200,{ok:true,id:ins&&ins[0]&&ins[0].id});
    }
    /* Assign an existing route to a rep. This is the missing link: it relates a route
       the office planned to the person who will drive it, rather than leaving it under
       the account that happened to create it. Assigning also re-bases the start point,
       because a route planned from the president's house must not send a rep there. */
    if(b.action==="assign_route"){
      if(!isBoss(me)) return json(403,{error:"President only"});
      const id=String(b.id||"").trim(); if(!id) return json(400,{error:"id required"});
      const rows=await sbGet(`rep_routes?id=eq.${encodeURIComponent(id)}&select=*`).catch(()=>[]);
      const route=rows&&rows[0]; if(!route) return json(404,{error:"route not found"});
      const email=String(b.assigned_to_email||"").toLowerCase().trim();
      const now=new Date().toISOString();
      if(!email){        // unassign
        await sbSend("PATCH",`rep_routes?id=eq.${encodeURIComponent(id)}`,
          {assigned_to_email:null,assigned_to_rep:null,assigned_at:null,assigned_by:null,updated_at:now},{Prefer:"return=minimal"});
        return json(200,{ok:true,assigned_to_email:null});
      }
      const su=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=email,name,rep_name,active,home_base`).catch(()=>[]);
      const u=su&&su[0];
      if(!u) return json(404,{error:`No staff user with the email ${email}. Add them under Staff before assigning a route.`});
      if(u.active===false) return json(400,{error:"That staff account is inactive"});
      const patch={assigned_to_email:email, assigned_to_rep:u.rep_name||u.name||null,
        assigned_at:now, assigned_by:me.email||me.name||"president", updated_at:now};
      /* Start point. The rep's own default wins; if they have none, the route's start is
         CLEARED rather than left pointing at whoever planned it, and their map asks them
         to set one. Silently keeping the admin's address is the bug being fixed. */
      let home_note=null;
      if(u.home_base && isFinite(u.home_base.lat) && isFinite(u.home_base.lng)){
        patch.home_base=u.home_base; home_note="start point set to the rep's own default";
      } else if(route.home_base && !emailEq(route.owner_email,email)){
        patch.home_base=null; home_note="start point cleared — this rep has no default yet, so their map will ask";
      }
      await sbSend("PATCH",`rep_routes?id=eq.${encodeURIComponent(id)}`,patch,{Prefer:"return=minimal"});
      return json(200,{ok:true,assigned_to_email:email,assigned_to_rep:patch.assigned_to_rep,home_note});
    }

    /* The reps a route can be assigned to. */
    if(b.action==="assignable_reps"){
      if(!isBoss(me)) return json(403,{error:"President only"});
      const rows=await sbGet("staff_users?active=neq.false&select=email,name,rep_name,role,home_base&order=name").catch(()=>[]);
      return json(200,{ok:true,reps:(rows||[]).map(r=>({email:r.email,name:r.name||r.email,
        rep_name:r.rep_name||"", role:r.role||"rep", has_home_base:!!(r.home_base&&isFinite(r.home_base.lat))}))});
    }

    /* Each rep's own start location. Personal: a rep may only read and write their own,
       and it is never copied from anyone else. */
    /* Turn a typed address into coordinates, so a rep can set their own start point
       without needing the full map. Uses the OpenRouteService key already configured
       for routing — no second provider, no key in the browser. */
    if(b.action==="geocode"){
      const q=String(b.q||"").trim();
      if(!q) return json(400,{error:"q required"});
      if(!ORS_KEY) return json(200,{ok:false,need_key:true,message:"Address lookup isn't set up yet — add ORS_API_KEY in Netlify."});
      try{
        const r=await fetch(`https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(ORS_KEY)}`
          +`&text=${encodeURIComponent(q)}&boundary.country=US&size=1`,{headers:{Accept:"application/json"}});
        if(!r.ok) return json(200,{ok:false,message:`Lookup failed (${r.status})`});
        const j=await r.json().catch(()=>null);
        const f=j&&j.features&&j.features[0];
        if(!f||!f.geometry||!Array.isArray(f.geometry.coordinates)) return json(200,{ok:false,message:"No match for that address"});
        return json(200,{ok:true,result:{lat:f.geometry.coordinates[1],lng:f.geometry.coordinates[0],
          address:(f.properties&&f.properties.label)||q}});
      }catch(e){ return json(200,{ok:false,message:String(e.message||e).slice(0,160)}); }
    }

    if(b.action==="my_settings"){
      return json(200,{ok:true, me:{email:me.email||"",name:me.name||"",rep_name:me.rep_name||"",role:me.role||"rep"},
        home_base:me.home_base||null});
    }
    if(b.action==="save_home_base"){
      if(!me.email) return json(400,{error:"This account has no email on file, so a personal start point can't be saved."});
      const h=b.home_base;
      if(h!==null && !(h && isFinite(h.lat) && isFinite(h.lng))) return json(400,{error:"home_base needs lat and lng"});
      const val=h?{label:String(h.label||"Home").slice(0,80), address:String(h.address||"").slice(0,240),
        lat:Number(h.lat), lng:Number(h.lng)}:null;
      await sbSend("PATCH",`staff_users?email=eq.${encodeURIComponent(String(me.email).toLowerCase())}`,
        {home_base:val},{Prefer:"return=minimal"});
      return json(200,{ok:true,home_base:val});
    }

    if(b.action==="list_routes"){
      let path="rep_routes?select=id,name,scheduled_date,stops,distance_m,duration_s,round_trip,updated_at,owner_email,rep_name,assigned_to_email,assigned_to_rep&order=scheduled_date.desc.nullslast,updated_at.desc";
      if(!isBoss(me)) path+="&"+mineFilter(me);
      else if(b.assigned_to_email){ path+=`&assigned_to_email=eq.${encodeURIComponent(String(b.assigned_to_email).toLowerCase())}`; }
      const rows=await sbGet(path).catch(()=>[]);
      // visited-progress per route (completed visit reports) so the route cards can show 2/5 done.
      const ids=(rows||[]).map(r=>r.id);
      let doneBy={};
      if(ids.length){ try{ const vr=await sbGet(`dealer_visit_reports?route_id=in.(${ids.join(",")})&completed_at=not.is.null&select=route_id`); for(const v of (vr||[])) doneBy[v.route_id]=(doneBy[v.route_id]||0)+1; }catch(e){} }
      const today=new Date().toISOString().slice(0,10);
      const routes=(rows||[]).map(r=>({id:r.id,name:r.name,scheduled_date:r.scheduled_date,stops_count:(r.stops||[]).length,
        visited:doneBy[r.id]||0, distance_m:r.distance_m,duration_s:r.duration_s,round_trip:r.round_trip,updated_at:r.updated_at,
        assigned_to_rep:r.assigned_to_rep||null, assigned_to_email:r.assigned_to_email||null,
        planned_by:(r.assigned_to_email&&!emailEq(r.assigned_to_email,r.owner_email))?(r.rep_name||r.owner_email||"the office"):null,
        mine:emailEq(r.assigned_to_email,me.email)||emailEq(r.owner_email,me.email),
        can_manage:canManageRoute(me,r),
        when:r.scheduled_date?(r.scheduled_date===today?"today":(r.scheduled_date>today?"upcoming":"past")):"saved"}));
      return json(200,{ok:true,routes,me:{email:me.email||"",name:me.name||"",rep_name:me.rep_name||"",role:me.role,
        home_base:me.home_base||null}});
    }
    if(b.action==="get_route"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`rep_routes?id=eq.${encodeURIComponent(b.id)}&select=*`).catch(()=>[]);
      const r=rows&&rows[0]; if(!r) return json(404,{error:"route not found"});
      if(!canViewRoute(me,r)) return json(403,{error:"not your route"});
      return json(200,{ok:true,route:r,home_base:resolveHomeBase(r,me),can_manage:canManageRoute(me,r)});
    }
    if(b.action==="delete_route"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`rep_routes?id=eq.${encodeURIComponent(b.id)}&select=owner_email,assigned_to_email`).catch(()=>[]);
      const r=rows&&rows[0]; if(!r) return json(200,{ok:true});
      if(!canManageRoute(me,r)) return json(403,{error:canViewRoute(me,r)
        ? "This route was planned for you by the office — it can't be deleted from here."
        : "not your route"});
      await sbSend("DELETE",`rep_routes?id=eq.${encodeURIComponent(b.id)}`,null,{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }

    // ---------- Business-case trip packet: per-stop history, contacts, opportunities ----------
    if(b.action==="business_case"){
      const ids=[...new Set((Array.isArray(b.dealer_ids)?b.dealer_ids:[]).filter(Boolean))];
      if(!ids.length) return json(200,{ok:true,cases:{}});
      // Load ALL dealers so a branch rolls up to its whole company (master HQ + all branches).
      const allDealers=await sbGet("dealers?select=id,business_name,hcps_account,contact_name,email,phone,address,city,state,zip,parent_id,golden_status,ovation_access,golden_url").catch(()=>[]);
      const byId=Object.fromEntries(allDealers.map(d=>[d.id,d]));
      const companyOf=id=>{ const d=byId[id]; return (d&&d.parent_id)?d.parent_id:id; };   // master id (self if HQ/standalone)
      const membersOfCompany={}; for(const d of allDealers){ const cid=d.parent_id||d.id; (membersOfCompany[cid]||(membersOfCompany[cid]=[])).push(d.id); }
      const reqCompanies=[...new Set(ids.map(companyOf))];
      const memberIds=[...new Set(reqCompanies.flatMap(cid=>membersOfCompany[cid]||[cid]))];
      const memIn=`in.(${memberIds.join(",")})`, reqIn=`in.(${ids.join(",")})`;
      const [sales,contacts,mfrs,dm] = await Promise.all([
        sbGet(`monthly_sales?dealer_id=${memIn}&select=dealer_id,manufacturer,period,amount,qty,product_code,product_name`).catch(()=>[]),
        sbGet(`dealer_contacts?dealer_id=${reqIn}&select=dealer_id,name,email,phone,cell,title,role`).catch(()=>[]),
        sbGet("manufacturers?select=slug,name").catch(()=>[]),
        sbGet(`dealer_manufacturers?dealer_id=${memIn}&select=dealer_id,manufacturer,account_ref,active`).catch(()=>[]),
      ]);
      // ---- Handout intelligence signals ----
      // (a) rep-set poor-fit exclusions (per LOCATION), (b) decayed engagement/intent per manufacturer
      // from the ordering portal (product views, repeat views, pricing views, order-page hits — already
      // rolled into dealer_intent.by_manufacturer), (c) fit-based cross-sell recommendations. All loaded
      // tolerantly so a missing table never breaks the handout.
      let exRows=[], intentRows=[], xsRows=[];
      try{ exRows=await sbGet(`dealer_handout_exclusions?dealer_id=${reqIn}&select=dealer_id,manufacturer`); }catch(e){ exRows=[]; }
      try{ intentRows=await sbGet(`dealer_intent?dealer_id=${memIn}&select=dealer_id,by_manufacturer`); }catch(e){ intentRows=[]; }
      try{ xsRows=await sbGet(`cross_sell?dealer_id=${memIn}&select=dealer_id,rec_slug,score`); }catch(e){ xsRows=[]; }
      const mfrName=Object.fromEntries((mfrs||[]).map(m=>[m.slug,m.name]));
      if(!mfrName["gce"]) mfrName["gce"]="Ohio Medical / GCE";  // DB may lack a GCE row; keep the label consistent with the rest
      const nameOf=s=>mfrName[s]||mfrName[normBuy(s)]||pretty(s);
      // Exclusions: matched set (normalized + raw) for filtering, plus the raw list to echo back to the UI.
      const exSetByDealer={}, exListByDealer={};
      for(const r of (exRows||[])){ const s=exSetByDealer[r.dealer_id]||(exSetByDealer[r.dealer_id]=new Set()); s.add(normBuy(r.manufacturer)); s.add(String(r.manufacturer||"").toLowerCase());
        (exListByDealer[r.dealer_id]||(exListByDealer[r.dealer_id]=[])).push(r.manufacturer); }
      // Engagement/intent per manufacturer — this location and rolled up to the company.
      const intentByDealer={}, intentByCo={};
      for(const r of (intentRows||[])){ const bm=(r&&r.by_manufacturer)||{}; const m=intentByDealer[r.dealer_id]||(intentByDealer[r.dealer_id]={});
        const cid=companyOf(r.dealer_id); const cm=intentByCo[cid]||(intentByCo[cid]={});
        for(const k in bm){ const sl=normBuy(k); const v=Number(bm[k])||0; if(v<=0) continue; m[sl]=(m[sl]||0)+v; cm[sl]=(cm[sl]||0)+v; } }
      // Fit-based cross-sell score per manufacturer — this location and rolled up to the company.
      const xsByDealer={}, xsByCo={};
      for(const r of (xsRows||[])){ if(!r||!r.rec_slug) continue; const sl=normBuy(r.rec_slug); const v=Number(r.score)||0;
        const m=xsByDealer[r.dealer_id]||(xsByDealer[r.dealer_id]={}); m[sl]=Math.max(m[sl]||0,v);
        const cid=companyOf(r.dealer_id); const cm=xsByCo[cid]||(xsByCo[cid]={}); cm[sl]=Math.max(cm[sl]||0,v); }
      const YR=String(new Date().getFullYear());
      const cutoff60=new Date(Date.now()-60*864e5).toISOString().slice(0,10);
      const cutoff120=new Date(Date.now()-120*864e5).toISOString().slice(0,10);
      const cutoff180=new Date(Date.now()-180*864e5).toISOString().slice(0,10);
      // aggregate sales + products per LOCATION (the primary figures), then roll totals up to
      // the company so a handout can show "this location vs the whole company".
      const byDealer={}; const prodByDealer={};
      for(const r of (sales||[])){
        const did=r.dealer_id; if(!did) continue;
        const d=byDealer[did]||(byDealer[did]={lines:{},total:0,ytd:0,recent:0,buys:new Set()});
        const slug=normBuy(r.manufacturer); const amt=Number(r.amount)||0; const per=(r.period||"").slice(0,10);
        const L=d.lines[slug]||(d.lines[slug]={name:nameOf(slug),amount:0,qty:0,orders:0,last:"",d60:0,d120:0,d180:0});
        L.amount+=amt; L.qty+=Number(r.qty)||0; L.orders+=1; if(per>L.last) L.last=per;
        if(per>=cutoff180){ L.d180+=amt; if(per>=cutoff120){ L.d120+=amt; if(per>=cutoff60) L.d60+=amt; } }
        d.total+=amt; if(per.startsWith(YR)) d.ytd+=amt; if(per>=cutoff60) d.recent+=amt; if(r.manufacturer) d.buys.add(slug);
        const pcode=String(r.product_code||"").trim(), pname=String(r.product_name||"").trim();
        if(pcode||pname){ const pk=(pcode||pname).toLowerCase(); const pd=prodByDealer[did]||(prodByDealer[did]={});
          const P=pd[pk]||(pd[pk]={code:pcode,name:pname||pcode,line:nameOf(slug),qty:0,amount:0,orders:0,last:"",d60:0,d120:0,d180:0});
          P.qty+=Number(r.qty)||0; P.amount+=amt; P.orders+=1; if(per>P.last) P.last=per;
          if(per>=cutoff180){ P.d180+=amt; if(per>=cutoff120){ P.d120+=amt; if(per>=cutoff60) P.d60+=amt; } } }
      }
      // company rollup: sum every location's totals + union their buys (for the comparison figure and opportunities)
      const coTotal={}, coYtd={}, coBuys={};
      for(const did in byDealer){ const cid=companyOf(did); const s=byDealer[did];
        coTotal[cid]=(coTotal[cid]||0)+s.total; coYtd[cid]=(coYtd[cid]||0)+s.ytd;
        const set=coBuys[cid]||(coBuys[cid]=new Set()); s.buys.forEach(x=>set.add(x)); }
      // real accounts on file BY COMPANY (union of account numbers across all locations)
      const acctByCo={};
      for(const x of (dm||[])){ if(x.active===false) continue; if(!(x.account_ref&&String(x.account_ref).trim())) continue;
        const cid=companyOf(x.dealer_id); const arr=acctByCo[cid]||(acctByCo[cid]=[]);
        if(!arr.some(a=>a.manufacturer===x.manufacturer&&a.account_ref===x.account_ref)) arr.push({manufacturer:x.manufacturer,account_ref:x.account_ref}); }
      const contactsByDealer={};
      for(const c of (contacts||[])){ (contactsByDealer[c.dealer_id]||(contactsByDealer[c.dealer_id]=[])).push(c); }
      const buySlugs=new Set(); for(const did in byDealer){ byDealer[did].buys.forEach(s=>buySlugs.add(s)); }
      const msrpByCode={};
      await Promise.all([...buySlugs].map(async slug=>{
        try{ const cat=await fetchJson(`${ORDERING_BASE}/data/${slug}.json`); (cat||[]).forEach(p=>{ if(p&&p.code){ const ms=Number(p.msrp)||0; if(ms>0) msrpByCode[String(p.code).toUpperCase()]=ms; } }); }catch(e){}
      }));
      let logoBySlug={};
      try{ const meta=await sbGet("manufacturer_meta?select=slug,logo_url"); (meta||[]).forEach(m=>{ if(m&&m.slug&&m.logo_url) logoBySlug[m.slug]=String(m.logo_url); }); }catch(e){}
      try{ const mm=await fetchJson(`${ORDERING_BASE}/data/manufacturers.json`); (mm||[]).forEach(m=>{ if(m&&m.slug&&m.logo&&!logoBySlug[m.slug]){ const p=String(m.logo); logoBySlug[m.slug]=p.startsWith("http")?p:(ORDERING_BASE+p); } }); }catch(e){}
      if(!logoBySlug["golden-technologies"]) logoBySlug["golden-technologies"]=ORDERING_BASE+"/assets/logos/golden-technologies.jpg";
      // Fallback logos from the public HCPS site (which this repo deploys) so lines missing a logo
      // in the ordering-site data — Access4U in particular — still render on the handout. The <img>
      // has onerror-hide, so a bad path degrades gracefully rather than showing a broken image.
      const PUBLIC_BASE=process.env.PUBLIC_SITE_BASE||"https://homecareproviderservices.netlify.app";
      const PUBLIC_LOGOS={access4u:"access4u.jpg","strongback-mobility":"strongback-mobility.jpg","airavant-bongorx":"airavant-bongorx.jpg",corsicana:"corsicana.jpg","ovation-medical":"ovation-medical.jpg",bemis:"bemis.jpg",pedifix:"pedifix.jpg","climbing-steps":"climbing-steps.jpg",gce:"ohio-medical.jpg","golden-technologies":"golden-technologies.jpg"};
      for(const sl in PUBLIC_LOGOS){ if(!logoBySlug[sl]) logoBySlug[sl]=`${PUBLIC_BASE}/assets/logos/${PUBLIC_LOGOS[sl]}`; }
      // GCE / Ohio Medical: the ordering-site data maps GCE to /assets/logos/gce.jpg, which isn't
      // hosted there, so the handout <img> 404s and the logo drops out. Force GCE (and its
      // ohio-medical alias) to the known-good logo THIS repo deploys, overriding the broken path.
      logoBySlug["gce"]=`${PUBLIC_BASE}/assets/logos/ohio-medical.jpg`;
      logoBySlug["ohio-medical"]=`${PUBLIC_BASE}/assets/logos/ohio-medical.jpg`;

      // ---- Regional sales trends (drives the per-visit crossover recommendation) ----
      // Aggregate the trailing-180-day sales of EVERY dealer by (state, manufacturer), split into a
      // recent 90-day half and the prior 90 so we can tell what's selling — and rising — in a dealer's
      // own state. Paged so a busy 6-month window isn't silently truncated at PostgREST's 1000-row cap.
      const cutoff90=new Date(Date.now()-90*864e5).toISOString().slice(0,10);
      const stateById=Object.fromEntries(allDealers.map(d=>[d.id,String(d.state||"").toUpperCase().trim()]));
      let recentRegion=[];
      try{ let from=0; for(;;){ const rows=await sbGet(`monthly_sales?period=gte.${cutoff180}&select=dealer_id,manufacturer,amount,period&order=id&limit=1000&offset=${from}`); recentRegion=recentRegion.concat(rows); if(rows.length<1000) break; from+=1000; if(from>=80000) break; } }catch(e){ recentRegion=[]; }
      const regRecent={}, regPrior={}, regTot={};
      for(const r of recentRegion){ const st=stateById[r.dealer_id]; if(!st) continue; const sl=normBuy(r.manufacturer); const amt=Number(r.amount)||0; const per=(r.period||"").slice(0,10); const k=st+"|"+sl;
        regTot[k]=(regTot[k]||0)+amt; if(per>=cutoff90) regRecent[k]=(regRecent[k]||0)+amt; else regPrior[k]=(regPrior[k]||0)+amt; }

      // ---- Assigned rep + email (dealer_directory dealer->rep, staff_users rep->email) ----
      let directory=[], staffU=[];
      try{ directory=await sbGet("dealer_directory?select=dealer_name,rep_name&limit=100000"); }catch(e){ directory=[]; }
      try{ staffU=await sbGet("staff_users?select=email,name,rep_name,active"); }catch(e){ staffU=[]; }
      const repByNorm={}; for(const x of (directory||[])){ const k=dnorm(x.dealer_name); if(k && x.rep_name && !(k in repByNorm)) repByNorm[k]=x.rep_name; }
      const repInfoByName={}; for(const s of (staffU||[])){ if(s.active===false) continue; const rn=String(s.rep_name||"").trim().toLowerCase(); if(rn && !(rn in repInfoByName)) repInfoByName[rn]={email:s.email||"",name:s.name||""}; }

      // Rotation seed: ISO week number — the crossover pick cycles through the top candidates over
      // successive visits (a different lead line week to week) while staying stable within one visit.
      const isoWeek=dt=>{ const t=new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate())); const day=(t.getUTCDay()+6)%7; t.setUTCDate(t.getUTCDate()-day+3); const f=new Date(Date.UTC(t.getUTCFullYear(),0,4)); const fd=(f.getUTCDay()+6)%7; f.setUTCDate(f.getUTCDate()-fd+3); return 1+Math.round((t-f)/(7*864e5)); };
      const weekSeed=isoWeek(new Date());
      const dhash=s=>{ s=String(s); let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h; };

      const cases={};
      for(const id of ids){
        const d=byId[id]; if(!d) continue;
        const cid=companyOf(id); const master=byId[cid]||d;   // company-level governing account
        let acc; try{ acc=computeAccess({state:master.state||d.state,business_name:master.business_name||d.business_name,ovation_access:!!(master.ovation_access||d.ovation_access),golden_status:(master.golden_status||d.golden_status||"None"),lat:null},[]); }catch(e){ acc={your_accounts:[],available:[],golden:"None"}; }
        const eligible=[...new Set([...(acc.your_accounts||[]),...(acc.available||[])])];
        const s=byDealer[id]||{lines:{},total:0,ytd:0,recent:0,buys:new Set()};
        const coBuySet=coBuys[cid]||new Set();
        // Poor-fit manufacturers the rep excluded for THIS location never appear on the handout —
        // not as a featured pick, not in "ways to grow". CRM/access are untouched (this is display only).
        const exSet=exSetByDealer[id]||new Set();
        const isExcluded=sl=>exSet.has(normBuy(sl))||exSet.has(String(sl).toLowerCase());
        const opps=eligible.filter(x=>!coBuySet.has(x)&&!isExcluded(x)).map(x=>({slug:x,name:nameOf(x),logo:logoBySlug[x]||""}));
        const r2=n=>Math.round((n||0)*100)/100;
        const lines=Object.entries(s.lines).map(([slug,v])=>({slug,name:v.name,amount:r2(v.amount),orders:v.orders,last:v.last,d60:r2(v.d60),d120:r2(v.d120),d180:r2(v.d180)})).sort((a,b)=>b.amount-a.amount);
        const allProds=Object.values(prodByDealer[id]||{}).sort((a,b)=>b.amount-a.amount);
        const products=allProds.slice(0,40).map(p=>({code:p.code,name:p.name,line:p.line,qty:p.qty,amount:r2(p.amount),orders:p.orders,last:p.last,d60:r2(p.d60),d120:r2(p.d120),d180:r2(p.d180)}));
        const products_more=Math.max(0,allProds.length-products.length);
        const accounts=(acctByCo[cid]||[]).map(a=>({slug:a.manufacturer,name:nameOf(a.manufacturer),account:a.account_ref})).sort((a,b)=>a.name.localeCompare(b.name));
        const carried=[...new Set(accounts.map(a=>a.slug))].map(sl=>({slug:sl,name:nameOf(sl),logo:logoBySlug[sl]||""}));

        // ---- One crossover recommendation for this visit ----
        // Primary: a line the dealer is approved for but nobody in the company buys, ranked by how
        // strongly it's selling in the dealer's own state, then rotated by week so the rep leads with
        // a different opportunity across visits. Fallback: a carried line that's moving regionally but
        // the dealer has gone quiet on (no order in 60 days) — a timely re-stock.
        const stCode=String(master.state||d.state||"").toUpperCase().trim();
        const rScore=sl=>(regRecent[stCode+"|"+sl]||0), rTot=sl=>(regTot[stCode+"|"+sl]||0), rPrior=sl=>(regPrior[stCode+"|"+sl]||0);
        // Blended opportunity score: the dealer's OWN engagement with a line (viewed/priced but not
        // bought) weighs highest, then fit-based cross-sell, then regional demand. All normalized within
        // this dealer's candidate pool so one big number can't dominate; rotates weekly among the top few.
        const intentM=sl=>{ const n=normBuy(sl); return (intentByDealer[id]&&intentByDealer[id][n])||(intentByCo[cid]&&intentByCo[cid][n])||0; };
        const xsM=sl=>{ const n=normBuy(sl); return (xsByDealer[id]&&xsByDealer[id][n])||(xsByCo[cid]&&xsByCo[cid][n])||0; };
        const maxI=Math.max(1e-9,...opps.map(o=>intentM(o.slug)));
        const maxX=Math.max(1e-9,...opps.map(o=>xsM(o.slug)));
        const maxR=Math.max(1e-9,...opps.map(o=>rScore(o.slug)));
        const WI=0.45, WX=0.30, WR=0.25;
        const blendedOf=o=>WI*(intentM(o.slug)/maxI)+WX*(xsM(o.slug)/maxX)+WR*(rScore(o.slug)/maxR);
        let crossover=null;
        const oppRanked=opps.map(o=>({...o,score:rScore(o.slug),tot:rTot(o.slug),intent:intentM(o.slug),xs:xsM(o.slug),blended:blendedOf(o)}))
          .sort((a,b)=>b.blended-a.blended||b.score-a.score||b.tot-a.tot||String(a.name).localeCompare(String(b.name)));
        if(oppRanked.length){
          const pool=oppRanked.slice(0,Math.min(5,oppRanked.length));
          const pick=pool[(weekSeed+dhash(id))%pool.length];
          const rising=rScore(pick.slug)>rPrior(pick.slug);
          const nI=pick.intent/maxI, nX=pick.xs/maxX, nR=pick.score/maxR;
          let reason, basis;
          if(pick.intent>0 && nI>=nX && nI>=nR){
            basis="engagement";
            reason=`Your team keeps looking at ${pick.name} on the ordering portal but hasn't ordered it yet — a timely opening to bring it up.`;
          } else if(pick.score>0 && nR>=nX){
            basis="regional";
            reason=`Dealers across ${stCode||"your area"} are ordering ${pick.name}${rising?" — and demand is trending up":""}. You're approved to carry it but aren't stocking it yet.`;
          } else if(pick.xs>0){
            basis="fit";
            reason=`${pick.name} is a natural fit alongside the lines you already carry — a strong cross-sell to add next.`;
          } else {
            basis="fit";
            reason=`Approved for your territory and a natural complement to the lines you already carry — a strong candidate to add next.`;
          }
          crossover={ kind:"new_line", name:pick.name, slug:pick.slug, logo:pick.logo||logoBySlug[pick.slug]||"",
            region_amt:r2(pick.score), basis, reason };
        }
        if(!crossover){
          const gaps=lines.filter(L=>(L.d60||0)===0 && rScore(L.slug)>0 && !isExcluded(L.slug)).map(L=>({...L,score:rScore(L.slug)})).sort((a,b)=>b.score-a.score);
          if(gaps.length){ const g=gaps.slice(0,Math.min(5,gaps.length))[(weekSeed+dhash(id))%Math.min(5,gaps.length)];
            crossover={ kind:"reorder", name:g.name, slug:g.slug, logo:logoBySlug[g.slug]||"", region_amt:r2(g.score), basis:"reorder",
              reason:`${g.name} is moving across ${stCode||"your area"} right now, but you haven't reordered in 60+ days — a timely re-stock while demand is up.` }; }
        }

        // ---- Assigned rep for THIS dealer (may differ from whoever prints the handout) ----
        const assignedRep=repByNorm[dnorm(master.business_name||"")]||repByNorm[dnorm(d.business_name||"")]||"";
        const repInfo=assignedRep?(repInfoByName[assignedRep.toLowerCase()]||null):null;

        let retail=0; const pd=prodByDealer[id]||{};
        for(const k in pd){ const P=pd[k]; const ms=msrpByCode[String(P.code||"").toUpperCase()]; if(ms&&P.qty) retail+=ms*P.qty; }
        const multiLoc=(membersOfCompany[cid]||[]).length>1;
        cases[id]={
          name:d.business_name||"", account:d.hcps_account||"", contact_name:d.contact_name||"", email:d.email||"", phone:d.phone||"",
          address:d.address||"", city:d.city||"", state:d.state||"", zip:d.zip||"",
          company:(master.business_name||d.business_name||""), is_branch:!!d.parent_id, multi_location:multiLoc,
          total:Math.round((s.total||0)*100)/100, ytd:Math.round((s.ytd||0)*100)/100, recent60:Math.round((s.recent||0)*100)/100,
          company_total:Math.round((coTotal[cid]||0)*100)/100, company_ytd:Math.round((coYtd[cid]||0)*100)/100,
          retail_value:Math.round(retail*100)/100,
          lines, opps, accounts, carried, products, products_more, crossover,
          excluded:(exListByDealer[id]||[]).map(sl=>({slug:sl,name:nameOf(sl),logo:logoBySlug[sl]||logoBySlug[normBuy(sl)]||""})),
          rep_name:assignedRep||"", rep_email:(repInfo&&repInfo.email)||"",
          golden:(acc.golden||master.golden_status||d.golden_status||"None"), golden_logo:(logoBySlug["golden-technologies"]||""), ovation:!!(master.ovation_access||d.ovation_access),
          contacts:(contactsByDealer[id]||[]).map(c=>({name:c.name||"",email:c.email||"",phone:c.phone||"",cell:c.cell||"",title:c.title||"",role:c.role||""})),
        };
      }
      return json(200,{ok:true,cases});
    }

    // ---------- Visited log ----------
    if(b.action==="log_visit"){
      if(!b.dealer_id) return json(400,{error:"dealer_id required"});
      const ins=await sbSend("POST","dealer_visits",{dealer_id:b.dealer_id,rep_name:me.rep_name||null,owner_email:me.email||null,visited_at:new Date().toISOString(),notes:(b.notes!=null?String(b.notes):null)},{Prefer:"return=representation"});
      return json(200,{ok:true,visited_at:(ins&&ins[0]&&ins[0].visited_at)||new Date().toISOString()});
    }

    // ---------- Editable app settings (e.g. the dealer-handout news) ----------
    if(b.action==="get_settings"){
      const key=String(b.key||"").trim(); if(!key) return json(400,{error:"key required"});
      const rows=await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value`).catch(()=>[]);
      return json(200,{ok:true,value:(rows&&rows[0]&&rows[0].value)||null});
    }
    if(b.action==="set_settings"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const key=String(b.key||"").trim(); if(!key) return json(400,{error:"key required"});
      await sbSend("POST","app_settings?on_conflict=key",{key,value:b.value||{},updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true});
    }

    // ---------- Dealer-handout manufacturer exclusions ----------
    // A rep (on their own accounts) or management can mark a manufacturer as a POOR FIT for a
    // specific dealer location, so it never appears as the handout's featured pick or in "ways to
    // grow" — WITHOUT touching the CRM relationship or the dealer's line access. Per-location only.
    const MGMT_ROLES=new Set(["president","admin","owner","relations"]);
    if(b.action==="list_handout_exclusions"){
      const did=String(b.dealer_id||"").trim(); if(!did) return json(400,{error:"dealer_id required"});
      const rows=await sbGet(`dealer_handout_exclusions?dealer_id=eq.${encodeURIComponent(did)}&select=manufacturer`).catch(()=>[]);
      return json(200,{ok:true,excluded:(rows||[]).map(r=>r.manufacturer)});
    }
    if(b.action==="set_handout_exclusion"){
      const did=String(b.dealer_id||"").trim(); const slug=String(b.manufacturer||"").trim(); const on=!!b.excluded;
      if(!did||!slug) return json(400,{error:"dealer_id and manufacturer required"});
      // Permission: management anywhere, or the rep this dealer is assigned to (dealers.rep_name).
      const dr=await sbGet(`dealers?id=eq.${encodeURIComponent(did)}&select=id,rep_name`).catch(()=>[]);
      const dealer=dr&&dr[0]; if(!dealer) return json(404,{error:"dealer not found"});
      const mgr=MGMT_ROLES.has(String(me.role||"").toLowerCase());
      const ownsIt=!!me.rep_name && String(dealer.rep_name||"").trim().toLowerCase()===String(me.rep_name).trim().toLowerCase();
      if(!mgr && !ownsIt) return json(403,{error:"not your account"});
      if(on){ await sbSend("POST","dealer_handout_exclusions?on_conflict=dealer_id,manufacturer",{dealer_id:did,manufacturer:slug,created_by:me.email||me.name||null,created_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
      else { await sbSend("DELETE",`dealer_handout_exclusions?dealer_id=eq.${encodeURIComponent(did)}&manufacturer=eq.${encodeURIComponent(slug)}`,null,{Prefer:"return=minimal"}); }
      return json(200,{ok:true,excluded:on});
    }

    // ---------- Scheduled Routes: mobile field-visit day view + per-dealer visit reports ----------
    // route_day returns the rep's route for a date (or a specific route) with stops enriched with
    // dealer contact info and the current visit status per stop. visit_checkin stamps arrival.
    // visit_report_save upserts the structured report and, on completion, writes through to the CRM
    // (touch + tasks + opportunities) exactly like save_visit. Reps see only their own routes.
    const ownsRoute=r=> canViewRoute(me,r);   // working a route needs view rights, not ownership
    if(b.action==="route_day"){
      let route=null;
      if(b.route_id){
        const rows=await sbGet(`rep_routes?id=eq.${encodeURIComponent(b.route_id)}&select=*`).catch(()=>[]);
        route=(rows&&rows[0])||null;
        if(route && !ownsRoute(route)) return json(403,{error:"not your route"});
      } else {
        const date=(b.date&&/^\d{4}-\d{2}-\d{2}$/.test(b.date))?b.date:new Date().toISOString().slice(0,10);
        const own=isBoss(me)?"":"&"+mineFilter(me);
        const rows=await sbGet(`rep_routes?scheduled_date=eq.${date}${own}&select=*&order=updated_at.desc&limit=1`).catch(()=>[]);
        route=(rows&&rows[0])||null;
      }
      if(!route) return json(200,{ok:true,route:null,stops:[]});
      const stops=Array.isArray(route.stops)?route.stops:[];
      const ids=[...new Set(stops.map(s=>s.dealer_id).filter(Boolean))];
      let dmap={},cmap={},vmap={};
      if(ids.length){
        try{ const ds=await sbGet(`dealers?id=in.(${ids.join(",")})&select=id,business_name,contact_name,email,phone,address,city,state,zip`); for(const d of (ds||[])) dmap[d.id]=d; }catch(e){}
        try{ const cs=await sbGet(`dealer_contacts?dealer_id=in.(${ids.join(",")})&select=dealer_id,name,email,phone,cell`); for(const c of (cs||[])){ if(!cmap[c.dealer_id]) cmap[c.dealer_id]=c; } }catch(e){}
      }
      try{ const vr=await sbGet(`dealer_visit_reports?route_id=eq.${encodeURIComponent(route.id)}&select=dealer_id,status,checkin_at,completed_at`); for(const v of (vr||[])) vmap[v.dealer_id]=v; }catch(e){}
      const outStops=stops.map((s,i)=>{ const d=dmap[s.dealer_id]||{}, c=cmap[s.dealer_id]||{}, v=vmap[s.dealer_id]||null;
        return { order:i, dealer_id:s.dealer_id||"", name:s.name||d.business_name||"",
          address:s.address||d.address||"", city:s.city||d.city||"", state:s.state||d.state||"", zip:s.zip||d.zip||"",
          lat:s.lat, lng:s.lng, visit_min:(s.visit_min!=null?s.visit_min:null),
          contact_name:(c.name||d.contact_name||""), contact_email:(c.email||d.email||""), contact_phone:(c.phone||c.cell||d.phone||""),
          visit: v?{status:v.status,checkin_at:v.checkin_at,completed_at:v.completed_at}:null }; });
      const hb=resolveHomeBase(route,me);
      return json(200,{ok:true,
        route:{id:route.id,name:route.name,scheduled_date:route.scheduled_date,
          home_base:hb, home_base_source:hb?hb.source:null,
          needs_home_base:!hb,
          round_trip:route.round_trip,distance_m:route.distance_m,duration_s:route.duration_s,geometry:route.geometry,
          assigned_to_rep:route.assigned_to_rep||null, assigned_to_email:route.assigned_to_email||null,
          planned_by:(route.assigned_to_email&&!emailEq(route.assigned_to_email,route.owner_email))
            ?(route.rep_name||route.owner_email||"the office"):null,
          can_manage:canManageRoute(me,route)},
        stops:outStops});
    }
    if(b.action==="visit_checkin"){
      const rid=String(b.route_id||"").trim()||null, did=String(b.dealer_id||"").trim();
      if(!did) return json(400,{error:"dealer_id required"});
      let sd=null;
      if(rid){ const rr=await sbGet(`rep_routes?id=eq.${encodeURIComponent(rid)}&select=scheduled_date,owner_email,assigned_to_email`).catch(()=>[]); const r=rr&&rr[0]; if(r){ if(!ownsRoute(r)) return json(403,{error:"not your route"}); sd=r.scheduled_date||null; } }
      const now=new Date().toISOString();
      const row={ route_id:rid, dealer_id:did, rep_email:me.email||null, rep_name:me.rep_name||null, scheduled_date:sd, checkin_at:now, status:"checked_in", updated_at:now };
      if(rid){ await sbSend("POST","dealer_visit_reports?on_conflict=route_id,dealer_id",row,{Prefer:"resolution=merge-duplicates,return=minimal"}); }
      else { await sbSend("POST","dealer_visit_reports",row,{Prefer:"return=minimal"}); }
      return json(200,{ok:true,checkin_at:now});
    }
    if(b.action==="visit_report_get"){
      const rid=String(b.route_id||"").trim(), did=String(b.dealer_id||"").trim();
      if(!did) return json(400,{error:"dealer_id required"});
      const path = rid
        ? `dealer_visit_reports?route_id=eq.${encodeURIComponent(rid)}&dealer_id=eq.${encodeURIComponent(did)}&select=*&limit=1`
        : `dealer_visit_reports?dealer_id=eq.${encodeURIComponent(did)}&select=*&order=updated_at.desc&limit=1`;
      const rows=await sbGet(path).catch(()=>[]);
      return json(200,{ok:true,report:(rows&&rows[0])||null});
    }
    if(b.action==="visit_report_save"){
      const rid=String(b.route_id||"").trim()||null, did=String(b.dealer_id||"").trim();
      if(!did) return json(400,{error:"dealer_id required"});
      const fields=(b.fields&&typeof b.fields==="object")?b.fields:{};
      const status=String(b.status||"in_progress");
      const completed = status==="completed";
      const now=new Date().toISOString();
      let sd=null;
      if(rid){ const rr=await sbGet(`rep_routes?id=eq.${encodeURIComponent(rid)}&select=scheduled_date,owner_email,assigned_to_email`).catch(()=>[]); const r=rr&&rr[0]; if(r){ if(!ownsRoute(r)) return json(403,{error:"not your route"}); sd=r.scheduled_date||null; } }
      const row={ route_id:rid, dealer_id:did, rep_email:me.email||null, rep_name:me.rep_name||null, scheduled_date:sd, status, fields, updated_at:now };
      if(b.transcript!=null) row.transcript=String(b.transcript);
      if(b.structured&&typeof b.structured==="object") row.structured=b.structured;
      if(completed) row.completed_at=now;
      if(rid){ await sbSend("POST","dealer_visit_reports?on_conflict=route_id,dealer_id",row,{Prefer:"resolution=merge-duplicates,return=minimal"}); }
      else { await sbSend("POST","dealer_visit_reports",row,{Prefer:"return=minimal"}); }
      let tCreated=0,oCreated=0;
      if(completed){
        const dr=await sbGet(`dealers?id=eq.${encodeURIComponent(did)}&select=business_name,is_test`).catch(()=>[]);
        const d=(dr&&dr[0])||{}; const st=await P.getState(); const env=P.envFor(st.mode,d.is_test);
        const repName=me.name||me.rep_name||"HCPS rep";
        try{ await sbSend("POST","dealer_visits",{dealer_id:did,rep_name:me.rep_name||null,owner_email:me.email||null,visited_at:now,notes:visitNotesSummary(fields),details:fields,env},{Prefer:"return=minimal"}); }catch(e){}
        const tasks=[];
        for(const f of followupList(fields.followups)){ const t=String(f).trim(); if(t) tasks.push({dealer_id:did,title:`Follow-up: ${t.slice(0,120)}`,detail:"From dealer visit",source:"visit",reason:"visit_followup",priority:"normal",assigned_rep:me.rep_name||null,created_by:repName,status:"open",env}); }
        const na=String(fields.next_action||"").trim();
        if(na){ const t={dealer_id:did,title:`Next action: ${na.slice(0,120)}`,detail:"From dealer visit",source:"visit",reason:"visit_next_action",priority:"normal",assigned_rep:me.rep_name||null,created_by:repName,status:"open",env}; if(/^\d{4}-\d{2}-\d{2}$/.test(String(fields.next_action_date||""))) t.due_date=fields.next_action_date; tasks.push(t); }
        if(tasks.length){ try{ await sbSend("POST","dealer_tasks",tasks,{Prefer:"return=minimal"}); tCreated=tasks.length; }catch(e){} }
        const oppRows=followupList(fields.opportunities).map(x=>String(x).trim()).filter(Boolean).map(x=>({dealer_id:did,title:x.slice(0,140),stage:"identified",source:"visit",owner_rep:me.rep_name||null,created_by:repName,notes:"From dealer visit",status:"open"}));
        if(oppRows.length){ try{ await sbSend("POST","opportunities",oppRows,{Prefer:"return=minimal"}); oCreated=oppRows.length; }catch(e){} }
        // Structured intelligence from a voice/AI-parsed visit: feed product-interest signals and
        // set poor-fit handout exclusions (both keyed to manufacturer slugs the rep reviewed).
        const S=(b.structured&&typeof b.structured==="object")?b.structured:{};
        const interestSlugs=Array.isArray(S.interest_slugs)?[...new Set(S.interest_slugs.map(x=>String(x||"").trim()).filter(Boolean))]:[];
        if(interestSlugs.length){ const evRows=interestSlugs.map(sl=>({dealer_id:did,manufacturer:sl,product_code:null,event_type:"visit_interest",weight:10,source:"visit",env,meta:{via:"scheduled_routes"},occurred_at:now})); try{ await sbSend("POST","intent_events",evRows,{Prefer:"return=minimal"}); }catch(e){} }
        const poorSlugs=Array.isArray(S.poor_fit_slugs)?[...new Set(S.poor_fit_slugs.map(x=>String(x||"").trim()).filter(Boolean))]:[];
        if(poorSlugs.length){ const exRows=poorSlugs.map(sl=>({dealer_id:did,manufacturer:sl,created_by:me.email||me.name||null,created_at:now})); try{ await sbSend("POST","dealer_handout_exclusions?on_conflict=dealer_id,manufacturer",exRows,{Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){} }
      }
      return json(200,{ok:true,status,completed_at:completed?now:null,tasks:tCreated,opportunities:oCreated});
    }

    // ---------- Visit notes → tasks + opportunities (Phase 4) ----------
    if(b.action==="save_visit"){
      const dealer_id=b.dealer_id; if(!dealer_id) return json(400,{error:"dealer_id required"});
      const details=(b.details&&typeof b.details==="object")?b.details:{};
      const summary=String(b.summary||details.summary||"").trim()||null;
      const dr=await sbGet(`dealers?id=eq.${encodeURIComponent(dealer_id)}&select=business_name,is_test`).catch(()=>[]);
      const d=(dr&&dr[0])||{};
      const st=await P.getState(); const env=P.envFor(st.mode,d.is_test);
      const repName=me.name||me.rep_name||"HCPS rep";
      try{ await sbSend("POST","dealer_visits",{dealer_id,rep_name:me.rep_name||null,owner_email:me.email||null,visited_at:new Date().toISOString(),notes:summary,details,env},{Prefer:"return=minimal"}); }catch(e){}
      // follow-up items -> tasks; order-expected & next-visit -> tasks
      const tasks=[];
      for(const f of followupList(details.follow_ups)){ const t=String(f).trim(); if(t) tasks.push({dealer_id,title:`Follow-up: ${t.slice(0,120)}`,detail:"From dealer visit",source:"visit",reason:"visit_followup",priority:"normal",assigned_rep:me.rep_name||null,created_by:repName,status:"open",env}); }
      if(String(details.orders_expected||"").trim()) tasks.push({dealer_id,title:`Expected order — ${d.business_name||"dealer"}`,detail:String(details.orders_expected).slice(0,200),source:"visit",reason:"visit_order",priority:"high",assigned_rep:me.rep_name||null,created_by:repName,status:"open",env});
      if(/^\d{4}-\d{2}-\d{2}$/.test(String(details.next_visit||""))) tasks.push({dealer_id,title:`Next visit — ${d.business_name||"dealer"}`,detail:"Scheduled from visit notes",due_date:details.next_visit,source:"visit",reason:"visit_next",priority:"normal",assigned_rep:me.rep_name||null,created_by:repName,status:"open",env});
      let tCreated=0; if(tasks.length){ try{ await sbSend("POST","dealer_tasks",tasks,{Prefer:"return=minimal"}); tCreated=tasks.length; }catch(e){} }
      // manufacturer opportunities -> opportunities (pipeline)
      const oppRows=followupList(details.opportunities).map(x=>String(x).trim()).filter(Boolean).map(x=>({dealer_id,title:x.slice(0,140),stage:"identified",source:"visit",owner_rep:me.rep_name||null,created_by:repName,notes:"From dealer visit",status:"open"}));
      let oCreated=0; if(oppRows.length){ try{ await sbSend("POST","opportunities",oppRows,{Prefer:"return=minimal"}); oCreated=oppRows.length; }catch(e){} }
      return json(200,{ok:true,tasks:tCreated,opportunities:oCreated});
    }
    if(b.action==="generate_followup"){
      const details=(b.details&&typeof b.details==="object")?b.details:{};
      let dealerName="there";
      if(b.dealer_id){ const dr=await sbGet(`dealers?id=eq.${encodeURIComponent(b.dealer_id)}&select=business_name,contact_name`).catch(()=>[]); if(dr&&dr[0]) dealerName=dr[0].contact_name||dr[0].business_name||"there"; }
      const fu=buildFollowup(dealerName,me.name||me.rep_name||"your HCPS rep",details);
      return json(200,{ok:true,subject:fu.subject,body:fu.body});
    }
    if(b.action==="send_followup"){
      const dealer_id=b.dealer_id; if(!dealer_id) return json(400,{error:"dealer_id required"});
      const subject=String(b.subject||"").trim()||"Following up from your HCPS visit";
      const body=String(b.body||"").trim(); if(!body) return json(400,{error:"empty message"});
      const dr=await sbGet(`dealers?id=eq.${encodeURIComponent(dealer_id)}&select=business_name,email,is_test`).catch(()=>[]);
      const d=dr&&dr[0]; if(!d) return json(404,{error:"dealer not found"});
      const to=String(d.email||"").trim(); if(!EMAIL_RE.test(to)) return json(200,{ok:false,message:"No email on file for this dealer."});
      const opt=await sbGet(`email_optout?email=eq.${encodeURIComponent(to.toLowerCase())}&select=email`).catch(()=>[]);
      if(opt&&opt[0]) return json(200,{ok:false,message:"This dealer has opted out of emails."});
      const st=await P.getState();
      if(!P.allowTransactional(st.mode,d.is_test)) return json(200,{ok:true,held:true,message:`Prepared — this will send once the platform is Live (currently ${st.mode}).`});
      const res=await sendMail({to,subject,html:followupHtml(body,me.name||me.rep_name||""),text:body,replyTo:me.email||""});
      if(res&&res.ok){
        try{ await sbSend("POST","email_sends",{dealer_id,contact_email:to,template:"visit_followup",env:P.envFor(st.mode,d.is_test)},{Prefer:"return=minimal"}); }catch(e){}
        try{ await sbSend("POST","dealer_activity",{dealer_id,kind:"email",subject:"Visit follow-up sent",contact_email:to,actor:me.name||me.rep_name||"rep"},{Prefer:"return=minimal"}); }catch(e){}
        return json(200,{ok:true,sent:true});
      }
      return json(200,{ok:false,message:(res&&res.skipped)?"Email isn't configured yet (RESEND_API_KEY).":"Couldn't send — try again."});
    }

    // ---------- Dealer visit notification (optional, rep-initiated) ----------
    if(b.action==="notify_visit"){
      const dealer_id=b.dealer_id; if(!dealer_id) return json(400,{error:"dealer_id required"});
      const dateStr=String(b.date||"").trim();
      const rows=await sbGet(`dealers?id=eq.${encodeURIComponent(dealer_id)}&select=business_name,contact_name,email,is_test`).catch(()=>[]);
      const d=rows&&rows[0]; if(!d) return json(404,{error:"dealer not found"});
      const toEmail=String(d.email||"").trim();
      if(!EMAIL_RE.test(toEmail)) return json(200,{ok:false,message:"No email on file for this dealer — add one in Dealer Manager."});
      const opt=await sbGet(`email_optout?email=eq.${encodeURIComponent(toEmail.toLowerCase())}&select=email`).catch(()=>[]);
      if(opt&&opt[0]) return json(200,{ok:false,message:"This dealer has opted out of emails."});
      // Mode gate: reaches a real dealer only when Live; before that it's prepared, not sent.
      const st=await P.getState();
      if(!P.allowTransactional(st.mode,d.is_test)) return json(200,{ok:true,held:true,message:`Prepared — this will send once the platform is Live (currently ${st.mode}).`});
      const repName=me.name||me.rep_name||"your HCPS representative";
      const res=await sendMail(visitEmail(toEmail,d,dateStr,repName,me.email));
      if(res&&res.ok){
        try{ await sbSend("POST","email_sends",{dealer_id,contact_email:toEmail,template:"visit_notice",env:P.envFor(st.mode,d.is_test)},{Prefer:"return=minimal"}); }catch(e){}
        try{ await sbSend("POST","dealer_activity",{dealer_id,kind:"email",subject:"Upcoming-visit notice sent",contact_email:toEmail,actor:repName},{Prefer:"return=minimal"}); }catch(e){}
        return json(200,{ok:true,sent:true});
      }
      return json(200,{ok:false,message:(res&&res.skipped)?"Email isn't configured yet (RESEND_API_KEY).":"Couldn't send — try again."});
    }

    // ---------- Pre-visit heads-up DRAFT (review-before-send) ----------
    // Builds the "we'll be in your area" note — scheduled date, estimated arrival, rep contact, a
    // low-pressure reason, and (optionally) a relevant opportunity — and RETURNS it for the rep to
    // review and send from their own Outlook. Nothing is sent here.
    if(b.action==="previsit_draft"){
      const dealer_id=b.dealer_id; if(!dealer_id) return json(400,{error:"dealer_id required"});
      const rows=await sbGet(`dealers?id=eq.${encodeURIComponent(dealer_id)}&select=business_name,contact_name,email`).catch(()=>[]);
      const d=rows&&rows[0]; if(!d) return json(404,{error:"dealer not found"});
      const repName=me.name||me.rep_name||"your HCPS representative";
      const dateStr=String(b.date||"").trim();
      const when = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? prettyDate(dateStr) : "";
      const eta = String(b.eta||"").trim();
      const opp = String(b.opportunity||"").trim();
      const first = String(d.contact_name||"").split(/\s+/)[0]||"";
      const greet = first?`Hi ${first},`:"Hi there,";
      const arrive = eta
        ? `I expect to be in your area${when?` on ${when}`:""} around ${eta}`
        : (when?`I'm planning to be in your area on ${when}`:"I'm planning to be in your area soon");
      const oppLine = opp ? `\n\nWhile I'm there I'd also like to show you ${opp} — I think it could be a good fit for your business.` : "";
      const body = `${greet}\n\nThis is ${repName} with HomeCare Provider Services. ${arrive}, and I'd love to stop by for a few minutes to review how things are going and make sure your lines and pricing are set up the way you need.${oppLine}\n\nThe arrival time is an estimate — I'll be moving between accounts that day — but I'll do my best to reach you close to then. If a different time works better, just reply and let me know.\n\nLooking forward to seeing you.`;
      const subject = `HCPS will be in your area${when?` — ${when}`:""}`;
      const signature = `${repName}${me.email?` · ${me.email}`:""}\nHomeCare Provider Services`;
      return json(200,{ok:true, to:String(d.email||""), subject, body, signature});
    }

    // ---------- Email the rep the mobile Scheduled Routes link (for add-to-home-screen) ----------
    if(b.action==="email_mobile_link"){
      const to=String(me.email||"").trim();
      if(!EMAIL_RE.test(to)) return json(200,{ok:false,message:"No email on file for your account — ask an admin to add it."});
      const base=process.env.PUBLIC_SITE_BASE||"https://homecareproviderservices.netlify.app";
      const url=base+"/admin/scheduled-routes.html";
      const html=`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px;font-size:14px;line-height:1.6">
        <h2 style="color:#2B4071;margin:0 0 6px">Your HCPS Scheduled Routes</h2>
        <p style="margin:0 0 12px">Open this on your phone and add it to your home screen so your day's dealer visits are one tap away:</p>
        <p style="margin:0 0 16px"><a href="${url}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px">Open Scheduled Routes &rarr;</a></p>
        <p style="margin:0 0 4px;font-weight:700;color:#2B4071">iPhone (Safari)</p>
        <p style="margin:0 0 12px;color:#374151">Open the link in <b>Safari</b> &rarr; tap the <b>Share</b> button &rarr; <b>Add to Home Screen</b>.</p>
        <p style="margin:0 0 4px;font-weight:700;color:#2B4071">Android (Chrome)</p>
        <p style="margin:0 0 12px;color:#374151">Open the link in <b>Chrome</b> &rarr; tap the <b>⋮</b> menu &rarr; <b>Add to Home screen</b> / <b>Install app</b>.</p>
        <p style="margin:0 0 0;color:#6b7280;font-size:12.5px">You'll sign in once with your HCPS email and password; after that it stays signed in. — HomeCare Provider Services</p>
      </div>`;
      const text=`Your HCPS Scheduled Routes\n\nOpen on your phone and add to your home screen:\n${url}\n\niPhone (Safari): open in Safari, tap Share, then Add to Home Screen.\nAndroid (Chrome): open in Chrome, tap the menu, then Add to Home screen / Install app.\n\nSign in once with your HCPS email and password.`;
      const res=await sendMail({to,subject:"Your HCPS Scheduled Routes — add to your phone",html,text});
      if(res&&res.ok) return json(200,{ok:true,sent:true,to});
      return json(200,{ok:false,message:(res&&res.skipped)?"Email isn't configured yet (RESEND_API_KEY).":"Couldn't send — try again."});
    }

    // ---------- Direct Outlook calendar write (create/update master + per-dealer visit events) ----------
    // Writes into the route owner's Outlook calendar and stores the Graph event IDs on the route, so a
    // later re-sync PATCHes the same events (reschedules stay in sync) and removed stops are deleted.
    // Needs the Graph app to have Calendars.ReadWrite (admin consent). `times` = {dealer_id: epoch_ms}.
    if(b.action==="route_calendar_sync"){
      const rid=String(b.route_id||"").trim(); if(!rid) return json(400,{error:"route_id required"});
      const rows=await sbGet(`rep_routes?id=eq.${encodeURIComponent(rid)}&select=*`).catch(()=>[]);
      const route=rows&&rows[0]; if(!route) return json(404,{error:"route not found"});
      if(!ownsRoute(route)) return json(403,{error:"not your route"});
      if(!G_TENANT||!G_CLIENT||!G_SECRET) return json(200,{ok:false,error:"graph_env_missing",message:"Outlook isn't configured yet (GRAPH_* env vars)."});
      const mailbox=String(route.owner_email||me.email||"").toLowerCase().trim();
      if(!EMAIL_RE.test(mailbox)) return json(200,{ok:false,message:"No Outlook mailbox on file for this route's owner."});
      const stops=Array.isArray(route.stops)?route.stops:[];
      const times=(b.times&&typeof b.times==="object")?b.times:{};
      const base=process.env.PUBLIC_SITE_BASE||"https://homecareproviderservices.netlify.app";
      const routeLink=base+"/admin/scheduled-routes.html?route="+encodeURIComponent(rid);
      const dealerLink=id=>base+"/admin/dealer.html?dealer="+encodeURIComponent(id);
      const ids=[...new Set(stops.map(s=>s.dealer_id).filter(Boolean))];
      let dmap={},cmap={},rmap={};
      if(ids.length){
        try{ const ds=await sbGet(`dealers?id=in.(${ids.join(",")})&select=id,business_name,contact_name,email,phone,address,city,state,zip`); for(const d of (ds||[])) dmap[d.id]=d; }catch(e){}
        try{ const cs=await sbGet(`dealer_contacts?dealer_id=in.(${ids.join(",")})&select=dealer_id,name,email,phone,cell`); for(const c of (cs||[])){ if(!cmap[c.dealer_id]) cmap[c.dealer_id]=c; } }catch(e){}
        try{ const vr=await sbGet(`dealer_visit_reports?route_id=eq.${encodeURIComponent(rid)}&select=dealer_id,fields`); for(const v of (vr||[])) rmap[v.dealer_id]=v.fields||{}; }catch(e){}
      }
      const fmt=ms=>new Date(ms).toISOString().slice(0,19);           // UTC instant, paired with timeZone:"UTC"
      const nextDay=ds=>{ const d=new Date(ds+"T00:00:00Z"); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10); };
      const arr=v=>Array.isArray(v)?v.filter(Boolean).join(", "):String(v||"");
      const addrOf=(s,d)=>[s.address||d.address,s.city||d.city,(s.state||d.state),(s.zip||d.zip)].filter(Boolean).join(", ");
      function visitBody(s,i){ const d=dmap[s.dealer_id]||{},c=cmap[s.dealer_id]||{},f=rmap[s.dealer_id]||{};
        const contact=(c.name||d.contact_name||""), phone=(c.phone||c.cell||d.phone||""); const p=[];
        p.push(`<b>Stop ${i+1} of ${stops.length}</b> · ${esc2(route.name||"route")}`);
        if(contact) p.push(`Contact: ${esc2(contact)}${phone?" · "+esc2(phone):""}`);
        const ad=addrOf(s,d); if(ad) p.push(`Address: ${esc2(ad)}`);
        if(f.purpose) p.push(`Purpose: ${esc2(f.purpose)}`);
        const md=[arr(f.manufacturers),arr(f.products)].filter(Boolean).join(" — "); if(md) p.push(`To discuss: ${esc2(md)}`);
        if(arr(f.opportunities)) p.push(`Opportunity: ${esc2(arr(f.opportunities))}`);
        p.push(`<a href="${dealerLink(s.dealer_id)}">Open Dealer 360</a> · <a href="${routeLink}">Open route</a>`);
        return p.join("<br>");
      }
      let tok; try{ tok=await graphToken(); }catch(e){ return json(200,{ok:false,error:"graph_token",message:"Couldn't authenticate to Outlook — check the Graph app credentials."}); }
      const prev=(route.calendar&&typeof route.calendar==="object"&&String(route.calendar.mailbox||"").toLowerCase()===mailbox)?route.calendar:{mailbox,master_id:null,events:{}};
      const newCal={mailbox,master_id:prev.master_id||null,events:{},updated_at:new Date().toISOString()};
      const denied=res=>res&&res.status===403;
      // ---- master route event ----
      const tlist=stops.map(s=>times[s.dealer_id]).filter(x=>x);
      const summary=stops.map((s,i)=>`${i+1}. ${esc2((dmap[s.dealer_id]&&dmap[s.dealer_id].business_name)||s.name||"")}`).join("<br>");
      const master={ subject:"Route: "+(route.name||"Sales route"),
        body:{contentType:"HTML",content:`${route.round_trip?"Round trip. ":""}${route.duration_s?Math.round(route.duration_s/60)+" min driving. ":""}${stops.length} stops.<br><br>${summary}${route.notes?"<br><br>Notes: "+esc2(route.notes):""}<br><br><a href="${routeLink}">Open route</a>`} };
      if(tlist.length){ const start=Math.min.apply(null,tlist); const lastArr=Math.max.apply(null,tlist);
        const lastVisit=(stops[stops.length-1]&&stops[stops.length-1].visit_min!=null?stops[stops.length-1].visit_min:30);
        master.isAllDay=false; master.start={dateTime:fmt(start),timeZone:"UTC"}; master.end={dateTime:fmt(lastArr+lastVisit*60000),timeZone:"UTC"}; }
      else { const ds=route.scheduled_date||new Date().toISOString().slice(0,10); master.isAllDay=true; master.start={dateTime:ds+"T00:00:00.0000000",timeZone:"UTC"}; master.end={dateTime:nextDay(ds)+"T00:00:00.0000000",timeZone:"UTC"}; }
      let mres;
      if(prev.master_id){ mres=await graphReq(tok,"PATCH",`/users/${encodeURIComponent(mailbox)}/events/${prev.master_id}`,master); if(mres.status===404) mres=await graphReq(tok,"POST",`/users/${encodeURIComponent(mailbox)}/events`,master); }
      else mres=await graphReq(tok,"POST",`/users/${encodeURIComponent(mailbox)}/events`,master);
      if(!mres.ok){ if(denied(mres)) return json(200,{ok:false,error:"calendar_denied",message:"The Graph app can't write to Outlook yet — grant it Calendars.ReadWrite with admin consent in Azure, then try again."});
        return json(200,{ok:false,error:"calendar_error",message:"Outlook error: "+String((mres.json&&mres.json.error&&mres.json.error.message)||mres.text||"").slice(0,180)}); }
      newCal.master_id=(mres.json&&mres.json.id)||prev.master_id;
      // ---- per-dealer visit events (timed only) ----
      let created=0,updated=0;
      for(let i=0;i<stops.length;i++){ const s=stops[i]; if(!s.dealer_id) continue; const t=times[s.dealer_id]; if(!t) continue;
        const d=dmap[s.dealer_id]||{}; const vis=(s.visit_min!=null?s.visit_min:30);
        const ev={ subject:"Visit: "+((d.business_name||s.name||"Dealer")), isAllDay:false,
          location:{displayName:addrOf(s,d)}, start:{dateTime:fmt(t),timeZone:"UTC"}, end:{dateTime:fmt(t+vis*60000),timeZone:"UTC"},
          body:{contentType:"HTML",content:visitBody(s,i)} };
        const pid=prev.events&&prev.events[s.dealer_id]; let r2;
        if(pid){ r2=await graphReq(tok,"PATCH",`/users/${encodeURIComponent(mailbox)}/events/${pid}`,ev); if(r2.status===404) r2=await graphReq(tok,"POST",`/users/${encodeURIComponent(mailbox)}/events`,ev); updated++; }
        else { r2=await graphReq(tok,"POST",`/users/${encodeURIComponent(mailbox)}/events`,ev); created++; }
        if(r2.ok && r2.json && r2.json.id) newCal.events[s.dealer_id]=r2.json.id; else if(pid) newCal.events[s.dealer_id]=pid;
      }
      // ---- delete events for dealers no longer on the route ----
      const cur=new Set(stops.map(s=>s.dealer_id));
      for(const did in (prev.events||{})){ if(!cur.has(did)){ try{ await graphReq(tok,"DELETE",`/users/${encodeURIComponent(mailbox)}/events/${prev.events[did]}`); }catch(e){} } }
      try{ await sbSend("PATCH",`rep_routes?id=eq.${encodeURIComponent(rid)}`,{calendar:newCal},{Prefer:"return=minimal"}); }catch(e){}
      return json(200,{ok:true,mailbox,master:!!newCal.master_id,events:Object.keys(newCal.events).length,created,updated});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

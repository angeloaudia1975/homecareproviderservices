// HCPS admin — Dealer master API (read + merge/manage). Service-role, server-side.
// Powers the Merge/Manage Dealers page. No npm deps.
//
//   GET  /.netlify/functions/dealers-api            -> dealer master + stats + aliases
//   POST /.netlify/functions/dealers-api  {action}  -> merge | edit | access | confirm | rep | split
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)
//
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUILD = "dealers-api direct-write v2 (2026-08-02)";   // shown by the "Check setup" diagnostic
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sbGet(path){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()});
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
// Paginate. orderCol MUST be a real column on the table — several tables (dealer_contacts,
// dealer_addresses, dealer_aliases, dealer_manufacturers) have a composite PK and NO "id"
// column, so ordering by "id" 400s and silently returns nothing. Always pass the right key.
async function sbGetAll(base, orderCol="id"){
  const PAGE=1000; let from=0,out=[];
  for(;;){const sep=base.includes("?")?"&":"?";
    const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`);
    out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE;}
  return out;
}
async function sbSend(method,path,body,extraHeaders){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,
    headers:{...H(),"content-type":"application/json",...(extraHeaders||{})},
    body:body!=null?JSON.stringify(body):undefined});
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t=await r.text(); return t?JSON.parse(t):null;
}
const rpc=(fn,args)=>sbSend("POST",`rpc/${fn}`,args,{Prefer:"return=minimal"});
// Manufacturer lines retired / consolidated — never offered in the access grid or line list.
// "golden" and "bongo" are the duplicate slugs merged into golden-technologies / airavant-bongorx
// (see supabase/manufacturer_merge.sql); listed here so they never resurface even if a row lingers.
const RETIRED=new Set(["complete-medical-supplies","golden","bongo"]);

const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Supabase Auth admin API (create/update/delete auth users). Service-role only.
async function authAdmin(method,pathAfter,body){
  const r=await fetch(`${SUPABASE_URL}/auth/v1/admin/${pathAfter}`,{method,
    headers:{...H(),"content-type":"application/json"},
    body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text();
  if(!r.ok) throw new Error(`Auth ${r.status}: ${t}`);
  return t?JSON.parse(t):null;
}

// ---- Email via Resend (same service the ordering portal uses). Needs RESEND_API_KEY in this
// site's Netlify env (homecareproviderservices.us is already verified in Resend). If unset,
// the send is skipped silently so approvals never break. ----
const MAIL_FROM = process.env.HCPS_MAIL_FROM || "HCPS Partner Portal <orders@homecareproviderservices.us>";
const PORTAL_URL = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const emailEsc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
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
// The dealer welcome email, sent the first time an account is approved.
async function sendWelcomeEmail(toEmail, dealerName){
  if(!toEmail||!EMAIL_RE.test(String(toEmail))) return;
  const hi=dealerName?`, <b>${emailEsc(dealerName)}</b>`:"";
  await sendMail({
    to:toEmail, subject:"Welcome to the HCPS Partner Portal — you're approved",
    html:`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
      <h2 style="color:#2B4071;margin:0 0 4px">You're approved${hi}</h2>
      <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 12px">Your HCPS Partner Portal account is active. You can now sign in to browse your manufacturer lines, see your pricing, and place orders 24/7.</p>
      <a href="${PORTAL_URL}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;font-size:14px">Sign in to your portal →</a>
      <p style="font-size:12.5px;line-height:1.6;color:#6b7280;margin:16px 0 0">The portal is currently in <b>beta</b> — we're still adding features, and a step-by-step tutorial is on the way. If anything looks off or you have questions, just reply to this email or reach your HCPS representative.</p>
      <p style="font-size:12px;color:#9aa4ae;margin:14px 0 0">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.</p></div>`,
    text:`You're approved${dealerName?", "+dealerName:""}!\n\nYour HCPS Partner Portal account is active. Sign in to browse your lines, see your pricing, and order 24/7:\n${PORTAL_URL}\n\nThe portal is in beta — more features and a tutorial are coming. Reply to this email with any questions.\n\nHomeCare Provider Services`
  });
}

const MONTH=["January","February","March","April","May","June","July","August","September","October","November","December"];
const plabel=p=>{const[y,m]=p.split("-");return `${MONTH[+m-1]} ${y}`;};
const pm=p=>{const[y,m]=p.split("-").map(Number);return y*12+(m-1);};

// ---- territory ACCESS RULES (shared with the ordering portal's dealer-auth). ----
const { computeAccess } = require("./_access.js");
const P = require("./_platform.js");
const ACT_ORDERING = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
// #2 Manufacturer Activated — when a dealer is newly approved to order a line, queue a
// one-time "you can order this now" email (ordering instructions & pricing) through the
// same email_queue the engine drains (caps + opt-out + go-live gating all still apply),
// and log the activation on the dealer timeline. Once-ever per dealer×line: prior
// activation emails' `reason` records which slugs were already covered. Live-only, so
// pre-launch setup never emails real dealers.
async function enqueueActivation(dealer_id, newSlugs){
  try{
    const st=await P.getState(); if(st.mode!=="live") return;                 // no premature sends before go-live
    if(!Array.isArray(newSlugs)||!newSlugs.length) return;
    const [dealers,mfrs,priorQ,opt]=await Promise.all([
      sbGet(`dealers?id=eq.${encodeURIComponent(dealer_id)}&select=business_name,email`).catch(()=>[]),
      sbGet("manufacturers?select=slug,name").catch(()=>[]),
      sbGet(`email_queue?dealer_id=eq.${encodeURIComponent(dealer_id)}&template=eq.activation&select=reason`).catch(()=>[]),
      sbGet("email_optout?select=email").catch(()=>[]),
    ]);
    const d=dealers&&dealers[0]; if(!d) return;
    const mfrName={}; for(const m of (mfrs||[])) mfrName[m.slug]=m.name||m.slug;
    const done=new Set(); for(const r of (priorQ||[])){ String(r.reason||"").replace(/^activation:/,"").split(",").forEach(s=>{ if(s) done.add(s); }); }
    const slugs=newSlugs.filter(s=>s && !done.has(s)); if(!slugs.length) return;
    let to=String(d.email||"").trim();
    if(!EMAIL_RE.test(to)){ const c=await sbGet(`dealer_contacts?dealer_id=eq.${encodeURIComponent(dealer_id)}&email=not.is.null&select=email&limit=1`).catch(()=>[]); to=String((c&&c[0]&&c[0].email)||"").trim(); }
    if(!EMAIL_RE.test(to)) return;
    const opted=new Set((opt||[]).map(r=>String(r.email||"").toLowerCase())); if(opted.has(to.toLowerCase())) return;
    const lines=slugs.map(s=>mfrName[s]||s);
    await sbSend("POST","email_queue",{dealer_id,contact_email:to,template:"activation",reason:"activation:"+slugs.join(","),
      priority:"normal",send_window:"primary",payload:{lines,slugs},
      detail:`${d.business_name||""}: line(s) activated — ${lines.join(", ")}`,
      send_after:new Date().toISOString(),status:"queued",env:P.envFor(st.mode,false)},{Prefer:"return=minimal"}).catch(()=>{});
    await sbSend("POST","dealer_activity",{dealer_id,kind:"system",subject:`Line(s) activated: ${lines.join(", ")}`,actor:"Access grant"},{Prefer:"return=minimal"}).catch(()=>{});
  }catch(e){/* activation email is best-effort; never block the access save */}
}
// Same normalized key the map's geocoder uses, to look up a governing account's latitude
// (needed for Strongback's "south of Indianapolis" rule).
function qkey(a){
  const parts=[a.address,a.city,[a.state,a.zip].filter(Boolean).join(" ")].map(x=>String(x||"").trim()).filter(Boolean);
  return parts.join(", ").toLowerCase().replace(/\s+/g," ").trim();
}
// Compute a single dealer's portal access EXACTLY as dealer-auth does: evaluate the
// governing account (master HQ if a branch), pull its latitude, and split owned vs available
// by whether the dealer actually has an ACCOUNT NUMBER for the line (account_ref).
async function computeDealerAccess(dealer_id){
  const d=await sbGet(`dealers?id=eq.${encodeURIComponent(dealer_id)}&select=id,business_name,address,city,state,zip,parent_id,golden_status,ovation_access`).catch(()=>[]);
  const self=d&&d[0]; if(!self) return null;
  let gov=self, governedBy=null;
  if(self.parent_id){ const p=await sbGet(`dealers?id=eq.${self.parent_id}&select=business_name,address,city,state,zip`).catch(()=>[]); if(p&&p[0]){ gov=p[0]; governedBy=p[0].business_name; } }
  let lat=null;
  try{ const q=qkey(gov); if(q){ const gc=await sbGet(`geocache?q=eq.${encodeURIComponent(q)}&ok=eq.true&select=lat&limit=1`).catch(()=>[]); if(gc&&gc[0]) lat=gc[0].lat; } }catch(e){}
  const dm=await sbGet(`dealer_manufacturers?dealer_id=eq.${encodeURIComponent(dealer_id)}&active=eq.true&select=manufacturer,account_ref`).catch(()=>[]);
  const ownedWithAccount=(dm||[]).filter(x=>x.account_ref&&String(x.account_ref).trim()).map(x=>x.manufacturer);
  const access=computeAccess({
    state: gov.state||self.state, business_name: gov.business_name||self.business_name, lat,
    golden_status: self.golden_status||"None", ovation_access: !!self.ovation_access,
  }, ownedWithAccount);
  return { access, gridLines:(dm||[]).map(x=>x.manufacturer).sort(), governedBy, lat_known: lat!=null };
}

// ---- staff auth: email/password JWT resolved against staff_users. A matching legacy
//      passcode still grants president during the transition; unset ANALYTICS_TOKEN to retire it.
async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN;
  const got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:""};
  return null;
}
async function ownsDealer(me, dealer_id){
  if(!me||!me.rep_name||!dealer_id) return false;
  const d=await sbGet(`dealers?id=eq.${encodeURIComponent(dealer_id)}&select=business_name`).catch(()=>[]);
  const nm=d&&d[0]&&d[0].business_name; if(!nm) return false;
  const dir=await sbGet(`dealer_directory?dealer_name=eq.${encodeURIComponent(nm)}&select=rep_name`).catch(()=>[]);
  return String((dir&&dir[0]&&dir[0].rep_name)||"").trim().toLowerCase()===String(me.rep_name).trim().toLowerCase();
}
// Structural / cross-book / login / approval tools are President-only.
const PRESIDENT_ONLY=new Set(["merge","split","import_contacts","backfill_master","attribution_breakdown","reattribute","clear_order_refs","confirm","nomerge","diag","approve_change","reject_change","approve_login","revoke_login","delete_login","set_login_email","rep","rep_bulk","list_contract_prices","set_contract_price","clear_contract_price","prefill_access","prefill_access_all","create_dealer"]);

async function buildState(){
  const [dealers,aliases,dm,mfrs,dir,reps,nomerge,logins] = await Promise.all([
    sbGetAll("dealers?select=id,business_name,hcps_account,contact_name,email,phone,address,city,state,zip,status,notes,active,parent_id"),
    sbGetAll("dealer_aliases?select=alias_norm,raw_name,dealer_id","alias_norm"),
    sbGetAll("dealer_manufacturers?select=dealer_id,manufacturer,active","dealer_id,manufacturer"),
    sbGet("manufacturers?select=slug,name,active"),
    sbGet("dealer_directory?select=dealer_name,rep_name,hcps_account").catch(()=>[]),
    sbGet("reps?select=name").catch(()=>[]),
    sbGet("dealer_nomerge?select=a,b").catch(()=>[]),
    sbGet("dealer_users?select=uid,email,dealer_id,status,created_at,req_company,req_contact,req_phone,req_address,req_city,req_state,req_zip&order=created_at.desc").catch(()=>[]),
  ]);
  // Websites live in dealers.website (added by supabase/master_backfill.sql). Fetched
  // decoupled + tolerant so the whole page still loads if the column isn't there yet.
  let webById={}; try{ const w=await sbGetAll("dealers?select=id,website"); for(const x of (w||[])) if(x.website) webById[x.id]=x.website; }catch(e){}
  // Email-verification status (dealers.email_verified, added by supabase/dealer_email_verification.sql).
  // Decoupled + tolerant: if the column doesn't exist yet the page still loads and no badges show.
  let evById={}, evSupported=false; try{ const ev=await sbGetAll("dealers?select=id,email_verified"); evSupported=true; for(const x of (ev||[])) evById[x.id]=!!x.email_verified; }catch(e){}
  // Golden portal linkage (dealers.golden_url / golden_status) — powers the "Open Golden portal" deep
  // link on Dealer 360. Decoupled + tolerant so the page still loads if the columns aren't present.
  let goldById={}; try{ const g=await sbGetAll("dealers?select=id,golden_url,golden_status"); for(const x of (g||[])) goldById[x.id]={url:x.golden_url||"",status:x.golden_status||""}; }catch(e){}
  // Assigned sales rep is now stored directly on the dealer (dealers.rep_name, keyed by dealer id) —
  // the durable source of truth that survives renames/merges. Decoupled + tolerant: if the column
  // isn't present yet the page still loads and we fall back to the legacy name-keyed directory below.
  let repById={}; try{ const rp=await sbGetAll("dealers?select=id,rep_name"); for(const x of (rp||[])) if(x.rep_name) repById[x.id]=x.rep_name; }catch(e){}
  const dcontacts = await sbGetAll("dealer_contacts?select=dealer_id,email,name,title,role,phone,cell","dealer_id,email").catch(()=>[]);
  const contactsByDealer=new Map(); for(const x of dcontacts){(contactsByDealer.get(x.dealer_id)||contactsByDealer.set(x.dealer_id,[]).get(x.dealer_id)).push(x);}
  const daddrs = await sbGetAll("dealer_addresses?select=dealer_id,address,city,state,zip,label,pri","dealer_id,addr_key").catch(()=>[]);
  const addrByDealer=new Map(); for(const x of daddrs){(addrByDealer.get(x.dealer_id)||addrByDealer.set(x.dealer_id,[]).get(x.dealer_id)).push(x);}
  const rows = await sbGetAll("monthly_sales?select=dealer_id,manufacturer,period,amount,commission,customer_name,customer_ref");
  // Lines whose report "customer #" is really a per-order number don't have real account
  // numbers — don't surface those order numbers as if they were account numbers.
  let orderLines=new Set(); try{ const cc=await sbGet("app_settings?key=eq.commission_config&select=value"); orderLines=new Set(((cc&&cc[0]&&cc[0].value&&cc[0].value.order_number_lines))||[]); }catch(e){}
  const mfrName=Object.fromEntries(mfrs.map(m=>[m.slug,m.name]));
  const repByName=Object.fromEntries(dir.map(d=>[d.dealer_name,d.rep_name]));
  const aliByDealer=new Map(); for(const a of aliases){(aliByDealer.get(a.dealer_id)||aliByDealer.set(a.dealer_id,[]).get(a.dealer_id)).push(a.raw_name);}
  const accByDealer=new Map(); for(const x of dm){if(x.active!==false)(accByDealer.get(x.dealer_id)||accByDealer.set(x.dealer_id,[]).get(x.dealer_id)).push(x.manufacturer);}
  // aggregate sales per dealer_id
  const agg=new Map();
  let unlinked=0;
  for(const r of rows){
    if(!r.dealer_id){unlinked++; continue;}
    const a=agg.get(r.dealer_id)||{sales:0,comm:0,recs:0,lines:new Set(),periods:new Set(),accts:new Set()};
    a.sales+=Number(r.amount)||0; a.comm+=Number(r.commission)||0; a.recs+=1;
    if(r.manufacturer)a.lines.add(r.manufacturer); if(r.period)a.periods.add(r.period.slice(0,10));
    if(r.customer_ref&&String(r.customer_ref).trim()&&!orderLines.has(r.manufacturer))a.accts.add(`${r.manufacturer}:${String(r.customer_ref).trim()}`);
    agg.set(r.dealer_id,a);
  }
  const periodsAll=[...new Set(rows.map(r=>(r.period||"").slice(0,10)).filter(Boolean))].sort();
  const latest=periodsAll[periodsAll.length-1];
  // master/branch structure (parent_id): a branch -> its HQ name; an HQ -> its branch list
  const nameById=Object.fromEntries(dealers.map(d=>[d.id,d.business_name]));
  const branchesByParent=new Map();
  for(const d of dealers){ if(d.parent_id){ (branchesByParent.get(d.parent_id)||branchesByParent.set(d.parent_id,[]).get(d.parent_id)).push(d.business_name); } }
  const out=dealers.map(d=>{
    const a=agg.get(d.id)||{sales:0,comm:0,recs:0,lines:new Set(),periods:new Set(),accts:new Set()};
    const per=[...a.periods].sort();
    const since = (latest&&per.length)? pm(latest)-pm(per[per.length-1]) : null;
    return {
      id:d.id, name:d.business_name, hcps_account:d.hcps_account||"", status:d.status||"",
      contact_name:d.contact_name||"", email:d.email||"", email_verified: evSupported?!!evById[d.id]:null, phone:d.phone||"", website:webById[d.id]||"",
      golden_url:(goldById[d.id]&&goldById[d.id].url)||"", golden_status:(goldById[d.id]&&goldById[d.id].status)||"",
      address:d.address||"", city:d.city||"", state:d.state||"", zip:d.zip||"", notes:d.notes||"",
      rep: repById[d.id]||repByName[d.business_name]||"",
      master: d.parent_id ? (nameById[d.parent_id]||"") : "",
      branches:(branchesByParent.get(d.id)||[]).slice().sort(),
      aliases:(aliByDealer.get(d.id)||[]).filter((v,i,s)=>s.indexOf(v)===i).sort(),
      access:(accByDealer.get(d.id)||[]).slice().sort(),
      buysLines:[...a.lines].sort(),
      accounts:[...a.accts].sort(),
      contacts:(contactsByDealer.get(d.id)||[]).map(c=>({email:c.email||"",name:c.name||"",title:c.title||"",role:c.role||"",phone:c.phone||"",cell:c.cell||""})),
      addresses:(addrByDealer.get(d.id)||[]).map(x=>({address:x.address||"",city:x.city||"",state:x.state||"",zip:x.zip||"",label:x.label||"",pri:x.pri||1}))
        .sort((p,q)=>(q.pri||1)-(p.pri||1)),
      sales:Math.round(a.sales*100)/100, comm:Math.round(a.comm*100)/100, recs:a.recs,
      periods:per, monthsSince:since, lastPeriod:per[per.length-1]||null,
    };
  }).sort((x,y)=>y.sales-x.sales);
  // dealer-submitted account change requests awaiting HCPS approval
  const changeReqs = await sbGet("dealer_change_requests?status=eq.pending&select=id,dealer_id,uid,email,changes,created_at&order=created_at.desc").catch(()=>[]);
  // login activity + persistent (open) carts
  const [sessions,carts] = await Promise.all([
    sbGet("dealer_sessions?select=dealer_id,email,login_at,last_seen_at&order=last_seen_at.desc&limit=800").catch(()=>[]),
    sbGet("dealer_carts?select=uid,dealer_id,email,cart,updated_at").catch(()=>[]),
  ]);
  const dName=id=>{const d=dealers.find(x=>x.id===id);return d?d.business_name:"";};
  const mins=(a,b)=>Math.max(0,Math.round((new Date(b)-new Date(a))/60000));
  const NOW=Date.now();
  const recentSessions=(sessions||[]).map(s=>({
    dealer_id:s.dealer_id||"", dealer_name:dName(s.dealer_id)||s.email||"", email:s.email||"",
    login_at:s.login_at, last_seen_at:s.last_seen_at, mins:mins(s.login_at,s.last_seen_at),
    live:(NOW-new Date(s.last_seen_at).getTime())<3*60*1000    // seen in last 3 min ≈ online now
  })).slice(0,150);
  const actByDealer=new Map();
  for(const s of (sessions||[])){ const k=s.dealer_id||("e:"+s.email); const a=actByDealer.get(k)||{count:0,lastSeen:null,lastLogin:null};
    a.count++; if(!a.lastSeen||new Date(s.last_seen_at)>new Date(a.lastSeen))a.lastSeen=s.last_seen_at;
    if(!a.lastLogin||new Date(s.login_at)>new Date(a.lastLogin))a.lastLogin=s.login_at; actByDealer.set(k,a); }
  const openCarts=(carts||[]).map(c=>{ const items=(c.cart&&c.cart.items)||[];
    let n=0,val=0; const lines=[];
    for(const it of items){ const p=it.p||{},q=Number(it.qty)||0; n+=q; val+=(Number(p.base_price)||0)*q;
      lines.push({name:p.name||p.code||"",code:p.code||"",manufacturer:p.manufacturer||"",qty:q}); }
    return {dealer_id:c.dealer_id||"", dealer_name:dName(c.dealer_id)||c.email||"", email:c.email||"",
      itemCount:n, value:Math.round(val*100)/100, updated_at:c.updated_at, lines};
  }).filter(c=>c.itemCount>0).sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at));
  return {
    generatedAt:new Date().toISOString(),
    latestPeriod:latest||null,
    manufacturers:mfrs.filter(m=>m.active!==false && !RETIRED.has(m.slug)).map(m=>({slug:m.slug,name:m.name})).sort((a,b)=>a.name.localeCompare(b.name)),
    repOptions:[...new Set(reps.map(r=>r.name).filter(Boolean))].sort(),
    mfrName, unlinked, dealers:out,
    nomerge:(nomerge||[]).map(x=>[x.a,x.b].sort().join("|")),
    logins:(logins||[]).map(u=>{const d=dealers.find(x=>x.id===u.dealer_id);
      return {uid:u.uid,email:u.email,status:u.status,created_at:u.created_at,
        dealer_id:u.dealer_id||"",dealer_name:d?d.business_name:"",
        req:{company:u.req_company||"",contact:u.req_contact||"",phone:u.req_phone||"",
             address:u.req_address||"",city:u.req_city||"",state:u.req_state||"",zip:u.req_zip||""}};}),
    changeRequests:(changeReqs||[]).map(r=>{const d=dealers.find(x=>x.id===r.dealer_id);
      return {id:r.id,dealer_id:r.dealer_id||"",dealer_name:d?d.business_name:(r.email||""),
        email:r.email||"",created_at:r.created_at,changes:r.changes||{}};}),
    recentSessions, openCarts, email_verified_supported:evSupported,
  };
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    // Two tiers. seesAll = who may see/work every dealer (management + a Relations Manager who
    // covers the whole territory). isAdminRole = who manages the admin queues (management only).
    const role=String(me.role||"").toLowerCase();
    const isAdminRole=!!({president:1,admin:1,owner:1})[role];
    const seesAll=isAdminRole || role==="relations";

    if(event.httpMethod==="GET"){
      const state=await buildState();
      state.role=me.role; state.rep_name=me.rep_name||"";
      if(!seesAll){
        // A sales rep sees only their own book of dealers.
        const rn=String(me.rep_name||"").trim().toLowerCase();
        state.dealers=(state.dealers||[]).filter(d=> rn && String(d.rep||"").trim().toLowerCase()===rn);
      }
      if(!isAdminRole){
        // Non-management roles don't manage the admin queues/tools — hide them.
        state.logins=[]; state.changeRequests=[]; state.recentSessions=[]; state.openCarts=[]; state.nomerge=[];
      }
      return json(200,state);
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
      const act=b.action;
      if(PRESIDENT_ONLY.has(act) && me.role!=="president") return json(403,{error:"President only"});
      if(!seesAll && (act==="edit"||act==="access"||act==="verify_email") && !(await ownsDealer(me,b.dealer_id))) return json(403,{error:"Not your dealer"});
      if(act==="diag"){
        // Self-check: which code is live, do the tables exist, and how many rows are stored.
        const probe=async(t)=>{ try{
            const r=await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=dealer_id`,{headers:{...H(),Prefer:"count=exact",Range:"0-0"}});
            if(r.status===404||r.status===400) return {exists:false,count:0};
            const cr=r.headers.get("content-range")||""; const cnt=cr.includes("/")?parseInt(cr.split("/")[1],10):null;
            return {exists:(r.ok||r.status===206),count:Number.isFinite(cnt)?cnt:null};
          }catch(e){ return {exists:false,count:0,error:String(e.message||e)}; } };
        return json(200,{ok:true,build:BUILD,dealer_contacts:await probe("dealer_contacts"),dealer_addresses:await probe("dealer_addresses")});
      }
      if(act==="preview_link"){
        // Mint a short-lived, READ-ONLY token so authorized staff can open the dealer's HCPS
        // Partner 360 ordering portal "as" them (preview/impersonation) — no dealer login, no
        // shared credentials, and no need to assign a staff email to the dealer account.
        // Mirrors the Golden SSO pattern (server-minted signed link, opened in a new tab).
        const dealer_id=b.dealer_id;
        if(!dealer_id) return json(400,{error:"dealer_id required"});
        // Authorized staff only: management/relations (seesAll) or the rep who owns this dealer.
        if(!seesAll && !(await ownsDealer(me,dealer_id))) return json(403,{error:"Not your dealer"});
        const drows=await sbGet(`dealers?id=eq.${encodeURIComponent(dealer_id)}&select=id,business_name`).catch(()=>[]);
        const dealer=drows&&drows[0];
        if(!dealer) return json(404,{error:"dealer not found"});
        const token=require("crypto").randomBytes(24).toString("hex");
        const ttlMin=30;
        const expires_at=new Date(Date.now()+ttlMin*60*1000).toISOString();
        try{ await sbSend("POST","dealer_preview_tokens",{token,dealer_id,created_by:(me.email||me.name||""),expires_at},{Prefer:"return=minimal"}); }
        catch(e){ return json(500,{error:"Could not create preview session. Run supabase/dealer_preview_tokens.sql, then retry.",detail:String(e.message||e)}); }
        return json(200,{ok:true,url:`${PORTAL_URL}/?preview=${token}`,dealer_name:dealer.business_name||"",expires_in:ttlMin*60});
      }
      if(act==="merge"){
        if(!b.survivor_id||!Array.isArray(b.loser_ids)||!b.loser_ids.length) return json(400,{error:"survivor_id + loser_ids required"});
        const survivor=b.survivor_id;
        const losers=[...new Set(b.loser_ids.filter(x=>x&&x!==survivor))];
        if(!losers.length) return json(400,{error:"no valid loser_ids (a dealer can't be merged into itself)"});
        // Re-point any child dealer whose parent is one of the losers onto the survivor FIRST. The
        // merge deletes the losers, and Postgres blocks that with dealers_parent_id_fkey while a
        // branch still points at the account being merged away. Excluding the survivor keeps it from
        // ever becoming its own parent; the survivor absorbs the losers' branches (intended merge).
        const inList="("+losers.map(x=>encodeURIComponent(x)).join(",")+")";
        try{ await sbSend("PATCH",`dealers?parent_id=in.${inList}&id=neq.${encodeURIComponent(survivor)}`,{parent_id:survivor},{Prefer:"return=minimal"}); }catch(e){}
        // If the survivor's OWN parent was one of the losers, detach it — it can't parent itself.
        try{ await sbSend("PATCH",`dealers?id=eq.${encodeURIComponent(survivor)}&parent_id=in.${inList}`,{parent_id:null},{Prefer:"return=minimal"}); }catch(e){}
        await rpc("merge_dealers",{p_survivor:survivor,p_losers:losers});
        return json(200,{ok:true});
      }
      if(act==="edit"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        const f={}; for(const k of ["contact_name","email","phone","website","address","city","state","zip","hcps_account","notes","business_name"]) if(k in b) f[k]=(b[k]===""?null:b[k]);
        f.updated_at=new Date().toISOString();
        // If the email ADDRESS actually changed, drop it back to Pending verification.
        if("email" in b){ try{ const cur=await sbGet(`dealers?id=eq.${encodeURIComponent(b.dealer_id)}&select=email,email_verified`); const c=cur&&cur[0];
          if(c && String(c.email||"")!==String(f.email||"")) f.email_verified=false; }catch(e){} }
        try{ await sbSend("PATCH",`dealers?id=eq.${b.dealer_id}`,f,{Prefer:"return=minimal"}); }
        catch(e){ // tolerate columns not existing yet (website / email_verified migrations)
          const msg=String(e.message||""); let retry=false;
          if(/email_verified/i.test(msg) && ("email_verified" in f)){ delete f.email_verified; retry=true; }
          if(/website/i.test(msg) && ("website" in f)){ delete f.website; retry=true; }
          if(retry){ await sbSend("PATCH",`dealers?id=eq.${b.dealer_id}`,f,{Prefer:"return=minimal"}); }
          else throw e; }
        // Keep the MAP in sync: it pins from dealer_addresses, so mirror an address edit
        // onto this dealer's primary (highest-pri) address row — or create one if none.
        if(["address","city","state","zip"].some(k=>k in b)){
          try{
            const cur=await sbGet(`dealers?id=eq.${b.dealer_id}&select=address,city,state,zip`);
            const d=(cur&&cur[0])||{};
            const payload={address:d.address||null,city:d.city||null,state:d.state||null,zip:d.zip||null};
            const rows=await sbGet(`dealer_addresses?dealer_id=eq.${b.dealer_id}&select=addr_key&order=pri.desc.nullslast&limit=1`).catch(()=>[]);
            if(rows&&rows[0]&&rows[0].addr_key){
              await sbSend("PATCH",`dealer_addresses?dealer_id=eq.${b.dealer_id}&addr_key=eq.${encodeURIComponent(rows[0].addr_key)}`,payload,{Prefer:"return=minimal"});
            } else {
              const ak=(String(d.address||"").toLowerCase().replace(/[^a-z0-9]+/g,"")).slice(0,120)||"primary";
              await sbSend("POST","dealer_addresses",{dealer_id:b.dealer_id,addr_key:ak,label:"Primary",pri:3,...payload},{Prefer:"resolution=merge-duplicates,return=minimal"});
            }
          }catch(e){}
        }
        return json(200,{ok:true});
      }
      if(act==="confirm"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        await sbSend("PATCH",`dealers?id=eq.${b.dealer_id}`,{status:null,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      // Mark a dealer's email verified (or un-verify), without recreating the dealer. Can also update
      // the address in the same call ({email}). Reversible; available to any signed-in staff.
      if(act==="verify_email"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        const verified=(b.verified!==false);
        const patch={ email_verified:verified, email_verified_at:verified?new Date().toISOString():null, updated_at:new Date().toISOString() };
        if(b.email!==undefined){ const em=String(b.email||"").trim(); patch.email=em||null; }
        try{ await sbSend("PATCH",`dealers?id=eq.${encodeURIComponent(b.dealer_id)}`,patch,{Prefer:"return=minimal"}); }
        catch(e){ if(/email_verified/i.test(String(e.message||""))) return json(200,{ok:false,error:"needs_migration",message:"Run supabase/dealer_email_verification.sql in Supabase first."}); throw e; }
        return json(200,{ok:true, verified});
      }
      // Create a brand-new dealer from scratch — a standalone/corporate account, or a branch of an
      // existing dealer when parent_id is passed. Seeds a primary address (so it pins on the map) and
      // optionally stores per-manufacturer account #s so commission imports auto-match by number.
      if(act==="create_dealer"){
        const name=String(b.business_name||"").trim();
        if(!name) return json(400,{error:"A business name is required"});
        let parent_id=b.parent_id||null;
        if(parent_id){ // validate the parent exists (and is itself a top-level dealer, not a branch)
          const p=await sbGet(`dealers?id=eq.${encodeURIComponent(parent_id)}&select=id,parent_id`).catch(()=>[]);
          if(!p||!p[0]) return json(400,{error:"The chosen parent dealer was not found"});
          if(p[0].parent_id) parent_id=p[0].parent_id;   // never nest branches — attach to the root
        }
        const clean=v=>(v!=null&&String(v).trim())?String(v).trim():null;
        const rec={
          business_name:name,
          contact_name:clean(b.contact_name), email:clean(b.email), phone:clean(b.phone),
          address:clean(b.address), city:clean(b.city), state:clean(b.state), zip:clean(b.zip),
          hcps_account:clean(b.hcps_account), notes:clean(b.notes),
          parent_id, active:true, status:(b.status!==undefined?b.status:null)
        };
        const ins=await sbSend("POST","dealers",rec,{Prefer:"return=representation"});
        const dealer_id=(ins&&ins[0]&&ins[0].id)||null;
        if(!dealer_id) return json(500,{error:"Dealer insert failed"});
        // Seed the primary address row the map pins from.
        if(rec.address||rec.city||rec.state||rec.zip){
          try{ const ak=(String(rec.address||"").toLowerCase().replace(/[^a-z0-9]+/g,"")).slice(0,120)||"primary";
            await sbSend("POST","dealer_addresses",{dealer_id,addr_key:ak,label:"Primary",pri:3,address:rec.address,city:rec.city,state:rec.state,zip:rec.zip},{Prefer:"resolution=merge-duplicates,return=minimal"});
          }catch(e){}
        }
        // Optional manufacturer account #s so future imports match by number.
        const ownAcct=new Set();
        if(Array.isArray(b.accounts)&&b.accounts.length){
          const rows=b.accounts.filter(a=>a&&a.manufacturer&&clean(a.account_ref))
            .map(a=>{ ownAcct.add(String(a.manufacturer).trim()); return {dealer_id,manufacturer:String(a.manufacturer).trim(),account_ref:clean(a.account_ref),active:true}; });
          if(rows.length) try{ await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",rows,{Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){}
        }
        // A branch inherits its parent organization's manufacturer account numbers (they are org-level).
        // Fill only the lines the branch wasn't just given its own number for.
        if(parent_id){
          try{
            const pdm=await sbGet(`dealer_manufacturers?dealer_id=eq.${encodeURIComponent(parent_id)}&select=manufacturer,account_ref`).catch(()=>[]);
            const inherit=(pdm||[]).filter(x=>x&&x.account_ref&&String(x.account_ref).trim()&&!ownAcct.has(x.manufacturer))
              .map(x=>({dealer_id,manufacturer:x.manufacturer,account_ref:x.account_ref,active:true}));
            if(inherit.length) await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",inherit,{Prefer:"resolution=merge-duplicates,return=minimal"});
          }catch(e){}
        }
        try{ await sbSend("POST","dealer_activity",{dealer_id,kind:"system",subject:parent_id?"Branch location added":"Dealer added",detail:name,actor:me.name||"admin"},{Prefer:"return=minimal"}); }catch(e){}
        return json(200,{ok:true,dealer_id});
      }
      if(act==="access"){
        if(!b.dealer_id||!Array.isArray(b.manufacturers)) return json(400,{error:"dealer_id + manufacturers[] required"});
        // preserve existing manufacturer account numbers (account_ref) so re-saving access
        // never wipes the dealer's account #s. Merge in any aliased slugs' refs too.
        const existing=await sbGet(`dealer_manufacturers?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&select=manufacturer,account_ref`,"dealer_id,manufacturer").catch(()=>[]);
        const refBy={}; for(const r of (existing||[])){ if(r.account_ref) refBy[r.manufacturer]=r.account_ref; }
        // b.refCarry: {canonicalSlug: account_ref} the UI passes when it merged duplicate rows
        if(b.refCarry&&typeof b.refCarry==="object"){ for(const k in b.refCarry){ if(b.refCarry[k]&&!refBy[k]) refBy[k]=b.refCarry[k]; } }
        await sbSend("DELETE",`dealer_manufacturers?dealer_id=eq.${b.dealer_id}`,null,{Prefer:"return=minimal"});
        if(b.manufacturers.length) await sbSend("POST","dealer_manufacturers",b.manufacturers.map(m=>({dealer_id:b.dealer_id,manufacturer:m,active:true,account_ref:refBy[m]||null})),{Prefer:"return=minimal"});
        // #2 Manufacturer Activated: fire for lines that weren't in the grid before this save.
        const hadBefore=new Set((existing||[]).map(r=>r.manufacturer));
        const newlyGranted=b.manufacturers.filter(m=>!hadBefore.has(m));
        if(newlyGranted.length) await enqueueActivation(b.dealer_id,newlyGranted);
        return json(200,{ok:true});
      }
      if(act==="rep"){
        const rep=(b.rep_name||"").trim()||null;
        // Preferred path: store the assignment on the dealer record itself (durable, survives renames).
        if(b.dealer_id){
          await sbSend("PATCH",`dealers?id=eq.${encodeURIComponent(b.dealer_id)}`,{rep_name:rep},{Prefer:"return=minimal"});
          // Keep the legacy name-keyed directory in sync so older lookups + rep-portal fallback stay consistent.
          if(b.dealer_name){ await sbSend("POST","dealer_directory",{dealer_name:b.dealer_name,rep_name:rep,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{}); }
          return json(200,{ok:true});
        }
        if(!b.dealer_name) return json(400,{error:"dealer_id or dealer_name required"});
        await sbSend("POST","dealer_directory",{dealer_name:b.dealer_name,rep_name:rep,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="rep_bulk"){
        const rep=(b.rep_name||"").trim()||null;
        const ids=Array.isArray(b.dealer_ids)?[...new Set(b.dealer_ids.filter(Boolean))]:[];
        if(!ids.length) return json(400,{error:"dealer_ids required"});
        // One PATCH for the whole selection via an in.() filter (chunked to keep the URL sane).
        for(let i=0;i<ids.length;i+=100){
          const chunk=ids.slice(i,i+100).map(encodeURIComponent).join(",");
          await sbSend("PATCH",`dealers?id=in.(${chunk})`,{rep_name:rep},{Prefer:"return=minimal"});
        }
        return json(200,{ok:true,updated:ids.length});
      }
      // ---- Territory access (rules engine) ----
      // Read-only: what this dealer can actually order on the portal, computed live from the rules.
      if(act==="portal_access"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        const r=await computeDealerAccess(b.dealer_id);
        if(!r) return json(404,{error:"dealer not found"});
        return json(200,{ok:true,...r});
      }
      // President-only: materialize the rule-eligible lines into this dealer's editable grid
      // (dealer_manufacturers), preserving any account numbers already on file.
      if(act==="prefill_access"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        const r=await computeDealerAccess(b.dealer_id);
        if(!r) return json(404,{error:"dealer not found"});
        const eligible=[...new Set([...(r.access.your_accounts||[]),...(r.access.available||[])])];
        const existing=await sbGet(`dealer_manufacturers?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&select=manufacturer,account_ref`).catch(()=>[]);
        const refBy={}; for(const x of (existing||[])){ if(x.account_ref) refBy[x.manufacturer]=x.account_ref; }
        if(eligible.length){
          const rows=eligible.map(m=>({dealer_id:b.dealer_id,manufacturer:m,active:true,account_ref:refBy[m]||null}));
          await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",rows,{Prefer:"resolution=merge-duplicates,return=minimal"});
        }
        return json(200,{ok:true,added:eligible.sort()});
      }
      // President-only: same, for EVERY dealer at once (bulk-load, compute in memory, batch upsert).
      if(act==="prefill_access_all"){
        const dealers=await sbGetAll("dealers?select=id,business_name,address,city,state,zip,parent_id,golden_status,ovation_access");
        const dmAll=await sbGetAll("dealer_manufacturers?select=dealer_id,manufacturer,account_ref","dealer_id,manufacturer");
        const gcAll=await sbGetAll("geocache?ok=eq.true&select=q,lat","q").catch(()=>[]);
        const latByQ={}; for(const g of (gcAll||[])) latByQ[g.q]=g.lat;
        const byId={}; for(const d of dealers) byId[d.id]=d;
        const refByDealer=new Map();
        for(const x of dmAll){ if(x.account_ref){ (refByDealer.get(x.dealer_id)||refByDealer.set(x.dealer_id,{}).get(x.dealer_id))[x.manufacturer]=x.account_ref; } }
        const rows=[];
        for(const d of dealers){
          const gov = (d.parent_id&&byId[d.parent_id]) ? byId[d.parent_id] : d;
          const q=qkey(gov); const lat=(q in latByQ)?latByQ[q]:null;
          const acc=computeAccess({state:gov.state||d.state,business_name:gov.business_name||d.business_name,lat,golden_status:d.golden_status||"None",ovation_access:!!d.ovation_access},[]);
          const eligible=[...new Set([...(acc.your_accounts||[]),...(acc.available||[])])];
          const refs=refByDealer.get(d.id)||{};
          for(const m of eligible) rows.push({dealer_id:d.id,manufacturer:m,active:true,account_ref:refs[m]||null});
        }
        let n=0; for(let i=0;i<rows.length;i+=500){ const part=rows.slice(i,i+500); await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); n+=part.length; }
        return json(200,{ok:true,dealers:dealers.length,lines:n});
      }
      // ---- Per-product contract pricing (dealer_contract_prices) ----
      if(act==="list_contract_prices"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        const rows=await sbGet(`dealer_contract_prices?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&select=manufacturer,code,name,price,note,active&order=manufacturer,code`).catch(()=>[]);
        return json(200,{ok:true,prices:rows||[]});
      }
      if(act==="set_contract_price"){
        if(!b.dealer_id||!b.manufacturer||!b.code) return json(400,{error:"dealer_id, manufacturer, code required"});
        const price=Number(b.price);
        if(!isFinite(price)||price<0) return json(400,{error:"valid price required"});
        const row={dealer_id:b.dealer_id,manufacturer:String(b.manufacturer),code:String(b.code),
          name:(b.name!=null&&String(b.name).trim())?String(b.name).trim().slice(0,200):null,
          price:Math.round(price*100)/100,
          note:(b.note!=null&&String(b.note).trim())?String(b.note).trim().slice(0,200):null,
          active:true,updated_at:new Date().toISOString()};
        await sbSend("POST","dealer_contract_prices?on_conflict=dealer_id,manufacturer,code",row,{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="clear_contract_price"){
        if(!b.dealer_id||!b.manufacturer||!b.code) return json(400,{error:"dealer_id, manufacturer, code required"});
        await sbSend("DELETE",`dealer_contract_prices?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&manufacturer=eq.${encodeURIComponent(b.manufacturer)}&code=eq.${encodeURIComponent(b.code)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="nomerge"){
        if(!b.id_a||!b.id_b) return json(400,{error:"id_a + id_b required"});
        const [a,c]=[b.id_a,b.id_b].sort();
        await sbSend("POST","dealer_nomerge",{a,b:c},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="split"){
        if(!b.alias_norm||!b.new_name) return json(400,{error:"alias_norm + new_name required"});
        await rpc("split_alias",{p_alias:b.alias_norm,p_new_name:b.new_name});
        return json(200,{ok:true});
      }
      if(act==="import_contacts"){
        const rows=Array.isArray(b.rows)?b.rows:[];
        if(!rows.length) return json(400,{error:"rows[] required"});
        const create=b.create!==false;
        // Store everything directly here (service role) instead of via a Postgres function,
        // so nothing can be silently blocked by a function that failed to install. The ONLY
        // requirement is that the two tables exist — probe them and say so plainly if not.
        try{ await sbGet("dealer_contacts?select=dealer_id&limit=1"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",result:{contacts:0,addresses:0,message:"The dealer_contacts table doesn't exist yet. Run create_tables.sql in Supabase, then re-import."}}); }
        try{ await sbGet("dealer_addresses?select=dealer_id&limit=1"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",result:{contacts:0,addresses:0,message:"The dealer_addresses table doesn't exist yet. Run create_tables.sql in Supabase, then re-import."}}); }

        const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
        const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
        const chunk=(arr,n)=>{const o=[];for(let i=0;i<arr.length;i+=n)o.push(arr.slice(i,i+n));return o;};
        const errors=[];

        // Optional clean slate: wipe existing contacts/addresses so a re-import lands only
        // on the correct (canonical) dealers — undoes any earlier mis-attached rows.
        if(b.replace){
          try{ await sbSend("DELETE","dealer_contacts?dealer_id=not.is.null",null,{Prefer:"return=minimal"}); }catch(e){ errors.push("wipe contacts: "+e.message); }
          try{ await sbSend("DELETE","dealer_addresses?dealer_id=not.is.null",null,{Prefer:"return=minimal"}); }catch(e){ errors.push("wipe addresses: "+e.message); }
        }

        // resolution map: normalized name/alias -> dealer_id
        const dealersAll=await sbGetAll("dealers?select=id,business_name");
        const aliasesAll=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
        const norm2id=new Map();
        for(const d of dealersAll) norm2id.set(dnorm(d.business_name), d.id);
        for(const a of aliasesAll) norm2id.set(a.alias_norm, a.dealer_id);

        // create unmatched companies (if allowed)
        let matched=0, created=0; const unmatched=[]; const createSet=new Map();
        for(const r of rows){ const nm=(r.company||"").trim(); if(!nm)continue; const k=dnorm(nm);
          if(norm2id.has(k)) matched++;
          else if(create){ if(!createSet.has(k)) createSet.set(k,nm); }
          else unmatched.push(nm); }
        if(createSet.size){
          const batch=[...createSet.values()].map(nm=>({business_name:nm,active:true,status:"prospect"}));
          try{
            const ins=await sbSend("POST","dealers?on_conflict=business_name",batch,{Prefer:"resolution=merge-duplicates,return=representation"});
            const aliasRows=[];
            for(const row of (ins||[])){ const k=dnorm(row.business_name); norm2id.set(k,row.id); aliasRows.push({alias_norm:k,raw_name:row.business_name,dealer_id:row.id}); }
            created=batch.length;
            if(aliasRows.length) await sbSend("POST","dealer_aliases?on_conflict=alias_norm",aliasRows,{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{});
          }catch(e){ errors.push("create dealers: "+e.message); }
        }

        // build de-duplicated bulk sets keyed by dealer
        const contactMap=new Map(), addrMap=new Map(), lineMap=new Map(), dealerUpd=new Map();
        for(const r of rows){ const nm=(r.company||"").trim(); if(!nm)continue; const id=norm2id.get(dnorm(nm)); if(!id)continue;
          if(!dealerUpd.has(id)) dealerUpd.set(id,{});
          const du=dealerUpd.get(id);
          if(!du.contact_name && r.contact) du.contact_name=r.contact;
          if(!du.email && r.email) du.email=String(r.email).trim();
          if(!du.phone && r.phone) du.phone=r.phone;
          for(const c of (r.contacts||[])){ const em=String(c.email||"").trim().toLowerCase(); if(!em)continue; const key=id+"|"+em;
            if(!contactMap.has(key)) contactMap.set(key,{dealer_id:id,email:em,name:c.name||null,title:c.title||null,role:c.role||null,phone:c.phone||null,cell:c.cell||null}); }
          for(const a of (r.addresses||[])){ const ad=String(a.address||"").trim(); if(!ad)continue;
            const ak=dnorm([ad,a.city,a.state].filter(Boolean).join(" ")); const key=id+"|"+ak;
            const lbl=String(a.label||""); const pri=/HQ/i.test(lbl)?3:(/\b(CORP|CORPORATE|HEADQUARTERS|MAIN|FLAGSHIP)\b/i.test(lbl)?2:1);
            const prev=addrMap.get(key); if(!prev||pri>prev.pri) addrMap.set(key,{dealer_id:id,addr_key:ak,address:ad,city:a.city||null,state:a.state||null,zip:a.zip||null,label:lbl||null,pri}); }
          for(const l of (r.lines||[])){ if(!l||!l.slug)continue; const key=id+"|"+l.slug;
            if(!lineMap.has(key)) lineMap.set(key,{dealer_id:id,manufacturer:l.slug,active:true,account_ref:(l.account||null)}); }
        }

        const contactsArr=[...contactMap.values()], addrArr=[...addrMap.values()], lineArr=[...lineMap.values()];
        let contactsStored=0, addressesStored=0, ents=0;
        for(const part of chunk(contactsArr,500)){ try{ await sbSend("POST","dealer_contacts?on_conflict=dealer_id,email",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); contactsStored+=part.length; }catch(e){ errors.push("contacts: "+e.message); } }
        for(const part of chunk(addrArr,500)){ try{ await sbSend("POST","dealer_addresses?on_conflict=dealer_id,addr_key",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); addressesStored+=part.length; }catch(e){ errors.push("addresses: "+e.message); } }
        for(const part of chunk(lineArr,500)){ try{ await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); ents+=part.length; }catch(e){ errors.push("lines: "+e.message); } }

        // per-dealer: set contact/email/phone + promote the top-ranked (HQ) address
        const primaryByDealer=new Map();
        for(const a of addrArr){ const p=primaryByDealer.get(a.dealer_id); if(!p||a.pri>p.pri) primaryByDealer.set(a.dealer_id,a); }
        const updates=[];
        for(const [id,du] of dealerUpd){ const pa=primaryByDealer.get(id); const patch={updated_at:new Date().toISOString()};
          if(du.contact_name)patch.contact_name=du.contact_name; if(du.email)patch.email=du.email; if(du.phone)patch.phone=du.phone;
          if(pa){ patch.address=pa.address; if(pa.city)patch.city=pa.city; if(pa.state)patch.state=pa.state; if(pa.zip)patch.zip=pa.zip; }
          updates.push({id,patch}); }
        for(const part of chunk(updates,20)){ await Promise.all(part.map(u=> sbSend("PATCH","dealers?id=eq."+u.id,u.patch,{Prefer:"return=minimal"}).catch(e=>{ if(errors.length<8) errors.push("dealer update: "+e.message); }) )); }

        return json(200,{ok:errors.length===0,result:{matched,created,updated:dealerUpd.size,entitlements:ents,contacts:contactsStored,addresses:addressesStored,unmatched,errors:errors.slice(0,6)}});
      }
      if(act==="approve_login"){
        if(!b.uid) return json(400,{error:"uid required"});
        // Was this login already approved? (reassigning an existing account shouldn't re-send
        // the welcome email — only the first approval does.)
        let prevStatus=null, loginEmail=null;
        try{ const cur=await sbGet(`dealer_users?uid=eq.${encodeURIComponent(b.uid)}&select=status,email`); if(cur&&cur[0]){ prevStatus=cur[0].status||null; loginEmail=cur[0].email||null; } }catch(e){}
        let dealerId=b.dealer_id||null;
        // Approve + create a brand-new dealer from the registrant's submitted details.
        if(!dealerId && b.new_dealer && String(b.new_dealer.business_name||"").trim()){
          const nd=b.new_dealer;
          const ins=await sbSend("POST","dealers",{
            business_name:String(nd.business_name).trim(),
            contact_name:nd.contact_name||null, email:nd.email||null, phone:nd.phone||null,
            address:nd.address||null, city:nd.city||null, state:nd.state||null, zip:nd.zip||null,
            active:true, status:"prospect"
          },{Prefer:"return=representation"});
          dealerId=ins&&ins[0]&&ins[0].id||null;
        }
        await rpc("approve_dealer_login",{p_uid:b.uid,p_dealer:dealerId||null,p_by:b.by||"admin"});
        // Auto-send the welcome email on the first approval only (not on later reassignments).
        if(prevStatus!=="approved"){
          let dealerName=null, dealerIsTest=false;
          if(dealerId){ try{ const dn=await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=business_name,is_test`); if(dn&&dn[0]){ dealerName=dn[0].business_name||null; dealerIsTest=!!dn[0].is_test; } }catch(e){} }
          // Welcome reaches a real dealer only when Live; before that, test accounts only.
          const pst=await P.getState();
          if(P.allowTransactional(pst.mode,dealerIsTest)){ try{ await sendWelcomeEmail(loginEmail, dealerName); }catch(e){ console.error("welcome email failed",e&&e.message); } }
          if(dealerId&&loginEmail){ try{ await sbSend("POST","dealer_activity",{dealer_id:dealerId,kind:"email",subject:"Welcome email sent",contact_email:loginEmail,actor:me.name||"admin"},{Prefer:"return=minimal"}); }catch(e){} }
        }
        return json(200,{ok:true,dealer_id:dealerId,welcomed:prevStatus!=="approved"});
      }
      if(act==="revoke_login"){
        if(!b.uid) return json(400,{error:"uid required"});
        await rpc("set_dealer_login_status",{p_uid:b.uid,p_status:b.status||"revoked"});
        return json(200,{ok:true});
      }
      // Change the actual portal SIGN-IN email (Supabase Auth) for a dealer login.
      // Accepts uid directly, or dealer_id (resolves the newest dealer_users row).
      if(act==="set_login_email"){
        const email=String(b.email||"").trim().toLowerCase();
        if(!EMAIL_RE.test(email)) return json(400,{error:"a valid email is required"});
        let uid=b.uid||null;
        if(!uid && b.dealer_id){
          const rows=await sbGet(`dealer_users?select=uid,created_at&dealer_id=eq.${encodeURIComponent(b.dealer_id)}&order=created_at.desc&limit=1`).catch(()=>[]);
          uid=rows&&rows[0]&&rows[0].uid||null;
        }
        if(!uid) return json(400,{error:"no portal login found for this dealer"});
        // Update Supabase Auth (the credential used to sign in) then mirror into dealer_users.
        await authAdmin("PUT",`users/${encodeURIComponent(uid)}`,{email,email_confirm:true});
        await sbSend("PATCH",`dealer_users?uid=eq.${encodeURIComponent(uid)}`,{email},{Prefer:"return=minimal"}).catch(()=>{});
        return json(200,{ok:true,uid,email});
      }
      // Approve a dealer's self-service account change → apply it to the dealer record
      // (and store shipping/billing as labeled addresses), then mark the request done.
      if(act==="approve_change"){
        if(!b.id) return json(400,{error:"id required"});
        const rows=await sbGet(`dealer_change_requests?id=eq.${encodeURIComponent(b.id)}&select=id,dealer_id,changes`).catch(()=>[]);
        const cr=rows&&rows[0];
        if(!cr) return json(400,{error:"change request not found"});
        const c=cr.changes||{}; const did=cr.dealer_id;
        if(did){
          const patch={updated_at:new Date().toISOString()};
          if(c.contact_name!=null) patch.contact_name=c.contact_name;
          if(c.email!=null) patch.email=c.email;
          if(c.phone!=null) patch.phone=c.phone;
          if(c.shipping){ patch.address=c.shipping.address||null; patch.city=c.shipping.city||null; patch.state=c.shipping.state||null; patch.zip=c.shipping.zip||null; }
          await sbSend("PATCH","dealers?id=eq."+encodeURIComponent(did),patch,{Prefer:"return=minimal"});
          // store shipping / billing as labeled addresses on file too
          const upAddr=(a,label,key)=>a?sbSend("POST","dealer_addresses?on_conflict=dealer_id,addr_key",
            {dealer_id:did,addr_key:key,address:a.address||null,city:a.city||null,state:a.state||null,zip:a.zip||null,label,pri:label==="Shipping"?2:1},
            {Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{}):null;
          await upAddr(c.shipping,"Shipping","ship");
          await upAddr(c.billing,"Billing","bill");
        }
        await sbSend("PATCH","dealer_change_requests?id=eq."+encodeURIComponent(b.id),{status:"approved",decided_at:new Date().toISOString(),decided_by:b.by||"admin"},{Prefer:"return=minimal"});
        return json(200,{ok:true,dealer_id:did||null});
      }
      if(act==="reject_change"){
        if(!b.id) return json(400,{error:"id required"});
        await sbSend("PATCH","dealer_change_requests?id=eq."+encodeURIComponent(b.id),{status:"rejected",decided_at:new Date().toISOString(),decided_by:b.by||"admin"},{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      // Delete a portal login entirely (removes the Auth user + the dealer_users row).
      // Use to clear a mistaken registration so the dealer can register again cleanly.
      if(act==="delete_login"){
        if(!b.uid) return json(400,{error:"uid required"});
        await authAdmin("DELETE",`users/${encodeURIComponent(b.uid)}`).catch(()=>{});
        await sbSend("DELETE",`dealer_users?uid=eq.${encodeURIComponent(b.uid)}`,null,{Prefer:"return=minimal"}).catch(()=>{});
        return json(200,{ok:true});
      }
      // Backfill the bundled master list (the same source that populated Zoho) into the
      // platform DB so it stays the source of truth. Two stages, sliced by offset/limit to
      // stay under the function timeout — mirrors the Zoho loader:
      //   {action:"backfill_master", stage:"accounts", offset, limit}  -> websites (+ fill
      //        empty phone/address) for matched dealers; creates missing companies as prospects.
      //   {action:"backfill_master", stage:"contacts", offset, limit}  -> the full contact
      //        roster into dealer_contacts, matched to its dealer by name.
      if(act==="backfill_master"){
        const master=require("./_zoho_master_data.js");
        const stage=b.stage||"accounts";
        const off=Number(b.offset)||0, lim=Number(b.limit)|| (stage==="contacts"?200:150);
        const create=b.create!==false;
        const chunk=(arr,n)=>{const o=[];for(let i=0;i<arr.length;i+=n)o.push(arr.slice(i,i+n));return o;};
        const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
        const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
        const clean=v=>{ const s=(v==null?"":String(v)).trim(); return s||null; };
        const errors=[];
        // resolution map: normalized business name / alias -> dealer_id (+ current fields)
        const dealersAll=await sbGetAll("dealers?select=id,business_name,phone,address,city,state,zip");
        const aliasesAll=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
        const norm2id=new Map(), byId=new Map();
        for(const d of dealersAll){ norm2id.set(dnorm(d.business_name),d.id); byId.set(d.id,d); }
        for(const a of aliasesAll){ if(!norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm,a.dealer_id); }

        if(stage==="accounts"){
          // The website column must exist first (supabase/master_backfill.sql).
          const probe=await fetch(`${SUPABASE_URL}/rest/v1/dealers?select=website&limit=1`,{headers:H()});
          if(probe.status>=400) return json(200,{ok:false,error:"column_missing",message:"Run supabase/master_backfill.sql in Supabase first (it adds the dealers.website column), then retry."});
          const slice=(master.accounts||[]).slice(off,off+lim);
          // create missing companies as prospects so their website/contacts have a home
          const toCreate=new Map();
          for(const a of slice){ const nm=(a.name||"").trim(); if(!nm)continue; const k=dnorm(nm);
            if(!norm2id.has(k) && create && !toCreate.has(k)) toCreate.set(k,nm); }
          let created=0;
          if(toCreate.size){
            const batch=[...toCreate.values()].map(nm=>({business_name:nm,active:true,status:"prospect"}));
            try{
              const ins=await sbSend("POST","dealers?on_conflict=business_name",batch,{Prefer:"resolution=merge-duplicates,return=representation"});
              const aliasRows=[];
              for(const row of (ins||[])){ const k=dnorm(row.business_name); norm2id.set(k,row.id); byId.set(row.id,{id:row.id,business_name:row.business_name}); aliasRows.push({alias_norm:k,raw_name:row.business_name,dealer_id:row.id}); }
              created=(ins||[]).length;
              if(aliasRows.length) await sbSend("POST","dealer_aliases?on_conflict=alias_norm",aliasRows,{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{});
            }catch(e){ errors.push("create: "+e.message); }
          }
          // patch website (always) + fill only-empty phone/address/city/state/zip
          let matched=0, websitesSet=0, filled=0; const updates=[];
          for(const a of slice){ const nm=(a.name||"").trim(); if(!nm)continue; const id=norm2id.get(dnorm(nm)); if(!id)continue; matched++;
            const cur=byId.get(id)||{}; const patch={};
            if(clean(a.website)){ patch.website=clean(a.website); websitesSet++; }
            if(clean(a.phone) && !cur.phone) patch.phone=clean(a.phone);
            if(clean(a.street) && !cur.address) patch.address=clean(a.street);
            if(clean(a.city) && !cur.city) patch.city=clean(a.city);
            if(clean(a.state) && !cur.state) patch.state=clean(a.state);
            if(clean(a.zip) && !cur.zip) patch.zip=clean(a.zip);
            if(patch.phone||patch.address||patch.city||patch.state||patch.zip) filled++;
            if(Object.keys(patch).length){ patch.updated_at=new Date().toISOString(); updates.push({id,patch}); }
          }
          for(const part of chunk(updates,20)){ await Promise.all(part.map(u=> sbSend("PATCH","dealers?id=eq."+u.id,u.patch,{Prefer:"return=minimal"}).catch(e=>{ if(errors.length<8)errors.push("patch: "+e.message); }))); }
          return json(200,{ok:errors.length===0,stage,offset:off,count:slice.length,total:(master.accounts||[]).length,matched,created,websitesSet,filled,errors:errors.slice(0,6)});
        }

        // contacts stage — the full roster into dealer_contacts (match by company name)
        try{ await sbGet("dealer_contacts?select=dealer_id&limit=1"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",message:"dealer_contacts doesn't exist yet — run create_tables.sql, then retry."}); }
        const slice=(master.contacts||[]).slice(off,off+lim);
        const contactMap=new Map(); let unmatched=0;
        for(const c of slice){ const nm=(c.company||"").trim(); if(!nm)continue; const id=norm2id.get(dnorm(nm)); if(!id){unmatched++;continue;}
          const em=String(c.email||"").trim().toLowerCase(); if(!em)continue;
          const name=[c.first,c.last].filter(Boolean).join(" ").trim()||null;
          const key=id+"|"+em;
          if(!contactMap.has(key)) contactMap.set(key,{dealer_id:id,email:em,name,title:clean(c.title),role:clean(c.dept),phone:clean(c.phone),cell:clean(c.mobile)});
        }
        const arr=[...contactMap.values()]; let stored=0;
        for(const part of chunk(arr,500)){ try{ await sbSend("POST","dealer_contacts?on_conflict=dealer_id,email",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); stored+=part.length; }catch(e){ errors.push("contacts: "+e.message); } }
        return json(200,{ok:errors.length===0,stage,offset:off,count:slice.length,total:(master.contacts||[]).length,stored,unmatched,errors:errors.slice(0,6)});
      }
      // ---- Sales attribution tools (fix sold-to vs ship-to / branch roll-up) ----
      // Read: break a dealer's stored sales into assignable groups — one per
      // (manufacturer, account #, reported name) — with $ + record counts, plus this
      // dealer's branch records as reassignment targets. Drives the "which location got
      // this order?" workflow.
      if(act==="attribution_breakdown"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        const rows=await sbGetAll(`monthly_sales?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&select=manufacturer,customer_ref,customer_name,amount`,"id").catch(()=>[]);
        const g=new Map();
        for(const r of (rows||[])){ const key=(r.manufacturer||"")+"|"+(r.customer_ref||"")+"|"+(r.customer_name||"");
          const o=g.get(key)||{manufacturer:r.manufacturer||"",account_ref:r.customer_ref||"",customer_name:r.customer_name||"",sales:0,records:0};
          o.sales+=Number(r.amount)||0; o.records++; g.set(key,o); }
        const groups=[...g.values()].map(o=>({...o,sales:Math.round(o.sales*100)/100})).sort((a,b)=>b.sales-a.sales);
        const self=await sbGet(`dealers?id=eq.${encodeURIComponent(b.dealer_id)}&select=id,business_name,parent_id`).catch(()=>[]);
        const s=(self&&self[0])||{};
        // targets: this dealer's branches, plus (if it is itself a branch) its HQ and siblings
        let targets=await sbGet(`dealers?parent_id=eq.${encodeURIComponent(b.dealer_id)}&select=id,business_name`).catch(()=>[]);
        if(s.parent_id){ const fam=await sbGet(`dealers?or=(id.eq.${encodeURIComponent(s.parent_id)},parent_id.eq.${encodeURIComponent(s.parent_id)})&select=id,business_name`).catch(()=>[]); targets=(targets||[]).concat(fam||[]); }
        const seen=new Set(); const branches=(targets||[]).filter(x=>x.id!==b.dealer_id && !seen.has(x.id) && seen.add(x.id)).map(x=>({id:x.id,name:x.business_name}));
        return json(200,{ok:true,dealer:{id:b.dealer_id,name:s.business_name||"",parent_id:s.parent_id||null},branches,groups});
      }
      // Write: move a group of sales (matched by account #, reported name, or source dealer)
      // onto the branch that actually received the order, optionally carrying the manufacturer
      // account number with it (and clearing it off any other record).
      if(act==="reattribute"){
        const slug=String(b.manufacturer||"").trim(); const to=b.to_dealer_id;
        if(!slug||!to) return json(400,{error:"manufacturer + to_dealer_id required"});
        let filt=`monthly_sales?manufacturer=eq.${encodeURIComponent(slug)}`;
        const ref=(b.account_ref!=null)?String(b.account_ref).trim():"";
        if(ref) filt+=`&customer_ref=eq.${encodeURIComponent(ref)}`;
        else if(b.customer_name) filt+=`&customer_name=eq.${encodeURIComponent(String(b.customer_name))}`;
        else if(b.from_dealer_id) filt+=`&dealer_id=eq.${encodeURIComponent(b.from_dealer_id)}`;
        else return json(400,{error:"one of account_ref, customer_name, or from_dealer_id required"});
        const patched=await sbSend("PATCH",filt,{dealer_id:to},{Prefer:"return=representation"}).catch(()=>null);
        const moved=Array.isArray(patched)?patched.length:0;
        if(b.move_account_ref && ref){
          await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",{dealer_id:to,manufacturer:slug,account_ref:ref,active:true},{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{});
          await sbSend("PATCH",`dealer_manufacturers?manufacturer=eq.${encodeURIComponent(slug)}&account_ref=eq.${encodeURIComponent(ref)}&dealer_id=neq.${encodeURIComponent(to)}`,{account_ref:null},{Prefer:"return=minimal"}).catch(()=>{});
        }
        return json(200,{ok:true,moved});
      }
      // Clear order-number values wrongly stored in the account-number field for a line
      // (e.g. Strongback), and remember the line so imports match it by NAME only from now on.
      if(act==="clear_order_refs"){
        const slug=String(b.manufacturer||"").trim(); if(!slug) return json(400,{error:"manufacturer required"});
        const patched=await sbSend("PATCH",`dealer_manufacturers?manufacturer=eq.${encodeURIComponent(slug)}&account_ref=not.is.null`,{account_ref:null},{Prefer:"return=representation"}).catch(()=>null);
        const cleared=Array.isArray(patched)?patched.length:0;
        try{
          const cur=await sbGet(`app_settings?key=eq.commission_config&select=value`).catch(()=>[]);
          const val=(cur&&cur[0]&&cur[0].value)||{};
          const set=new Set(val.order_number_lines||[]); set.add(slug); val.order_number_lines=[...set];
          await sbSend("POST","app_settings?on_conflict=key",{key:"commission_config",value:val,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
        }catch(e){}
        return json(200,{ok:true,cleared});
      }
      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};

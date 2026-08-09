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

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email,can_travel:!!su.can_travel}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:"",can_travel:true};
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
      const row={
        owner_email:me.email||null, rep_name:me.rep_name||null, name,
        scheduled_date:(b.scheduled_date&&String(b.scheduled_date).trim())||null,
        home_base:b.home_base||null, round_trip:b.round_trip!==false,
        stops:Array.isArray(b.stops)?b.stops:[],
        distance_m:isFinite(b.distance_m)?b.distance_m:null, duration_s:isFinite(b.duration_s)?b.duration_s:null,
        geometry:b.geometry||null, notes:(b.notes!=null?String(b.notes):null),
        updated_at:new Date().toISOString(),
      };
      if(b.id){
        // ownership check
        const cur=await sbGet(`rep_routes?id=eq.${encodeURIComponent(b.id)}&select=owner_email`).catch(()=>[]);
        const own=cur&&cur[0]; if(!own) return json(404,{error:"route not found"});
        if(me.role!=="president" && String(own.owner_email||"").toLowerCase()!==String(me.email||"").toLowerCase()) return json(403,{error:"not your route"});
        await sbSend("PATCH",`rep_routes?id=eq.${encodeURIComponent(b.id)}`,row,{Prefer:"return=minimal"});
        return json(200,{ok:true,id:b.id});
      }
      const ins=await sbSend("POST","rep_routes",row,{Prefer:"return=representation"});
      return json(200,{ok:true,id:ins&&ins[0]&&ins[0].id});
    }
    if(b.action==="list_routes"){
      let path="rep_routes?select=id,name,scheduled_date,stops,distance_m,duration_s,round_trip,updated_at&order=scheduled_date.desc.nullslast,updated_at.desc";
      if(me.role!=="president") path+=`&owner_email=eq.${encodeURIComponent(me.email||"~none~")}`;
      const rows=await sbGet(path).catch(()=>[]);
      const routes=(rows||[]).map(r=>({id:r.id,name:r.name,scheduled_date:r.scheduled_date,stops_count:(r.stops||[]).length,
        distance_m:r.distance_m,duration_s:r.duration_s,round_trip:r.round_trip,updated_at:r.updated_at}));
      return json(200,{ok:true,routes});
    }
    if(b.action==="get_route"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`rep_routes?id=eq.${encodeURIComponent(b.id)}&select=*`).catch(()=>[]);
      const r=rows&&rows[0]; if(!r) return json(404,{error:"route not found"});
      if(me.role!=="president" && String(r.owner_email||"").toLowerCase()!==String(me.email||"").toLowerCase()) return json(403,{error:"not your route"});
      return json(200,{ok:true,route:r});
    }
    if(b.action==="delete_route"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`rep_routes?id=eq.${encodeURIComponent(b.id)}&select=owner_email`).catch(()=>[]);
      const r=rows&&rows[0]; if(!r) return json(200,{ok:true});
      if(me.role!=="president" && String(r.owner_email||"").toLowerCase()!==String(me.email||"").toLowerCase()) return json(403,{error:"not your route"});
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
      const mfrName=Object.fromEntries((mfrs||[]).map(m=>[m.slug,m.name]));
      const nameOf=s=>mfrName[s]||mfrName[normBuy(s)]||pretty(s);
      const YR=String(new Date().getFullYear());
      const cutoff60=new Date(Date.now()-60*864e5).toISOString().slice(0,10);
      // aggregate sales + products per LOCATION (the primary figures), then roll totals up to
      // the company so a handout can show "this location vs the whole company".
      const byDealer={}; const prodByDealer={};
      for(const r of (sales||[])){
        const did=r.dealer_id; if(!did) continue;
        const d=byDealer[did]||(byDealer[did]={lines:{},total:0,ytd:0,recent:0,buys:new Set()});
        const slug=normBuy(r.manufacturer); const amt=Number(r.amount)||0; const per=(r.period||"").slice(0,10);
        const L=d.lines[slug]||(d.lines[slug]={name:nameOf(slug),amount:0,qty:0,orders:0,last:""});
        L.amount+=amt; L.qty+=Number(r.qty)||0; L.orders+=1; if(per>L.last) L.last=per;
        d.total+=amt; if(per.startsWith(YR)) d.ytd+=amt; if(per>=cutoff60) d.recent+=amt; if(r.manufacturer) d.buys.add(slug);
        const pcode=String(r.product_code||"").trim(), pname=String(r.product_name||"").trim();
        if(pcode||pname){ const pk=(pcode||pname).toLowerCase(); const pd=prodByDealer[did]||(prodByDealer[did]={});
          const P=pd[pk]||(pd[pk]={code:pcode,name:pname||pcode,line:nameOf(slug),qty:0,amount:0,orders:0,last:""});
          P.qty+=Number(r.qty)||0; P.amount+=amt; P.orders+=1; if(per>P.last) P.last=per; }
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
      const cases={};
      for(const id of ids){
        const d=byId[id]; if(!d) continue;
        const cid=companyOf(id); const master=byId[cid]||d;   // company-level governing account
        let acc; try{ acc=computeAccess({state:master.state||d.state,business_name:master.business_name||d.business_name,ovation_access:!!(master.ovation_access||d.ovation_access),golden_status:(master.golden_status||d.golden_status||"None"),lat:null},[]); }catch(e){ acc={your_accounts:[],available:[],golden:"None"}; }
        const eligible=[...new Set([...(acc.your_accounts||[]),...(acc.available||[])])];
        const s=byDealer[id]||{lines:{},total:0,ytd:0,recent:0,buys:new Set()};
        const coBuySet=coBuys[cid]||new Set();
        const opps=eligible.filter(x=>!coBuySet.has(x)).map(x=>({slug:x,name:nameOf(x),logo:logoBySlug[x]||""}));
        const lines=Object.entries(s.lines).map(([slug,v])=>({slug,name:v.name,amount:Math.round(v.amount*100)/100,orders:v.orders,last:v.last})).sort((a,b)=>b.amount-a.amount);
        const allProds=Object.values(prodByDealer[id]||{}).sort((a,b)=>b.amount-a.amount);
        const products=allProds.slice(0,40).map(p=>({code:p.code,name:p.name,line:p.line,qty:p.qty,amount:Math.round(p.amount*100)/100,orders:p.orders,last:p.last}));
        const products_more=Math.max(0,allProds.length-products.length);
        const accounts=(acctByCo[cid]||[]).map(a=>({slug:a.manufacturer,name:nameOf(a.manufacturer),account:a.account_ref})).sort((a,b)=>a.name.localeCompare(b.name));
        const carried=[...new Set(accounts.map(a=>a.slug))].map(sl=>({slug:sl,name:nameOf(sl),logo:logoBySlug[sl]||""}));
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
          lines, opps, accounts, carried, products, products_more,
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

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

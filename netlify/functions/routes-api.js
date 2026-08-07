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

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

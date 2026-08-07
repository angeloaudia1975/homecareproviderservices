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
      const idIn=`in.(${ids.join(",")})`;
      const [dealers,sales,contacts,mfrs,dm] = await Promise.all([
        sbGet(`dealers?id=${idIn}&select=id,business_name,hcps_account,contact_name,email,phone,address,city,state,zip,parent_id,golden_status,ovation_access,golden_url`).catch(()=>[]),
        sbGet(`monthly_sales?dealer_id=${idIn}&select=dealer_id,manufacturer,period,amount,qty`).catch(()=>[]),
        sbGet(`dealer_contacts?dealer_id=${idIn}&select=dealer_id,name,email,phone,cell,title,role`).catch(()=>[]),
        sbGet("manufacturers?select=slug,name").catch(()=>[]),
        sbGet(`dealer_manufacturers?dealer_id=${idIn}&select=dealer_id,manufacturer,account_ref,active`).catch(()=>[]),
      ]);
      // manufacturer accounts on file per dealer (the lines they carry + account numbers)
      const acctByDealer={};
      for(const x of (dm||[])){ if(x.active===false) continue; (acctByDealer[x.dealer_id]||(acctByDealer[x.dealer_id]=[])).push({manufacturer:x.manufacturer,account_ref:x.account_ref||""}); }
      // parents (for a branch's governing state/name)
      const parentIds=[...new Set(dealers.map(d=>d.parent_id).filter(Boolean))];
      let parents=[]; if(parentIds.length){ parents=await sbGet(`dealers?id=in.(${parentIds.join(",")})&select=id,business_name,state`).catch(()=>[]); }
      const parById=Object.fromEntries(parents.map(p=>[p.id,p]));
      const mfrName=Object.fromEntries((mfrs||[]).map(m=>[m.slug,m.name]));
      const nameOf=s=>mfrName[s]||mfrName[normBuy(s)]||pretty(s);
      // sales per dealer -> per line
      const byDealer={};
      for(const r of (sales||[])){
        const did=r.dealer_id; if(!did) continue;
        const d=byDealer[did]||(byDealer[did]={lines:{},total:0,buys:new Set()});
        const slug=normBuy(r.manufacturer); const amt=Number(r.amount)||0;
        const L=d.lines[slug]||(d.lines[slug]={name:nameOf(slug),amount:0,qty:0,orders:0,last:""});
        L.amount+=amt; L.qty+=Number(r.qty)||0; L.orders+=1;
        const per=(r.period||"").slice(0,10); if(per>L.last) L.last=per;
        d.total+=amt; if(r.manufacturer) d.buys.add(slug);
      }
      const contactsByDealer={};
      for(const c of (contacts||[])){ (contactsByDealer[c.dealer_id]||(contactsByDealer[c.dealer_id]=[])).push(c); }
      const cases={};
      for(const d of dealers){
        const gov = d.parent_id&&parById[d.parent_id] ? parById[d.parent_id] : d;
        let acc; try{ acc=computeAccess({state:gov.state||d.state,business_name:gov.business_name||d.business_name,ovation_access:!!d.ovation_access,lat:null},[]); }catch(e){ acc={your_accounts:[],available:[]}; }
        const eligible=[...new Set([...(acc.your_accounts||[]),...(acc.available||[])])];
        const s=byDealer[d.id]||{lines:{},total:0,buys:new Set()};
        const opps=eligible.filter(x=>!s.buys.has(x)).map(x=>({slug:x,name:nameOf(x)}));
        const lines=Object.entries(s.lines).map(([slug,v])=>({slug,name:v.name,amount:Math.round(v.amount*100)/100,orders:v.orders,last:v.last})).sort((a,b)=>b.amount-a.amount);
        const accounts=(acctByDealer[d.id]||[]).map(a=>({slug:a.manufacturer,name:nameOf(a.manufacturer),account:a.account_ref})).sort((a,b)=>a.name.localeCompare(b.name));
        const carried=[...new Set(accounts.map(a=>a.slug))].map(sl=>({slug:sl,name:nameOf(sl)}));
        cases[d.id]={
          name:d.business_name||"", account:d.hcps_account||"", contact_name:d.contact_name||"", email:d.email||"", phone:d.phone||"",
          address:d.address||"", city:d.city||"", state:d.state||"", zip:d.zip||"",
          total:Math.round((s.total||0)*100)/100, lines, opps, accounts, carried,
          golden:d.golden_status||"None", ovation:!!d.ovation_access,
          contacts:(contactsByDealer[d.id]||[]).map(c=>({name:c.name||"",email:c.email||"",phone:c.phone||"",cell:c.cell||"",title:c.title||"",role:c.role||""})),
        };
      }
      return json(200,{ok:true,cases});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

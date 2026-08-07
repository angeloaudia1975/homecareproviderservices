// HCPS admin — Geocoding + map data. Service-role, server-side. No npm deps.
//
//   GET  /.netlify/functions/geocode-api            -> map points (geocoded dealer locations)
//   POST /.netlify/functions/geocode-api {action}   -> status | run  (batch geocode)
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)
//
// Coordinates are cached in the `geocache` table keyed by the normalized address
// string, so re-importing contacts never loses them. Uses the free US Census
// geocoder (no API key, US addresses).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUILD = "geocode-api v2 (pin classes)";

// Territory rules — to flag each dealer's growth opportunities on the map.
const { computeAccess } = require("./_access.js");
// Normalize a monthly_sales manufacturer slug to the catalog/access slug so "what they buy"
// lines up with "what they're eligible for" (reports say bongo/golden; catalog says the rest).
const NORM_BUY={ bongo:"airavant-bongorx", airavant:"airavant-bongorx", "golden":"golden-technologies", "ohio-medical":"gce" };
const normBuy=s=>{ s=String(s||"").toLowerCase().trim(); return NORM_BUY[s]||s; };

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sbGet(path){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()});
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
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

// Build the normalized address key used for both geocoding and cache lookup.
function qkey(a){
  const parts=[a.address, a.city, [a.state,a.zip].filter(Boolean).join(" ")].map(x=>String(x||"").trim()).filter(Boolean);
  return parts.join(", ").toLowerCase().replace(/\s+/g," ").trim();
}
// One address -> {lat,lng} via the US Census geocoder, or null if no match.
async function geocodeCensus(q){
  const url=`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`;
  try{
    const r=await fetch(url); if(!r.ok) return null;
    const j=await r.json();
    const m=j&&j.result&&j.result.addressMatches&&j.result.addressMatches[0];
    if(!m||!m.coordinates) return null;
    return {lat:Number(m.coordinates.y), lng:Number(m.coordinates.x)};
  }catch(e){ return null; }
}
// OpenStreetMap Nominatim — geocodes the valid streets AND the city/ZIP lookups that
// the Census geocoder returns nothing for. Light, incremental use here; sends a
// descriptive User-Agent per OSM's usage policy. Called sequentially (see run) so we
// stay within ~1 request/second.
async function geocodeNominatim(q){
  if(!q) return null;
  try{
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
    const r=await fetch(url,{headers:{"User-Agent":"HCPS-DealerMap/1.0 (admin@homecareproviderservices.us)","Accept":"application/json"}});
    if(!r.ok) return null;
    const j=await r.json();
    if(Array.isArray(j)&&j[0]&&j[0].lat&&j[0].lon) return {lat:Number(j[0].lat),lng:Number(j[0].lon)};
  }catch(e){}
  return null;
}
// Geocode a dealer address: exact street via Census first (fast); if it can't match,
// fall back to Nominatim for the full street, then the city/state/ZIP (town-level).
// approx=true means the pin is town-level, not the exact street.
async function geocodeParts(a){
  const exact=await geocodeCensus(qkey(a));
  if(exact) return {...exact, approx:false};
  const full=[a.address,a.city,a.state,a.zip].map(x=>String(x||"").trim()).filter(Boolean).join(", ");
  const n=await geocodeNominatim(full);
  if(n) return {...n, approx:false};
  const city=[a.city,a.state,a.zip].map(x=>String(x||"").trim()).filter(Boolean).join(", ");
  const c=await geocodeNominatim(city);
  if(c) return {...c, approx:true};
  return null;
}
// Run promises with a small concurrency cap (keeps us well under the function timeout).
async function pool(items, n, fn){
  const out=[]; let i=0;
  const workers=Array.from({length:Math.min(n,items.length)},async()=>{
    while(i<items.length){ const idx=i++; out[idx]=await fn(items[idx],idx); }
  });
  await Promise.all(workers); return out;
}

// Distinct address keys currently in dealer_addresses (+ the primary dealers.address).
async function allAddressKeys(){
  const addrs=await sbGetAll("dealer_addresses?select=address,city,state,zip","address").catch(()=>[]);
  const map=new Map();
  for(const a of addrs){ const q=qkey(a); if(q) map.set(q,a); }
  return map; // q -> sample address parts
}

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",can_travel:!!su.can_travel,name:su.name||email}; return null; } }
    }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN;
  const got=event.headers["x-analytics-token"]||event.headers["X-Analytics-Token"]||"";
  if(!need) return {role:"president",rep_name:"",can_travel:true,name:"Admin"};
  if(got===need) return {role:"president",rep_name:"",can_travel:true,name:"Admin"};
  return null;
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});

    // ---- GET: map points (join geocoded addresses to their dealers) ----
    if(event.httpMethod==="GET"){
      let addrs, cache;
      try{
        addrs=await sbGetAll("dealer_addresses?select=dealer_id,address,city,state,zip,label,dealers(business_name,status,email)","dealer_id");
        cache=await sbGetAll("geocache?select=q,lat,lng,ok,approx","q");
      }catch(e){
        return json(200,{ok:false,error:"tables_missing",points:[],message:"Run geocode.sql (and create_tables.sql) in Supabase, then reload."});
      }
      const cmap=new Map(); for(const c of cache){ if(c.ok&&c.lat!=null) cmap.set(c.q,c); }
      const points=[]; const unmapped=[];
      for(const a of addrs){
        const d=a.dealers||{};
        const c=cmap.get(qkey(a));
        if(!c){ unmapped.push({dealer_id:a.dealer_id||"",name:d.business_name||"(unknown)",status:d.status||"",
          address:a.address||"",city:a.city||"",state:a.state||"",zip:a.zip||""}); continue; }
        points.push({lat:c.lat,lng:c.lng,approx:!!c.approx,name:d.business_name||"(unknown)",status:d.status||"",
          email:d.email||"",address:a.address||"",city:a.city||"",state:a.state||"",zip:a.zip||"",label:a.label||"",dealer_id:a.dealer_id||""});
      }
      // Classify each pin: prospect (no sales), customer (buys all eligible lines), or
      // opportunity (buys something but has eligible lines it isn't buying yet).
      const buysByDealer=new Map(); const salesTot=new Map();
      try{ const sales=await sbGetAll("monthly_sales?select=dealer_id,manufacturer,amount","id");
        for(const r of (sales||[])){ if(!r.dealer_id) continue;
          if(r.manufacturer){ const set=buysByDealer.get(r.dealer_id)||buysByDealer.set(r.dealer_id,new Set()).get(r.dealer_id); set.add(normBuy(r.manufacturer)); }
          salesTot.set(r.dealer_id,(salesTot.get(r.dealer_id)||0)+(Number(r.amount)||0)); } }catch(e){}
      const lastVisit=new Map();
      try{ const vis=await sbGetAll("dealer_visits?select=dealer_id,visited_at","visited_at");
        for(const v of (vis||[])){ if(!v.dealer_id) continue; const cur=lastVisit.get(v.dealer_id); if(!cur||v.visited_at>cur) lastVisit.set(v.dealer_id,v.visited_at); } }catch(e){}
      for(const p of points){
        const buys=buysByDealer.get(p.dealer_id)||new Set();
        p.sales=Math.round((salesTot.get(p.dealer_id)||0)*100)/100;
        p.last_visit=lastVisit.get(p.dealer_id)||null;
        if(buys.size===0){ p.klass="prospect"; p.opps=[]; p.buys_count=0; p.opps_count=0; continue; }
        let acc; try{ acc=computeAccess({state:p.state,business_name:p.name,ovation_access:false,lat:null},[]); }catch(e){ acc={your_accounts:[],available:[]}; }
        const eligible=new Set([...(acc.your_accounts||[]),...(acc.available||[])]);
        const opps=[...eligible].filter(s=>!buys.has(s));
        p.klass=opps.length?"opportunity":"customer"; p.opps=opps; p.buys_count=buys.size; p.opps_count=opps.length;
      }
      if(me.role!=="president"){
        const rn=String(me.rep_name||"").trim().toLowerCase();
        const rep={}; try{ const dir=await sbGetAll("dealer_directory?select=dealer_name,rep_name","dealer_name"); for(const d of (dir||[])) rep[d.dealer_name]=d.rep_name||""; }catch(e){}
        const mine=p=> !!rn && String(rep[p.name]||"").trim().toLowerCase()===rn;
        return json(200,{ok:true,build:BUILD,role:me.role,points:points.filter(mine),unmapped:unmapped.filter(mine)});
      }
      return json(200,{ok:true,build:BUILD,role:me.role,points,unmapped});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

      // ---- status: how many address keys still need geocoding ----
      if(b.action==="status"){
        if(me.role!=="president") return json(403,{error:"President only"});
        let keys, cache;
        try{ keys=await allAddressKeys(); cache=await sbGetAll("geocache?select=q,ok","q"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run geocode.sql and create_tables.sql in Supabase first."}); }
        const done=new Set(cache.map(c=>c.q));   // matches the run action: cached = done
        let remaining=0; for(const q of keys.keys()) if(!done.has(q)) remaining++;
        return json(200,{ok:true,build:BUILD,total:keys.size,cached:done.size,remaining});
      }

      // ---- run: geocode up to `limit` uncached address keys ----
      if(b.action==="run"){
        if(me.role!=="president") return json(403,{error:"President only"});
        const limit=Math.min(Math.max(parseInt(b.limit,10)||20,1),40);
        let keys, cache;
        try{ keys=await allAddressKeys(); cache=await sbGetAll("geocache?select=q,ok","q"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run geocode.sql and create_tables.sql in Supabase first."}); }
        const done=new Set(cache.map(c=>c.q));   // once cached (success OR failure) it's done — no infinite retry
        const todo=[...keys.keys()].filter(q=>!done.has(q)).slice(0,limit);
        if(!todo.length) return json(200,{ok:true,processed:0,matched:0,remaining:0});
        // Process SEQUENTIALLY within a time budget: Census is fast, but its misses fall
        // back to Nominatim (rate-limited to ~1/sec). We stop before the function timeout
        // and only persist what we actually attempted; anything we didn't reach stays
        // uncached and the client's loop picks it up on the next run.
        const rows=[]; const t0=Date.now();
        for(const q of todo){
          if(rows.length && Date.now()-t0>7000) break;   // leave slack for the write
          const a=keys.get(q)||{}; const g=await geocodeParts(a);
          rows.push({q,lat:g?g.lat:null,lng:g?g.lng:null,ok:!!g,approx:g?!!g.approx:false,geocoded_at:new Date().toISOString()});
        }
        if(rows.length) await sbSend("POST","geocache?on_conflict=q",rows,{Prefer:"resolution=merge-duplicates,return=minimal"});
        const matched=rows.filter(r=>r.ok).length;
        const remaining=[...keys.keys()].filter(q=>!done.has(q)).length - rows.length;
        return json(200,{ok:true,processed:rows.length,matched,remaining:Math.max(0,remaining)});
      }

      // Geocode a single typed address (used to set the route "home base").
      if(b.action==="geocode_one"){
        const q=String(b.q||"").trim(); if(!q) return json(400,{error:"q required"});
        const g=await geocodeCensus(q);
        if(!g) return json(200,{ok:false,error:"not_found"});
        return json(200,{ok:true,lat:g.lat,lng:g.lng});
      }

      return json(400,{error:"unknown action"});
    }

    return json(405,{error:"method not allowed"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

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
const BUILD = "geocode-api v1 (2026-08-04)";

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

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    const need=process.env.ANALYTICS_TOKEN;
    if(need){ const got=event.headers["x-analytics-token"]||event.headers["X-Analytics-Token"]; if(got!==need) return json(401,{error:"unauthorized"}); }

    // ---- GET: map points (join geocoded addresses to their dealers) ----
    if(event.httpMethod==="GET"){
      let addrs, cache;
      try{
        addrs=await sbGetAll("dealer_addresses?select=dealer_id,address,city,state,zip,label,dealers(business_name,status,email)","dealer_id");
        cache=await sbGetAll("geocache?select=q,lat,lng,ok","q");
      }catch(e){
        return json(200,{ok:false,error:"tables_missing",points:[],message:"Run geocode.sql (and create_tables.sql) in Supabase, then reload."});
      }
      const cmap=new Map(); for(const c of cache){ if(c.ok&&c.lat!=null) cmap.set(c.q,c); }
      const points=[];
      for(const a of addrs){
        const c=cmap.get(qkey(a)); if(!c) continue;
        const d=a.dealers||{};
        points.push({lat:c.lat,lng:c.lng,name:d.business_name||"(unknown)",status:d.status||"",
          email:d.email||"",city:a.city||"",state:a.state||"",label:a.label||"",dealer_id:a.dealer_id||""});
      }
      return json(200,{ok:true,build:BUILD,points});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

      // ---- status: how many address keys still need geocoding ----
      if(b.action==="status"){
        let keys, cache;
        try{ keys=await allAddressKeys(); cache=await sbGetAll("geocache?select=q","q"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run geocode.sql and create_tables.sql in Supabase first."}); }
        const done=new Set(cache.map(c=>c.q));
        let remaining=0; for(const q of keys.keys()) if(!done.has(q)) remaining++;
        return json(200,{ok:true,build:BUILD,total:keys.size,cached:done.size,remaining});
      }

      // ---- run: geocode up to `limit` uncached address keys ----
      if(b.action==="run"){
        const limit=Math.min(Math.max(parseInt(b.limit,10)||20,1),40);
        let keys, cache;
        try{ keys=await allAddressKeys(); cache=await sbGetAll("geocache?select=q","q"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run geocode.sql and create_tables.sql in Supabase first."}); }
        const done=new Set(cache.map(c=>c.q));
        const todo=[...keys.keys()].filter(q=>!done.has(q)).slice(0,limit);
        if(!todo.length) return json(200,{ok:true,processed:0,matched:0,remaining:0});
        const rows=await pool(todo,5,async(q)=>{
          const g=await geocodeCensus(q);
          return {q,lat:g?g.lat:null,lng:g?g.lng:null,ok:!!g,geocoded_at:new Date().toISOString()};
        });
        await sbSend("POST","geocache?on_conflict=q",rows,{Prefer:"resolution=merge-duplicates,return=minimal"});
        const matched=rows.filter(r=>r.ok).length;
        const remaining=[...keys.keys()].filter(q=>!done.has(q)).length - todo.length;
        return json(200,{ok:true,processed:todo.length,matched,remaining:Math.max(0,remaining)});
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

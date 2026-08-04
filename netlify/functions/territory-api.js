// HCPS admin — Territory assignments (manufacturer lines by state). Service-role.
//
//   GET  /.netlify/functions/territory-api            -> { manufacturers, states, assignments }
//   POST /.netlify/functions/territory-api {action}   -> set_line | set_state
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const BUILD = "territory-api v1 (2026-08-04)";

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbGetAll(base, orderCol="state"){
  const PAGE=1000; let from=0,out=[];
  for(;;){const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE;}
  return out;
}
async function sbSend(method,path,body,extraHeaders){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extraHeaders||{})},body:body!=null?JSON.stringify(body):undefined});
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t=await r.text(); return t?JSON.parse(t):null;
}
async function fetchJson(url){ const r=await fetch(url); if(!r.ok) throw new Error("fetch "+r.status); return r.json(); }

// Lines we NO LONGER represent — excluded from the Territory picker AND from business-
// development targeting. Add a slug here to retire a line company-wide (rep-facing tools).
const NOT_REPRESENTED=new Set(["complete-medical-supplies"]);
const STATES=["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

function pretty(slug){ return String(slug||"").split("-").map(w=>w?w[0].toUpperCase()+w.slice(1):w).join(" "); }
// The full set of lines we REPRESENT (broader than what's orderable on this platform):
// orderable lines (nice names) + the Supabase manufacturers table + every line any dealer
// actually holds an account on (dealer_manufacturers) — so account-only lines like Golden
// (golden-technologies), sold on a separate platform, still appear for territory + targeting.
async function manufacturers(){
  const nameMap={};
  try{ const j=await fetchJson(`${ORDERING_BASE}/data/manufacturers.json`); (j||[]).forEach(x=>{ if(x&&x.slug&&x.hidden!==true && !nameMap[x.slug]) nameMap[x.slug]=x.name||pretty(x.slug); }); }catch(e){}
  try{ const m=await sbGet("manufacturers?select=slug,name"); (m||[]).forEach(x=>{ if(x&&x.slug&&!nameMap[x.slug]) nameMap[x.slug]=x.name||pretty(x.slug); }); }catch(e){}
  try{ const dm=await sbGetAll("dealer_manufacturers?select=manufacturer","manufacturer"); (dm||[]).forEach(x=>{ const s=x&&x.manufacturer; if(s&&!(s in nameMap)) nameMap[s]=pretty(s); }); }catch(e){}
  const list=Object.keys(nameMap).filter(s=>!NOT_REPRESENTED.has(s)).map(slug=>({slug,name:nameMap[slug]||pretty(slug)}));
  return list.sort((a,b)=>a.name.localeCompare(b.name));
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    const need=process.env.ANALYTICS_TOKEN;
    if(need){ const got=event.headers["x-analytics-token"]||event.headers["X-Analytics-Token"]; if(got!==need) return json(401,{error:"unauthorized"}); }

    if(event.httpMethod==="GET"){
      const mfrs=await manufacturers();
      let rows;
      try{ rows=await sbGetAll("territory_lines?select=state,manufacturer","state"); }
      catch(e){ return json(200,{ok:false,error:"tables_missing",manufacturers:mfrs,states:STATES,assignments:{},message:"Run territory.sql in Supabase, then reload."}); }
      const assignments={}; for(const r of rows){ if(NOT_REPRESENTED.has(r.manufacturer))continue; (assignments[r.state]=assignments[r.state]||[]).push(r.manufacturer); }
      return json(200,{ok:true,build:BUILD,manufacturers:mfrs,states:STATES,assignments});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

      if(b.action==="set_line"){
        const st=String(b.state||"").trim().toUpperCase(), mf=String(b.manufacturer||"").trim();
        if(!st||!mf) return json(400,{error:"state + manufacturer required"});
        if(NOT_REPRESENTED.has(mf)) return json(200,{ok:false,message:"That line is retired (no longer represented)."});
        if(b.on) await sbSend("POST","territory_lines?on_conflict=state,manufacturer",{state:st,manufacturer:mf},{Prefer:"resolution=merge-duplicates,return=minimal"});
        else     await sbSend("DELETE",`territory_lines?state=eq.${encodeURIComponent(st)}&manufacturer=eq.${encodeURIComponent(mf)}`,null,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(b.action==="set_state"){
        const st=String(b.state||"").trim().toUpperCase(); if(!st) return json(400,{error:"state required"});
        const slugs=Array.isArray(b.manufacturers)?b.manufacturers.filter(Boolean):[];
        await sbSend("DELETE",`territory_lines?state=eq.${encodeURIComponent(st)}`,null,{Prefer:"return=minimal"});
        if(slugs.length) await sbSend("POST","territory_lines",slugs.map(s=>({state:st,manufacturer:String(s)})),{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

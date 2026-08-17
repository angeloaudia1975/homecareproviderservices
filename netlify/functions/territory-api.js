// HCPS admin — Territory assignments (manufacturer lines by state). Service-role.
//
//   GET  /.netlify/functions/territory-api            -> { manufacturers, states, assignments }
//   POST /.netlify/functions/territory-api {action}   -> set_line | set_state
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const BUILD = "territory-api v2 (2026-08-04)";

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

// Auth: accept a President/admin staff Bearer (the shared session used across the portal) OR the
// legacy x-analytics-token passcode. Territory config is admin-only — reps don't manage it.
const ADMIN_ROLES=new Set(["president","admin","owner"]);
async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,active`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",email}; } } }catch(e){}
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||event.headers["X-Analytics-Token"]||"";
  if(need){ if(got===need) return {role:"president",email:""}; }
  else { return {role:"president",email:""}; }   // no passcode configured → preserve legacy open behavior
  return null;
}

// Lines we NO LONGER represent — excluded from the Territory picker AND from business-
// development targeting. Add a slug here to retire a line company-wide (rep-facing tools).
const NOT_REPRESENTED=new Set(["complete-medical-supplies"]);
const STATES=["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

function pretty(slug){ return String(slug||"").split("-").map(w=>w?w[0].toUpperCase()+w.slice(1):w).join(" "); }
// Collapse the same real manufacturer that appears under more than one slug/name
// (e.g. Golden Technologies twice; AIRAVANT / BongoRx / "Bongo"). Mirrors Dealer Manager.
function canonKey(name){
  let s=String(name||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  if(/airavant|bongo/.test(s)) return "airavant-bongorx";
  if(/golden/.test(s)) return "golden-technologies";
  return s;
}
const SPECIAL=new Set(["airavant-bongorx","golden-technologies"]);

// The full set of lines we REPRESENT (broader than what's orderable here), de-duplicated
// into ONE entry per real manufacturer. Returns the picker list plus a slug->canonical map.
async function buildCatalog(){
  const nameMap={}; const orderable=new Set();
  try{ const j=await fetchJson(`${ORDERING_BASE}/data/manufacturers.json`); (j||[]).forEach(x=>{ if(x&&x.slug&&x.hidden!==true){ orderable.add(x.slug); if(!nameMap[x.slug])nameMap[x.slug]=x.name||pretty(x.slug); } }); }catch(e){}
  try{ const m=await sbGet("manufacturers?select=slug,name"); (m||[]).forEach(x=>{ if(x&&x.slug&&!nameMap[x.slug]) nameMap[x.slug]=x.name||pretty(x.slug); }); }catch(e){}
  try{ const dm=await sbGetAll("dealer_manufacturers?select=manufacturer","manufacturer"); (dm||[]).forEach(x=>{ const s=x&&x.manufacturer; if(s&&!(s in nameMap)) nameMap[s]=pretty(s); }); }catch(e){}

  const groups=new Map();
  for(const slug of Object.keys(nameMap)){ const k=canonKey(nameMap[slug]||slug); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(slug); }

  const canonOf={}, membersOf={}, list=[];
  for(const [k,slugs] of groups){
    const canon = SPECIAL.has(k) ? k : (slugs.find(s=>orderable.has(s)) || slugs.slice().sort()[0]);
    const members=[...new Set(slugs.concat(nameMap[canon]!==undefined && !slugs.includes(canon)?[canon]:[]))];
    members.forEach(s=>{ canonOf[s]=canon; });
    if(NOT_REPRESENTED.has(canon) || members.some(s=>NOT_REPRESENTED.has(s))) continue;   // retired -> not in picker
    const name = nameMap[canon] || members.map(s=>nameMap[s]).filter(Boolean).sort()[0] || pretty(canon);
    membersOf[canon]=members;
    list.push({slug:canon,name});
  }
  list.sort((a,b)=>a.name.localeCompare(b.name));
  return {list,canonOf,membersOf};
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    if(!ADMIN_ROLES.has(String(me.role||"").toLowerCase())) return json(403,{error:"Admin only"});

    const cat=await buildCatalog();

    if(event.httpMethod==="GET"){
      let rows;
      try{ rows=await sbGetAll("territory_lines?select=state,manufacturer","state"); }
      catch(e){ return json(200,{ok:false,error:"tables_missing",manufacturers:cat.list,states:STATES,assignments:{},message:"Run territory.sql in Supabase, then reload."}); }
      const assignments={};
      for(const r of rows){ const canon=cat.canonOf[r.manufacturer]||r.manufacturer; if(NOT_REPRESENTED.has(canon))continue;
        const arr=assignments[r.state]=assignments[r.state]||[]; if(!arr.includes(canon))arr.push(canon); }
      return json(200,{ok:true,build:BUILD,manufacturers:cat.list,states:STATES,assignments});
    }

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

      if(b.action==="set_line"){
        const st=String(b.state||"").trim().toUpperCase(); let mf=String(b.manufacturer||"").trim();
        if(!st||!mf) return json(400,{error:"state + manufacturer required"});
        mf=cat.canonOf[mf]||mf;
        if(NOT_REPRESENTED.has(mf)) return json(200,{ok:false,message:"That line is retired (no longer represented)."});
        const members=cat.membersOf[mf]||[mf];
        if(b.on){ await sbSend("POST","territory_lines?on_conflict=state,manufacturer",{state:st,manufacturer:mf},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
        else { await sbSend("DELETE",`territory_lines?state=eq.${encodeURIComponent(st)}&manufacturer=in.(${members.map(encodeURIComponent).join(",")})`,null,{Prefer:"return=minimal"}); }
        return json(200,{ok:true});
      }
      if(b.action==="set_state"){
        const st=String(b.state||"").trim().toUpperCase(); if(!st) return json(400,{error:"state required"});
        const slugs=[...new Set((Array.isArray(b.manufacturers)?b.manufacturers:[]).map(s=>cat.canonOf[s]||s).filter(s=>s&&!NOT_REPRESENTED.has(s)))];
        await sbSend("DELETE",`territory_lines?state=eq.${encodeURIComponent(st)}`,null,{Prefer:"return=minimal"});
        if(slugs.length) await sbSend("POST","territory_lines",slugs.map(s=>({state:st,manufacturer:String(s)})),{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

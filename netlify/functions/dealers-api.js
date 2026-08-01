// HCPS admin — Dealer master API (read + merge/manage). Service-role, server-side.
// Powers the Merge/Manage Dealers page. No npm deps.
//
//   GET  /.netlify/functions/dealers-api            -> dealer master + stats + aliases
//   POST /.netlify/functions/dealers-api  {action}  -> merge | edit | access | confirm | rep | split
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)
//
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sbGet(path){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()});
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbGetAll(base){
  const PAGE=1000; let from=0,out=[];
  for(;;){const sep=base.includes("?")?"&":"?";
    const rows=await sbGet(`${base}${sep}order=id&limit=${PAGE}&offset=${from}`);
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

const MONTH=["January","February","March","April","May","June","July","August","September","October","November","December"];
const plabel=p=>{const[y,m]=p.split("-");return `${MONTH[+m-1]} ${y}`;};
const pm=p=>{const[y,m]=p.split("-").map(Number);return y*12+(m-1);};

async function buildState(){
  const [dealers,aliases,dm,mfrs,dir,reps,nomerge,logins] = await Promise.all([
    sbGetAll("dealers?select=id,business_name,hcps_account,contact_name,email,phone,address,city,state,zip,status,notes,active"),
    sbGet("dealer_aliases?select=alias_norm,raw_name,dealer_id"),
    sbGet("dealer_manufacturers?select=dealer_id,manufacturer,active"),
    sbGet("manufacturers?select=slug,name,active"),
    sbGet("dealer_directory?select=dealer_name,rep_name,hcps_account").catch(()=>[]),
    sbGet("reps?select=name").catch(()=>[]),
    sbGet("dealer_nomerge?select=a,b").catch(()=>[]),
    sbGet("dealer_users?select=uid,email,dealer_id,status,created_at&order=created_at.desc").catch(()=>[]),
  ]);
  const rows = await sbGetAll("monthly_sales?select=dealer_id,manufacturer,period,amount,commission,customer_name,customer_ref");
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
    if(r.customer_ref&&String(r.customer_ref).trim())a.accts.add(`${r.manufacturer}:${String(r.customer_ref).trim()}`);
    agg.set(r.dealer_id,a);
  }
  const periodsAll=[...new Set(rows.map(r=>(r.period||"").slice(0,10)).filter(Boolean))].sort();
  const latest=periodsAll[periodsAll.length-1];
  const out=dealers.map(d=>{
    const a=agg.get(d.id)||{sales:0,comm:0,recs:0,lines:new Set(),periods:new Set(),accts:new Set()};
    const per=[...a.periods].sort();
    const since = (latest&&per.length)? pm(latest)-pm(per[per.length-1]) : null;
    return {
      id:d.id, name:d.business_name, hcps_account:d.hcps_account||"", status:d.status||"",
      contact_name:d.contact_name||"", email:d.email||"", phone:d.phone||"",
      address:d.address||"", city:d.city||"", state:d.state||"", zip:d.zip||"", notes:d.notes||"",
      rep: repByName[d.business_name]||"",
      aliases:(aliByDealer.get(d.id)||[]).filter((v,i,s)=>s.indexOf(v)===i).sort(),
      access:(accByDealer.get(d.id)||[]).slice().sort(),
      buysLines:[...a.lines].sort(),
      accounts:[...a.accts].sort(),
      sales:Math.round(a.sales*100)/100, comm:Math.round(a.comm*100)/100, recs:a.recs,
      periods:per, monthsSince:since, lastPeriod:per[per.length-1]||null,
    };
  }).sort((x,y)=>y.sales-x.sales);
  return {
    generatedAt:new Date().toISOString(),
    latestPeriod:latest||null,
    manufacturers:mfrs.map(m=>({slug:m.slug,name:m.name})).sort((a,b)=>a.name.localeCompare(b.name)),
    repOptions:[...new Set(reps.map(r=>r.name).filter(Boolean))].sort(),
    mfrName, unlinked, dealers:out,
    nomerge:(nomerge||[]).map(x=>[x.a,x.b].sort().join("|")),
    logins:(logins||[]).map(u=>{const d=dealers.find(x=>x.id===u.dealer_id);
      return {uid:u.uid,email:u.email,status:u.status,created_at:u.created_at,
        dealer_id:u.dealer_id||"",dealer_name:d?d.business_name:""};}),
  };
}

exports.handler = async (event)=>{
  try{
    const need=process.env.ANALYTICS_TOKEN;
    if(need){const got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||""; if(got!==need) return json(401,{error:"unauthorized"});}
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});

    if(event.httpMethod==="GET") return json(200, await buildState());

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
      const act=b.action;
      if(act==="merge"){
        if(!b.survivor_id||!Array.isArray(b.loser_ids)||!b.loser_ids.length) return json(400,{error:"survivor_id + loser_ids required"});
        await rpc("merge_dealers",{p_survivor:b.survivor_id,p_losers:b.loser_ids});
        return json(200,{ok:true});
      }
      if(act==="edit"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        const f={}; for(const k of ["contact_name","email","phone","address","city","state","zip","hcps_account","notes","business_name"]) if(k in b) f[k]=(b[k]===""?null:b[k]);
        f.updated_at=new Date().toISOString();
        await sbSend("PATCH",`dealers?id=eq.${b.dealer_id}`,f,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="confirm"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        await sbSend("PATCH",`dealers?id=eq.${b.dealer_id}`,{status:null,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="access"){
        if(!b.dealer_id||!Array.isArray(b.manufacturers)) return json(400,{error:"dealer_id + manufacturers[] required"});
        await sbSend("DELETE",`dealer_manufacturers?dealer_id=eq.${b.dealer_id}`,null,{Prefer:"return=minimal"});
        if(b.manufacturers.length) await sbSend("POST","dealer_manufacturers",b.manufacturers.map(m=>({dealer_id:b.dealer_id,manufacturer:m,active:true})),{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="rep"){
        if(!b.dealer_name) return json(400,{error:"dealer_name required"});
        await sbSend("POST","dealer_directory",{dealer_name:b.dealer_name,rep_name:(b.rep_name||"").trim()||null,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
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
        if(!Array.isArray(b.rows)||!b.rows.length) return json(400,{error:"rows[] required"});
        // resolve+enrich each company via dealer_norm/aliases; create unmatched when requested
        const res=await sbSend("POST","rpc/import_dealer_contacts",{p_rows:b.rows,p_create:b.create!==false});
        return json(200,{ok:true,result:res});
      }
      if(act==="approve_login"){
        if(!b.uid) return json(400,{error:"uid required"});
        await rpc("approve_dealer_login",{p_uid:b.uid,p_dealer:b.dealer_id||null,p_by:b.by||"admin"});
        return json(200,{ok:true});
      }
      if(act==="revoke_login"){
        if(!b.uid) return json(400,{error:"uid required"});
        await rpc("set_dealer_login_status",{p_uid:b.uid,p_status:b.status||"revoked"});
        return json(200,{ok:true});
      }
      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};

// HCPS admin — commission report importer. President-only, service-role, no npm deps.
// The file is parsed in the browser (Excel/CSV/PDF); this endpoint stores per-manufacturer
// column templates and loads the mapped rows into monthly_sales, resolving each customer
// name to a dealer through the same alias table the Dealer Manager uses.
//
//   POST {action:"config"}                                  -> {manufacturers, templates}
//   POST {action:"save_template", manufacturer, mapping}    -> {ok}
//   POST {action:"import", manufacturer, period, source_file, rows:[...]} -> {inserted, matched, unmatched}
//   All require a President Bearer token.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbGetAll(base, orderCol){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function fetchJson(url){ const r=await fetch(url); if(!r.ok) throw new Error("fetch "+r.status); return r.json(); }

// dealer name normalizer — MUST match the alias seeding used elsewhere.
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const num=v=>{ if(v==null||v==="") return null; const n=Number(String(v).replace(/[$,\s]/g,"")); return isFinite(n)?n:null; };

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",email,name:su.name||email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",email:"",name:"Admin"};
  return null;
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    if(me.role!=="president") return json(403,{error:"President only"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    if(b.action==="config"){
      const nameMap={};
      try{ const j=await fetchJson(`${ORDERING_BASE}/data/manufacturers.json`); (j||[]).forEach(x=>{ if(x&&x.slug) nameMap[x.slug]=x.name||x.slug; }); }catch(e){}
      try{ const m=await sbGet("manufacturers?select=slug,name"); (m||[]).forEach(x=>{ if(x&&x.slug&&!nameMap[x.slug]) nameMap[x.slug]=x.name||x.slug; }); }catch(e){}
      const manufacturers=Object.entries(nameMap).map(([slug,name])=>({slug,name})).sort((a,b)=>a.name.localeCompare(b.name));
      let templates={};
      try{ const rows=await sbGet("app_settings?key=like.ctpl:*&select=key,value"); (rows||[]).forEach(r=>{ templates[String(r.key).slice(5)]=r.value||{}; }); }catch(e){}
      return json(200,{ok:true,manufacturers,templates});
    }

    if(b.action==="save_template"){
      const slug=String(b.manufacturer||"").trim(); if(!slug) return json(400,{error:"manufacturer required"});
      await sbSend("POST","app_settings?on_conflict=key",{key:"ctpl:"+slug,value:b.mapping||{},updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true});
    }

    if(b.action==="import"){
      const slug=String(b.manufacturer||"").trim();
      const period=String(b.period||"").trim();          // expect YYYY-MM
      const source_file=String(b.source_file||"").trim()||null;
      const rows=Array.isArray(b.rows)?b.rows:[];
      if(!slug||!/^\d{4}-\d{2}$/.test(period)) return json(400,{error:"manufacturer + period (YYYY-MM) required"});
      if(!rows.length) return json(400,{error:"no rows"});
      const per=`${period}-01`;
      // alias map for dealer resolution
      const aliases=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
      const idByAlias={}; for(const a of (aliases||[])) idByAlias[a.alias_norm]=a.dealer_id;
      const out=[]; const unmatched=new Set(); let matched=0;
      for(const r of rows){
        const cname=String(r.customer_name||"").trim();
        const did = cname ? idByAlias[dnorm(cname)] : null;
        if(did) matched++; else if(cname) unmatched.add(cname);
        out.push({
          manufacturer:slug, period:per, dealer_id:did||null,
          customer_name:cname||null, customer_ref:(r.customer_ref!=null&&String(r.customer_ref).trim())?String(r.customer_ref).trim():null,
          product_code:(r.product_code!=null&&String(r.product_code).trim())?String(r.product_code).trim():null,
          product_name:(r.product_name!=null&&String(r.product_name).trim())?String(r.product_name).trim():null,
          qty:num(r.qty), amount:num(r.amount), commission:num(r.commission), cost:num(r.cost),
          rep_name:(r.rep_name!=null&&String(r.rep_name).trim())?String(r.rep_name).trim():null,
          source_file, imported_at:new Date().toISOString(),
        });
      }
      // Replace any prior load of this exact file+line+month so re-importing never double-counts.
      try{
        let del=`monthly_sales?manufacturer=eq.${encodeURIComponent(slug)}&period=eq.${encodeURIComponent(per)}`;
        if(source_file) del+=`&source_file=eq.${encodeURIComponent(source_file)}`;
        await sbSend("DELETE",del,null,{Prefer:"return=minimal"});
      }catch(e){}
      let inserted=0;
      for(let i=0;i<out.length;i+=500){ const part=out.slice(i,i+500); await sbSend("POST","monthly_sales",part,{Prefer:"return=minimal"}); inserted+=part.length; }
      return json(200,{ok:true,inserted,matched,unmatched:[...unmatched].slice(0,200),unmatched_count:unmatched.size});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

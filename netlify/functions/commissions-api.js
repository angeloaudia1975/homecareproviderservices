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
      // Lightweight dealer list (for the "resolve unmatched" picker) + reports already on file.
      let dealers=[];
      try{ dealers=(await sbGetAll("dealers?select=id,business_name,city,state","business_name")).map(d=>({id:d.id,name:d.business_name,city:d.city||"",state:d.state||""})); }catch(e){}
      let received={};
      try{ const rows=await sbGetAll("monthly_sales?select=manufacturer,period","id");
        const acc={}; for(const r of (rows||[])){ const p=(r.period||"").slice(0,7); if(!r.manufacturer||!p) continue; (acc[r.manufacturer]||(acc[r.manufacturer]=new Set())).add(p); }
        for(const k in acc) received[k]=[...acc[k]].sort(); }catch(e){}
      return json(200,{ok:true,manufacturers,templates,dealers,received});
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
      // alias map for dealer resolution (by normalized name)
      const aliases=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
      const idByAlias={}; for(const a of (aliases||[])) idByAlias[a.alias_norm]=a.dealer_id;
      // account-number map for THIS manufacturer (match by the report's Customer # — most reliable)
      const idByAccount={};
      try{ const dmr=await sbGetAll(`dealer_manufacturers?manufacturer=eq.${encodeURIComponent(slug)}&select=dealer_id,account_ref`,"dealer_id,manufacturer");
        for(const x of (dmr||[])){ if(x.account_ref) idByAccount[String(x.account_ref).trim()]=x.dealer_id; } }catch(e){}
      const out=[]; const unmatched=new Map(); let matched=0;   // name -> {name, account, count}
      for(const r of rows){
        const cname=String(r.customer_name||"").trim();
        const cref=String(r.customer_ref||"").trim();
        const did = (cref && idByAccount[cref]) || (cname ? idByAlias[dnorm(cname)] : null) || null;
        if(did) matched++;
        else if(cname){ const u=unmatched.get(cname)||{name:cname,account:cref||"",count:0}; u.count++; if(!u.account&&cref)u.account=cref; unmatched.set(cname,u); }
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
      return json(200,{ok:true,inserted,matched,unmatched:[...unmatched.values()].slice(0,200),unmatched_count:unmatched.size});
    }

    // Resolve unmatched names to dealers: learn the alias, relink the imported rows, and
    // (optionally) store the manufacturer account number so future reports match by number.
    if(b.action==="resolve"){
      const slug=String(b.manufacturer||"").trim();
      const maps=Array.isArray(b.mappings)?b.mappings:[];
      if(!slug) return json(400,{error:"manufacturer required"});
      let resolved=0, relinked=0;
      for(const m of maps){
        const name=String(m.name||"").trim(); const did=m.dealer_id;
        if(!name||!did) continue;
        // 1) learn the alias so this name auto-matches next time
        await sbSend("POST","dealer_aliases?on_conflict=alias_norm",{alias_norm:dnorm(name),raw_name:name,dealer_id:did},{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{});
        // 2) relink every still-unmatched sales row for this line + name
        const patched=await sbSend("PATCH",`monthly_sales?manufacturer=eq.${encodeURIComponent(slug)}&customer_name=eq.${encodeURIComponent(name)}&dealer_id=is.null`,{dealer_id:did},{Prefer:"return=representation"}).catch(()=>null);
        if(Array.isArray(patched)) relinked+=patched.length;
        // 3) store the account number on that dealer's line (so future reports match by number)
        const acct=String(m.account_ref||"").trim();
        if(acct){ await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",{dealer_id:did,manufacturer:slug,account_ref:acct,active:true},{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{}); }
        resolved++;
      }
      return json(200,{ok:true,resolved,relinked});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

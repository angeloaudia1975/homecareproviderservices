// HCPS manufacturer SALES-report import. Loads order/line reports (e.g. Strongback's
// YTD orders export) into monthly_sales as the sales + product record, attributing each
// order to the SPECIFIC dealer branch and computing commission at the manufacturer rate.
// Staff-authenticated (president or rep). Supabase service-role. No npm deps.
//
//   POST {action:"preview", manufacturer, commission_rate?, rows:[...]}  -> summary, no writes
//   POST {action:"import",  manufacturer, commission_rate?, source_file?, rows:[...]} -> {inserted, matched, unmatched}
//
// Each row (normalized client-side): { order_number, date, product_name, product_code,
//   qty, unit_price, line_amount?, company, account_ref, email, ship_name, ship_city,
//   ship_state, ship_zip }. amount = line_amount if given, else unit_price*qty.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||400):null; };
const num=v=>{ if(v==null||v==="") return null; const n=Number(String(v).replace(/[$,\s]/g,"")); return Number.isFinite(n)?n:null; };
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const znorm=z=>{ const m=String(z||"").match(/\d{5}/); return m?m[0]:""; };
// monthly_sales.period is a DATE column — store the first of the month (YYYY-MM-01), matching the commission importer.
const period=d=>{ const s=String(d||""); const m=s.match(/(\d{4})-(\d{2})/); if(m) return m[1]+"-"+m[2]+"-01"; const dt=new Date(s); return isNaN(dt)?null:(dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-01"); };
const dateOnly=d=>{ const s=String(d||""); const m=s.match(/\d{4}-\d{2}-\d{2}/); if(m) return m[0]; const dt=new Date(s); return isNaN(dt)?null:dt.toISOString().slice(0,10); };

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",name:su.name||email,email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",name:"Admin",email:""};
  return null;
}

// Build the dealer resolver: account_ref (per manufacturer) + name/alias, with
// branch selection by shipping zip/city inside the dealer family.
async function buildResolver(slug){
  const [dealers,dms,aliases,dir]=await Promise.all([
    sbGetAll("dealers?select=id,business_name,parent_id,city,zip","id").catch(()=>[]),
    sbGetAll(`dealer_manufacturers?manufacturer=eq.${encodeURIComponent(slug)}&select=dealer_id,account_ref`,"dealer_id").catch(()=>[]),
    sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
    sbGetAll("dealer_directory?select=dealer_name,rep_name","dealer_name").catch(()=>[]),
  ]);
  const byId=new Map(); for(const d of dealers) byId.set(d.id,d);
  const rootOf=id=>{ const d=byId.get(id); return (d&&d.parent_id)?d.parent_id:id; };
  // rep assignment lives in dealer_directory (dealer_name -> rep_name); match by normalized name,
  // and fall back to the family HQ's assignment for branches without their own directory row.
  const repByName=new Map(); for(const x of (dir||[])){ if(x&&x.dealer_name){ const rn=String(x.rep_name||"").trim(); if(rn) repByName.set(dnorm(x.dealer_name), rn); } }
  function repOf(id){ if(!id) return null; const d=byId.get(id); if(!d) return null;
    let r=repByName.get(dnorm(d.business_name));
    if(!r){ const rt=byId.get(rootOf(id)); if(rt) r=repByName.get(dnorm(rt.business_name)); }
    return r||null; }
  const familyByRoot=new Map();
  for(const d of dealers){ const r=rootOf(d.id); (familyByRoot.get(r)||familyByRoot.set(r,[]).get(r)).push(d); }
  const refToIds=new Map(); for(const x of dms){ const k=String(x.account_ref||"").trim().toLowerCase(); if(!k) continue; (refToIds.get(k)||refToIds.set(k,[]).get(k)).push(x.dealer_id); }
  const norm2id=new Map(); for(const d of dealers) norm2id.set(dnorm(d.business_name), d.id);
  for(const a of aliases){ if(a&&a.alias_norm&&!norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm, a.dealer_id); }
  function family(id){ const r=rootOf(id); return familyByRoot.get(r)||[byId.get(id)].filter(Boolean); }
  function pickBranch(cands, row){
    if(cands.length<=1) return cands[0]||null;
    const zip=znorm(row.ship_zip), city=dnorm(row.ship_city), shipName=dnorm(row.ship_name);
    let hit=zip&&cands.find(d=>znorm(d.zip)===zip); if(hit) return hit;
    hit=city&&cands.find(d=>dnorm(d.city)===city); if(hit) return hit;
    hit=shipName&&cands.find(d=>dnorm(d.business_name)===shipName); if(hit) return hit;
    return cands.find(d=>!d.parent_id)||cands[0];   // fall back to the HQ/root
  }
  function resolve(row){
    let cands=null;
    const ref=String(row.account_ref||"").trim().toLowerCase();
    if(ref&&refToIds.has(ref)){ const ids=refToIds.get(ref); cands=ids.map(i=>byId.get(i)).filter(Boolean);
      if(cands.length===1) cands=family(cands[0].id); }               // expand a single hit to its family for branch pick
    if((!cands||!cands.length)&&row.company){ const id=norm2id.get(dnorm(row.company)); if(id) cands=family(id); }
    if(!cands||!cands.length) return null;
    const d=pickBranch(cands,row); return d?d.id:null;
  }
  return { resolve, byId, repOf };
}

function mapRow(slug, rate, source_file, row, idx){
  const qty=num(row.qty)||0, up=num(row.unit_price);
  const amount=Math.round(((row.line_amount!=null&&row.line_amount!=="")?(num(row.line_amount)||0):((up||0)*qty))*100)/100;
  const commission=Math.round(amount*rate*100)/100;
  const order=clean(row.order_number,60);
  const code=clean(row.product_code,80), name=clean(row.product_name,200)||code;
  const ext=`${slug}|${order||"na"}|${(code||name||"").slice(0,40)}|${idx}`;
  return {
    manufacturer:slug, period:period(row.date), order_date:dateOnly(row.date),
    invoice_no:order, product_code:code, product_name:name, qty,
    amount, commission, commission_rate:rate,
    customer_name:clean(row.company,180), customer_ref:clean(row.account_ref,80),
    ship_city:clean(row.ship_city,80), ship_state:clean(row.ship_state,40), ship_zip:clean(row.ship_zip,20),
    line_type:amount>0?"sale":"collateral", source:"sales_report", external_ref:ext,
    source_file:source_file||null, imported_at:new Date().toISOString()
  };
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    let b; try{ b=JSON.parse(event.body||"{}"); }catch{ return json(400,{error:"bad JSON"}); }

    // Dealer list for the "assign unmatched company" dropdown.
    if(b.action==="dealers"){
      const ds=await sbGetAll("dealers?select=id,business_name,parent_id","id").catch(()=>[]);
      const list=ds.map(d=>({id:d.id,name:d.business_name||"",branch:!!d.parent_id})).filter(d=>d.name).sort((a,b)=>a.name.localeCompare(b.name));
      return json(200,{ok:true,dealers:list});
    }
    // Remember an unmatched report name → dealer, so this and future imports match it.
    if(b.action==="add_alias"){
      const company=clean(b.company,180), dealer_id=clean(b.dealer_id,80);
      if(!company||!dealer_id) return json(400,{error:"company and dealer_id required"});
      const alias_norm=dnorm(company); if(!alias_norm) return json(400,{error:"empty name"});
      await sbSend("POST","dealer_aliases?on_conflict=alias_norm",{alias_norm,raw_name:company,dealer_id},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true,alias_norm,dealer_id});
    }

    if(b.action!=="preview"&&b.action!=="import") return json(400,{error:"unknown action"});

    const slug=clean(b.manufacturer,60); if(!slug) return json(400,{error:"manufacturer required"});
    const rate=(b.commission_rate!=null&&b.commission_rate!=="")?(Number(b.commission_rate)>1?Number(b.commission_rate)/100:Number(b.commission_rate)):0;
    const rows=Array.isArray(b.rows)?b.rows:[];
    if(!rows.length) return json(200,{ok:true, rows:0, matched:0, unmatched:[]});

    // Column present? (friendly message if the migration hasn't run yet.)
    try{ await sbGet("monthly_sales?select=external_ref&limit=1"); }
    catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/sales_import.sql in Supabase, then reload."}); }

    const { resolve, byId, repOf } = await buildResolver(slug);
    const mapped=rows.map((r,i)=>{ const dealer_id=resolve(r); const rec=mapRow(slug,rate,clean(b.source_file,200),r,i); rec.rep_name=repOf(dealer_id); return { rec, dealer_id, raw:r }; });
    // aggregate
    let total=0, comm=0, matchedLines=0; const byDealer=new Map(); const unmatchedNames=new Set();
    for(const m of mapped){ total+=m.rec.amount; comm+=m.rec.commission;
      if(m.dealer_id){ matchedLines++; const d=byId.get(m.dealer_id); const o=byDealer.get(m.dealer_id)||{name:(d&&d.business_name)||"",sales:0,commission:0,lines:0,orders:new Set()};
        o.sales+=m.rec.amount; o.commission+=m.rec.commission; o.lines++; if(m.rec.invoice_no)o.orders.add(m.rec.invoice_no); byDealer.set(m.dealer_id,o); }
      else if(m.raw.company){ unmatchedNames.add(String(m.raw.company).trim()); }
    }
    const perDealer=[...byDealer.entries()].map(([id,o])=>({dealer_id:id,name:o.name,sales:Math.round(o.sales*100)/100,commission:Math.round(o.commission*100)/100,lines:o.lines,orders:o.orders.size})).sort((a,b)=>b.sales-a.sales);
    const summary={ rows:mapped.length, matched_lines:matchedLines, unmatched_lines:mapped.length-matchedLines,
      dealers:perDealer.length, unmatched:[...unmatchedNames].slice(0,100),
      total_sales:Math.round(total*100)/100, total_commission:Math.round(comm*100)/100,
      commission_rate:rate, per_dealer:perDealer.slice(0,500) };

    if(b.action==="preview") return json(200,{ok:true, preview:summary});

    // IMPORT — upsert into monthly_sales keyed on (manufacturer, external_ref).
    const recs=mapped.map(m=>({ ...m.rec, dealer_id:m.dealer_id||null }));
    let written=0;
    for(let i=0;i<recs.length;i+=500){ await sbSend("POST","monthly_sales?on_conflict=manufacturer,external_ref",recs.slice(i,i+500),{Prefer:"resolution=merge-duplicates,return=minimal"}); written+=recs.slice(i,i+500).length; }
    return json(200,{ok:true, imported:written, summary});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

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
// Manufacturers with no numeric account #: the report's company name IS the account number, and it is
// shared across a dealer's whole family (HQ + branches). The importer stores it on the family on commit.
const NAME_AS_ACCOUNT = new Set(["access4u"]);
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
// ZIP normalizer — Golden stores some ZIPs as numbers, so Northeast codes lose their leading
// zero (1532 -> 01532). Reduce to the 5-digit base and re-pad.
const znorm=z=>{ if(z==null||z==="") return ""; const s=String(z).split("-")[0].replace(/[^0-9]/g,""); if(!s) return ""; return s.length>5?s.slice(0,5):s.padStart(5,"0"); };
// Golden appends " <C>" to the customer name on credit memos — same dealer, strip it before matching.
const stripC=n=>String(n||"").replace(/\s*<\s*C\s*>\s*$/i,"").trim();
// Normalize an order date to YYYY-MM-DD (handles "2025-01-23 00:00:00", "1/23/2025", Date objects).
const toDate=v=>{ if(v==null||v==="") return null; const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/); if(m) return `${m[3]}-${String(m[1]).padStart(2,"0")}-${String(m[2]).padStart(2,"0")}`;
  const d=new Date(s); return isNaN(d.getTime())?null:d.toISOString().slice(0,10); };
const ncity=s=>String(s||"").toUpperCase().replace(/[^A-Z ]/g," ").replace(/\s+/g," ").trim();
const nstate=s=>String(s||"").toUpperCase().replace(/[^A-Z]/g,"").slice(0,2);

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

// Build the matching context once: name aliases, this line's account#→dealer map, the order-number
// lines, and every dealer "family" (an HQ + its branches) indexed by root.
async function buildCtx(slug){
  const aliases=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
  const idByAlias={}; for(const a of (aliases||[])) idByAlias[a.alias_norm]=a.dealer_id;
  const idByAccount={};
  try{ const dmr=await sbGetAll(`dealer_manufacturers?manufacturer=eq.${encodeURIComponent(slug)}&select=dealer_id,account_ref`,"dealer_id,manufacturer");
    for(const x of (dmr||[])){ if(x.account_ref) idByAccount[String(x.account_ref).trim()]=x.dealer_id; } }catch(e){}
  let orderLines=new Set();
  try{ const cc=await sbGet("app_settings?key=eq.commission_config&select=value"); orderLines=new Set(((cc&&cc[0]&&cc[0].value&&cc[0].value.order_number_lines))||[]); }catch(e){}
  const fam=await sbGetAll("dealers?select=id,business_name,city,state,zip,parent_id","business_name").catch(()=>[]);
  const rootOf=new Map(), byRoot=new Map(), nameById=new Map();
  for(const d of (fam||[])){ const root=d.parent_id||d.id; rootOf.set(d.id,root); (byRoot.get(root)||byRoot.set(root,[]).get(root)).push(d); nameById.set(d.id,d.business_name); }
  // Saved ZIP→branch assignments (from the review screen) — resolve ambiguous/assigned ZIPs deterministically.
  let zipmap={};
  try{ const zm=await sbGet(`app_settings?key=eq.zipmap:${encodeURIComponent(slug)}&select=value`); if(zm&&zm[0]&&zm[0].value&&typeof zm[0].value==="object") zipmap=zm[0].value; }catch(e){}
  // Access4u: channel (physical/drop-ship) is decided on the invoice; a later payment inherits it via
  // the R-##### reference. Preload already-imported invoice channels so cross-month payments classify.
  const invChannel={};
  try{ const iv=await sbGetAll(`monthly_sales?manufacturer=eq.${encodeURIComponent(slug)}&line_type=eq.invoice&select=invoice_no,channel`,"invoice_no").catch(()=>[]);
    for(const x of (iv||[])){ if(x.invoice_no) invChannel[String(x.invoice_no).toUpperCase()]=x.channel; } }catch(e){}
  return {idByAlias,idByAccount,orderLines,rootOf,byRoot,nameById,zipmap,invChannel};
}

// Map raw report rows to monthly_sales rows AND compute a review report. Pure (no DB writes) so the
// same code powers the dry-run "analyze" and the real "import". Dealer match: account# first, then
// name alias. Branch attribution: ship-to ZIP → a branch/corporate ZIP on file = physical; no ZIP
// match = corporate drop-ship. (Falls back to city/state for lines that supply them, e.g. non-Golden.)
function mapRows(slug, per, source_file, rows, ctx){
  const {idByAlias,idByAccount,orderLines,rootOf,byRoot,nameById}=ctx;
  const zipmap=ctx.zipmap||{}, invChannel=ctx.invChannel||{};
  const refMatch=!orderLines.has(slug);
  const out=[]; const unmatched=new Map();
  let matched=0, physical=0, dropship=0, physAmt=0, dropAmt=0, credits=0, amtTot=0, commTot=0;
  const newAcct=new Map(), noZip=new Map(), ambiguous=[], ambSeen=new Set(), models=new Set();
  // Access4u ledger metrics + a same-file invoice→channel map (Med Mart PO = drop-ship) so payments
  // in this same file inherit their order's channel even before it's in the database.
  let invRows=0, payRows=0, billedTot=0; const localInv={};
  const poDropOf=m=>/\bPO\s*#?\s*\d+/i.test(String(m||""));
  for(const r of rows){ if(String(r.line_type||"").toLowerCase()==="invoice"){ const inv=String(r.invoice_no||"").toUpperCase(); if(inv) localInv[inv]=poDropOf(r.memo)?"dropship":"physical"; } }
  for(const r of rows){
    const acct=(r.customer_ref!=null)?String(r.customer_ref).trim():"";
    const name=stripC(r.customer_name);
    const shipZip=znorm(r.ship_zip!=null?r.ship_zip:(r.postal!=null?r.postal:""));
    const shipCity=(r.ship_city!=null)?String(r.ship_city).trim():"";
    const shipState=(r.ship_state!=null)?String(r.ship_state).trim():"";
    const amount=num(r.amount), commission=num(r.commission);
    amtTot+=amount||0; commTot+=commission||0;
    const type=(r.line_type!=null)?String(r.line_type).trim().toUpperCase():"";
    if(type==="C"||(amount!=null&&amount<0)) credits++;
    const model=(r.product_code!=null&&String(r.product_code).trim())?String(r.product_code).trim():"";
    if(model) models.add(model);
    // Access4u ledger fields (blank/absent for other lines)
    const lineType=type.toLowerCase();
    const billed=num(r.billed_amount);
    const memo=(r.memo!=null)?String(r.memo).trim():"";
    const invRef=(r.invoice_no!=null&&String(r.invoice_no).trim())?String(r.invoice_no).trim().toUpperCase():"";
    if(lineType==="invoice"){ invRows++; if(billed!=null) billedTot+=billed; }
    else if(lineType==="payment"){ payRows++; }
    const byAcct=refMatch&&acct&&idByAccount[acct];
    const byName=name?idByAlias[dnorm(name)]:null;
    let did=byAcct||byName||null; let channel=null;
    if(did){
      matched++;
      const root=rootOf.get(did)||did;
      const famArr=byRoot.get(root)||[];
      const famZips=famArr.map(d=>znorm(d.zip)).filter(Boolean);
      if(lineType==="invoice"||lineType==="payment"){
        // Access4u ledger: no ZIP. Channel comes from the order's memo (PO = drop-ship); a payment
        // inherits its invoice's channel via the R-##### reference (same file, then the database).
        did=root;
        const linked = lineType==="payment" ? (localInv[invRef]||invChannel[invRef]) : null;
        channel = (poDropOf(memo) || linked==="dropship") ? "dropship" : "physical";
      } else {
        // A saved ZIP→branch assignment (from the review screen) wins, when it points into this family.
        const assigned = (shipZip && zipmap[shipZip] && (rootOf.get(zipmap[shipZip])===root)) ? zipmap[shipZip] : null;
        if(assigned){ did=assigned; channel="physical"; }
        else if(shipZip && famZips.length){
          const hit=famArr.filter(d=>znorm(d.zip)===shipZip);
          if(hit.length===1){ did=hit[0].id; channel="physical"; }
          else if(hit.length>1){ did=hit[0].id; channel="physical";
            if(!ambSeen.has(shipZip)){ ambSeen.add(shipZip); ambiguous.push({zip:shipZip,dealers:hit.map(d=>({id:d.id,name:nameById.get(d.id)||d.id}))}); } }
          else { did=root; channel="dropship"; }
        } else if(shipCity){
          const c=ncity(shipCity), st=nstate(shipState);
          const mm = famArr.length<=1 ? famArr[0] : (famArr.find(x=>ncity(x.city)===c&&(!st||nstate(x.state)===st))||famArr.find(x=>ncity(x.city)===c));
          did=(mm&&mm.id)||root; channel="physical";
        } else if(famZips.length){
          did=root; channel="dropship";                 // ZIP branches exist but this line has no ZIP → can't place
        } else {
          did=root; channel="physical"; const n0=noZip.get(root)||{dealer_id:root,name:nameById.get(root)||name,count:0}; n0.count++; noZip.set(root,n0);
        }
      }
      if(channel==="physical"){ physical++; physAmt+=amount||0; } else { dropship++; dropAmt+=amount||0; }
      if(byName && !byAcct && acct && !idByAccount[acct] && !orderLines.has(slug)){
        const k=root+"|"+acct; if(!newAcct.has(k)) newAcct.set(k,{dealer_id:root,name:nameById.get(root)||name,account_ref:acct}); }
    } else if(name){
      const u=unmatched.get(name)||{name,account:acct||"",zip:shipZip||"",count:0}; u.count++; if(!u.account&&acct)u.account=acct; unmatched.set(name,u);
    }
    out.push({
      manufacturer:slug, period:per, dealer_id:did||null, channel:channel||null,
      customer_name:name||null, customer_ref:acct||null,
      ship_city:shipCity||null, ship_state:shipState||null, ship_zip:shipZip||null,
      order_date:toDate(r.order_date),
      product_code:model||null,
      product_name:(r.product_name!=null&&String(r.product_name).trim())?String(r.product_name).trim():null,
      item_no:(r.item_no!=null&&String(r.item_no).trim())?String(r.item_no).trim():null,
      qty:num(r.qty), amount, commission, commission_rate:num(r.commission_rate), cost:num(r.cost),
      line_type:type||null, billed_amount:billed, memo:memo||null,
      credit_reason:(r.credit_reason!=null&&String(r.credit_reason).trim())?String(r.credit_reason).trim():null,
      invoice_no:(r.invoice_no!=null&&String(r.invoice_no).trim())?String(r.invoice_no).trim():null,
      rep_name:(r.rep_name!=null&&String(r.rep_name).trim())?String(r.rep_name).trim():null,
      source_file, imported_at:new Date().toISOString(),
    });
  }
  const review={ total:rows.length, matched, unmatched_count:unmatched.size,
    unmatched:[...unmatched.values()].sort((a,b)=>b.count-a.count).slice(0,300),
    physical_rows:physical, dropship_rows:dropship,
    physical_amount:Math.round(physAmt*100)/100, dropship_amount:Math.round(dropAmt*100)/100,
    new_accounts:[...newAcct.values()].slice(0,300), no_zip_dealers:[...noZip.values()].slice(0,300),
    ambiguous_zips:ambiguous.slice(0,100), distinct_products:models.size, credits,
    invoice_rows:invRows, payment_rows:payRows, billed_total:Math.round(billedTot*100)/100,
    amount_total:Math.round(amtTot*100)/100, commission_total:Math.round(commTot*100)/100 };
  return {out, review};
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

    // Dry run: map + score the rows and return the review report WITHOUT writing anything.
    if(b.action==="analyze"){
      const slug=String(b.manufacturer||"").trim();
      const period=String(b.period||"").trim();
      const rows=Array.isArray(b.rows)?b.rows:[];
      if(!slug||!/^\d{4}-\d{2}$/.test(period)) return json(400,{error:"manufacturer + period (YYYY-MM) required"});
      if(!rows.length) return json(400,{error:"no rows"});
      const ctx=await buildCtx(slug);
      const {review}=mapRows(slug,`${period}-01`,String(b.source_file||"").trim()||null,rows,ctx);
      return json(200,{ok:true,review});
    }

    // Commit: map the rows and write them to monthly_sales (replacing any prior load of this file+month).
    if(b.action==="import"){
      const slug=String(b.manufacturer||"").trim();
      const period=String(b.period||"").trim();          // expect YYYY-MM
      const source_file=String(b.source_file||"").trim()||null;
      const rows=Array.isArray(b.rows)?b.rows:[];
      if(!slug||!/^\d{4}-\d{2}$/.test(period)) return json(400,{error:"manufacturer + period (YYYY-MM) required"});
      if(!rows.length) return json(400,{error:"no rows"});
      const per=`${period}-01`;
      const ctx=await buildCtx(slug);
      const {out,review}=mapRows(slug,per,source_file,rows,ctx);
      // Column-existence probes: enrichment cols (golden_import.sql) + ship cols (attribution.sql).
      let hasEnrich=true; try{ const p=await fetch(`${SUPABASE_URL}/rest/v1/monthly_sales?select=channel&limit=1`,{headers:H()}); hasEnrich=p.ok; }catch(e){ hasEnrich=false; }
      let hasShip=true;   try{ const p=await fetch(`${SUPABASE_URL}/rest/v1/monthly_sales?select=ship_city&limit=1`,{headers:H()}); hasShip=p.ok; }catch(e){ hasShip=false; }
      const ENRICH=["channel","item_no","line_type","credit_reason","invoice_no","ship_zip","commission_rate","order_date","billed_amount","memo"];
      const clean=out.map(o=>{ const row={...o};
        if(!hasEnrich) ENRICH.forEach(k=>delete row[k]);
        if(!hasShip){ delete row.ship_city; delete row.ship_state; delete row.ship_zip; }
        return row; });
      try{ let del=`monthly_sales?manufacturer=eq.${encodeURIComponent(slug)}&period=eq.${encodeURIComponent(per)}`;
        if(source_file) del+=`&source_file=eq.${encodeURIComponent(source_file)}`;
        await sbSend("DELETE",del,null,{Prefer:"return=minimal"}); }catch(e){}
      let inserted=0;
      for(let i=0;i<clean.length;i+=500){ const part=clean.slice(i,i+500); await sbSend("POST","monthly_sales",part,{Prefer:"return=minimal"}); inserted+=part.length; }
      // Name-as-account lines (Access4u): the report company name IS the account number. Store it as
      // the manufacturer account_ref on every matched dealer AND its whole family, so an HQ and all its
      // branches share one Access4u account number. Idempotent (updates existing rows).
      let accounts_set=0;
      if(NAME_AS_ACCOUNT.has(slug)){
        const acctByDealer=new Map();
        for(const o of out){ if(o.dealer_id && o.customer_name && !acctByDealer.has(o.dealer_id)) acctByDealer.set(o.dealer_id,o.customer_name); }
        const dmRows=[], seen=new Set();
        for(const [dealerId,acctName] of acctByDealer){
          const root=ctx.rootOf.get(dealerId)||dealerId;
          const fam=ctx.byRoot.get(root)||[{id:dealerId}];
          for(const fd of fam){ if(seen.has(fd.id)) continue; seen.add(fd.id); dmRows.push({dealer_id:fd.id,manufacturer:slug,account_ref:acctName,active:true}); }
        }
        if(dmRows.length){ try{ await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",dmRows,{Prefer:"resolution=merge-duplicates,return=minimal"}); accounts_set=dmRows.length; }catch(e){} }
      }
      return json(200,{ok:true,inserted,review,accounts_set,
        matched:review.matched, unmatched:review.unmatched.slice(0,200), unmatched_count:review.unmatched_count});
    }

    // Resolve unmatched names to dealers: learn the alias, relink the imported rows, and
    // (optionally) store the manufacturer account number so future reports match by number.
    if(b.action==="resolve"){
      const slug=String(b.manufacturer||"").trim();
      const maps=Array.isArray(b.mappings)?b.mappings:[];
      if(!slug) return json(400,{error:"manufacturer required"});
      // Don't promote a report "customer #" to a stored account number for order-number lines.
      let orderLines=new Set();
      try{ const cc=await sbGet("app_settings?key=eq.commission_config&select=value"); orderLines=new Set(((cc&&cc[0]&&cc[0].value&&cc[0].value.order_number_lines))||[]); }catch(e){}
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
        if(acct && !orderLines.has(slug)){ await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",{dealer_id:did,manufacturer:slug,account_ref:acct,active:true},{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{}); }
        resolved++;
      }
      return json(200,{ok:true,resolved,relinked});
    }

    // Pre-commit correction from the review screen: learn a name→dealer alias and (optionally) store
    // the manufacturer account number, so this and future reports auto-match. No monthly_sales writes.
    if(b.action==="learn_match"){
      const slug=String(b.manufacturer||"").trim();
      const name=String(b.name||"").trim();
      const did=b.dealer_id;
      if(!slug||!did) return json(400,{error:"manufacturer + dealer_id required"});
      if(name) await sbSend("POST","dealer_aliases?on_conflict=alias_norm",{alias_norm:dnorm(name),raw_name:name,dealer_id:did},{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{});
      const acct=String(b.account_ref||"").trim();
      if(acct){
        let orderLines=new Set();
        try{ const cc=await sbGet("app_settings?key=eq.commission_config&select=value"); orderLines=new Set(((cc&&cc[0]&&cc[0].value&&cc[0].value.order_number_lines))||[]); }catch(e){}
        if(!orderLines.has(slug)) await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",{dealer_id:did,manufacturer:slug,account_ref:acct,active:true},{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{});
      }
      return json(200,{ok:true});
    }

    // Assign a ship-to ZIP to a specific branch (resolves ambiguous/dropship ZIPs). Stored per line
    // in app_settings zipmap:<slug> and applied by every future analyze/import for this manufacturer.
    if(b.action==="assign_zip"){
      const slug=String(b.manufacturer||"").trim();
      const zraw=String(b.zip||"").replace(/[^0-9]/g,"");
      const zip=zraw? (zraw.length>5?zraw.slice(0,5):zraw.padStart(5,"0")) : "";
      const did=b.dealer_id;
      if(!slug||!zip||!did) return json(400,{error:"manufacturer + zip + dealer_id required"});
      const key="zipmap:"+slug;
      let cur={}; try{ const r=await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value`); if(r&&r[0]&&r[0].value&&typeof r[0].value==="object") cur=r[0].value; }catch(e){}
      cur[zip]=did;
      await sbSend("POST","app_settings?on_conflict=key",{key,value:cur,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

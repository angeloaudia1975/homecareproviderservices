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
// Reused-number manufacturers + account-capture exclusions live in ONE shared place, used by both
// the commission importer and the sales-report importer. PediFix is NAME_FIRST (a shared C-number can
// be two different Quipt dealers) but its number IS a real account number, so it is captured — with
// conflict flagging, never a silent overwrite (see reconcileAccountRef below).
const { NAME_FIRST, NO_ACCOUNT_CAPTURE } = require("./_mfr_rules.js");
// Split one uploaded file that spans several report months into per-month rows by Order Date.
function groupRowsByMonth(rows){ const g={}, undated=[]; for(const r of rows){ const d=toDate(r&&r.order_date); const m=d?d.slice(0,7):null; if(m){ (g[m]||(g[m]=[])).push(r); } else { undated.push(r); } } return {groups:g, undated}; }
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbGetAll(base, orderCol){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function fetchJson(url){ const r=await fetch(url); if(!r.ok) throw new Error("fetch "+r.status); return r.json(); }
// Organization-level manufacturer account numbers (parent + branches share one number, fill-blanks).
const orgAccounts=require("./_accountorg.js")(sbGet,sbSend);

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
// Street-address normalizer for branch matching — strip suite/unit qualifiers so "245 Northridge Dr
// Suite F" and "245 NORTHRIDGE DR" match the same branch.
const naddr=a=>String(a||"").toUpperCase().replace(/[^A-Z0-9 ]/g," ").replace(/\b(SUITE|STE|UNIT|APT|BLDG|BLD|FL|FLOOR|RM|ROOM|DEPT|#)\b.*$/,"").replace(/\s+/g," ").trim();
// Distinguish a NEW dealer BRANCH ship-to from a one-off patient/drop-ship consignee. A ship-to whose
// name carries a business marker, or shares a significant word with the dealer, is treated as a branch
// (held for review/creation); a bare person name ("Smith, John") is a patient drop-ship (sale → dealer).
const BIZ=/\b(inc|llc|corp|co|medical|health|healthcare|pharmacy|dme|supply|supplies|home|equipment|hospital|hosp|services|center|centre|clinic|homecare|rehab|mobility|oxygen|respiratory|surgical|drug|care)\b/i;
const STOPW=new Set(["THE","AND","FOR","INC","LLC","CORP","COMPANY","HOME","MEDICAL","EQUIPMENT","HEALTHCARE","HEALTH","CARE","SERVICES","SERVICE","SUPPLY","SUPPLIES","PHARMACY","HOSPITAL","CENTER","GROUP"]);
const sigTokens=s=>dnorm(s).split(" ").filter(t=>t.length>=4 && !STOPW.has(t));
function looksLikeBranch(shipName, custName){
  const sn=String(shipName||"").trim(); if(!sn) return false;
  if(/,/.test(sn) && !BIZ.test(sn)) return false;                 // "Last, First" with no business marker → patient
  const st=sigTokens(sn), ct=new Set(sigTokens(custName));
  if(st.some(t=>ct.has(t))) return true;                          // shares a distinctive word with the dealer
  return BIZ.test(sn);                                            // a business-named consignee is a candidate branch
}
// Resolve a ship-to to a specific branch within the dealer family (root + branches). Priority mirrors
// the operator's mental model: saved ZIP→branch override, exact ZIP, street address, ship-to NAME
// (a branch whose business name matches the consignee), then a unique city/state. Returns {id} or null.
function resolveBranchFn(root, famArr, ship, zipmap, rootOf, ambiguous, ambSeen, nameById){
  const zip=ship.zip, addr=ship.addr, city=ship.city, state=ship.state, sname=ship.name;
  // MASTER RULE: an explicit ZIP→branch assignment (set by an operator in Review) wins over
  // everything else — name, address, and spelling. New assignments are stored as
  // {d:dealer_id, c:corporate_root} so the rule applies only to the corporate that made it and
  // can route to a branch even if it wasn't already in the family. Older flat entries (a bare
  // dealer id) keep the in-family behavior. This makes ZIP the master key, so sloppy name/address
  // typing on the manufacturer's side can no longer misroute a shipment.
  if(zip && zipmap[zip] != null){
    const zm = zipmap[zip];
    if(zm && typeof zm === "object"){ if(zm.d && (!zm.c || zm.c === root)) return {id:zm.d}; }
    else if(zm && rootOf.get(zm) === root){ return {id:zm}; }
  }
  if(zip){ const hit=famArr.filter(d=>znorm(d.zip)===zip);
    if(hit.length===1) return {id:hit[0].id};
    if(hit.length>1){ if(!ambSeen.has(zip)){ ambSeen.add(zip); ambiguous.push({zip,dealers:hit.map(d=>({id:d.id,name:nameById.get(d.id)||d.id}))}); } return {id:hit[0].id}; } }
  if(addr){ const hit=famArr.filter(d=>{ const a=naddr(d.address); return a && a===addr; }); if(hit.length>=1) return {id:hit[0].id}; }
  // Ship-to NAME → an existing branch whose business name matches the consignee (e.g. "DASCO / Lima
  // Branch"). Only used when the consignee looks like a branch, never a bare patient name.
  if(sname){ const snd=dnorm(sname); if(snd){ const hit=famArr.filter(d=>{ const bn=dnorm(nameById.get(d.id)||d.business_name||""); return bn && bn===snd; }); if(hit.length>=1) return {id:hit[0].id}; } }
  if(city){ const c=ncity(city), st=nstate(state); const hit=famArr.filter(d=>ncity(d.city)===c && (!st||nstate(d.state)===st)); if(hit.length===1) return {id:hit[0].id}; }
  return null;
}

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
  const fam=await sbGetAll("dealers?select=id,business_name,city,state,zip,address,parent_id","business_name").catch(()=>[]);
  const rootOf=new Map(), byRoot=new Map(), nameById=new Map();
  // Match by dealer business NAME (normalized), not just saved aliases — so a line resolves to the
  // dealer that actually bears that name even when its customer number is shared/reused. First writer
  // wins on a normalized-name collision.
  const idByName={};
  for(const d of (fam||[])){ const root=d.parent_id||d.id; rootOf.set(d.id,root); (byRoot.get(root)||byRoot.set(root,[]).get(root)).push(d); nameById.set(d.id,d.business_name);
    const nk=dnorm(d.business_name); if(nk && !(nk in idByName)) idByName[nk]=d.id; }
  // Saved ZIP→branch assignments (from the review screen) — resolve ambiguous/assigned ZIPs deterministically.
  let zipmap={};
  try{ const zm=await sbGet(`app_settings?key=eq.zipmap:${encodeURIComponent(slug)}&select=value`); if(zm&&zm[0]&&zm[0].value&&typeof zm[0].value==="object") zipmap=zm[0].value; }catch(e){}
  // Access4u: channel (physical/drop-ship) is decided on the invoice; a later payment inherits it via
  // the R-##### reference. Preload already-imported invoice channels so cross-month payments classify.
  const invChannel={};
  try{ const iv=await sbGetAll(`monthly_sales?manufacturer=eq.${encodeURIComponent(slug)}&line_type=eq.invoice&select=invoice_no,channel`,"invoice_no").catch(()=>[]);
    for(const x of (iv||[])){ if(x.invoice_no) invChannel[String(x.invoice_no).toUpperCase()]=x.channel; } }catch(e){}
  return {idByAlias,idByName,idByAccount,orderLines,rootOf,byRoot,nameById,zipmap,invChannel};
}

// Map raw report rows to monthly_sales rows AND compute a review report. Pure (no DB writes) so the
// same code powers the dry-run "analyze" and the real "import". Dealer match: account# first, then
// name alias. Branch attribution: ship-to ZIP → a branch/corporate ZIP on file = physical; no ZIP
// match = corporate drop-ship. (Falls back to city/state for lines that supply them, e.g. non-Golden.)
function mapRows(slug, per, source_file, rows, ctx){
  const {idByAlias,idByName,idByAccount,orderLines,rootOf,byRoot,nameById}=ctx;
  const zipmap=ctx.zipmap||{}, invChannel=ctx.invChannel||{};
  const refMatch=!orderLines.has(slug);
  const nameFirst=NAME_FIRST.has(slug);
  const out=[]; const unmatched=new Map();
  let matched=0, physical=0, dropship=0, physAmt=0, dropAmt=0, credits=0, amtTot=0, commTot=0, heldRows=0;
  const newAcct=new Map(), noZip=new Map(), ambiguous=[], ambSeen=new Set(), models=new Set(), unknownBranch=new Map();
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
    const shipName=(r.ship_name!=null)?String(r.ship_name).trim():"";
    const shipAddr=(r.ship_address!=null)?String(r.ship_address).trim():"";
    const shipAddrN=naddr(shipAddr);
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
    const acctId=refMatch&&acct?(idByAccount[acct]||null):null;
    const nameId=name?(idByAlias[dnorm(name)]||idByName[dnorm(name)]||null):null;
    // Reused-number manufacturers (NAME_FIRST): the customer NAME is authoritative — resolve by it, and
    // only fall back to the number when no dealer bears the name. Everyone else keeps number-first, but
    // now a NAME that maps to a DIFFERENT dealer than the number still wins (that mismatch was a misroute).
    let did;
    if(nameFirst) did=nameId||acctId||null;
    else if(nameId&&acctId&&nameId!==acctId) did=nameId;
    else did=acctId||nameId||null;
    const byName=!!(did&&did===nameId);
    const byAcct=!!(did&&!byName&&did===acctId);
    let channel=null;
    if(did){
      const root=rootOf.get(did)||did;
      const famArr=byRoot.get(root)||[];
      const famZips=famArr.map(d=>znorm(d.zip)).filter(Boolean);
      const hasShip = !!(shipZip||shipAddrN||shipCity||shipName);
      if(hasShip){
        // BRANCH-AWARE routing (GCE + any line with ship-to). Resolve the ship-to to a branch within
        // the dealer family; assign the sale to the ACTUAL location, never bundled onto corporate.
        const rb = resolveBranchFn(root, famArr, {zip:shipZip, addr:shipAddrN, city:shipCity, state:shipState, name:shipName}, zipmap, rootOf, ambiguous, ambSeen, nameById);
        if(rb && rb.id){ did=rb.id; channel="physical"; }
        else if(looksLikeBranch(shipName, name||nameById.get(root))){
          // A dealer LOCATION we don't have on file yet → HOLD (do not assign to corporate). Surfaced
          // in Review & Correct so the operator can create the branch under this corporate, or reassign.
          did=null; heldRows++;
          // Key on ZIP+address; fall back to the ship-to name when neither is present so distinct
          // name-only branches don't collapse into one held bucket.
          const key=root+"|"+shipZip+"|"+shipAddrN+"|"+((shipZip||shipAddrN)?"":dnorm(shipName));
          const g=unknownBranch.get(key)||{corporate_id:root, corporate_name:nameById.get(root)||name||"", account_ref:acct||"",
            ship_name:shipName, ship_address:shipAddr, ship_city:shipCity, ship_state:shipState, ship_zip:shipZip, count:0, amount:0};
          g.count++; g.amount+=amount||0; unknownBranch.set(key,g);
        } else {
          // A patient / one-off consignee → drop-ship. The SALE belongs to the dealer; keep the ship-to
          // on the row for history, but don't invent a branch for a person.
          did=root; channel="dropship";
        }
      } else if(lineType==="invoice"||lineType==="payment"){
        // Ledger line with no ship-to (access4u): channel from the order memo / linked payment.
        did=root;
        const linked = lineType==="payment" ? (localInv[invRef]||invChannel[invRef]) : null;
        channel = (poDropOf(memo) || linked==="dropship") ? "dropship" : "physical";
      } else if(famZips.length){
        did=root; channel="dropship";                   // branch ZIPs exist but this line has no ship-to
      } else {
        did=root; channel="physical"; const n0=noZip.get(root)||{dealer_id:root,name:nameById.get(root)||name,count:0}; n0.count++; noZip.set(root,n0);
      }
      if(did){
        matched++;
        if(channel==="physical"){ physical++; physAmt+=amount||0; } else { dropship++; dropAmt+=amount||0; }
        if(byName && !byAcct && acct && !idByAccount[acct] && !orderLines.has(slug)){
          const k=root+"|"+acct; if(!newAcct.has(k)) newAcct.set(k,{dealer_id:root,name:nameById.get(root)||name,account_ref:acct}); }
      }
    } else if(name){
      // Unmatched corporate — the dealer isn't in Dealer 360 yet. Instead of collapsing all its rows
      // into one name-only bucket, break them out by ship-to LOCATION so the operator sees exactly
      // where product shipped before matching: distinct branch-type ship-tos are listed individually
      // (a create-branch candidate each), person-name/patient consignees roll up as drop-ship "other
      // revenue" on the corporate, and ledger lines with no ship-to roll up separately.
      const u=unmatched.get(name)||{name,account:acct||"",zip:shipZip||"",count:0,
        dropship:{count:0,amount:0}, noship:{count:0,amount:0}, _locs:new Map()};
      u.count++; if(!u.account&&acct)u.account=acct;
      const amt = amount!=null?amount:(billed!=null?billed:0);
      const hasShip = !!(shipZip||shipAddrN||shipName||shipCity);
      if(hasShip && looksLikeBranch(shipName, name)){
        // Group by normalized ZIP + street address so spelling/case/name variants of the SAME physical
        // branch ("245 Northridge Dr" vs "245 NORTHRIDGE DR") merge instead of splitting.
        const key=shipZip+"|"+shipAddrN+"|"+((shipZip||shipAddrN)?"":dnorm(shipName));
        const g=u._locs.get(key)||{ship_name:shipName,ship_address:shipAddr,ship_city:shipCity,ship_state:shipState,ship_zip:shipZip,count:0,amount:0};
        g.count++; g.amount+=amt; if(!g.ship_name&&shipName)g.ship_name=shipName; if(!g.ship_address&&shipAddr)g.ship_address=shipAddr;
        u._locs.set(key,g);
      } else if(hasShip){
        u.dropship.count++; u.dropship.amount+=amt;     // patient / one-off consignee → other revenue on corp
      } else {
        u.noship.count++; u.noship.amount+=amt;          // ledger line with no ship-to
      }
      unmatched.set(name,u);
    }
    out.push({
      manufacturer:slug, period:per, dealer_id:did||null, channel:channel||null,
      customer_name:name||null, customer_ref:acct||null,
      ship_city:shipCity||null, ship_state:shipState||null, ship_zip:shipZip||null,
      ship_name:shipName||null, ship_address:shipAddr||null,
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
  const R2=n=>Math.round((n||0)*100)/100;
  const review={ total:rows.length, matched, unmatched_count:unmatched.size,
    unmatched:[...unmatched.values()].sort((a,b)=>b.count-a.count).slice(0,300).map(u=>{
      const branches=[...(u._locs?u._locs.values():[])].sort((a,b)=>b.count-a.count)
        .map(g=>({ship_name:g.ship_name||"",ship_address:g.ship_address||"",ship_city:g.ship_city||"",ship_state:g.ship_state||"",ship_zip:g.ship_zip||"",count:g.count,amount:R2(g.amount)})).slice(0,80);
      const branch_amount=R2(branches.reduce((a,g)=>a+g.amount,0));
      const total_amount=R2(branch_amount+(u.dropship?u.dropship.amount:0)+(u.noship?u.noship.amount:0));
      return { name:u.name, account:u.account, zip:u.zip, count:u.count, branches, branch_amount, total_amount,
        dropship:{count:(u.dropship?u.dropship.count:0),amount:R2(u.dropship?u.dropship.amount:0)},
        noship:{count:(u.noship?u.noship.count:0),amount:R2(u.noship?u.noship.amount:0)} };
    }),
    physical_rows:physical, dropship_rows:dropship,
    physical_amount:Math.round(physAmt*100)/100, dropship_amount:Math.round(dropAmt*100)/100,
    new_accounts:[...newAcct.values()].slice(0,300), no_zip_dealers:[...noZip.values()].slice(0,300),
    unknown_branches:[...unknownBranch.values()].sort((a,b)=>b.count-a.count).slice(0,400), held_rows:heldRows,
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
      // GCE / Ohio Medical is a two-tab open/paid commission source — always offer it in the picker,
      // labeled so it's recognizable as the GCE report (its parser reads the two GCE tabs directly).
      // Consolidated onto ONE slug: drop the legacy duplicate 'gce' so only 'ohio-medical' shows.
      nameMap["ohio-medical"]="Ohio Medical / GCE";
      delete nameMap["gce"];
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
      const multi=b.multi_month===true||period==="auto";
      const rows=Array.isArray(b.rows)?b.rows:[];
      if(!slug) return json(400,{error:"manufacturer required"});
      if(!multi && !/^\d{4}-\d{2}$/.test(period)) return json(400,{error:"manufacturer + period (YYYY-MM) required"});
      if(!rows.length) return json(400,{error:"no rows"});
      const ctx=await buildCtx(slug);
      // Dealer matching does not depend on the period, so a single pass scores the whole file for review.
      const {review}=mapRows(slug,`${(multi?"2000-01":period)}-01`,String(b.source_file||"").trim()||null,rows,ctx);
      if(multi){
        const {groups,undated}=groupRowsByMonth(rows);
        review.months=Object.keys(groups).sort().map(m=>({period:m,rows:groups[m].length}));
        review.undated_rows=undated.length;
        if(!review.months.length) return json(200,{ok:false,error:"No usable Order Date on any row — map the Order Date column, or uncheck ‘multiple months’ and pick one report month."});
      }
      return json(200,{ok:true,review});
    }

    // Commit: map the rows and write them to monthly_sales (replacing any prior load of this file+month).
    // A file may cover ONE month (b.period=YYYY-MM) or SEVERAL (b.multi_month=true / period="auto") —
    // in the multi-month case each row is filed under its own Order Date, one delete+insert per month,
    // so re-importing the same file stays idempotent per month.
    if(b.action==="import"){
      const slug=String(b.manufacturer||"").trim();
      const period=String(b.period||"").trim();          // expect YYYY-MM (single-month)
      const multi=b.multi_month===true||period==="auto";
      const source_file=String(b.source_file||"").trim()||null;
      const rows=Array.isArray(b.rows)?b.rows:[];
      if(!slug) return json(400,{error:"manufacturer required"});
      if(!multi && !/^\d{4}-\d{2}$/.test(period)) return json(400,{error:"manufacturer + period (YYYY-MM) required"});
      if(!rows.length) return json(400,{error:"no rows"});
      const ctx=await buildCtx(slug);
      // Column-existence probes: enrichment cols (golden_import.sql) + ship cols (attribution.sql).
      let hasEnrich=true; try{ const p=await fetch(`${SUPABASE_URL}/rest/v1/monthly_sales?select=channel&limit=1`,{headers:H()}); hasEnrich=p.ok; }catch(e){ hasEnrich=false; }
      let hasShip=true;   try{ const p=await fetch(`${SUPABASE_URL}/rest/v1/monthly_sales?select=ship_city&limit=1`,{headers:H()}); hasShip=p.ok; }catch(e){ hasShip=false; }
      let hasShipNA=true; try{ const p=await fetch(`${SUPABASE_URL}/rest/v1/monthly_sales?select=ship_name&limit=1`,{headers:H()}); hasShipNA=p.ok; }catch(e){ hasShipNA=false; }
      const ENRICH=["channel","item_no","line_type","credit_reason","invoice_no","ship_zip","commission_rate","order_date","billed_amount","memo"];
      const clean1=out=>out.map(o=>{ const row={...o};
        if(!hasEnrich) ENRICH.forEach(k=>delete row[k]);
        if(!hasShip){ delete row.ship_city; delete row.ship_state; delete row.ship_zip; }
        if(!hasShipNA){ delete row.ship_name; delete row.ship_address; }   // pre-migration safety
        return row; });
      // Build the per-month batches to write.
      let batches, undatedCount=0;
      if(multi){
        const g=groupRowsByMonth(rows); undatedCount=g.undated.length;
        batches=Object.keys(g.groups).sort().map(m=>({per:`${m}-01`,period:m,rows:g.groups[m]}));
        if(!batches.length) return json(200,{ok:false,error:"No usable Order Date on any row — can't split by month."});
      } else {
        batches=[{per:`${period}-01`,period,rows}];
      }
      let inserted=0; const allOut=[]; const monthsWritten=[];
      for(const bt of batches){
        const {out}=mapRows(slug,bt.per,source_file,bt.rows,ctx);
        const clean=clean1(out);
        try{ let del=`monthly_sales?manufacturer=eq.${encodeURIComponent(slug)}&period=eq.${encodeURIComponent(bt.per)}`;
          if(source_file) del+=`&source_file=eq.${encodeURIComponent(source_file)}`;
          await sbSend("DELETE",del,null,{Prefer:"return=minimal"}); }catch(e){}
        for(let i=0;i<clean.length;i+=500){ const part=clean.slice(i,i+500); await sbSend("POST","monthly_sales",part,{Prefer:"return=minimal"}); inserted+=part.length; }
        allOut.push(...out); monthsWritten.push({period:bt.period,rows:clean.length});
      }
      // One combined review for the response (dealer matching is period-independent, so a single pass scores all rows).
      const review=mapRows(slug,"2000-01-01",source_file,rows,ctx).review;
      review.months=monthsWritten; if(undatedCount) review.undated_rows=undatedCount;
      // Account-number maintenance (STANDARD RULE, shared with the sales-report importer): capture the
      // account number this report carries for each matched dealer — the report company name for
      // name-as-account lines (Access4u), otherwise the customer # — SET it when blank (and fill the
      // family), CONFIRM + mark active when it matches, and FLAG (never overwrite) when it differs.
      let accounts_set=0; const acctConflicts=[];
      if(!(ctx.orderLines&&ctx.orderLines.has(slug)) && !NO_ACCOUNT_CAPTURE.has(slug)){
        const acctByDealer=new Map();
        for(const o of allOut){
          if(!o.dealer_id) continue;
          const ref = NAME_AS_ACCOUNT.has(slug) ? String(o.customer_name||"").trim() : String(o.customer_ref||"").trim();
          const e=acctByDealer.get(o.dealer_id)||new Set(); if(ref) e.add(ref); acctByDealer.set(o.dealer_id, e);
        }
        for(const [dealerId,set] of acctByDealer){
          const refs=[...set];
          if(refs.length>1){ acctConflicts.push({dealer_id:dealerId,reason:"report_lists_multiple_numbers",values:refs}); continue; }
          try{ const res=await orgAccounts.reconcileAccountRef(slug, dealerId, refs[0]||"", {apply:true});
            if(res.status==="set") accounts_set++;
            else if(res.status==="conflict") acctConflicts.push({dealer_id:dealerId,existing:res.existing,incoming:res.incoming,reason:"differs_from_record"});
          }catch(e){}
        }
      }
      review.account_conflicts=acctConflicts;
      return json(200,{ok:true,inserted,review,accounts_set,months:monthsWritten,
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
        // 3) store the account number on that dealer's line, and fill it across the org's family
        //    (parent + branches) wherever a branch has none yet — so future reports match by number.
        const acct=String(m.account_ref||"").trim();
        if(acct && !orderLines.has(slug)){ await orgAccounts.propagateAccountRef(slug,did,acct).catch(()=>{}); }
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
        if(!orderLines.has(slug)) await orgAccounts.propagateAccountRef(slug,did,acct).catch(()=>{});
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
      const corp=String(b.corporate_id||"").trim();   // corporate root this rule belongs to (from Review)
      if(!slug||!zip||!did) return json(400,{error:"manufacturer + zip + dealer_id required"});
      const key="zipmap:"+slug;
      let cur={}; try{ const r=await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value`); if(r&&r[0]&&r[0].value&&typeof r[0].value==="object") cur=r[0].value; }catch(e){}
      // Store {d:dealer, c:corporate-root}. With the corporate scope, this ZIP→branch rule becomes the
      // MASTER key for that corporate — it routes the shipment to `did` on every future import,
      // regardless of how the name/address was typed, and even if `did` isn't already in the family.
      cur[zip] = corp ? {d:did, c:corp} : {d:did};
      await sbSend("POST","app_settings?on_conflict=key",{key,value:cur,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

// HCPS ⇄ Golden Federation — inbound event RECEIVER.
// Implements FEDERATED_ARCHITECTURE.md v1.1.0: §5.1 (signed, idempotent transport),
// §5.2 (canonical envelope), §5.3 (event catalog), §3.10 (cross-system identity),
// §8 (idempotent upserts, occurred_at authoritative). One-way: HCPS only CONSUMES.
//
//   POST /.netlify/functions/federation-events
//     headers: X-HCPS-Signature: <hex HMAC-SHA256 of the raw body, key=FEDERATION_SECRET>
//     body:    the canonical Event Envelope (§5.2)
//   -> 200 { ok:true, dealer_id, matched, duplicate? }   (2xx only after durable write)
//   -> 401 on bad/missing signature
//
// Golden signals land in the SAME tables the rest of HCPS intelligence already
// reads (intent_events → engagement/intent/tasks/handout; dealer_activity →
// Dealer 360 timeline), plus federation_* plumbing for idempotency/identity.
const crypto = require("crypto");
const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SECRET = process.env.FEDERATION_SECRET || "";
const KNOWN_SOURCES = new Set(["golden"]);          // extend as more manufacturer platforms federate
const CORS = { "access-control-allow-origin":"*", "access-control-allow-methods":"POST, OPTIONS", "access-control-allow-headers":"content-type, x-hcps-signature" };
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null; }

const { weightFor, getConfig } = require("./_intent.js");
const { dnorm } = require("./_scope.js");
const P = require("./_platform.js");

const clip=(s,n)=>{ s=String(s==null?"":s).trim(); return s?s.slice(0,n||300):null; };

// Staff auth for the observability GET (president-only) — resolve the Supabase JWT to a staff row.
async function whoami(event){
  const auth=(event.headers&&(event.headers.authorization||event.headers.Authorization))||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(!r.ok) return null; const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase(); if(!email) return null;
    const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,active`).catch(()=>[]); const su=s&&s[0];
    if(su&&su.active!==false) return {email,role:su.role||"rep"};
  }catch(e){}
  return null;
}
const money=n=>"$"+Math.round(Number(n)||0).toLocaleString("en-US");

// Canonical Golden event  ->  HCPS intent event_type (see plan / §5.3).
const EVENT_TO_INTENT = {
  "dealer.login":"login",
  "product.viewed":"product_view",
  "product.clicked":"product_clicked",
  "product.added_to_cart":"cart_add",
  "cart.abandoned":"cart_abandoned",
  "order.created":"order_created",
  "order.completed":"order_completed",
  "product.purchased":"product_purchased",
};
const ORDER_EVENTS = new Set(["order.created","order.completed"]);

// Verify the HMAC-SHA256 signature over the EXACT raw bytes we received.
function verifySig(rawBuf, sigHex){
  if(!SECRET || !sigHex) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(rawBuf).digest("hex");
  const a = Buffer.from(String(sigHex).trim().toLowerCase(), "utf8"), b = Buffer.from(expected, "utf8");
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

// Resolve the source dealer to a canonical HCPS dealer_id (§3.10). Order:
//   1. hcps_dealer_id on the event (already linked)      -> exact
//   2. partner_dealer_map cache (by external id or acct) -> cached
//   3. dealers.hcps_account === customer_no              -> account
//   4. dnorm(name) [+ zip] alias match                  -> alias
// Returns { dealer_id, is_test, confidence } or { dealer_id:null } if unmatched.
async function resolveDealer(env){
  const dealer = env.dealer||{};
  const ext = clip(dealer.dealer_id, 120);
  const cust = clip(dealer.customer_no, 60);
  const name = clip(dealer.display_name||dealer.name||dealer.legal_name, 200);
  const zip = clip(dealer.zip, 20);
  const src = clip(env.source&&env.source.system, 40)||"golden";
  const ten = clip(env.source&&env.source.tenant_id, 40)||"hcps";

  // 1. Already-linked hcps_dealer_id — trust only if it's a real dealer.
  const hid = clip(dealer.hcps_dealer_id, 60);
  if(hid){ try{ const d=await sbGet(`dealers?id=eq.${encodeURIComponent(hid)}&select=id,is_test`); if(d&&d[0]) return {dealer_id:d[0].id,is_test:!!d[0].is_test,confidence:"exact"}; }catch(e){} }

  // 2. Cache.
  try{
    const clauses=[];
    if(ext) clauses.push(`external_dealer_id.eq.${encodeURIComponent(ext)}`);
    if(cust) clauses.push(`customer_no.eq.${encodeURIComponent(cust)}`);
    if(clauses.length){
      const m=await sbGet(`partner_dealer_map?source_system=eq.${encodeURIComponent(src)}&tenant_id=eq.${encodeURIComponent(ten)}&or=(${clauses.join(",")})&select=dealer_id&limit=1`);
      if(m&&m[0]&&m[0].dealer_id){ let isTest=false; try{ const d=await sbGet(`dealers?id=eq.${encodeURIComponent(m[0].dealer_id)}&select=is_test`); isTest=!!(d&&d[0]&&d[0].is_test); }catch(e){} return {dealer_id:m[0].dealer_id,is_test:isTest,confidence:"cached"}; }
    }
  }catch(e){}

  // 3. Account number == HCPS account. Account numbers are ORGANIZATION-level (§3.5), so a
  // multi-branch dealer (e.g. Georges Pharmacy) carries the SAME number on several rows. Resolve
  // to the organization HQ (parent_id null) instead of refusing a non-unique match; a single match
  // uses that row directly. This attaches the org's portal activity to the record Dealer 360 rolls
  // branches up into.
  if(cust){ try{ const d=await sbGet(`dealers?hcps_account=eq.${encodeURIComponent(cust)}&select=id,parent_id,is_test`);
    if(d&&d.length){ const pick = d.length===1 ? d[0] : (d.find(x=>!x.parent_id)||d[0]);
      const conf = d.length===1?"account":"account_org";
      await cacheMap(src,ten,ext,cust,pick.id,conf); return {dealer_id:pick.id,is_test:!!pick.is_test,confidence:conf}; } }catch(e){} }

  // 4. Name (+ optional zip) alias match, normalized the same way as the rest of HCPS.
  if(name){ try{
    const first=name.replace(/[%_]/g," ").trim().split(/\s+/)[0]||name;
    const cand=await sbGet(`dealers?business_name=ilike.*${encodeURIComponent(first)}*&select=id,business_name,zip,is_test&limit=50`);
    const key=dnorm(name);
    let hits=(cand||[]).filter(x=>dnorm(x.business_name)===key);
    if(hits.length>1 && zip) hits=hits.filter(x=>String(x.zip||"").slice(0,5)===String(zip).slice(0,5));
    if(hits.length===1){ await cacheMap(src,ten,ext,cust,hits[0].id,"alias"); return {dealer_id:hits[0].id,is_test:!!hits[0].is_test,confidence:"alias"}; }
  }catch(e){} }

  return {dealer_id:null};
}
async function cacheMap(src,ten,ext,cust,dealer_id,confidence){
  try{ await sbSend("POST","partner_dealer_map?on_conflict=source_system,tenant_id,external_dealer_id",
    {source_system:src,tenant_id:ten,external_dealer_id:ext||null,customer_no:cust||null,dealer_id,confidence,updated_at:new Date().toISOString()},
    {Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){}
}

// A short, human subject line for the Dealer 360 timeline row.
function timelineSubject(evt, data, product){
  const p = product && (product.name||product.product_id);
  switch(evt){
    case "dealer.login": return "Signed in to the Golden portal";
    case "product.viewed": return p?`Viewed ${p}`:"Viewed a product";
    case "product.clicked": return p?`Clicked ${p}`:(data&&data.placement?`Clicked (${clip(data.placement,40)})`:"Clicked a product/promo");
    case "product.added_to_cart": return p?`Added ${p} to cart`:"Added an item to cart";
    case "cart.abandoned": return `Abandoned cart${data&&data.cart_value?` (${money(data.cart_value)})`:""}`;
    case "order.created": return `Placed an order${data&&data.total?` — ${money(data.total)}`:""}${data&&data.order_id?` (#${clip(data.order_id,40)})`:""}`;
    case "order.completed": return `Order completed${data&&data.total?` — ${money(data.total)}`:""}${data&&data.order_id?` (#${clip(data.order_id,40)})`:""}`;
    case "product.purchased": return p?`Purchased ${p}${data&&data.qty?` ×${data.qty}`:""}`:"Purchased a product";
    default: return `Golden: ${clip(evt,60)}`;
  }
}

exports.handler = async (event) => {
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});

    // ---- Observability (president-only): watch federation ingestion live ----
    if(event.httpMethod==="GET"){
      const me=await whoami(event); if(!me||me.role!=="president") return json(401,{error:"unauthorized"});
      const out={ok:true,counts:{},recent:[],unmatched:[]};
      try{ const rows=await sbGet("federation_events?select=status&limit=100000"); const c={}; for(const r of rows) c[r.status]=(c[r.status]||0)+1; out.counts=c; out.total=rows.length; }
      catch(e){ if(/relation|does not exist|federation_events/i.test(String(e&&e.message||e))) return json(200,{ok:false,error:"tables_missing",message:"Run supabase/federation.sql in Supabase first."}); }
      try{ out.recent=await sbGet("federation_events?select=event,status,dealer_id,customer_no,external_dealer_id,occurred_at,received_at&order=received_at.desc&limit=25"); }catch(e){}
      try{ out.unmatched=await sbGet("federation_unmatched?resolved_dealer_id=is.null&select=customer_no,dealer_name,event,occurred_at&order=created_at.desc&limit=25"); }catch(e){}
      return json(200,out);
    }

    if(!SECRET) return json(500,{error:"FEDERATION_SECRET not configured"});
    if(event.httpMethod!=="POST") return json(405,{error:"method not allowed"});

    // Verify the signature over the RAW bytes exactly as received.
    const rawBuf = event.isBase64Encoded ? Buffer.from(event.body||"", "base64") : Buffer.from(event.body||"", "utf8");
    const sig = (event.headers&&(event.headers["x-hcps-signature"]||event.headers["X-HCPS-Signature"]))||"";
    if(!verifySig(rawBuf, sig)) return json(401,{error:"bad signature"});

    let env; try{ env=JSON.parse(rawBuf.toString("utf8")||"{}"); }catch{ return json(400,{error:"bad JSON"}); }
    const evt = clip(env.event, 60);
    const eventId = clip(env.event_id || env.idempotency_key, 120);
    if(!evt || !eventId) return json(400,{error:"event and event_id required"});
    if(!EVENT_TO_INTENT[evt]) return json(202,{ok:true,ignored:"unknown event"});   // accept-and-ignore unknown catalog events
    const src = clip(env.source&&env.source.system, 40)||"golden";
    if(!KNOWN_SOURCES.has(src)) return json(202,{ok:true,ignored:"unknown source"});
    const tenant = clip(env.source&&env.source.tenant_id, 40)||"hcps";

    // Idempotency (§5.1): a re-delivered event is accepted and ignored.
    try{ const seen=await sbGet(`federation_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id&limit=1`); if(seen&&seen[0]) return json(200,{ok:true,duplicate:true}); }catch(e){}

    const occurredAt = env.occurred_at || new Date().toISOString();
    const manufacturer = clip(env.manufacturer_id, 60) || "golden-technologies";
    const product = env.product||null;
    const productCode = product ? clip(product.product_id||product.code, 60) : null;
    const data = (env.data&&typeof env.data==="object")?env.data:{};
    const dealerBlk = env.dealer||{};

    // Resolve the canonical dealer.
    const res = await resolveDealer(env);
    const auditBase = {
      event_id:eventId, event:evt, source_system:src, tenant_id:tenant,
      external_dealer_id:clip(dealerBlk.dealer_id,120), customer_no:clip(dealerBlk.customer_no,60),
      manufacturer, occurred_at:occurredAt, raw:env,
    };

    if(!res.dealer_id){
      // No dealer match — store whole for admin assignment; still 200 so Golden doesn't retry forever.
      try{ await sbSend("POST","federation_unmatched",{source_system:src,tenant_id:tenant,external_dealer_id:auditBase.external_dealer_id,customer_no:auditBase.customer_no,dealer_name:clip(dealerBlk.display_name||dealerBlk.name,200),event:evt,occurred_at:occurredAt,raw:env},{Prefer:"return=minimal"}); }catch(e){}
      try{ await sbSend("POST","federation_events?on_conflict=event_id",{...auditBase,dealer_id:null,status:"unmatched"},{Prefer:"resolution=ignore-duplicates,return=minimal"}); }catch(e){}
      return json(200,{ok:true,matched:false,dealer_id:null});
    }
    const dealerId = res.dealer_id;

    // Env stamp so dev/test activity never contaminates live intelligence (mirrors events-api).
    let mode="development"; try{ mode=(await P.getState()).mode; }catch(e){}
    const evStamp = P.envFor(mode, res.is_test);

    // 1. intent_events — feeds engagement/intent/tasks/handout via the existing cron.
    let intentType = EVENT_TO_INTENT[evt];
    if(intentType==="product_view" && data && data.repeat) intentType="product_view_repeat";
    const cfg=await getConfig();
    const intentRow={ dealer_id:dealerId, manufacturer, product_code:productCode, event_type:intentType,
      weight:weightFor(intentType,cfg), source:src, env:evStamp,
      meta:{...data, event:evt, branch_id:clip(dealerBlk.branch_id||env.branch_id,60)}, occurred_at:occurredAt };
    try{ await sbSend("POST","intent_events",[intentRow],{Prefer:"return=minimal"}); }catch(e){}

    // 2. dealer_activity — Dealer 360 timeline. Verbosity is config-driven (default 'all').
    let verbosity="all"; try{ const c=await sbGet("app_settings?key=eq.automation_config&select=value"); verbosity=(c&&c[0]&&c[0].value&&c[0].value.federation_timeline_verbosity)||"all"; }catch(e){}
    const HIGH=new Set(["dealer.login","cart.abandoned","order.created","order.completed","product.purchased"]);
    const wantTimeline = verbosity==="all" || (verbosity==="high" && HIGH.has(evt)) || (verbosity==="rollup" && HIGH.has(evt));
    if(wantTimeline){
      const subj=timelineSubject(evt, data, product);
      const detailBits=[product&&(product.name||product.product_id)?("Product: "+clip(product.name||product.product_id,80)):"", data&&data.query?("Search: "+clip(data.query,80)):"", dealerBlk.branch_id||env.branch_id?("Branch: "+clip(dealerBlk.branch_id||env.branch_id,40)):""].filter(Boolean);
      try{ await sbSend("POST","dealer_activity",{dealer_id:dealerId,kind:"golden",subject:subj,detail:detailBits.join(" · ")||null,actor:"Golden portal",created_at:occurredAt},{Prefer:"return=minimal"}); }catch(e){}
    }

    // 3. Order/purchase SIGNAL mirror (never monthly_sales). Deduped by event_id.
    if(ORDER_EVENTS.has(evt)){
      const lines=Array.isArray(data.lines)?data.lines.slice(0,200).map(l=>({product_id:clip(l.product_id||l.sku||l.code,60),name:clip(l.name,120),qty:Number(l.qty)||null,value:Number(l.value||l.total||l.amount)||null})):[];
      try{ await sbSend("POST","federation_orders?on_conflict=event_id",
        {event_id:eventId,dealer_id:dealerId,manufacturer,external_order_id:clip(data.order_id,80),order_total:Number(data.total)||null,line_count:lines.length||(Number(data.line_count)||null),lines,status:evt==="order.completed"?"completed":"created",occurred_at:occurredAt},
        {Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){}
    }

    // 4. Record in the idempotency inbox LAST — only after the durable fan-out above.
    try{ await sbSend("POST","federation_events?on_conflict=event_id",{...auditBase,dealer_id:dealerId,status:"processed"},{Prefer:"resolution=ignore-duplicates,return=minimal"}); }catch(e){}

    // Echo the resolved dealer_id so Golden can back-fill hcps_dealer_id (§5.4/§8.5).
    return json(200,{ok:true,matched:true,dealer_id:dealerId,hcps_dealer_id:dealerId});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

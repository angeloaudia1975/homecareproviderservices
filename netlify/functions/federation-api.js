// HCPS federation intelligence API — powers the Golden Activity dashboard and the
// Product-Interest → campaign audience builder. Reads the behavioral signals the
// federation receiver lands (intent_events source='golden', federation_events,
// federation_orders) plus monthly_sales (to know who already ordered), and can turn
// a product/line interest list into a saved audience for Campaign Studio.
//
//   POST { action:"dashboard" }                 -> Golden activity KPIs + lists
//   POST { action:"products" }                  -> products/lines with intent (picker)
//   POST { action:"product_interest", product?, manufacturer?, window_days?, signals? }
//                                                -> dealers showing intent who haven't ordered
//   POST { action:"build_audience", name, dealer_ids[], meta? } -> { audience_id }
//   POST { action:"provision_test_dealer", account?, email?, name? } -> president: is_test sandbox dealer
//   POST { action:"resolve_unmatched" }         -> president: re-run matching on the unmatched queue
//   POST { action:"purge_test" }                -> president-only: remove PR505M live-test rows
//   POST { action:"dealer_options" }            -> compact dealer list for the assign picker
//   POST { action:"assign_unmatched", dealer_id, customer_no|unmatched_id } -> president: manual assign
//   POST { action:"activation_audience", preview? } -> Golden-access dealers who never logged in → audience
//   POST { action:"dealer_score", dealer_id }   -> composite Activation & Engagement score (0–100)
//   POST { action:"golden_sso_link", dealer_id } -> signed one-click deep-link into the Golden portal
// All require a staff Bearer token. Reps are scoped to their own dealers.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); const t=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`); return t?JSON.parse(t):null; }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; if(from>=60000) break; } return out; }
const { dealerScope } = require("./_scope.js");

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(!r.ok) return null; const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase(); if(!email) return null;
    const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
    if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email};
  }catch(e){}
  return null;
}

const VIEW_TYPES=new Set(["product_view","product_view_repeat","product_clicked","pricing_view"]);
const CART_TYPES=new Set(["cart_add","cart_abandoned"]);
const clip=(s,n)=>{ s=String(s==null?"":s).trim(); return s?s.slice(0,n||200):null; };
const iso=d=>new Date(Date.now()-d*864e5).toISOString();

exports.handler=async(event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"method not allowed"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b={}; try{ b=JSON.parse(event.body||"{}"); }catch{ return json(400,{error:"bad JSON"}); }
    const scope=await dealerScope(me, sbGet);
    const inScope=id=> scope.isAll || (scope.ids && scope.ids.has(String(id)));

    // Canonical dealer master + rep, shared by several actions.
    async function dealerMap(){
      const dealers=await sbGetAll("dealers?select=id,business_name,city,state,hcps_account,parent_id,is_test");
      let dir=[]; try{ dir=await sbGet("dealer_directory?select=dealer_name,rep_name&limit=100000"); }catch(e){}
      const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
      const dn=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
      const repByNorm={}; for(const x of dir){ const k=dn(x.dealer_name); if(k&&x.rep_name&&!(k in repByNorm)) repByNorm[k]=x.rep_name; }
      const m={}; for(const d of dealers) m[d.id]={id:d.id,name:d.business_name||"",city:d.city||"",state:d.state||"",acct:d.hcps_account||"",parent_id:d.parent_id||null,is_test:!!d.is_test,rep:repByNorm[dn(d.business_name)]||""};
      return m;
    }
    // Dealers flagged is_test (sandbox/QA) — excluded from the real audience builders so test
    // activity can never land in a live campaign. The Golden Activity dashboard still shows them.
    async function testDealerIds(){ try{ const rows=await sbGet("dealers?is_test=eq.true&select=id"); return new Set((rows||[]).map(r=>String(r.id))); }catch(e){ return new Set(); } }
    // Create a static audience from a dealer-id list + seed members with each dealer's primary contact
    // email. Shared by build_audience (Product-Interest) and activation_audience. Excludes out-of-scope.
    async function buildStaticAudience(name, dealerIds, notes){
      const ids=[...new Set((dealerIds||[]).map(String).filter(Boolean))].filter(inScope);
      if(!ids.length) return {audience_id:null,count:0};
      let env="development"; try{ const P=require("./_platform.js"); env=(await P.getState()).mode; }catch(e){}
      let aud; try{ aud=await sbSend("POST","audiences",{name,type:"static",notes:notes||"Built from federation",env,created_by:me.email||me.name||"staff"},{Prefer:"return=representation"}); }
      catch(e){ if(/relation|does not exist|audiences/i.test(String(e.message||e))){ const err=new Error("tables_missing"); err.tables_missing=true; throw err; } throw e; }
      const audience_id=aud&&aud[0]&&aud[0].id; if(!audience_id) throw new Error("audience not created");
      const dm=await dealerMap();
      let contacts=[]; try{ contacts=await sbGet(`dealer_contacts?dealer_id=in.(${ids.slice(0,300).join(",")})&select=dealer_id,email,name`); }catch(e){}
      const emailBy={}; for(const c of (contacts||[])){ if(!emailBy[c.dealer_id]&&c.email) emailBy[c.dealer_id]={email:c.email,name:c.name||""}; }
      const rows=ids.map(id=>{ const d=dm[id]||{}; const c=emailBy[id]||{}; return {audience_id,dealer_id:id,company:d.name||"",contact_name:c.name||"",contact_email:c.email||""}; });
      for(let i=0;i<rows.length;i+=500){ try{ await sbSend("POST","audience_members",rows.slice(i,i+500),{Prefer:"return=minimal"}); }catch(e){} }
      return {audience_id,count:rows.length};
    }

    // ---------- Golden Activity dashboard ----------
    if(b.action==="dashboard"){
      const since=iso(30);
      const [ev, orders, fed, unmatched, mfrs] = await Promise.all([
        sbGetAll(`intent_events?source=eq.golden&occurred_at=gte.${encodeURIComponent(since)}&select=dealer_id,event_type,manufacturer,product_code,meta,occurred_at`,"id"),
        sbGetAll(`federation_orders?occurred_at=gte.${encodeURIComponent(since)}&select=dealer_id,manufacturer,external_order_id,order_total,line_count,status,occurred_at`,"event_id"),
        sbGetAll(`federation_events?source_system=eq.golden&received_at=gte.${encodeURIComponent(since)}&select=event,status,dealer_id,customer_no,occurred_at`,"event_id"),
        sbGet("federation_unmatched?resolved_dealer_id=is.null&select=customer_no,dealer_name,event,occurred_at&order=created_at.desc&limit=50").catch(()=>[]),
        sbGet("manufacturers?select=slug,name").catch(()=>[]),
      ]);
      const dm=await dealerMap(); const mfrName={}; (mfrs||[]).forEach(m=>mfrName[m.slug]=m.name||m.slug);
      const keep=r=> r.dealer_id && inScope(r.dealer_id);
      const evS=ev.filter(keep), ordS=orders.filter(keep);
      let views=0,searches=0,cartAdds=0,abandoned=0,clicks=0;
      const prod={};
      for(const e of evS){ const t=e.event_type;
        if(t==="product_view"||t==="product_view_repeat") views++;
        else if(t==="product_clicked") clicks++;
        else if(t==="cart_add") cartAdds++;
        else if(t==="cart_abandoned") abandoned++;
        if(e.meta&&e.meta.query) searches++;
        if((VIEW_TYPES.has(t)||t==="cart_add") && e.product_code){ const k=e.product_code; const p=prod[k]=prod[k]||{code:e.product_code,line:mfrName[e.manufacturer]||e.manufacturer||"",views:0,dealers:new Set(),last:e.occurred_at}; p.views++; p.dealers.add(e.dealer_id); if(e.occurred_at>p.last)p.last=e.occurred_at; } }
      const logins=fed.filter(r=>r.event==="dealer.login" && r.status==="processed" && (scope.isAll|| (r.dealer_id&&inScope(r.dealer_id))));
      const topProducts=Object.values(prod).map(p=>({code:p.code,line:p.line,views:p.views,dealers:p.dealers.size,last:p.last})).sort((a,b)=>b.views-a.views).slice(0,15);
      const orderVal=ordS.reduce((a,r)=>a+(Number(r.order_total)||0),0);
      const recentOrders=ordS.sort((a,b)=>String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0,15).map(r=>({dealer:(dm[r.dealer_id]||{}).name||"",total:Number(r.order_total)||0,lines:r.line_count,status:r.status,at:r.occurred_at}));
      const recentLogins=logins.sort((a,b)=>String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0,15).map(r=>({dealer:(dm[r.dealer_id]||{}).name||"",acct:r.customer_no,at:r.occurred_at}));
      const abandonedList=evS.filter(e=>e.event_type==="cart_abandoned").sort((a,b)=>String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0,15).map(e=>({dealer:(dm[e.dealer_id]||{}).name||"",value:(e.meta&&e.meta.cart_value)||null,at:e.occurred_at}));
      return json(200,{ok:true,
        kpis:{logins:logins.length,product_views:views,clicks,searches,cart_adds:cartAdds,carts_abandoned:abandoned,orders:ordS.length,order_value:Math.round(orderVal),unmatched:scope.isAll?(unmatched||[]).length:0},
        top_products:topProducts, recent_orders:recentOrders, recent_logins:recentLogins, abandoned_carts:abandonedList,
        unmatched: scope.isAll ? (unmatched||[]).slice(0,25) : [],
        rep_scoped: !scope.isAll });
    }

    // ---------- Products/lines with intent (audience-builder picker) ----------
    if(b.action==="products"){
      const since=iso(Number(b.window_days)||90);
      const ev=await sbGetAll(`intent_events?occurred_at=gte.${encodeURIComponent(since)}&select=dealer_id,event_type,manufacturer,product_code`,"id").catch(()=>[]);
      const mfrs=await sbGet("manufacturers?select=slug,name").catch(()=>[]); const mfrName={}; (mfrs||[]).forEach(m=>mfrName[m.slug]=m.name||m.slug);
      const testIds=await testDealerIds();
      const prod={}, line={};
      for(const e of ev){ if(!e.dealer_id||!inScope(e.dealer_id)||testIds.has(String(e.dealer_id))) continue; const t=e.event_type; if(!(VIEW_TYPES.has(t)||CART_TYPES.has(t))) continue;
        if(e.manufacturer){ const L=line[e.manufacturer]=line[e.manufacturer]||{manufacturer:e.manufacturer,name:mfrName[e.manufacturer]||e.manufacturer,signals:0,dealers:new Set()}; L.signals++; L.dealers.add(e.dealer_id); }
        if(e.product_code){ const k=(e.manufacturer||"")+"|"+e.product_code; const P=prod[k]=prod[k]||{product:e.product_code,manufacturer:e.manufacturer||"",line:mfrName[e.manufacturer]||e.manufacturer||"",signals:0,dealers:new Set()}; P.signals++; P.dealers.add(e.dealer_id); } }
      return json(200,{ok:true,
        lines:Object.values(line).map(L=>({manufacturer:L.manufacturer,name:L.name,signals:L.signals,dealers:L.dealers.size})).sort((a,b)=>b.dealers-a.dealers),
        products:Object.values(prod).map(P=>({product:P.product,manufacturer:P.manufacturer,line:P.line,signals:P.signals,dealers:P.dealers.size})).sort((a,b)=>b.dealers-a.dealers).slice(0,400)});
    }

    // ---------- Dealers showing intent who haven't ordered ----------
    if(b.action==="product_interest"){
      const product=clip(b.product,60), manufacturer=clip(b.manufacturer,60);
      if(!product && !manufacturer) return json(400,{error:"product or manufacturer required"});
      const windowDays=Number(b.window_days)||30; const since=iso(windowDays);
      const sig=b.signals||{views:true,searches:true,carts:true};
      // intent for the product/line in the window
      let q=`intent_events?occurred_at=gte.${encodeURIComponent(since)}&select=dealer_id,event_type,manufacturer,product_code,meta,occurred_at`;
      if(product) q+=`&product_code=eq.${encodeURIComponent(product)}`;
      else q+=`&manufacturer=eq.${encodeURIComponent(manufacturer)}`;
      const ev=await sbGetAll(q,"id").catch(()=>[]);
      const testIds=await testDealerIds();
      const per={};
      for(const e of ev){ if(!e.dealer_id||!inScope(e.dealer_id)||testIds.has(String(e.dealer_id))) continue; const t=e.event_type;
        const isView=VIEW_TYPES.has(t), isCart=CART_TYPES.has(t), isSearch=!!(e.meta&&e.meta.query);
        if(!( (sig.views&&isView) || (sig.carts&&isCart) || (sig.searches&&isSearch) )) continue;
        const o=per[e.dealer_id]=per[e.dealer_id]||{dealer_id:e.dealer_id,views:0,carts:0,searches:0,last:e.occurred_at};
        if(isView)o.views++; if(isCart)o.carts++; if(isSearch)o.searches++; if(e.occurred_at>o.last)o.last=e.occurred_at; }
      const dealerIds=Object.keys(per);
      if(!dealerIds.length) return json(200,{ok:true,dealers:[],excluded_buyers:0});
      // exclude dealers who already ordered: by product_code (ever) or by manufacturer within 6 months
      const buyers=new Set();
      try{
        if(product){ const ms=await sbGetAll(`monthly_sales?product_code=eq.${encodeURIComponent(product)}&select=dealer_id`,"id"); ms.forEach(r=>r.dealer_id&&buyers.add(String(r.dealer_id))); }
        else { const since6=iso(183); const ms=await sbGetAll(`monthly_sales?manufacturer=eq.${encodeURIComponent(manufacturer)}&period=gte.${since6.slice(0,10)}&select=dealer_id`,"id"); ms.forEach(r=>r.dealer_id&&buyers.add(String(r.dealer_id))); }
      }catch(e){}
      const dm=await dealerMap();
      const nameById={}; for(const id in dm) nameById[id]=dm[id];
      const out=dealerIds.filter(id=>!buyers.has(String(id))).map(id=>{ const o=per[id]; const d=nameById[id]||{}; return {dealer_id:id,name:d.name||"",city:d.city||"",state:d.state||"",rep:d.rep||"",views:o.views,carts:o.carts,searches:o.searches,intent:o.views+o.carts*2+o.searches,last:o.last}; })
        .sort((a,b)=>b.intent-a.intent || String(b.last).localeCompare(String(a.last)));
      return json(200,{ok:true,dealers:out,excluded_buyers:dealerIds.length-out.length,window_days:windowDays});
    }

    // ---------- Build a static audience from the selected dealers ----------
    if(b.action==="build_audience"){
      const ids=[...new Set((Array.isArray(b.dealer_ids)?b.dealer_ids:[]).map(String).filter(Boolean))].filter(inScope);
      if(!ids.length) return json(400,{error:"no dealers in scope to add"});
      const name=clip(b.name,120)||("Product interest — "+new Date().toISOString().slice(0,10));
      try{ const r=await buildStaticAudience(name, ids, clip(b.notes,500)||"Built from Product-Interest (federation)"); return json(200,{ok:true,audience_id:r.audience_id,count:r.count,name}); }
      catch(e){ if(e&&e.tables_missing) return json(200,{ok:false,error:"tables_missing",message:"Run supabase/audiences.sql first."}); return json(500,{error:String(e&&e.message||e)}); }
    }

    // ---------- Provision (or refresh) the sandbox test dealer (president) ----------
    // Creates ONE is_test dealer bound to the Golden test account so QA activity flows through
    // the whole pipeline (Golden Activity → Dealer 360 → campaigns) but is env-stamped test and
    // excluded from every live surface. Idempotent — re-running just refreshes the contact email.
    if(b.action==="provision_test_dealer"){
      if(me.role!=="president") return json(403,{error:"president only"});
      const acct=clip(b.account,60)||"111111";
      const email=clip(b.email,160)||"angelo@homecareproviderservices.us";
      const name=clip(b.name,120)||"TEST — Golden Sandbox";
      let dealer_id=null, created=false;
      try{ const ex=await sbGet(`dealers?hcps_account=eq.${encodeURIComponent(acct)}&is_test=eq.true&select=id&limit=1`); if(ex&&ex[0]) dealer_id=ex[0].id; }catch(e){}
      if(!dealer_id){
        try{ const ins=await sbSend("POST","dealers",{business_name:name,hcps_account:acct,email,contact_name:"Sandbox (Angelo)",city:"Batesville",state:"IN",is_test:true,active:true,status:null},{Prefer:"return=representation"});
          dealer_id=ins&&ins[0]&&ins[0].id; created=true; }
        catch(e){ return json(500,{error:"could not create test dealer: "+String(e.message||e)}); }
      } else {
        try{ await sbSend("PATCH",`dealers?id=eq.${dealer_id}`,{email,business_name:name},{Prefer:"return=minimal"}); }catch(e){}
      }
      if(!dealer_id) return json(500,{error:"test dealer not created"});
      // Contact row so campaign sends reach the test inbox (best-effort — dealer.email is also set).
      try{ await sbSend("POST","dealer_contacts",{dealer_id,name:"Sandbox (Angelo)",email},{Prefer:"return=minimal"}); }catch(e){}
      return json(200,{ok:true,dealer_id,account:acct,email,created,note:"Golden events on account "+acct+" now match this test dealer (env-stamped test)."});
    }

    // ---------- Re-resolve the unmatched queue (president) ----------
    // Historical events that arrived before an account was linked (or before a matching fix
    // deployed) sit in federation_unmatched. Re-run the SAME matcher the receiver uses; anything
    // that now maps to a dealer is fanned out into intent_events / dealer_activity and cleared
    // from the queue. Idempotent — resolved rows are skipped on the next run.
    if(b.action==="resolve_unmatched"){
      if(me.role!=="president") return json(403,{error:"president only"});
      const fed=require("./federation-events.js");
      const rows=await sbGet("federation_unmatched?resolved_dealer_id=is.null&select=id,customer_no,dealer_name,event,raw,occurred_at&order=created_at.asc&limit=1000").catch(()=>[]);
      let resolved=0, still=0, errors=0;
      for(const row of rows){
        const fenv=row.raw;
        if(!fenv||typeof fenv!=="object"){ still++; continue; }
        let res=null; try{ res=await fed.resolveDealer(fenv); }catch(e){ res=null; }
        if(res&&res.dealer_id){
          try{
            await fed.ingestResolved(fenv,res);
            const eid=fenv.event_id||fenv.idempotency_key;
            if(eid) await sbSend("PATCH",`federation_events?event_id=eq.${encodeURIComponent(String(eid))}`,{dealer_id:res.dealer_id,status:"processed"},{Prefer:"return=minimal"}).catch(()=>{});
            await sbSend("PATCH",`federation_unmatched?id=eq.${row.id}`,{resolved_dealer_id:res.dealer_id,resolved_at:new Date().toISOString()},{Prefer:"return=minimal"});
            resolved++;
          }catch(e){ errors++; }
        } else still++;
      }
      return json(200,{ok:true,scanned:rows.length,resolved,still_unmatched:still,errors});
    }

    // ---------- One-off cleanup of the PR505M / test rows (president) ----------
    if(b.action==="purge_test"){
      if(me.role!=="president") return json(403,{error:"president only"});
      let removed={};
      try{ await sbSend("DELETE","intent_events?product_code=eq.PR505M",null,{Prefer:"return=minimal"}); removed.intent="ok"; }catch(e){ removed.intent=String(e.message||e); }
      try{ await sbSend("DELETE","dealer_activity?subject=ilike.*PR505M*",null,{Prefer:"return=minimal"}); }catch(e){}
      try{ await sbSend("DELETE","dealer_activity?subject=ilike.*federation*test*",null,{Prefer:"return=minimal"}); removed.activity="ok"; }catch(e){ removed.activity=String(e.message||e); }
      try{ await sbSend("DELETE","federation_orders?event_id=like.gtest*",null,{Prefer:"return=minimal"}); }catch(e){}
      try{ await sbSend("DELETE","federation_events?event_id=like.gtest*",null,{Prefer:"return=minimal"}); }catch(e){}
      removed.pr505m="cleared";
      return json(200,{ok:true,removed});
    }

    // ---------- Compact dealer list for pickers (assign screen, etc.) ----------
    if(b.action==="dealer_options"){
      const dm=await dealerMap();
      const list=Object.values(dm).filter(d=>scope.isAll||inScope(d.id))
        .map(d=>({id:d.id,name:d.name,acct:d.acct,state:d.state}))
        .sort((a,b)=>String(a.name).localeCompare(String(b.name)));
      return json(200,{ok:true,dealers:list});
    }

    // ---------- Manually assign unmatched event(s) to a dealer (president) ----------
    // Handles the genuinely ambiguous cases the auto re-check can't. Caches the identity so future
    // events from that account resolve automatically, then replays the stored event(s) to the dealer.
    if(b.action==="assign_unmatched"){
      if(me.role!=="president") return json(403,{error:"president only"});
      const did=clip(b.dealer_id,60), cust=clip(b.customer_no,60), uid=clip(b.unmatched_id,60);
      if(!did||(!cust&&!uid)) return json(400,{error:"dealer_id and (customer_no or unmatched_id) required"});
      const dch=await sbGet(`dealers?id=eq.${encodeURIComponent(did)}&select=id,is_test`).catch(()=>[]);
      if(!dch||!dch[0]) return json(404,{error:"dealer not found"});
      const isTest=!!dch[0].is_test;
      const q = cust
        ? `federation_unmatched?resolved_dealer_id=is.null&customer_no=eq.${encodeURIComponent(cust)}&select=id,customer_no,external_dealer_id,raw&limit=500`
        : `federation_unmatched?id=eq.${encodeURIComponent(uid)}&select=id,customer_no,external_dealer_id,raw&limit=1`;
      const rows=await sbGet(q).catch(()=>[]);
      if(!rows.length) return json(404,{error:"no matching unmatched rows"});
      const fed=require("./federation-events.js");
      const f0=rows[0].raw||{}; const src=(f0.source&&f0.source.system)||"golden", ten=(f0.source&&f0.source.tenant_id)||"hcps";
      // Cache identity (find-or-update — partial unique index makes on_conflict unreliable).
      try{
        const cno=cust||rows[0].customer_no||null, ext=rows[0].external_dealer_id||null;
        let ex=[]; if(cno) ex=await sbGet(`partner_dealer_map?source_system=eq.${encodeURIComponent(src)}&tenant_id=eq.${encodeURIComponent(ten)}&customer_no=eq.${encodeURIComponent(cno)}&select=id&limit=1`).catch(()=>[]);
        if(ex&&ex[0]) await sbSend("PATCH",`partner_dealer_map?id=eq.${ex[0].id}`,{dealer_id:did,external_dealer_id:ext,confidence:"manual",updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
        else await sbSend("POST","partner_dealer_map",{source_system:src,tenant_id:ten,external_dealer_id:ext,customer_no:cno,dealer_id:did,confidence:"manual",updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
      }catch(e){}
      let assigned=0;
      for(const row of rows){
        const fenv=row.raw; if(!fenv||typeof fenv!=="object") continue;
        try{ await fed.ingestResolved(fenv,{dealer_id:did,is_test:isTest});
          const eid=fenv.event_id||fenv.idempotency_key;
          if(eid) await sbSend("PATCH",`federation_events?event_id=eq.${encodeURIComponent(String(eid))}`,{dealer_id:did,status:"processed"},{Prefer:"return=minimal"}).catch(()=>{});
          await sbSend("PATCH",`federation_unmatched?id=eq.${row.id}`,{resolved_dealer_id:did,resolved_at:new Date().toISOString()},{Prefer:"return=minimal"});
          assigned++;
        }catch(e){}
      }
      return json(200,{ok:true,assigned,dealer_id:did});
    }

    // ---------- "Never logged in" activation audience ----------
    // Golden-access dealers (golden_status Account/Prospect, or KY) who have never had a Golden login.
    // preview:true returns the list; otherwise builds a static audience for Campaign Studio.
    if(b.action==="activation_audience"){
      const gd=await sbGetAll("dealers?or=(golden_status.eq.Account,golden_status.eq.Prospect,state.eq.KY)&select=id,business_name,city,state,hcps_account,golden_status,golden_url,parent_id,is_test");
      const loginRows=await sbGetAll("intent_events?source=eq.golden&event_type=eq.login&select=dealer_id","id").catch(()=>[]);
      const loggedIn=new Set((loginRows||[]).map(r=>String(r.dealer_id)));
      const never=(gd||[]).filter(d=>!d.is_test && inScope(d.id) && !loggedIn.has(String(d.id)));
      const list=never.map(d=>({dealer_id:d.id,name:d.business_name||"",city:d.city||"",state:d.state||"",acct:d.hcps_account||"",golden_status:d.golden_status||"",has_portal:!!d.golden_url}));
      if(b.preview) return json(200,{ok:true,dealers:list,count:list.length});
      if(!list.length) return json(200,{ok:true,built:false,count:0,message:"No never-logged-in Golden dealers found."});
      const name=clip(b.name,120)||("Golden activation — never logged in ("+new Date().toISOString().slice(0,10)+")");
      try{ const r=await buildStaticAudience(name, list.map(d=>d.dealer_id), "Golden portal access, never logged in — activation campaign target."); return json(200,{ok:true,built:true,audience_id:r.audience_id,count:r.count,name}); }
      catch(e){ if(e&&e.tables_missing) return json(200,{ok:false,error:"tables_missing",message:"Run supabase/audiences.sql first."}); return json(500,{error:String(e&&e.message||e)}); }
    }

    // ---------- Dealer Activation & Engagement Score (composite, on-demand) ----------
    // Blends Golden login recency/frequency + product-interest (dealer_intent) + order cadence
    // (dealer_engagement). 0–100, tiered cold/warming/active/champion.
    if(b.action==="dealer_score"){
      const did=clip(b.dealer_id,60); if(!did) return json(400,{error:"dealer_id required"});
      if(!inScope(did)) return json(403,{error:"out of scope"});
      const now=Date.now();
      const logins=await sbGet(`intent_events?dealer_id=eq.${encodeURIComponent(did)}&source=eq.golden&event_type=eq.login&select=occurred_at&order=occurred_at.desc&limit=200`).catch(()=>[]);
      const loginCount90=(logins||[]).filter(l=>now-new Date(l.occurred_at).getTime()<=90*864e5).length;
      const lastLogin=(logins&&logins[0])?logins[0].occurred_at:null;
      const daysSinceLogin=lastLogin?Math.floor((now-new Date(lastLogin).getTime())/864e5):null;
      let intent=null; try{ const di=await sbGet(`dealer_intent?dealer_id=eq.${encodeURIComponent(did)}&select=score_total,tier,top_manufacturer,top_product&limit=1`); intent=di&&di[0]; }catch(e){}
      let eng=null; try{ const de=await sbGet(`dealer_engagement?dealer_id=eq.${encodeURIComponent(did)}&select=score,months_since,status&limit=1`); eng=de&&de[0]; }catch(e){}
      const recency = lastLogin==null?0:(daysSinceLogin<=7?100:daysSinceLogin<=30?80:daysSinceLogin<=60?55:daysSinceLogin<=90?30:10);
      const freq = Math.max(0,Math.min(100, loginCount90*20));           // 5+ logins in 90d = 100
      const login = Math.round(0.6*recency + 0.4*freq);
      const interest = Math.max(0,Math.min(100, Math.round((intent&&Number(intent.score_total)||0)*2))); // intent 50 → 100
      const cadence = Math.max(0,Math.min(100, Math.round(eng&&eng.score!=null?Number(eng.score):0)));
      const score = Math.round(0.35*login + 0.35*interest + 0.30*cadence);
      const tier = score>=75?"champion":score>=50?"active":score>=25?"warming":"cold";
      return json(200,{ok:true,score,tier,components:{login,interest,cadence},
        detail:{last_login:lastLogin,days_since_login:daysSinceLogin,logins_90d:loginCount90,intent_tier:(intent&&intent.tier)||null,order_status:(eng&&eng.status)||null}});
    }

    // ---------- Generate a signed one-click SSO deep-link into the dealer's Golden portal ----------
    // Staff-authenticated. Signs {slug,exp} with FEDERATION_SECRET (shared with Golden); the Golden
    // /sso endpoint verifies, mints a portal session, and lands the rep in the dealer's portal.
    if(b.action==="golden_sso_link"){
      const did=clip(b.dealer_id,60); if(!did) return json(400,{error:"dealer_id required"});
      if(!inScope(did)) return json(403,{error:"out of scope"});
      let slug=null;
      // 1. Identity cache (fast path when present).
      try{ const m=await sbGet(`partner_dealer_map?source_system=eq.golden&dealer_id=eq.${encodeURIComponent(did)}&external_dealer_id=not.is.null&select=external_dealer_id&limit=1`); if(m&&m[0]&&m[0].external_dealer_id) slug=m[0].external_dealer_id; }catch(e){}
      // 2. The federation audit trail always carries the Golden slug on processed events — reliable.
      if(!slug){ try{ const fe=await sbGet(`federation_events?source_system=eq.golden&dealer_id=eq.${encodeURIComponent(did)}&external_dealer_id=not.is.null&select=external_dealer_id&order=received_at.desc&limit=1`); if(fe&&fe[0]&&fe[0].external_dealer_id) slug=fe[0].external_dealer_id; }catch(e){} }
      // 3. Fall back to a golden_url on the dealer record.
      if(!slug){ try{ const d=await sbGet(`dealers?id=eq.${encodeURIComponent(did)}&select=golden_url`); const u=d&&d[0]&&d[0].golden_url; if(u){ const mm=String(u).match(/\/portal\/([^\/?#]+)/); slug=mm?mm[1]:(/^[a-z0-9][a-z0-9-]*$/i.test(String(u).trim())?String(u).trim():null); } }catch(e){} }
      if(!slug) return json(400,{error:"no_golden_slug",message:"No linked Golden portal for this dealer (no Golden slug on file)."});
      const secret=process.env.FEDERATION_SECRET||""; if(!secret) return json(500,{error:"FEDERATION_SECRET not set"});
      const crypto=require("crypto");
      const exp=Math.floor(Date.now()/1000)+120;   // 2-minute link
      const payload=Buffer.from(JSON.stringify({slug:String(slug),exp}),"utf8").toString("base64url");
      const sig=crypto.createHmac("sha256",secret).update(payload,"utf8").digest("hex");
      const base=String(process.env.GOLDEN_PORTAL_BASE||"https://goldenonlineordering.netlify.app").replace(/\/$/,"");
      return json(200,{ok:true,url:base+"/sso?t="+encodeURIComponent(payload+"."+sig),slug,expires_in:120});
    }

    // ---------- Recompute the Manufacturer Relationship matrix on demand (president) ----------
    // Runs the same job the nightly engine runs — refresh the line matrix, then the canonical
    // (dealer × manufacturer) status incl. 'restricted'. Lets you apply a restriction immediately.
    if(b.action==="recompute_relationships"){
      if(me.role!=="president") return json(403,{error:"president only"});
      // Re-layer the canonical (dealer × manufacturer) status from the nightly line matrix. Fast:
      // it reads dealer_line_status (maintained nightly), it does NOT rebuild it. Guard the table.
      try{ await sbGet("dealer_relationships?select=dealer_id&limit=1"); }
      catch(e){ if(/relation|does not exist|dealer_relationships/i.test(String(e&&e.message||e))) return json(200,{ok:false,error:"tables_missing",message:"Run supabase/relationships.sql first."}); }
      try{ const I=require("./_intent.js"); const rel=await I.computeRelationships(); return json(200,{ok:true,relationships:rel}); }
      catch(e){ return json(500,{error:String(e&&e.message||e)}); }
    }

    // ---------- Relationship summary + restricted list (staff) ----------
    if(b.action==="relationships_summary"){
      let rows=[]; try{ rows=await sbGetAll("dealer_relationships?select=dealer_id,manufacturer,status","dealer_id"); }catch(e){ if(/relation|does not exist|schema cache|dealer_relationships/i.test(String(e&&e.message||e))) return json(200,{ok:false,error:"tables_missing",message:"Run supabase/relationships.sql first."}); }
      const counts={active:0,prospect:0,dormant:0,restricted:0};
      const restricted=[];
      const dm=await dealerMap();
      for(const r of rows){ if(!inScope(r.dealer_id)) continue; if(counts[r.status]!=null) counts[r.status]++;
        if(r.status==="restricted") restricted.push({dealer_id:r.dealer_id,name:(dm[r.dealer_id]||{}).name||"",manufacturer:r.manufacturer}); }
      return json(200,{ok:true,counts,restricted:restricted.slice(0,200)});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

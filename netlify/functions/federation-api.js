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
//   POST { action:"purge_test" }                -> president-only: remove PR505M live-test rows
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
      const dealers=await sbGetAll("dealers?select=id,business_name,city,state,hcps_account,parent_id");
      let dir=[]; try{ dir=await sbGet("dealer_directory?select=dealer_name,rep_name&limit=100000"); }catch(e){}
      const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
      const dn=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
      const repByNorm={}; for(const x of dir){ const k=dn(x.dealer_name); if(k&&x.rep_name&&!(k in repByNorm)) repByNorm[k]=x.rep_name; }
      const m={}; for(const d of dealers) m[d.id]={id:d.id,name:d.business_name||"",city:d.city||"",state:d.state||"",acct:d.hcps_account||"",parent_id:d.parent_id||null,rep:repByNorm[dn(d.business_name)]||""};
      return m;
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
      const prod={}, line={};
      for(const e of ev){ if(!e.dealer_id||!inScope(e.dealer_id)) continue; const t=e.event_type; if(!(VIEW_TYPES.has(t)||CART_TYPES.has(t))) continue;
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
      const per={};
      for(const e of ev){ if(!e.dealer_id||!inScope(e.dealer_id)) continue; const t=e.event_type;
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
      let env="development"; try{ const P=require("./_platform.js"); env=(await P.getState()).mode; }catch(e){}
      let aud; try{ aud=await sbSend("POST","audiences",{name,type:"static",notes:clip(b.notes,500)||"Built from Product-Interest (federation)",env,created_by:me.email||me.name||"staff"},{Prefer:"return=representation"}); }
      catch(e){ if(/relation|does not exist|audiences/i.test(String(e.message||e))) return json(200,{ok:false,error:"tables_missing",message:"Run supabase/audiences.sql first."}); throw e; }
      const audience_id=aud&&aud[0]&&aud[0].id; if(!audience_id) return json(500,{error:"audience not created"});
      // members: dealer + its primary contact email (best-effort)
      const dm=await dealerMap();
      let contacts=[]; try{ contacts=await sbGet(`dealer_contacts?dealer_id=in.(${ids.slice(0,300).join(",")})&select=dealer_id,email,name`); }catch(e){}
      const emailBy={}; for(const c of (contacts||[])){ if(!emailBy[c.dealer_id]&&c.email) emailBy[c.dealer_id]={email:c.email,name:c.name||""}; }
      const rows=ids.map(id=>{ const d=dm[id]||{}; const c=emailBy[id]||{}; return {audience_id,dealer_id:id,company:d.name||"",contact_name:c.name||"",contact_email:c.email||""}; });
      for(let i=0;i<rows.length;i+=500){ try{ await sbSend("POST","audience_members",rows.slice(i,i+500),{Prefer:"return=minimal"}); }catch(e){} }
      return json(200,{ok:true,audience_id,count:rows.length,name});
    }

    // ---------- One-off cleanup of the PR505M live-test rows (president) ----------
    if(b.action==="purge_test"){
      if(me.role!=="president") return json(403,{error:"president only"});
      let removed={};
      try{ await sbSend("DELETE","intent_events?product_code=eq.PR505M",null,{Prefer:"return=minimal"}); removed.intent="ok"; }catch(e){ removed.intent=String(e.message||e); }
      try{ await sbSend("DELETE","dealer_activity?subject=ilike.*federation*test*",null,{Prefer:"return=minimal"}); removed.activity="ok"; }catch(e){ removed.activity=String(e.message||e); }
      try{ await sbSend("DELETE","federation_orders?event_id=like.gtest*",null,{Prefer:"return=minimal"}); }catch(e){}
      return json(200,{ok:true,removed});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

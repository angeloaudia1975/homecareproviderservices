// HCPS CRM API (Phase 2) — notes + tasks per dealer, stored in Supabase (system of record).
// Staff-authenticated (president or rep). Service-role for DB writes. No npm deps.
//
//   POST {action:"list", dealer_id}                  -> { notes:[...], tasks:[...] }
//   POST {action:"add_note", dealer_id, body}        -> { note }
//   POST {action:"add_task", dealer_id, title, detail?, due_date?, priority?, assigned_rep?} -> { task }
//   POST {action:"complete_task", id}                -> { ok }
//   POST {action:"reopen_task", id}                  -> { ok }
//   POST {action:"dismiss_task", id}                 -> { ok }
//   POST {action:"my_tasks", status?, scope?}        -> { tasks:[...] }  (open tasks across dealers)
//   All require a staff Bearer token.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||2000):null; };
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const median=a=>{ if(!a.length) return null; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const pmOf=p=>{ const s=String(p||"").slice(0,7); const[y,m]=s.split("-").map(Number); return (y*12+(m-1)); };
// Resolve dealer_id -> business_name for a set of ids (chunked to keep URLs short).
async function namesFor(ids){ const out={}; const u=[...new Set(ids.filter(Boolean))]; for(let i=0;i<u.length;i+=150){ const part=u.slice(i,i+150).map(encodeURIComponent).join(","); try{ const ds=await sbGet(`dealers?id=in.(${part})&select=id,business_name`); for(const d of ds) out[d.id]=d.business_name; }catch(e){} } return out; }

// ---- Re-engagement email (Resend) ----
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAIL_FROM=process.env.HCPS_MAIL_FROM||"HCPS Partner Portal <orders@homecareproviderservices.us>";
const ORDERING=process.env.ORDERING_BASE||"https://hcpsonlineordering.netlify.app";
const SITE_BASE=process.env.SITE_BASE||"https://homecareproviderservices.netlify.app";
const engine=require("./_engine");   // shared automation core (tasks + email queue + delivery)
const orgAccounts=require("./_accountorg.js")(sbGet,sbSend); // org-level manufacturer account numbers
const eesc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function sendMail({to,subject,html,text}){
  const key=process.env.RESEND_API_KEY; if(!key) return {ok:false,skipped:true};
  try{ const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({from:MAIL_FROM,to:[to],subject,html,text})}); return {ok:r.ok}; }
  catch(e){ return {ok:false}; }
}
function reengageHtml(dealer,unsub){
  const hi=dealer?(", "+eesc(dealer)):"";
  return `<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
    <h2 style="color:#2B4071;margin:0 0 6px">We've missed you${hi}</h2>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 12px">It's been a little while since your last order with HomeCare Provider Services. Your account is active and ready — browse your manufacturer lines, see your pricing, and reorder in a couple of clicks, 24/7.</p>
    <a href="${ORDERING}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;font-size:14px">Sign in &amp; reorder →</a>
    <p style="font-size:12.5px;line-height:1.6;color:#6b7280;margin:16px 0 0">Questions, or want a hand with a reorder? Reply to this email or reach your HCPS rep — glad to help.</p>
    <p style="font-size:12px;color:#9aa4ae;margin:14px 0 0">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.<br><a href="${unsub}" style="color:#9aa4ae">Unsubscribe from these emails</a></p></div>`;
}

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:""};
  return null;
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    // Tables present? (friendly message if the migration hasn't run yet.)
    try{ await sbGet("dealer_tasks?select=id&limit=1"); }
    catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/crm.sql in Supabase, then reload."}); }

    if(b.action==="list"){
      if(!b.dealer_id) return json(400,{error:"dealer_id required"});
      const did=encodeURIComponent(b.dealer_id);
      const [notes,tasks,activity,crosssell,health,opportunities]=await Promise.all([
        sbGet(`dealer_notes?dealer_id=eq.${did}&select=*&order=created_at.desc&limit=200`).catch(()=>[]),
        sbGet(`dealer_tasks?dealer_id=eq.${did}&select=*&order=status.asc,due_date.asc.nullslast,created_at.desc&limit=200`).catch(()=>[]),
        sbGet(`dealer_activity?dealer_id=eq.${did}&select=*&order=created_at.desc&limit=50`).catch(()=>[]),
        sbGet(`cross_sell?dealer_id=eq.${did}&select=rank,rec_name,basis_name,score,support&order=rank.asc&limit=3`).catch(()=>[]),
        sbGet(`dealer_engagement?dealer_id=eq.${did}&select=status,score,trend,churn_score,months_since,last_period,recent_sales,total_sales,lines`).catch(()=>[]),
        sbGet(`opportunities?dealer_id=eq.${did}&status=eq.open&select=id,title,line,stage,value,probability,expected_close,owner_rep&order=value.desc`).catch(()=>[]),
      ]);
      return json(200,{ok:true,notes:notes||[],tasks:tasks||[],activity:activity||[],crosssell:crosssell||[],health:(health&&health[0])||null,opportunities:opportunities||[]});
    }

    // Unified per-dealer digital-activity intelligence: email engagement, ordering-portal
    // logins, product/line interest (incl. lines they DON'T buy but are researching),
    // carts, orders — the "what are they interested in right now" picture.
    if(b.action==="intel"){
      if(!b.dealer_id) return json(400,{error:"dealer_id required"});
      const did=encodeURIComponent(b.dealer_id);
      const d30=new Date(Date.now()-30*864e5).toISOString(), d90=new Date(Date.now()-90*864e5).toISOString();
      const [events,intentRows,lines,sends,sessions,orders,carts,mfrs,salesRows]=await Promise.all([
        sbGet(`intent_events?dealer_id=eq.${did}&occurred_at=gte.${encodeURIComponent(d90)}&select=event_type,manufacturer,product_code,meta,occurred_at&order=occurred_at.desc&limit=800`).catch(()=>[]),
        sbGet(`dealer_intent?dealer_id=eq.${did}&select=score_total,tier,by_manufacturer,top_manufacturer,top_product,last_event_at`).catch(()=>[]),
        sbGet(`dealer_line_status?dealer_id=eq.${did}&select=manufacturer,relationship,months_since`).catch(()=>[]),
        sbGet(`email_sends?dealer_id=eq.${did}&select=template,sent_at&order=sent_at.desc&limit=100`).catch(()=>[]),
        sbGet(`dealer_sessions?dealer_id=eq.${did}&select=last_seen_at&order=last_seen_at.desc&limit=200`).catch(()=>[]),
        sbGet(`orders?dealer_id=eq.${did}&select=manufacturer,status,subtotal,submitted_at&order=submitted_at.desc&limit=15`).catch(()=>[]),
        sbGet(`dealer_carts?dealer_id=eq.${did}&select=cart,updated_at`).catch(()=>[]),
        sbGet("manufacturers?select=slug,name").catch(()=>[]),
        sbGet(`monthly_sales?dealer_id=eq.${did}&select=manufacturer,line_type,amount,commission,commission_rate,billed_amount,invoice_no,order_date,memo&limit=8000`).catch(()=>[]),
      ]);
      const mfrName={}; (mfrs||[]).forEach(m=>mfrName[m.slug]=m.name||m.slug);
      const rel={}; (lines||[]).forEach(l=>rel[l.manufacturer]=l.relationship);
      const d30ms=Date.now()-30*864e5;
      const evByMfr={}, prodViews={}; let opens=0,clicks=0,opens30=0,clicks30=0;
      for(const e of (events||[])){ const t=e.event_type, mfr=e.manufacturer, ts=new Date(e.occurred_at).getTime();
        if(t==="email_open"){ opens++; if(ts>=d30ms)opens30++; continue; }
        if(t==="email_click"){ clicks++; if(ts>=d30ms)clicks30++; continue; }
        if(mfr){ const g=evByMfr[mfr]=evByMfr[mfr]||{views:0,pricing:0,order:0};
          if(t==="product_view"||t==="product_view_repeat") g.views++;
          else if(t==="pricing_view") g.pricing++;
          else if(t==="order_page"||t==="order_started") g.order++; }
        if((t==="product_view"||t==="product_view_repeat"||t==="pricing_view") && e.product_code){
          const k=(mfr||"")+"|"+e.product_code; const p=prodViews[k]=prodViews[k]||{code:e.product_code,manufacturer:mfrName[mfr]||mfr||"",count:0,last:e.occurred_at};
          p.count++; if(e.occurred_at>p.last)p.last=e.occurred_at; } }
      const byM=(intentRows&&intentRows[0]&&intentRows[0].by_manufacturer)||{};
      const mfrSet=new Set([...Object.keys(evByMfr),...Object.keys(byM)]);
      const interest=[...mfrSet].map(slug=>{ const g=evByMfr[slug]||{views:0,pricing:0,order:0}; const sc=Number(byM[slug])||0; const r=rel[slug]||"none";
        return {slug,name:mfrName[slug]||slug,relationship:r,views:g.views,pricing:g.pricing,order_activity:g.order,intent:Math.round(sc),
          emerging:(r!=="active") && (g.views>0||g.pricing>0||g.order>0||sc>0)}; })
        .sort((a,b)=>(b.emerging?1:0)-(a.emerging?1:0) || (b.pricing*3+b.views+b.intent)-(a.pricing*3+a.views+a.intent));
      const sess=sessions||[]; const logins30=sess.filter(s=>new Date(s.last_seen_at).getTime()>=d30ms).length;
      const cartList=(carts||[]).map(c=>{ const items=(c.cart&&c.cart.items)||[]; let n=0,val=0; for(const it of items){const q=Number(it.qty)||0;n+=q;val+=(Number(it.p&&it.p.base_price)||0)*q;}
        return {items:n,value:Math.round(val),updated_at:c.updated_at,mfr:mfrName[(c.cart&&c.cart.mfr)]||((c.cart&&c.cart.mfr)||"")}; }).filter(c=>c.items>0);
      const topProducts=Object.values(prodViews).sort((a,b)=>b.count-a.count).slice(0,8);
      // Commission ledger — paid (realized) vs outstanding (invoiced, awaiting payment). Outstanding
      // comes from Access4u invoice rows whose R-##### has no matching payment; est. pending commission
      // applies the dealer's own paid rate to that backlog.
      const ms=salesRows||[]; let paidComm=0, realized=0, rateSum=0, rateN=0; const paidRefs=new Set();
      for(const r of ms){ if(r.commission!=null) paidComm+=Number(r.commission)||0; if(r.amount!=null) realized+=Number(r.amount)||0;
        if(String(r.line_type||"").toLowerCase()==="payment"){ if(r.invoice_no) paidRefs.add(String(r.invoice_no).toUpperCase()); if(r.commission_rate!=null){ rateSum+=Number(r.commission_rate)||0; rateN++; } } }
      const openInv=ms.filter(r=>String(r.line_type||"").toLowerCase()==="invoice" && !(r.invoice_no && paidRefs.has(String(r.invoice_no).toUpperCase())));
      const outstanding=openInv.reduce((a,r)=>a+(Number(r.billed_amount)||0),0);
      const estRate=rateN?(rateSum/rateN):0.05;
      const openList=openInv.slice().sort((a,b)=>(Number(b.billed_amount)||0)-(Number(a.billed_amount)||0)).slice(0,12)
        .map(r=>({invoice_no:r.invoice_no,billed:Math.round((Number(r.billed_amount)||0)*100)/100,date:r.order_date,memo:r.memo,manufacturer:mfrName[r.manufacturer]||r.manufacturer}));
      const commission={ paid:Math.round(paidComm*100)/100, realized_sales:Math.round(realized*100)/100,
        outstanding_sales:Math.round(outstanding*100)/100, open_invoices:openInv.length,
        est_rate:Math.round(estRate*10000)/10000, est_pending:Math.round(outstanding*estRate*100)/100, open_list:openList };
      return json(200,{ok:true,intel:{ commission,
        email:{opens,clicks,opens_30d:opens30,clicks_30d:clicks30,sent:(sends||[]).length,last_sent:(sends&&sends[0]&&sends[0].sent_at)||null},
        logins:{count:sess.length,count_30d:logins30,last_login:(sess[0]&&sess[0].last_seen_at)||null,lines_browsed:[...new Set(Object.keys(evByMfr))].map(s=>mfrName[s]||s)},
        interest, products_viewed:topProducts, carts:cartList, orders:orders||[],
        intent:{score:Math.round((intentRows&&intentRows[0]&&intentRows[0].score_total)||0),tier:(intentRows&&intentRows[0]&&intentRows[0].tier)||"normal",
          top_manufacturer:mfrName[(intentRows&&intentRows[0]&&intentRows[0].top_manufacturer)]||null,top_product:(intentRows&&intentRows[0]&&intentRows[0].top_product)||null}
      }});
    }

    // Deep sales drill-down for Dealer 360 — combined monthly $ plus, per manufacturer:
    // monthly $/qty, the actual products ordered, quantities, order count, AOV, buying
    // cadence, top products, and a recent-vs-prior trend. All computed from monthly_sales.
    if(b.action==="sales"){
      if(!b.dealer_id) return json(400,{error:"dealer_id required"});
      const did=encodeURIComponent(b.dealer_id);
      const [rows,mfrs]=await Promise.all([
        sbGetAll(`monthly_sales?dealer_id=eq.${did}&select=manufacturer,period,product_code,product_name,qty,amount,commission,invoice_no`,"period").catch(()=>[]),
        sbGet("manufacturers?select=slug,name").catch(()=>[]),
      ]);
      const mfrName={}; for(const m of (mfrs||[])) mfrName[m.slug]=m.name||m.slug;
      const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const pmOf=p=>{ const s=String(p||"").slice(0,7); const a=s.split("-"); const y=Number(a[0]),mo=Number(a[1]); return (y&&mo)?y*12+(mo-1):null; };
      const pmLabel=pm=>MON[((pm%12)+12)%12]+" "+String(Math.floor(pm/12)).slice(2);
      const combined=new Map(); const byMfr=new Map(); let minPm=Infinity,maxPm=-Infinity;
      for(const r of (rows||[])){
        const pm=pmOf(r.period); if(pm==null) continue;
        const amt=Number(r.amount)||0, qty=Number(r.qty)||0, comm=Number(r.commission)||0;
        if(pm<minPm)minPm=pm; if(pm>maxPm)maxPm=pm;
        combined.set(pm,(combined.get(pm)||0)+amt);
        const slug=r.manufacturer||"(unknown)";
        let M=byMfr.get(slug); if(!M){ M={months:new Map(),products:new Map(),total:0,comm:0,qty:0,orders:new Set(),pms:new Set()}; byMfr.set(slug,M); }
        M.total+=amt; M.comm+=comm; M.qty+=qty; M.pms.add(pm); if(r.invoice_no) M.orders.add(String(r.invoice_no));
        const mm=M.months.get(pm)||{amount:0,qty:0}; mm.amount+=amt; mm.qty+=qty; M.months.set(pm,mm);
        const pname=String(r.product_name||r.product_code||"").trim();
        if(pname){ const key=String(r.product_code||pname).trim().toLowerCase();
          const P=M.products.get(key)||{name:pname,sku:(r.product_code&&String(r.product_code)!==pname)?r.product_code:"",qty:0,amount:0,orders:new Set(),last:null};
          P.qty+=qty; P.amount+=amt; if(r.invoice_no)P.orders.add(String(r.invoice_no)); if(P.last==null||pm>P.last)P.last=pm;
          M.products.set(key,P);
        }
      }
      const combinedSeries=[]; if(isFinite(minPm)){ for(let pm=minPm;pm<=maxPm;pm++) combinedSeries.push({pm,label:pmLabel(pm),amount:Math.round((combined.get(pm)||0)*100)/100}); }
      const manufacturers=[...byMfr.entries()].map(([slug,M])=>{
        const pms=[...M.pms].sort((a,b)=>a-b);
        const months=[]; for(let pm=pms[0];pm<=pms[pms.length-1];pm++){ const mm=M.months.get(pm); months.push({pm,label:pmLabel(pm),amount:Math.round(((mm&&mm.amount)||0)*100)/100,qty:(mm&&mm.qty)||0}); }
        const orders=M.orders.size||pms.length;
        const aov=orders?Math.round((M.total/orders)*100)/100:0;
        const spanMo=pms.length?(pms[pms.length-1]-pms[0]+1):0;
        const cadence=(orders>1&&spanMo>1)?Math.round((spanMo/orders)*10)/10:null;
        const active=pms.map(pm=>((M.months.get(pm)||{amount:0}).amount));
        const recent=active.slice(-3).reduce((s,x)=>s+x,0), prior=active.slice(-6,-3).reduce((s,x)=>s+x,0);
        const pct=prior>0?Math.round(((recent-prior)/prior)*100):(recent>0?null:0);
        const trend={recent:Math.round(recent*100)/100,prior:Math.round(prior*100)/100,pct,dir:pct==null?"flat":(pct>5?"up":pct<-5?"down":"flat")};
        const products=[...M.products.values()].map(p=>({name:p.name,sku:p.sku,qty:p.qty,amount:Math.round(p.amount*100)/100,orders:p.orders.size,last:p.last!=null?pmLabel(p.last):null})).sort((a,b)=>b.amount-a.amount);
        return { slug, name:mfrName[slug]||slug, total:Math.round(M.total*100)/100, commission:Math.round(M.comm*100)/100,
          qty:M.qty, orders, aov, months_active:pms.length, cadence, first:pms.length?pmLabel(pms[0]):null, last:pms.length?pmLabel(pms[pms.length-1]):null,
          months, products, trend };
      }).sort((a,b)=>b.total-a.total);
      const grand=Math.round([...combined.values()].reduce((s,x)=>s+x,0)*100)/100;
      return json(200,{ok:true, sales:{ currency:"USD", total:grand, combined:combinedSeries, manufacturers, has_products:manufacturers.some(m=>m.products.length>0) }});
    }

    // Lightweight open-task count for the masthead badge (the caller's own, rep-scoped).
    if(b.action==="task_count"){
      if(me.role==="president"){
        try{ const r=await fetch(`${SUPABASE_URL}/rest/v1/dealer_tasks?status=eq.open&select=id`,{headers:{...H(),Prefer:"count=exact",Range:"0-0"}}); const cr=r.headers.get("content-range")||""; const n=cr.includes("/")?parseInt(cr.split("/")[1],10):0; return json(200,{ok:true,count:Number.isFinite(n)?n:0}); }
        catch(e){ return json(200,{ok:true,count:0}); }
      }
      const rn=(me.rep_name||"").toLowerCase();
      const rows=await sbGet(`dealer_tasks?status=eq.open&select=assigned_rep`).catch(()=>[]);
      const n=(rows||[]).filter(t=>String(t.assigned_rep||"").toLowerCase()===rn).length;
      return json(200,{ok:true,count:n});
    }

    if(b.action==="add_note"){
      if(!b.dealer_id||!clean(b.body)) return json(400,{error:"dealer_id + body required"});
      const row={dealer_id:b.dealer_id,author_email:me.email||null,author_name:me.name||null,body:clean(b.body,4000)};
      const ins=await sbSend("POST","dealer_notes",row,{Prefer:"return=representation"});
      return json(200,{ok:true,note:(ins&&ins[0])||row});
    }

    // ---- Contacts + manufacturer account numbers (managed right from Dealer 360) ----
    // dealer_contacts is keyed by (dealer_id, email); "primary" is the dealers.email convention.
    if(b.action==="contacts"){
      if(!b.dealer_id) return json(400,{error:"dealer_id required"});
      const did=encodeURIComponent(b.dealer_id);
      const [contacts,dealer,lines,mfrs]=await Promise.all([
        sbGet(`dealer_contacts?dealer_id=eq.${did}&select=email,name,title,role,phone,cell&order=name`).catch(()=>[]),
        sbGet(`dealers?id=eq.${did}&select=email,contact_name,phone`).catch(()=>[]),
        sbGet(`dealer_manufacturers?dealer_id=eq.${did}&select=manufacturer,account_ref,active`).catch(()=>[]),
        sbGet("manufacturers?select=slug,name").catch(()=>[]),
      ]);
      const mfrName={}; (mfrs||[]).forEach(m=>mfrName[m.slug]=m.name||m.slug);
      const accounts=(lines||[]).map(l=>({slug:l.manufacturer,name:mfrName[l.manufacturer]||l.manufacturer,account_ref:l.account_ref||"",active:l.active!==false}))
        .sort((a,b)=>a.name.localeCompare(b.name));
      return json(200,{ok:true,contacts:contacts||[],primary_email:String((dealer&&dealer[0]&&dealer[0].email)||"").toLowerCase(),accounts});
    }
    if(b.action==="save_contact"){
      const email=String(b.email||"").trim().toLowerCase();
      if(!b.dealer_id||!EMAIL_RE.test(email)) return json(400,{error:"dealer_id + a valid email are required"});
      const old=String(b.old_email||"").trim().toLowerCase();
      if(old && old!==email){ try{ await sbSend("DELETE",`dealer_contacts?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&email=eq.${encodeURIComponent(old)}`,null,{Prefer:"return=minimal"}); }catch(e){} }
      const row={dealer_id:b.dealer_id,email,name:clean(b.name,160),title:clean(b.title,120),role:clean(b.role,120),phone:clean(b.phone,60),cell:clean(b.cell,60)};
      await sbSend("POST","dealer_contacts?on_conflict=dealer_id,email",row,{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true});
    }
    if(b.action==="delete_contact"){
      if(!b.dealer_id||!b.email) return json(400,{error:"dealer_id + email required"});
      await sbSend("DELETE",`dealer_contacts?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&email=eq.${encodeURIComponent(String(b.email).toLowerCase())}`,null,{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }
    if(b.action==="set_primary_contact"){
      const email=String(b.email||"").trim().toLowerCase();
      if(!b.dealer_id||!EMAIL_RE.test(email)) return json(400,{error:"valid email required"});
      const patch={email}; const nm=clean(b.name,160), ph=clean(b.phone,60); if(nm)patch.contact_name=nm; if(ph)patch.phone=ph;
      await sbSend("PATCH",`dealers?id=eq.${encodeURIComponent(b.dealer_id)}`,patch,{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }
    if(b.action==="save_account_ref"){
      if(!b.dealer_id||!b.manufacturer) return json(400,{error:"dealer_id + manufacturer required"});
      // Account numbers are organization-level: set it here and fill it across the dealer's family
      // (parent + branches) wherever a branch has none yet — a branch with its own number is left alone.
      await orgAccounts.propagateAccountRef(String(b.manufacturer), b.dealer_id, clean(b.account_ref,60));
      return json(200,{ok:true});
    }

    // Log a real touch — call / visit / email / meeting / note — into the timeline,
    // optionally creating a follow-up task in the same step.
    if(b.action==="log_activity"){
      if(!b.dealer_id||!clean(b.summary)) return json(400,{error:"dealer_id + summary required"});
      const kind=["call","visit","email","meeting","note"].includes(b.kind)?b.kind:"note";
      const row={dealer_id:b.dealer_id,kind,subject:clean(b.summary,300),detail:clean(b.detail,4000)||null,
        contact_email:clean(b.contact_email,200)||null,actor:me.name||me.email||null,created_at:new Date().toISOString()};
      const ins=await sbSend("POST","dealer_activity",row,{Prefer:"return=representation"});
      let task=null;
      if(clean(b.followup_title)){
        const trow={dealer_id:b.dealer_id,title:clean(b.followup_title,200),detail:clean(b.followup_detail||b.summary,2000),
          due_date:/^\d{4}-\d{2}-\d{2}$/.test(String(b.followup_due||""))?b.followup_due:null,
          priority:["low","normal","high"].includes(b.followup_priority)?b.followup_priority:"normal",
          source:"manual",assigned_rep:me.rep_name||null,created_by:me.name||me.email||null,status:"open"};
        const ti=await sbSend("POST","dealer_tasks",trow,{Prefer:"return=representation"}); task=(ti&&ti[0])||trow;
      }
      return json(200,{ok:true,activity:(ins&&ins[0])||row,task});
    }

    if(b.action==="add_task"){
      if(!b.dealer_id||!clean(b.title)) return json(400,{error:"dealer_id + title required"});
      const pr=["low","normal","high"].includes(b.priority)?b.priority:"normal";
      const row={dealer_id:b.dealer_id,title:clean(b.title,200),detail:clean(b.detail,2000),
        due_date:/^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date||""))?b.due_date:null,
        priority:pr,source:"manual",assigned_rep:clean(b.assigned_rep,120)||me.rep_name||null,
        created_by:me.name||me.email||null,status:"open"};
      const ins=await sbSend("POST","dealer_tasks",row,{Prefer:"return=representation"});
      return json(200,{ok:true,task:(ins&&ins[0])||row});
    }

    if(b.action==="complete_task"||b.action==="reopen_task"||b.action==="dismiss_task"){
      if(!b.id) return json(400,{error:"id required"});
      const status=b.action==="complete_task"?"done":b.action==="dismiss_task"?"dismissed":"open";
      const patch={status,done_at:status==="open"?null:new Date().toISOString()};
      await sbSend("PATCH",`dealer_tasks?id=eq.${encodeURIComponent(b.id)}`,patch,{Prefer:"return=minimal"});
      return json(200,{ok:true,status});
    }

    // Open tasks across all dealers (for a future global worklist). Reps see their own.
    if(b.action==="my_tasks"){
      const status=["open","done","dismissed"].includes(b.status)?b.status:"open";
      let q=`dealer_tasks?status=eq.${status}&select=*&order=priority.desc,due_date.asc.nullslast,created_at.desc&limit=800`;
      let tasks=await sbGet(q).catch(()=>[]);
      if(me.role!=="president" && me.rep_name){ const rn=me.rep_name.toLowerCase(); tasks=(tasks||[]).filter(t=>String(t.assigned_rep||"").toLowerCase()===rn); }
      const names=await namesFor((tasks||[]).map(t=>t.dealer_id));
      tasks=(tasks||[]).map(t=>({...t,dealer_name:names[t.dealer_id]||""}));
      return json(200,{ok:true,tasks,role:me.role});
    }

    // Intelligent follow-up engine (President-only). Reads the same signals the Call List
    // shows — overdue reorder, dormant, buying intent, new — and creates/updates auto-tasks
    // (source='auto', one per dealer+reason). Re-running is idempotent: it creates only new
    // signals and dismisses auto-tasks whose signal no longer applies (e.g. the dealer reordered).
    if(b.action==="run_followups"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const out=await engine.runTasks();   // same signal logic the scheduled engine uses
      return json(200,out);
    }

    // Manual "run the engine now" (President) — decide tasks + queue eligible emails, and
    // deliver if we're inside a send window. Mirrors exactly what the hourly cron does.
    if(b.action==="run_engine_now"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const cfg=await engine.getConfig();
      let crosssell=null; try{ crosssell=await engine.computeCrossSell(); }catch(e){}
      let health=null; try{ health=await engine.recomputeEngagement(); }catch(e){}
      const sig=await engine.computeSignals();
      const tasks=await engine.runTasks(sig);
      const emails=await engine.enqueueEmails(sig,cfg);
      const w=engine.currentWindow(cfg);
      const delivery=w?await engine.drainQueue(cfg,w):{skipped:"no send window right now"};
      return json(200,{ok:true,window:w||null,crosssell,health,tasks,emails,delivery});
    }

    // Automation control panel data (President): current config + queue/send counters.
    if(b.action==="automation_status"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const cfg=await engine.getConfig();
      const cut7=new Date(Date.now()-7*864e5).toISOString();
      const [q,sent7,eng]=await Promise.all([
        sbGet("email_queue?status=eq.queued&select=id,template&limit=2000").catch(()=>[]),
        sbGet(`email_sends?sent_at=gte.${cut7}&select=id,template`).catch(()=>[]),
        sbGet("dealer_engagement?select=status").catch(()=>[]),
      ]);
      const byTmpl={}; for(const r of (q||[])) byTmpl[r.template]=(byTmpl[r.template]||0)+1;
      const byStatus={}; for(const r of (eng||[])) byStatus[r.status]=(byStatus[r.status]||0)+1;
      return json(200,{ok:true,config:cfg,queued:(q||[]).length,queued_by_template:byTmpl,sent_7d:(sent7||[]).length,engagement:byStatus});
    }

    // Recent queue + sends for the admin visibility list (President).
    if(b.action==="automation_recent"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const [queue,sends]=await Promise.all([
        sbGet("email_queue?select=*&order=enqueued_at.desc&limit=60").catch(()=>[]),
        sbGet("email_sends?select=*&order=sent_at.desc&limit=40").catch(()=>[]),
      ]);
      return json(200,{ok:true,queue,sends});
    }

    // Update tunable parameters (President). Merges a patch into automation_config so the
    // master switches (engine_enabled / email_enabled) and thresholds are set from the UI.
    if(b.action==="set_automation_config"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const patch=b.patch||{}; const allow=new Set(["engine_enabled","email_enabled","cap_per_7d","min_gap_hours","dormant_months","overdue_mult","overdue_min_gap_months","quiet_weekends","business_hours","timezone","windows","templates_enabled","queue_ttl_hours","exclude_manufacturers","exclude_dealers","reports_enabled","report_recipients"]);
      const cur=await engine.getConfig();
      const next={...cur}; for(const k of Object.keys(patch)){ if(allow.has(k)) next[k]=patch[k]; }
      await sbSend("POST","app_settings?on_conflict=key",{key:"automation_config",value:next,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true,config:next});
    }

    // Rep-triggered re-engagement email to a dealer's contact. Respects the opt-out list,
    // sends via Resend with an unsubscribe link, and logs the send to the activity timeline.
    if(b.action==="send_reengagement"){
      if(!b.dealer_id) return json(400,{error:"dealer_id required"});
      const did=encodeURIComponent(b.dealer_id);
      const drows=await sbGet(`dealers?id=eq.${did}&select=business_name,email`).catch(()=>[]); const d=drows&&drows[0];
      if(!d) return json(404,{error:"dealer not found"});
      let to=clean(b.contact_email,180)||d.email||null;
      if(!to){ const c=await sbGet(`dealer_contacts?dealer_id=eq.${did}&select=email&limit=1`).catch(()=>[]); to=(c&&c[0]&&c[0].email)||null; }
      to=String(to||"").trim(); if(!EMAIL_RE.test(to)) return json(200,{ok:false,message:"No valid contact email on file for this dealer."});
      const opt=await sbGet(`email_optout?email=eq.${encodeURIComponent(to.toLowerCase())}&select=email`).catch(()=>[]);
      if(opt&&opt[0]) return json(200,{ok:false,message:"That contact has unsubscribed from marketing emails."});
      const unsub=`${SITE_BASE}/.netlify/functions/unsubscribe?e=${encodeURIComponent(to)}&d=${encodeURIComponent(b.dealer_id)}`;
      const res=await sendMail({to,subject:"We've missed you at HomeCare Provider Services",html:reengageHtml(d.business_name,unsub),text:`We've missed you${d.business_name?", "+d.business_name:""}!\n\nIt's been a while since your last order with HomeCare Provider Services. Your account is active — sign in to browse your lines, see pricing, and reorder 24/7:\n${ORDERING}\n\nReply to this email or reach your HCPS rep for a hand.\n\nUnsubscribe: ${unsub}`});
      if(res.skipped) return json(200,{ok:false,message:"Email isn't configured yet (RESEND_API_KEY not set)."});
      if(!res.ok) return json(200,{ok:false,message:"The email failed to send — please try again."});
      try{ await sbSend("POST","dealer_activity",{dealer_id:b.dealer_id,kind:"campaign",subject:"Re-engagement email sent",contact_email:to,actor:me.name||"staff"},{Prefer:"return=minimal"}); }catch(e){}
      return json(200,{ok:true,to});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

// HCPS Command Center 360 — intelligence layer. President-only. Returns the analytics
// that go BEYOND the sales facts cube (which /analytics already ships): dealer
// growth/decline + dormant, engagement/activity, opportunities + follow-ups + cross-sell,
// rep rollups, and the branch-vs-dropship channel split. Server-side, service-role.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
const money=n=>Math.round((Number(n)||0)*100)/100;

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
// Robust trend sign from a value that may be a number ('12.4') or a word ('up'/'down').
function trendSign(t){ const n=Number(t); if(Number.isFinite(n)&&String(t).trim()!=="") return n>0.5?1:(n<-0.5?-1:0); const s=String(t||"").toLowerCase(); if(/up|grow|rising|\+/.test(s))return 1; if(/down|declin|falling|-/.test(s))return -1; return 0; }

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    if(me.role!=="president") return json(403,{error:"President only"});

    const d30=new Date(Date.now()-30*864e5).toISOString(), d90=new Date(Date.now()-90*864e5).toISOString();
    const [dealers,mfrs,eng,opps,tasks,xsell,ms,intent,evs,camps,sends,dm]=await Promise.all([
      sbGetAll("dealers?select=id,business_name,state,parent_id","id").catch(()=>[]),
      sbGet("manufacturers?select=slug,name").catch(()=>[]),
      sbGetAll("dealer_engagement?select=dealer_id,rep_name,status,score,churn_score,months_since,total_sales,recent_sales,trend","dealer_id").catch(()=>[]),
      sbGetAll("opportunities?status=eq.open&select=dealer_id,title,line,stage,value,expected_close,owner_rep","dealer_id").catch(()=>[]),
      sbGetAll("dealer_tasks?status=eq.open&select=id,dealer_id,title,reason,due_date,assigned_rep,source","dealer_id").catch(()=>[]),
      sbGetAll("cross_sell?select=dealer_id,rec_name,basis_name,score,rank","dealer_id").catch(()=>[]),
      sbGetAll("monthly_sales?select=manufacturer,channel,amount,product_code,product_name,qty,dealer_id,period","manufacturer").catch(()=>[]),
      sbGetAll("dealer_intent?select=dealer_id,score_total,tier,top_manufacturer","dealer_id").catch(()=>[]),
      sbGet(`intent_events?occurred_at=gte.${encodeURIComponent(d30)}&select=dealer_id,event_type,manufacturer&limit=20000`).catch(()=>[]),
      sbGet("marketing_campaigns?select=name,status,manufacturer,segment,results,updated_at&order=updated_at.desc.nullslast&limit=200").catch(()=>[]),
      sbGet(`email_sends?sent_at=gte.${encodeURIComponent(d90)}&select=template&limit=30000`).catch(()=>[]),
      sbGetAll("dealer_manufacturers?select=manufacturer,account_ref,dealer_id","dealer_id").catch(()=>[]),
    ]);
    const chan=ms;  // channel split reuses the monthly_sales scan below
    const nameOf={}, stateOf={}; for(const d of dealers){ nameOf[d.id]=d.business_name||""; stateOf[d.id]=d.state||""; }
    const mfrName={}; for(const m of (mfrs||[])) mfrName[m.slug]=m.name||m.slug;

    // ---- engagement: growth / decline / dormant ----
    const engRows=(eng||[]).map(e=>({ dealer_id:e.dealer_id, name:nameOf[e.dealer_id]||"(dealer)", state:stateOf[e.dealer_id]||"",
      rep:e.rep_name||"Unassigned", status:e.status||"", score:Number(e.score)||0, churn:Number(e.churn_score)||0,
      months_since:e.months_since==null?null:Number(e.months_since), recent:money(e.recent_sales), total:money(e.total_sales),
      sign:trendSign(e.trend) }));
    const buckets={growing:0,steady:0,declining:0,dormant:0};
    for(const r of engRows){ if(r.months_since!=null&&r.months_since>=3||/dorm/i.test(r.status)){ r.bucket="dormant"; buckets.dormant++; }
      else if(r.sign<0||/declin/i.test(r.status)){ r.bucket="declining"; buckets.declining++; }
      else if(r.sign>0||/grow/i.test(r.status)){ r.bucket="growing"; buckets.growing++; }
      else { r.bucket="steady"; buckets.steady++; } }
    const dormant=engRows.filter(r=>r.bucket==="dormant").sort((a,b)=>b.total-a.total).slice(0,60);
    const declining=engRows.filter(r=>r.bucket==="declining").sort((a,b)=>b.total-a.total).slice(0,60);
    const growing=engRows.filter(r=>r.bucket==="growing").sort((a,b)=>b.recent-a.recent).slice(0,60);

    // ---- opportunities ----
    const oppList=(opps||[]).map(o=>({dealer_id:o.dealer_id,name:nameOf[o.dealer_id]||"(dealer)",title:o.title||"",line:o.line||"",stage:o.stage||"",value:money(o.value),rep:o.owner_rep||"",close:o.expected_close||null}))
      .sort((a,b)=>b.value-a.value);
    const oppTotal=money(oppList.reduce((s,o)=>s+o.value,0));

    // ---- follow-ups (open tasks) + dormant alerts ----
    const taskTop=(tasks||[]).map(t=>({dealer_id:t.dealer_id,name:nameOf[t.dealer_id]||"(dealer)",title:t.title||"",reason:t.reason||"",due:t.due_date||null,rep:t.assigned_rep||"",source:t.source||""}))
      .sort((a,b)=>String(a.due||"9999").localeCompare(String(b.due||"9999"))).slice(0,60);

    // ---- cross-sell (best per dealer by rank/score) ----
    const bestX=new Map(); for(const x of (xsell||[])){ const cur=bestX.get(x.dealer_id); const rank=Number(x.rank)||99; if(!cur||rank<cur.rank) bestX.set(x.dealer_id,{rank,rec:x.rec_name,basis:x.basis_name,score:Number(x.score)||0}); }
    const crosssell=[...bestX.entries()].map(([id,x])=>({dealer_id:id,name:nameOf[id]||"(dealer)",rec:x.rec,basis:x.basis,score:x.score})).sort((a,b)=>b.score-a.score).slice(0,40);

    // ---- channel: branch (physical) vs drop-ship ----
    let physical=0,dropship=0; const chByMfr={};
    for(const r of (chan||[])){ const a=Number(r.amount)||0; const c=String(r.channel||"").toLowerCase(); const isDrop=/drop/.test(c);
      if(isDrop)dropship+=a; else physical+=a;
      const k=r.manufacturer||"(unknown)"; const o=chByMfr[k]||(chByMfr[k]={physical:0,dropship:0}); if(isDrop)o.dropship+=a; else o.physical+=a; }
    const channelByMfr=Object.entries(chByMfr).map(([slug,o])=>({slug,name:mfrName[slug]||slug,physical:money(o.physical),dropship:money(o.dropship)})).sort((a,b)=>(b.physical+b.dropship)-(a.physical+a.dropship)).slice(0,15);

    // ---- ordering/website activity (last 30d) ----
    const actDealers=new Set(), loginDealers=new Set(); const interest={};
    for(const e of (evs||[])){ if(e.dealer_id) actDealers.add(e.dealer_id); if(e.event_type==="login"&&e.dealer_id) loginDealers.add(e.dealer_id);
      if(e.manufacturer){ const k=e.manufacturer; const o=interest[k]||(interest[k]={events:0,dealers:new Set()}); o.events++; if(e.dealer_id)o.dealers.add(e.dealer_id); } }
    const topInterest=Object.entries(interest).map(([slug,o])=>({slug,name:mfrName[slug]||slug,events:o.events,dealers:o.dealers.size})).sort((a,b)=>b.events-a.events).slice(0,12);

    // ---- Phase 2: top products (+monthly trend + top dealers) ----
    const MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const pmOf=p=>{const s=String(p||"").slice(0,7);const a=s.split("-");return (Number(a[0])||0)*12+((Number(a[1])||1)-1);};
    const pmLabel=pm=>MON[((pm%12)+12)%12]+" "+String(Math.floor(pm/12)).slice(2);
    const prodMap=new Map();
    for(const r of (ms||[])){ const amt=Number(r.amount)||0; const nm=String(r.product_name||r.product_code||"").trim(); if(!nm) continue;
      const key=String(r.product_code||nm).trim().toLowerCase()+"|"+(r.manufacturer||"");
      let P=prodMap.get(key); if(!P){ P={name:nm,sku:r.product_code||"",mfr:mfrName[r.manufacturer]||r.manufacturer||"",qty:0,amount:0,dealers:new Set(),months:new Map(),byDealer:new Map()}; prodMap.set(key,P); }
      P.qty+=Number(r.qty)||0; P.amount+=amt; if(r.dealer_id)P.dealers.add(r.dealer_id);
      const pm=pmOf(r.period); if(pm){ P.months.set(pm,(P.months.get(pm)||0)+amt); }
      if(r.dealer_id) P.byDealer.set(r.dealer_id,(P.byDealer.get(r.dealer_id)||0)+amt);
    }
    const topProducts=[...prodMap.values()].sort((a,b)=>b.amount-a.amount).slice(0,40).map(P=>{
      const pms=[...P.months.keys()].sort((a,b)=>a-b); const months=pms.map(pm=>({label:pmLabel(pm),amount:money(P.months.get(pm))}));
      const topDealers=[...P.byDealer.entries()].map(([id,v])=>({name:nameOf[id]||"(dealer)",amount:money(v)})).sort((a,b)=>b.amount-a.amount).slice(0,6);
      return {name:P.name,sku:P.sku,mfr:P.mfr,qty:P.qty,amount:money(P.amount),dealers:P.dealers.size,months,topDealers};
    });

    // ---- Phase 2: marketing / email engagement ----
    let mkSent=0,mkOpens=0,mkClicks=0; const campList=(camps||[]).map(c=>{ const r=c.results||{}; const s=Number(r.sent)||0,o=Number(r.opens)||0,cl=Number(r.clicks)||0; mkSent+=s;mkOpens+=o;mkClicks+=cl;
      return {name:c.name||"(campaign)",status:c.status||"",manufacturer:c.manufacturer||"",sent:s,opens:o,clicks:cl,open_rate:s?Math.round(o/s*100):0,click_rate:s?Math.round(cl/s*100):0}; })
      .sort((a,b)=>b.sent-a.sent).slice(0,20);
    const sendVol={}; for(const e of (sends||[])){ const t=e.template||"other"; sendVol[t]=(sendVol[t]||0)+1; }

    // ---- Phase 2: manufacturer account coverage / penetration ----
    const totalDealers=dealers.length||1; const covMap={};
    for(const x of (dm||[])){ const k=x.manufacturer||"(unknown)"; const o=covMap[k]||(covMap[k]={withAcct:new Set(),lines:new Set()}); if(x.dealer_id){ o.lines.add(x.dealer_id); if(String(x.account_ref||"").trim()) o.withAcct.add(x.dealer_id); } }
    const coverage=Object.entries(covMap).map(([slug,o])=>({slug,name:mfrName[slug]||slug,dealers:o.lines.size,with_account:o.withAcct.size,penetration:Math.round(o.lines.size/totalDealers*100)})).sort((a,b)=>b.dealers-a.dealers).slice(0,20);

    return json(200,{ ok:true,
      dealers: dealers.map(d=>({id:d.id,name:d.business_name||"",state:d.state||"",parent_id:d.parent_id||null})),
      engagement:{ buckets, dormant, declining, growing, scored:engRows.length },
      opportunities:{ count:oppList.length, value:oppTotal, top:oppList.slice(0,40) },
      followups:{ open:(tasks||[]).length, top:taskTop },
      crosssell,
      channel:{ physical:money(physical), dropship:money(dropship), by_mfr:channelByMfr },
      activity:{ active_30d:actDealers.size, logins_30d:loginDealers.size, interest:topInterest },
      products:{ count:prodMap.size, top:topProducts },
      marketing:{ sent:mkSent, opens:mkOpens, clicks:mkClicks, open_rate:mkSent?Math.round(mkOpens/mkSent*100):0, click_rate:mkSent?Math.round(mkClicks/mkSent*100):0, campaigns:campList, send_volume:sendVol },
      coverage
    });
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

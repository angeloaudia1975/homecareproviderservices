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

    const d30=new Date(Date.now()-30*864e5).toISOString();
    const [dealers,mfrs,eng,opps,tasks,xsell,chan,intent,evs]=await Promise.all([
      sbGetAll("dealers?select=id,business_name,state,parent_id","id").catch(()=>[]),
      sbGet("manufacturers?select=slug,name").catch(()=>[]),
      sbGetAll("dealer_engagement?select=dealer_id,rep_name,status,score,churn_score,months_since,total_sales,recent_sales,trend","dealer_id").catch(()=>[]),
      sbGetAll("opportunities?status=eq.open&select=dealer_id,title,line,stage,value,expected_close,owner_rep","dealer_id").catch(()=>[]),
      sbGetAll("dealer_tasks?status=eq.open&select=id,dealer_id,title,reason,due_date,assigned_rep,source","dealer_id").catch(()=>[]),
      sbGetAll("cross_sell?select=dealer_id,rec_name,basis_name,score,rank","dealer_id").catch(()=>[]),
      sbGetAll("monthly_sales?select=manufacturer,channel,amount","manufacturer").catch(()=>[]),
      sbGetAll("dealer_intent?select=dealer_id,score_total,tier,top_manufacturer","dealer_id").catch(()=>[]),
      sbGet(`intent_events?occurred_at=gte.${encodeURIComponent(d30)}&select=dealer_id,event_type,manufacturer&limit=20000`).catch(()=>[]),
    ]);
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

    return json(200,{ ok:true,
      dealers: dealers.map(d=>({id:d.id,name:d.business_name||"",state:d.state||"",parent_id:d.parent_id||null})),
      engagement:{ buckets, dormant, declining, growing, scored:engRows.length },
      opportunities:{ count:oppList.length, value:oppTotal, top:oppList.slice(0,40) },
      followups:{ open:(tasks||[]).length, top:taskTop },
      crosssell,
      channel:{ physical:money(physical), dropship:money(dropship), by_mfr:channelByMfr },
      activity:{ active_30d:actDealers.size, logins_30d:loginDealers.size, interest:topInterest }
    });
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

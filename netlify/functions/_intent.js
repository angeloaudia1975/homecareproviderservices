// HCPS intent engine — PHASE 1 shared core.
//   * computeIntent()    — turn intent_events into a decayed per-dealer score
//                          (dealer_intent), with a per-manufacturer breakdown
//   * computeLineStatus()— derive the relationship matrix (dealer_line_status):
//                          active / dormant from sales, prospect from cross-sell
//   * syncIntentTasks()  — raise (and retire) "Call dealer" rep tasks for
//                          opportunity-tier dealers, source='intent' so it never
//                          collides with the sales-signal auto-tasks
// Everything is driven by the automation_config row (intent_* keys added by
// supabase/intent.sql). Reads/writes go through Supabase service-role REST,
// exactly like _engine.js. All functions are defensive: they never throw out.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }

// ---- helpers (mirrors _engine.js so behavior matches) -----------------------
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const median=a=>{ if(!a.length) return null; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const pmOf=p=>{ const s=String(p||"").slice(0,7); const[y,m]=s.split("-").map(Number); return (y*12+(m-1)); };
const pmToStr=pm=>{ if(pm==null)return null; const y=Math.floor(pm/12), m=(pm%12)+1; return `${y}-${String(m).padStart(2,"0")}`; };
const mnorm=s=>String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const isoDate=d=>d.toISOString().slice(0,10);
function monthsAgo(n){ const d=new Date(); d.setMonth(d.getMonth()-n); return d; }

// ---- config -----------------------------------------------------------------
const INTENT_DEFAULTS={
  intent_enabled:true, intent_window_days:30, intent_decay_pct_per_week:0.20,
  intent_weights:{login:2,product_view:3,product_view_repeat:5,pricing_view:8,order_page:10,order_started:15,email_open:1,email_click:4},
  intent_tiers:{interested:10,high:20,opportunity:30},
  intent_task_threshold:30, intent_task_cooldown_days:7,
  dormant_months:3, exclude_manufacturers:[]
};
async function getConfig(){
  try{ const rows=await sbGet("app_settings?key=eq.automation_config&select=value");
    const v=(rows&&rows[0]&&rows[0].value)||{};
    return {...INTENT_DEFAULTS,...v,
      intent_weights:{...INTENT_DEFAULTS.intent_weights,...(v.intent_weights||{})},
      intent_tiers:{...INTENT_DEFAULTS.intent_tiers,...(v.intent_tiers||{})}}; }
  catch(e){ return {...INTENT_DEFAULTS}; }
}
// Allowed event types + the server-side weight for each (client-supplied weights ignored).
const ALLOWED_EVENTS=["login","product_view","product_view_repeat","pricing_view","order_page","order_started","email_open","email_click"];
function weightFor(type,cfg){ const w=(cfg&&cfg.intent_weights)||INTENT_DEFAULTS.intent_weights; return Number(w[type])||0; }
function tierFor(score,tiers){ const s=Number(score)||0; const t=tiers||INTENT_DEFAULTS.intent_tiers;
  if(s>=t.opportunity) return "opportunity"; if(s>=t.high) return "high"; if(s>=t.interested) return "interested"; return "normal"; }

// ---- 1. intent scoring ------------------------------------------------------
// Decayed rolling sum over the window: an event worth W points, D days old,
// contributes W * (1 - decay)^(D/7). Recomputed hourly (fresh) + nightly (full).
async function computeIntent(){
  const cfg=await getConfig();
  if(cfg.intent_enabled===false) return {skipped:"intent disabled"};
  const windowDays=Number(cfg.intent_window_days)||30;
  const decay=Math.min(0.95,Math.max(0,Number(cfg.intent_decay_pct_per_week)||0));
  const now=Date.now(); const stamp=new Date(now).toISOString();
  const sinceIso=new Date(now-windowDays*864e5).toISOString();
  let ev=[]; try{ ev=await sbGetAll(`intent_events?occurred_at=gte.${encodeURIComponent(sinceIso)}&select=dealer_id,manufacturer,product_code,weight,occurred_at`,"id"); }catch(e){ return {error:String(e&&e.message||e)}; }
  const DL=new Map();
  for(const e of ev){ if(!e.dealer_id) continue;
    const w=Number(e.weight)||0; if(w===0) continue;
    const ageDays=Math.max(0,(now-new Date(e.occurred_at).getTime())/864e5);
    const dw=w*Math.pow(1-decay, ageDays/7);
    let o=DL.get(e.dealer_id); if(!o){o={total:0,mfr:{},prod:{},last:0};DL.set(e.dealer_id,o);}
    o.total+=dw;
    if(e.manufacturer) o.mfr[e.manufacturer]=(o.mfr[e.manufacturer]||0)+dw;
    if(e.product_code) o.prod[e.product_code]=(o.prod[e.product_code]||0)+dw;
    const t=new Date(e.occurred_at).getTime(); if(t>o.last)o.last=t;
  }
  const rows=[]; let opp=0,high=0;
  for(const [id,o] of DL){
    const total=Math.round(o.total*10)/10;
    const byM={}; for(const k in o.mfr) byM[k]=Math.round(o.mfr[k]*10)/10;
    const topM=Object.entries(o.mfr).sort((a,b)=>b[1]-a[1])[0];
    const topP=Object.entries(o.prod).sort((a,b)=>b[1]-a[1])[0];
    const tier=tierFor(total,cfg.intent_tiers); if(tier==="opportunity")opp++; else if(tier==="high")high++;
    rows.push({dealer_id:id,score_total:total,tier,by_manufacturer:byM,
      top_manufacturer:topM?topM[0]:null,top_product:topP?topP[0]:null,
      last_event_at:new Date(o.last).toISOString(),computed_at:stamp});
  }
  let up=0; for(let i=0;i<rows.length;i+=200){ const part=rows.slice(i,i+200);
    try{ await sbSend("POST","dealer_intent?on_conflict=dealer_id",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); up+=part.length; }catch(e){} }
  // Dealers with no qualifying events in the window have decayed to zero — reset
  // their cached row so tiers stay honest (don't leave a stale "opportunity").
  let zeroed=0; try{ const r=await sbSend("PATCH",`dealer_intent?computed_at=lt.${encodeURIComponent(stamp)}`,
    {score_total:0,tier:"normal",by_manufacturer:{},top_manufacturer:null,top_product:null,computed_at:stamp},
    {Prefer:"return=representation"}); zeroed=(r&&r.length)||0; }catch(e){}
  return {scored:up,opportunity:opp,high,zeroed,events:ev.length};
}

// ---- 2. relationship matrix -------------------------------------------------
// active/dormant come from monthly_sales cadence; prospect comes from cross_sell
// (a fitting line the dealer doesn't yet buy). Retired lines are excluded. Rows
// are pruned each run so the matrix reflects the current book.
async function computeLineStatus(){
  const cfg=await getConfig();
  const [mfrs,dealers,aliases,xsell]=await Promise.all([
    sbGet("manufacturers?select=slug,name").catch(()=>[]),
    sbGetAll("dealers?select=id,business_name,parent_id"),
    sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
    sbGet("cross_sell?select=dealer_id,rec_slug,rec_name,basis_name,score,rank").catch(()=>[]),
  ]);
  const mfrName={}; for(const m of mfrs) mfrName[m.slug]=m.name||m.slug;
  const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
  const idByAlias={}; for(const a of aliases) idByAlias[a.alias_norm]=a.dealer_id;
  const exMfr=new Set((cfg.exclude_manufacturers||[]).map(mnorm));
  const isEx=slug=>exMfr.has(mnorm(slug))||exMfr.has(mnorm(mfrName[slug]));
  const DORM=Number(cfg.dormant_months)||3;
  const rows=await sbGetAll("monthly_sales?select=dealer_id,manufacturer,period,customer_name,amount");
  const resolve=r=>{ if(r.dealer_id && nameById[r.dealer_id]) return r.dealer_id; const id=idByAlias[dnorm(r.customer_name)]; return (id&&nameById[id])?id:null; };
  let latest=0; const DL=new Map(); // dealer -> Map(slug -> {pms:Set,first,last})
  for(const r of rows){ const id=resolve(r); if(!id)continue; const slug=r.manufacturer; if(!slug||isEx(slug))continue; const pm=pmOf(r.period); if(!pm)continue; if(pm>latest)latest=pm;
    let m=DL.get(id); if(!m){m=new Map();DL.set(id,m);}
    let ln=m.get(slug); if(!ln){ln={pms:new Set(),first:pm,last:pm};m.set(slug,ln);}
    ln.pms.add(pm); if(pm<ln.first)ln.first=pm; if(pm>ln.last)ln.last=pm; }
  const stamp=new Date().toISOString(); const out=[];
  const has=new Map(); // dealer -> Set(slug) already covered by an ordered line
  for(const [id,m] of DL){ const s=new Set(); has.set(id,s);
    for(const [slug,ln] of m){ s.add(slug);
      const pms=[...ln.pms].sort((a,b)=>a-b); let cyc=null; if(pms.length>=2){ const g=[]; for(let i=1;i<pms.length;i++)g.push(pms[i]-pms[i-1]); cyc=median(g); }
      const ms=latest-ln.last; const dormant=ms>=DORM;
      out.push({dealer_id:id,manufacturer:slug,relationship:dormant?"dormant":"active",fit_flag:false,
        first_order_period:pmToStr(ln.first),last_order_period:pmToStr(ln.last),
        reorder_months:cyc!=null?Math.round(cyc*10)/10:null,months_since:ms,
        status_since:dormant?isoDate(monthsAgo(ms)):null,score:null,computed_at:stamp}); }
  }
  // prospects from cross-sell: a fitting line the dealer doesn't currently order
  for(const x of (xsell||[])){ if(!x||!x.dealer_id||!x.rec_slug) continue; if(isEx(x.rec_slug)) continue;
    const s=has.get(x.dealer_id); if(s&&s.has(x.rec_slug)) continue; // already active/dormant
    if(!nameById[x.dealer_id]) continue;
    if(s) s.add(x.rec_slug); // guard against duplicate prospect rows for the same line
    out.push({dealer_id:x.dealer_id,manufacturer:x.rec_slug,relationship:"prospect",fit_flag:true,
      first_order_period:null,last_order_period:null,reorder_months:null,months_since:null,
      status_since:null,score:x.score!=null?x.score:null,computed_at:stamp}); }
  let up=0; for(let i=0;i<out.length;i+=200){ const part=out.slice(i,i+200);
    try{ await sbSend("POST","dealer_line_status?on_conflict=dealer_id,manufacturer",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); up+=part.length; }catch(e){} }
  try{ await sbSend("DELETE",`dealer_line_status?computed_at=lt.${encodeURIComponent(stamp)}`,null,{Prefer:"return=minimal"}); }catch(e){}
  return {rows:up,dealers:DL.size};
}

// ---- 3. high-intent rep tasks ----------------------------------------------
// One open "Call dealer" task per opportunity-tier dealer (source='intent').
// Mirrors _engine.runTasks idempotency + 7-day cooldown, scoped to source=intent
// so the two task generators never fight over each other's rows.
async function syncIntentTasks(){
  const cfg=await getConfig();
  if(cfg.intent_enabled===false) return {skipped:"intent disabled"};
  const th=Number(cfg.intent_task_threshold)||30;
  const coolDays=Number(cfg.intent_task_cooldown_days)||7;
  const [hot,dealers,mfrs,dir]=await Promise.all([
    sbGet(`dealer_intent?score_total=gte.${th}&select=dealer_id,score_total,by_manufacturer,top_manufacturer,top_product,last_event_at`).catch(()=>[]),
    sbGetAll("dealers?select=id,business_name"),
    sbGet("manufacturers?select=slug,name").catch(()=>[]),
    sbGet("dealer_directory?select=dealer_name,rep_name").catch(()=>[]),
  ]);
  const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
  const mfrName={}; for(const m of mfrs) mfrName[m.slug]=m.name||m.slug;
  const repByName={}; for(const x of dir) repByName[x.dealer_name]=x.rep_name||"";
  // enrich with months-since-last-order for the hot line (for the evidence line)
  const ids=(hot||[]).map(h=>h.dealer_id);
  let lineMs={}; // dealer -> { slug -> months_since }
  if(ids.length){ try{ const uniq=[...new Set(ids)];
    for(let i=0;i<uniq.length;i+=100){ const part=uniq.slice(i,i+100);
      const ls=await sbGet(`dealer_line_status?dealer_id=in.(${part.join(",")})&select=dealer_id,manufacturer,months_since`).catch(()=>[]);
      for(const r of (ls||[])){ (lineMs[r.dealer_id]=lineMs[r.dealer_id]||{})[r.manufacturer]=r.months_since; } } }catch(e){} }
  const desired=new Map();
  for(const h of (hot||[])){ const name=nameById[h.dealer_id]||"This dealer";
    const topM=h.top_manufacturer; const mfrD=topM?(mfrName[topM]||topM):null;
    const ms=(topM&&lineMs[h.dealer_id])?lineMs[h.dealer_id][topM]:null;
    const line=mfrD?` in ${mfrD}`:""; const since=(ms!=null)?` Last ${mfrD} order ${ms} month(s) ago.`:"";
    const detail=`${name} is showing strong buying interest${line}. Intent score ${Math.round(h.score_total)}.${since} Recommended action: call the dealer.`;
    desired.set(h.dealer_id,{title:`High intent — call ${name}`,detail,priority:"high",rep:repByName[name]||null});
  }
  const existing=await sbGet("dealer_tasks?source=eq.intent&status=eq.open&select=id,dealer_id").catch(()=>[]);
  const existBy=new Map(); for(const t of (existing||[])) existBy.set(t.dealer_id,t.id);
  const cutoff=new Date(Date.now()-coolDays*864e5).toISOString();
  const recentClosed=await sbGet(`dealer_tasks?source=eq.intent&status=in.(done,dismissed)&done_at=gte.${cutoff}&select=dealer_id`).catch(()=>[]);
  const cooldown=new Set((recentClosed||[]).map(t=>t.dealer_id));
  const toCreate=[];
  for(const [id,f] of desired){ if(existBy.has(id)||cooldown.has(id)) continue;
    toCreate.push({dealer_id:id,title:f.title,detail:f.detail,priority:f.priority,source:"intent",reason:"intent",assigned_rep:f.rep||null,created_by:"Intent engine",status:"open"}); }
  let created=0; for(let i=0;i<toCreate.length;i+=200){ const part=toCreate.slice(i,i+200); try{ await sbSend("POST","dealer_tasks",part,{Prefer:"return=minimal"}); created+=part.length; }catch(e){} }
  // retire open intent tasks whose dealer is no longer opportunity-tier
  let closed=0; for(const t of (existing||[])){ if(!desired.has(t.dealer_id)){ try{ await sbSend("PATCH",`dealer_tasks?id=eq.${encodeURIComponent(t.id)}`,{status:"dismissed",done_at:new Date().toISOString()},{Prefer:"return=minimal"}); closed++; }catch(e){} } }
  return {opportunity:desired.size,created,dismissed:closed};
}

module.exports={ getConfig,computeIntent,computeLineStatus,syncIntentTasks,ALLOWED_EVENTS,weightFor,tierFor,INTENT_DEFAULTS };

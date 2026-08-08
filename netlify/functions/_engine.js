// HCPS automation engine — shared core for the scheduled follow-up + email machine.
// DECIDE (computeSignals -> runTasks / enqueueEmails) is separated from DELIVER
// (drainQueue, only in send windows). Everything is driven by the automation_config
// row in app_settings so parameters are tuned in one place, not in code.
//
// Exports: getConfig, computeSignals, runTasks, enqueueEmails, drainQueue,
//          recomputeEngagement, etHour, dueWindow
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const median=a=>{ if(!a.length) return null; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const pmOf=p=>{ const s=String(p||"").slice(0,7); const[y,m]=s.split("-").map(Number); return (y*12+(m-1)); };
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const eesc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const MAIL_FROM=process.env.HCPS_MAIL_FROM||"HCPS Partner Portal <orders@homecareproviderservices.us>";
const ORDERING=process.env.ORDERING_BASE||"https://hcpsonlineordering.netlify.app";
const SITE_BASE=process.env.SITE_BASE||"https://homecareproviderservices.netlify.app";

// ---- Config -----------------------------------------------------------------
const DEFAULTS={engine_enabled:true,email_enabled:false,cap_per_7d:2,min_gap_hours:48,
  dormant_months:3,overdue_mult:0.5,overdue_min_gap_months:1,quiet_weekends:true,
  business_hours:[7,19],timezone:"America/New_York",
  windows:{primary:[9,10],behavior:[12,13],remaining:[15,16]},
  templates_enabled:{overdue:true,dormant:true,cart:true,new:true},queue_ttl_hours:72};
async function getConfig(){
  try{ const rows=await sbGet("app_settings?key=eq.automation_config&select=value");
    const v=(rows&&rows[0]&&rows[0].value)||{}; return {...DEFAULTS,...v,
      windows:{...DEFAULTS.windows,...(v.windows||{})},
      templates_enabled:{...DEFAULTS.templates_enabled,...(v.templates_enabled||{})}}; }
  catch(e){ return {...DEFAULTS}; }
}

// ---- Eastern-time helpers (DST-safe via Intl) -------------------------------
function etParts(tz){
  const f=new Intl.DateTimeFormat("en-US",{timeZone:tz||"America/New_York",weekday:"short",hour:"numeric",hour12:false});
  const p={}; for(const x of f.formatToParts(new Date())) p[x.type]=x.value;
  let hour=parseInt(p.hour,10); if(hour===24)hour=0;
  const wk=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday);
  return {hour,weekday:wk};
}
const etHour=tz=>etParts(tz).hour;
// Is it currently inside a defined send window? returns window key or null.
function currentWindow(cfg){
  const {hour,weekday}=etParts(cfg.timezone);
  if(cfg.quiet_weekends && (weekday===0||weekday===6)) return null;
  for(const [key,[a,b]] of Object.entries(cfg.windows)){ if(hour>=a && hour<b) return key; }
  return null;
}
// Is the engine allowed to do heavy processing right now (weekday business hours)?
function inBusiness(cfg){
  const {hour,weekday}=etParts(cfg.timezone);
  if(cfg.quiet_weekends && (weekday===0||weekday===6)) return false;
  const [a,b]=cfg.business_hours||[7,19]; return hour>=a && hour<b;
}

// ---- Signal computation (single source of truth) ----------------------------
// Reads sales history + portal activity, returns Map dealer_id -> {name,email,rep,
// sales,first,last,monthsSince,signals:[{reason,title,detail,priority,template,payload}]}
async function computeSignals(){
  const cfg=await getConfig();
  const [mfrs,dealers,aliases,dir]=await Promise.all([
    sbGet("manufacturers?select=slug,name").catch(()=>[]),
    sbGetAll("dealers?select=id,business_name,parent_id,email"),
    sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
    sbGet("dealer_directory?select=dealer_name,rep_name").catch(()=>[]),
  ]);
  const mfrName={}; for(const m of mfrs) mfrName[m.slug]=m.name||m.slug;
  const nameById={},emailById={}; for(const d of dealers){ nameById[d.id]=d.business_name; emailById[d.id]=d.email||null; }
  const idByAlias={}; for(const a of aliases) idByAlias[a.alias_norm]=a.dealer_id;
  const repByName={}; for(const x of dir) repByName[x.dealer_name]=x.rep_name||"";
  const rows=await sbGetAll("monthly_sales?select=dealer_id,manufacturer,period,customer_name,amount");
  const resolve=r=>{ if(r.dealer_id && nameById[r.dealer_id]) return r.dealer_id; const id=idByAlias[dnorm(r.customer_name)]; return (id&&nameById[id])?id:null; };
  let latest=0; const DL=new Map();
  for(const r of rows){ const id=resolve(r); if(!id) continue; const pm=pmOf(r.period); if(!pm) continue; if(pm>latest)latest=pm;
    let o=DL.get(id); if(!o){o={sales:0,first:pm,last:pm,lines:new Map()};DL.set(id,o);}
    const amt=Number(r.amount)||0; o.sales+=amt; if(pm<o.first)o.first=pm; if(pm>o.last)o.last=pm;
    let ln=o.lines.get(r.manufacturer); if(!ln){ln={pms:new Set(),sales:0};o.lines.set(r.manufacturer,ln);}
    ln.pms.add(pm); ln.sales+=amt; }
  let sessions=[],carts=[];
  try{ sessions=await sbGet("dealer_sessions?select=dealer_id,last_seen_at&order=last_seen_at.desc&limit=800"); }catch(e){}
  try{ carts=await sbGet("dealer_carts?select=dealer_id,cart,updated_at"); }catch(e){}
  const seenBy={}; for(const s of (sessions||[])){ if(!s.dealer_id)continue; const t=new Date(s.last_seen_at).getTime(); if(!seenBy[s.dealer_id]||t>seenBy[s.dealer_id])seenBy[s.dealer_id]=t; }
  const cartBy={}; for(const c of (carts||[])){ if(!c.dealer_id)continue; const items=(c.cart&&c.cart.items)||[]; let n=0,val=0; for(const it of items){const q=Number(it.qty)||0;n+=q;val+=(Number(it.p&&it.p.base_price)||0)*q;} if(n>0){ const p=cartBy[c.dealer_id]; if(!p||val>p.val)cartBy[c.dealer_id]={val,items:n}; } }
  const NOW=Date.now(); const out=new Map();
  const DORM=Number(cfg.dormant_months)||3, MULT=Number(cfg.overdue_mult)||0.5, MING=Number(cfg.overdue_min_gap_months)||1;
  // Lines/dealers we no longer represent — never generate tasks or emails for these.
  const mnorm=s=>String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  const exMfr=new Set((cfg.exclude_manufacturers||[]).map(mnorm));
  const exDealer=new Set((cfg.exclude_dealers||[]).map(String));
  for(const [id,o] of DL){
    if(exDealer.has(id)) continue;
    const rep=repByName[nameById[id]]||null; const signals=[];
    const ov=[]; for(const [slug,ln] of o.lines){ if(exMfr.has(mnorm(slug))||exMfr.has(mnorm(mfrName[slug]))) continue; const pms=[...ln.pms].sort((a,b)=>a-b); if(pms.length<2)continue; const gaps=[]; for(let i=1;i<pms.length;i++)gaps.push(pms[i]-pms[i-1]); const cyc=median(gaps); if(cyc==null||cyc<=0)continue; const since=latest-pms[pms.length-1]; if(since>=cyc+Math.max(MING,Math.round(cyc*MULT))) ov.push({slug,since,cyc,sales:ln.sales}); }
    ov.sort((a,b)=>b.sales-a.sales);
    for(const x of ov.slice(0,3)){ const line=mfrName[x.slug]||x.slug; signals.push({reason:"overdue:"+x.slug,title:`Reorder due — ${line}`,detail:`Usually orders ~${Math.round(x.cyc)}mo; ${x.since}mo since last ${line} order.`,priority:x.sales>20000?"high":"normal",template:"overdue",payload:{line,slug:x.slug,cyc:Math.round(x.cyc),since:x.since}}); }
    const monthsSince=latest-o.last;
    if(monthsSince>=DORM) signals.push({reason:"dormant",title:"Dormant account — re-engage",detail:`No orders in ${monthsSince} months.`,priority:o.sales>50000?"high":"normal",template:"dormant",payload:{monthsSince}});
    const cart=cartBy[id]; if(cart) signals.push({reason:"intent_cart",title:"Open cart — follow up",detail:`${cart.items} item(s), ~$${Math.round(cart.val)} in cart on the portal.`,priority:"high",template:"cart",payload:{items:cart.items,val:Math.round(cart.val)}});
    const seen=seenBy[id]; if(seen && (NOW-seen)<21*864e5) signals.push({reason:"intent_login",title:"Recent login — reach out",detail:`Logged in ${new Date(seen).toISOString().slice(0,10)}.`,priority:"normal"}); // task only, no email
    if((latest-o.first)<=2) signals.push({reason:"new",title:"New account — onboard",detail:"First order in the last 2 months.",priority:"normal",template:"new",payload:{}});
    if(signals.length) out.set(id,{name:nameById[id],email:emailById[id],rep,sales:o.sales,first:o.first,last:o.last,monthsSince,signals});
  }
  return {latest,dealers:out,mfrName};
}

// ---- Tasks (used by scheduled hourly AND manual "run now") -------------------
// Idempotent: creates only new signals, honors a 7-day per-(dealer,reason) cooldown
// even after a task was completed/dismissed, and dismisses auto-tasks that no longer apply.
async function runTasks(sig){
  const s=sig||await computeSignals(); const desired=new Map();
  for(const [id,d] of s.dealers){ const m=new Map(); for(const g of d.signals) m.set(g.reason,{title:g.title,detail:g.detail,priority:g.priority,rep:d.rep}); desired.set(id,m); }
  const existing=await sbGetAll("dealer_tasks?source=eq.auto&status=eq.open&select=id,dealer_id,reason","id").catch(()=>[]);
  const existKey=new Set(); for(const t of existing) existKey.add(t.dealer_id+"|"+t.reason);
  // Cooldown: recently-closed auto-tasks (last 7d) suppress immediate re-creation.
  const cutoff=new Date(Date.now()-7*864e5).toISOString();
  const recentClosed=await sbGet(`dealer_tasks?source=eq.auto&status=in.(done,dismissed)&done_at=gte.${cutoff}&select=dealer_id,reason`).catch(()=>[]);
  const cooldown=new Set(); for(const t of (recentClosed||[])) cooldown.add(t.dealer_id+"|"+t.reason);
  const toCreate=[];
  for(const [id,m] of desired){ for(const [reason,f] of m){ const k=id+"|"+reason; if(existKey.has(k)||cooldown.has(k))continue; toCreate.push({dealer_id:id,title:f.title,detail:f.detail,priority:f.priority,source:"auto",reason,assigned_rep:f.rep||null,created_by:"Follow-up engine",status:"open"}); } }
  let created=0; for(let i=0;i<toCreate.length;i+=200){ const part=toCreate.slice(i,i+200); try{ await sbSend("POST","dealer_tasks",part,{Prefer:"return=minimal"}); created+=part.length; }catch(e){} }
  let closed=0; for(const t of existing){ const m=desired.get(t.dealer_id); if(!(m&&m.has(t.reason))){ try{ await sbSend("PATCH",`dealer_tasks?id=eq.${encodeURIComponent(t.id)}`,{status:"dismissed",done_at:new Date().toISOString()},{Prefer:"return=minimal"}); closed++; }catch(e){} } }
  return {ok:true,dealers_flagged:desired.size,created,dismissed:closed,open_auto:(existing.length-closed)+created};
}

// ---- Email queueing (DECIDE) ------------------------------------------------
const WIN_FOR={overdue:"behavior",cart:"behavior",dormant:"remaining",new:"primary",crosssell:"remaining",campaign:"primary"};
// Next window start (ISO) from now, honoring quiet weekends. Simple: same day if the
// window is still ahead, else search forward up to 8 days.
function nextWindowAt(cfg,winKey){
  const [a]=cfg.windows[winKey]||[12]; const tz=cfg.timezone;
  for(let addDays=0; addDays<8; addDays++){
    const base=new Date(Date.now()+addDays*864e5);
    const parts=new Intl.DateTimeFormat("en-US",{timeZone:tz,weekday:"short"}).formatToParts(base);
    const wk=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(parts.find(p=>p.type==="weekday").value);
    if(cfg.quiet_weekends && (wk===0||wk===6)) continue;
    // Build a timestamp at hour `a` ET that day. We approximate ET offset from the date.
    const ymd=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(base);
    const offMin=etOffsetMinutes(tz,base); // minutes behind UTC (e.g. 240 or 300)
    const iso=`${ymd}T${String(a).padStart(2,"0")}:00:00.000Z`;
    const t=new Date(new Date(iso).getTime()+offMin*60000); // shift so `a` is ET local
    if(addDays>0 || t.getTime()>Date.now()) return t.toISOString();
  }
  return new Date(Date.now()+3600e3).toISOString();
}
function etOffsetMinutes(tz,d){
  // minutes to ADD to a UTC-labeled wall time to get the true UTC instant for ET
  const dtf=new Intl.DateTimeFormat("en-US",{timeZone:tz,hour:"numeric",hour12:false});
  const h=parseInt(dtf.formatToParts(d).find(p=>p.type==="hour").value,10)%24;
  const utcH=d.getUTCHours(); let diff=utcH-h; if(diff<0)diff+=24; return diff*60;
}
async function enqueueEmails(sig,cfg){
  cfg=cfg||await getConfig(); const s=sig||await computeSignals();
  // Contacts fallback + opt-outs, fetched once.
  const optRows=await sbGet("email_optout?select=email").catch(()=>[]);
  const opted=new Set((optRows||[]).map(r=>String(r.email||"").toLowerCase()));
  const liveRows=await sbGet("email_queue?status=eq.queued&select=dealer_id,template").catch(()=>[]);
  const live=new Set((liveRows||[]).map(r=>r.dealer_id+"|"+r.template));
  // recent sends (7d) — avoid re-queuing the same template we just sent
  const cut=new Date(Date.now()-7*864e5).toISOString();
  const sentRows=await sbGet(`email_sends?sent_at=gte.${cut}&select=dealer_id,template`).catch(()=>[]);
  const sentRecent=new Set((sentRows||[]).map(r=>r.dealer_id+"|"+r.template));
  const insert=[]; let considered=0,skipped=0;
  for(const [id,d] of s.dealers){
    // one best signal→email per dealer per run, highest priority first
    const emailSignals=d.signals.filter(g=>g.template && cfg.templates_enabled[g.template]);
    if(!emailSignals.length) continue;
    emailSignals.sort((a,b)=>(a.priority==="high"?0:1)-(b.priority==="high"?0:1));
    let to=d.email;
    if(!to){ try{ const c=await sbGet(`dealer_contacts?dealer_id=eq.${encodeURIComponent(id)}&select=email&limit=1`); to=(c&&c[0]&&c[0].email)||null; }catch(e){} }
    to=String(to||"").trim();
    for(const g of emailSignals){
      considered++;
      const key=id+"|"+g.template;
      if(!EMAIL_RE.test(to)){ skipped++; break; }
      if(opted.has(to.toLowerCase())){ skipped++; break; }
      if(live.has(key)||sentRecent.has(key)){ skipped++; continue; }
      const win=WIN_FOR[g.template]||"behavior";
      insert.push({dealer_id:id,contact_email:to,template:g.template,reason:g.reason,priority:g.priority,send_window:win,payload:g.payload||{},detail:`${d.name||""}: ${g.detail}`,send_after:nextWindowAt(cfg,win),status:"queued"});
      break; // at most one queued email per dealer per run; the cap enforces the rest
    }
  }
  let queued=0;
  for(const row of insert){ try{ await sbSend("POST","email_queue",row,{Prefer:"return=minimal"}); queued++; }catch(e){/* unique index race -> already queued */} }
  return {considered,queued,skipped};
}

// ---- Email templates --------------------------------------------------------
function tmpl(template,dealer,payload,unsub){
  const hi=dealer?(", "+eesc(dealer)):""; const btn=(t)=>`<a href="${ORDERING}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;font-size:14px">${t} →</a>`;
  const wrap=(head,body,cta)=>({html:`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px"><h2 style="color:#2B4071;margin:0 0 6px">${head}</h2><p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 12px">${body}</p>${btn(cta)}<p style="font-size:12.5px;line-height:1.6;color:#6b7280;margin:16px 0 0">Questions, or want a hand with a reorder? Reply to this email or reach your HCPS rep — glad to help.</p><p style="font-size:12px;color:#9aa4ae;margin:14px 0 0">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.<br><a href="${unsub}" style="color:#9aa4ae">Unsubscribe from these emails</a></p></div>`});
  if(template==="overdue"){ const line=eesc(payload&&payload.line||"your usual products");
    return {subject:`Time to restock ${payload&&payload.line?payload.line:"your line"}?`, ...wrap(`Ready for a reorder${hi}?`,`It's been about ${payload&&payload.since||"a few"} months since your last ${line} order — right around when you usually restock. Your pricing is loaded and you can reorder in a couple of clicks, 24/7.`,"Reorder now")}; }
  if(template==="cart"){ return {subject:"You left items in your cart", ...wrap(`Still thinking it over${hi}?`,`You've got ${payload&&payload.items||"a few"} item(s) waiting in your cart on the HCPS portal. Everything's saved — pick up right where you left off whenever you're ready.`,"Finish your order")}; }
  if(template==="new"){ return {subject:"Welcome to HomeCare Provider Services", ...wrap(`Welcome aboard${hi}!`,`Thanks for your first order with HomeCare Provider Services. Your account is set up with your manufacturer lines and pricing — browse anytime and reorder in a couple of clicks. We're glad to have you.`,"Browse your lines")}; }
  // dormant (default)
  return {subject:"We've missed you at HomeCare Provider Services", ...wrap(`We've missed you${hi}`,`It's been a little while since your last order with HomeCare Provider Services. Your account is active and ready — browse your lines, see your pricing, and reorder in a couple of clicks, 24/7.`,"Sign in & reorder")};
}
async function sendMail({to,subject,html,text}){
  const key=process.env.RESEND_API_KEY; if(!key) return {ok:false,skipped:true};
  try{ const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({from:MAIL_FROM,to:[to],subject,html,text})}); return {ok:r.ok}; }
  catch(e){ return {ok:false}; }
}

// ---- Delivery (DELIVER) — only called inside a send window ------------------
// Sends due queued emails, enforcing opt-out + the frequency cap (N per rolling
// 7 days, min gap hours). In dry-run (email_enabled=false) it sends nothing.
async function drainQueue(cfg,winKey){
  cfg=cfg||await getConfig();
  const nowIso=new Date().toISOString();
  const filt=winKey?`&send_window=eq.${winKey}`:"";
  const due=await sbGet(`email_queue?status=eq.queued&send_after=lte.${nowIso}${filt}&select=*&order=priority.asc,enqueued_at.asc&limit=60`).catch(()=>[]);
  let sent=0,capped=0,failed=0,skipped=0;
  if(!cfg.email_enabled){ return {dry_run:true,due:(due||[]).length,sent:0}; }
  const capN=Number(cfg.cap_per_7d)||2, gapMs=(Number(cfg.min_gap_hours)||48)*3600e3;
  const cut7=new Date(Date.now()-7*864e5).toISOString();
  for(const q of (due||[])){
    const to=String(q.contact_email||"").trim().toLowerCase();
    if(!EMAIL_RE.test(to)){ await mark(q.id,"skipped","no valid email"); skipped++; continue; }
    const opt=await sbGet(`email_optout?email=eq.${encodeURIComponent(to)}&select=email`).catch(()=>[]);
    if(opt&&opt[0]){ await mark(q.id,"skipped","opted out"); skipped++; continue; }
    // frequency cap per dealer
    const recent=await sbGet(`email_sends?dealer_id=eq.${encodeURIComponent(q.dealer_id)}&sent_at=gte.${cut7}&select=sent_at&order=sent_at.desc`).catch(()=>[]);
    if((recent||[]).length>=capN){ await mark(q.id,"skipped","weekly cap"); capped++; continue; }
    if(recent&&recent[0] && (Date.now()-new Date(recent[0].sent_at).getTime())<gapMs){ await mark(q.id,"skipped","min gap"); capped++; continue; }
    const unsub=`${SITE_BASE}/.netlify/functions/unsubscribe?e=${encodeURIComponent(q.contact_email)}&d=${encodeURIComponent(q.dealer_id||"")}`;
    const t=tmpl(q.template,q.detail?String(q.detail).split(":")[0]:"",q.payload||{},unsub);
    const res=await sendMail({to:q.contact_email,subject:t.subject,html:t.html,text:t.subject});
    if(res&&res.ok){
      await sbSend("POST","email_sends",{dealer_id:q.dealer_id,contact_email:q.contact_email,template:q.template},{Prefer:"return=minimal"}).catch(()=>{});
      await sbSend("POST","dealer_activity",{dealer_id:q.dealer_id,kind:"campaign",subject:`Auto email: ${q.template}`,contact_email:q.contact_email,actor:"Automation engine"},{Prefer:"return=minimal"}).catch(()=>{});
      await sbSend("PATCH",`email_queue?id=eq.${encodeURIComponent(q.id)}`,{status:"sent",sent_at:new Date().toISOString()},{Prefer:"return=minimal"}).catch(()=>{});
      sent++;
    }else{ await mark(q.id,"failed",res&&res.skipped?"resend not configured":"send failed"); failed++; }
  }
  async function mark(id,status,err){ try{ await sbSend("PATCH",`email_queue?id=eq.${encodeURIComponent(id)}`,{status,error:err||null,sent_at:new Date().toISOString()},{Prefer:"return=minimal"}); }catch(e){} }
  return {dry_run:false,due:(due||[]).length,sent,capped,failed,skipped};
}

// ---- Nightly engagement recompute + queue housekeeping ----------------------
async function recomputeEngagement(sig){
  const cfg=await getConfig(); const s=sig||await computeSignals(); const rows=[];
  for(const [id,d] of s.dealers){
    const ms=d.monthsSince; let status="active";
    if(d.first!=null && (s.latest-d.first)<=2) status="new";
    else if(ms>=Number(cfg.dormant_months||3)) status="dormant";
    else if(d.signals.some(g=>g.reason&&g.reason.startsWith("overdue"))) status="overdue";
    else if(ms>=2) status="slipping";
    const rec=Math.max(0,100-ms*12);
    rows.push({dealer_id:id,status,score:Math.round(rec),months_since:ms,last_period:pmToStr(d.last),dormant_since:status==="dormant"?isoDate(monthsAgo(ms)):null,cycle_json:{},computed_at:new Date().toISOString()});
  }
  let up=0; for(let i=0;i<rows.length;i+=200){ const part=rows.slice(i,i+200); try{ await sbSend("POST","dealer_engagement?on_conflict=dealer_id",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); up+=part.length; }catch(e){} }
  // Housekeeping: expire stale queued emails past TTL.
  const ttl=new Date(Date.now()-(Number(cfg.queue_ttl_hours)||72)*3600e3).toISOString();
  let expired=0; try{ const r=await sbSend("PATCH",`email_queue?status=eq.queued&send_after=lt.${ttl}`,{status:"expired"},{Prefer:"return=representation"}); expired=(r&&r.length)||0; }catch(e){}
  return {engagement_rows:up,expired};
}
function pmToStr(pm){ if(pm==null)return null; const y=Math.floor(pm/12), m=(pm%12)+1; return `${y}-${String(m).padStart(2,"0")}`; }
function monthsAgo(n){ const d=new Date(); d.setMonth(d.getMonth()-n); return d; }
function isoDate(d){ return d.toISOString().slice(0,10); }

module.exports={getConfig,computeSignals,runTasks,enqueueEmails,drainQueue,recomputeEngagement,currentWindow,inBusiness,etHour,DEFAULTS};

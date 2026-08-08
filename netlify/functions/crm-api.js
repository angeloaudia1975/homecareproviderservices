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

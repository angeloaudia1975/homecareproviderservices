// HCPS Connect 360 — Rep Usage & Adoption (Phase 4). President-only.
// Turns the Phase-3 capture (staff_sessions + rep_activity) PLUS the meaningful actions already
// stored per-rep (dealer_notes / dealer_activity / dealer_tasks / dealer_visits / rep_routes /
// opportunities) into one adoption view: who's logging in, how actively, and whether they're
// actually working their book — not just leaving the portal open.
//
//   POST {action:"overview", days?}       -> per-rep summary rows + an engagement score
//   POST {action:"rep", email, days?}     -> one rep's metrics + a chronological activity timeline
//
// Every table read is best-effort: missing tables (e.g. before rep_activity.sql is run) just yield
// zeros, so the page works the moment it deploys and fills in as capture accumulates.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbGetAll(base, orderCol){ const PAGE=1000; let from=0,out=[]; const sep=base.includes("?")?"&":"?"; for(;;){ const rows=await sbGet(`${base}${sep}order=${orderCol||"created_at"}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
async function safe(base, orderCol){ try{ return await sbGetAll(base, orderCol); }catch(e){ return []; } }
const lc=x=>String(x==null?"":x).trim().toLowerCase();
const dayKey=t=>String(t||"").slice(0,10);

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
      if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,rep_name,name,active`).catch(()=>[]); const su=s&&s[0];
        if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email}; } }
  }catch(e){}
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:""};
  return null;
}

// Pull every window-scoped source once; overview + rep detail both read from it.
async function gather(days){
  const since=new Date(Date.now()-days*864e5).toISOString();
  const [staff, sessions, acts, notes, activity, tasks, visits, routes, opps, dealers] = await Promise.all([
    safe(`staff_users?select=email,name,role,rep_name,active`, "email"),
    safe(`staff_sessions?login_at=gte.${since}&select=email,login_at,last_seen_at,active_seconds`, "login_at"),
    safe(`rep_activity?occurred_at=gte.${since}&select=email,action,tool,dealer_id,occurred_at`, "occurred_at"),
    safe(`dealer_notes?created_at=gte.${since}&select=author_email,author_name,dealer_id,body,created_at`, "created_at"),
    safe(`dealer_activity?created_at=gte.${since}&select=actor,kind,subject,dealer_id,created_at`, "created_at"),
    safe(`dealer_tasks?or=(created_at.gte.${since},done_at.gte.${since})&select=created_by,assigned_rep,title,status,dealer_id,done_at,created_at`, "created_at"),
    safe(`dealer_visits?visited_at=gte.${since}&select=owner_email,rep_name,dealer_id,visited_at`, "visited_at"),
    safe(`rep_routes?created_at=gte.${since}&select=owner_email,rep_name,name,scheduled_date,stops,created_at`, "created_at"),
    safe(`opportunities?created_at=gte.${since}&select=created_by,owner_rep,title,dealer_id,created_at`, "created_at"),
    safe(`dealers?select=id,business_name`, "id")
  ]);
  const dname={}; for(const d of dealers){ if(d&&d.id) dname[d.id]=d.business_name||""; }
  return {since, staff, sessions, acts, notes, activity, tasks, visits, routes, opps, dname};
}

// Does an action record belong to this rep? Attribution keys vary by table (email / name / rep_name).
function keysFor(su){ return { email:lc(su.email), name:lc(su.name), rep:lc(su.rep_name) }; }
function isMine(k, ...vals){ const set=new Set(vals.map(lc).filter(Boolean)); return !!(set.has(k.email)||(k.name&&set.has(k.name))||(k.rep&&set.has(k.rep))); }

function summarize(su, D){
  const k=keysFor(su);
  const mySess=D.sessions.filter(s=>lc(s.email)===k.email);
  const days=new Set(mySess.map(s=>dayKey(s.login_at)));
  const activeSecs=mySess.reduce((a,s)=>a+(Number(s.active_seconds)||0),0);
  const lastLogin=mySess.reduce((m,s)=>(!m||s.login_at>m)?s.login_at:m, null);

  const myViews=D.acts.filter(a=>lc(a.email)===k.email);
  const tools=new Set(myViews.filter(a=>a.tool).map(a=>a.tool));
  const dealersSeen=new Set(myViews.filter(a=>a.action==="dealer_view"&&a.dealer_id).map(a=>a.dealer_id));

  const notes=D.notes.filter(n=>lc(n.author_email)===k.email).length;
  const touches=D.activity.filter(a=>isMine(k, a.actor)).length;
  const tasksCreated=D.tasks.filter(t=>isMine(k, t.created_by)).length;
  const tasksDone=D.tasks.filter(t=>t.done_at && isMine(k, t.assigned_rep, t.created_by)).length;
  const visits=D.visits.filter(v=>isMine(k, v.owner_email, v.rep_name)).length;
  const routes=D.routes.filter(r=>isMine(k, r.owner_email, r.rep_name)).length;
  const opps=D.opps.filter(o=>isMine(k, o.created_by, o.owner_rep)).length;

  const meaningful = touches+notes+tasksDone+visits+routes+opps;
  // Engagement rewards WORK, not just minutes: showing up + reviewing accounts + logging real actions.
  const raw = days.size*5 + dealersSeen.size*2 + touches*4 + notes*2 + tasksDone*4 + tasksCreated*1 + visits*5 + routes*6 + opps*3;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const tier = score>=60?"strong":score>=30?"active":score>=10?"light":(mySess.length?"idle":"none");
  const flag = (mySess.length>0 && meaningful===0) ? "logged_in_no_activity" : "";

  return {
    email:su.email, name:su.name||su.email, role:su.role||"rep", rep_name:su.rep_name||"",
    last_login:lastLogin, sessions:mySess.length, active_days:days.size,
    active_minutes:Math.round(activeSecs/60),
    tools_used:tools.size, tool_list:[...tools], dealers_accessed:dealersSeen.size,
    notes, touches, tasks_created:tasksCreated, tasks_completed:tasksDone, visits, routes, opportunities:opps,
    meaningful, score, tier, flag
  };
}

exports.handler = async (event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{ok:false,error:"unauthorized"});
    const role=lc(me.role);
    if(!(role==="president"||role==="admin"||role==="owner")) return json(403,{ok:false,error:"president only"});
    let b; try{ b=JSON.parse(event.body||"{}"); }catch{ return json(400,{ok:false,error:"bad JSON"}); }
    const days=Math.max(1,Math.min(parseInt(b.days,10)||30,365));

    const D=await gather(days);
    // Staff we report on: active accounts, reps first (president can still see everyone).
    const roster=D.staff.filter(s=>s&&s.email&&s.active!==false);

    if(b.action==="rep"){
      const email=lc(b.email); if(!email) return json(400,{ok:false,error:"email required"});
      const su=roster.find(s=>lc(s.email)===email); if(!su) return json(404,{ok:false,error:"rep not found"});
      const sum=summarize(su, D);
      const k=keysFor(su);
      const dn=id=>D.dname[id]||"(dealer)";
      const tl=[];
      D.sessions.filter(s=>lc(s.email)===k.email).forEach(s=>tl.push({at:s.login_at, kind:"login", text:"Signed in", detail:(Math.round((Number(s.active_seconds)||0)/60))+" min active"}));
      D.acts.filter(a=>lc(a.email)===k.email).forEach(a=>tl.push({at:a.occurred_at, kind:a.action==="dealer_view"?"dealer":"view", text:a.action==="dealer_view"?("Opened "+dn(a.dealer_id)):("Opened "+(a.tool||"a tool")), detail:""}));
      D.activity.filter(a=>isMine(k,a.actor)).forEach(a=>tl.push({at:a.created_at, kind:"touch", text:(a.kind||"touch")+(a.dealer_id?(" · "+dn(a.dealer_id)):""), detail:a.subject||""}));
      D.notes.filter(n=>lc(n.author_email)===k.email).forEach(n=>tl.push({at:n.created_at, kind:"note", text:"Note"+(n.dealer_id?(" · "+dn(n.dealer_id)):""), detail:(n.body||"").slice(0,80)}));
      D.tasks.filter(t=>isMine(k,t.created_by)).forEach(t=>tl.push({at:t.created_at, kind:"task", text:"Task created"+(t.dealer_id?(" · "+dn(t.dealer_id)):""), detail:t.title||""}));
      D.tasks.filter(t=>t.done_at&&isMine(k,t.assigned_rep,t.created_by)).forEach(t=>tl.push({at:t.done_at, kind:"done", text:"Task completed"+(t.dealer_id?(" · "+dn(t.dealer_id)):""), detail:t.title||""}));
      D.visits.filter(v=>isMine(k,v.owner_email,v.rep_name)).forEach(v=>tl.push({at:v.visited_at, kind:"visit", text:"Visit logged"+(v.dealer_id?(" · "+dn(v.dealer_id)):""), detail:""}));
      D.routes.filter(r=>isMine(k,r.owner_email,r.rep_name)).forEach(r=>tl.push({at:r.created_at, kind:"route", text:"Route: "+(r.name||"trip"), detail:((r.stops&&r.stops.length)||0)+" stops"+(r.scheduled_date?(" · "+dayKey(r.scheduled_date)):"")}));
      D.opps.filter(o=>isMine(k,o.created_by,o.owner_rep)).forEach(o=>tl.push({at:o.created_at, kind:"opp", text:"Opportunity"+(o.dealer_id?(" · "+dn(o.dealer_id)):""), detail:o.title||""}));
      tl.sort((a,b)=>String(b.at||"").localeCompare(String(a.at||"")));
      return json(200,{ok:true, days, rep:sum, timeline:tl.slice(0,80)});
    }

    // overview (default)
    const reps=roster.map(su=>summarize(su, D)).sort((a,b)=> (b.score-a.score) || String(b.last_login||"").localeCompare(String(a.last_login||"")));
    const captureOn = D.sessions.length>0 || D.acts.length>0;
    return json(200,{ok:true, days, generated_at:new Date().toISOString(), capture_on:captureOn, reps});
  }catch(e){ return json(500,{ok:false,error:String(e&&e.message||e)}); }
};

// HCPS — Sales Rep Command Center API (Phase 1).
//
// Answers a rep's three questions from data that already exists — no AI on load, nothing copied:
//   What do I need to do today?          Daily Header · Today's Priorities · Today's Route · Meeting Prep
//   What happened during my visits?      Visit Progress · Today's Visit Activity
//   What do I need to follow up on now?  Follow-Up Queue · Opportunities Needing Attention ·
//                                        End-of-Day Results (Today's Follow-Up Progress) · Tomorrow Preview
//
//   POST {action:"today", date?:"YYYY-MM-DD" (the rep's local date), hour?:0-23, rep?:email}
//   POST {action:"reps"}   -> the people a viewer may pick (management / Relations only)
//
// WHO: the signed-in person sees their own Command Center. The president (and admin/owner) and
// Customer Relations — the roles that work every dealer — may pick a rep to VIEW (read-only, never
// act as them). A sales rep can never see anyone else's: a rep's `rep` is ignored.
// HOW: every read is filtered on the server by that person's email / rep name, their routes, or the
// dealer ids on today's route — never a company-wide payload — run in parallel, and paged past the
// database's 1000-row limit.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
const SC = require("./_scope.js");
const getAll = (path, order) => SC.getAll(sbGet, path, order);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const low = s => String(s == null ? "" : s).trim().toLowerCase();
const enc = encodeURIComponent;
const PRANK = { high: 0, normal: 1, medium: 1, low: 2 };
const STAGE_PROB = { identified: 0.1, contacted: 0.3, quoted: 0.6, won: 1, lost: 0 };

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
      if(email){ const s=await sbGet(`staff_users?email=eq.${enc(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
        if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email}; } } }catch(e){}
  return null;
}

const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const monthsBack = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCMonth(t.getUTCMonth() - n); return t.toISOString().slice(0, 7); };
const inList = ids => [...new Set(ids.filter(Boolean).map(String))].map(enc).join(",");
const chunks = (arr, n) => { const out = []; for(let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
async function byIds(table, col, ids, select, extra){
  const u = [...new Set((ids || []).filter(Boolean).map(String))]; if(!u.length) return [];
  const parts = await Promise.all(chunks(u, 120).map(p => getAll(`${table}?${col}=in.(${inList(p)})${extra || ""}&select=${select}`, "id").catch(() => [])));
  return [].concat(...parts);
}

/* ---- Pure panel builders (tested directly) ------------------------------------------------- */

function stopStatus(v){
  if(!v) return "planned";
  if(v.approved_at || v.completed_at) return "done";
  if(v.ended_at) return "ended";
  if(v.checkin_at) return "on_site";
  return "planned";
}

/* A short brief to read in the parking lot. Only facts that exist; empty parts are left out. */
function buildPrep(dealerId, d, today){
  const out = { dealer_id: dealerId };
  const visits = (d.visits || []).filter(v => v.completed_at || v.approved_at).sort((a, z) => String(z.checkin_at || "").localeCompare(String(a.checkin_at || "")));
  const lv = visits[0];
  if(lv){
    const s = lv.summary || {};
    out.last_visit = { date: String(lv.checkin_at || lv.completed_at || "").slice(0, 10), rep: lv.rep_name || null,
      summary: String(s.meeting_summary || (lv.fields && lv.fields.notes) || "").slice(0, 220) || null };
    const concerns = [].concat(s.dealer_concerns || [], s.objections || []).filter(Boolean);
    if(concerns.length) out.concerns = concerns.slice(0, 4);
  }
  const sales = d.sales || [];
  const withAmt = sales.filter(x => Number(x.amount) > 0);
  const lastP = withAmt.map(x => String(x.period || "").slice(0, 7)).sort().pop();
  const lastOrder = (d.orders || []).map(o => String(o.submitted_at || "").slice(0, 10)).filter(Boolean).sort().pop();
  if(lastP || lastOrder) out.last_purchase = { month: lastP || null, amount: lastP ? Math.round(withAmt.filter(x => String(x.period).slice(0, 7) === lastP).reduce((a, x) => a + Number(x.amount || 0), 0)) : null, portal_order: lastOrder || null };
  const win = m => { const from = monthsBack(today, m); return Math.round(withAmt.filter(x => String(x.period || "").slice(0, 7) >= from).reduce((a, x) => a + Number(x.amount || 0), 0)); };
  const touches = days => { const from = addDays(today, -days); return (d.activity || []).filter(a => String(a.created_at || "").slice(0, 10) >= from).length; };
  out.activity = { sales_60: win(2), sales_120: win(4), sales_180: win(6), touches_60: touches(60), touches_120: touches(120), touches_180: touches(180) };
  const recent = {}; for(const x of withAmt.filter(x => String(x.period || "").slice(0, 7) >= monthsBack(today, 6))){ const k = String(x.product_name || "").trim(); if(k) recent[k] = (recent[k] || 0) + Number(x.amount || 0); }
  const rp = Object.entries(recent).sort((a, z) => z[1] - a[1]).slice(0, 4).map(e => e[0]);
  if(rp.length) out.recent_products = rp;
  const ot = d.tasks || []; if(ot.length) out.open_tasks = { count: ot.length, top: ot.slice(0, 3).map(t => ({ title: t.title, due_date: t.due_date || null })) };
  const oo = d.opps || []; if(oo.length) out.open_opportunities = { count: oo.length, value: Math.round(oo.reduce((a, o) => a + Number(o.value || 0), 0)), top: oo.slice(0, 3).map(o => ({ title: o.title, stage: o.stage })) };
  const notes = (d.notes || []).slice(0, 2).map(n => ({ date: String(n.created_at || "").slice(0, 10), text: String(n.body || "").replace(/\s+/g, " ").slice(0, 160) }));
  if(notes.length) out.recent_notes = notes;
  if(d.health) out.trend = { status: d.health.status || null, trend: d.health.trend != null ? d.health.trend : null, score: d.health.score != null ? d.health.score : null };
  if(d.cross) out.crossover = { line: d.cross.rec_name, because: d.cross.basis_name || null };
  const cs = (d.contacts || []).slice(0, 4).map(c => ({ name: c.name || c.email, title: c.title || null, phone: c.phone || c.cell || null }));
  if(cs.length) out.contacts = cs;
  return out;
}

function oppAttention(o, today){
  const reasons = [];
  if(o.expected_close && o.expected_close < today) reasons.push("Close date passed");
  else if(o.expected_close && o.expected_close <= addDays(today, 14)) reasons.push("Closes " + o.expected_close);
  if(o.next_step_date && o.next_step_date <= today) reasons.push("Next step due");
  if(o.origin_type === "visit_report" && String(o.stage) === "identified" && String(o.created_at || "").slice(0, 10) >= addDays(today, -7)) reasons.push("New from a visit");
  const touched = String(o.updated_at || o.created_at || "").slice(0, 10);
  if(touched && touched < addDays(today, -30)) reasons.push("No update in 30+ days");
  return reasons;
}

function priorities(ctx){
  const { today, tasks, followups, opps, appointments, names } = ctx;
  const P = [];
  for(const t of tasks){
    const overdue = t.due_date && t.due_date < today, dueToday = t.due_date === today;
    if(!(overdue || dueToday || String(t.priority) === "high")) continue;
    P.push({ kind: "task", id: t.id, title: t.title, dealer_id: t.dealer_id, dealer: names[t.dealer_id] || "", due: t.due_date || null,
      why: overdue ? "Overdue" : dueToday ? "Due today" : "High priority", rank: (overdue ? 0 : dueToday ? 1 : 3) * 10 + (PRANK[String(t.priority || "normal")] ?? 1) });
  }
  for(const f of followups){ if(f.followup_due && f.followup_due <= today)
    P.push({ kind: "followup", id: f.id, title: "Finish visit follow-up", dealer_id: f.dealer_id, dealer: names[f.dealer_id] || "", due: f.followup_due, why: f.followup_due < today ? "Follow-up overdue" : "Follow-up due today", rank: 5 }); }
  for(const a of appointments) P.push({ kind: "appointment", id: a.id, title: a.service || a.meeting_type || "Appointment", dealer_id: a.dealer_id, dealer: names[a.dealer_id] || "", due: a.start_at, why: "Booked today", rank: 2 });
  for(const o of opps){ const why = oppAttention(o, today); if(why.some(w => /passed|due/i.test(w)))
    P.push({ kind: "opportunity", id: o.id, title: o.title, dealer_id: o.dealer_id, dealer: names[o.dealer_id] || "", due: o.expected_close || o.next_step_date || null, why: why[0], rank: 15 }); }
  return P.sort((a, z) => a.rank - z.rank || String(a.due || "9").localeCompare(String(z.due || "9"))).slice(0, 10).map(({ rank, ...x }) => x);
}

/* Today's Follow-Up Progress: the actions today's visits created plus what was due today. */
function followupProgress(ctx){
  const { today, todaysReportIds, tasksOpenMine, tasksClosedToday, originTasksToday } = ctx;
  const ids = new Set(todaysReportIds.map(String));
  const fromVisits = originTasksToday.filter(t => ids.has(String(t.origin_id)));
  const dueToday = tasksOpenMine.filter(t => t.due_date === today).concat(tasksClosedToday.filter(t => t.due_date === today));
  const all = new Map(); for(const t of fromVisits.concat(dueToday)) all.set(String(t.id), t);
  const total = all.size, done = [...all.values()].filter(t => t.status === "done" || t.status === "dismissed").length;
  return { total, completed: done, label: total ? `${done} of ${total} actions completed` : "No follow-up actions yet today" };
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b={}; try{ b=JSON.parse(event.body||"{}"); }catch(e){ return json(400,{error:"bad JSON"}); }
    const canPick=SC.seesAllDealers(me);   // management + Customer Relations (Phase 0 matrix)

    if(b.action==="reps"){
      if(!canPick) return json(200,{ok:true,reps:[]});
      const s=await sbGet("staff_users?active=eq.true&select=email,name,rep_name,role&order=name").catch(()=>[]);
      return json(200,{ok:true,reps:(s||[]).filter(x=>x.email).map(x=>({email:low(x.email),name:x.name||x.rep_name||x.email,role:x.role||"rep"}))});
    }
    if(b.action!=="today") return json(400,{error:"unknown action"});

    // The person whose day this is.
    let who={email:low(me.email),rep_name:String(me.rep_name||"").trim(),name:me.name||me.email,role:me.role};
    if(b.rep && canPick && low(b.rep)!==who.email){
      const s=await sbGet(`staff_users?email=eq.${enc(low(b.rep))}&select=email,name,rep_name,role,active`).catch(()=>[]);
      const su=s&&s[0]; if(!su||su.active===false) return json(404,{error:"No active staff member with that email."});
      who={email:low(su.email),rep_name:String(su.rep_name||"").trim(),name:su.name||su.email,role:su.role||"rep"};
    }
    if(!who.email) return json(200,{ok:true,empty:true,message:"Your account has no email on file."});
    const today=ISO.test(String(b.date||""))?String(b.date):new Date().toISOString().slice(0,10);
    const tomorrow=addDays(today,1);
    const hour=Number.isFinite(Number(b.hour))?Number(b.hour):null;
    const E=enc(who.email), rn=who.rep_name.replace(/[,()"]/g,"");
    const nameLike=rn?enc("*"+rn+"*"):null;
    const mineTasks=[`assigned_email.eq.${E}`, nameLike?`assigned_rep.ilike.${nameLike}`:null].filter(Boolean).join(",");
    const mineOpps=[`owner_email.eq.${E}`, nameLike?`owner_rep.ilike.${nameLike}`:null].filter(Boolean).join(",");
    const isMineT=t=>low(t.assigned_email)===who.email || (rn && low(t.assigned_rep)===low(rn));
    const isMineO=o=>low(o.owner_email)===who.email || (rn && low(o.owner_rep)===low(rn));
    // The rep's own day: b.tz is the browser's getTimezoneOffset() in minutes (Eastern = 300 / 240).
    const tzMin=Number.isFinite(Number(b.tz))?Math.max(-840,Math.min(840,Number(b.tz))):300;
    const dayStartMs=Date.parse(today+"T00:00:00Z")+tzMin*60000, dayEndMs=dayStartMs+86400000;
    const sinceIso=new Date(dayStartMs).toISOString(), untilIso=new Date(dayEndMs).toISOString();
    const inDay=iso=>{ const t=Date.parse(String(iso||"")); return Number.isFinite(t)&&t>=dayStartMs&&t<dayEndMs; };

    // ---- Round 1: everything keyed by the person (parallel, paged) ----
    const [routes,tasksOpen,tasksClosed,opps,myVisits,pendingFU,appts]=await Promise.all([
      sbGet(`rep_routes?scheduled_date=in.(${today},${tomorrow})&or=(owner_email.eq.${E},assigned_to_email.eq.${E})&select=id,name,scheduled_date,stops,owner_email,assigned_to_email,round_trip,home_base&order=updated_at.desc&limit=20`).catch(()=>[]),
      getAll(`dealer_tasks?status=eq.open&or=(${mineTasks})&select=id,dealer_id,title,due_date,priority,source,reason,assigned_rep,assigned_email,origin_type,origin_id,created_at,status`,"id").catch(()=>[]),
      getAll(`dealer_tasks?status=in.(done,dismissed)&done_at=gte.${enc(sinceIso)}&or=(${mineTasks})&select=id,dealer_id,title,due_date,status,origin_type,origin_id,assigned_rep,assigned_email,done_at`,"id").catch(()=>[]),
      getAll(`opportunities?status=eq.open&or=(${mineOpps})&select=id,dealer_id,title,stage,value,expected_close,next_step,next_step_date,origin_type,origin_id,owner_rep,owner_email,created_at,updated_at`,"id").catch(()=>[]),
      getAll(`dealer_visit_reports?rep_email=eq.${E}&checkin_at=gte.${enc(sinceIso)}&select=id,route_id,dealer_id,checkin_at,ended_at,completed_at,approved_at,duration_min,status,summary,followup_status,followup_due,followup_email`,"id").catch(()=>[]),
      getAll(`dealer_visit_reports?rep_email=eq.${E}&followup_status=eq.pending&select=id,dealer_id,checkin_at,followup_due,summary`,"id").catch(()=>[]),
      sbGet(`service_requests?owner_email=eq.${E}&start_at=gte.${enc(sinceIso)}&start_at=lt.${enc(untilIso)}&select=id,dealer_id,service,meeting_type,start_at,end_at,status&order=start_at&limit=20`).catch(()=>[]),
    ]);
    // Only the person's routes: assigned to them, or built by them for nobody else.
    const mineRoutes=(routes||[]).filter(r=>r.assigned_to_email ? low(r.assigned_to_email)===who.email : low(r.owner_email)===who.email);
    const todayRoute=mineRoutes.find(r=>r.scheduled_date===today)||null;
    const tomorrowRoute=mineRoutes.find(r=>r.scheduled_date===tomorrow)||null;
    const tasks=(tasksOpen||[]).filter(isMineT);
    const closedToday=(tasksClosed||[]).filter(isMineT);
    const myOpps=(opps||[]).filter(isMineO);
    const stopsToday=todayRoute&&Array.isArray(todayRoute.stops)?todayRoute.stops.filter(s=>s&&s.dealer_id):[];
    const stopsTomorrow=tomorrowRoute&&Array.isArray(tomorrowRoute.stops)?tomorrowRoute.stops.filter(s=>s&&s.dealer_id):[];
    const prepIds=[...new Set(stopsToday.map(s=>String(s.dealer_id)))].slice(0,30);
    const todaysVisits=(myVisits||[]).filter(v=>inDay(v.checkin_at));

    // ---- Round 2: route-stop dealers (Meeting Prep) and the visits' own links (parallel) ----
    const from6=monthsBack(today,7)+"-01", since180=addDays(today,-180);
    const visitIds=[...new Set(todaysVisits.map(v=>v.id).concat((pendingFU||[]).map(v=>v.id)))];
    const [routeReports,pv,ps,po,pt,pop,pn,pe,pc,pcon,pa,originTasks,originOpps,partsToday]=await Promise.all([
      todayRoute?sbGet(`dealer_visit_reports?route_id=eq.${enc(todayRoute.id)}&select=id,dealer_id,checkin_at,ended_at,completed_at,approved_at,status,duration_min,followup_status`).catch(()=>[]):[],
      byIds("dealer_visit_reports","dealer_id",prepIds,"id,dealer_id,checkin_at,completed_at,approved_at,rep_name,summary,fields","&completed_at=not.is.null"),
      byIds("monthly_sales","dealer_id",prepIds,"dealer_id,period,amount,product_name",`&period=gte.${from6}`),
      byIds("orders","dealer_id",prepIds,"id,dealer_id,submitted_at"),
      byIds("dealer_tasks","dealer_id",prepIds,"id,dealer_id,title,due_date,priority","&status=eq.open"),
      byIds("opportunities","dealer_id",prepIds,"id,dealer_id,title,stage,value","&status=eq.open"),
      byIds("dealer_notes","dealer_id",prepIds,"id,dealer_id,body,created_at",`&created_at=gte.${since180}`),
      byIds("dealer_engagement","dealer_id",prepIds,"dealer_id,status,trend,score"),
      byIds("cross_sell","dealer_id",prepIds,"dealer_id,rec_name,basis_name,rank","&rank=eq.1"),
      byIds("dealer_contacts","dealer_id",prepIds,"id,dealer_id,name,email,title,phone,cell"),
      byIds("dealer_activity","dealer_id",prepIds,"id,dealer_id,kind,created_at",`&kind=in.(call,visit,email,meeting,note)&created_at=gte.${since180}`),
      byIds("dealer_tasks","origin_id",visitIds,"id,origin_id,title,status,due_date","&origin_type=eq.visit_report"),
      byIds("opportunities","origin_id",visitIds,"id,origin_id,title,stage,value","&origin_type=eq.visit_report"),
      byIds("dealer_visit_participants","visit_report_id",todaysVisits.map(v=>v.id),"visit_report_id,name_snapshot,contact_id"),
    ]);

    // Dealer names for everything shown.
    const nameIds=[].concat(stopsToday.map(s=>s.dealer_id),stopsTomorrow.map(s=>s.dealer_id),tasks.map(t=>t.dealer_id),myOpps.map(o=>o.dealer_id),
      todaysVisits.map(v=>v.dealer_id),(pendingFU||[]).map(v=>v.dealer_id),(appts||[]).map(a=>a.dealer_id));
    const nrows=await byIds("dealers","id",nameIds,"id,business_name,city,state");
    const names={}, place={}; for(const d of nrows){ names[d.id]=d.business_name; place[d.id]=[d.city,d.state].filter(Boolean).join(", "); }

    // ---- Panels ----
    const vByDealer={}; for(const v of (routeReports||[])) vByDealer[String(v.dealer_id)]=v;
    const route=todayRoute?{id:todayRoute.id,name:todayRoute.name,date:todayRoute.scheduled_date,
      stops:stopsToday.map((s,i)=>{ const v=vByDealer[String(s.dealer_id)]||null; return {order:i+1,dealer_id:s.dealer_id,name:s.name||names[s.dealer_id]||"",
        place:[s.city,s.state].filter(Boolean).join(", ")||place[s.dealer_id]||"",visit_min:s.visit_min!=null?s.visit_min:null,overnight:!!s.overnight,
        status:stopStatus(v),started_at:v&&v.checkin_at||null,duration_min:v&&v.duration_min!=null?v.duration_min:null,followup_status:v&&v.followup_status||null}; })}:null;

    const group=(arr,k)=>{ const m={}; for(const x of (arr||[])){ (m[String(x[k])]=m[String(x[k])]||[]).push(x); } return m; };
    const G={visits:group(pv,"dealer_id"),sales:group(ps,"dealer_id"),orders:group(po,"dealer_id"),tasks:group(pt,"dealer_id"),opps:group(pop,"dealer_id"),
      notes:group((pn||[]).sort((a,z)=>String(z.created_at).localeCompare(String(a.created_at))),"dealer_id"),health:group(pe,"dealer_id"),cross:group(pc,"dealer_id"),
      contacts:group(pcon,"dealer_id"),activity:group(pa,"dealer_id")};
    const prep=prepIds.map(id=>Object.assign({name:names[id]||""},buildPrep(id,{visits:G.visits[id],sales:G.sales[id],orders:G.orders[id],tasks:G.tasks[id],opps:G.opps[id],
      notes:G.notes[id],health:(G.health[id]||[])[0],cross:(G.cross[id]||[])[0],contacts:G.contacts[id],activity:G.activity[id]},today)));

    const counts={planned:0,on_site:0,ended:0,done:0}; for(const s of (route?route.stops:[])) counts[s.status]=(counts[s.status]||0)+1;
    const tByVisit=group(originTasks,"origin_id"), oByVisit=group(originOpps,"origin_id"), pByVisit=group(partsToday,"visit_report_id");
    const visitActivity=todaysVisits.slice()
      .sort((a,z)=>String(z.checkin_at).localeCompare(String(a.checkin_at))).map(v=>({id:v.id,dealer_id:v.dealer_id,dealer:names[v.dealer_id]||"",
        started_at:v.checkin_at,ended_at:v.ended_at||null,duration_min:v.duration_min!=null?v.duration_min:null,status:stopStatus(v),
        summary:String((v.summary&&v.summary.meeting_summary)||"").slice(0,240)||null,
        attendees:(pByVisit[v.id]||[]).map(p=>p.name_snapshot),contacts_added:((v.summary&&v.summary.contacts_added)||[]).length,
        tasks:(tByVisit[v.id]||[]).length,opportunities:(oByVisit[v.id]||[]).length,followup_status:v.followup_status||null,
        email_sent:!!(v.followup_email&&v.followup_email.sent_at),email_drafted:!!(v.followup_email&&v.followup_email.saved_at)}));

    const followQueue=(pendingFU||[]).sort((a,z)=>String(a.followup_due||"9999").localeCompare(String(z.followup_due||"9999"))||String(z.checkin_at).localeCompare(String(a.checkin_at)))
      .slice(0,30).map(v=>({id:v.id,dealer_id:v.dealer_id,dealer:names[v.dealer_id]||"",visit_date:String(v.checkin_at||"").slice(0,10),due:v.followup_due||null,
        commitments:{rep:((v.summary&&v.summary.rep_commitments)||[]).map(c=>c.text).slice(0,4),dealer:((v.summary&&v.summary.dealer_commitments)||[]).map(c=>c.text).slice(0,4)},
        open_tasks:(tByVisit[v.id]||[]).filter(t=>t.status==="open").map(t=>({id:t.id,title:t.title,due_date:t.due_date||null})),
        opportunities:(oByVisit[v.id]||[]).map(o=>({id:o.id,title:o.title,stage:o.stage}))}));
    const soon=addDays(today,3);
    const dueSoon=tasks.filter(t=>t.due_date&&t.due_date<=soon&&!(t.origin_type==="visit_report"&&followQueue.some(f=>String(f.id)===String(t.origin_id))))
      .sort((a,z)=>String(a.due_date).localeCompare(String(z.due_date))).slice(0,20).map(t=>({id:t.id,title:t.title,dealer_id:t.dealer_id,dealer:names[t.dealer_id]||"",due_date:t.due_date,priority:t.priority||"normal",source:t.source||null}));

    const oppList=myOpps.map(o=>({o,why:oppAttention(o,today)})).filter(x=>x.why.length)
      .sort((a,z)=>String(a.o.expected_close||"9999").localeCompare(String(z.o.expected_close||"9999"))).slice(0,12)
      .map(({o,why})=>({id:o.id,title:o.title,dealer_id:o.dealer_id,dealer:names[o.dealer_id]||"",stage:o.stage,value:Number(o.value)||0,expected_close:o.expected_close||null,next_step:o.next_step||null,why}));
    const weighted=Math.round(myOpps.reduce((a,o)=>a+(Number(o.value)||0)*(STAGE_PROB[o.stage]??0.1),0));

    const todaysIds=visitActivity.map(v=>v.id);
    const progress=followupProgress({today,todaysReportIds:todaysIds,tasksOpenMine:tasks,tasksClosedToday:closedToday,
      originTasksToday:(originTasks||[]).filter(t=>todaysIds.includes(String(t.origin_id)))});
    const eod={progress,visits_completed:visitActivity.filter(v=>v.status==="done").length,visits_started:visitActivity.length,
      tasks_completed:closedToday.filter(t=>t.status==="done").length,tasks_created_from_visits:visitActivity.reduce((a,v)=>a+v.tasks,0),
      opportunities_created:visitActivity.reduce((a,v)=>a+v.opportunities,0),contacts_added:visitActivity.reduce((a,v)=>a+v.contacts_added,0),
      followup_emails_sent:visitActivity.filter(v=>v.email_sent).length,followup_emails_drafted:visitActivity.filter(v=>v.email_drafted&&!v.email_sent).length,
      rep_commitments:todaysVisits.reduce((a,v)=>a+((v.summary&&v.summary.rep_commitments)||[]).length,0),
      dealer_commitments:todaysVisits.reduce((a,v)=>a+((v.summary&&v.summary.dealer_commitments)||[]).length,0)};

    const overdue=tasks.filter(t=>t.due_date&&t.due_date<today).length, dueToday=tasks.filter(t=>t.due_date===today).length;
    const header={date:today,rep:{email:who.email,name:who.name,rep_name:who.rep_name},viewing_other:who.email!==low(me.email),
      stops:route?route.stops.length:0,first_stop:route&&route.stops[0]?route.stops[0].name:null,
      open_tasks:tasks.length,overdue,due_today:dueToday,followups_pending:(pendingFU||[]).length,
      opportunities_open:myOpps.length,opportunities_attention:oppList.length,pipeline_weighted:weighted,appointments:(appts||[]).length};
    const phase=(counts.on_site||counts.ended||counts.done||visitActivity.length)
      ? ((route&&counts.planned===0&&!counts.on_site)||(hour!=null&&hour>=16) ? "wrap" : "field") : (hour!=null&&hour>=16?"wrap":"morning");

    const tomorrowPrev=tomorrowRoute?{id:tomorrowRoute.id,name:tomorrowRoute.name,date:tomorrowRoute.scheduled_date,stops:stopsTomorrow.length,
      first_stop:stopsTomorrow[0]?(stopsTomorrow[0].name||names[stopsTomorrow[0].dealer_id]||""):null,
      dealers:stopsTomorrow.slice(0,12).map(s=>({dealer_id:s.dealer_id,name:s.name||names[s.dealer_id]||"",place:[s.city,s.state].filter(Boolean).join(", ")||place[s.dealer_id]||""})),
      tasks_due:tasks.filter(t=>t.due_date===tomorrow).length}:{stops:0,tasks_due:tasks.filter(t=>t.due_date===tomorrow).length};

    return json(200,{ok:true,phase,header,
      priorities:priorities({today,tasks,followups:pendingFU||[],opps:myOpps,appointments:appts||[],names}),
      route,prep,visit_progress:{counts,total:route?route.stops.length:0,off_route:visitActivity.filter(v=>!(route&&route.stops.some(s=>String(s.dealer_id)===String(v.dealer_id)))).length},
      visit_activity:visitActivity,followup_queue:{visits:followQueue,tasks_due_soon:dueSoon},
      opportunities:{needs_attention:oppList,open:myOpps.length,weighted},end_of_day:eod,tomorrow:tomorrowPrev,appointments:appts||[]});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

module.exports.__test = { buildPrep, oppAttention, priorities, followupProgress, stopStatus };

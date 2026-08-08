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
      const [notes,tasks,activity]=await Promise.all([
        sbGet(`dealer_notes?dealer_id=eq.${did}&select=*&order=created_at.desc&limit=200`).catch(()=>[]),
        sbGet(`dealer_tasks?dealer_id=eq.${did}&select=*&order=status.asc,due_date.asc.nullslast,created_at.desc&limit=200`).catch(()=>[]),
        sbGet(`dealer_activity?dealer_id=eq.${did}&select=*&order=created_at.desc&limit=50`).catch(()=>[]),
      ]);
      return json(200,{ok:true,notes:notes||[],tasks:tasks||[],activity:activity||[]});
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
      const [mfrs,dealers,aliases,dir]=await Promise.all([
        sbGet("manufacturers?select=slug,name").catch(()=>[]),
        sbGetAll("dealers?select=id,business_name,parent_id"),
        sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
        sbGet("dealer_directory?select=dealer_name,rep_name").catch(()=>[]),
      ]);
      const mfrName={}; for(const m of mfrs) mfrName[m.slug]=m.name||m.slug;
      const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
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
      const NOW=Date.now(); const desired=new Map();
      for(const [id,o] of DL){
        const rep=repByName[nameById[id]]||null; const sig=new Map();
        const ov=[]; for(const [slug,ln] of o.lines){ const pms=[...ln.pms].sort((a,b)=>a-b); if(pms.length<2)continue; const gaps=[]; for(let i=1;i<pms.length;i++)gaps.push(pms[i]-pms[i-1]); const cyc=median(gaps); if(cyc==null||cyc<=0)continue; const since=latest-pms[pms.length-1]; if(since>=cyc+Math.max(1,Math.round(cyc*0.5))) ov.push({slug,since,cyc,sales:ln.sales}); }
        ov.sort((a,b)=>b.sales-a.sales);
        for(const x of ov.slice(0,3)){ const line=mfrName[x.slug]||x.slug; sig.set("overdue:"+x.slug,{title:`Reorder due — ${line}`,detail:`Usually orders ~${Math.round(x.cyc)}mo; ${x.since}mo since last ${line} order.`,priority:x.sales>20000?"high":"normal",rep}); }
        const monthsSince=latest-o.last;
        if(monthsSince>=3) sig.set("dormant",{title:"Dormant account — re-engage",detail:`No orders in ${monthsSince} months.`,priority:o.sales>50000?"high":"normal",rep});
        const cart=cartBy[id]; if(cart) sig.set("intent_cart",{title:"Open cart — follow up",detail:`${cart.items} item(s), ~$${Math.round(cart.val)} in cart on the portal.`,priority:"high",rep});
        const seen=seenBy[id]; if(seen && (NOW-seen)<21*864e5) sig.set("intent_login",{title:"Recent login — reach out",detail:`Logged in ${new Date(seen).toISOString().slice(0,10)}.`,priority:"normal",rep});
        if((latest-o.first)<=2) sig.set("new",{title:"New account — onboard",detail:"First order in the last 2 months.",priority:"normal",rep});
        if(sig.size) desired.set(id,sig);
      }
      const existing=await sbGetAll("dealer_tasks?source=eq.auto&status=eq.open&select=id,dealer_id,reason","id").catch(()=>[]);
      const existKey=new Set(); for(const t of existing) existKey.add(t.dealer_id+"|"+t.reason);
      const toCreate=[];
      for(const [id,sig] of desired){ for(const [reason,f] of sig){ if(!existKey.has(id+"|"+reason)) toCreate.push({dealer_id:id,title:f.title,detail:f.detail,priority:f.priority,source:"auto",reason,assigned_rep:f.rep||null,created_by:"Follow-up engine",status:"open"}); } }
      let created=0; for(let i=0;i<toCreate.length;i+=200){ const part=toCreate.slice(i,i+200); try{ await sbSend("POST","dealer_tasks",part,{Prefer:"return=minimal"}); created+=part.length; }catch(e){} }
      let closed=0; for(const t of existing){ const sig=desired.get(t.dealer_id); if(!(sig&&sig.has(t.reason))){ try{ await sbSend("PATCH",`dealer_tasks?id=eq.${encodeURIComponent(t.id)}`,{status:"dismissed",done_at:new Date().toISOString()},{Prefer:"return=minimal"}); closed++; }catch(e){} } }
      return json(200,{ok:true,dealers_flagged:desired.size,created,dismissed:closed,open_auto:(existing.length-closed)+created});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

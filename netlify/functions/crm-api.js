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
      const [notes,tasks]=await Promise.all([
        sbGet(`dealer_notes?dealer_id=eq.${did}&select=*&order=created_at.desc&limit=200`).catch(()=>[]),
        sbGet(`dealer_tasks?dealer_id=eq.${did}&select=*&order=status.asc,due_date.asc.nullslast,created_at.desc&limit=200`).catch(()=>[]),
      ]);
      return json(200,{ok:true,notes:notes||[],tasks:tasks||[]});
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
      let q=`dealer_tasks?status=eq.${status}&select=*&order=due_date.asc.nullslast,created_at.desc&limit=500`;
      let tasks=await sbGet(q).catch(()=>[]);
      if(me.role!=="president" && me.rep_name){ const rn=me.rep_name.toLowerCase(); tasks=(tasks||[]).filter(t=>String(t.assigned_rep||"").toLowerCase()===rn); }
      return json(200,{ok:true,tasks:tasks||[]});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

// HCPS Connect 360 — Rep usage capture (Phase 3).
// Records staff/rep app usage that nothing else logs: sign-in sessions (login time, last-seen,
// real active-time) and which tools/dealers a rep opened. Identity is ALWAYS taken from the
// signed-in JWT (never from the request body), so a rep can only write their own activity.
//
//   POST {action:"session_start", user_agent?}          -> {ok, id}  (start/adopt a session)
//   POST {action:"session_ping",  id, active_seconds}   -> {ok}      (heartbeat: last-seen + active time)
//   POST {action:"track", kind, tool, dealer_id?, meta?}-> {ok}      (a tool/page or dealer view)
//
// Best-effort and silent by design: if the tables aren't created yet it returns ok:false and the
// client tracker just ignores it — usage capture never breaks a page.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||400):null; };
const tablesMissing=e=>/relation|does not exist|schema cache|could not find the table/i.test(String(e&&e.message||e));

// Same staff-JWT check every function uses: validate the Bearer against Supabase, then load the staff row.
async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
      if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,rep_name,name,active`).catch(()=>[]); const su=s&&s[0];
        if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email}; } }
  }catch(e){}
  return null;
}

exports.handler = async (event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{ok:false,error:"unauthorized"});
    let b; try{ b=JSON.parse(event.body||"{}"); }catch{ return json(400,{ok:false,error:"bad JSON"}); }
    const ua=(event.headers["user-agent"]||event.headers["User-Agent"]||"");

    if(b.action==="session_start"){
      try{
        const row=await sbSend("POST","staff_sessions",{
          email:me.email, rep_name:me.rep_name||null, role:me.role||null,
          user_agent:clean(b.user_agent||ua,400)
        },{Prefer:"return=representation"});
        const id=(row&&row[0]&&row[0].id)||null;
        return json(200,{ok:!!id,id});
      }catch(e){ return json(200,{ok:false,error:tablesMissing(e)?"tables_missing":"write_failed"}); }
    }

    if(b.action==="session_ping"){
      const id=clean(b.id,80); if(!id) return json(400,{ok:false,error:"id required"});
      const secs=Math.max(0,Math.min(parseInt(b.active_seconds,10)||0, 86400)); // cap a day
      try{
        await sbSend("PATCH",`staff_sessions?id=eq.${encodeURIComponent(id)}&email=eq.${encodeURIComponent(me.email)}`,
          { last_seen_at:new Date().toISOString(), active_seconds:secs },{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }catch(e){ return json(200,{ok:false,error:tablesMissing(e)?"tables_missing":"write_failed"}); }
    }

    if(b.action==="track"){
      const kind = (b.kind==="dealer"||b.kind==="dealer_view") ? "dealer_view" : "view";
      try{
        await sbSend("POST","rep_activity",{
          email:me.email, rep_name:me.rep_name||null, role:me.role||null,
          action:kind, tool:clean(b.tool,120), dealer_id:clean(b.dealer_id,80)||null,
          meta:(b.meta&&typeof b.meta==="object")?b.meta:null
        },{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }catch(e){ return json(200,{ok:false,error:tablesMissing(e)?"tables_missing":"write_failed"}); }
    }

    return json(400,{ok:false,error:"unknown action"});
  }catch(e){ return json(200,{ok:false,error:String(e&&e.message||e)}); }
};

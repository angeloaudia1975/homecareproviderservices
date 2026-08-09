// HCPS Activation / Go-Live Control — admin API.
//   POST {action:"get"}            -> current platform state (any signed-in staff)
//   POST {action:"set", mode}      -> change mode; switching to "live" requires the
//                                     president role and stamps go_live_at once.
// Auth: staff Supabase JWT -> staff_users(role,active), same as the other admin APIs.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const P=require("./_platform.js");

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{
    const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(!r.ok) return null; const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase(); if(!email) return null;
    const s=await fetch(`${SUPABASE_URL}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=role,active`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`}}).then(r=>r.json()).catch(()=>[]);
    const su=s&&s[0]; if(su&&su.active!==false) return {role:su.role||"rep",email};
  }catch(e){}
  return null;
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{b={};}

    if(b.action==="get" || !b.action){
      const st=await P.getState();
      return json(200,{ok:true,...st,role:me.role});
    }
    if(b.action==="set"){
      const mode=String(b.mode||"").toLowerCase();
      if(!P.MODES.includes(mode)) return json(400,{ok:false,error:"invalid mode"});
      // Only the president may take the platform Live (it starts the official record).
      if(mode==="live" && me.role!=="president") return json(200,{ok:false,message:"Only the president can activate Live mode."});
      const res=await P.setMode(mode,me.email,new Date().toISOString());
      return json(200,{ok:true,...res});
    }
    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

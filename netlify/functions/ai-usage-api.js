// HCPS — Claude AI usage & credit tracker. President/admin only. Reads the Anthropic organization
// Cost API (all API + Claude Code + Workbench spend) and computes a running balance against the
// credits you've purchased. Anthropic has NO live-balance endpoint, so "balance" = purchased − spend.
//
//   POST {action:"report"}                         -> { ok, spend_month, spend_since, daily, balance, ... }
//   POST {action:"set_credits", purchased, since}  -> { ok }   (save the purchased-credits config)
//
// Env: ANTHROPIC_ADMIN_KEY  (an Admin API key, sk-ant-admin… — different from ANTHROPIC_API_KEY).
// The admin key is powerful (org-level); it is used server-side only and never sent to the browser.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY || "";

const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
const { isAdmin } = require("./_scope.js");

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,active`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",email}; } } }catch(e){}
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",email:""};
  return null;
}

async function anthGet(path){
  const r=await fetch(`https://api.anthropic.com${path}`,{headers:{"x-api-key":ADMIN_KEY,"anthropic-version":"2023-06-01"}});
  const t=await r.text(); let j={}; try{ j=JSON.parse(t); }catch(e){}
  return {ok:r.ok,status:r.status,json:j,text:t};
}
// The cost report returns amounts in USD cents (lowest units) as decimal strings. Sum a bucket → cents.
function sumCents(bucket){
  let c=0; const rs=(bucket&&(bucket.results||bucket.result))||[];
  for(const r of rs){ const v=Number(r&&(r.amount!=null?r.amount:(r.cost!=null?r.cost:r.value))); if(isFinite(v)) c+=v; }
  return c;
}

exports.handler=async(event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    if(!isAdmin(me)) return json(403,{error:"President only"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    // Read the credits config (how much has been purchased, and the date to start counting spend from).
    let cfg={}; try{ const r=await sbGet("app_settings?key=eq.ai_credits&select=value"); if(r&&r[0]&&r[0].value&&typeof r[0].value==="object") cfg=r[0].value; }catch(e){}

    if(b.action==="set_credits"){
      const purchased=(b.purchased===""||b.purchased==null)?null:Number(b.purchased);
      const since=String(b.since||"").slice(0,10);
      const value={ purchased:(isFinite(purchased)?purchased:null), since:(/^\d{4}-\d{2}-\d{2}$/.test(since)?since:(cfg.since||null)) };
      await sbSend("POST","app_settings?on_conflict=key",{key:"ai_credits",value,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true,...value});
    }

    // ---- report ----
    const now=new Date();
    const nowISO=now.toISOString();
    const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString().slice(0,10);
    const since = (cfg.since && /^\d{4}-\d{2}-\d{2}$/.test(cfg.since)) ? cfg.since : monthStart;
    const purchased = (cfg.purchased!=null && isFinite(Number(cfg.purchased))) ? Number(cfg.purchased) : null;

    if(!ADMIN_KEY){
      return json(200,{ok:false,error:"admin_key_missing",
        message:"Add an Anthropic Admin API key as ANTHROPIC_ADMIN_KEY in Netlify to show live spend. Create one in the Claude Console → Settings → Admin keys (org admins only).",
        since, purchased});
    }

    // Cost report, day-buckets, since -> now (page through in case >31 days).
    const startISO = new Date(since+"T00:00:00Z").toISOString();
    let daily=[], totalCents=0, page=null, guard=0, apiError=null;
    do{
      const qs=`starting_at=${encodeURIComponent(startISO)}&ending_at=${encodeURIComponent(nowISO)}`+(page?`&page=${encodeURIComponent(page)}`:"");
      const r=await anthGet(`/v1/organizations/cost_report?${qs}`);
      if(!r.ok){
        apiError={ status:r.status,
          error: r.status===401?"admin_key_invalid":(r.status===403?"admin_key_forbidden":"cost_api_error"),
          message: r.status===401?"The ANTHROPIC_ADMIN_KEY was rejected — check it's a valid Admin key (sk-ant-admin…)."
                 : r.status===403?"That key isn't an org Admin key — usage reporting needs an Admin API key."
                 : ("Anthropic cost API error: "+(((r.json||{}).error||{}).message||r.text.slice(0,160))) };
        break;
      }
      const data=(r.json&&r.json.data)||[];
      for(const bk of data){ const cents=sumCents(bk); totalCents+=cents; const day=String(bk.starting_at||bk.date||"").slice(0,10); if(day) daily.push({date:day,usd:Math.round(cents)/100}); }
      page = r.json && r.json.has_more ? (r.json.next_page||r.json.next||null) : null;
    } while(page && ++guard<12);

    if(apiError) return json(200,{ok:false,...apiError,since,purchased});

    daily.sort((a,b)=>a.date<b.date?-1:1);
    const spend_since = Math.round(totalCents)/100;
    const ym = nowISO.slice(0,7);
    const spend_month = Math.round(daily.filter(d=>d.date.slice(0,7)===ym).reduce((s,d)=>s+d.usd*100,0))/100;
    const spend_7 = (()=>{ const cut=new Date(now.getTime()-7*864e5).toISOString().slice(0,10); return Math.round(daily.filter(d=>d.date>=cut).reduce((s,d)=>s+d.usd*100,0))/100; })();
    const balance = purchased!=null ? Math.round((purchased-spend_since)*100)/100 : null;

    return json(200,{ ok:true, currency:"USD", updated:nowISO, since, purchased,
      spend_since, spend_month, spend_7, balance,
      daily: daily.slice(-30) });
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

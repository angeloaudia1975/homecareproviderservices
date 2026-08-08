// HCPS Website Traffic API — proxies Plausible's Stats API server-side so the API key never
// reaches the browser. Staff-authenticated. Returns KPIs, a visitors timeseries, top pages,
// and top sources for the chosen period. Until the env vars are set it reports not-configured.
//
// Netlify env vars:
//   PLAUSIBLE_API_KEY   Plausible Stats API key (Bearer).
//   PLAUSIBLE_SITE_ID   The site's domain in Plausible (e.g. homecareproviderservices.us).
//   PLAUSIBLE_API_BASE  Optional — defaults to https://plausible.io (set for self-hosted).
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const KEY=process.env.PLAUSIBLE_API_KEY, SITE=process.env.PLAUSIBLE_SITE_ID;
const BASE=(process.env.PLAUSIBLE_API_BASE||"https://plausible.io").replace(/\/+$/,"");
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await fetch(`${SUPABASE_URL}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=role,active`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`}}).then(r=>r.json()).catch(()=>[]);
          const su=s&&s[0]; if(su&&su.active!==false) return {role:su.role||"rep",email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",email:""};
  return null;
}

async function pget(path){
  const r=await fetch(`${BASE}${path}`,{headers:{Authorization:`Bearer ${KEY}`}});
  const t=await r.text(); let j=null; try{ j=t?JSON.parse(t):null; }catch(e){ j={raw:t}; }
  return {ok:r.ok,status:r.status,json:j};
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    if(!KEY||!SITE) return json(200,{ok:true,configured:false,
      message:"Set PLAUSIBLE_API_KEY and PLAUSIBLE_SITE_ID in Netlify, then reload."});
    let b; try{b=JSON.parse(event.body||"{}");}catch{b={};}
    const period=["7d","30d","6mo","12mo"].includes(b.period)?b.period:"30d";
    const sid=encodeURIComponent(SITE);
    const [agg,ts,pages,sources]=await Promise.all([
      pget(`/api/v1/stats/aggregate?site_id=${sid}&period=${period}&metrics=visitors,pageviews,bounce_rate,visit_duration`),
      pget(`/api/v1/stats/timeseries?site_id=${sid}&period=${period}&metrics=visitors`),
      pget(`/api/v1/stats/breakdown?site_id=${sid}&period=${period}&property=event:page&metrics=visitors,pageviews&limit=10`),
      pget(`/api/v1/stats/breakdown?site_id=${sid}&period=${period}&property=visit:source&metrics=visitors&limit=10`),
    ]);
    if(!agg.ok){
      const msg=(agg.json&&(agg.json.error||agg.json.message))||("Plausible error "+agg.status);
      return json(200,{ok:false,configured:true,error:msg});
    }
    const A=(agg.json&&agg.json.results)||{};
    return json(200,{ ok:true, configured:true, period,
      kpis:{ visitors:(A.visitors&&A.visitors.value)||0, pageviews:(A.pageviews&&A.pageviews.value)||0,
        bounce_rate:(A.bounce_rate&&A.bounce_rate.value)||0, visit_duration:(A.visit_duration&&A.visit_duration.value)||0 },
      timeseries:(ts.json&&ts.json.results)||[],
      pages:(pages.json&&pages.json.results)||[],
      sources:(sources.json&&sources.json.results)||[] });
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

// HCPS Website Traffic API — proxies a web-analytics provider server-side so the key never
// reaches the browser. Provider-aware: uses Cloudflare Web Analytics (free, GraphQL) if its
// env vars are set, else Plausible (REST) if its are, else reports not-configured. Returns a
// normalized shape { provider, sampled, kpis, timeseries, pages, sources }. Staff-authed.
//
// Cloudflare env:  CLOUDFLARE_API_TOKEN (Account Analytics: Read), CLOUDFLARE_ACCOUNT_ID,
//                  CLOUDFLARE_SITE_TAG (the Web Analytics site tag / beacon token)
// Plausible env:   PLAUSIBLE_API_KEY, PLAUSIBLE_SITE_ID  (+ PLAUSIBLE_API_BASE optional)
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const CF_TOKEN=process.env.CLOUDFLARE_API_TOKEN, CF_ACCT=process.env.CLOUDFLARE_ACCOUNT_ID, CF_SITE=process.env.CLOUDFLARE_SITE_TAG;
const PL_KEY=process.env.PLAUSIBLE_API_KEY, PL_SITE=process.env.PLAUSIBLE_SITE_ID;
const PL_BASE=(process.env.PLAUSIBLE_API_BASE||"https://plausible.io").replace(/\/+$/,"");
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

// period -> {since, until} as YYYY-MM-DD (used by Cloudflare) and Plausible period string.
function windowFor(period){
  const days={ "7d":7, "30d":30, "6mo":182, "12mo":365 }[period]||30;
  const d=new Date(); const until=d.toISOString().slice(0,10);
  const s=new Date(d.getTime()-days*864e5); const since=s.toISOString().slice(0,10);
  return {since,until,days};
}

// ---------- Cloudflare Web Analytics (GraphQL) ----------
async function cloudflare(period){
  const {since,until}=windowFor(period);
  const q=`{ viewer { accounts(filter: {accountTag: "${CF_ACCT}"}) {
    totals: rumPageloadEventsAdaptiveGroups(limit: 1, filter: {siteTag: "${CF_SITE}", date_geq: "${since}", date_leq: "${until}"}) { count sum { visits } }
    series: rumPageloadEventsAdaptiveGroups(limit: 5000, filter: {siteTag: "${CF_SITE}", date_geq: "${since}", date_leq: "${until}"}, orderBy: [date_ASC]) { dimensions { date } count sum { visits } }
    pages: rumPageloadEventsAdaptiveGroups(limit: 15, filter: {siteTag: "${CF_SITE}", date_geq: "${since}", date_leq: "${until}"}, orderBy: [count_DESC]) { dimensions { requestPath } count sum { visits } }
    sources: rumPageloadEventsAdaptiveGroups(limit: 15, filter: {siteTag: "${CF_SITE}", date_geq: "${since}", date_leq: "${until}"}, orderBy: [count_DESC]) { dimensions { refererHost } count sum { visits } }
  } } }`;
  const r=await fetch("https://api.cloudflare.com/client/v4/graphql",{method:"POST",
    headers:{Authorization:`Bearer ${CF_TOKEN}`,"Content-Type":"application/json"},
    body:JSON.stringify({query:q})});
  const j=await r.json().catch(()=>({}));
  if(j&&j.errors&&j.errors.length) return {ok:false,error:(j.errors[0]&&j.errors[0].message)||"Cloudflare GraphQL error"};
  const acct=j&&j.data&&j.data.viewer&&j.data.viewer.accounts&&j.data.viewer.accounts[0];
  if(!acct) return {ok:false,error:"No Cloudflare account/site data — check the token, account ID, and site tag."};
  const t=(acct.totals&&acct.totals[0])||{count:0,sum:{visits:0}};
  const visits=(t.sum&&t.sum.visits)||0, views=t.count||0;
  return { ok:true, provider:"cloudflare", sampled:true,
    kpis:{ visitors:visits, pageviews:views, bounce_rate:null, visit_duration:null },
    timeseries:(acct.series||[]).map(x=>({date:x.dimensions.date, visitors:(x.sum&&x.sum.visits)||0})),
    pages:(acct.pages||[]).map(x=>({page:x.dimensions.requestPath||"/", visitors:(x.sum&&x.sum.visits)||0, pageviews:x.count||0})),
    sources:(acct.sources||[]).map(x=>({source:x.dimensions.refererHost||"Direct", visitors:(x.sum&&x.sum.visits)||0})) };
}

// ---------- Plausible (REST) ----------
async function pget(path){ const r=await fetch(`${PL_BASE}${path}`,{headers:{Authorization:`Bearer ${PL_KEY}`}}); const t=await r.text(); let j=null; try{j=t?JSON.parse(t):null;}catch(e){j={raw:t};} return {ok:r.ok,status:r.status,json:j}; }
async function plausible(period){
  const sid=encodeURIComponent(PL_SITE);
  const [agg,ts,pages,sources]=await Promise.all([
    pget(`/api/v1/stats/aggregate?site_id=${sid}&period=${period}&metrics=visitors,pageviews,bounce_rate,visit_duration`),
    pget(`/api/v1/stats/timeseries?site_id=${sid}&period=${period}&metrics=visitors`),
    pget(`/api/v1/stats/breakdown?site_id=${sid}&period=${period}&property=event:page&metrics=visitors,pageviews&limit=10`),
    pget(`/api/v1/stats/breakdown?site_id=${sid}&period=${period}&property=visit:source&metrics=visitors&limit=10`),
  ]);
  if(!agg.ok){ const msg=(agg.json&&(agg.json.error||agg.json.message))||("Plausible error "+agg.status); return {ok:false,error:msg}; }
  const A=(agg.json&&agg.json.results)||{};
  return { ok:true, provider:"plausible", sampled:false,
    kpis:{ visitors:(A.visitors&&A.visitors.value)||0, pageviews:(A.pageviews&&A.pageviews.value)||0,
      bounce_rate:(A.bounce_rate&&A.bounce_rate.value)||0, visit_duration:(A.visit_duration&&A.visit_duration.value)||0 },
    timeseries:(ts.json&&ts.json.results)||[],
    pages:(pages.json&&pages.json.results)||[],
    sources:(sources.json&&sources.json.results)||[] };
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    const cfReady=!!(CF_TOKEN&&CF_ACCT&&CF_SITE), plReady=!!(PL_KEY&&PL_SITE);
    if(!cfReady && !plReady) return json(200,{ok:true,configured:false,
      message:"Set the Cloudflare Web Analytics env vars (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_SITE_TAG) in Netlify, then reload."});
    let b; try{b=JSON.parse(event.body||"{}");}catch{b={};}
    const period=["7d","30d","6mo","12mo"].includes(b.period)?b.period:"30d";
    const out = cfReady ? await cloudflare(period) : await plausible(period);
    if(!out.ok) return json(200,{ok:false,configured:true,provider:cfReady?"cloudflare":"plausible",error:out.error});
    return json(200,{ ...out, ok:true, configured:true, period });
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

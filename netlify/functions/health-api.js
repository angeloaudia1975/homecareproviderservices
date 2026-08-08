// HCPS Dealer Health API — serves the health dashboard from the nightly dealer_engagement
// cache (built by the engine). President sees all dealers; a rep sees only their book.
// GET /.netlify/functions/health-api   (Bearer staff token, or x-analytics-token passcode)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbGetAll(base,orderCol="dealer_id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }

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
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:""};
  return null;
}

exports.handler=async(event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let eng;
    try{ eng=await sbGetAll("dealer_engagement?select=*"); }
    catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/engine.sql + supabase/health.sql, then click Run engine now."}); }
    if(!eng.length) return json(200,{ok:true,rows:[],summary:emptySummary(),role:me.role,seeded:false});
    // dealer display info
    let dealers=[]; try{ dealers=await sbGetAll("dealers?select=id,business_name,city,state,email,phone"); }catch(e){}
    const info={}; for(const d of dealers) info[d.id]={name:d.business_name,city:d.city||"",state:d.state||"",email:d.email||"",phone:d.phone||""};
    let rows=eng.map(e=>({...e, name:(info[e.dealer_id]&&info[e.dealer_id].name)||"(dealer)",
      city:(info[e.dealer_id]&&info[e.dealer_id].city)||"", state:(info[e.dealer_id]&&info[e.dealer_id].state)||"",
      email:(info[e.dealer_id]&&info[e.dealer_id].email)||"" }));
    // rep scope
    if(me.role==="rep"){ const rn=(me.rep_name||"").toLowerCase(); rows=rows.filter(r=>String(r.rep_name||"").toLowerCase()===rn); }
    // summary
    const tiers={healthy:0,watch:0,at_risk:0,dormant:0,new:0};
    let scoreSum=0, atRiskRev=0;
    for(const r of rows){ const t=r.status||"unknown"; if(t in tiers)tiers[t]++; scoreSum+=Number(r.score)||0;
      if(t==="watch"||t==="at_risk") atRiskRev+=Number(r.total_sales)||0; }
    const summary={ total:rows.length, tiers, avg_score: rows.length?Math.round(scoreSum/rows.length):0,
      at_risk_revenue: Math.round(atRiskRev),
      reps:[...new Set(rows.map(r=>r.rep_name).filter(Boolean))].sort() };
    // default order: churn urgency desc, then value desc
    rows.sort((a,b)=>(Number(b.churn_score)||0)-(Number(a.churn_score)||0) || (Number(b.total_sales)||0)-(Number(a.total_sales)||0));
    return json(200,{ok:true,rows,summary,role:me.role,seeded:true,generatedAt:new Date().toISOString()});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};
function emptySummary(){ return {total:0,tiers:{healthy:0,watch:0,at_risk:0,dormant:0,new:0},avg_score:0,at_risk_revenue:0,reps:[]}; }

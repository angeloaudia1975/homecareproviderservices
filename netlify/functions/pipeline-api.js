// HCPS Pipeline & Forecasting API — the opportunity/deal board plus a 6-month forward
// revenue forecast = cadence-based reorder projection + stage-weighted pipeline. President
// sees everything; a rep sees their own deals and their book's forecast. No npm deps.
//   POST {action:"board"}                               -> { opportunities, forecast, history, summary, stages }
//   POST {action:"add", title, dealer_id?, line?, value?, stage?, expected_close?, owner_rep?, notes?}
//   POST {action:"update", id, ...fields}
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(p){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${p}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(m,p,b,x){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${p}`,{method:m,headers:{...H(),"content-type":"application/json",...(x||{})},body:b!=null?JSON.stringify(b):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base,col="id"){ const PAGE=1000; let f=0,out=[]; for(;;){ const s=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${s}order=${col}&limit=${PAGE}&offset=${f}`); out=out.concat(rows); if(rows.length<PAGE)break; f+=PAGE; } return out; }
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const pmOf=p=>{ const s=String(p||"").slice(0,7); const[y,m]=s.split("-").map(Number); return (y&&m)?(y*12+(m-1)):null; };
const pmStr=pm=>{ const y=Math.floor(pm/12),m=(pm%12)+1; return `${y}-${String(m).padStart(2,"0")}`; };
const pmLabel=pm=>{ const M=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return M[pm%12]+" "+Math.floor(pm/12); };
const median=a=>{ if(!a.length)return null; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||2000):null; };
const STAGE_PROB={identified:0.1,contacted:0.3,quoted:0.6,won:1,lost:0};
const STAGES=["identified","contacted","quoted","won","lost"];

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){ try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email}; } } }catch(e){}
    return null; }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:""};
  return null;
}

exports.handler=async(event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
    // table present?
    try{ await sbGet("opportunities?select=id&limit=1"); }
    catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/pipeline.sql in Supabase, then reload."}); }

    if(b.action==="add"){
      if(!clean(b.title)) return json(400,{error:"title required"});
      const stage=STAGES.includes(b.stage)?b.stage:"identified";
      const row={ dealer_id:b.dealer_id||null, title:clean(b.title,200), line:clean(b.line,120),
        stage, value:Number(b.value)||0, probability:(b.probability!=null?Number(b.probability):STAGE_PROB[stage]),
        expected_close:/^\d{4}-\d{2}-\d{2}$/.test(String(b.expected_close||""))?b.expected_close:null,
        owner_rep:clean(b.owner_rep,120)||me.rep_name||null, source:b.source==="crosssell"?"crosssell":"manual",
        notes:clean(b.notes,2000), status: stage==="won"?"won":stage==="lost"?"lost":"open",
        created_by:me.name||me.email||null };
      const ins=await sbSend("POST","opportunities",row,{Prefer:"return=representation"});
      return json(200,{ok:true,opportunity:(ins&&ins[0])||row});
    }
    if(b.action==="update"){
      if(!b.id) return json(400,{error:"id required"});
      const patch={updated_at:new Date().toISOString()};
      if(b.stage&&STAGES.includes(b.stage)){ patch.stage=b.stage; patch.probability=(b.probability!=null?Number(b.probability):STAGE_PROB[b.stage]); patch.status=b.stage==="won"?"won":b.stage==="lost"?"lost":"open"; }
      if(b.value!=null) patch.value=Number(b.value)||0;
      if(b.title!=null) patch.title=clean(b.title,200);
      if(b.line!=null) patch.line=clean(b.line,120);
      if(b.notes!=null) patch.notes=clean(b.notes,2000);
      if(b.expected_close!==undefined) patch.expected_close=/^\d{4}-\d{2}-\d{2}$/.test(String(b.expected_close||""))?b.expected_close:null;
      if(b.owner_rep!=null) patch.owner_rep=clean(b.owner_rep,120);
      await sbSend("PATCH",`opportunities?id=eq.${encodeURIComponent(b.id)}`,patch,{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }

    // ---- board + forecast ----
    const [opps,dealers,aliases,dir,mfrs,cfg]=await Promise.all([
      sbGetAll("opportunities?select=*","created_at"),
      sbGetAll("dealers?select=id,business_name"),
      sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
      sbGet("dealer_directory?select=dealer_name,rep_name").catch(()=>[]),
      sbGet("manufacturers?select=slug,name").catch(()=>[]),
      sbGet("app_settings?key=eq.automation_config&select=value").catch(()=>[]),
    ]);
    const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
    const idByAlias={}; for(const a of aliases) idByAlias[a.alias_norm]=a.dealer_id;
    const repByName={}; for(const x of dir) repByName[x.dealer_name]=x.rep_name||"";
    const mfrName={}; for(const m of mfrs) mfrName[m.slug]=m.name||m.slug;
    const mnorm=s=>String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
    const exSet=new Set((((cfg&&cfg[0]&&cfg[0].value&&cfg[0].value.exclude_manufacturers)||[])).map(mnorm));
    const isEx=slug=>exSet.has(mnorm(slug))||exSet.has(mnorm(mfrName[slug]));
    const isRep = me.role==="rep"; const myRep=(me.rep_name||"").toLowerCase();
    const repOfDealer=id=>repByName[nameById[id]]||null;

    // reorder projection from monthly_sales cadence
    const rows=await sbGetAll("monthly_sales?select=dealer_id,manufacturer,period,customer_name,amount");
    const resolve=r=>{ if(r.dealer_id&&nameById[r.dealer_id])return r.dealer_id; const id=idByAlias[dnorm(r.customer_name)]; return (id&&nameById[id])?id:null; };
    const DLL=new Map(); let L=0; // dealer|line -> {pms:Map(pm->$)}
    for(const r of rows){ const id=resolve(r); if(!id)continue; if(isEx(r.manufacturer))continue; const pm=pmOf(r.period); if(!pm)continue; if(pm>L)L=pm;
      if(isRep && String(repOfDealer(id)||"").toLowerCase()!==myRep) continue;
      const key=id+"|"+r.manufacturer; let o=DLL.get(key); if(!o){o={id,pms:new Map()};DLL.set(key,o);} o.pms.set(pm,(o.pms.get(pm)||0)+(Number(r.amount)||0)); }
    const HOR=6; const reorderByPm={};
    for(const [,o] of DLL){ const pmArr=[...o.pms.keys()].sort((a,b)=>a-b); if(pmArr.length<2)continue;
      const gaps=[]; for(let i=1;i<pmArr.length;i++)gaps.push(pmArr[i]-pmArr[i-1]); const cyc=median(gaps); if(!cyc||cyc<=0)continue;
      const amts=[...o.pms.values()]; const avg=amts.reduce((s,v)=>s+v,0)/amts.length;
      const last=pmArr[pmArr.length-1]; let next=last+cyc; while(next<=L) next+=cyc;
      for(; next<=L+HOR; next+=cyc){ reorderByPm[next]=(reorderByPm[next]||0)+avg; } }

    // opportunities (rep-scoped) + pipeline forecast
    let oppList=opps.map(o=>({...o, dealer_name:o.dealer_id?(nameById[o.dealer_id]||""):"" }));
    if(isRep) oppList=oppList.filter(o=>String(o.owner_rep||"").toLowerCase()===myRep);
    const pipeByPm={};
    for(const o of oppList){ if(o.status!=="open")continue; const pm=o.expected_close?pmOf(o.expected_close):null; if(pm==null||pm<=L||pm>L+HOR)continue;
      const prob=o.probability!=null?Number(o.probability):(STAGE_PROB[o.stage]||0); pipeByPm[pm]=(pipeByPm[pm]||0)+(Number(o.value)||0)*prob/12; }
      // note: opportunity.value is annual; a close in-month contributes ~1/12 monthly-equivalent to the month view

    const forecast=[]; for(let m=L+1;m<=L+HOR;m++){ const ro=Math.round(reorderByPm[m]||0), pp=Math.round(pipeByPm[m]||0); forecast.push({pm:m,label:pmLabel(m),reorder:ro,pipeline:pp,total:ro+pp}); }
    // history (last 12 months actuals, same scope)
    const actualByPm={}; for(const r of rows){ const id=resolve(r); if(!id)continue; if(isEx(r.manufacturer))continue; if(isRep&&String(repOfDealer(id)||"").toLowerCase()!==myRep)continue; const pm=pmOf(r.period); if(pm==null)continue; if(pm>L-12&&pm<=L) actualByPm[pm]=(actualByPm[pm]||0)+(Number(r.amount)||0); }
    const history=[]; for(let m=L-11;m<=L;m++){ history.push({pm:m,label:pmLabel(m),actual:Math.round(actualByPm[m]||0)}); }

    // summary
    const openOpps=oppList.filter(o=>o.status==="open");
    const byStage={}; for(const st of STAGES) byStage[st]={count:0,value:0};
    for(const o of oppList){ const st=o.stage||"identified"; if(!byStage[st])byStage[st]={count:0,value:0}; byStage[st].count++; byStage[st].value+=Number(o.value)||0; }
    const summary={
      open_count:openOpps.length,
      open_value:Math.round(openOpps.reduce((s,o)=>s+(Number(o.value)||0),0)),
      weighted_value:Math.round(openOpps.reduce((s,o)=>s+(Number(o.value)||0)*(o.probability!=null?Number(o.probability):(STAGE_PROB[o.stage]||0)),0)),
      forecast_90:Math.round(forecast.slice(0,3).reduce((s,f)=>s+f.total,0)),
      reorder_90:Math.round(forecast.slice(0,3).reduce((s,f)=>s+f.reorder,0)),
      by_stage:byStage
    };
    oppList.sort((a,b)=>(Number(b.value)||0)-(Number(a.value)||0));
    return json(200,{ok:true,role:me.role,latest:L?pmStr(L):null,opportunities:oppList,forecast,history,summary,stages:STAGES,stage_prob:STAGE_PROB});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

// HCPS Pipeline & Forecasting API — the opportunity/deal board plus a 6-month forward
// revenue forecast = cadence-based reorder projection + stage-weighted pipeline. President
// sees everything; a rep sees their own deals and their book's forecast. No npm deps.
//   POST {action:"board"}                               -> { opportunities, forecast, history, summary, stages }
//   POST {action:"add", title, dealer_id?, line?, value?, stage?, expected_close?, owner_rep?, notes?}
//   POST {action:"update", id, ...fields}
//   POST {action:"history", id}                         -> { opportunity, events }   (Phase 2E, switch `conversion`)
//   POST {action:"conversion", days?|from?,to?}         -> the Conversion report       (Phase 2E, switch `conversion`)
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

const SC=require("./_scope.js");
const UP=require("./_upsert.js");
const VI=require("./_visits.js");   // Phase 1: a visit's follow-up status follows its deals
const FL=require("./_flags.js");
const CV=require("./_conversion.js"); // Phase 2E: the Conversion report
// Phase 2E: the database records every stage/status change (supabase/phase2_opportunity_events.sql). The
// Pipeline says on its own writes that it is the Pipeline, and who — PostgREST hands these request headers
// to the trigger. Nothing else changes about the write.
const ctxHeaders=(me,extra)=>Object.assign({"x-hcps-source":"pipeline","x-hcps-actor":String((me&&(me.email||me.name))||"").toLowerCase().slice(0,200)},extra||{});
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

    /* Who may write a deal. Management (and, unchanged in Phase 0, Relations) may work any deal.
       A rep may add deals on dealers in his book, change only deals he owns or whose dealer is
       in his book, and can't hand a deal to someone else — owner_rep stays his own. */
    // In My Sales Workspace the President writes deals as a rep with his own book (Phase 2, amendment 1).
    const scopeMe=SC.workspaceUser(event, me);
    const manages=SC.seesAllDealers(scopeMe);
    if(b.action==="add"){
      if(!clean(b.title)) return json(400,{error:"title required"});
      if(b.dealer_id && !(await SC.canAccessDealer(scopeMe,b.dealer_id,sbGet))) return json(403,{error:"Not your dealer"});
      const stage=STAGES.includes(b.stage)?b.stage:"identified";
      const row={ dealer_id:b.dealer_id||null, title:clean(b.title,200), line:clean(b.line,120),
        stage, value:Number(b.value)||0, probability:(b.probability!=null?Number(b.probability):STAGE_PROB[stage]),
        expected_close:/^\d{4}-\d{2}-\d{2}$/.test(String(b.expected_close||""))?b.expected_close:null,
        owner_rep:(manages?(clean(b.owner_rep,120)||me.rep_name||null):(me.rep_name||null)), source:b.source==="crosssell"?"crosssell":"manual",
        notes:clean(b.notes,2000), status: stage==="won"?"won":stage==="lost"?"lost":"open",
        created_by:me.name||me.email||null };
      // owner_email (Phase 0J): a rep's own deal carries their sign-in email; for a deal management
      // assigns to someone else the database fills it from owner_rep (phase0_task_owner_email.sql).
      if(!manages || !clean(b.owner_rep,120)) row.owner_email=String(me.email||"").toLowerCase()||null;
      const ins=await UP.sendTolerant(sbSend,"POST","opportunities",row,["owner_email"],ctxHeaders(me,{Prefer:"return=representation"}));
      return json(200,{ok:true,opportunity:(ins&&ins[0])||row});
    }
    if(b.action==="update"){
      if(!b.id) return json(400,{error:"id required"});
      const own=await SC.authorizeRecord(scopeMe,"opportunities",b.id,sbGet,{ownerFields:["owner_rep","owner_email"],optional:["owner_email"]});
      if(!own.ok) return json(own.status,{error:own.error});
      const patch={updated_at:new Date().toISOString(),updated_by:me.email||me.name||null};
      if(b.stage&&STAGES.includes(b.stage)){ patch.stage=b.stage; patch.probability=(b.probability!=null?Number(b.probability):STAGE_PROB[b.stage]); patch.status=b.stage==="won"?"won":b.stage==="lost"?"lost":"open";
        const cur=await sbGet(`opportunities?id=eq.${encodeURIComponent(b.id)}&select=stage`).catch(()=>[]);
        if(String((cur&&cur[0]&&cur[0].stage)||"")!==b.stage) patch.stage_changed_at=patch.updated_at; }
      if(b.value!=null) patch.value=Number(b.value)||0;
      if(b.title!=null) patch.title=clean(b.title,200);
      if(b.line!=null) patch.line=clean(b.line,120);
      if(b.notes!=null) patch.notes=clean(b.notes,2000);
      if(b.expected_close!==undefined) patch.expected_close=/^\d{4}-\d{2}-\d{2}$/.test(String(b.expected_close||""))?b.expected_close:null;
      if(b.owner_rep!=null && manages) patch.owner_rep=clean(b.owner_rep,120);
      await UP.sendTolerant(sbSend,"PATCH",`opportunities?id=eq.${encodeURIComponent(b.id)}`,patch,["updated_by","stage_changed_at"],ctxHeaders(me,{Prefer:"return=minimal"}));
      // A deal from a visit moves that visit's follow-up status (Phase 1).
      try{ const o=await sbGet(`opportunities?id=eq.${encodeURIComponent(b.id)}&select=origin_type,origin_id`);
        if(o&&o[0]&&o[0].origin_type==="visit_report"&&o[0].origin_id) await VI.recomputeFollowup([o[0].origin_id],{sbGet,sbSend}); }catch(e){}
      return json(200,{ok:true});
    }

    /* ---- Phase 2E: a deal's stage history, and the Conversion report -----------------------------
       Scoped exactly like the board: a rep sees his own deals; the President in My Sales Workspace his
       own; management and Relations in the normal views the whole company. No commission figures. */
    if(b.action==="history"||b.action==="conversion"){
      if(!(await FL.flagOn(sbGet,"conversion"))) return json(403,{error:"Conversion reporting isn't turned on yet.",code:"flag_off"});
      const role=String(me.role||"").toLowerCase(), workspace=SC.workspaceMine(event, me);
      const isRep=workspace || !({president:1,admin:1,owner:1,relations:1})[role];
      const myEmail=String(me.email||"").trim().toLowerCase(), myRep=String(me.rep_name||"").trim().toLowerCase();
      const mine=o=>(!!myEmail && String(o.owner_email||"").trim().toLowerCase()===myEmail) || (!!myRep && String(o.owner_rep||"").trim().toLowerCase()===myRep);
      const scope=isRep?(workspace?"workspace":"own"):"company";
      const ECOLS="opportunity_id,kind,from_stage,to_stage,from_status,to_status,value,changed_by,source,changed_at";
      const MISSING=/PGRST20[45]|Could not find the table|42P01|does not exist/i;
      if(b.action==="history"){
        if(!b.id) return json(400,{error:"id required"});
        const r=await sbGet(`opportunities?id=eq.${encodeURIComponent(b.id)}&select=id,title,dealer_id,stage,status,value,owner_rep,owner_email,created_at,origin_type,source`).catch(()=>[]);
        const o=r&&r[0]; if(!o) return json(404,{error:"Deal not found"});
        if(isRep && !mine(o)) return json(403,{error:"Not your deal"});
        let events;
        try{ events=await sbGet(`opportunity_events?opportunity_id=eq.${encodeURIComponent(o.id)}&select=${ECOLS}&order=changed_at.asc&limit=500`); }
        catch(e){ return json(MISSING.test(String(e.message||e))?503:500,{error:"storage_missing",setup:"supabase/phase2_opportunity_events.sql"}); }
        return json(200,{ok:true,scope,opportunity:{id:o.id,title:o.title,dealer_id:o.dealer_id,stage:o.stage,status:o.status,value:o.value,owner:o.owner_rep||o.owner_email||"",created_at:o.created_at,from_visit:o.origin_type==="visit_report"||o.source==="visit"},events:events||[]});
      }
      // The period: the last N days (30 / 90 / 180 / 365), or from–to dates.
      const DAYS=[30,90,180,365]; const ISOD=/^\d{4}-\d{2}-\d{2}$/;
      let to=Date.now(), from=to-(DAYS.includes(Number(b.days))?Number(b.days):90)*864e5;
      if(ISOD.test(String(b.from||"")) && ISOD.test(String(b.to||""))){ const f=Date.parse(b.from+"T00:00:00Z"), t=Date.parse(b.to+"T00:00:00Z")+864e5; if(t>f){ from=f; to=t; } }
      let opps=await sbGetAll("opportunities?select=id,title,dealer_id,stage,status,value,probability,owner_rep,owner_email,created_at,origin_type,source,manufacturer,line","created_at")
        .catch(()=>sbGetAll("opportunities?select=id,title,dealer_id,stage,status,value,probability,owner_rep,owner_email,created_at,source,line","created_at"));
      if(isRep) opps=opps.filter(mine);
      let events=[];
      try{
        if(isRep){ const ids=opps.map(o=>o.id); for(let i=0;i<ids.length;i+=100){ const part=ids.slice(i,i+100).map(encodeURIComponent).join(","); events=events.concat(await sbGet(`opportunity_events?opportunity_id=in.(${part})&select=${ECOLS}&limit=5000`)); } }
        else events=await sbGetAll(`opportunity_events?select=id,${ECOLS}`,"changed_at,id");
      }catch(e){ if(MISSING.test(String(e.message||e))) return json(503,{error:"storage_missing",setup:"supabase/phase2_opportunity_events.sql"}); throw e; }
      const mfrs=await sbGet("manufacturers?select=slug,name").catch(()=>[]);
      // Orders only for the deals that can be matched (created in the period, manufacturer certain).
      const cand=opps.filter(o=>{ const t=Date.parse(o.created_at||""); return o.dealer_id && t>=from && t<to && CV.manufacturerOf(o,mfrs); });
      const dids=[...new Set(cand.map(o=>String(o.dealer_id)))];
      const since=cand.length?new Date(Math.min(...cand.map(o=>Date.parse(o.created_at)))).toISOString():null;
      let orders=[], sales=[], names={};
      for(let i=0;i<dids.length;i+=80){
        const part=dids.slice(i,i+80).map(encodeURIComponent).join(",");
        const [o1,s1,n1]=await Promise.all([
          sbGetAll(`orders?dealer_id=in.(${part})&submitted_at=gte.${encodeURIComponent(since)}&select=id,dealer_id,manufacturer,submitted_at,subtotal`,"id").catch(()=>[]),
          sbGetAll(`monthly_sales?dealer_id=in.(${part})&period=gte.${since.slice(0,7)}-01&select=dealer_id,manufacturer,period,order_date,amount`,"period")
            .catch(()=>sbGetAll(`monthly_sales?dealer_id=in.(${part})&period=gte.${since.slice(0,7)}-01&select=dealer_id,manufacturer,period,amount`,"period").catch(()=>[])),
          sbGet(`dealers?id=in.(${part})&select=id,business_name`).catch(()=>[]),
        ]);
        orders=orders.concat(o1||[]); sales=sales.concat(s1||[]); for(const d of (n1||[])) names[d.id]=d.business_name;
      }
      for(const o of opps) if(names[o.dealer_id]) o.dealer_name=names[o.dealer_id];
      const rep=CV.compute({opps,events,orders,sales,mfrs,from,to});
      return json(200,Object.assign({ok:true,scope,workspace,days:DAYS.includes(Number(b.days))?Number(b.days):(b.from?null:90)},rep));
    }

    // ---- board + forecast ----
    const [opps,dealers,aliases,OI,mfrs,cfg]=await Promise.all([
      sbGetAll("opportunities?select=*","created_at"),
      sbGetAll("dealers?select=id,business_name"),
      sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
      SC.ownerIndex(sbGet).catch(()=>null),                 // who owns each dealer (Phase 0D)
      sbGet("manufacturers?select=slug,name").catch(()=>[]),
      sbGet("app_settings?key=eq.automation_config&select=value").catch(()=>[]),
    ]);
    const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
    const idByAlias={}; for(const a of aliases) idByAlias[a.alias_norm]=a.dealer_id;

    const mfrName={}; for(const m of mfrs) mfrName[m.slug]=m.name||m.slug;
    const mnorm=s=>String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
    const exSet=new Set((((cfg&&cfg[0]&&cfg[0].value&&cfg[0].value.exclude_manufacturers)||[])).map(mnorm));
    const isEx=slug=>exSet.has(mnorm(slug))||exSet.has(mnorm(mfrName[slug]));
    // Pipeline scope: management + a Relations Manager see the whole territory's pipeline; a sales
    // rep sees only their own.
    const role=String(me.role||"").toLowerCase();
    // My Sales Workspace: a President working his own book gets the rep view of HIS book and deals.
    const workspace=SC.workspaceMine(event, me);
    const isRep = workspace || !({president:1,admin:1,owner:1,relations:1})[role]; const myRep=(me.rep_name||"").toLowerCase();
    // A rep's sales actuals and reorder projection cover exactly their book (shared resolver).
    const sc=isRep ? await (workspace ? SC.ownBook(me, sbGet, OI||undefined) : SC.dealerScope(me, sbGet, OI||undefined)) : null;
    const outOfBook=id=>isRep && !(sc && sc.ids && sc.ids.has(String(id)));

    // reorder projection from monthly_sales cadence
    const rows=await sbGetAll("monthly_sales?select=dealer_id,manufacturer,period,customer_name,amount");
    const resolve=r=>{ if(r.dealer_id&&nameById[r.dealer_id])return r.dealer_id; const id=idByAlias[dnorm(r.customer_name)]; return (id&&nameById[id])?id:null; };
    const DLL=new Map(); let L=0; // dealer|line -> {pms:Map(pm->$)}
    for(const r of rows){ const id=resolve(r); if(!id)continue; if(isEx(r.manufacturer))continue; const pm=pmOf(r.period); if(!pm)continue; if(pm>L)L=pm;
      if(outOfBook(id)) continue;
      const key=id+"|"+r.manufacturer; let o=DLL.get(key); if(!o){o={id,pms:new Map()};DLL.set(key,o);} o.pms.set(pm,(o.pms.get(pm)||0)+(Number(r.amount)||0)); }
    const HOR=6; const reorderByPm={};
    for(const [,o] of DLL){ const pmArr=[...o.pms.keys()].sort((a,b)=>a-b); if(pmArr.length<2)continue;
      const gaps=[]; for(let i=1;i<pmArr.length;i++)gaps.push(pmArr[i]-pmArr[i-1]); const cyc=median(gaps); if(!cyc||cyc<=0)continue;
      const amts=[...o.pms.values()]; const avg=amts.reduce((s,v)=>s+v,0)/amts.length;
      const last=pmArr[pmArr.length-1]; let next=last+cyc; while(next<=L) next+=cyc;
      for(; next<=L+HOR; next+=cyc){ reorderByPm[next]=(reorderByPm[next]||0)+avg; } }

    // opportunities (rep-scoped) + pipeline forecast
    let oppList=opps.map(o=>({...o, dealer_name:o.dealer_id?(nameById[o.dealer_id]||""):"" }));
    // A rep with no book name sees no deals — a blank name must never match unowned deals.
    const myEmail=String(me.email||"").trim().toLowerCase();
    if(isRep) oppList=oppList.filter(o=>(!!myEmail && String(o.owner_email||"").toLowerCase()===myEmail) || (!!myRep && String(o.owner_rep||"").toLowerCase()===myRep));
    const pipeByPm={};
    for(const o of oppList){ if(o.status!=="open")continue; const pm=o.expected_close?pmOf(o.expected_close):null; if(pm==null||pm<=L||pm>L+HOR)continue;
      const prob=o.probability!=null?Number(o.probability):(STAGE_PROB[o.stage]||0); pipeByPm[pm]=(pipeByPm[pm]||0)+(Number(o.value)||0)*prob/12; }
      // note: opportunity.value is annual; a close in-month contributes ~1/12 monthly-equivalent to the month view

    const forecast=[]; for(let m=L+1;m<=L+HOR;m++){ const ro=Math.round(reorderByPm[m]||0), pp=Math.round(pipeByPm[m]||0); forecast.push({pm:m,label:pmLabel(m),reorder:ro,pipeline:pp,total:ro+pp}); }
    // history (last 12 months actuals, same scope)
    const actualByPm={}; for(const r of rows){ const id=resolve(r); if(!id)continue; if(isEx(r.manufacturer))continue; if(outOfBook(id))continue; const pm=pmOf(r.period); if(pm==null)continue; if(pm>L-12&&pm<=L) actualByPm[pm]=(actualByPm[pm]||0)+(Number(r.amount)||0); }
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
    // Phase 2E: with the conversion switch on, the page offers the Conversion tab and each deal's history.
    const conversion=await FL.flagOn(sbGet,"conversion");
    return json(200,{ok:true,role:me.role,workspace,latest:L?pmStr(L):null,opportunities:oppList,forecast,history,summary,stages:STAGES,stage_prob:STAGE_PROB,conversion});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

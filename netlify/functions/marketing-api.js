// HCPS Email Marketing Command Center — "Today's Sales Opportunities" + metrics.
// A read-only assembly from the cached intelligence tables (dealer_intent,
// dealer_engagement, cross_sell, opportunities, dealer_tasks, email_sends), so it
// reflects exactly what the engine already produced. Staff-authed; reps see only
// their own book, the president sees everything.
//
//   POST {action:"today"}  + staff Bearer token  -> {ok, opportunities:[...], metrics:{...}}
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sbGetAll(base,col="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${col}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE)break; from+=PAGE; } return out; }

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{
    const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(!r.ok) return null; const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase(); if(!email) return null;
    const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,rep_name,active`).catch(()=>[]);
    const su=s&&s[0]; if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",email};
  }catch(e){}
  return null;
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});

    const [intent,eng,xs,dealers,mfrs]=await Promise.all([
      sbGet("dealer_intent?tier=in.(high,opportunity)&select=dealer_id,score_total,tier,top_manufacturer").catch(()=>[]),
      sbGetAll("dealer_engagement?select=dealer_id,status,months_since,churn_score,trend,rep_name,cycle_json","dealer_id").catch(()=>[]),
      sbGet("cross_sell?rank=eq.1&select=dealer_id,rec_name,basis_name,score").catch(()=>[]),
      sbGetAll("dealers?select=id,business_name","id").catch(()=>[]),
      sbGet("manufacturers?select=slug,name").catch(()=>[]),
    ]);
    const nameById={}; dealers.forEach(d=>nameById[d.id]=d.business_name);
    const mfrName={}; mfrs.forEach(m=>mfrName[m.slug]=m.name||m.slug);
    const engById={}; eng.forEach(e=>engById[e.dealer_id]=e);
    const intentById={}; intent.forEach(it=>intentById[it.dealer_id]=it);
    const xsById={}; xs.forEach(x=>{ if(x&&x.dealer_id&&!xsById[x.dealer_id]) xsById[x.dealer_id]=x; });

    const meRep = me.role==="president" ? null : (me.rep_name||"~none~");
    const repSet = meRep ? new Set(eng.filter(e=>String(e.rep_name||"")===meRep).map(e=>e.dealer_id)) : null;
    const inScope = id => (!repSet || repSet.has(id)) && !!nameById[id];
    const repOf = id => (engById[id]&&engById[id].rep_name)||"";

    const rows=[]; const seen=new Set();
    const push=(id,prio,badge,evidence,action)=>{ if(seen.has(id)||!inScope(id))return; seen.add(id); rows.push({dealer_id:id,name:nameById[id],rep:repOf(id),prio,badge,evidence,action}); };

    // 1–2. High intent (opportunity first, then interested)
    Object.values(intentById).sort((a,b)=>(b.score_total||0)-(a.score_total||0)).forEach(it=>{
      if(it.tier!=="opportunity"&&it.tier!=="high")return;
      const e=engById[it.dealer_id]; const mfr=it.top_manufacturer?(mfrName[it.top_manufacturer]||it.top_manufacturer):null;
      const ms=e?e.months_since:null;
      const ev=`Intent ${Math.round(it.score_total||0)}${mfr?` on ${mfr}`:""}${ms!=null?` · last order ${ms}mo ago`:""}`;
      push(it.dealer_id, it.tier==="opportunity"?1:2, it.tier==="opportunity"?"HOT":"INTEREST", ev, "Call dealer");
    });
    // 3. Reorder due
    eng.filter(e=>e.status==="overdue").sort((a,b)=>(b.churn_score||0)-(a.churn_score||0)).forEach(e=>{
      const cyc=e.cycle_json&&e.cycle_json.cyc;
      const ev=`${cyc?`Usually orders ~${cyc}mo; `:""}${e.months_since!=null?`${e.months_since}mo since last order`:"past due"}`;
      push(e.dealer_id,3,"REORDER DUE",ev,"Send reorder / call");
    });
    // 4. At risk (declining, not yet dormant/overdue)
    eng.filter(e=>(e.status==="slipping")||((e.churn_score||0)>=60&&e.status!=="dormant"&&e.status!=="overdue")).sort((a,b)=>(b.churn_score||0)-(a.churn_score||0)).forEach(e=>{
      const ev=`Declining${e.trend?` (${e.trend})`:""}${e.months_since!=null?` · ${e.months_since}mo since last order`:""}`;
      push(e.dealer_id,4,"AT RISK",ev,"Check in");
    });
    // 5. Cross-sell
    Object.values(xsById).sort((a,b)=>(b.score||0)-(a.score||0)).forEach(x=>{
      push(x.dealer_id,5,"CROSS-SELL",`Buys ${x.basis_name||"other lines"}; doesn't carry ${x.rec_name}`,`Introduce ${x.rec_name}`);
    });
    // 6. Dormant
    eng.filter(e=>e.status==="dormant").sort((a,b)=>(a.months_since||0)-(b.months_since||0)).forEach(e=>{
      push(e.dealer_id,6,"DORMANT",`No orders in ${e.months_since!=null?e.months_since:"?"}mo`,"Reactivate");
    });
    rows.sort((a,b)=>a.prio-b.prio);
    const opportunities=rows.slice(0,120);

    // ---- metrics ----
    const cut7=new Date(Date.now()-7*864e5).toISOString();
    const taskFilt = meRep ? `&assigned_rep=eq.${encodeURIComponent(meRep)}` : "";
    const oppFilt  = meRep ? `&owner_rep=eq.${encodeURIComponent(meRep)}` : "";
    const [tasks,sends,opps]=await Promise.all([
      sbGet(`dealer_tasks?status=eq.open&select=id${taskFilt}`).catch(()=>[]),
      sbGet(`email_sends?sent_at=gte.${cut7}&select=dealer_id`).catch(()=>[]),
      sbGet(`opportunities?status=eq.open&select=value${oppFilt}`).catch(()=>[]),
    ]);
    const metrics={
      hot: Object.values(intentById).filter(it=>it.tier==="opportunity"&&inScope(it.dealer_id)).length,
      interested: Object.values(intentById).filter(it=>it.tier==="high"&&inScope(it.dealer_id)).length,
      reorder_due: eng.filter(e=>e.status==="overdue"&&inScope(e.dealer_id)).length,
      cross_sell: Object.keys(xsById).filter(inScope).length,
      dormant: eng.filter(e=>e.status==="dormant"&&inScope(e.dealer_id)).length,
      open_tasks: (tasks||[]).length,
      emails_7d: (sends||[]).length,
      dealers_emailed_7d: new Set((sends||[]).map(s=>s.dealer_id)).size,
      opps_open: (opps||[]).length,
      opps_value: Math.round((opps||[]).reduce((n,o)=>n+(Number(o.value)||0),0)),
    };
    return json(200,{ok:true,role:me.role,opportunities,metrics});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

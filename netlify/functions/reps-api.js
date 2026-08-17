// HCPS Rep Performance & Goals API — per-rep scorecards (sales YTD, YoY, attainment vs
// target, book health, momentum, open tasks) + a leaderboard. President sees all and can
// set targets; a rep sees only their own card. Data from monthly_sales + dealer_directory
// + dealer_engagement + dealer_tasks + rep_targets. No npm deps.
//   POST {action:"scorecards"}                         -> { reps:[...], year, summary }
//   POST {action:"set_target", rep_name, year, target} -> { ok }  (president only)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base,orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const ym=p=>String(p||"").slice(0,7);

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

exports.handler=async(event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    if(b.action==="set_target"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const rep=String(b.rep_name||"").trim(); const year=parseInt(b.year,10); const target=Number(b.target)||0;
      if(!rep||!year) return json(400,{error:"rep_name + year required"});
      await sbSend("POST","rep_targets?on_conflict=rep_name,year",{rep_name:rep,year,target,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true});
    }

    // ---- commission splits (President) ----
    // Read the single config row of rep→percentage splits.
    if(b.action==="get_splits"){
      if(me.role!=="president") return json(403,{error:"President only"});
      let val={}; try{ const r=await sbGet("app_settings?key=eq.commission_splits&select=value"); if(r&&r[0]&&r[0].value&&typeof r[0].value==="object") val=r[0].value; }catch(e){}
      return json(200,{ok:true,splits:val});
    }
    // Set (or remove) one rep's split. rep_pct is the rep's own share; company share is the remainder.
    if(b.action==="set_split"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const name=String(b.rep_name||"").trim(); if(!name) return json(400,{error:"rep_name required"});
      const key=name.toLowerCase();
      let val={}; try{ const r=await sbGet("app_settings?key=eq.commission_splits&select=value"); if(r&&r[0]&&r[0].value&&typeof r[0].value==="object") val=r[0].value; }catch(e){}
      if(b.remove===true){ delete val[key]; }
      else {
        let rp=Number(b.rep_pct); if(!isFinite(rp)) return json(400,{error:"rep_pct (0-100) required"});
        rp=Math.max(0,Math.min(100,Math.round(rp)));
        val[key]={name,rep_pct:rp};
      }
      await sbSend("POST","app_settings?on_conflict=key",{key:"commission_splits",value:val,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true,splits:val});
    }

    // Preview the executive report HTML without sending (President).
    if(b.action==="preview_report"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const report=require("./_report"); const ex=await report.previewExec();
      return json(200,{ok:true,subject:ex.subject,html:ex.html});
    }
    // Send the weekly exec + per-rep digests now (President).
    if(b.action==="send_reports_now"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const report=require("./_report"); const r=await report.sendReports();
      return json(200,r);
    }

    // ---- scorecards ----
    const [dealers,aliases,dir,eng,tasks,targets]=await Promise.all([
      sbGetAll("dealers?select=id,business_name,parent_id"),
      sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
      sbGet("dealer_directory?select=dealer_name,rep_name").catch(()=>[]),
      sbGet("dealer_engagement?select=rep_name,status,score,total_sales,recent_sales").catch(()=>[]),
      sbGet("dealer_tasks?status=eq.open&select=assigned_rep").catch(()=>[]),
      sbGet("rep_targets?select=rep_name,year,target").catch(()=>[]),
    ]);
    const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
    const idByAlias={}; for(const a of aliases) idByAlias[a.alias_norm]=a.dealer_id;
    const repByName={}; for(const x of dir) repByName[x.dealer_name]=x.rep_name||"";
    const canon=r=>{ if(r.dealer_id&&nameById[r.dealer_id])return nameById[r.dealer_id]; const id=idByAlias[dnorm(r.customer_name)]; return (id&&nameById[id])?nameById[id]:((r.customer_name||"").trim()||null); };
    const rows=await sbGetAll("monthly_sales?select=dealer_id,period,customer_name,rep_name,amount");
    // per-rep monthly sales
    const byRepMonth={}; const periods=new Set();
    for(const r of rows){ const nm=canon(r); const rep=(nm&&repByName[nm])||r.rep_name||"Unassigned"; const p=ym(r.period); if(!p)continue; periods.add(p);
      (byRepMonth[rep]=byRepMonth[rep]||{})[p]=(byRepMonth[rep][p]||0)+(Number(r.amount)||0); }
    const plist=[...periods].sort();
    const latest=plist[plist.length-1]||null; const curYear=latest?latest.slice(0,4):String(new Date().getFullYear());
    const prevYear=String(Number(curYear)-1);
    const curMonths=new Set(plist.filter(p=>p.slice(0,4)===curYear).map(p=>p.slice(5,7)));
    const recent3=plist.slice(-3), prior3=plist.slice(-6,-3);
    const targetBy={}; for(const t of targets){ if(String(t.year)===curYear) targetBy[t.rep_name]=Number(t.target)||0; }
    // health rollups by rep
    const healthBy={}; for(const e of eng){ const rep=e.rep_name||"Unassigned"; const h=healthBy[rep]=healthBy[rep]||{n:0,scoreSum:0,active:0,atRisk:0,dormant:0};
      h.n++; h.scoreSum+=Number(e.score)||0; const s=e.status; if(s==="dormant")h.dormant++; else h.active++; if(s==="watch"||s==="at_risk")h.atRisk++; }
    const taskBy={}; for(const t of tasks){ const rep=t.assigned_rep||"Unassigned"; taskBy[rep]=(taskBy[rep]||0)+1; }

    const allReps=new Set([...Object.keys(byRepMonth),...Object.keys(healthBy),...Object.keys(targetBy)]);
    allReps.delete("Unassigned");
    let reps=[...allReps].map(rep=>{
      const m=byRepMonth[rep]||{};
      let ytd=0,prevYtd=0,mtd=0,all=0,r3=0,p3=0;
      for(const p in m){ const v=m[p], y=p.slice(0,4), mo=p.slice(5,7); all+=v;
        if(y===curYear)ytd+=v;
        if(y===prevYear && curMonths.has(mo))prevYtd+=v;
        if(p===latest)mtd+=v;
        if(recent3.includes(p))r3+=v; else if(prior3.includes(p))p3+=v; }
      const h=healthBy[rep]||{n:0,scoreSum:0,active:0,atRisk:0,dormant:0};
      const tgt=targetBy[rep]||0;
      return { rep, sales_ytd:Math.round(ytd), sales_prev_ytd:Math.round(prevYtd),
        yoy: prevYtd>0?Math.round((ytd-prevYtd)/prevYtd*100):null,
        sales_mtd:Math.round(mtd), sales_all:Math.round(all),
        target:Math.round(tgt), attainment: tgt>0?Math.round(ytd/tgt*100):null,
        dealers:h.n, active:h.active, at_risk:h.atRisk, dormant:h.dormant,
        avg_health: h.n?Math.round(h.scoreSum/h.n):0,
        momentum: Math.round(r3-p3), open_tasks: taskBy[rep]||0 };
    });
    // Team-wide performance is management-only. Any non-admin role (rep, relations, …) sees only
    // their own scorecard — never another teammate's sales, attainment, or momentum.
    const ADMIN_ROLES={president:1,admin:1,owner:1};
    const admin=!!ADMIN_ROLES[String(me.role||"").toLowerCase()];
    if(!admin){ const rn=(me.rep_name||"").toLowerCase(); reps=reps.filter(r=>String(r.rep).toLowerCase()===rn); }
    reps.sort((a,b)=>b.sales_ytd-a.sales_ytd);
    const summary={ year:curYear, prev_year:prevYear,
      team_ytd:reps.reduce((s,r)=>s+r.sales_ytd,0),
      team_target:reps.reduce((s,r)=>s+r.target,0),
      team_prev_ytd:reps.reduce((s,r)=>s+r.sales_prev_ytd,0),
      rep_count:reps.length };
    return json(200,{ok:true,reps,year:curYear,prev_year:prevYear,role:me.role,summary});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

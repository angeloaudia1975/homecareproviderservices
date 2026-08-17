// HCPS automated reporting — builds and sends the weekly executive summary (to leadership)
// and per-rep digests ("call these first"). Data from dealer_engagement + monthly_sales +
// dealer_tasks + rep_targets. Sends via Resend. Gated by automation_config.reports_enabled.
const engine=require("./_engine");
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(p){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${p}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbGetAll(base,col="id"){ const PAGE=1000; let f=0,out=[]; for(;;){ const s=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${s}order=${col}&limit=${PAGE}&offset=${f}`); out=out.concat(rows); if(rows.length<PAGE)break; f+=PAGE; } return out; }
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const ym=p=>String(p||"").slice(0,7);
const eesc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const money=n=>"$"+Math.round(Number(n||0)).toLocaleString("en-US");
const short=n=>{n=Number(n||0);const a=Math.abs(n);if(a>=1e6)return "$"+(n/1e6).toFixed(1)+"M";if(a>=1e3)return "$"+Math.round(n/1e3)+"k";return "$"+Math.round(n);};
const MAIL_FROM=process.env.HCPS_MAIL_FROM||"HCPS Partner Portal <orders@homecareproviderservices.us>";
const SITE_BASE=process.env.SITE_BASE||"https://homecareproviderservices.netlify.app";
async function sendMail({to,subject,html,text}){ const key=process.env.RESEND_API_KEY; if(!key) return {ok:false,skipped:true};
  try{ const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({from:MAIL_FROM,to:[to],subject,html,text})}); return {ok:r.ok}; }catch(e){ return {ok:false}; } }

// ---- Gather everything the reports need, once. -----------------------------
async function gather(){
  const [dealers,dir,eng,tasks,targets,sales,staff]=await Promise.all([
    sbGetAll("dealers?select=id,business_name"),
    sbGet("dealer_directory?select=dealer_name,rep_name").catch(()=>[]),
    sbGet("dealer_engagement?select=dealer_id,rep_name,status,score,churn_score,months_since,last_period,total_sales,recent_sales,trend").catch(()=>[]),
    sbGet("dealer_tasks?status=eq.open&select=assigned_rep").catch(()=>[]),
    sbGet("rep_targets?select=rep_name,year,target").catch(()=>[]),
    sbGetAll("monthly_sales?select=dealer_id,period,customer_name,rep_name,amount"),
    sbGet("staff_users?select=name,email,role,rep_name,active").catch(()=>[]),
  ]);
  const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
  const repByName={}; for(const x of dir) repByName[x.dealer_name]=x.rep_name||"";
  // per-rep sales
  const byRepMonth={}; const periods=new Set();
  for(const r of sales){ const nm=nameById[r.dealer_id]|| (r.customer_name||"").trim(); const rep=(nm&&repByName[nm])||r.rep_name||"Unassigned"; const p=ym(r.period); if(!p)continue; periods.add(p); (byRepMonth[rep]=byRepMonth[rep]||{})[p]=(byRepMonth[rep][p]||0)+(Number(r.amount)||0); }
  const plist=[...periods].sort(); const latest=plist[plist.length-1]||null;
  const curYear=latest?latest.slice(0,4):String(2026), prevYear=String(Number(curYear)-1);
  const curMonths=new Set(plist.filter(p=>p.slice(0,4)===curYear).map(p=>p.slice(5,7)));
  const targetBy={}; for(const t of targets){ if(String(t.year)===curYear) targetBy[t.rep_name]=Number(t.target)||0; }
  const taskBy={}; for(const t of tasks){ const rep=t.assigned_rep||"Unassigned"; taskBy[rep]=(taskBy[rep]||0)+1; }
  // health per dealer (with name)
  const dhealth=eng.map(e=>({...e, name:nameById[e.dealer_id]||"(dealer)"}));
  const atRiskAll=dhealth.filter(d=>d.status==="watch"||d.status==="at_risk").sort((a,b)=>(b.churn_score||0)-(a.churn_score||0)||(b.total_sales||0)-(a.total_sales||0));
  // rep rollups
  const repSet=new Set([...Object.keys(byRepMonth),...dhealth.map(d=>d.rep_name).filter(Boolean),...Object.keys(targetBy)]); repSet.delete("Unassigned");
  const reps=[...repSet].map(rep=>{
    const m=byRepMonth[rep]||{}; let ytd=0,prevYtd=0;
    for(const p in m){ const y=p.slice(0,4),mo=p.slice(5,7); if(y===curYear)ytd+=m[p]; if(y===prevYear&&curMonths.has(mo))prevYtd+=m[p]; }
    const book=dhealth.filter(d=>d.rep_name===rep);
    const at=book.filter(d=>d.status==="watch"||d.status==="at_risk");
    const tgt=targetBy[rep]||0;
    return { rep, ytd:Math.round(ytd), prevYtd:Math.round(prevYtd), yoy:prevYtd>0?Math.round((ytd-prevYtd)/prevYtd*100):null,
      target:Math.round(tgt), attainment:tgt>0?Math.round(ytd/tgt*100):null,
      dealers:book.length, at_risk:at.length, dormant:book.filter(d=>d.status==="dormant").length,
      avg_health:book.length?Math.round(book.reduce((s,d)=>s+(Number(d.score)||0),0)/book.length):0,
      open_tasks:taskBy[rep]||0, atRiskList:at.slice(0,6) };
  }).sort((a,b)=>b.ytd-a.ytd);
  const team={ ytd:reps.reduce((s,r)=>s+r.ytd,0), prevYtd:reps.reduce((s,r)=>s+r.prevYtd,0),
    target:reps.reduce((s,r)=>s+r.target,0),
    at_risk:atRiskAll.length, at_risk_rev:atRiskAll.reduce((s,d)=>s+(Number(d.total_sales)||0),0),
    dormant:dhealth.filter(d=>d.status==="dormant").length, dealers:dhealth.length,
    open_tasks:tasks.length };
  team.yoy = team.prevYtd>0?Math.round((team.ytd-team.prevYtd)/team.prevYtd*100):null;
  // The full-team executive summary goes ONLY to management (president/admin/owner). Every other
  // role — including a Relations Manager — gets a per-rep digest scoped to their own book instead.
  const ADMIN_ROLES=new Set(["president","admin","owner"]);
  const leadership=(staff||[]).filter(s=>s.active!==false && ADMIN_ROLES.has(String(s.role||"").toLowerCase()) && /@/.test(s.email||"")).map(s=>s.email);
  const repStaff=(staff||[]).filter(s=>s.active!==false && !ADMIN_ROLES.has(String(s.role||"").toLowerCase()) && /@/.test(s.email||"") && s.rep_name);
  return {curYear,prevYear,reps,team,atRiskAll,leadership,repStaff};
}

// ---- HTML rendering --------------------------------------------------------
const wrap=(title,inner)=>`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:640px;margin:0 auto">
  <div style="background:#10263f;color:#fff;border-radius:12px 12px 0 0;padding:16px 20px"><div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#aebdd0">HCPS · Sales Operating System</div><div style="font-size:20px;font-weight:800;font-family:'Barlow Condensed',Arial">${title}</div></div>
  <div style="border:1px solid #e2e6ea;border-top:0;border-radius:0 0 12px 12px;padding:18px 20px">${inner}
    <p style="font-size:11px;color:#9aa4ae;margin:18px 0 0">Automated report from the HCPS Admin portal · <a href="${SITE_BASE}/admin/" style="color:#1681c2">Open the portal</a></p></div></div>`;
const kpiTiles=arr=>`<table role="presentation" width="100%" style="border-collapse:separate;border-spacing:6px;margin:0 0 12px"><tr>${arr.map(k=>`<td style="background:#f4f7fa;border:1px solid #e2e6ea;border-radius:9px;padding:9px 10px;text-align:center"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;font-weight:700">${k[0]}</div><div style="font-size:18px;font-weight:800;color:${k[2]||'#10263f'}">${k[1]}</div></td>`).join("")}</tr></table>`;
const riskRow=d=>`<tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;font-weight:700;color:#10263f">${eesc(d.name)}</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;color:#6b7280;font-size:12px">${eesc(d.rep_name||"—")}</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;color:#c2410c;font-weight:700">urgency ${d.churn_score||0}</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;color:#41576b">${d.months_since!=null?d.months_since+"mo":""} · ${short(d.total_sales)}</td></tr>`;

function execReport(data){
  const t=data.team;
  const kpis=kpiTiles([
    ["Sales "+data.curYear,short(t.ytd)],
    ["YoY", t.yoy!=null?((t.yoy>=0?"+":"")+t.yoy+"%"):"—", t.yoy!=null&&t.yoy<0?"#c2410c":"#1f7a44"],
    ["At-risk", String(t.at_risk), "#c2410c"],
    ["At-risk $", short(t.at_risk_rev)],
    ["Dormant", String(t.dormant)],
  ]);
  const risk=data.atRiskAll.slice(0,8);
  const riskTbl = risk.length?`<div style="font-size:13px;font-weight:800;color:#10263f;margin:6px 0 4px">⚠ Accounts to save first</div>
    <table width="100%" style="border-collapse:collapse;font-size:13px">${risk.map(riskRow).join("")}</table>`:"";
  const lb=data.reps.slice(0,10);
  const lbTbl = lb.length?`<div style="font-size:13px;font-weight:800;color:#10263f;margin:16px 0 4px">🏆 Rep leaderboard</div>
    <table width="100%" style="border-collapse:collapse;font-size:13px">
    <tr><td style="padding:5px 8px;color:#6b7280;font-size:10px;text-transform:uppercase">Rep</td><td style="padding:5px 8px;text-align:right;color:#6b7280;font-size:10px;text-transform:uppercase">Sales</td><td style="padding:5px 8px;text-align:right;color:#6b7280;font-size:10px;text-transform:uppercase">Attain</td><td style="padding:5px 8px;text-align:right;color:#6b7280;font-size:10px;text-transform:uppercase">YoY</td></tr>
    ${lb.map(r=>`<tr><td style="padding:5px 8px;border-top:1px solid #eef2f6;font-weight:700">${eesc(r.rep)}</td><td style="padding:5px 8px;border-top:1px solid #eef2f6;text-align:right">${money(r.ytd)}</td><td style="padding:5px 8px;border-top:1px solid #eef2f6;text-align:right">${r.attainment!=null?r.attainment+"%":"—"}</td><td style="padding:5px 8px;border-top:1px solid #eef2f6;text-align:right;color:${r.yoy==null?'#6b7280':r.yoy<0?'#c2410c':'#1f7a44'}">${r.yoy!=null?((r.yoy>=0?'+':'')+r.yoy+'%'):'—'}</td></tr>`).join("")}
    </table>`:"";
  const inner=`<p style="font-size:13.5px;color:#374151;margin:0 0 12px">Here's the weekly pulse across the book — ${t.dealers} dealers, ${t.open_tasks} open follow-ups.</p>${kpis}${riskTbl}${lbTbl}`;
  return {subject:`HCPS weekly sales summary — ${short(t.ytd)} YTD, ${t.at_risk} at-risk`, html:wrap("Weekly Sales Summary",inner),
    text:`HCPS weekly summary\nSales ${data.curYear}: ${money(t.ytd)} (YoY ${t.yoy!=null?t.yoy+"%":"n/a"})\nAt-risk accounts: ${t.at_risk} (${money(t.at_risk_rev)})\nDormant: ${t.dormant}\nOpen the portal: ${SITE_BASE}/admin/`};
}
function repDigest(r,curYear){
  const kpis=kpiTiles([
    ["Your sales "+curYear,short(r.ytd)],
    ["Attainment", r.attainment!=null?r.attainment+"%":"—", r.attainment!=null&&r.attainment<100?"#F5821F":"#1f7a44"],
    ["YoY", r.yoy!=null?((r.yoy>=0?"+":"")+r.yoy+"%"):"—", r.yoy!=null&&r.yoy<0?"#c2410c":"#1f7a44"],
    ["At-risk", String(r.at_risk), "#c2410c"],
  ]);
  const risk=r.atRiskList||[];
  const riskTbl=risk.length?`<div style="font-size:13px;font-weight:800;color:#10263f;margin:6px 0 4px">📞 Call these first</div>
    <table width="100%" style="border-collapse:collapse;font-size:13px">${risk.map(riskRow).join("")}</table>`:`<p style="font-size:13px;color:#1f7a44">No at-risk accounts in your book this week — nice work. 🎉</p>`;
  const inner=`<p style="font-size:13.5px;color:#374151;margin:0 0 12px">Good morning ${eesc(r.rep)} — your book at a glance and who needs a touch this week.</p>${kpis}${riskTbl}
    <p style="font-size:12.5px;color:#6b7280;margin:14px 0 0">You have ${r.open_tasks} open task${r.open_tasks===1?"":"s"}. <a href="${SITE_BASE}/admin/tasks.html" style="color:#1681c2">Open My Tasks</a> · <a href="${SITE_BASE}/admin/health.html" style="color:#1681c2">Dealer Health</a></p>`;
  return {subject:`Your week: ${short(r.ytd)} YTD · ${r.at_risk} to save`, html:wrap("Your Weekly Digest",inner),
    text:`Your week, ${r.rep}\nSales ${curYear}: ${money(r.ytd)} (${r.attainment!=null?r.attainment+"% of target":"no target set"})\nAt-risk accounts: ${r.at_risk}\nOpen My Tasks: ${SITE_BASE}/admin/tasks.html`};
}

// ---- Orchestration ---------------------------------------------------------
async function previewExec(){ const data=await gather(); return execReport(data); }
async function sendReports(opts){
  opts=opts||{}; const cfg=await engine.getConfig();
  const data=await gather();
  const recips=[...new Set([...(data.leadership||[]),...((cfg.report_recipients)||[])])];
  let execSent=0, repSent=0, skipped=[];
  // exec report to leadership
  const ex=execReport(data);
  for(const to of recips){ const r=await sendMail({to,...ex}); if(r.ok)execSent++; else skipped.push(to); }
  // per-rep digests
  for(const s of (data.repStaff||[])){ const r=data.reps.find(x=>String(x.rep).toLowerCase()===String(s.rep_name).toLowerCase()); if(!r)continue;
    const dg=repDigest(r,data.curYear); const res=await sendMail({to:s.email,...dg}); if(res.ok)repSent++; else skipped.push(s.email); }
  return {ok:true, recipients:recips.length, exec_sent:execSent, rep_digests:repSent, skipped, resend: !!process.env.RESEND_API_KEY };
}
module.exports={gather,previewExec,sendReports};

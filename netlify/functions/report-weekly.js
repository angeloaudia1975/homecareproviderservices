// HCPS weekly reports (Netlify scheduled function; see netlify.toml). Sends the executive
// summary to leadership + a per-rep "call these first" digest each Monday morning. Gated by
// automation_config.reports_enabled (default off) so nothing goes out until you turn it on.
const engine=require("./_engine");
const report=require("./_report");
exports.handler=async()=>{
  try{
    const cfg=await engine.getConfig();
    if(cfg.reports_enabled!==true) return {statusCode:200,body:JSON.stringify({skipped:"reports disabled"})};
    const r=await report.sendReports();
    return {statusCode:200,headers:{"content-type":"application/json"},body:JSON.stringify({ok:true,...r})};
  }catch(e){ return {statusCode:500,body:String(e&&e.message||e)}; }
};

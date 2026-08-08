// HCPS automation engine — HOURLY tick (Netlify scheduled function; see netlify.toml).
// DECIDES every business hour: refresh auto-tasks, queue eligible emails. DELIVERS
// only when the current ET hour falls inside a send window. Outside weekday business
// hours it returns immediately after one tiny config read. Delivery still respects the
// master email_enabled switch (dry-run) and the per-dealer frequency cap.
const E=require("./_engine");
const I=require("./_intent");
const ok=o=>({statusCode:200,headers:{"content-type":"application/json"},body:JSON.stringify(o)});
exports.handler=async()=>{
  try{
    const cfg=await E.getConfig();
    if(cfg.engine_enabled===false) return ok({skipped:"engine disabled"});
    if(!E.inBusiness(cfg)) return ok({skipped:"outside business hours"});
    const sig=await E.computeSignals();
    const tasks=await E.runTasks(sig);
    const emails=await E.enqueueEmails(sig,cfg);
    // Intent refresh + high-intent rep tasks + product-interest emails (isolated so it
    // can never break the engine). Runs BEFORE delivery so queued product emails drain.
    let intent=null;
    try{ const sc=await I.computeIntent(); const it=await I.syncIntentTasks(); const pe=await I.enqueueIntentEmails(); intent={score:sc,tasks:it,emails:pe}; }
    catch(e){ intent={error:String(e&&e.message||e)}; }
    const w=E.currentWindow(cfg);
    const delivery=w?await E.drainQueue(cfg,w):{skipped:"no send window this hour"};
    return ok({ran:true,window:w||null,tasks,emails,delivery,intent});
  }catch(e){ return {statusCode:500,body:String(e&&e.message||e)}; }
};

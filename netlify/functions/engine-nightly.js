// HCPS automation engine — NIGHTLY tick (Netlify scheduled function; see netlify.toml).
// Recomputes the dealer_engagement cache (status/score/cadence) and expires any stale
// queued emails past their TTL. Runs once overnight (off business hours) so daytime
// reads are fast and dormant/engagement status stays current.
const E=require("./_engine");
const I=require("./_intent");
exports.handler=async()=>{
  try{
    const xs=await E.computeCrossSell();       // refresh "bought this -> look at this"
    const r=await E.recomputeEngagement();      // rebuild dealer-health scores for every dealer
    // Phase 1: relationship matrix + full intent recompute + rep tasks. Isolated so a
    // hiccup here never blocks the nightly health/cross-sell rebuild above.
    let intent=null;
    try{
      const ls=await I.computeLineStatus();     // active/prospect/dormant per dealer x line
      const sc=await I.computeIntent();         // decayed rolling intent score
      const it=await I.syncIntentTasks();       // raise/retire high-intent "call dealer" tasks
      const po=await I.enqueuePostOrder();      // post-order check-in for recent online orders
      intent={line_status:ls,score:sc,tasks:it,postorder:po};
    }catch(e){ intent={error:String(e&&e.message||e)}; }
    return {statusCode:200,headers:{"content-type":"application/json"},body:JSON.stringify({ok:true,crosssell:xs,...r,intent})};
  }catch(e){ return {statusCode:500,body:String(e&&e.message||e)}; }
};

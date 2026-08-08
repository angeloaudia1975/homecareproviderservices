// HCPS automation engine — NIGHTLY tick (Netlify scheduled function; see netlify.toml).
// Recomputes the dealer_engagement cache (status/score/cadence) and expires any stale
// queued emails past their TTL. Runs once overnight (off business hours) so daytime
// reads are fast and dormant/engagement status stays current.
const E=require("./_engine");
exports.handler=async()=>{
  try{
    const xs=await E.computeCrossSell();       // refresh "bought this -> look at this"
    const r=await E.recomputeEngagement();      // rebuild dealer-health scores for every dealer
    return {statusCode:200,headers:{"content-type":"application/json"},body:JSON.stringify({ok:true,crosssell:xs,...r})};
  }catch(e){ return {statusCode:500,body:String(e&&e.message||e)}; }
};

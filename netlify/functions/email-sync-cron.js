// HCPS Dealer 360 — email auto-sync (Netlify scheduled function; see netlify.toml).
// Runs hourly with no user interaction: pulls a short recent window from every connected
// mailbox, matches to dealers, and stores it. Idempotent (upsert on graph_id), so re-runs
// never duplicate. The manual "Sync now" button handles big backfills; this keeps it current.
const { runSync } = require("./email-sync-api.js");
exports.handler = async ()=>{
  try{
    if(!process.env.GRAPH_TENANT_ID || !process.env.GRAPH_CLIENT_ID || !process.env.GRAPH_CLIENT_SECRET)
      return { statusCode:200, body:JSON.stringify({skipped:"graph env not set"}) };
    if(!String(process.env.GRAPH_MAILBOXES||"").trim())
      return { statusCode:200, body:JSON.stringify({skipped:"no mailboxes"}) };
    const r = await runSync({ days: 3, per_folder: 200, cap: 800 });   // light, recent, current
    return { statusCode:200, body:JSON.stringify({ran:true, ...r}) };
  }catch(e){ return { statusCode:500, body:String(e&&e.message||e) }; }
};

// HCPS Activation / Go-Live Control — shared platform-state helper.
// One source of truth for the operating mode (development | sandbox | live),
// the env stamp written on behavioral data, and the gates that decide what may
// actually send or feed production intelligence. Imported by the engine, the
// intent core, the event capture, order confirmation, and the welcome email.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }

const MODES=["development","sandbox","live"];

// Current platform state. Defaults to development if unreadable so nothing ever
// sends or contaminates production on a config hiccup.
async function getState(){
  try{ const rows=await sbGet("app_settings?key=eq.platform_state&select=value");
    const v=(rows&&rows[0]&&rows[0].value)||{};
    const mode=MODES.includes(v.mode)?v.mode:"development";
    return {mode,go_live_at:v.go_live_at||null,mode_since:v.mode_since||null,changed_by:v.changed_by||null,history:Array.isArray(v.history)?v.history:[]};
  }catch(e){ return {mode:"development",go_live_at:null,mode_since:null,changed_by:null,history:[]}; }
}

// Persist a mode change. Stamps go_live_at ONCE on the first switch to live and
// appends an audit entry. nowIso is passed in (functions can't call Date.now in
// some contexts); callers supply it.
async function setMode(mode,byEmail,nowIso){
  if(!MODES.includes(mode)) throw new Error("invalid mode");
  const cur=await getState();
  const go_live_at = cur.go_live_at || (mode==="live" ? nowIso : null);
  const history=(cur.history||[]).concat([{mode,at:nowIso,by:byEmail||null}]).slice(-50);
  const value={mode,go_live_at,mode_since:nowIso,changed_by:byEmail||null,history};
  await sbSend("PATCH","app_settings?key=eq.platform_state",{value,updated_at:nowIso},{Prefer:"return=minimal"});
  return {mode,go_live_at,mode_since:nowIso};
}

// The env to stamp on a behavioral row: flagged test accounts are always 'test';
// everyone else takes the current platform mode.
function envFor(mode,isTest){ return isTest ? "test" : (MODES.includes(mode)?mode:"development"); }

// Read filter for PRODUCTION intelligence: when Live, score ONLY live data, so
// all the development/test history is retained but never counted. Before go-live
// (development/sandbox) we DO consider the data so automations can be validated.
function scoringEnvClause(mode,col){ col=col||"env"; return mode==="live" ? `&${col}=eq.live` : ""; }

// Send gates.
//  - transactional (order confirmation, welcome): reach real dealers only when
//    Live; before that, only flagged test accounts (so you can test delivery).
function allowTransactional(mode,isTest){ return mode==="live" || !!isTest; }
//  - marketing/automation to real dealers: Live AND the email master switch on;
//    test accounts may receive in sandbox/live for template testing.
function allowMarketing(mode,isTest,emailEnabled){ return isTest ? (mode==="sandbox"||mode==="live") : (mode==="live" && !!emailEnabled); }

const isLive=mode=>mode==="live";

module.exports={ MODES,getState,setMode,envFor,scoringEnvClause,allowTransactional,allowMarketing,isLive };

// MI-1a — import routing between the existing importers and the atomic database functions.
//
// Two switches in app_settings.phase2_flags, both OFF until Angelo turns them on:
//   mi_import_v2      — Sales Report Import uses hcps_sales_report_apply for ENROLLED manufacturers
//   mi_commission_v2  — Commission Report Import uses hcps_commission_file_apply (whole file, one transaction)
// Enrolment (table mi1a_enrollment) is written ONLY by the reviewed SQL (the Strongback re-key, and the
// commission-lane step at its own activation) — never by code, never automatically.
//
//   Sales import     not enrolled → legacy (today's path, unchanged), whatever the switch says
//                    enrolled + switch on  → v2
//                    enrolled + switch off → paused (the database write guard would refuse the old path)
//   Commission import switch on → v2 · switch off + lane enrolled → paused · switch off → legacy
//
// A read failure of mi1a_enrollment is an error (strict), except "table not installed yet" which means
// nothing is enrolled — the state before Part 1 runs.
const NOT_INSTALLED = /PGRST205|42P01|Could not find the table|does not exist/i;

function routeSales(flagOn, isEnrolled){ return isEnrolled ? (flagOn ? "v2" : "paused") : "legacy"; }
function routeCommission(flagOn, isEnrolled){ return flagOn ? "v2" : (isEnrolled ? "paused" : "legacy"); }

function make(sbGet, sbSend){
  async function enrolled(slug, lane){
    const s = String(slug||"").trim(); if(!s) return false;
    try{
      const rows = await sbGet(`mi1a_enrollment?lane=eq.${encodeURIComponent(lane)}&manufacturer=in.(${encodeURIComponent(s)},*)&select=manufacturer`);
      return Array.isArray(rows) && rows.length > 0;
    }catch(e){
      if(NOT_INSTALLED.test(String(e && e.message || e))) return false;
      throw e;
    }
  }
  // Call one MI-1a database function. A refusal raised by the function (mi1a_*) comes back as
  // {refused:true, code, message}; anything else is thrown so the caller reports a real error.
  async function rpc(fn, p){
    try{
      const r = await sbSend("POST", `rpc/${fn}`, { p });
      return { ok:true, result:r };
    }catch(e){
      const msg = String(e && e.message || e);
      const m = msg.match(/(mi1a_[a-z_]+)/);
      if(m) return { ok:false, refused:true, code:m[1], message:extractMessage(msg) };
      throw e;
    }
  }
  return { enrolled, rpc };
}
function extractMessage(msg){
  const j = msg.indexOf("{");
  if(j >= 0){ try{ const o = JSON.parse(msg.slice(j)); if(o && o.message) return String(o.message); }catch(e){} }
  return msg;
}
const PAUSED_SALES = "Imports for this manufacturer are paused: its sales rows use the MI-1a keys but the mi_import_v2 switch is off. Turn the switch on, or finish the MI-1a rollback (R1) first.";
const PAUSED_COMMISSION = "Commission imports are paused: the MI-1a write guard covers this manufacturer but the mi_commission_v2 switch is off. Turn the switch on, or finish the MI-1a rollback (R1) first.";

module.exports = { make, routeSales, routeCommission, PAUSED_SALES, PAUSED_COMMISSION, NOT_INSTALLED };

// Phase 2 feature switches (app_settings key "phase2_flags"), e.g.
//   {"adhoc_visit":true,"morning_brief":false,"eod_recap":false,"timeline":false,"conversion":false,"device_check":false}
// A feature is ON only when its value is exactly true; a missing row, a missing key or a read error
// means OFF — Phase 1 behaviour. Turning one off is the first step of any Phase 2 rollback: the
// button or card disappears and the feature's entry point answers "not turned on", with no deploy.
// Pass the calling function's own sbGet.
async function flags(sbGet){
  try{
    const r=await sbGet("app_settings?key=eq.phase2_flags&select=value");
    const v=r&&r[0]&&r[0].value;
    return (v&&typeof v==="object"&&!Array.isArray(v)) ? v : {};
  }catch(e){ return {}; }
}
async function flagOn(sbGet, name){ const f=await flags(sbGet); return f[name]===true; }
module.exports = { flags, flagOn };

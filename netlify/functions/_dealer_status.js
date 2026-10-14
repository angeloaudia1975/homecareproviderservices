// HCPS CRM lifecycle, separate from onboarding status and ordering permissions.
const isActive = row => !!row && row.active !== false;
async function activeIds(sbGetAll){
  const rows = await sbGetAll("dealers?select=id,active","id");
  return new Set((rows||[]).filter(isActive).map(d=>String(d.id)));
}
async function isDealerActive(sbGet,id){
  if(!id) return false;
  const rows = await sbGet(`dealers?id=eq.${encodeURIComponent(id)}&select=id,active`);
  return !!(rows&&rows[0]&&isActive(rows[0]));
}
module.exports={isActive,activeIds,isDealerActive};

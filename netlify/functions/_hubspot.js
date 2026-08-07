// HubSpot API helper — SERVER-SIDE ONLY. Uses HUBSPOT_ACCESS_TOKEN (a HubSpot Service Key /
// private-app token) from this site's Netlify env. The token must NEVER be exposed to the
// browser. All calls go through here so auth + error handling live in one place.
const HS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const HS_BASE  = "https://api.hubapi.com";

const hasToken = () => !!HS_TOKEN;

// Low-level call. Returns {ok, status, json} — never throws on HTTP errors so callers can
// inspect status (e.g. 403 = missing scope) and report it cleanly.
async function hs(method, path, body){
  if(!HS_TOKEN) return { ok:false, status:0, json:{ message:"HUBSPOT_ACCESS_TOKEN not set" } };
  let r;
  try{
    r = await fetch(`${HS_BASE}${path}`, {
      method,
      headers:{ Authorization:`Bearer ${HS_TOKEN}`, "Content-Type":"application/json" },
      body: body!=null ? JSON.stringify(body) : undefined,
    });
  }catch(e){ return { ok:false, status:0, json:{ message:String(e&&e.message||e) } }; }
  const text = await r.text().catch(()=> "");
  let json=null; try{ json = text ? JSON.parse(text) : null; }catch(e){ json = { raw:text }; }
  return { ok:r.ok, status:r.status, json };
}

// Upsert a CRM object by a unique property (idProperty) — HubSpot updates the matching record
// or creates it if none exists. Used later by the dealer/contact/deal sync. properties is a
// flat {name:value} map.
async function upsert(objectType, idProperty, idValue, properties){
  // Try update-by-unique-property first; fall back to create when not found.
  const enc = encodeURIComponent(String(idValue));
  const up = await hs("PATCH", `/crm/v3/objects/${objectType}/${enc}?idProperty=${encodeURIComponent(idProperty)}`, { properties });
  if(up.ok) return { ...up, mode:"updated" };
  if(up.status===404){
    const cr = await hs("POST", `/crm/v3/objects/${objectType}`, { properties });
    return { ...cr, mode:"created" };
  }
  return { ...up, mode:"error" };
}

// Ensure a custom UNIQUE text property exists on an object (idempotent). We key our syncs on
// these (e.g. hcps_dealer_id) so re-running updates the same record instead of duplicating.
async function ensureUniqueProp(objectType, name, label, groupName){
  const check = await hs("GET", `/crm/v3/properties/${objectType}/${encodeURIComponent(name)}`);
  if(check.ok) return { ok:true, existed:true };
  const create = await hs("POST", `/crm/v3/properties/${objectType}`, {
    name, label, type:"string", fieldType:"text", groupName, hasUniqueValue:true, hidden:false,
  });
  return { ok:create.ok, existed:false, status:create.status, error: create.ok ? undefined : (create.json && create.json.message) };
}

// Batch upsert by a unique idProperty. records = [{id, properties}]. Chunks of 100 (HubSpot cap).
// Returns {processed, errors:[{batch,status,message}]}.
async function batchUpsert(objectType, idProperty, records){
  const out = { processed:0, errors:[] };
  for(let i=0;i<records.length;i+=100){
    const inputs = records.slice(i,i+100).map(r=>({ idProperty, id:String(r.id), properties:r.properties }));
    const res = await hs("POST", `/crm/v3/objects/${objectType}/batch/upsert`, { inputs });
    if(res.ok){ out.processed += ((res.json && res.json.results) || inputs).length; }
    else out.errors.push({ batch:i/100, status:res.status, message:(res.json && (res.json.message || JSON.stringify(res.json).slice(0,200))) || "error" });
  }
  return out;
}

module.exports = { hs, upsert, ensureUniqueProp, batchUpsert, hasToken };

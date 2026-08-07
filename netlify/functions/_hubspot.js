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

module.exports = { hs, upsert, hasToken };

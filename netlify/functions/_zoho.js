// Zoho CRM API helper — SERVER-SIDE ONLY. Zoho uses OAuth 2.0: a long-lived REFRESH TOKEN is
// exchanged for short-lived access tokens. We keep the client id/secret in Netlify env and the
// refresh token in Supabase (app_settings), so no durable credential ever reaches the browser.
//
// Env: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_ACCOUNTS_DOMAIN (default accounts.zoho.com — set
//      to accounts.zoho.eu / .in / .com.au for other data centers).
const ACCOUNTS     = process.env.ZOHO_ACCOUNTS_DOMAIN || "accounts.zoho.com";
const CLIENT_ID    = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET= process.env.ZOHO_CLIENT_SECRET;

const hasCreds = () => !!(CLIENT_ID && CLIENT_SECRET);

async function tokenCall(params){
  const body = new URLSearchParams({ client_id:CLIENT_ID, client_secret:CLIENT_SECRET, ...params });
  let r;
  try{ r = await fetch(`https://${ACCOUNTS}/oauth/v2/token`, { method:"POST", headers:{ "content-type":"application/x-www-form-urlencoded" }, body }); }
  catch(e){ return { ok:false, status:0, error:String(e&&e.message||e) }; }
  const j = await r.json().catch(()=> ({}));
  return { ok:r.ok, status:r.status, json:j };
}

// One-time: swap the Self Client authorization code for a refresh token (never expires) +
// the account's api_domain (which encodes the data center).
async function exchangeCode(code){
  const t = await tokenCall({ grant_type:"authorization_code", code });
  if(!t.ok || !t.json.refresh_token) return { ok:false, status:t.status, error:(t.json&&(t.json.error||JSON.stringify(t.json).slice(0,200)))||t.error||"exchange failed" };
  return { ok:true, refresh_token:t.json.refresh_token, api_domain:t.json.api_domain || "https://www.zohoapis.com" };
}

// Get a fresh access token from the stored refresh token.
async function accessToken(refresh_token){
  const t = await tokenCall({ grant_type:"refresh_token", refresh_token });
  if(!t.ok || !t.json.access_token) return { ok:false, status:t.status, error:(t.json&&(t.json.error||JSON.stringify(t.json).slice(0,200)))||t.error||"refresh failed" };
  return { ok:true, access_token:t.json.access_token, api_domain:t.json.api_domain || "https://www.zohoapis.com" };
}

// Low-level CRM call. Never throws on HTTP errors so callers can inspect status.
async function zoho(method, apiDomain, token, path, body){
  let r;
  try{
    r = await fetch(`${apiDomain}${path}`, {
      method,
      headers:{ Authorization:`Zoho-oauthtoken ${token}`, "Content-Type":"application/json" },
      body: body!=null ? JSON.stringify(body) : undefined,
    });
  }catch(e){ return { ok:false, status:0, json:{ message:String(e&&e.message||e) } }; }
  const text = await r.text().catch(()=> "");
  let json=null; try{ json = text ? JSON.parse(text) : null; }catch(e){ json = { raw:text }; }
  return { ok:r.ok, status:r.status, json };
}

// List a module's fields (used to find a custom field's auto-generated api_name).
async function getFields(apiDomain, token, module){
  const r = await zoho("GET", apiDomain, token, `/crm/v8/settings/fields?module=${encodeURIComponent(module)}&type=all`);
  return (r.ok && r.json && Array.isArray(r.json.fields)) ? r.json.fields : [];
}

// Ensure a custom text field exists on a module; returns its api_name. Zoho auto-generates the
// api_name from the label, so after creating we re-read the fields to capture it. Idempotent.
async function ensureTextField(apiDomain, token, module, label, length){
  let fields = await getFields(apiDomain, token, module);
  let f = fields.find(x => x.field_label === label);
  if(f) return { ok:true, api_name:f.api_name, existed:true };
  const cr = await zoho("POST", apiDomain, token, `/crm/v8/settings/fields?module=${encodeURIComponent(module)}`,
    { fields:[{ field_label:label, data_type:"text", length:length||120 }] });
  const created = cr.ok || (cr.json && Array.isArray(cr.json.fields) && cr.json.fields[0] && cr.json.fields[0].code==="SUCCESS");
  if(!created) return { ok:false, error:(cr.json && JSON.stringify(cr.json).slice(0,200)) || ("http "+cr.status) };
  fields = await getFields(apiDomain, token, module);
  f = fields.find(x => x.field_label === label);
  return f ? { ok:true, api_name:f.api_name, existed:false } : { ok:false, error:"created but api_name not found" };
}

// Upsert records into a module, matched by duplicate_check_fields. records = [{key, record}]
// where key is our own id (so we can map key -> Zoho id afterward for associations). Chunks of 100.
async function upsertRecords(apiDomain, token, module, records, dupFields){
  const out = { processed:0, inserted:0, updated:0, errors:[], idByKey:{} };
  for(let i=0;i<records.length;i+=100){
    const chunk = records.slice(i, i+100);
    const r = await zoho("POST", apiDomain, token, `/crm/v8/${encodeURIComponent(module)}/upsert`,
      { data: chunk.map(x=>x.record), duplicate_check_fields: dupFields });
    if(r.ok && r.json && Array.isArray(r.json.data)){
      r.json.data.forEach((row, idx)=>{
        if(row && row.code==="SUCCESS"){
          out.processed++; if(row.action==="insert") out.inserted++; else out.updated++;
          const key = chunk[idx] && chunk[idx].key, id = row.details && row.details.id;
          if(key && id) out.idByKey[key] = id;
        } else if(out.errors.length<8){ out.errors.push({ code:row&&row.code, message:row&&row.message }); }
      });
    } else out.errors.push({ batch:i/100, status:r.status, message:(r.json && JSON.stringify(r.json).slice(0,200)) || "error" });
  }
  return out;
}

// Read all records of a module (paginated, 200/page) with the given comma-separated fields.
async function getAllRecords(apiDomain, token, module, fields){
  const out=[]; let page=1;
  for(;;){
    const r = await zoho("GET", apiDomain, token, `/crm/v8/${encodeURIComponent(module)}?fields=${encodeURIComponent(fields)}&per_page=200&page=${page}`);
    if(!r.ok || !r.json || !Array.isArray(r.json.data)) break;
    out.push(...r.json.data);
    if(!(r.json.info && r.json.info.more_records)) break;
    page++; if(page>60) break;   // safety cap
  }
  return out;
}

module.exports = { hasCreds, exchangeCode, accessToken, zoho, getFields, ensureTextField, upsertRecords, getAllRecords, ACCOUNTS };

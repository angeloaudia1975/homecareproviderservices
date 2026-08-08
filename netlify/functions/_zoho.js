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

module.exports = { hasCreds, exchangeCode, accessToken, zoho, ACCOUNTS };

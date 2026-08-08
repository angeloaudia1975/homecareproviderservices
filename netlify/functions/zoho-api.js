// HCPS ↔ Zoho CRM integration API. President-only. Server-side (Supabase service-role, Zoho OAuth).
// Client id/secret live in Netlify env; the refresh token is captured once (oauth_exchange) and
// stored in Supabase app_settings — never in the browser or in chat.
//
//   POST {action:"status"}                 -> are creds set? is the account connected?
//   POST {action:"oauth_exchange", code}   -> swap the Self Client code for a refresh token + store it
//   POST {action:"test"}                   -> confirm we can reach Zoho CRM (reads org + modules)
//   (sync actions to follow)
//   All require a President Bearer token.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const { hasCreds, exchangeCode, accessToken, zoho, ensureTextField, upsertRecords, ACCOUNTS } = require("./_zoho.js");
const clean = v => { const s=(v==null?"":String(v)).trim(); return s||undefined; };

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }

// Zoho auth config (refresh token + api domain) is stored under app_settings key "zoho_auth".
async function getZohoAuth(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_auth&select=value"); return (rows&&rows[0]&&rows[0].value)||null; }catch(e){ return null; } }
async function setZohoAuth(value){ await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_auth",value,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
// The Zoho api_names of our match fields (auto-generated from the labels) are cached here.
async function getZohoFields(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_fields&select=value"); return (rows&&rows[0]&&rows[0].value)||{}; }catch(e){ return {}; } }
async function setZohoFields(value){ await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_fields",value,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",email,name:su.name||email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",email:"",name:"Admin"};
  return null;
}

// Resolve a fresh access token (+ api domain) from the stored refresh token.
async function connect(){
  const cfg=await getZohoAuth();
  if(!cfg||!cfg.refresh_token) return { ok:false, reason:"not_connected" };
  const at=await accessToken(cfg.refresh_token);
  if(!at.ok) return { ok:false, reason:"refresh_failed", error:at.error };
  return { ok:true, token:at.access_token, apiDomain:(cfg.api_domain||at.api_domain||"https://www.zohoapis.com").replace(/\/+$/,"") };
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    if(me.role!=="president") return json(403,{error:"President only"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    if(b.action==="status"){
      const cfg=await getZohoAuth();
      return json(200,{ ok:true, creds_set:hasCreds(), connected:!!(cfg&&cfg.refresh_token),
        api_domain:(cfg&&cfg.api_domain)||null, accounts_domain:ACCOUNTS,
        message: !hasCreds() ? "Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in Netlify, then paste your Self Client code."
          : (cfg&&cfg.refresh_token) ? "Connected to Zoho." : "Credentials set — paste your Self Client authorization code to finish connecting." });
    }

    if(b.action==="oauth_exchange"){
      if(!hasCreds()) return json(200,{ok:false,message:"Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in Netlify first."});
      const code=String(b.code||"").trim();
      if(!code) return json(400,{error:"code required"});
      const ex=await exchangeCode(code);
      if(!ex.ok) return json(200,{ok:false,message:"Zoho rejected the code — it may have expired (they last a few minutes) or the scopes were off. Generate a fresh code and try again.",detail:ex.error});
      await setZohoAuth({ refresh_token:ex.refresh_token, api_domain:ex.api_domain, connected_at:new Date().toISOString() });
      return json(200,{ok:true,message:"Connected to Zoho — refresh token stored securely.",api_domain:ex.api_domain});
    }

    if(b.action==="test"){
      const c=await connect();
      if(!c.ok) return json(200,{ok:false,connected:false,reason:c.reason,message: c.reason==="not_connected" ? "Not connected yet — finish the Self Client step." : "Couldn't refresh the Zoho token — reconnect.",detail:c.error});
      const org=await zoho("GET",c.apiDomain,c.token,"/crm/v8/org");
      const mods=await zoho("GET",c.apiDomain,c.token,"/crm/v8/settings/modules");
      const orgName = org.ok && org.json && org.json.org && org.json.org[0] && org.json.org[0].company_name;
      return json(200,{ ok:org.ok||mods.ok, connected:true, api_domain:c.apiDomain,
        org: orgName || null, modules_read: mods.ok ? "ok" : ("http "+mods.status),
        message: (org.ok||mods.ok) ? "Connected to Zoho CRM." : "Token works but CRM read failed — check the Self Client scopes." });
    }

    // One-time (idempotent) setup: create the match fields our syncs upsert against.
    if(b.action==="setup"){
      const c=await connect();
      if(!c.ok) return json(200,{ok:false,message: c.reason==="not_connected"?"Not connected yet — finish the Self Client step.":"Couldn't refresh the Zoho token — reconnect.",reason:c.reason});
      const acc=await ensureTextField(c.apiDomain,c.token,"Accounts","HCPS Dealer ID",120);
      const con=await ensureTextField(c.apiDomain,c.token,"Contacts","HCPS Contact ID",120);
      const fields={}; if(acc.ok) fields.account_key=acc.api_name; if(con.ok) fields.contact_key=con.api_name;
      if(Object.keys(fields).length) await setZohoFields(fields);
      return json(200,{ ok:(acc.ok&&con.ok), account_key:acc, contact_key:con,
        message:(acc.ok&&con.ok)?"Zoho is set up for syncing.":"Couldn't create a match field — check the ZohoCRM.settings.ALL scope on your Self Client." });
    }

    // Push every dealer into Zoho as an Account, matched by our HCPS Dealer ID field so re-runs
    // update instead of duplicate.
    if(b.action==="sync_accounts"){
      const c=await connect();
      if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      let fields=await getZohoFields();
      if(!fields.account_key){ const acc=await ensureTextField(c.apiDomain,c.token,"Accounts","HCPS Dealer ID",120);
        if(!acc.ok) return json(200,{ok:false,message:"Couldn't ensure the match field.",detail:acc.error});
        fields.account_key=acc.api_name; await setZohoFields(fields); }
      const key=fields.account_key;
      const dealers=await sbGetAll("dealers?select=id,business_name,city,state,zip,phone,address","id");
      const records=dealers.map(d=>({ key:String(d.id), record:{
        Account_Name:(clean(d.business_name)||("Dealer "+d.id)).slice(0,255),
        [key]:String(d.id),
        Phone:clean(d.phone),
        Billing_Street:clean(d.address), Billing_City:clean(d.city), Billing_State:clean(d.state), Billing_Code:clean(d.zip),
      }}));
      const res=await upsertRecords(c.apiDomain,c.token,"Accounts",records,[key]);
      return json(200,{ ok:res.errors.length===0, total:dealers.length, processed:res.processed, inserted:res.inserted, updated:res.updated, errors:res.errors.slice(0,5) });
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

// HCPS ↔ HubSpot integration API. President-only. Server-side (Supabase service-role for reads,
// HUBSPOT_ACCESS_TOKEN for HubSpot). This first cut ships the connection test so we can confirm
// the Service Key works and is scoped correctly; the dealer / contact / deal sync builds on it.
//
//   POST {action:"test"}   -> verify the token reaches HubSpot + which CRM objects are readable
//   (sync actions to follow)
//   All require a President Bearer token (staff email/password JWT).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const { hs, hasToken } = require("./_hubspot.js");

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }

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

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    if(me.role!=="president") return json(403,{error:"President only"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    if(b.action==="test"){
      if(!hasToken()) return json(200,{ok:false,configured:false,message:"HUBSPOT_ACCESS_TOKEN is not set on this site's Netlify env yet."});
      // account details (confirms the token authenticates) + probe each CRM object we plan to sync
      const acct=await hs("GET","/account-info/v3/details");
      const co=await hs("GET","/crm/v3/objects/companies?limit=1");
      const ct=await hs("GET","/crm/v3/objects/contacts?limit=1");
      const dl=await hs("GET","/crm/v3/objects/deals?limit=1");
      const scopeOk=s=>s===200 ? "ok" : (s===403 ? "missing scope" : ("http "+s));
      const authOk = acct.ok || co.ok || ct.ok || dl.ok;
      return json(200,{
        ok: authOk,
        configured: true,
        account: acct.ok ? { portalId:acct.json&&acct.json.portalId, accountType:acct.json&&acct.json.accountType, timeZone:acct.json&&acct.json.timeZone } : null,
        scopes: { companies_read:scopeOk(co.status), contacts_read:scopeOk(ct.status), deals_read:scopeOk(dl.status) },
        message: authOk
          ? "Connected to HubSpot."
          : "Token is set but HubSpot rejected it — check the Service Key value and scopes.",
      });
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

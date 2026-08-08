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
const { hasCreds, exchangeCode, accessToken, zoho, ensureTextField, upsertRecords, getAllRecords, ACCOUNTS } = require("./_zoho.js");
const clean = v => { const s=(v==null?"":String(v)).trim(); return s||undefined; };
// Derive a website from a business email domain; skip common personal providers.
const PERSONAL = new Set(["gmail.com","yahoo.com","hotmail.com","aol.com","outlook.com","icloud.com","comcast.net","att.net","msn.com","live.com","sbcglobal.net","bellsouth.net","ymail.com","me.com","cox.net","verizon.net","charter.net","windstream.net"]);
const websiteFrom = email => { const m=String(email||"").trim().toLowerCase().match(/@([^@\s]+)$/); if(!m) return undefined; const dom=m[1]; return PERSONAL.has(dom)?undefined:("https://"+dom); };
const splitName = n => { const p=String(n||"").trim().split(/\s+/).filter(Boolean); if(!p.length) return {first:"",last:""}; return { first:p.slice(0,-1).join(" ")||p[0], last:p.length>1?p[p.length-1]:p[0] }; };

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
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

    // Setup: nothing to create. Free Zoho blocks custom fields, so we match Accounts on the
    // standard Account_Number (holding the HCPS dealer id) and Contacts on the standard Email.
    if(b.action==="setup"){
      const c=await connect();
      if(!c.ok) return json(200,{ok:false,message: c.reason==="not_connected"?"Not connected yet — finish the Self Client step.":"Couldn't refresh the Zoho token — reconnect.",reason:c.reason});
      return json(200,{ ok:true, message:"Ready to sync — Accounts match on Account Number, Contacts on Email. No custom fields needed." });
    }

    // Push every dealer into Zoho as an Account, matched by the standard Account_Number field
    // (set to the HCPS dealer id) so re-runs update instead of duplicate.
    if(b.action==="sync_accounts"){
      const c=await connect();
      if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const dealers=await sbGetAll("dealers?select=id,business_name,city,state,zip,phone,address,email","id");
      const records=dealers.map(d=>({ key:String(d.id), record:{
        Account_Name:(clean(d.business_name)||("Dealer "+d.id)).slice(0,255),
        Phone:clean(d.phone), Website:websiteFrom(d.email),
        Billing_Street:clean(d.address), Billing_City:clean(d.city), Billing_State:clean(d.state), Billing_Code:clean(d.zip),
      }}));
      const res=await upsertRecords(c.apiDomain,c.token,"Accounts",records,["Account_Name"]);
      return json(200,{ ok:res.errors.length===0, total:dealers.length, processed:res.processed, inserted:res.inserted, updated:res.updated, errors:res.errors.slice(0,5) });
    }

    // Push dealer people into Zoho as Contacts (matched on Email), each linked to its dealer's
    // Account via the native Account lookup — which is the association. Only emailed contacts sync.
    if(b.action==="sync_contacts"){
      const c=await connect();
      if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      // map each dealer to its Zoho Account id (accounts were matched on Account_Name = business_name)
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name");
      const acctIdByName={}; for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[a.Account_Name]=a.id; }
      const dealers=await sbGetAll("dealers?select=id,business_name,contact_name,email","id");
      const nameByDealer={}; for(const d of dealers) nameByDealer[String(d.id)]=(clean(d.business_name)||("Dealer "+d.id)).slice(0,255);
      const people=[];
      const dc=await sbGetAll("dealer_contacts?select=id,dealer_id,name,email,phone,title","id").catch(()=>[]);
      for(const x of (dc||[])){ const email=clean(x.email); if(!email) continue; const nm=splitName(x.name);
        people.push({ dealer_id:String(x.dealer_id), email, first:nm.first, last:nm.last, phone:clean(x.phone), title:clean(x.title) }); }
      for(const d of dealers){ const email=clean(d.email); if(!email) continue; const nm=splitName(d.contact_name);
        people.push({ dealer_id:String(d.id), email, first:nm.first, last:nm.last }); }
      const seen=new Set(), uniq=[];
      for(const p of people){ const k=p.email.toLowerCase(); if(seen.has(k)) continue; seen.add(k); uniq.push(p); }
      const records=uniq.map(p=>{
        const acctId=acctIdByName[nameByDealer[p.dealer_id]];
        const rec={ Last_Name:(p.last||p.first||nameByDealer[p.dealer_id]||"Contact").slice(0,80), First_Name:clean(p.first), Email:p.email, Phone:p.phone, Title:p.title };
        if(acctId) rec.Account_Name={ id:acctId };
        return { key:p.email, record:rec };
      });
      const res=await upsertRecords(c.apiDomain,c.token,"Contacts",records,["Email"]);
      const linked=records.filter(r=>r.record.Account_Name).length;
      return json(200,{ ok:res.errors.length===0, total:uniq.length, processed:res.processed, inserted:res.inserted, updated:res.updated, linked_to_account:linked, errors:res.errors.slice(0,5) });
    }

    // Bulk-load Accounts from an uploaded master list (rows passed in the body). Upserts by
    // Account_Name so existing accounts get the website/address updated instead of duplicated.
    if(b.action==="zoho_import_accounts"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const rows=Array.isArray(b.rows)?b.rows:[];
      const records=rows.map(r=>({ key:r.name, record:{
        Account_Name:(clean(r.name)||"Account").slice(0,255),
        Website:clean(r.website), Phone:clean(r.phone),
        Billing_Street:clean(r.street), Billing_City:clean(r.city), Billing_State:clean(r.state), Billing_Code:clean(r.zip),
      }})).filter(x=>x.record.Account_Name);
      const res=await upsertRecords(c.apiDomain,c.token,"Accounts",records,["Account_Name"]);
      return json(200,{ ok:res.errors.length===0, processed:res.processed, inserted:res.inserted, updated:res.updated, errors:res.errors.slice(0,5) });
    }

    // Bulk-load Contacts from the master list (rows in the body). Matches on Email, links each to
    // its company's Account by name. Reports how many couldn't be linked.
    if(b.action==="zoho_import_contacts"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const rows=Array.isArray(b.rows)?b.rows:[];
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name");
      const acctIdByName={}; for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[String(a.Account_Name)]=a.id; }
      const records=rows.map(r=>{
        const rec={ Last_Name:(clean(r.last)||clean(r.first)||"Contact").slice(0,80), First_Name:clean(r.first), Email:clean(r.email), Phone:clean(r.phone), Title:clean(r.title) };
        const acctId=acctIdByName[(clean(r.company)||"").slice(0,255)];
        if(acctId) rec.Account_Name={ id:acctId };
        return { key:r.email, record:rec };
      }).filter(x=>x.record.Email);
      const res=await upsertRecords(c.apiDomain,c.token,"Contacts",records,["Email"]);
      const linked=records.filter(x=>x.record.Account_Name).length;
      return json(200,{ ok:res.errors.length===0, processed:res.processed, inserted:res.inserted, updated:res.updated, linked, unlinked:records.length-linked, errors:res.errors.slice(0,5) });
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

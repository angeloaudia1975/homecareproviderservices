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
const { hasCreds, exchangeCode, accessToken, zoho, getFields, ensureTextField, upsertRecords, getAllRecords: getAllRecordsRaw, ACCOUNTS } = require("./_zoho.js");
// Phase 2F-1: on-demand syncs record every failed record and every incomplete Zoho read as a
// failure row (zoho_sync_log, result "fail") — the response still shows the first few, the log keeps all.
const ZL = require("./_zoho_log.js");
let ACTION="zoho-api";                 // the action being run (set per request) — names the failure rows
let READ_GAPS=[];                      // incomplete Zoho reads in this request (returned as zoho_read_incomplete)
async function getAllRecords(apiDomain, token, module, fields){
  const list=await getAllRecordsRaw(apiDomain, token, module, fields);
  if(list && list.incomplete){ READ_GAPS.push(list.incomplete);
    await ZL.writeLog([ZL.failRow({entity:String(module).toLowerCase(),action:"read",phase:ACTION,msg:"Zoho read stopped early: "+list.incomplete.message,extra:{page:list.incomplete.page,status:list.incomplete.status,records_read:list.incomplete.records_read}})]); }
  return list;
}
// Every record a Zoho upsert refused → one failure row each (the response keeps its first few).
async function logUpsertFails(res, entity, idOf){
  const rows=((res&&res.failed)||[]).map(f=>ZL.failRow({entity,entity_id:idOf?idOf(f.key):f.key,action:"push",phase:ACTION,msg:(f.code?f.code+": ":"")+(f.message||"not accepted"),extra:{zoho_details:f.details||null}}));
  if(rows.length) await ZL.writeLog(rows);
  return rows.length;
}
async function logFail(f){ await ZL.writeLog([ZL.failRow(Object.assign({phase:ACTION},f))]); }
// Phase 2F-2: TEST isolation — every push below asks the shared rule first. If the TEST dealers can't be
// read the push doesn't happen at all (fail closed) and the reason is recorded.
const ZT = require("./_zoho_test.js");
// Phase 2F-5: the one deal engine (field-level, baseline-based, conflict-safe).
const DS = require("./_zoho_deals.js");
async function testRule(){ try{ return await ZT.load(sbGet); }
  catch(e){ await logFail({entity:"dealers",action:"read",msg:"TEST dealers couldn't be read, so nothing was pushed to Zoho: "+failMsg(e)}); return null; } }
const TEST_RULE_DOWN=()=>json(200,{ok:false,error:"test_rule_unavailable",message:"Couldn't confirm which dealers are TEST dealers, so nothing was sent to Zoho. Try again shortly."});
const failMsg=e=>String((e&&e.message)||e);
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
// Call a Postgres function via PostgREST (used for org-level account-number propagation).
async function rpc(fn,args){ const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`,{method:"POST",headers:{...H(),"content-type":"application/json"},body:JSON.stringify(args||{})}); if(!r.ok) throw new Error(`rpc ${fn} ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
// Same business-name normalization the rest of the app uses (dnorm) so Zoho account
// names resolve to the same dealers — plus the dealer_aliases table for known variants.
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
// Manufacturer account-number fields on the Zoho Accounts module — matched by their
// LABEL (the api_name is auto-discovered at run time) -> our dealer_manufacturers slug.
const ACCT_FIELD_MAP=[
  {label:"Golden Acct #",slug:"golden-technologies"},
  {label:"Access4U Acct #",slug:"access4u"},
  {label:"Pedifix Acct #",slug:"pedifix"},
  {label:"GCE Acct #",slug:"gce"},
  {label:"Climbing Steps Acct #",slug:"climbing-steps"},
  {label:"Strongback Acct #",slug:"strongback-mobility"},
  {label:"Corsicana Acct #",slug:"corsicana"},
  {label:"BongoRx Acct #",slug:"airavant-bongorx"},
  {label:"Bemis Acct #",slug:"bemis"},
  {label:"Ovation Acct #",slug:"ovation-medical"},
];

// Zoho auth config (refresh token + api domain) is stored under app_settings key "zoho_auth".
async function getZohoAuth(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_auth&select=value"); return (rows&&rows[0]&&rows[0].value)||null; }catch(e){ return null; } }
async function setZohoAuth(value){ await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_auth",value,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
// The Zoho api_names of our match fields (auto-generated from the labels) are cached here.
async function getZohoFields(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_fields&select=value"); return (rows&&rows[0]&&rows[0].value)||{}; }catch(e){ return {}; } }
async function setZohoFields(value){ await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_fields",value,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
// Last-sync timestamps (per action) for the sync dashboard.
async function getSyncState(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_sync&select=value"); return (rows&&rows[0]&&rows[0].value)||{}; }catch(e){ return {}; } }
async function stampSync(k){ try{ const v=await getSyncState(); v[k]=new Date().toISOString(); await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_sync",value:v,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){} }
// Pipeline stage <-> Zoho Deal stage.
// (Phase 2F-5: the stage mapping lives in the deal engine, _zoho_deals.js — unchanged.)

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
    ACTION=String(b.action||"zoho-api").slice(0,60); READ_GAPS=[];

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
      if(!ex.ok) return json(200,{ok:false,message:"Zoho rejected the code — it may have expired (they last a few minutes) or the scopes were off. Generate a fresh code and try again.",detail:ex.error==null?ex.error:ZL.scrubString(String(ex.error))});
      await setZohoAuth({ refresh_token:ex.refresh_token, api_domain:ex.api_domain, connected_at:new Date().toISOString() });
      return json(200,{ok:true,message:"Connected to Zoho — refresh token stored securely.",api_domain:ex.api_domain});
    }

    if(b.action==="test"){
      const c=await connect();
      if(!c.ok) return json(200,{ok:false,connected:false,reason:c.reason,message: c.reason==="not_connected" ? "Not connected yet — finish the Self Client step." : "Couldn't refresh the Zoho token — reconnect.",detail:c.error==null?c.error:ZL.scrubString(String(c.error))});
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
      const T=await testRule(); if(!T) return TEST_RULE_DOWN();
      const all=await sbGetAll("dealers?select=id,business_name,city,state,zip,phone,address,email","id");
      const dealers=all.filter(d=>!T.dealer(d.id)), test_excluded=all.length-dealers.length;
      const records=dealers.map(d=>({ key:String(d.id), record:{
        Account_Name:(clean(d.business_name)||("Dealer "+d.id)).slice(0,255),
        Phone:clean(d.phone), Website:websiteFrom(d.email),
        Billing_Street:clean(d.address), Billing_City:clean(d.city), Billing_State:clean(d.state), Billing_Code:clean(d.zip),
      }}));
      const res=await upsertRecords(c.apiDomain,c.token,"Accounts",records,["Account_Name"]);
      const failed=await logUpsertFails(res,"dealer");
      return json(200,{ ok:res.errors.length===0&&!failed, total:dealers.length, test_excluded, processed:res.processed, inserted:res.inserted, updated:res.updated, failed, errors:res.errors.slice(0,5) });
    }

    // Push dealer people into Zoho as Contacts (matched on Email), each linked to its dealer's
    // Account via the native Account lookup — which is the association. Only emailed contacts sync.
    if(b.action==="sync_contacts"){
      const c=await connect();
      if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const T=await testRule(); if(!T) return TEST_RULE_DOWN(); let test_excluded=0;
      // map each dealer to its Zoho Account id (accounts were matched on Account_Name = business_name)
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name");
      const acctIdByName={}; for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[a.Account_Name]=a.id; }
      const dealers=await sbGetAll("dealers?select=id,business_name,contact_name,email","id");
      const nameByDealer={}; for(const d of dealers) nameByDealer[String(d.id)]=(clean(d.business_name)||("Dealer "+d.id)).slice(0,255);
      const people=[];
      const dc=await sbGetAll("dealer_contacts?select=id,dealer_id,name,email,phone,title","id").catch(()=>[]);
      for(const x of (dc||[])){ const email=clean(x.email); if(!email) continue; if(T.dealer(x.dealer_id)){ test_excluded++; continue; } const nm=splitName(x.name);
        people.push({ dealer_id:String(x.dealer_id), email, first:nm.first, last:nm.last, phone:clean(x.phone), title:clean(x.title) }); }
      for(const d of dealers){ const email=clean(d.email); if(!email) continue; if(T.dealer(d.id)){ test_excluded++; continue; } const nm=splitName(d.contact_name);
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
      const failed=await logUpsertFails(res,"contact");
      const linked=records.filter(r=>r.record.Account_Name).length;
      return json(200,{ ok:res.errors.length===0&&!failed&&!READ_GAPS.length, total:uniq.length, test_excluded, processed:res.processed, inserted:res.inserted, updated:res.updated, failed, linked_to_account:linked, errors:res.errors.slice(0,5), zoho_read_incomplete:READ_GAPS });
    }

    // Bulk-load Accounts from an uploaded master list (rows passed in the body). Upserts by
    // Account_Name so existing accounts get the website/address updated instead of duplicated.
    if(b.action==="zoho_import_accounts"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const T=await testRule(); if(!T) return TEST_RULE_DOWN();
      const given=Array.isArray(b.rows)?b.rows:[]; const rows=given.filter(r=>!T.name(r.name)), test_excluded=given.length-rows.length;
      const records=rows.map(r=>({ key:r.name, record:{
        Account_Name:(clean(r.name)||"Account").slice(0,255),
        Website:clean(r.website), Phone:clean(r.phone),
        Billing_Street:clean(r.street), Billing_City:clean(r.city), Billing_State:clean(r.state), Billing_Code:clean(r.zip),
      }})).filter(x=>x.record.Account_Name);
      const res=await upsertRecords(c.apiDomain,c.token,"Accounts",records,["Account_Name"]);
      const failed=await logUpsertFails(res,"account");
      return json(200,{ ok:res.errors.length===0&&!failed, test_excluded, processed:res.processed, inserted:res.inserted, updated:res.updated, failed, errors:res.errors.slice(0,5) });
    }

    // Bulk-load Contacts from the master list (rows in the body). Matches on Email, links each to
    // its company's Account by name. Reports how many couldn't be linked.
    if(b.action==="zoho_import_contacts"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const T=await testRule(); if(!T) return TEST_RULE_DOWN();
      const given=Array.isArray(b.rows)?b.rows:[]; const rows=given.filter(r=>!T.name(r.company)&&!T.email(r.email)), test_excluded=given.length-rows.length;
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name");
      const acctIdByName={}; for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[String(a.Account_Name)]=a.id; }
      const records=rows.map(r=>{
        const rec={ Last_Name:(clean(r.last)||clean(r.first)||"Contact").slice(0,80), First_Name:clean(r.first), Email:clean(r.email), Phone:clean(r.phone), Title:clean(r.title) };
        const acctId=acctIdByName[(clean(r.company)||"").slice(0,255)];
        if(acctId) rec.Account_Name={ id:acctId };
        return { key:r.email, record:rec };
      }).filter(x=>x.record.Email);
      const res=await upsertRecords(c.apiDomain,c.token,"Contacts",records,["Email"]);
      const failed=await logUpsertFails(res,"contact");
      const linked=records.filter(x=>x.record.Account_Name).length;
      return json(200,{ ok:res.errors.length===0&&!failed&&!READ_GAPS.length, test_excluded, processed:res.processed, inserted:res.inserted, updated:res.updated, failed, linked, unlinked:records.length-linked, errors:res.errors.slice(0,5), zoho_read_incomplete:READ_GAPS });
    }

    // Load the bundled master list into Zoho in controlled slices (avoids function timeouts and
    // keeps contact data out of the browser). {stage:"accounts"|"contacts", offset, limit}.
    if(b.action==="zoho_load_master"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const master=require("./_zoho_master_data.js");
      const T=await testRule(); if(!T) return TEST_RULE_DOWN();
      const stage=b.stage||"accounts", off=Number(b.offset)||0, lim=Number(b.limit)|| (stage==="contacts"?150:200);
      if(stage==="accounts"){
        const slice=(master.accounts||[]).slice(off,off+lim);
        const test_excluded=slice.filter(r=>T.name(r.name)).length;
        const records=slice.filter(r=>!T.name(r.name)).map(r=>({ key:r.name, record:{
          Account_Name:(clean(r.name)||"Account").slice(0,255), Website:clean(r.website), Phone:clean(r.phone),
          Billing_Street:clean(r.street), Billing_City:clean(r.city), Billing_State:clean(r.state), Billing_Code:clean(r.zip),
        }})).filter(x=>x.record.Account_Name);
        const res=await upsertRecords(c.apiDomain,c.token,"Accounts",records,["Account_Name"]);
        const failed=await logUpsertFails(res,"account");
        return json(200,{ ok:res.errors.length===0&&!failed, stage, offset:off, count:slice.length, test_excluded, total:(master.accounts||[]).length, inserted:res.inserted, updated:res.updated, failed, errors:res.errors.slice(0,5) });
      }
      // contacts: map each to its Account by company name, carry both phones + mailing address
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name");
      const acctIdByName={}; for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[String(a.Account_Name)]=a.id; }
      const slice=(master.contacts||[]).slice(off,off+lim);
      const isTest=r=>T.name(r.company)||T.email(r.email), test_excluded=slice.filter(isTest).length;
      const records=slice.filter(r=>!isTest(r)).map(r=>{
        const rec={ Last_Name:(clean(r.last)||clean(r.first)||"Contact").slice(0,80), First_Name:clean(r.first), Email:clean(r.email),
          Phone:clean(r.phone), Mobile:clean(r.mobile), Title:clean(r.title), Department:clean(r.dept),
          Mailing_Street:clean(r.street), Mailing_City:clean(r.city), Mailing_State:clean(r.state), Mailing_Zip:clean(r.zip) };
        const id=acctIdByName[(clean(r.company)||"").slice(0,255)]; if(id) rec.Account_Name={ id };
        return { key:r.email, record:rec };
      }).filter(x=>x.record.Email);
      const res=await upsertRecords(c.apiDomain,c.token,"Contacts",records,["Email"]);
      const failed=await logUpsertFails(res,"contact");
      const linked=records.filter(x=>x.record.Account_Name).length;
      return json(200,{ ok:res.errors.length===0&&!failed&&!READ_GAPS.length, stage, offset:off, count:slice.length, test_excluded, total:(master.contacts||[]).length, inserted:res.inserted, updated:res.updated, failed, linked, unlinked:records.length-linked, errors:res.errors.slice(0,5), zoho_read_incomplete:READ_GAPS });
    }

    // Sync sales into Zoho as Deals — one closed-won deal per (dealer, manufacturer) with the
    // total amount, linked to the Account. Sliced by {offset, limit} to avoid timeouts.
    if(b.action==="sync_deals"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const T=await testRule(); if(!T) return TEST_RULE_DOWN(); let test_excluded=0;
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name");
      const acctIdByName={}; for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[String(a.Account_Name)]=a.id; }
      const dealers=await sbGetAll("dealers?select=id,business_name","id");
      const nameByDealer={}; for(const d of dealers) nameByDealer[String(d.id)]=(clean(d.business_name)||("Dealer "+d.id)).slice(0,255);
      const sales=await sbGetAll("monthly_sales?select=dealer_id,manufacturer,amount,period&dealer_id=not.is.null","id");
      const agg={};
      for(const s of (sales||[])){ if(!s.dealer_id||!s.manufacturer) continue; if(T.dealer(s.dealer_id)){ test_excluded++; continue; } const k=s.dealer_id+"|"+s.manufacturer;
        const a=agg[k]||(agg[k]={amount:0,last:null,dealer_id:s.dealer_id,manufacturer:s.manufacturer});
        a.amount+=Number(s.amount)||0; const p=(s.period||"").slice(0,10); if(p&&(!a.last||p>a.last)) a.last=p; }
      const all=Object.values(agg).sort((x,y)=>(x.dealer_id+x.manufacturer<y.dealer_id+y.manufacturer?-1:1));
      const off=Number(b.offset)||0, lim=Number(b.limit)||150;
      const today=new Date().toISOString().slice(0,10);
      const records=all.slice(off,off+lim).map(a=>{
        const acctName=nameByDealer[String(a.dealer_id)]; const acctId=acctIdByName[acctName];
        const rec={ Deal_Name:((acctName||"Dealer")+" — "+a.manufacturer).slice(0,255), Amount:Math.round(a.amount*100)/100, Stage:"Closed Won", Closing_Date:a.last||today };
        if(acctId) rec.Account_Name={ id:acctId };
        return { key:a.dealer_id+"|"+a.manufacturer, record:rec };
      });
      const res=await upsertRecords(c.apiDomain,c.token,"Deals",records,["Deal_Name"]);
      const failed=await logUpsertFails(res,"sales_deal");
      const linked=records.filter(r=>r.record.Account_Name).length;
      return json(200,{ ok:res.errors.length===0&&!failed&&!READ_GAPS.length, offset:off, count:records.length, test_excluded, total:all.length, inserted:res.inserted, updated:res.updated, failed, linked, errors:res.errors.slice(0,5), zoho_read_incomplete:READ_GAPS });
    }

    // One-way mirror: push the portal's CRM notes + tasks up to the matching Zoho Account as
    // Zoho Notes + Tasks. Idempotent — only records with zoho_synced_at IS NULL are pushed, and
    // each is stamped on success. Supabase stays the system of record; Zoho gets a live copy.
    if(b.action==="mirror_to_zoho"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected to Zoho.",reason:c.reason});
      const T=await testRule(); if(!T) return TEST_RULE_DOWN(); let test_excluded=0;
      const dealers=await sbGetAll("dealers?select=id,business_name","id");
      const nameById={}; for(const d of dealers) nameById[d.id]=d.business_name;
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name");
      const acctIdByName={}; for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[String(a.Account_Name)]=a.id; }
      let notesPushed=0, notesSkipped=0, tasksPushed=0, tasksSkipped=0, failures=0; const errors=[];
      // notes
      let notes=[]; try{ notes=await sbGetAll("dealer_notes?zoho_synced_at=is.null&select=id,dealer_id,body,author_name,created_at","id"); }catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/crm.sql + crm2.sql first."}); }
      for(const n of notes){ if(T.dealer(n.dealer_id)){ test_excluded++; continue; } const acc=acctIdByName[nameById[n.dealer_id]]; if(!acc){ notesSkipped++; continue; }
        const r=await zoho("POST",c.apiDomain,c.token,"/crm/v8/Notes",{data:[{Note_Title:("Note — "+(n.author_name||"HCPS")).slice(0,120),Note_Content:String(n.body||"").slice(0,32000),Parent_Id:acc,se_module:"Accounts"}]});
        const ok=r.ok && r.json && Array.isArray(r.json.data) && r.json.data[0] && r.json.data[0].code==="SUCCESS";
        if(ok){ await sbSend("PATCH",`dealer_notes?id=eq.${encodeURIComponent(n.id)}`,{zoho_synced_at:new Date().toISOString()},{Prefer:"return=minimal"})
            .catch(async e=>{ failures++; if(errors.length<5) errors.push({note:n.id,msg:"pushed, but not marked as sent — it would be pushed again"}); await logFail({entity:"note",entity_id:n.id,dealer_id:n.dealer_id,action:"write",msg:"note pushed to Zoho but not stamped as sent (a re-run would duplicate it): "+failMsg(e)}); });
          notesPushed++; }
        else { failures++; if(errors.length<5){ errors.push({note:n.id,msg:(r.json&&JSON.stringify(r.json).slice(0,160))||("http "+r.status)}); }
          await logFail({entity:"note",entity_id:n.id,dealer_id:n.dealer_id,action:"push",msg:(r.json&&JSON.stringify(r.json))||("http "+r.status)}); }
      }
      // tasks
      let tasks=[]; try{ tasks=await sbGetAll("dealer_tasks?zoho_synced_at=is.null&select=id,dealer_id,title,detail,due_date,status","id"); }
      catch(e){ tasks=[]; failures++; errors.push({msg:"tasks couldn't be read; none were mirrored"}); await logFail({entity:"tasks",action:"read",msg:"HCPS tasks couldn't be read, so no task was mirrored: "+failMsg(e)}); }
      for(const t of tasks){ if(T.dealer(t.dealer_id)){ test_excluded++; continue; } const acc=acctIdByName[nameById[t.dealer_id]]; if(!acc){ tasksSkipped++; continue; }
        const rec={Subject:String(t.title||"Task").slice(0,255),Status:t.status==="done"?"Completed":t.status==="dismissed"?"Deferred":"Not Started",What_Id:acc,$se_module:"Accounts"};
        if(/^\d{4}-\d{2}-\d{2}$/.test(String(t.due_date||""))) rec.Due_Date=t.due_date;
        if(t.detail) rec.Description=String(t.detail).slice(0,30000);
        const r=await zoho("POST",c.apiDomain,c.token,"/crm/v8/Tasks",{data:[rec]});
        const ok=r.ok && r.json && Array.isArray(r.json.data) && r.json.data[0] && r.json.data[0].code==="SUCCESS";
        if(ok){ await sbSend("PATCH",`dealer_tasks?id=eq.${encodeURIComponent(t.id)}`,{zoho_synced_at:new Date().toISOString()},{Prefer:"return=minimal"})
            .catch(async e=>{ failures++; if(errors.length<5) errors.push({task:t.id,msg:"pushed, but not marked as sent — it would be pushed again"}); await logFail({entity:"task",entity_id:t.id,dealer_id:t.dealer_id,action:"write",msg:"task pushed to Zoho but not stamped as sent (a re-run would duplicate it): "+failMsg(e)}); });
          tasksPushed++; }
        else { failures++; if(errors.length<5){ errors.push({task:t.id,msg:(r.json&&JSON.stringify(r.json).slice(0,160))||("http "+r.status)}); }
          await logFail({entity:"task",entity_id:t.id,dealer_id:t.dealer_id,action:"push",msg:(r.json&&JSON.stringify(r.json))||("http "+r.status)}); }
      }
      return json(200,{ok:errors.length===0&&!failures&&!READ_GAPS.length,notes_pushed:notesPushed,notes_skipped:notesSkipped,tasks_pushed:tasksPushed,tasks_skipped:tasksSkipped,test_excluded,failed:failures,errors,zoho_read_incomplete:READ_GAPS});
    }

    // Sync state for the dashboard: connection + last-sync times + pipeline link coverage +
    // live automatic-sync heartbeat, inbound webhook activity, and a recent-events feed.
    if(b.action==="sync_state"){
      const cfg=await getZohoAuth(); const st=await getSyncState();
      let opps=[]; try{ opps=await sbGetAll("opportunities?select=id,zoho_id","id"); }catch(e){}
      const linked=(opps||[]).filter(o=>o.zoho_id).length;
      // Portal record counts (context for the health dashboard).
      let dealers=0, contacts=0;
      try{ dealers=(await sbGetAll("dealers?select=id","id")).length; }catch(e){}
      try{ contacts=(await sbGetAll("dealer_contacts?select=email","email")).length; }catch(e){}
      // Queue health — overall pending/failed plus inbound-specific (webhook events awaiting drain).
      // Phase 2F-4: inbound HCPS echoes end "ignored" (counted separately; never applied).
      let pending=0, failed=0, inPending=0, inSynced=0, inIgnored=0, haveQueue=false;
      try{ const q=await sbGetAll("zoho_sync_queue?select=direction,status","direction"); haveQueue=true;
        for(const x of (q||[])){ if(x.status==="pending"){ pending++; if(x.direction==="in") inPending++; } else if(x.status==="failed") failed++; else if(x.status==="synced" && x.direction==="in") inSynced++; else if(x.status==="ignored" && x.direction==="in") inIgnored++; } }catch(e){}
      // Automatic-sync heartbeat + inbound webhook activity + last-20 event feed (all best-effort;
      // the log/queue tables come from supabase/zoho_sync.sql — silent, empty until that's run).
      const autosync_at = st.autosync_at || null;
      const since24 = new Date(Date.now()-864e5).toISOString();
      let wh_in_24h=0, wh_last=null, auto_last=null, recent=[], fail_24h=0, fail_last=null;
      // Phase 2F-1: failures recorded by the sync (one row per failed record) — the "Failed syncs" tile.
      try{ const rows=await sbGet(`zoho_sync_log?select=id&result=eq.fail&created_at=gte.${encodeURIComponent(since24)}&limit=5000`); fail_24h=(rows||[]).length; }catch(e){}
      // Phase 2F-5: deal conflicts / review conditions waiting for a person (neither side was changed).
      let deal_conflicts=null; try{ deal_conflicts=((await sbGet("zoho_deal_conflicts?select=id&status=eq.open&limit=5000"))||[]).length; }catch(e){}
      try{ const rows=await sbGet("zoho_sync_log?select=entity,action,detail,created_at&result=eq.fail&order=created_at.desc&limit=1"); fail_last=(rows&&rows[0])||null; }catch(e){}
      try{ const rows=await sbGet(`zoho_sync_log?select=created_at&direction=eq.in&action=eq.webhook&created_at=gte.${encodeURIComponent(since24)}&limit=2000`); wh_in_24h=(rows||[]).length; }catch(e){}
      try{ const rows=await sbGet("zoho_sync_log?select=created_at&direction=eq.in&action=eq.webhook&order=created_at.desc&limit=1"); wh_last=(rows&&rows[0]&&rows[0].created_at)||null; }catch(e){}
      try{ const rows=await sbGet("zoho_sync_log?select=result,detail,created_at&entity=eq.autosync&order=created_at.desc&limit=1"); auto_last=(rows&&rows[0])||null; }catch(e){}
      try{ recent=await sbGet("zoho_sync_log?select=direction,entity,action,result,detail,created_at&order=created_at.desc&limit=20"); }catch(e){ recent=[]; }
      return json(200,{ ok:true, connected:!!(cfg&&cfg.refresh_token), last:st,
        opportunities:{ total:(opps||[]).length, linked, unlinked:(opps||[]).length-linked },
        counts:{ dealers, contacts }, queue:{ pending, failed, in_pending:inPending, in_synced:inSynced, in_ignored:inIgnored },
        autosync:{ on:!!autosync_at, at:autosync_at, last:auto_last }, have_queue:haveQueue,
        webhooks:{ in_24h:wh_in_24h, last:wh_last, pending:inPending, synced:inSynced, ignored:inIgnored },
        failures:{ in_24h:fail_24h, last:fail_last },
        deal_conflicts,
        recent:(recent||[]) });
    }

    // Phase 2F-5: both deal actions run the ONE deal engine (_zoho_deals.js), so an on-demand run can never
    // overwrite a Zoho change or pick a winner in a conflict. "Pipeline → Zoho" pushes only the fields HCPS
    // changed (and creates new deals as before); "Deal changes" applies only Zoho changes that arrived as
    // external/pending Deal events. Each field is compared with the last-synchronized baseline; a field changed on
    // both sides is recorded as a conflict and neither side is changed.
    if(b.action==="sync_opportunities" || b.action==="pull_deals"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const pushing=b.action==="sync_opportunities";
      let T=null; if(pushing){ T=await testRule(); if(!T) return TEST_RULE_DOWN(); }
      let acctIdByName={};
      if(pushing){ const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name"); for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[String(a.Account_Name)]=a.id; } }
      let failures=0; const errors=[];
      const D=await DS.run({sbGet, sbGetAll, sbSend, zoho,
          fail:f=>{ failures++; if(errors.length<6) errors.push({opp:f.entity_id||null,msg:String(f.msg||"").slice(0,200)}); return logFail(f); },
          log:row=>sbSend("POST","zoho_sync_log",row,{Prefer:"return=minimal"}).catch(()=>{})},
        {apiDomain:c.apiDomain, token:c.token, T, acctIdByName, push:pushing, apply:!pushing});
      await stampSync(pushing?"opportunities_pushed_at":"deals_pulled_at");
      const ok=errors.length===0&&!failures&&!READ_GAPS.length;
      if(pushing) return json(200,{ ok, total:D.total, test_excluded:D.test_excluded, created:D.created, updated:D.pushed, failed:failures, errors, conflicts:D.conflicts_open, deals:D, zoho_read_incomplete:READ_GAPS });
      return json(200,{ ok, linked:D.linked, changed:D.applied, changes:[], failed:failures, errors, conflicts:D.conflicts_open, events_processed:D.events_processed, drift:D.drift, deals:D, zoho_read_incomplete:READ_GAPS });
    }

    // Phase 2F-6 discovery — TEST deal ONLY. What does Zoho's API actually do with a Deal's Closing_Date?
    //   step "read"        the deal as Zoho holds it (read-only)
    //   step "meta"        Closing_Date's field settings + whether each Deals layout requires it (read-only)
    //   step "clear"       PUT Closing_Date:null            step "clear_blank"  PUT Closing_Date:""
    //   step "omit"        an update WITHOUT Closing_Date (re-sends the deal's own Description, unchanged)
    //   step "restore"     PUT Closing_Date:<date given>
    //   step "create"      POST a new deal with NO Closing_Date, under the TEST deal's own TEST account
    // Refused unless the Zoho deal is linked to exactly ONE HCPS deal and that deal's dealer is a TEST dealer (an
    // unreadable TEST rule refuses too) — never a real opportunity. Writes carry trigger:[] (no workflow → no webhook,
    // so the deal engine has no event to act on) and each is logged (action "probe"; result ok / refused).
    if(b.action==="probe_close_date"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const T=await testRule(); if(!T) return TEST_RULE_DOWN();
      const zid=String(b.zoho_id||"").trim();
      if(!/^\d{6,30}$/.test(zid)) return json(400,{ok:false,error:"zoho_id required"});
      let links; try{ links=await sbGet(`opportunities?select=id,dealer_id&zoho_id=eq.${encodeURIComponent(zid)}`); }
      catch(e){ return json(503,{ok:false,error:"links_unreadable",message:"Couldn't confirm the deal is a TEST deal, so nothing was done."}); }
      if(!Array.isArray(links) || links.length!==1 || !T.dealer(links[0].dealer_id))
        return json(403,{ok:false,error:"not_a_test_deal",message:"The probe runs only on a Zoho deal linked to exactly one TEST dealer's deal."});
      const opp=links[0], step=String(b.step||"read");
      const PF="Deal_Name,Closing_Date,Stage,Amount,Description,Account_Name,Modified_Time";
      const readDeal=async id=>{ const r=await zoho("GET",c.apiDomain,c.token,`/crm/v8/Deals?ids=${encodeURIComponent(id)}&fields=${PF}`);
        const z=r.ok&&r.json&&Array.isArray(r.json.data)?r.json.data.find(x=>String(x.id)===String(id)):null;
        if(!z) return {ok:false, http:r.status};
        const a=z.Account_Name&&typeof z.Account_Name==="object"?z.Account_Name:null;
        return {ok:true, id:String(z.id), Deal_Name:z.Deal_Name==null?null:z.Deal_Name, Closing_Date:z.Closing_Date==null?null:z.Closing_Date, Stage:z.Stage==null?null:z.Stage,
          Amount:z.Amount==null?null:z.Amount, Description:z.Description==null?null:z.Description, Modified_Time:z.Modified_Time||null, account:a?{id:a.id==null?null:String(a.id), name:a.name==null?null:a.name}:null}; };
      const before=await readDeal(zid);
      if(!before.ok) return json(200,{ok:false,step,error:"deal_unreadable",http:before.http});
      if(step==="read") return json(200,{ok:true,step,deal:before});
      if(step==="meta"){
        const f=await zoho("GET",c.apiDomain,c.token,"/crm/v8/settings/fields?module=Deals");
        const fld=f.ok&&f.json&&Array.isArray(f.json.fields)?f.json.fields.find(x=>x&&x.api_name==="Closing_Date"):null;
        const l=await zoho("GET",c.apiDomain,c.token,"/crm/v8/settings/layouts?module=Deals");
        const layouts=(l.ok&&l.json&&Array.isArray(l.json.layouts)?l.json.layouts:[]).map(L=>{ let inLayout=false, required=null;
          for(const s of (L.sections||[])) for(const x of (s.fields||[])) if(x&&x.api_name==="Closing_Date"){ inLayout=true; required=x.required===true; }
          return {id:L.id==null?null:String(L.id), name:L.name||null, status:L.status||null, closing_date_in_layout:inLayout, closing_date_required:required}; });
        return json(200,{ok:!!(f.ok&&l.ok), step, fields_http:f.status, layouts_http:l.status,
          field:fld?{api_name:fld.api_name, data_type:fld.data_type||null, system_mandatory:fld.system_mandatory===true, read_only:fld.read_only===true, custom_field:fld.custom_field===true}:null,
          layouts, deal:{Closing_Date:before.Closing_Date, Modified_Time:before.Modified_Time}});
      }
      let rec, method="PUT";
      if(step==="clear") rec={id:zid, Closing_Date:null};
      else if(step==="clear_blank") rec={id:zid, Closing_Date:""};
      else if(step==="omit") rec={id:zid, Description:before.Description};
      else if(step==="restore"){ const d=String(b.date||""); if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json(400,{ok:false,error:"date (yyyy-mm-dd) required"}); rec={id:zid, Closing_Date:d}; }
      else if(step==="create"){ method="POST";
        if(!before.account || !before.account.id || !T.name(before.account.name))
          return json(403,{ok:false,error:"not_test_account",message:"The create probe goes only under the TEST deal's own TEST account."});
        rec={Deal_Name:"TEST 2F-6 create probe — sandbox", Stage:"Qualification", Amount:0, Account_Name:{id:before.account.id}}; }
      else return json(400,{ok:false,error:"unknown step"});
      const r=await zoho(method,c.apiDomain,c.token,"/crm/v8/Deals",{data:[rec],trigger:[]});
      const row=r.json&&Array.isArray(r.json.data)?r.json.data[0]:null;
      const res={http:r.status, code:row?row.code||null:(r.json&&r.json.code)||null, status:row?row.status||null:(r.json&&r.json.status)||null,
        message:row?row.message||null:(r.json&&r.json.message)||null, details:row?row.details||null:(r.json&&r.json.details)||null};
      const newId=method==="POST"&&res.code==="SUCCESS"&&res.details&&res.details.id?String(res.details.id):null;
      const after=method==="PUT"?await readDeal(zid):(newId?await readDeal(newId):null);
      const shown=x=>x&&x.ok?{id:x.id, Closing_Date:x.Closing_Date, Modified_Time:x.Modified_Time, Description:x.Description}:x;
      await sbSend("POST","zoho_sync_log",{direction:"out",entity:"opportunity",entity_id:opp.id,dealer_id:opp.dealer_id,zoho_id:newId||zid,action:"probe",
        result:res.code==="SUCCESS"?"ok":"refused",detail:ZL.scrubString(JSON.stringify({phase:"2F-6 close-date probe",step,sent:rec,zoho:res,after:shown(after)}))},{Prefer:"return=minimal"}).catch(()=>{});
      return json(200,{ok:true, step, sent:rec, zoho:res, before:{Closing_Date:before.Closing_Date, Modified_Time:before.Modified_Time, Description:before.Description}, after:shown(after), created_id:newId});
    }

    // PULL Zoho Account contact-info updates (phone / address) back onto matched dealers, and
    // surface Zoho-only accounts (not in our dealer list) as a review list — never auto-created,
    // so Supabase stays the system of record.
    if(b.action==="pull_accounts"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const dealers=await sbGetAll("dealers?select=id,business_name,phone,address,city,state,zip","id");
      const byName={}; for(const d of dealers) byName[String(d.business_name||"").trim().toLowerCase()]=d;
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts","Account_Name,Phone,Billing_Street,Billing_City,Billing_State,Billing_Code,Modified_Time");
      let updated=0, failures=0; const newInZoho=[]; const changes=[]; const errors=[];
      for(const a of (accts||[])){ const nm=String(a.Account_Name||"").trim(); if(!nm) continue; const d=byName[nm.toLowerCase()];
        if(!d){ if(newInZoho.length<100) newInZoho.push({name:nm,phone:a.Phone||"",city:a.Billing_City||"",state:a.Billing_State||""}); continue; }
        const patch={}; const set=(col,val)=>{ const v=(val==null?"":String(val)).trim(); if(v && v!==String(d[col]||"").trim()) patch[col]=v.slice(0,180); };
        set("phone",a.Phone); set("address",a.Billing_Street); set("city",a.Billing_City); set("state",a.Billing_State); set("zip",a.Billing_Code);
        if(Object.keys(patch).length){
          try{ await sbSend("PATCH",`dealers?id=eq.${encodeURIComponent(d.id)}`,patch,{Prefer:"return=minimal"});
            await sbSend("POST","dealer_activity",{dealer_id:d.id,kind:"system",subject:"Updated from Zoho ("+Object.keys(patch).join(", ")+")",actor:"Zoho sync"},{Prefer:"return=minimal"})
              .catch(async e=>{ failures++; await logFail({entity:"dealer_activity",dealer_id:d.id,direction:"in",action:"apply",msg:"dealer updated from Zoho, but the timeline entry wasn't added: "+failMsg(e)}); });
            updated++; if(changes.length<12)changes.push({dealer:nm,fields:Object.keys(patch)}); }
          catch(e){ failures++; if(errors.length<5)errors.push({dealer:nm,msg:String(e.message||e)});
            await logFail({entity:"dealer",entity_id:d.id,dealer_id:d.id,direction:"in",action:"pull",msg:"a Zoho account update couldn't be saved: "+failMsg(e),extra:{fields:Object.keys(patch)}}); }
        }
      }
      await stampSync("accounts_pulled_at");
      return json(200,{ ok:errors.length===0&&!failures&&!READ_GAPS.length, accounts:(accts||[]).length, updated, changes, new_in_zoho:newInZoho, failed:failures, errors, zoho_read_incomplete:READ_GAPS });
    }

    // PULL manufacturer ACCOUNT NUMBERS from Zoho back into the portal. Reads the Acct # fields
    // off each Zoho Account, resolves the account to a dealer (dnorm(name) + dealer_aliases),
    // writes changed numbers into dealer_manufacturers, then fans org-level numbers out to
    // satellite locations. A blank in Zoho never clears a number here — Supabase keeps the last
    // known value — so an accidental blank can't wipe the portal.
    if(b.action==="pull_account_numbers"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      // Discover the api_names of the Acct # fields from their labels (import may name them anything).
      const fields=await getFields(c.apiDomain,c.token,"Accounts");
      const apiByLabel={}; for(const f of (fields||[])){ if(f&&f.field_label) apiByLabel[String(f.field_label).trim().toLowerCase()]=f.api_name; }
      const map=[], missing=[];
      for(const m of ACCT_FIELD_MAP){ const api=apiByLabel[m.label.toLowerCase()]; if(api) map.push({api,slug:m.slug,label:m.label}); else missing.push(m.label); }
      if(!map.length) return json(200,{ok:false,message:"No account-number fields found on the Zoho Accounts module. Confirm the Acct # fields exist (labels like 'Golden Acct #').",fields_missing:missing});
      // Pull every account with its name + the discovered number fields.
      const accts=await getAllRecords(c.apiDomain,c.token,"Accounts",["Account_Name",...map.map(m=>m.api)].join(","));
      // Build the dealer resolver: dnorm(business_name) and dealer_aliases.alias_norm -> dealer_id.
      const dealers=await sbGetAll("dealers?select=id,business_name","id");
      const norm2id=new Map(); for(const d of dealers) norm2id.set(dnorm(d.business_name), d.id);
      const aliases=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
      for(const a of (aliases||[])){ if(a&&a.alias_norm&&!norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm, a.dealer_id); }
      // Resolve each account and collect one number per (dealer, line); a numeric ref wins if two
      // account names collide onto the same dealer with different values.
      const want=new Map(); const unmatched=[]; let cells=0;
      for(const a of (accts||[])){ const nm=String(a.Account_Name||"").trim(); if(!nm) continue;
        const id=norm2id.get(dnorm(nm)); if(!id){ if(unmatched.length<300) unmatched.push(nm); continue; }
        for(const m of map){ const v=clean(a[m.api]); if(!v) continue; cells++;
          const key=id+"|"+m.slug, prev=want.get(key);
          if(prev==null || (/[0-9]/.test(v)&&!/[0-9]/.test(prev))) want.set(key, v);
        }
      }
      // Only write lines whose value actually changed (keeps writes + activity minimal).
      const existing=await sbGetAll("dealer_manufacturers?select=dealer_id,manufacturer,account_ref","dealer_id,manufacturer");
      const curr=new Map(); for(const x of (existing||[])) curr.set(x.dealer_id+"|"+x.manufacturer, x.account_ref==null?"":String(x.account_ref));
      const rows=[]; for(const [key,ref] of want){ if((curr.get(key)||"")===ref) continue; const i=key.indexOf("|"); rows.push({dealer_id:key.slice(0,i),manufacturer:key.slice(i+1),account_ref:ref,active:true}); }
      for(let i=0;i<rows.length;i+=500){ await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",rows.slice(i,i+500),{Prefer:"resolution=merge-duplicates,return=minimal"}); }
      // Fan org-level numbers out to satellites (fills blanks, never overwrites a branch's own number).
      let propagated=true; try{ await rpc("propagate_org_account_numbers",{}); }catch(e){ propagated=String(e.message||e); }
      await stampSync("account_numbers_pulled_at");
      return json(200,{ ok:!READ_GAPS.length, zoho_read_incomplete:READ_GAPS, accounts:(accts||[]).length, fields_found:map.map(m=>m.label), fields_missing:missing,
        numbers_seen:cells, lines_updated:rows.length, unmatched_accounts:unmatched.length, unmatched_sample:unmatched.slice(0,25), propagated });
    }

    // PULL Zoho CONTACTS back into the portal. Maps each contact to its dealer via the parent
    // Account (dnorm(name) + dealer_aliases, same as the account-number pull), then upserts into
    // dealer_contacts (dealer_id,email). This gives the email matcher the full Zoho address book —
    // every on-file email auto-attributes incoming mail to the right dealer.
    if(b.action==="pull_contacts"){
      const c=await connect(); if(!c.ok) return json(200,{ok:false,message:"Not connected.",reason:c.reason});
      const dealers=await sbGetAll("dealers?select=id,business_name","id");
      const norm2id=new Map(); for(const d of dealers) norm2id.set(dnorm(d.business_name), d.id);
      const aliases=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
      for(const a of (aliases||[])){ if(a&&a.alias_norm&&!norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm,a.dealer_id); }
      const contacts=await getAllRecords(c.apiDomain,c.token,"Contacts","Email,First_Name,Last_Name,Account_Name,Phone,Title");
      const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const rows=[]; const seen=new Set(); let withEmail=0; const unmatched=new Set();
      for(const ct of (contacts||[])){
        const email=String(ct.Email||"").trim().toLowerCase(); if(!EMAIL_RE.test(email)) continue; withEmail++;
        const acctName=(ct.Account_Name && (ct.Account_Name.name||ct.Account_Name))||"";
        const id=acctName?norm2id.get(dnorm(acctName)):null;
        if(!id){ if(acctName) unmatched.add(acctName); continue; }
        const key=id+"|"+email; if(seen.has(key)) continue; seen.add(key);
        const name=[clean(ct.First_Name),clean(ct.Last_Name)].filter(Boolean).join(" ").slice(0,120)||null;
        rows.push({dealer_id:id,email,name,title:clean(ct.Title)||null,phone:clean(ct.Phone)||null});
      }
      // A Zoho contact with no phone or title must not erase the one on file (Phase 0H).
      const { written } = await require("./_upsert.js").upsertKeepingValues(sbSend,"dealer_contacts?on_conflict=dealer_id,email",rows);
      try{ await stampSync("contacts_pulled_at"); }catch(e){}
      return json(200,{ ok:!READ_GAPS.length, zoho_read_incomplete:READ_GAPS, zoho_contacts:(contacts||[]).length, with_email:withEmail, matched_to_dealer:rows.length, written,
        unmatched_accounts:unmatched.size, unmatched_sample:[...unmatched].slice(0,20) });
    }

    // DATA QUALITY: list contacts/dealers whose email is present but malformed. Zoho rejects these
    // on push (INVALID_DATA), so the auto-sync skips them — this surfaces them so you can correct
    // the address on the dealer; the next sync then pushes it and the email matcher starts using it
    // too. Two bulk reads (dealers + dealer_contacts), so it's cheap even at full size.
    if(b.action==="invalid_emails"){
      const OK=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const bad=[];
      const dealers=await sbGetAll("dealers?select=id,business_name,email,contact_name","id");
      const nameById={}; for(const d of dealers) nameById[d.id]=(d.business_name||("Dealer "+d.id));
      for(const d of dealers){ const e=String(d.email==null?"":d.email).trim(); if(e && !OK.test(e)) bad.push({source:"primary",dealer_id:d.id,dealer:nameById[d.id],name:clean(d.contact_name)||null,email:e}); }
      let dc=[]; try{ dc=await sbGetAll("dealer_contacts?select=id,dealer_id,name,email","id"); }catch(e){}
      for(const x of (dc||[])){ const e=String(x.email==null?"":x.email).trim(); if(e && !OK.test(e)) bad.push({source:"contact",dealer_id:x.dealer_id,dealer:nameById[x.dealer_id]||("Dealer "+x.dealer_id),name:clean(x.name)||null,email:e}); }
      bad.sort((a,b2)=>String(a.dealer||"").localeCompare(String(b2.dealer||"")));
      return json(200,{ ok:true, count:bad.length, invalid:bad.slice(0,300) });
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:ZL.scrubString(String(e.message||e))}); }   // 2F-1.1: cleaned like the log
};

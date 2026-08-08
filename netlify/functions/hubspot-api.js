// HCPS ↔ HubSpot integration API. President-only. Server-side (Supabase service-role for reads,
// HUBSPOT_ACCESS_TOKEN for HubSpot). This first cut ships the connection test so we can confirm
// the Service Key works and is scoped correctly; the dealer / contact / deal sync builds on it.
//
//   POST {action:"test"}   -> verify the token reaches HubSpot + which CRM objects are readable
//   (sync actions to follow)
//   All require a President Bearer token (staff email/password JWT).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const { hs, hasToken, ensureUniqueProp, batchUpsert, companyIdByDealer, batchAssociateDefault } = require("./_hubspot.js");

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
const clean=v=>{ const s=(v==null?"":String(v)).trim(); return s||undefined; };
const domainFrom=email=>{ const m=String(email||"").trim().match(/@([^@\s]+)$/); return m?m[1].toLowerCase():undefined; };

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

    // One-time (idempotent) setup: create the unique keys our syncs match on.
    if(b.action==="setup"){
      if(!hasToken()) return json(200,{ok:false,configured:false,message:"HUBSPOT_ACCESS_TOKEN is not set yet."});
      const comp=await ensureUniqueProp("companies","hcps_dealer_id","HCPS Dealer ID","companyinformation");
      const cont=await ensureUniqueProp("contacts","hcps_contact_id","HCPS Contact ID","contactinformation");
      return json(200,{ok:(comp.ok&&cont.ok), properties:{ company_key:comp, contact_key:cont },
        message:(comp.ok&&cont.ok)?"HubSpot is set up for syncing.":"Couldn't create one or more sync keys — check scopes (crm.schemas.companies.write / crm.schemas.contacts.write may be required)."});
    }

    // Push every dealer into HubSpot as a Company, matched by hcps_dealer_id (so re-runs update,
    // never duplicate). Maps the core fields; the CRM sync foundation for contacts/deals follows.
    if(b.action==="sync_companies"){
      if(!hasToken()) return json(200,{ok:false,configured:false,message:"HUBSPOT_ACCESS_TOKEN is not set yet."});
      // make sure the unique key exists first (safe if it already does)
      await ensureUniqueProp("companies","hcps_dealer_id","HCPS Dealer ID","companyinformation");
      const dealers=await sbGetAll("dealers?select=id,business_name,city,state,zip,phone,address,email,parent_id,golden_status","id");
      const byId={}; for(const d of dealers) byId[d.id]=d;
      const records=dealers.map(d=>({
        id:d.id,
        properties:{
          hcps_dealer_id:String(d.id),
          name:clean(d.business_name),
          city:clean(d.city), state:clean(d.state), zip:clean(d.zip),
          phone:clean(d.phone), address:clean(d.address),
          domain:domainFrom(d.email),
        },
      }));
      const res=await batchUpsert("companies","hcps_dealer_id",records);
      return json(200,{ok:res.errors.length===0, total:dealers.length, processed:res.processed, errors:res.errors.slice(0,5)});
    }

    // Push dealer people into HubSpot as Contacts (email is the identity), then associate each
    // to its dealer Company. These are what email automation runs on. Only contacts WITH an
    // email are synced — a contact with no email can't be marketed to.
    if(b.action==="sync_contacts"){
      if(!hasToken()) return json(200,{ok:false,configured:false,message:"HUBSPOT_ACCESS_TOKEN is not set yet."});
      await ensureUniqueProp("contacts","hcps_contact_id","HCPS Contact ID","contactinformation");
      const splitName=n=>{ const p=String(n||"").trim().split(/\s+/).filter(Boolean); if(!p.length) return {first:"",last:""}; return { first:p.slice(0,-1).join(" ")||p[0], last:p.length>1?p[p.length-1]:"" }; };
      const people=[];
      // dedicated contacts on file
      const dc=await sbGetAll("dealer_contacts?select=id,dealer_id,name,email,phone,title","id").catch(()=>[]);
      for(const c of (dc||[])){ const email=clean(c.email); if(!email) continue; const nm=splitName(c.name);
        people.push({ cid:"c"+c.id, dealer_id:c.dealer_id, email, first:nm.first, last:nm.last, phone:clean(c.phone), title:clean(c.title) }); }
      // each dealer's own primary contact/email
      const dealers=await sbGetAll("dealers?select=id,contact_name,email","id");
      for(const d of (dealers||[])){ const email=clean(d.email); if(!email) continue; const nm=splitName(d.contact_name);
        people.push({ cid:"d"+d.id, dealer_id:d.id, email, first:nm.first, last:nm.last }); }
      // one record per email (first wins)
      const seen=new Set(), uniq=[];
      for(const p of people){ const k=p.email.toLowerCase(); if(seen.has(k)) continue; seen.add(k); uniq.push(p); }
      const records=uniq.map(p=>({ id:p.email, properties:{
        hcps_contact_id:p.cid, email:p.email,
        firstname:clean(p.first), lastname:clean(p.last), phone:p.phone, jobtitle:p.title,
      }}));
      const up=await batchUpsert("contacts","email",records);
      // map email -> contact internal id, then associate to the dealer's company
      const idByEmail={}; for(const r of up.results){ if(r.idValue) idByEmail[String(r.idValue).toLowerCase()]=r.id; }
      const compMap=await companyIdByDealer();
      const pairs=[]; for(const p of uniq){ const cId=idByEmail[p.email.toLowerCase()], coId=compMap[String(p.dealer_id)]; if(cId&&coId) pairs.push({ fromId:cId, toId:coId }); }
      const assoc=await batchAssociateDefault("contacts","companies",pairs);
      return json(200,{
        ok: up.errors.length===0 && assoc.errors.length===0,
        contacts_total: uniq.length, contacts_processed: up.processed,
        associated_to_company: assoc.done,
        upsert_errors: up.errors.slice(0,3), assoc_errors: assoc.errors.slice(0,3),
      });
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

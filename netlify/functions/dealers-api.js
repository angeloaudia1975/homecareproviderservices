// HCPS admin — Dealer master API (read + merge/manage). Service-role, server-side.
// Powers the Merge/Manage Dealers page. No npm deps.
//
//   GET  /.netlify/functions/dealers-api            -> dealer master + stats + aliases
//   POST /.netlify/functions/dealers-api  {action}  -> merge | edit | access | confirm | rep | split
//   header x-analytics-token: <passcode>  (if ANALYTICS_TOKEN is set)
//
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BUILD = "dealers-api direct-write v2 (2026-08-02)";   // shown by the "Check setup" diagnostic
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});

async function sbGet(path){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()});
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
// Paginate. orderCol MUST be a real column on the table — several tables (dealer_contacts,
// dealer_addresses, dealer_aliases, dealer_manufacturers) have a composite PK and NO "id"
// column, so ordering by "id" 400s and silently returns nothing. Always pass the right key.
async function sbGetAll(base, orderCol="id"){
  const PAGE=1000; let from=0,out=[];
  for(;;){const sep=base.includes("?")?"&":"?";
    const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`);
    out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE;}
  return out;
}
async function sbSend(method,path,body,extraHeaders){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,
    headers:{...H(),"content-type":"application/json",...(extraHeaders||{})},
    body:body!=null?JSON.stringify(body):undefined});
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t=await r.text(); return t?JSON.parse(t):null;
}
const rpc=(fn,args)=>sbSend("POST",`rpc/${fn}`,args,{Prefer:"return=minimal"});

const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Supabase Auth admin API (create/update/delete auth users). Service-role only.
async function authAdmin(method,pathAfter,body){
  const r=await fetch(`${SUPABASE_URL}/auth/v1/admin/${pathAfter}`,{method,
    headers:{...H(),"content-type":"application/json"},
    body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text();
  if(!r.ok) throw new Error(`Auth ${r.status}: ${t}`);
  return t?JSON.parse(t):null;
}

const MONTH=["January","February","March","April","May","June","July","August","September","October","November","December"];
const plabel=p=>{const[y,m]=p.split("-");return `${MONTH[+m-1]} ${y}`;};
const pm=p=>{const[y,m]=p.split("-").map(Number);return y*12+(m-1);};

async function buildState(){
  const [dealers,aliases,dm,mfrs,dir,reps,nomerge,logins] = await Promise.all([
    sbGetAll("dealers?select=id,business_name,hcps_account,contact_name,email,phone,address,city,state,zip,status,notes,active"),
    sbGetAll("dealer_aliases?select=alias_norm,raw_name,dealer_id","alias_norm"),
    sbGetAll("dealer_manufacturers?select=dealer_id,manufacturer,active","dealer_id,manufacturer"),
    sbGet("manufacturers?select=slug,name,active"),
    sbGet("dealer_directory?select=dealer_name,rep_name,hcps_account").catch(()=>[]),
    sbGet("reps?select=name").catch(()=>[]),
    sbGet("dealer_nomerge?select=a,b").catch(()=>[]),
    sbGet("dealer_users?select=uid,email,dealer_id,status,created_at,req_company,req_contact,req_phone,req_address,req_city,req_state,req_zip&order=created_at.desc").catch(()=>[]),
  ]);
  const dcontacts = await sbGetAll("dealer_contacts?select=dealer_id,email,name,title,role,phone","dealer_id,email").catch(()=>[]);
  const contactsByDealer=new Map(); for(const x of dcontacts){(contactsByDealer.get(x.dealer_id)||contactsByDealer.set(x.dealer_id,[]).get(x.dealer_id)).push(x);}
  const daddrs = await sbGetAll("dealer_addresses?select=dealer_id,address,city,state,zip,label,pri","dealer_id,addr_key").catch(()=>[]);
  const addrByDealer=new Map(); for(const x of daddrs){(addrByDealer.get(x.dealer_id)||addrByDealer.set(x.dealer_id,[]).get(x.dealer_id)).push(x);}
  const rows = await sbGetAll("monthly_sales?select=dealer_id,manufacturer,period,amount,commission,customer_name,customer_ref");
  const mfrName=Object.fromEntries(mfrs.map(m=>[m.slug,m.name]));
  const repByName=Object.fromEntries(dir.map(d=>[d.dealer_name,d.rep_name]));
  const aliByDealer=new Map(); for(const a of aliases){(aliByDealer.get(a.dealer_id)||aliByDealer.set(a.dealer_id,[]).get(a.dealer_id)).push(a.raw_name);}
  const accByDealer=new Map(); for(const x of dm){if(x.active!==false)(accByDealer.get(x.dealer_id)||accByDealer.set(x.dealer_id,[]).get(x.dealer_id)).push(x.manufacturer);}
  // aggregate sales per dealer_id
  const agg=new Map();
  let unlinked=0;
  for(const r of rows){
    if(!r.dealer_id){unlinked++; continue;}
    const a=agg.get(r.dealer_id)||{sales:0,comm:0,recs:0,lines:new Set(),periods:new Set(),accts:new Set()};
    a.sales+=Number(r.amount)||0; a.comm+=Number(r.commission)||0; a.recs+=1;
    if(r.manufacturer)a.lines.add(r.manufacturer); if(r.period)a.periods.add(r.period.slice(0,10));
    if(r.customer_ref&&String(r.customer_ref).trim())a.accts.add(`${r.manufacturer}:${String(r.customer_ref).trim()}`);
    agg.set(r.dealer_id,a);
  }
  const periodsAll=[...new Set(rows.map(r=>(r.period||"").slice(0,10)).filter(Boolean))].sort();
  const latest=periodsAll[periodsAll.length-1];
  const out=dealers.map(d=>{
    const a=agg.get(d.id)||{sales:0,comm:0,recs:0,lines:new Set(),periods:new Set(),accts:new Set()};
    const per=[...a.periods].sort();
    const since = (latest&&per.length)? pm(latest)-pm(per[per.length-1]) : null;
    return {
      id:d.id, name:d.business_name, hcps_account:d.hcps_account||"", status:d.status||"",
      contact_name:d.contact_name||"", email:d.email||"", phone:d.phone||"",
      address:d.address||"", city:d.city||"", state:d.state||"", zip:d.zip||"", notes:d.notes||"",
      rep: repByName[d.business_name]||"",
      aliases:(aliByDealer.get(d.id)||[]).filter((v,i,s)=>s.indexOf(v)===i).sort(),
      access:(accByDealer.get(d.id)||[]).slice().sort(),
      buysLines:[...a.lines].sort(),
      accounts:[...a.accts].sort(),
      contacts:(contactsByDealer.get(d.id)||[]).map(c=>({email:c.email||"",name:c.name||"",title:c.title||"",role:c.role||"",phone:c.phone||""})),
      addresses:(addrByDealer.get(d.id)||[]).map(x=>({address:x.address||"",city:x.city||"",state:x.state||"",zip:x.zip||"",label:x.label||"",pri:x.pri||1}))
        .sort((p,q)=>(q.pri||1)-(p.pri||1)),
      sales:Math.round(a.sales*100)/100, comm:Math.round(a.comm*100)/100, recs:a.recs,
      periods:per, monthsSince:since, lastPeriod:per[per.length-1]||null,
    };
  }).sort((x,y)=>y.sales-x.sales);
  return {
    generatedAt:new Date().toISOString(),
    latestPeriod:latest||null,
    manufacturers:mfrs.map(m=>({slug:m.slug,name:m.name})).sort((a,b)=>a.name.localeCompare(b.name)),
    repOptions:[...new Set(reps.map(r=>r.name).filter(Boolean))].sort(),
    mfrName, unlinked, dealers:out,
    nomerge:(nomerge||[]).map(x=>[x.a,x.b].sort().join("|")),
    logins:(logins||[]).map(u=>{const d=dealers.find(x=>x.id===u.dealer_id);
      return {uid:u.uid,email:u.email,status:u.status,created_at:u.created_at,
        dealer_id:u.dealer_id||"",dealer_name:d?d.business_name:"",
        req:{company:u.req_company||"",contact:u.req_contact||"",phone:u.req_phone||"",
             address:u.req_address||"",city:u.req_city||"",state:u.req_state||"",zip:u.req_zip||""}};}),
  };
}

exports.handler = async (event)=>{
  try{
    const need=process.env.ANALYTICS_TOKEN;
    if(need){const got=event.headers["x-analytics-token"]||(event.queryStringParameters||{}).token||""; if(got!==need) return json(401,{error:"unauthorized"});}
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});

    if(event.httpMethod==="GET") return json(200, await buildState());

    if(event.httpMethod==="POST"){
      let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
      const act=b.action;
      if(act==="diag"){
        // Self-check: which code is live, do the tables exist, and how many rows are stored.
        const probe=async(t)=>{ try{
            const r=await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=dealer_id`,{headers:{...H(),Prefer:"count=exact",Range:"0-0"}});
            if(r.status===404||r.status===400) return {exists:false,count:0};
            const cr=r.headers.get("content-range")||""; const cnt=cr.includes("/")?parseInt(cr.split("/")[1],10):null;
            return {exists:(r.ok||r.status===206),count:Number.isFinite(cnt)?cnt:null};
          }catch(e){ return {exists:false,count:0,error:String(e.message||e)}; } };
        return json(200,{ok:true,build:BUILD,dealer_contacts:await probe("dealer_contacts"),dealer_addresses:await probe("dealer_addresses")});
      }
      if(act==="merge"){
        if(!b.survivor_id||!Array.isArray(b.loser_ids)||!b.loser_ids.length) return json(400,{error:"survivor_id + loser_ids required"});
        await rpc("merge_dealers",{p_survivor:b.survivor_id,p_losers:b.loser_ids});
        return json(200,{ok:true});
      }
      if(act==="edit"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        const f={}; for(const k of ["contact_name","email","phone","address","city","state","zip","hcps_account","notes","business_name"]) if(k in b) f[k]=(b[k]===""?null:b[k]);
        f.updated_at=new Date().toISOString();
        await sbSend("PATCH",`dealers?id=eq.${b.dealer_id}`,f,{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="confirm"){
        if(!b.dealer_id) return json(400,{error:"dealer_id required"});
        await sbSend("PATCH",`dealers?id=eq.${b.dealer_id}`,{status:null,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="access"){
        if(!b.dealer_id||!Array.isArray(b.manufacturers)) return json(400,{error:"dealer_id + manufacturers[] required"});
        await sbSend("DELETE",`dealer_manufacturers?dealer_id=eq.${b.dealer_id}`,null,{Prefer:"return=minimal"});
        if(b.manufacturers.length) await sbSend("POST","dealer_manufacturers",b.manufacturers.map(m=>({dealer_id:b.dealer_id,manufacturer:m,active:true})),{Prefer:"return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="rep"){
        if(!b.dealer_name) return json(400,{error:"dealer_name required"});
        await sbSend("POST","dealer_directory",{dealer_name:b.dealer_name,rep_name:(b.rep_name||"").trim()||null,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="nomerge"){
        if(!b.id_a||!b.id_b) return json(400,{error:"id_a + id_b required"});
        const [a,c]=[b.id_a,b.id_b].sort();
        await sbSend("POST","dealer_nomerge",{a,b:c},{Prefer:"resolution=merge-duplicates,return=minimal"});
        return json(200,{ok:true});
      }
      if(act==="split"){
        if(!b.alias_norm||!b.new_name) return json(400,{error:"alias_norm + new_name required"});
        await rpc("split_alias",{p_alias:b.alias_norm,p_new_name:b.new_name});
        return json(200,{ok:true});
      }
      if(act==="import_contacts"){
        const rows=Array.isArray(b.rows)?b.rows:[];
        if(!rows.length) return json(400,{error:"rows[] required"});
        const create=b.create!==false;
        // Store everything directly here (service role) instead of via a Postgres function,
        // so nothing can be silently blocked by a function that failed to install. The ONLY
        // requirement is that the two tables exist — probe them and say so plainly if not.
        try{ await sbGet("dealer_contacts?select=dealer_id&limit=1"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",result:{contacts:0,addresses:0,message:"The dealer_contacts table doesn't exist yet. Run create_tables.sql in Supabase, then re-import."}}); }
        try{ await sbGet("dealer_addresses?select=dealer_id&limit=1"); }
        catch(e){ return json(200,{ok:false,error:"tables_missing",result:{contacts:0,addresses:0,message:"The dealer_addresses table doesn't exist yet. Run create_tables.sql in Supabase, then re-import."}}); }

        const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
        const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
        const chunk=(arr,n)=>{const o=[];for(let i=0;i<arr.length;i+=n)o.push(arr.slice(i,i+n));return o;};
        const errors=[];

        // Optional clean slate: wipe existing contacts/addresses so a re-import lands only
        // on the correct (canonical) dealers — undoes any earlier mis-attached rows.
        if(b.replace){
          try{ await sbSend("DELETE","dealer_contacts?dealer_id=not.is.null",null,{Prefer:"return=minimal"}); }catch(e){ errors.push("wipe contacts: "+e.message); }
          try{ await sbSend("DELETE","dealer_addresses?dealer_id=not.is.null",null,{Prefer:"return=minimal"}); }catch(e){ errors.push("wipe addresses: "+e.message); }
        }

        // resolution map: normalized name/alias -> dealer_id
        const dealersAll=await sbGetAll("dealers?select=id,business_name");
        const aliasesAll=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
        const norm2id=new Map();
        for(const d of dealersAll) norm2id.set(dnorm(d.business_name), d.id);
        for(const a of aliasesAll) norm2id.set(a.alias_norm, a.dealer_id);

        // create unmatched companies (if allowed)
        let matched=0, created=0; const unmatched=[]; const createSet=new Map();
        for(const r of rows){ const nm=(r.company||"").trim(); if(!nm)continue; const k=dnorm(nm);
          if(norm2id.has(k)) matched++;
          else if(create){ if(!createSet.has(k)) createSet.set(k,nm); }
          else unmatched.push(nm); }
        if(createSet.size){
          const batch=[...createSet.values()].map(nm=>({business_name:nm,active:true,status:"prospect"}));
          try{
            const ins=await sbSend("POST","dealers?on_conflict=business_name",batch,{Prefer:"resolution=merge-duplicates,return=representation"});
            const aliasRows=[];
            for(const row of (ins||[])){ const k=dnorm(row.business_name); norm2id.set(k,row.id); aliasRows.push({alias_norm:k,raw_name:row.business_name,dealer_id:row.id}); }
            created=batch.length;
            if(aliasRows.length) await sbSend("POST","dealer_aliases?on_conflict=alias_norm",aliasRows,{Prefer:"resolution=merge-duplicates,return=minimal"}).catch(()=>{});
          }catch(e){ errors.push("create dealers: "+e.message); }
        }

        // build de-duplicated bulk sets keyed by dealer
        const contactMap=new Map(), addrMap=new Map(), lineMap=new Map(), dealerUpd=new Map();
        for(const r of rows){ const nm=(r.company||"").trim(); if(!nm)continue; const id=norm2id.get(dnorm(nm)); if(!id)continue;
          if(!dealerUpd.has(id)) dealerUpd.set(id,{});
          const du=dealerUpd.get(id);
          if(!du.contact_name && r.contact) du.contact_name=r.contact;
          if(!du.email && r.email) du.email=String(r.email).trim();
          if(!du.phone && r.phone) du.phone=r.phone;
          for(const c of (r.contacts||[])){ const em=String(c.email||"").trim().toLowerCase(); if(!em)continue; const key=id+"|"+em;
            if(!contactMap.has(key)) contactMap.set(key,{dealer_id:id,email:em,name:c.name||null,title:c.title||null,role:c.role||null,phone:c.phone||null}); }
          for(const a of (r.addresses||[])){ const ad=String(a.address||"").trim(); if(!ad)continue;
            const ak=dnorm([ad,a.city,a.state].filter(Boolean).join(" ")); const key=id+"|"+ak;
            const lbl=String(a.label||""); const pri=/HQ/i.test(lbl)?3:(/\b(CORP|CORPORATE|HEADQUARTERS|MAIN|FLAGSHIP)\b/i.test(lbl)?2:1);
            const prev=addrMap.get(key); if(!prev||pri>prev.pri) addrMap.set(key,{dealer_id:id,addr_key:ak,address:ad,city:a.city||null,state:a.state||null,zip:a.zip||null,label:lbl||null,pri}); }
          for(const l of (r.lines||[])){ if(!l||!l.slug)continue; const key=id+"|"+l.slug;
            if(!lineMap.has(key)) lineMap.set(key,{dealer_id:id,manufacturer:l.slug,active:true,account_ref:(l.account||null)}); }
        }

        const contactsArr=[...contactMap.values()], addrArr=[...addrMap.values()], lineArr=[...lineMap.values()];
        let contactsStored=0, addressesStored=0, ents=0;
        for(const part of chunk(contactsArr,500)){ try{ await sbSend("POST","dealer_contacts?on_conflict=dealer_id,email",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); contactsStored+=part.length; }catch(e){ errors.push("contacts: "+e.message); } }
        for(const part of chunk(addrArr,500)){ try{ await sbSend("POST","dealer_addresses?on_conflict=dealer_id,addr_key",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); addressesStored+=part.length; }catch(e){ errors.push("addresses: "+e.message); } }
        for(const part of chunk(lineArr,500)){ try{ await sbSend("POST","dealer_manufacturers?on_conflict=dealer_id,manufacturer",part,{Prefer:"resolution=merge-duplicates,return=minimal"}); ents+=part.length; }catch(e){ errors.push("lines: "+e.message); } }

        // per-dealer: set contact/email/phone + promote the top-ranked (HQ) address
        const primaryByDealer=new Map();
        for(const a of addrArr){ const p=primaryByDealer.get(a.dealer_id); if(!p||a.pri>p.pri) primaryByDealer.set(a.dealer_id,a); }
        const updates=[];
        for(const [id,du] of dealerUpd){ const pa=primaryByDealer.get(id); const patch={updated_at:new Date().toISOString()};
          if(du.contact_name)patch.contact_name=du.contact_name; if(du.email)patch.email=du.email; if(du.phone)patch.phone=du.phone;
          if(pa){ patch.address=pa.address; if(pa.city)patch.city=pa.city; if(pa.state)patch.state=pa.state; if(pa.zip)patch.zip=pa.zip; }
          updates.push({id,patch}); }
        for(const part of chunk(updates,20)){ await Promise.all(part.map(u=> sbSend("PATCH","dealers?id=eq."+u.id,u.patch,{Prefer:"return=minimal"}).catch(e=>{ if(errors.length<8) errors.push("dealer update: "+e.message); }) )); }

        return json(200,{ok:errors.length===0,result:{matched,created,updated:dealerUpd.size,entitlements:ents,contacts:contactsStored,addresses:addressesStored,unmatched,errors:errors.slice(0,6)}});
      }
      if(act==="approve_login"){
        if(!b.uid) return json(400,{error:"uid required"});
        let dealerId=b.dealer_id||null;
        // Approve + create a brand-new dealer from the registrant's submitted details.
        if(!dealerId && b.new_dealer && String(b.new_dealer.business_name||"").trim()){
          const nd=b.new_dealer;
          const ins=await sbSend("POST","dealers",{
            business_name:String(nd.business_name).trim(),
            contact_name:nd.contact_name||null, email:nd.email||null, phone:nd.phone||null,
            address:nd.address||null, city:nd.city||null, state:nd.state||null, zip:nd.zip||null,
            active:true, status:"prospect"
          },{Prefer:"return=representation"});
          dealerId=ins&&ins[0]&&ins[0].id||null;
        }
        await rpc("approve_dealer_login",{p_uid:b.uid,p_dealer:dealerId||null,p_by:b.by||"admin"});
        return json(200,{ok:true,dealer_id:dealerId});
      }
      if(act==="revoke_login"){
        if(!b.uid) return json(400,{error:"uid required"});
        await rpc("set_dealer_login_status",{p_uid:b.uid,p_status:b.status||"revoked"});
        return json(200,{ok:true});
      }
      // Change the actual portal SIGN-IN email (Supabase Auth) for a dealer login.
      // Accepts uid directly, or dealer_id (resolves the newest dealer_users row).
      if(act==="set_login_email"){
        const email=String(b.email||"").trim().toLowerCase();
        if(!EMAIL_RE.test(email)) return json(400,{error:"a valid email is required"});
        let uid=b.uid||null;
        if(!uid && b.dealer_id){
          const rows=await sbGet(`dealer_users?select=uid,created_at&dealer_id=eq.${encodeURIComponent(b.dealer_id)}&order=created_at.desc&limit=1`).catch(()=>[]);
          uid=rows&&rows[0]&&rows[0].uid||null;
        }
        if(!uid) return json(400,{error:"no portal login found for this dealer"});
        // Update Supabase Auth (the credential used to sign in) then mirror into dealer_users.
        await authAdmin("PUT",`users/${encodeURIComponent(uid)}`,{email,email_confirm:true});
        await sbSend("PATCH",`dealer_users?uid=eq.${encodeURIComponent(uid)}`,{email},{Prefer:"return=minimal"}).catch(()=>{});
        return json(200,{ok:true,uid,email});
      }
      // Delete a portal login entirely (removes the Auth user + the dealer_users row).
      // Use to clear a mistaken registration so the dealer can register again cleanly.
      if(act==="delete_login"){
        if(!b.uid) return json(400,{error:"uid required"});
        await authAdmin("DELETE",`users/${encodeURIComponent(b.uid)}`).catch(()=>{});
        await sbSend("DELETE",`dealer_users?uid=eq.${encodeURIComponent(b.uid)}`,null,{Prefer:"return=minimal"}).catch(()=>{});
        return json(200,{ok:true});
      }
      return json(400,{error:"unknown action"});
    }
    return json(405,{error:"method not allowed"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};

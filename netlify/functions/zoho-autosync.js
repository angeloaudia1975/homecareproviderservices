// HCPS ⇄ Zoho — AUTOMATIC two-way sync (scheduled). Runs on a cron and keeps Zoho CRM Plus in
// step with Dealer 360 without anyone pressing a button. Ownership-safe BY CONSTRUCTION:
//   OUTBOUND (Dealer 360 owns → pushed up): dealer profile → Accounts, people → Contacts,
//            pipeline → Deals. Only records whose CONTENT actually changed since the last run are
//            pushed — a per-record content hash is kept in app_settings.zoho_push_hashes — so
//            unchanged data is never re-written and Zoho's Modified_Time doesn't churn.
//   INBOUND  (Zoho owns pipeline stage → pulled down): Zoho Deal stage / amount / close date flow
//            back onto linked opportunities.
// We deliberately never PUSH engagement / lead-score / campaign fields (Zoho owns those — they're
// absent from the field sets below) and never PULL profile fields (Dealer 360 owns those). So each
// side only ever writes the fields it owns; the other side's columns are left untouched.
// Real-time inbound *signal* is delivered separately by zoho-webhook.js; this scheduler is the
// steady heartbeat that reconciles both directions and is the outbound (portal→Zoho) engine.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const { accessToken, zoho, upsertRecords, getAllRecords } = require("./_zoho.js");

const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }

// Field helpers — copied verbatim from zoho-api.js so the automatic push maps fields identically
// to the proven manual sync (same Account/Contact/Deal shapes, same personal-domain skip list).
const clean = v => { const s=(v==null?"":String(v)).trim(); return s||undefined; };
const PERSONAL = new Set(["gmail.com","yahoo.com","hotmail.com","aol.com","outlook.com","icloud.com","comcast.net","att.net","msn.com","live.com","sbcglobal.net","bellsouth.net","ymail.com","me.com","cox.net","verizon.net","charter.net","windstream.net"]);
const websiteFrom = email => { const m=String(email||"").trim().toLowerCase().match(/@([^@\s]+)$/); if(!m) return undefined; const dom=m[1]; return PERSONAL.has(dom)?undefined:("https://"+dom); };
const splitName = n => { const p=String(n||"").trim().split(/\s+/).filter(Boolean); if(!p.length) return {first:"",last:""}; return { first:p.slice(0,-1).join(" ")||p[0], last:p.length>1?p[p.length-1]:p[0] }; };
const STAGE_TO_ZOHO={identified:"Qualification",contacted:"Needs Analysis",quoted:"Proposal/Price Quote",won:"Closed Won",lost:"Closed Lost"};
const ZOHO_TO_STAGE={"Qualification":"identified","Needs Analysis":"contacted","Value Proposition":"contacted","Identify Decision Makers":"contacted","Proposal/Price Quote":"quoted","Negotiation/Review":"quoted","Closed Won":"won","Closed Lost":"lost","Closed-Lost":"lost","Closed Lost to Competition":"lost"};
// Business-name normalization (same dnorm the rest of the app uses) so a Zoho Account name on an
// inbound webhook event resolves to the same dealer; + the email shape used everywhere.
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Stable content hash (key-order-independent) — lets us skip records that haven't changed.
function hashOf(obj){
  const keys=Object.keys(obj).sort();
  const s=keys.map(k=>k+"="+(obj[k]==null?"":String(obj[k]))).join("|");
  let h=5381; for(let i=0;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))|0; } return (h>>>0).toString(36);
}
function prune(rec){ Object.keys(rec).forEach(k=>rec[k]===undefined&&delete rec[k]); return rec; }

async function getZohoAuth(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_auth&select=value"); return (rows&&rows[0]&&rows[0].value)||null; }catch(e){ return null; } }
async function getHashes(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_push_hashes&select=value"); return (rows&&rows[0]&&rows[0].value)||{}; }catch(e){ return {}; } }
async function setHashes(v){ try{ await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_push_hashes",value:v,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){} }
async function stampSync(k){ try{ const rows=await sbGet("app_settings?key=eq.zoho_sync&select=value"); const v=(rows&&rows[0]&&rows[0].value)||{}; v[k]=new Date().toISOString(); await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_sync",value:v,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){} }
async function logRow(row){ try{ await sbSend("POST","zoho_sync_log",row,{Prefer:"return=minimal"}); }catch(e){} }

async function run(){
  const cfg=await getZohoAuth();
  if(!cfg||!cfg.refresh_token){ await logRow({direction:"out",entity:"autosync",action:"run",result:"skip",detail:"not connected"}); return {ok:false,reason:"not_connected"}; }
  const at=await accessToken(cfg.refresh_token);
  if(!at||!at.ok){ await logRow({direction:"out",entity:"autosync",action:"run",result:"fail",detail:"token refresh failed"}); return {ok:false,reason:"token"}; }
  const apiDomain=(cfg.api_domain||at.api_domain||"https://www.zohoapis.com").replace(/\/+$/,"");
  const token=at.access_token;

  const hashes=await getHashes(); const next={...hashes};
  const summary={accounts:{changed:0,ok:0}, contacts:{changed:0,ok:0}, opportunities:{changed:0,ok:0}, deals_pulled:0, errors:[]};

  // Cache Zoho Account ids by name (needed to LINK contacts + deals to their account). One read.
  const acctIdByName={};
  try{ const accts=await getAllRecords(apiDomain,token,"Accounts","Account_Name"); for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[String(a.Account_Name)]=a.id; } }catch(e){}

  // ---- OUTBOUND: dealers -> Accounts (changed only, matched on Account_Name) ----
  try{
    const dealers=await sbGetAll("dealers?select=id,business_name,city,state,zip,phone,address,email","id");
    const changed=[];
    for(const d of dealers){
      const rec=prune({ Account_Name:(clean(d.business_name)||("Dealer "+d.id)), Phone:clean(d.phone), Website:websiteFrom(d.email), Billing_Street:clean(d.address), Billing_City:clean(d.city), Billing_State:clean(d.state), Billing_Code:clean(d.zip) });
      rec.Account_Name=String(rec.Account_Name).slice(0,255);
      const key="acct:"+d.id, h=hashOf(rec);
      if(hashes[key]!==h) changed.push({key, record:rec, _h:h});
    }
    summary.accounts.changed=changed.length;
    if(changed.length){
      const res=await upsertRecords(apiDomain,token,"Accounts",changed,["Account_Name"]);
      for(const c of changed){ const id=res.idByKey[c.key]; if(id){ next[c.key]=c._h; summary.accounts.ok++; if(c.record.Account_Name) acctIdByName[c.record.Account_Name]=id; } }
      if(res.errors.length) summary.errors.push({phase:"accounts",errs:res.errors.slice(0,2)});
      await setHashes(next);   // persist progress before the next (heavier) phase
    }
  }catch(e){ summary.errors.push({phase:"accounts",msg:String(e.message||e)}); }

  // ---- OUTBOUND: dealer people -> Contacts (changed only, matched on Email, linked to Account) ----
  try{
    const dealers=await sbGetAll("dealers?select=id,business_name,contact_name,email","id");
    const nameByDealer={}; for(const d of dealers) nameByDealer[String(d.id)]=(clean(d.business_name)||("Dealer "+d.id)).slice(0,255);
    const people=[];
    const dc=await sbGetAll("dealer_contacts?select=id,dealer_id,name,email,phone,title","id").catch(()=>[]);
    for(const x of (dc||[])){ const email=clean(x.email); if(!email||!EMAIL_RE.test(email)) continue; const nm=splitName(x.name); people.push({dealer_id:String(x.dealer_id), email, first:nm.first, last:nm.last, phone:clean(x.phone), title:clean(x.title)}); }
    for(const d of dealers){ const email=clean(d.email); if(!email||!EMAIL_RE.test(email)) continue; const nm=splitName(d.contact_name); people.push({dealer_id:String(d.id), email, first:nm.first, last:nm.last}); }
    const seen=new Set(), uniq=[];
    for(const p of people){ const k=p.email.toLowerCase(); if(seen.has(k)) continue; seen.add(k); uniq.push(p); }
    const changed=[];
    for(const p of uniq){
      const company=nameByDealer[p.dealer_id]||"";
      const rec=prune({ Last_Name:(p.last||p.first||company||"Contact").slice(0,80), First_Name:clean(p.first), Email:p.email, Phone:clean(p.phone), Title:clean(p.title) });
      const key="contact:"+p.email.toLowerCase(), h=hashOf({...rec, _company:company});
      if(hashes[key]!==h){ const acctId=acctIdByName[company]; const record={...rec}; if(acctId) record.Account_Name={id:acctId}; changed.push({key, record, _h:h}); }
    }
    summary.contacts.changed=changed.length;
    if(changed.length){
      const res=await upsertRecords(apiDomain,token,"Contacts",changed,["Email"]);
      for(const c of changed){ if(res.idByKey[c.key]){ next[c.key]=c._h; summary.contacts.ok++; } }
      if(res.errors.length) summary.errors.push({phase:"contacts",errs:res.errors.slice(0,2)});
      await setHashes(next);
    }
  }catch(e){ summary.errors.push({phase:"contacts",msg:String(e.message||e)}); }

  // ---- OUTBOUND: pipeline -> Deals (changed only; PUT when we already know the Zoho Deal id) ----
  try{
    const opps=await sbGetAll("opportunities?select=id,dealer_id,title,line,stage,value,expected_close,zoho_id","id").catch(()=>[]);
    const dealers=await sbGetAll("dealers?select=id,business_name","id"); const nameById={}; for(const d of dealers) nameById[d.id]=(clean(d.business_name)||("Dealer "+d.id)).slice(0,255);
    const today=new Date().toISOString().slice(0,10);
    for(const o of opps){
      const rec=prune({ Deal_Name:String(o.title||"Opportunity").slice(0,255), Amount:Number(o.value)||0, Stage:STAGE_TO_ZOHO[o.stage]||"Qualification", Closing_Date:/^\d{4}-\d{2}-\d{2}$/.test(String(o.expected_close||""))?o.expected_close:today });
      if(o.line) rec.Description="Line: "+o.line;
      const acctId=o.dealer_id?acctIdByName[nameById[o.dealer_id]]:null;
      const key="opp:"+o.id, h=hashOf({...rec, _acct:acctId||"", _zid:o.zoho_id||""});
      if(hashes[key]===h) continue;
      const body={...rec}; if(acctId) body.Account_Name={id:acctId};
      let r;
      if(o.zoho_id){ r=await zoho("PUT",apiDomain,token,"/crm/v8/Deals",{data:[{id:o.zoho_id,...body}]}); }
      else { r=await zoho("POST",apiDomain,token,"/crm/v8/Deals",{data:[body]}); }
      const row=r.ok&&r.json&&Array.isArray(r.json.data)&&r.json.data[0];
      if(row&&row.code==="SUCCESS"){ next[key]=h; summary.opportunities.ok++; if(!o.zoho_id){ const id=row.details&&row.details.id; if(id){ try{ await sbSend("PATCH",`opportunities?id=eq.${encodeURIComponent(o.id)}`,{zoho_id:id},{Prefer:"return=minimal"}); }catch(e){} } } }
      else if(summary.errors.length<8){ summary.errors.push({phase:"opps",opp:o.id,msg:(r.json&&JSON.stringify(r.json).slice(0,120))||("http "+r.status)}); }
    }
    summary.opportunities.changed=summary.opportunities.ok;
    await setHashes(next);
  }catch(e){ summary.errors.push({phase:"opps",msg:String(e.message||e)}); }

  // ---- INBOUND: Zoho Deal stage/amount/close -> linked opportunities (Zoho owns pipeline moves) ----
  try{
    const opps=await sbGetAll("opportunities?select=id,zoho_id,stage,value,expected_close&zoho_id=not.is.null","id").catch(()=>[]);
    if(opps.length){
      const byZoho={}; for(const o of opps) byZoho[o.zoho_id]=o;
      const deals=await getAllRecords(apiDomain,token,"Deals","Deal_Name,Stage,Amount,Closing_Date,Modified_Time");
      for(const d of (deals||[])){ const o=byZoho[d.id]; if(!o) continue;
        const mapped=ZOHO_TO_STAGE[d.Stage]||null; const patch={};
        if(mapped && mapped!==o.stage) patch.stage=mapped;
        if(d.Amount!=null && Math.round(Number(d.Amount))!==Math.round(Number(o.value||0))) patch.value=Number(d.Amount)||0;
        if(d.Closing_Date && d.Closing_Date!==o.expected_close) patch.expected_close=d.Closing_Date;
        if(Object.keys(patch).length){
          if(patch.stage){ patch.status=patch.stage==="won"?"won":patch.stage==="lost"?"lost":"open"; const P={identified:0.1,contacted:0.3,quoted:0.6,won:1,lost:0}; patch.probability=P[patch.stage]; }
          patch.updated_at=new Date().toISOString();
          try{ await sbSend("PATCH",`opportunities?id=eq.${encodeURIComponent(o.id)}`,patch,{Prefer:"return=minimal"}); summary.deals_pulled++; }catch(e){}
        }
      }
    }
  }catch(e){ summary.errors.push({phase:"pull_deals",msg:String(e.message||e)}); }

  // ---- INBOUND webhook queue: process the real-time Zoho change events captured by zoho-webhook.js.
  // Ownership-safe: we NEVER overwrite Dealer-360-owned profile fields from here. For each event we
  //   (1) resolve the dealer (by the webhook's email match, else by the Account name),
  //   (2) grow the address book — a known dealer + a business email we don't have yet becomes a
  //       dealer_contact (which also improves inbound email auto-matching), and
  //   (3) drop a touch-point on the dealer timeline so reps see Zoho-side activity,
  // then mark the queue row done so it never re-processes. Bounded per run to stay well inside the
  // function budget; leftover rows drain on the next heartbeat.
  try{
    const pend=await sbGetAll("zoho_sync_queue?select=id,entity,entity_id,dealer_id,payload,attempts&direction=eq.in&status=eq.pending&order=id.asc&limit=400","id").catch(()=>[]);
    if(pend.length){
      const dealers=await sbGetAll("dealers?select=id,business_name","id");
      const norm2id=new Map(); for(const d of dealers) norm2id.set(dnorm(d.business_name), d.id);
      const aliases=await sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]);
      for(const a of (aliases||[])){ if(a&&a.alias_norm&&!norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm,a.dealer_id); }
      let processed=0, touched=0, newContacts=0;
      for(const q of pend){
        const p=q.payload||{};
        const email=String(p.Email||p.email||"").trim().toLowerCase();
        const account=String(p["Account Name"]||p.Account_Name||p.account_name||p.Account||"").trim();
        let dealer_id=q.dealer_id||null;
        if(!dealer_id && account){ const id=norm2id.get(dnorm(account)); if(id) dealer_id=id; }
        // Grow the address book (known dealer + new business email).
        if(dealer_id && email && EMAIL_RE.test(email)){
          try{
            const ex=await sbGet(`dealer_contacts?dealer_id=eq.${encodeURIComponent(dealer_id)}&email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
            if(!(Array.isArray(ex)&&ex.length)){
              const nm=[clean(p.First_Name),clean(p.Last_Name)].filter(Boolean).join(" ")||undefined;
              await sbSend("POST","dealer_contacts?on_conflict=dealer_id,email",prune({dealer_id,email,name:nm}),{Prefer:"resolution=merge-duplicates,return=minimal"});
              newContacts++;
            }
          }catch(e){}
        }
        // Timeline touch-point (visible to reps; leaves owned profile fields untouched).
        if(dealer_id){
          const subj=("Zoho "+(q.entity||"record")+" updated"+(email?(" — "+email):account?(" — "+account):"")).slice(0,180);
          try{ await sbSend("POST","dealer_activity",{dealer_id,kind:"system",subject:subj,actor:"Zoho sync"},{Prefer:"return=minimal"}); touched++; }catch(e){}
        }
        try{ await sbSend("PATCH",`zoho_sync_queue?id=eq.${encodeURIComponent(q.id)}`,{status:"synced",dealer_id,processed_at:new Date().toISOString(),updated_at:new Date().toISOString()},{Prefer:"return=minimal"}); processed++; }catch(e){}
      }
      summary.inbound={processed,touched,new_contacts:newContacts};
    }
  }catch(e){ summary.errors.push({phase:"inbound_queue",msg:String(e.message||e)}); }

  await setHashes(next);
  await stampSync("autosync_at");
  await logRow({direction:"out",entity:"autosync",action:"run",result:summary.errors.length?"partial":"ok",detail:JSON.stringify(summary).slice(0,600)});
  return {ok:true, summary};
}

exports.handler = async ()=>{
  try{ const res=await run(); return {statusCode:200, headers:{"content-type":"application/json"}, body:JSON.stringify(res)}; }
  catch(e){
    try{ await logRow({direction:"out",entity:"autosync",action:"run",result:"fail",detail:String(e&&e.message||e).slice(0,300)}); }catch(_){}
    return {statusCode:200, headers:{"content-type":"application/json"}, body:JSON.stringify({ok:false,error:String(e&&e.message||e)})};
  }
};

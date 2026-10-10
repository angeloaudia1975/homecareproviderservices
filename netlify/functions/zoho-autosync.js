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
//
// Phase 2F-4 — inbound events are CLASSIFIED here, never applied. Each captured webhook event is compared
// with HCPS's own record of what it last pushed successfully: Zoho's current values of the fields HCPS pushes
// (hashed exactly as the push hashed them) must equal HCPS's last push fingerprint (zoho_push_hashes) AND the
// event must have happened at that push (zoho_push_times) — then it is an HCPS echo ("ignored"). Anything
// else is an external Zoho change, or "unresolved" when it can't be tied to one HCPS record; both stay
// pending for the conflict-safe processor (2F-5). Modified_By is never used: the integration signs in as a
// real person. Classification writes only the queue row — no dealer, contact, deal, activity or Zoho write.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const { accessToken, zoho, upsertRecords, getAllRecords } = require("./_zoho.js");
// Phase 2F-1: every step that used to swallow an error records a failure row (one per record)
// and the run is logged "partial". Sync behaviour itself is unchanged.
const ZL = require("./_zoho_log.js");
// Phase 2F-2: TEST isolation — nothing attached to an is_test dealer is pushed (the shared rule).
const ZT = require("./_zoho_test.js");

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
// Phase 2F-5: Deals (and the stage mapping) are handled by the one deal engine.
const DS = require("./_zoho_deals.js");
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

// F (the run's failure collector) is set by run(); helpers report into it when one exists.
let F=null;
const failMsg=e=>String((e&&e.message)||e);
async function getZohoAuth(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_auth&select=value"); return (rows&&rows[0]&&rows[0].value)||null; }
  catch(e){ if(F) F.fail({phase:"auth_read",entity:"zoho_auth",action:"read",msg:failMsg(e)}); return null; } }
async function getHashes(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_push_hashes&select=value"); return (rows&&rows[0]&&rows[0].value)||{}; }
  catch(e){ if(F) F.fail({phase:"hashes_read",entity:"sync_state",action:"read",msg:"push fingerprints couldn't be read, so every record counts as changed this run: "+failMsg(e)}); return {}; } }
async function setHashes(v){ try{ await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_push_hashes",value:v,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
  catch(e){ if(F) F.fail({phase:"hashes_write",entity:"sync_state",action:"write",msg:"push fingerprints weren't saved, so this run's records will be pushed again: "+failMsg(e)}); } }
// Phase 2F-4: when each record was last ACCEPTED by Zoho (app_settings.zoho_push_times, key → ISO time). It only
// supports echo classification: what is pushed, and when, still depends on zoho_push_hashes alone. If the times
// can't be read they are not rewritten this run (no wipe), and no event can be proven an echo.
async function getPushTimes(){ try{ const rows=await sbGet("app_settings?key=eq.zoho_push_times&select=value"); return { ok:true, v:(rows&&rows[0]&&rows[0].value)||{} }; }
  catch(e){ if(F) F.fail({phase:"push_times_read",entity:"sync_state",action:"read",msg:"HCPS push times couldn't be read — they are left as they are, and no inbound event can be proven an echo this run: "+failMsg(e)}); return { ok:false, v:{} }; } }
async function setPushTimes(v){ try{ await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_push_times",value:v,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); return true; }
  catch(e){ if(F) F.fail({phase:"push_times_write",entity:"sync_state",action:"write",msg:"HCPS push times weren't saved, so echoes of this run's pushes can't be proven: "+failMsg(e)}); return false; } }
async function stampSync(k){ try{ const rows=await sbGet("app_settings?key=eq.zoho_sync&select=value"); const v=(rows&&rows[0]&&rows[0].value)||{}; v[k]=new Date().toISOString(); await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_sync",value:v,updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
  catch(e){ if(F) F.fail({phase:"stamp",entity:"sync_state",action:"write",msg:"last-sync time not saved ("+k+"): "+failMsg(e)}); } }
async function logRow(row){ try{ await sbSend("POST","zoho_sync_log",row,{Prefer:"return=minimal"}); }catch(e){ console.error("zoho_sync_log write failed:", ZL.scrubString(failMsg(e))); } }
// A Zoho read that came back incomplete (see _zoho.js getAllRecords) — recorded, the run carries on as before.
function readCheck(list, phase){ if(list && list.incomplete && F) F.fail({phase,entity:String(list.incomplete.module||"zoho").toLowerCase(),action:"read",msg:"Zoho read stopped early: "+list.incomplete.message,extra:{page:list.incomplete.page,status:list.incomplete.status,records_read:list.incomplete.records_read}}); return list||[]; }
// Every record a Zoho upsert refused, one failure row each.
function upsertFails(res, phase, entity, idOf){ for(const f of ((res&&res.failed)||[])){ const id=idOf(f.key); F.fail({phase,entity,entity_id:id.entity_id,dealer_id:id.dealer_id||null,action:"push",msg:(f.code?f.code+": ":"")+(f.message||"not accepted"),extra:{zoho_details:f.details||null}}); } }

// ---------- Phase 2F-4: inbound classification ----------
const CLASSIFY_BATCH=200;
const ZMOD={accounts:"Accounts",contacts:"Contacts",deals:"Deals"};
// The Zoho fields each push writes (+ Modified_Time) — read back to compare with HCPS's last push.
const ZFIELDS={ accounts:"Account_Name,Phone,Website,Billing_Street,Billing_City,Billing_State,Billing_Code,Modified_Time",
  contacts:"Last_Name,First_Name,Email,Phone,Title,Account_Name,Modified_Time",
  deals:"Deal_Name,Amount,Stage,Closing_Date,Description,Account_Name,Modified_Time" };
// An echo's change happens at HCPS's push: Zoho stamps Modified_Time just before it answers, and HCPS records the
// push time just after (a batch of up to 100 accounts or contacts takes a little while).
const ECHO_BEFORE_MS=10*60e3, ECHO_AFTER_MS=2*60e3;
// Zoho times (webhook "yyyy-mm-dd HH:MM:SS" Chicago, or ISO): one parser, shared with the deal engine.
const parseZohoTime=DS.parseZohoTime;
const lookupName=x=>x&&typeof x==="object"?(x.name==null?null:String(x.name)):(x==null?null:String(x));
const lookupId=x=>x&&typeof x==="object"?(x.id==null?null:String(x.id)):null;
const pushedAcctName=d=>(clean(d.business_name)||("Dealer "+d.id)).slice(0,255);

// HCPS's last ACCEPTED push to each Zoho record: zoho_push_times[key] = {at, id} (key as in zoho_push_hashes).
const pushRec=v=>(v&&typeof v==="object"&&v.at&&v.id)?v:null;
const KEY_ENTITY={acct:"accounts",contact:"contacts",opp:"deals"};

// One event → {cls, reason}. z = the record's CURRENT Zoho values (undefined when Zoho has no such record).
// Echo needs ALL of: (1) exactly one HCPS record whose last accepted push went to THIS Zoho record (module + id);
// (2) Zoho's current values of the fields that push writes, rebuilt exactly as the push hashed them (same fields,
// same cleaning, same hidden link keys), hash to that push's fingerprint; (3) the event's Modified_Time falls at
// that push. Anything else is external, or unresolved when it can't be tied to one HCPS record. Nothing about
// who made the change (Modified_By) is used.
function classifyOne(q, z, ctx, m){
  if(!z) return {cls:"unresolved", reason:"the record was not found in Zoho (deleted, merged or not readable), so it can't be compared"};
  const zid=String(z.id), keys=m.keysByZid.get(q.entity+":"+zid)||[];
  if(keys.length>1) return {cls:"unresolved", reason:keys.length+" HCPS records were last pushed to this Zoho record ("+keys.join(", ")+"), so it can't be tied to one HCPS record"};
  if(!keys.length) return {cls:"external", reason:"HCPS has no recorded successful push to this Zoho record"+testNote(q.entity,z,ctx,m)+", so it isn't an HCPS echo"};
  const key=keys[0], push=ctx.times[key]; let rec, dealFp=null;
  if(q.entity==="accounts"){
    rec=prune({ Account_Name:clean(z.Account_Name), Phone:clean(z.Phone), Website:clean(z.Website), Billing_Street:clean(z.Billing_Street), Billing_City:clean(z.Billing_City), Billing_State:clean(z.Billing_State), Billing_Code:clean(z.Billing_Code) });
    if(rec.Account_Name!=null) rec.Account_Name=String(rec.Account_Name).slice(0,255);
  } else if(q.entity==="contacts"){
    rec={...prune({ Last_Name:clean(z.Last_Name), First_Name:clean(z.First_Name), Email:clean(z.Email), Phone:clean(z.Phone), Title:clean(z.Title) }), _company:lookupName(z.Account_Name)||""};
  } else {
    const o=m.oppById.get(key.slice(4)); if(!o) return {cls:"external", reason:"the HCPS deal last pushed to this Zoho record ("+key+") no longer exists, so it can't be compared"};
    rec=null; dealFp=DS.fingerprint(z, o.line);   // the same fingerprint the deal engine records for its pushes
  }
  const stored=ctx.hashes[key];
  if(!stored) return {cls:"external", reason:"HCPS has no push fingerprint for "+key+", so it can't be proven an echo"};
  if((rec?hashOf(rec):dealFp)!==stored) return {cls:"external", reason:"Zoho's current values of the fields HCPS pushes differ from HCPS's last successful push for "+key+": an external Zoho change"};
  const evt=parseZohoTime(q.modified_time);
  if(!evt) return {cls:"external", reason:"Zoho's values equal HCPS's last push for "+key+", but the event's Modified_Time ("+(q.modified_time||"none")+") can't be read, so it can't be proven an echo"};
  const dt=evt.getTime()-Date.parse(push.at);
  if(!(dt>=-ECHO_BEFORE_MS && dt<=ECHO_AFTER_MS)) return {cls:"external", reason:"Zoho's values equal HCPS's last push for "+key+" (at "+push.at+"), but this change ("+evt.toISOString()+") was not made by that push: a change to fields HCPS doesn't push, or one a later HCPS push replaced"};
  return {cls:"echo", reason:"HCPS echo: Zoho record "+zid+" holds exactly what HCPS pushed for "+key+" at "+push.at+" (fingerprint "+stored+"), and this change ("+evt.toISOString()+") happened at that push"};
}
// A note only (never part of the decision): the record belongs to a TEST dealer, which HCPS never pushes.
function testNote(ent, z, ctx, m){
  const T=ctx.T; if(!T) return "";
  try{
    if(ent==="accounts"){ const l=m.dealersByName.get(String(z.Account_Name==null?"":z.Account_Name))||[]; return l.some(d=>T.dealer(d.id))?" (it carries a TEST dealer's name; TEST records are never pushed)":""; }
    if(ent==="contacts") return (clean(z.Email)&&T.email(clean(z.Email)))?" (a TEST contact; TEST records are never pushed)":"";
    if(ent==="deals"){ const o=m.oppByZoho.get(String(z.id)); return (o&&T.dealer(o.dealer_id))?" (a TEST dealer's deal; TEST records are never pushed)":""; }
  }catch(e){}
  return "";
}

async function classifyInbound(pend, ctx){
  const out={classified:0, echo:0, external:0, unresolved:0, left_unclassified:0};
  // Without HCPS's push records nothing can be proven an echo, and calling everything external would be a guess:
  // leave every event unclassified (the read failure is already recorded) and try again next run.
  if(!ctx.timesOk){ out.left_unclassified=pend.length; return out; }
  const need=new Set(pend.map(q=>q.entity));
  let dealers=[], opps=[];
  try{
    if(need.has("accounts")) dealers=await sbGetAll("dealers?select=id,business_name","id");
    if(need.has("deals")) opps=await sbGetAll("opportunities?select=id,dealer_id,zoho_id,line","id");
  }catch(e){ F.fail({phase:"inbound_classify",entity:"queue",direction:"in",action:"read",msg:"the HCPS records needed to classify inbound events couldn't be read, so none were classified: "+failMsg(e)}); out.left_unclassified=pend.length; return out; }
  const m={ keysByZid:new Map(), dealersByName:new Map(), oppByZoho:new Map(), oppById:new Map() };
  for(const [key,v] of Object.entries(ctx.times||{})){ const pr=pushRec(v), ent=KEY_ENTITY[key.split(":")[0]]; if(!pr||!ent) continue;
    const k=ent+":"+String(pr.id); if(!m.keysByZid.has(k)) m.keysByZid.set(k,[]); m.keysByZid.get(k).push(key); }
  for(const d of dealers){ const n=pushedAcctName(d); if(!m.dealersByName.has(n)) m.dealersByName.set(n,[]); m.dealersByName.get(n).push(d); }
  for(const o of opps){ m.oppById.set(String(o.id), o); if(o.zoho_id) m.oppByZoho.set(String(o.zoho_id), o); }
  // The CURRENT Zoho values of each record, read by id (100 per call). A module that can't be read leaves its
  // events unclassified for the next run.
  const zrec={}, readOk={};
  for(const ent of need){
    const mod=ZMOD[ent]; if(!mod) continue; readOk[ent]=true;
    const ids=[...new Set(pend.filter(q=>q.entity===ent && q.zoho_id).map(q=>String(q.zoho_id)))];
    for(let i=0;i<ids.length;i+=100){
      const chunk=ids.slice(i,i+100);
      const r=await zoho("GET",ctx.apiDomain,ctx.token,`/crm/v8/${mod}?ids=${chunk.map(encodeURIComponent).join(",")}&fields=${ZFIELDS[ent]}`);
      if(r.status===204) continue;   // none of these records exists in Zoho
      if(!r.ok || !r.json || !Array.isArray(r.json.data)){ readOk[ent]=false;
        F.fail({phase:"inbound_classify",entity:ent,direction:"in",action:"read",msg:"Zoho "+mod+" couldn't be read to classify inbound events (they stay unclassified until the next run): "+((r.json&&(r.json.code||r.json.message))?[r.json.code,r.json.message].filter(Boolean).join(": "):"http "+r.status),extra:{records:chunk.length}});
        break; }
      for(const z of r.json.data) zrec[ent+":"+z.id]=z;
    }
  }
  for(const q of pend){
    if(ZMOD[q.entity] && !readOk[q.entity]){ out.left_unclassified++; continue; }
    const v=ZMOD[q.entity] ? classifyOne(q, zrec[q.entity+":"+q.zoho_id], ctx, m)
      : {cls:"unresolved", reason:"the event's module ("+q.entity+") isn't one HCPS classifies"};
    const now=new Date().toISOString();
    // Only a row still unclassified is written (an overlapping run can't classify it twice or overwrite it).
    try{ const upd=await sbSend("PATCH",`zoho_sync_queue?id=eq.${encodeURIComponent(q.id)}&classification=is.null`,{classification:v.cls, class_reason:v.reason.slice(0,1000), classified_at:now,
        status:v.cls==="echo"?"ignored":"pending", processed_at:v.cls==="echo"?now:null, updated_at:now},{Prefer:"return=representation"});
      if(Array.isArray(upd) && !upd.length) continue;
      out.classified++; out[v.cls]++; }
    catch(e){ out.left_unclassified++; F.fail({phase:"inbound_classify",entity:"queue",entity_id:String(q.id),zoho_id:q.zoho_id||null,direction:"in",action:"write",msg:"an inbound event was classified ("+v.cls+") but the result wasn't saved; it is classified again next run: "+failMsg(e)}); }
  }
  return out;
}

async function run(){
  const runAt=new Date().toISOString();
  F=ZL.collector({run:runAt});
  try{ return await runInner(runAt); }
  finally{ try{ await F.flush(); }catch(e){} F=null; }
}
async function runInner(runAt){
  const cfg=await getZohoAuth();
  if(!cfg||!cfg.refresh_token){ await F.flush(); await logRow({direction:"out",entity:"autosync",action:"run",result:F.count()?"fail":"skip",detail:F.count()?"Zoho connection settings couldn't be read":"not connected"}); return {ok:false,reason:F.count()?"auth_read":"not_connected"}; }
  const at=await accessToken(cfg.refresh_token);
  if(!at||!at.ok){ await logRow({direction:"out",entity:"autosync",action:"run",result:"fail",detail:ZL.scrubString("token refresh failed"+(at&&at.error?": "+at.error:"")+(at&&at.status?" (http "+at.status+")":""))}); return {ok:false,reason:"token"}; }
  const apiDomain=(cfg.api_domain||at.api_domain||"https://www.zohoapis.com").replace(/\/+$/,"");
  const token=at.access_token;

  const hashes=await getHashes(); const next={...hashes};
  const PT=await getPushTimes(); const times={...PT.v}; let timesDirty=false;
  const pushedOk=(key,zid)=>{ times[key]={at:new Date().toISOString(), id:String(zid)}; timesDirty=true; };
  const saveTimes=async()=>{ if(PT.ok && timesDirty && await setPushTimes(times)) timesDirty=false; };
  const summary={accounts:{changed:0,ok:0}, contacts:{changed:0,ok:0}, opportunities:{changed:0,ok:0}, deals_pulled:0, errors:[]};
  // Phase 2F-2: which dealers are TEST. If that can't be read, NOTHING is pushed this run (fail closed);
  // the pulls below still run (they only write to HCPS).
  let T=null;
  try{ T=await ZT.load(sbGet); }
  catch(e){ F.fail({phase:"test_rule",entity:"dealers",action:"read",msg:"TEST dealers couldn't be read, so nothing was pushed to Zoho this run: "+failMsg(e)}); summary.outbound_skipped="test_rule_unavailable"; }
  summary.test_excluded={accounts:0,contacts:0,deals:0};

  // Cache Zoho Account ids by name (needed to LINK contacts + deals to their account). One read.
  const acctIdByName={};
  try{ const accts=readCheck(await getAllRecords(apiDomain,token,"Accounts","Account_Name"),"accounts_read"); for(const a of (accts||[])){ if(a.Account_Name) acctIdByName[String(a.Account_Name)]=a.id; } }
  catch(e){ F.fail({phase:"accounts_read",entity:"accounts",action:"read",msg:"Zoho Accounts couldn't be read (contacts and deals go out without their account link): "+failMsg(e)}); }

  // ---- OUTBOUND: dealers -> Accounts (changed only, matched on Account_Name) ----
  if(T) try{
    const dealers=await sbGetAll("dealers?select=id,business_name,city,state,zip,phone,address,email","id");
    const changed=[];
    for(const d of dealers){
      if(T.dealer(d.id)){ summary.test_excluded.accounts++; continue; }   // a TEST dealer is never an Account
      const rec=prune({ Account_Name:(clean(d.business_name)||("Dealer "+d.id)), Phone:clean(d.phone), Website:websiteFrom(d.email), Billing_Street:clean(d.address), Billing_City:clean(d.city), Billing_State:clean(d.state), Billing_Code:clean(d.zip) });
      rec.Account_Name=String(rec.Account_Name).slice(0,255);
      const key="acct:"+d.id, h=hashOf(rec);
      if(hashes[key]!==h) changed.push({key, record:rec, _h:h});
    }
    summary.accounts.changed=changed.length;
    if(changed.length){
      const res=await upsertRecords(apiDomain,token,"Accounts",changed,["Account_Name"]);
      for(const c of changed){ const id=res.idByKey[c.key]; if(id){ next[c.key]=c._h; pushedOk(c.key,id); summary.accounts.ok++; if(c.record.Account_Name) acctIdByName[c.record.Account_Name]=id; } }
      upsertFails(res,"accounts","dealer",k=>({entity_id:String(k||"").replace(/^acct:/,""),dealer_id:String(k||"").replace(/^acct:/,"")}));
      await setHashes(next);   // persist progress before the next (heavier) phase
      await saveTimes();
    }
  }catch(e){ summary.errors.push({phase:"accounts",msg:String(e.message||e)}); }
  await F.flush();

  // ---- OUTBOUND: dealer people -> Contacts (changed only, matched on Email, linked to Account) ----
  if(T) try{
    const dealers=await sbGetAll("dealers?select=id,business_name,contact_name,email","id");
    const nameByDealer={}; for(const d of dealers) nameByDealer[String(d.id)]=(clean(d.business_name)||("Dealer "+d.id)).slice(0,255);
    const people=[];
    const dc=await sbGetAll("dealer_contacts?select=id,dealer_id,name,email,phone,title","id").catch(e=>{ F.fail({phase:"contacts_read",entity:"contacts",action:"read",msg:"HCPS contacts couldn't be read (only dealers' main emails were considered): "+failMsg(e)}); return []; });
    // A TEST dealer's contacts and its own email are left out BEFORE de-duplication, so the same address on
    // a real dealer is still pushed for that real dealer.
    for(const x of (dc||[])){ const email=clean(x.email); if(!email||!EMAIL_RE.test(email)) continue; if(T.dealer(x.dealer_id)){ summary.test_excluded.contacts++; continue; } const nm=splitName(x.name); people.push({dealer_id:String(x.dealer_id), email, first:nm.first, last:nm.last, phone:clean(x.phone), title:clean(x.title)}); }
    for(const d of dealers){ const email=clean(d.email); if(!email||!EMAIL_RE.test(email)) continue; if(T.dealer(d.id)){ summary.test_excluded.contacts++; continue; } const nm=splitName(d.contact_name); people.push({dealer_id:String(d.id), email, first:nm.first, last:nm.last}); }
    const seen=new Set(), uniq=[];
    for(const p of people){ const k=p.email.toLowerCase(); if(seen.has(k)) continue; seen.add(k); uniq.push(p); }
    const changed=[], dealerOfKey={};
    for(const p of uniq){
      const company=nameByDealer[p.dealer_id]||"";
      const rec=prune({ Last_Name:(p.last||p.first||company||"Contact").slice(0,80), First_Name:clean(p.first), Email:p.email, Phone:clean(p.phone), Title:clean(p.title) });
      const key="contact:"+p.email.toLowerCase(), h=hashOf({...rec, _company:company});
      if(hashes[key]!==h){ const acctId=acctIdByName[company]; const record={...rec}; if(acctId) record.Account_Name={id:acctId}; changed.push({key, record, _h:h}); dealerOfKey[key]=p.dealer_id; }
    }
    summary.contacts.changed=changed.length;
    if(changed.length){
      const res=await upsertRecords(apiDomain,token,"Contacts",changed,["Email"]);
      for(const c of changed){ if(res.idByKey[c.key]){ next[c.key]=c._h; pushedOk(c.key,res.idByKey[c.key]); summary.contacts.ok++; } }
      upsertFails(res,"contacts","contact",k=>({entity_id:String(k||"").replace(/^contact:/,""),dealer_id:dealerOfKey[k]||null}));
      await setHashes(next);
      await saveTimes();
    }
  }catch(e){ summary.errors.push({phase:"contacts",msg:String(e.message||e)}); }
  await F.flush();

  // ---- INBOUND webhook queue (Phase 2F-4): CLASSIFY ONLY. Each captured event becomes "echo" (status ignored),
  // "external" or "unresolved" (both stay pending for 2F-5), with the reason. Nothing is applied: no dealer,
  // contact, deal, activity or Zoho write happens here. An event that can't be classified this run (Zoho or
  // HCPS couldn't be read) stays unclassified, is recorded as a failure and is tried again next run.
  try{
    let pend=[];
    try{ pend=await sbGet("zoho_sync_queue?select=id,entity,entity_id,zoho_id,modified_time&direction=eq.in&status=eq.pending&classification=is.null&order=id.asc&limit="+CLASSIFY_BATCH); }
    catch(e){ F.fail({phase:"inbound_read",entity:"queue",direction:"in",action:"read",msg:"the inbound queue couldn't be read, so no event was classified: "+failMsg(e)}); }
    if(pend && pend.length) summary.inbound=await classifyInbound(pend,{apiDomain,token,hashes:next,times,timesOk:PT.ok,T});
  }catch(e){ summary.errors.push({phase:"inbound_classify",msg:String(e.message||e)}); }
  await F.flush();

  // ---- DEALS (Phase 2F-5): field-level two-way sync with conflict protection — _zoho_deals.js, the one engine.
  // Runs AFTER classification so this run's external Deal events are seen. Stage, amount and close date are each
  // compared with the last-synchronized baseline: only-HCPS → pushed (never for a TEST deal), only-Zoho → applied
  // to HCPS only with an external/pending Deal event (otherwise reported as drift), both → conflict, nothing
  // changed. New HCPS deals are created in Zoho as before. (Replaces the old whole-record push and the blind pull.)
  try{
    const D=await DS.run({sbGet, sbGetAll, sbSend, zoho, fail:x=>F.fail(x), log:logRow},
      {apiDomain, token, T, acctIdByName, push:true, apply:true, hashes:next, pushedOk});
    summary.deals=D; summary.test_excluded.deals=D.test_excluded;
    summary.opportunities.ok=summary.opportunities.changed=D.created+D.pushed; summary.deals_pulled=D.applied;
  }catch(e){ summary.errors.push({phase:"deals",msg:String(e.message||e)}); }
  await F.flush();

  await setHashes(next);
  await saveTimes();
  await stampSync("autosync_at");
  // The run's summary row: counts only (each failure has its own row, with its full reason) and never cut.
  const fl=await F.flush();
  summary.failures=F.count(); if(summary.failures) summary.failures_by_phase=F.byPhase();
  if(fl.lost) summary.failure_rows_not_written=fl.lost;
  summary.run=runAt;
  await logRow({direction:"out",entity:"autosync",action:"run",result:(summary.errors.length||summary.failures)?"partial":"ok",detail:ZL.scrubString(JSON.stringify(summary))});
  return {ok:true, summary};
}

exports._classifyOne = classifyOne; exports._parseZohoTime = parseZohoTime;   // for the tests
exports.handler = async ()=>{
  try{ const res=await run(); return {statusCode:200, headers:{"content-type":"application/json"}, body:JSON.stringify(res)}; }
  catch(e){
    // 2F-1.1: the crash reason is cleaned like every other log line (no secret, no token) and kept whole.
    const msg=ZL.scrubString(failMsg(e)).slice(0,ZL.DETAIL_MAX);
    try{ await logRow({direction:"out",entity:"autosync",action:"run",result:"fail",detail:msg}); }catch(_){}
    return {statusCode:200, headers:{"content-type":"application/json"}, body:JSON.stringify({ok:false,error:msg})};
  }
};

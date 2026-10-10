// Phase 2F-5 — Deal conflict protection + Zoho stage preservation. SERVER-SIDE ONLY.
//
// The ONE engine for every path that moves a linked deal's two-way fields between HCPS (opportunities) and Zoho
// (Deals): the 15-minute zoho-autosync and the on-demand zoho-api actions (sync_opportunities / pull_deals).
//
// Two-way fields: stage, amount (HCPS value), close date. For each linked deal and EACH field independently the
// current HCPS value and the current Zoho value are compared with the LAST-SYNCHRONIZED baseline
// (zoho_deal_baseline.base — never updated_at, which any unrelated HCPS edit changes):
//   only Zoho changed  → apply that field to HCPS — ONLY when the deal has an inbound Deal event that 2F-4 marked
//                        external and pending, and only when no NEWER uncaptured Zoho change is in the state read
//                        (Zoho's Modified_Time ≤ the newest captured event's): a stale event never authorizes a later
//                        change. Otherwise the difference is reported once as drift, never applied; the event waits.
//   only HCPS changed  → push that field (and only that field) to Zoho. A TEST deal is never pushed (2F-2).
//   neither changed    → nothing.
//   both changed       → a conflict is recorded (zoho_deal_conflicts) and NEITHER side is changed. If both sides
//                        changed to the same value they simply agree again (no conflict).
// A field with no agreed baseline yet is recorded for review (no_baseline) unless both sides already agree.
//
// Stage: HCPS keeps its own five stages; Zoho's EXACT stage is kept in opportunities.zoho_stage and in the baseline.
//   · Zoho moving between stages that map to the SAME HCPS stage (Needs Analysis → Value Proposition) changes no HCPS
//     stage and is never rewritten back to HCPS's preferred Zoho stage.
//   · HCPS pushes a stage only when HCPS's own stage changed, and never when Zoho's stage already maps to it.
//   · A Zoho stage the mapping doesn't know is preserved and recorded for review (unmapped_stage): it is never
//     overwritten and HCPS's stage is not changed, until Zoho's stage is a mapped one again.
// The mapping itself (STAGE_TO_ZOHO / ZOHO_TO_STAGE) is unchanged from the original sync.
//
// HCPS-owned Deal fields (name, line → Description, account link) are one-way HCPS → Zoho, pushed when they change.
// New HCPS deals are created in Zoho exactly as before (same fields, same provisional close date when HCPS has none).

const STAGE_TO_ZOHO={identified:"Qualification",contacted:"Needs Analysis",quoted:"Proposal/Price Quote",won:"Closed Won",lost:"Closed Lost"};
const ZOHO_TO_STAGE={"Qualification":"identified","Needs Analysis":"contacted","Value Proposition":"contacted","Identify Decision Makers":"contacted","Proposal/Price Quote":"quoted","Negotiation/Review":"quoted","Closed Won":"won","Closed Lost":"lost","Closed-Lost":"lost","Closed Lost to Competition":"lost"};
const PROB={identified:0.1,contacted:0.3,quoted:0.6,won:1,lost:0};
const statusOf=s=>s==="won"?"won":s==="lost"?"lost":"open";
const FIELDS=["stage","amount","close_date"];
const ZOHO_DEAL_FIELDS="Deal_Name,Stage,Amount,Closing_Date,Description,Account_Name,Modified_Time";

const clean=v=>{ const s=(v==null?"":String(v)).trim(); return s||undefined; };
const prune=rec=>{ Object.keys(rec).forEach(k=>rec[k]===undefined&&delete rec[k]); return rec; };
const money=v=>{ if(v==null||v==="") return 0; const n=Number(v); return isFinite(n)?Math.round(n*100)/100:0; };
const day=v=>{ const s=v==null?"":String(v).slice(0,10); return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:null; };
const zStage=v=>{ const s=v==null?"":String(v).trim(); return s||null; };
const lookupId=x=>x&&typeof x==="object"?(x.id==null?null:String(x.id)):null;   // same as the 2F-4 classifier
function hashOf(obj){ const keys=Object.keys(obj).sort(); const s=keys.map(k=>k+"="+(obj[k]==null?"":String(obj[k]))).join("|");
  let h=5381; for(let i=0;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))|0; } return (h>>>0).toString(36); }
const show=v=>v==null?"(none)":String(v);

// What a Zoho Deal looks like to the 2F-4 echo classifier (zoho-autosync classifyOne uses this same function), so
// a push's fingerprint is comparable with the record Zoho holds afterwards.
function fingerprint(z, line){
  const d=prune({ Deal_Name:clean(z.Deal_Name), Amount:Number(z.Amount)||0, Stage:clean(z.Stage), Closing_Date:clean(z.Closing_Date) });
  if(line) d.Description=z.Description==null?"":String(z.Description);
  return hashOf({...d, _acct:lookupId(z.Account_Name)||"", _zid:String(z.id)});
}
// HCPS-owned Deal fields (one-way): their Zoho values and a fingerprint of them.
function ownedOf(o, acctId){ const rec={ Deal_Name:String(o.title||"Opportunity").slice(0,255) }; if(o.line) rec.Description="Line: "+o.line; if(acctId) rec.Account_Name={id:String(acctId)}; return rec; }
const ownedHash=(o, acctId)=>hashOf({ Deal_Name:String(o.title||"Opportunity").slice(0,255), Description:o.line?("Line: "+o.line):"", _acct:acctId?String(acctId):"" });

// ---- the decision for ONE field (pure) -------------------------------------------------------------------------
// → {act:"none"|"agree"|"apply"|"push"|"conflict", base?:{…new baseline keys}, kind?, hcps, zoho, baseValue, …}
function decideStage(o, z, b){
  const hs=o.stage||null, zx=zStage(z.Stage), zm=zx?(ZOHO_TO_STAGE[zx]||null):null;
  const r={field:"stage", hcps:hs, zoho:zx, baseValue:("stage" in b)?(b.stage+" / "+show(b.zoho_stage)):null};
  if(zx && !zm) return {...r, act:"conflict", kind:"unmapped_stage", preserve:zx};
  if(!("stage" in b) || !("zoho_stage" in b)) return (zm && zm===hs) ? {...r, act:"agree", base:{stage:hs, zoho_stage:zx}} : {...r, act:"conflict", kind:"no_baseline"};
  const zCh=zx!==b.zoho_stage, hCh=hs!==b.stage;
  if(!zCh && !hCh) return {...r, act:"none"};
  if(zCh && !hCh){ if(!zx) return {...r, act:"none"};   // Zoho has no stage at all: nothing to take
    return {...r, act:"apply", base:{stage:zm, zoho_stage:zx}, set:zm===hs?{zoho_stage:zx}:{stage:zm, zoho_stage:zx}}; }
  if(!zCh && hCh){ if(zm===hs) return {...r, act:"agree", base:{stage:hs, zoho_stage:zx}};
    const to=STAGE_TO_ZOHO[hs]||"Qualification"; return {...r, act:"push", base:{stage:hs, zoho_stage:to}, put:{Stage:to}}; }
  return zm===hs ? {...r, act:"agree", base:{stage:hs, zoho_stage:zx}} : {...r, act:"conflict", kind:"both_changed"};
}
function decideAmount(o, z, b){
  const h=money(o.value), zv=money(z.Amount); const r={field:"amount", hcps:h, zoho:zv, baseValue:("amount" in b)?b.amount:null};
  if(!("amount" in b)) return h===zv ? {...r, act:"agree", base:{amount:h}} : {...r, act:"conflict", kind:"no_baseline"};
  const zCh=zv!==money(b.amount), hCh=h!==money(b.amount);
  if(!zCh && !hCh) return {...r, act:"none"};
  if(zCh && !hCh) return {...r, act:"apply", base:{amount:zv}, set:{value:zv}};
  if(!zCh && hCh) return {...r, act:"push", base:{amount:h}, put:{Amount:h}};
  return h===zv ? {...r, act:"agree", base:{amount:h}} : {...r, act:"conflict", kind:"both_changed"};
}
// A blank HCPS close date is "no HCPS value": it is never pushed (Zoho requires one) and never counts as a change.
function decideClose(o, z, b){
  const h=day(o.expected_close), zv=day(z.Closing_Date); const r={field:"close_date", hcps:h, zoho:zv, baseValue:("close_date" in b)?b.close_date:null};
  if(!("close_date" in b)) return (h===zv || h===null) ? {...r, act:"agree", base:{close_date:zv}} : {...r, act:"conflict", kind:"no_baseline"};
  const zCh=zv!==null && zv!==b.close_date, hCh=h!==null && h!==b.close_date;
  if(!zCh && !hCh) return {...r, act:"none"};
  if(zCh && !hCh) return {...r, act:"apply", base:{close_date:zv}, set:{expected_close:zv}};
  if(!zCh && hCh) return {...r, act:"push", base:{close_date:h}, put:{Closing_Date:h}};
  return h===zv ? {...r, act:"agree", base:{close_date:h}} : {...r, act:"conflict", kind:"both_changed"};
}
function decideDeal(o, z, base){ const b=base||{}; return [decideStage(o,z,b), decideAmount(o,z,b), decideClose(o,z,b)]; }

// Zoho times: the webhook sends "yyyy-mm-dd HH:MM:SS" in the org's time zone (America/Chicago); the API sends ISO
// with an offset. (Phase 2F-4's echo classifier uses this same function.)
const ZOHO_TZ=process.env.ZOHO_WEBHOOK_TZ||"America/Chicago";
function tzOffsetMs(utcMs, tz){
  const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:tz,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}).formatToParts(new Date(utcMs)).map(x=>[x.type,x.value]));
  return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-utcMs;
}
function parseZohoTime(s){
  s=String(s||"").trim(); if(!s) return null;
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)){ const d=new Date(s); return isNaN(d)?null:d; }
  const m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s); if(!m) return null;
  const wall=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));
  try{ let t=wall-tzOffsetMs(wall,ZOHO_TZ); t=wall-tzOffsetMs(t,ZOHO_TZ); return new Date(t); }catch(e){ return null; }
}

const chunks=(a,n)=>{ const out=[]; for(let i=0;i<a.length;i+=n) out.push(a.slice(i,i+n)); return out; };
const inList=ids=>"("+ids.map(x=>encodeURIComponent(String(x))).join(",")+")";

/* ---- the engine ----------------------------------------------------------------------------------------------
   deps: {sbGet, sbGetAll, sbSend, zoho, fail(f), log(row)}  (fail records a failure row; log writes a zoho_sync_log row)
   ctx:  {apiDomain, token, T (TEST rule, or null = unknown → nothing pushed), acctIdByName, push, apply,
          hashes (2F-4 push fingerprints, updated for every accepted push), pushedOk(key, zohoId)} */
async function run(deps, ctx){
  const {sbGet, sbGetAll, sbSend, zoho, fail, log}=deps;
  const S={total:0, linked:0, created:0, pushed:0, applied:0, agreed:0, conflicts_open:0, conflicts_new:0, conflicts_resolved:0,
    events_processed:0, events_conflict:0, events_waiting:0, duplicate_links:0, drift:0, unlinked_events:0, missing_in_zoho:0, test_held:0, test_excluded:0, failed:0};
  const nowIso=()=>new Date().toISOString();
  const canPushRule=!!(ctx.push && ctx.T);
  const isTest=o=>!ctx.T || ctx.T.dealer(o.dealer_id);
  const f1=x=>{ S.failed++; fail(x); };

  let opps;
  try{ opps=await sbGetAll("opportunities?select=id,dealer_id,title,line,stage,value,expected_close,zoho_id,zoho_stage","id"); }
  catch(e){ f1({phase:"opps_read",entity:"opportunities",action:"read",msg:"HCPS deals couldn't be read, so no deal was pushed or updated: "+(e.message||e)}); return S; }
  S.total=opps.length;
  // The 2F-5 tables must exist before anything is created or pushed (deploy order: SQL first). Without them no deal
  // work is done at all — in particular no new deal is created in Zoho whose id/baseline then couldn't be kept.
  try{ await sbGet("zoho_deal_baseline?select=opportunity_id&limit=1"); }
  catch(e){ f1({phase:"deal_baseline_read",entity:"opportunities",action:"read",msg:"the deal sync baselines couldn't be read (has the 2F-5 migration run?), so no deal was created, pushed or updated this run: "+(e.message||e)}); return S; }
  let nameById={};
  if(ctx.push){ try{ for(const d of await sbGetAll("dealers?select=id,business_name","id")) nameById[d.id]=(clean(d.business_name)||("Dealer "+d.id)).slice(0,255); }
    catch(e){ f1({phase:"opps_read",entity:"dealers",action:"read",msg:"dealer names couldn't be read, so no deal was pushed: "+(e.message||e)}); ctx={...ctx, push:false}; } }
  const acctFor=o=>o.dealer_id?(ctx.acctIdByName||{})[nameById[o.dealer_id]]||null:null;
  const canPush=o=>ctx.push && canPushRule && !isTest(o);

  // ---- new HCPS deals → created in Zoho, exactly as before (TEST deals never) ----
  if(ctx.push) for(const o of opps.filter(x=>!x.zoho_id)){
    if(!canPushRule) continue;
    if(isTest(o)){ S.test_excluded++; continue; }
    const today=nowIso().slice(0,10), acctId=acctFor(o);
    const stage=STAGE_TO_ZOHO[o.stage]||"Qualification", close=day(o.expected_close)||today;
    const rec={ Deal_Name:String(o.title||"Opportunity").slice(0,255), Amount:money(o.value), Stage:stage, Closing_Date:close };
    if(o.line) rec.Description="Line: "+o.line; if(acctId) rec.Account_Name={id:acctId};
    const r=await zoho("POST",ctx.apiDomain,ctx.token,"/crm/v8/Deals",{data:[rec]});
    const row=r.ok&&r.json&&Array.isArray(r.json.data)&&r.json.data[0];
    if(!(row&&row.code==="SUCCESS")){ f1({phase:"opps",entity:"opportunity",entity_id:o.id,dealer_id:o.dealer_id,action:"push",msg:(row&&row.code?row.code+": "+(row.message||""):"http "+r.status),extra:{zoho:r.json||null}}); continue; }
    const id=row.details&&row.details.id;
    if(!id){ f1({phase:"opps_zoho_id",entity:"opportunity",entity_id:o.id,dealer_id:o.dealer_id,action:"push",msg:"Zoho created the deal but returned no id"}); continue; }
    S.created++;
    // HCPS keeps what it had; a blank close date gets the date Zoho was given (the existing provisional behaviour).
    // The Zoho id is saved on its own first (as before), so nothing else can make the next run create it again.
    const back={zoho_id:id}; if(!day(o.expected_close)) back.expected_close=close;
    try{ await sbSend("PATCH",`opportunities?id=eq.${encodeURIComponent(o.id)}`,back,{Prefer:"return=minimal"}); }
    catch(e){ f1({phase:"opps_zoho_id",entity:"opportunity",entity_id:o.id,dealer_id:o.dealer_id,zoho_id:id,action:"write",msg:"the new Zoho Deal id wasn't saved on the HCPS deal — the next run would create the deal in Zoho again: "+(e.message||e)}); continue; }
    try{ await sbSend("PATCH",`opportunities?id=eq.${encodeURIComponent(o.id)}`,{zoho_stage:stage},{Prefer:"return=minimal"}); }
    catch(e){ f1({phase:"deal_zoho_stage",entity:"opportunity",entity_id:o.id,dealer_id:o.dealer_id,zoho_id:id,direction:"in",action:"write",msg:"Zoho's exact stage couldn't be recorded on the new HCPS deal (zoho_stage; set on a later run): "+(e.message||e)}); }
    const base={stage:o.stage, zoho_stage:stage, amount:money(o.value), close_date:close};
    try{ await sbSend("POST","zoho_deal_baseline?on_conflict=opportunity_id",{opportunity_id:o.id, zoho_id:String(id), base, owned_hash:ownedHash(o,acctId), drift:null, synced_at:nowIso(), updated_at:nowIso()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
    catch(e){ f1({phase:"deal_baseline_write",entity:"opportunity",entity_id:o.id,dealer_id:o.dealer_id,zoho_id:id,action:"write",msg:"the new deal's sync baseline wasn't saved; its fields will be reviewed, not guessed: "+(e.message||e)}); }
    if(ctx.hashes) ctx.hashes["opp:"+o.id]=fingerprint({...rec, id}, o.line);
    if(ctx.pushedOk) ctx.pushedOk("opp:"+o.id, id);
  }

  // ---- linked deals ----
  const linked=opps.filter(o=>o.zoho_id); S.linked=linked.length;
  if(!linked.length) return S;
  const ids=linked.map(o=>o.id), zids=[...new Set(linked.map(o=>String(o.zoho_id)))];
  const bases={}, open={}; let events=[];
  try{
    for(const c of chunks(ids,100)){
      for(const b of await sbGet(`zoho_deal_baseline?select=opportunity_id,zoho_id,base,owned_hash,drift&opportunity_id=in.${inList(c)}`)) bases[b.opportunity_id]=b;
      for(const x of await sbGet(`zoho_deal_conflicts?select=id,opportunity_id,field,kind,hcps_value,zoho_value&status=eq.open&opportunity_id=in.${inList(c)}`)) open[x.opportunity_id+"|"+x.field]=x;
    }
  }catch(e){ f1({phase:"deal_baseline_read",entity:"opportunities",action:"read",msg:"the deal sync baselines couldn't be read, so no linked deal was pushed or updated this run (nothing is guessed): "+(e.message||e)}); return S; }
  if(ctx.apply){
    try{ for(const c of chunks(zids,100)) events=events.concat(await sbGet(`zoho_sync_queue?select=id,zoho_id&direction=eq.in&entity=eq.deals&status=eq.pending&classification=eq.external&zoho_id=in.${inList(c)}&order=id.asc&limit=1000`)); }
    catch(e){ events=[]; f1({phase:"deal_events_read",entity:"queue",direction:"in",action:"read",msg:"pending Deal events couldn't be read, so no Zoho change was applied this run: "+(e.message||e)}); }
    try{ const all=await sbGet("zoho_sync_queue?select=zoho_id&direction=eq.in&entity=eq.deals&status=eq.pending&classification=eq.external&limit=5000");
      const set=new Set(zids); S.unlinked_events=(all||[]).filter(x=>!set.has(String(x.zoho_id))).length; }catch(e){}
  }
  const evBy={}; for(const e of events){ (evBy[String(e.zoho_id)]=evBy[String(e.zoho_id)]||[]).push(e.id); }
  // The newest Modified_Time any captured Deal event (whatever became of it — applied, echo, conflict …) carries, per
  // Zoho deal. A pending event authorizes ONLY the Zoho state it (or a later captured event) saw: if Zoho's current
  // Modified_Time is newer, the state includes a change no webhook delivered, and nothing is taken from it.
  const lastCaptured={}; let capturedOk=true;
  if(ctx.apply && events.length){
    try{ for(const c of chunks([...new Set(events.map(e=>String(e.zoho_id)))],100))
        for(const x of await sbGet(`zoho_sync_queue?select=zoho_id,modified_time&direction=eq.in&entity=eq.deals&zoho_id=in.${inList(c)}&order=id.desc&limit=5000`)){
          const t=parseZohoTime(x.modified_time); if(t && (lastCaptured[String(x.zoho_id)]==null || t.getTime()>lastCaptured[String(x.zoho_id)])) lastCaptured[String(x.zoho_id)]=t.getTime(); } }
    catch(e){ capturedOk=false; f1({phase:"deal_events_read",entity:"queue",direction:"in",action:"read",msg:"the captured Deal events' times couldn't be read, so no Zoho change was applied this run: "+(e.message||e)}); }
  }
  // One Zoho deal must never belong to more than one HCPS deal: such deals are not synchronized at all.
  const perZid={}; for(const o of linked) perZid[String(o.zoho_id)]=(perZid[String(o.zoho_id)]||0)+1;
  // Zoho's CURRENT values, read by id. If Zoho can't be read, no linked deal is decided this run (fail closed).
  const zrec={};
  for(const c of chunks(zids,100)){
    const r=await zoho("GET",ctx.apiDomain,ctx.token,`/crm/v8/Deals?ids=${c.map(encodeURIComponent).join(",")}&fields=${ZOHO_DEAL_FIELDS}`);
    if(r.status===204) continue;
    if(!r.ok || !r.json || !Array.isArray(r.json.data)){
      f1({phase:"deals_read",entity:"deals",action:"read",msg:"Zoho Deals couldn't be read, so no linked deal was pushed or updated this run: "+((r.json&&(r.json.code||r.json.message))?[r.json.code,r.json.message].filter(Boolean).join(": "):"http "+r.status),extra:{status:r.status,records:c.length}});
      return S; }
    for(const z of r.json.data) zrec[String(z.id)]=z;
  }

  for(const o of linked){
    const z=zrec[String(o.zoho_id)], b=bases[o.id]||null, base=(b&&b.base&&typeof b.base==="object")?b.base:{};
    const evIds=evBy[String(o.zoho_id)]||[], hasEvent=evIds.length>0, key="opp:"+o.id, ref={entity:"opportunity",entity_id:o.id,dealer_id:o.dealer_id,zoho_id:o.zoho_id};
    if(ctx.push && ctx.T && isTest(o)) S.test_excluded++;   // a TEST deal is never pushed (it is still kept in step FROM Zoho)
    if(perZid[String(o.zoho_id)]>1){ S.duplicate_links++;
      f1({phase:"deal_link_duplicate",...ref,action:"read",msg:"Zoho deal "+o.zoho_id+" is linked to "+perZid[String(o.zoho_id)]+" HCPS deals, so none of them is synchronized (nothing pushed or applied) until one link is removed"});
      continue; }
    if(!z){ S.missing_in_zoho++;
      if(!b || b.drift!=="missing_in_zoho"){ await log({direction:"in",...ref,action:"drift",result:"ok",detail:JSON.stringify({note:"the linked Zoho deal wasn't found (deleted or merged in Zoho?); nothing was changed"})});
        await saveBase(o, b, base, {drift:"missing_in_zoho"}); }
      continue; }
    const dec=decideDeal(o, z, base);
    // An event authorizes the Zoho state only if no newer, uncaptured Zoho change is in it (see lastCaptured).
    const zMod=parseZohoTime(z.Modified_Time), last=lastCaptured[String(o.zoho_id)];
    const authorized=hasEvent && capturedOk && !!zMod && last!=null && zMod.getTime()<=last;
    const unconfirmed=hasEvent && !authorized;
    const patch={}, put={}, newBase={...base}; const applied=[], pushed=[], held=[], drifted=[];
    let zohoStage=null;   // what opportunities.zoho_stage should become (null = leave)
    for(const d of dec){
      if(d.act==="agree"){ Object.assign(newBase,d.base); if(d.field==="stage") zohoStage=d.base.zoho_stage; }
      else if(d.act==="apply"){
        if(ctx.apply && authorized){ Object.assign(patch,d.set); applied.push(d); }
        else if(ctx.apply){ drifted.push(d); } }
      else if(d.act==="push"){
        if(canPush(o)){ Object.assign(put,d.put); pushed.push(d); }
        else if(ctx.push && ctx.T){ held.push(d); } }
      else if(d.act==="conflict" && d.kind==="unmapped_stage" && ctx.apply && authorized) zohoStage=d.preserve;   // preserved, never overwritten
    }
    if(patch.stage){ patch.status=statusOf(patch.stage); patch.probability=PROB[patch.stage]; }
    if(zohoStage!=null && zohoStage!==o.zoho_stage && patch.zoho_stage===undefined) patch.zoho_stage=zohoStage;
    // HCPS-owned fields (one-way): pushed when they changed since last synchronized. At first sight the current
    // values are taken as synchronized (the old sync kept them in step), so deploying 2F-5 pushes nothing by itself.
    let ownedNew=b?b.owned_hash:null; const acctId=canPush(o)?acctFor(o):null;
    if(canPush(o)){ const oh=ownedHash(o,acctId);
      if(!ownedNew) ownedNew=oh;
      else if(ownedNew!==oh){ Object.assign(put, ownedOf(o,acctId)); pushed.push({field:"owned", owned:oh}); } }
    if(held.length) S.test_held+=held.length;

    // 1) Zoho → HCPS (only with an event). The PATCH carries no Pipeline context (history records it as unknown).
    let applyOk=true; const realPatch=Object.keys(patch).filter(k=>k!=="zoho_stage").length>0;
    if(Object.keys(patch).length){
      if(realPatch) patch.updated_at=nowIso();
      try{ await sbSend("PATCH",`opportunities?id=eq.${encodeURIComponent(o.id)}`,patch,{Prefer:"return=minimal"}); }
      catch(e){ applyOk=false; f1(realPatch ? {phase:"pull_deals",...ref,direction:"in",action:"pull",msg:"a Zoho change couldn't be saved on the HCPS deal (it is tried again next run): "+(e.message||e),extra:{fields:Object.keys(patch)}}
          : {phase:"deal_zoho_stage",...ref,direction:"in",action:"write",msg:"Zoho's exact stage couldn't be recorded on the HCPS deal (zoho_stage; tried again next run): "+(e.message||e)}); }
    }
    if(applyOk && applied.length){ S.applied++; for(const d of applied) Object.assign(newBase,d.base);
      if(applied.some(d=>Object.keys(d.set).some(k=>k!=="zoho_stage"))) await log({direction:"in",...ref,action:"deal_apply",result:"ok",detail:JSON.stringify({fields:applied.map(d=>({field:d.field, from:d.hcps, to:d.field==="stage"?(d.set.stage||d.hcps):d.zoho, zoho:d.zoho}))})}); }
    // 2) HCPS → Zoho: only the fields HCPS changed (+ owned fields), never the others.
    let pushOk=true;
    if(Object.keys(put).length){
      const r=await zoho("PUT",ctx.apiDomain,ctx.token,"/crm/v8/Deals",{data:[{id:o.zoho_id,...put}]});
      const row=r.ok&&r.json&&Array.isArray(r.json.data)&&r.json.data[0];
      if(row&&row.code==="SUCCESS"){ S.pushed++;
        for(const d of pushed){ if(d.field==="owned") ownedNew=d.owned; else Object.assign(newBase,d.base); }
        if(ctx.hashes) ctx.hashes[key]=fingerprint({...z, ...put, id:o.zoho_id}, o.line);
        if(ctx.pushedOk) ctx.pushedOk(key, o.zoho_id);
        await log({direction:"out",...ref,action:"deal_push",result:"ok",detail:JSON.stringify({fields:Object.keys(put)})});
        if(put.Stage && put.Stage!==o.zoho_stage){ try{ await sbSend("PATCH",`opportunities?id=eq.${encodeURIComponent(o.id)}`,{zoho_stage:put.Stage},{Prefer:"return=minimal"}); }
          catch(e){ f1({phase:"opps",...ref,action:"write",msg:"the stage pushed to Zoho wasn't recorded on the HCPS deal (zoho_stage): "+(e.message||e)}); } }
      } else { pushOk=false; f1({phase:"opps",...ref,action:"push",msg:(row&&row.code?row.code+": "+(row.message||""):"http "+r.status),extra:{zoho:r.json||null,fields:Object.keys(put)}}); }
    }
    // 3) Conflicts / review conditions: one open record per field; resolved (kept) when both sides agree again.
    const conflictNow={};
    for(const d of dec) if(d.act==="conflict") conflictNow[d.field]=d;
    for(const fld of FIELDS){
      const cur=open[o.id+"|"+fld], d=conflictNow[fld];
      if(d){ const hv=show(d.hcps), zv=show(d.zoho);
        if(!cur){
          try{ await sbSend("POST","zoho_deal_conflicts",{opportunity_id:o.id, zoho_id:String(o.zoho_id), field:fld, kind:d.kind, base_value:d.baseValue==null?null:String(d.baseValue), hcps_value:hv, zoho_value:zv, status:"open", detected_at:nowIso(), updated_at:nowIso()},{Prefer:"return=minimal"});
            S.conflicts_new++; await log({direction:"in",...ref,action:"conflict",result:"conflict",detail:JSON.stringify({field:fld, kind:d.kind, base:d.baseValue, hcps:d.hcps, zoho:d.zoho, note:"neither side was changed"})}); }
          catch(e){ if(!/23505|duplicate/i.test(String(e.message||e))) f1({phase:"deal_conflict",...ref,action:"write",msg:"a deal conflict couldn't be recorded (neither side was changed): "+(e.message||e),extra:{field:fld,kind:d.kind}}); }
        } else if(cur.hcps_value!==hv || cur.zoho_value!==zv || cur.kind!==d.kind){
          try{ await sbSend("PATCH",`zoho_deal_conflicts?id=eq.${encodeURIComponent(cur.id)}&status=eq.open`,{kind:d.kind, hcps_value:hv, zoho_value:zv, updated_at:nowIso()},{Prefer:"return=minimal"}); }
          catch(e){ f1({phase:"deal_conflict",...ref,action:"write",msg:"a deal conflict's current values couldn't be updated: "+(e.message||e),extra:{field:fld}}); }
        }
        S.conflicts_open++;
      } else if(cur){
        const dd=dec.find(x=>x.field===fld);
        const settled=dd && (dd.act==="agree" || dd.act==="none" || (dd.act==="apply" && applyOk && applied.includes(dd)) || (dd.act==="push" && pushOk && pushed.includes(dd)));
        if(settled){ try{ await sbSend("PATCH",`zoho_deal_conflicts?id=eq.${encodeURIComponent(cur.id)}&status=eq.open`,{status:"resolved", resolved_at:nowIso(), updated_at:nowIso(),
              resolution:(dd.act==="agree"?"both sides agree again":dd.act==="none"?"no longer differs from the baseline":dd.act==="apply"?"the Zoho change was applied":"the HCPS change was pushed")},{Prefer:"return=minimal"});
            S.conflicts_resolved++; await log({direction:"in",...ref,action:"conflict_resolved",result:"ok",detail:JSON.stringify({field:fld, hcps:dd.hcps, zoho:dd.zoho})}); }
          catch(e){ f1({phase:"deal_conflict",...ref,action:"write",msg:"a resolved deal conflict couldn't be closed: "+(e.message||e),extra:{field:fld}}); } }
        else S.conflicts_open++;
      }
    }
    // 4) Drift: a Zoho change no captured event covers is reported once (never applied). With a pending event that
    // is older than Zoho's current state, the event stays pending until the newer change's own webhook arrives.
    const sig=(drifted.length||unconfirmed)?((unconfirmed?"unconfirmed@"+(z.Modified_Time||"?")+";":"")+drifted.map(d=>d.field+"="+show(d.zoho)).join(";")):null;
    if(sig){ S.drift++; if(unconfirmed) S.events_waiting+=evIds.length;
      if(!b || b.drift!==sig) await log({direction:"in",...ref,action:"drift",result:"ok",detail:JSON.stringify(unconfirmed
        ? {note:"Zoho changed again after the last captured Deal event — nothing is taken from that newer state; the event stays pending until the newer change's own webhook arrives",
           zoho_modified:z.Modified_Time||null, last_captured:last!=null?new Date(last).toISOString():null, fields:drifted.map(d=>({field:d.field, hcps:d.hcps, zoho:d.zoho, base:d.baseValue}))}
        : {note:"Zoho changed without a webhook event — not applied; it will be applied when an event arrives",fields:drifted.map(d=>({field:d.field, hcps:d.hcps, zoho:d.zoho, base:d.baseValue}))})}); }
    // 5) The baseline moves only for fields that were agreed, applied or pushed successfully.
    if(dec.some(d=>d.act==="agree")) S.agreed++;
    await saveBase(o, b, newBase, {owned_hash:ownedNew, drift:sig});
    // 6) This deal's pending events: processed, with what happened (left pending when the HCPS write failed).
    if(authorized && applyOk){
      const anyConflict=FIELDS.some(fld=>conflictNow[fld]);
      const parts=[]; for(const d of dec){
        if(d.act==="apply" && applied.includes(d)) parts.push(d.field==="stage"?("stage "+(d.set.stage?("→ "+d.set.stage+" (Zoho: "+d.zoho+")"):("kept "+d.hcps+" (Zoho: "+d.zoho+")"))):(d.field+" "+show(d.hcps)+" → "+show(d.zoho)));
        else if(d.act==="conflict") parts.push(d.field+" "+(d.kind==="unmapped_stage"?("unmapped Zoho stage \""+d.zoho+"\" kept for review"):d.kind==="no_baseline"?"has no agreed value yet (review)":"changed on both sides — conflict, neither side changed"));
      }
      const outcome=(parts.length?parts.join("; "):"no change to a shared field (stage, amount, close date)").slice(0,1000);
      try{ await sbSend("PATCH",`zoho_sync_queue?id=in.(${evIds.map(encodeURIComponent).join(",")})&status=eq.pending`,{status:anyConflict?"conflict":"synced", outcome, processed_at:nowIso(), updated_at:nowIso()},{Prefer:"return=minimal"});
        S.events_processed+=evIds.length; if(anyConflict) S.events_conflict+=evIds.length; }
      catch(e){ f1({phase:"deal_events",...ref,direction:"in",action:"write",msg:"the Deal events were processed but not marked; they are processed again next run (no second write: the baseline already moved): "+(e.message||e)}); }
    }
  }
  return S;

  async function saveBase(o, b, base, extra){
    const row={opportunity_id:o.id, zoho_id:String(o.zoho_id), base, owned_hash:extra.owned_hash!==undefined?extra.owned_hash:(b?b.owned_hash:null),
      drift:extra.drift!==undefined?extra.drift:(b?b.drift:null)};
    if(b && JSON.stringify(sortObj(b.base||{}))===JSON.stringify(sortObj(base)) && (b.owned_hash||null)===(row.owned_hash||null) && (b.drift||null)===(row.drift||null) && String(b.zoho_id)===row.zoho_id) return;
    try{ await sbSend("POST","zoho_deal_baseline?on_conflict=opportunity_id",{...row, synced_at:nowIso(), updated_at:nowIso()},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
    catch(e){ f1({phase:"deal_baseline_write",entity:"opportunity",entity_id:o.id,dealer_id:o.dealer_id,zoho_id:o.zoho_id,action:"write",msg:"the deal sync baseline wasn't saved; the next run compares against the previous one (no change is lost or doubled): "+(e.message||e)}); }
  }
}
const sortObj=o=>Object.fromEntries(Object.keys(o).sort().map(k=>[k,o[k]]));

module.exports={ run, decideDeal, decideStage, decideAmount, decideClose, fingerprint, parseZohoTime, STAGE_TO_ZOHO, ZOHO_TO_STAGE, ZOHO_DEAL_FIELDS };

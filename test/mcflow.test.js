/* Manufacturer Center Phase 6 — the guided workflow, end to end, on a COPY of Bemis (the dry walkthrough the
   implementation plan requires). Everything runs through the real catalog-api in the in-memory database
   (phase0-mock): nothing touches the live database, and the real Bemis line is never involved.

   The sandbox holds two lines:
     bemis-copy — a brand-new line built from a copy of Bemis's data (test/fixtures/bemis-copy.json): the
                  price list rows as received, the custom product and override layer, and the storefront's own
                  catalog file. It starts with no source, no decisions, no master record and no authority.
     bemis      — a frozen line shaped like the real one (record-authoritative, freight traced). It must refuse
                  every workflow write and come out byte-identical.

   Walkthrough: register source → accept → import rows as received → match → decisions → freight terms
   (dry run, Approval 1, write) → stage (dry run, Approval 1, write) → structure & commercial status →
   pre-activation verification → Approval 2 → activation dry run → activate → post-activation verification.
   The copy must end with the SAME fingerprint as the real Bemis line (3620a321933995db): the workflow rebuilds
   the Gold Standard exactly. Every gate and write protection is also attacked on the way. */
const path=require('path'), fs=require('fs');
const {M,fx,COPY,REAL,PACKS,world,mod,call,clone}=require('./mcflow.world.js');
let fail=0, pass=0; const LOG=[];
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };

const step=async(C,label,b)=>{ const r=await call(C,b); LOG.push({step:label, action:b.action, dry_run:b.dry_run===true, status:r.status, error:r.body&&r.body.error||null, summary:summarize(b.action,r.body)}); return r; };
function summarize(action,j){ if(!j) return null; const s={};
  ['plan_hash','plan_kind','imported','would_insert','staged','approval_used','result','fingerprint','run_id','authoritative','message'].forEach(k=>{ if(j[k]!=null) s[k]=Array.isArray(j[k])?j[k].length:j[k]; });
  if(j.summary) s.match=j.summary; if(j.approval) s.approval={id:j.approval.id,field:j.approval.field}; if(j.decision) s.decision={id:j.decision.id,code:j.decision.code,field:j.decision.field,hcps_value:j.decision.hcps_value};
  if(j.source) s.source={id:j.source.id,status:j.source.status,sha256:j.source.file_sha256&&j.source.file_sha256.slice(0,12)};
  if(j.failed) s.failed=j.failed; return s; }
const realSnapshot=W=>JSON.stringify({meta:W.db.manufacturer_meta.filter(m=>m.slug===REAL), skus:W.db.product_skus.filter(r=>r.manufacturer===REAL).map(({code_norm,...x})=>x),
  custom:W.db.custom_products.filter(r=>r.manufacturer===REAL), ov:W.db.product_overrides.filter(r=>r.manufacturer===REAL),
  src:W.db.mfr_sources.filter(r=>r.manufacturer===REAL), dec:W.db.mfr_decisions.filter(r=>r.manufacturer===REAL), imp:(W.db.price_imports||[]).filter(r=>r.manufacturer===REAL)});
const csv=fx.source.rows.map(r=>[r.code,r.base_price,r.msrp,r.map,r.unit_cost,r.case_qty_text||''].join(',')).join('\n');

(async()=>{
const W=world(), C=mod(W), REAL_BEFORE=realSnapshot(W);
let srcId, freightDecision, stageDry, stageApproval, preRun, actApproval;

await t('1 · register the source: the dry run writes nothing; the write stores the file privately with its SHA-256, status "received"',async()=>{
  const body={action:'mc_register_source',manufacturer:COPY,kind:'price_list',title:fx.source.title,received_date:fx.source.received_date,effective_date_status:'pending',
    file_name:'bemis-price-list-2026.csv',content_type:'text/csv',file_b64:Buffer.from('code,base_price,msrp,map,unit_cost,case_qty\n'+csv).toString('base64'),note:'Walkthrough copy of the Bemis list'};
  const n=W.writes.length; const d=await step(C,'register source (dry run)',Object.assign({},body,{dry_run:true}));
  eq([d.status,W.writes.length,W.stored.length],[200,n,0],'dry run wrote nothing'); eq(d.body.would_insert.status,'received');
  const r=await step(C,'register source',body); eq(r.status,200,JSON.stringify(r.body)); srcId=r.body.source.id;
  ok(/^[0-9a-f]{64}$/.test(r.body.source.file_sha256),'sha256'); eq([W.stored.length,W.stored[0].upsert],[1,'false'],'stored once, never overwritten');
  ok(W.stored[0].path.startsWith(COPY+'/'+r.body.source.file_sha256+'/'),'stored under line/sha');
  const nodate=await call(C,Object.assign({},body,{received_date:''})); eq([nodate.status],[400],'a received date is never invented');
});
await t('1 · accept the source (dry run, then write) — the acceptance is a recorded decision; a second acceptance is refused',async()=>{
  const d=await step(C,'accept source (dry run)',{action:'mc_accept_source',manufacturer:COPY,source_id:srcId,reason:'Checked against the PDF; all 9 SKUs present',dry_run:true});
  eq([d.status,W.db.mfr_sources.find(s=>s.id===srcId).status],[200,'received']);
  const r=await step(C,'accept source',{action:'mc_accept_source',manufacturer:COPY,source_id:srcId,reason:'Checked against the PDF; all 9 SKUs present'});
  eq([r.status,W.db.mfr_sources.find(s=>s.id===srcId).status,r.body.decision.kind],[200,'accepted','acceptance']);
  const again=await call(C,{action:'mc_accept_source',manufacturer:COPY,source_id:srcId,reason:'again'}); eq(again.status,409);
});
await t('1 · import the rows exactly as received (dry run, then write); "2/CS" parsed to 2 beside the raw text; never imported twice',async()=>{
  const rows=fx.source.rows.map(r=>({code:r.code,description:r.description,base_price:r.base_price,msrp:r.msrp,map:r.map,unit_cost:r.unit_cost,case_qty_text:r.case_qty_text,raw:r.raw}));
  const d=await step(C,'import rows (dry run)',{action:'mc_import_source_rows',manufacturer:COPY,source_id:srcId,rows,dry_run:true});
  eq([d.status,d.body.would_insert,(W.db.price_imports||[]).length],[200,9,0]);
  const r=await step(C,'import rows',{action:'mc_import_source_rows',manufacturer:COPY,source_id:srcId,rows}); eq([r.status,r.body.imported],[200,9]);
  const row=W.db.price_imports.find(x=>x.code==='7YR05310TSS'); eq([row.parsed_case_qty,row.raw['Master Case Qty'],row.parsed_unit_cost,row.raw['Dealer Cost Per Unit']],[2,'2/CS',64.99,64.99]);
  eq(W.db.price_imports.find(x=>x.code==='7YE82350TC').parsed_case_qty,null,'no case qty given → none parsed (a decision is needed)');
  const twice=await call(C,{action:'mc_import_source_rows',manufacturer:COPY,source_id:srcId,rows}); eq([twice.status,twice.body.error],[409,'already_imported']);
});
await t('2 · match: 9 new SKUs; every one waits for a decision (7 packs have no order-unit name, Steadfast and the display have no unit at all)',async()=>{
  const r=await step(C,'match (before decisions)',{action:'mc_match',manufacturer:COPY}); eq(r.status,200,JSON.stringify(r.body).slice(0,300));
  eq([r.body.source.id,r.body.summary.new,r.body.summary.needs_decision,r.body.summary.ready_to_stage],[srcId,9,9,0]);
  const need=c=>r.body.rows.find(x=>x.code===c).needs_decision.map(n=>n.field);
  eq([need('7YR05310TSS'),need('7YE82350TC'),need('444DISPLAY')],[['uom'],['uom'],['uom']]);
  ok(r.body.rows.every(x=>x.source&&x.record===null),'source facts shown, no record yet');
});
await t('2 · decide (dry run, then write): packs = "Case" with MSRP/MAP each; Steadfast = Each/1; display = Display/1 — source facts untouched',async()=>{
  const factsBefore=JSON.stringify(W.db.price_imports);
  const D=[{field:'uom',code:null,hcps_value:{uom:'Case',msrp_basis:'each',map_basis:'each',applies_to:'packs'},reason:'Bemis quotes dealer price per master case and MSRP/MAP per piece'},
           {field:'uom',code:'7YE82350TC',hcps_value:{uom:'Each',case_qty:1},reason:'No master case quantity: Steadfast is sold singly'},
           {field:'uom',code:'444DISPLAY',hcps_value:{uom:'Display',case_qty:1},reason:'One floor display program per order'}];
  for(const d of D){
    const body=Object.assign({action:'mc_record_decision',manufacturer:COPY,kind:'interpretation',source_id:srcId},d);
    const dry=await step(C,'decision '+(d.code||'packs')+' (dry run)',Object.assign({},body,{dry_run:true})); eq(dry.status,200,JSON.stringify(dry.body));
    const r=await step(C,'decision '+(d.code||'packs'),body); eq(r.status,200,JSON.stringify(r.body));
  }
  eq(JSON.stringify(W.db.price_imports),factsBefore,'the manufacturer facts are never changed by a decision');
  const forged=await call(C,{action:'mc_record_decision',manufacturer:COPY,kind:'acceptance',field:'gate:stage',reason:'forged',hcps_value:{plan_hash:'0'.repeat(64),plan_kind:'records'}});
  eq([forged.status,forged.body.error],[400,'gate_not_here'],'an approval cannot be forged as an ordinary decision');
});
await t('2 · match again: all 9 ready to stage, proposed rows = source facts + decisions',async()=>{
  const r=await step(C,'match (after decisions)',{action:'mc_match',manufacturer:COPY});
  eq([r.body.summary.needs_decision,r.body.summary.ready_to_stage],[0,9]);
  const p=c=>r.body.stage_rows.find(x=>x.code===c);
  eq([p('7YR05310TSS').uom,p('7YR05310TSS').case_qty,p('7YR05310TSS').msrp_basis,p('7YR05310TSS').base_price],['Case',2,'each',109.98]);
  eq([p('7YE82350TC').uom,p('7YE82350TC').case_qty,p('7YE82350TC').msrp_basis],['Each',1,undefined]);
  eq([p('444DISPLAY').uom,p('444DISPLAY').map],['Display',1269.72]);
});
await t('4 · freight terms: dry run prices every threshold before and after; a write without Approval 1, with a stale approval or twice is refused',async()=>{
  const dec=await step(C,'freight decision',{action:'mc_record_decision',manufacturer:COPY,kind:'freight_terms',field:'freight',source_id:srcId,reason:'Bemis terms: $500 prepaid, $40 S&H below',
    hcps_value:{freeAt:500,flatUnder:40,freeLabel:'Prepaid freight',flatLabel:'shipping & handling'}}); freightDecision=dec.body.decision.id;
  const body={action:'mc_set_freight_terms',manufacturer:COPY,terms:clone(fx.freight),trace:{source_id:srcId,decision_id:freightDecision}};
  const bad=await call(C,Object.assign({},body,{terms:{groups:'all'},dry_run:true})); eq([bad.status,bad.body.error],[400,'terms_invalid']);
  const untraced=await call(C,Object.assign({},body,{trace:{},dry_run:true})); eq([untraced.status,untraced.body.error],[400,'trace_required']);
  const dry=await step(C,'freight terms (dry run)',Object.assign({},body,{dry_run:true})); eq([dry.status,dry.body.plan_kind],[200,'freight'],JSON.stringify(dry.body).slice(0,300));
  eq(dry.body.preview.before.source,'none','a new line had no freight rule');
  eq(dry.body.preview.after.boundaries.map(x=>[x.amount,x.fee]),[[499.99,40],[500,0],[500.01,0]]);
  ok(/\$40\.00 shipping & handling/.test(dry.body.preview.after.boundaries[0].words)&&/Prepaid freight/.test(dry.body.preview.after.boundaries[1].words),'words');
  const no=await call(C,body); eq([no.status,no.body.error,W.db.manufacturer_meta.find(m=>m.slug===COPY).freight_terms],[409,'approval_required',null]);
  const wrong=await call(C,{action:'mc_approve_gate',manufacturer:COPY,gate:'stage',plan_hash:'a'.repeat(64),plan_kind:'freight',reason:'approve something else'});
  const stale=await call(C,Object.assign({},body,{approval_decision_id:wrong.body.approval.id})); eq([stale.status,stale.body.error],[409,'approval_invalid'],'approval of another plan');
  const ap=await step(C,'Approval 1 (freight)',{action:'mc_approve_gate',manufacturer:COPY,gate:'stage',plan_hash:dry.body.plan_hash,plan_kind:'freight',reason:'Matches the Bemis terms of agreement'});
  const r=await step(C,'freight terms (write)',Object.assign({},body,{approval_decision_id:ap.body.approval.id})); eq([r.status,r.body.approval_used],[200,ap.body.approval.id]);
  eq(W.db.manufacturer_meta.find(m=>m.slug===COPY).freight_terms.trace,{source_id:srcId,decision_id:freightDecision});
  const twice=await call(C,Object.assign({},body,{approval_decision_id:ap.body.approval.id})); eq([twice.status,twice.body.error],[409,'approval_invalid'],'single use');
});
await t('5 · stage: dry run; no write without Approval 1; an approval does not cover a changed plan; the approved write lands on the record only',async()=>{
  const m=(await call(C,{action:'mc_match',manufacturer:COPY})).body;
  const body={action:'stage_record_source',manufacturer:COPY,source_id:srcId,rows:m.stage_rows};
  stageDry=await step(C,'stage (dry run)',Object.assign({},body,{dry_run:true})); eq([stageDry.status,stageDry.body.plan.length,stageDry.body.plan.every(p=>p.action==='create')],[200,9,true]);
  eq(W.db.product_skus.filter(r=>r.manufacturer===COPY).length,0,'dry run wrote nothing');
  const no=await step(C,'stage without approval',body); eq([no.status,no.body.error],[409,'approval_required']);
  stageApproval=(await step(C,'Approval 1 (staging)',{action:'mc_approve_gate',manufacturer:COPY,gate:'stage',plan_hash:stageDry.body.plan_hash,plan_kind:'records',reason:'All 9 SKUs as decided'})).body.approval;
  const tampered=clone(body); tampered.rows.find(x=>x.code==='7YA0AS100').base_price=89.98;
  const t1=await step(C,'stage a changed plan with that approval',Object.assign({},tampered,{approval_decision_id:stageApproval.id})); eq([t1.status,t1.body.error],[409,'approval_invalid']);
  const freightAp=W.db.mfr_decisions.find(d=>d.field==='gate:stage'&&d.hcps_value.plan_kind==='freight'&&d.used_at);
  const t2=await call(C,Object.assign({},body,{approval_decision_id:freightAp.id})); eq(t2.status,409,'a freight approval cannot stage records');
  const ov=JSON.stringify(W.db.product_overrides), cu=JSON.stringify(W.db.custom_products);
  const r=await step(C,'stage (write)',Object.assign({},body,{approval_decision_id:stageApproval.id})); eq([r.status,r.body.staged.length,r.body.approval_used],[200,9,stageApproval.id]);
  eq([JSON.stringify(W.db.product_overrides),JSON.stringify(W.db.custom_products)],[ov,cu],'layers untouched');
  eq(W.db.manufacturer_meta.find(x=>x.slug===COPY).record_authoritative,false,'staging never activates');
  const again=await call(C,Object.assign({},body,{approval_decision_id:stageApproval.id})); eq([again.status,again.body.error],[409,'approval_invalid'],'single use');
});
await t('3 · structure & content and 4 · commercial read the line without writing; freight comes from the record',async()=>{
  const n=W.writes.length;
  const s=await step(C,'structure & content',{action:'mc_structure',manufacturer:COPY}); eq(s.status,200,JSON.stringify(s.body).slice(0,300)); ok(s.body.links.structure_map.includes('manufacturer='+COPY),'links');
  const c=await step(C,'commercial & freight',{action:'mc_commercial',manufacturer:COPY}); eq([c.status,c.body.records.length,c.body.freight.source],[200,9,'record']);
  eq(W.writes.length,n,'reads wrote nothing');
});
await t('6 · Approval 2 needs a passing pre-activation run; activation without it, or after the record changed, is refused',async()=>{
  const noRun=await call(C,{action:'set_record_authority',manufacturer:COPY,authoritative:true,confirm_parity:true}); eq([noRun.status,noRun.body.error],[409,'approval_required']);
  const v=await step(C,'pre-activation verification',{action:'mc_verify',manufacturer:COPY,phase:'pre'}); eq(v.status,200,JSON.stringify(v.body).slice(0,300));
  eq([v.body.result,v.body.failed],['pass',[]],JSON.stringify((v.body.checks||[]).filter(c=>!c.pass)).slice(0,600)); preRun=v.body;
  ok(v.body.fingerprint!==fx.real.fingerprint,'before activation the copy still shows the layers (no pack wording) — activation is what changes it');
  const badGate=await call(C,{action:'mc_approve_gate',manufacturer:COPY,gate:'activate',run_id:999999,reason:'x'}); eq(badGate.status,409,'no such run');
  actApproval=(await step(C,'Approval 2 (activation)',{action:'mc_approve_gate',manufacturer:COPY,gate:'activate',run_id:preRun.run_id,reason:'Pre-activation run passed; fingerprint equals the Gold Standard'})).body.approval;
  eq(actApproval.hcps_value.run_id,preRun.run_id);
  const dry=await step(C,'activation (dry run)',{action:'set_record_authority',manufacturer:COPY,authoritative:true,confirm_parity:true,approval_decision_id:actApproval.id,dry_run:true});
  eq([dry.status,dry.body.dry_run,W.db.manufacturer_meta.find(x=>x.slug===COPY).record_authoritative],[200,true,false],JSON.stringify(dry.body).slice(0,300));
});
await t('6 · activate with Approval 2 (single use), then the post-activation verification passes with the Gold Standard fingerprint',async()=>{
  const r=await step(C,'activate',{action:'set_record_authority',manufacturer:COPY,authoritative:true,confirm_parity:true,approval_decision_id:actApproval.id});
  eq([r.status,r.body.authoritative,r.body.approval_used],[200,true,actApproval.id],JSON.stringify(r.body).slice(0,300));
  const again=await call(C,{action:'set_record_authority',manufacturer:COPY,authoritative:true,confirm_parity:true,approval_decision_id:actApproval.id}); eq(again.status,409,'single use');
  const v=await step(C,'post-activation verification',{action:'mc_verify',manufacturer:COPY,phase:'post'});
  eq([v.body.result,v.body.failed,v.body.fingerprint],['pass',[],fx.real.fingerprint],JSON.stringify((v.body.checks||[]).filter(c=>!c.pass)).slice(0,600));
  const ck=id=>(v.body.checks||[]).find(c=>c.id===id)||{};
  eq([ck('freight_source').detail.source,ck('full_field_parity').pass,ck('source_alignment').pass],['record',true,true]);
  const cmp=await step(C,'compare pre vs post',{action:'mc_compare_runs',a:preRun.run_id,b:v.body.run_id}); eq([cmp.status,cmp.body.fingerprint_same],[200,false],'activation changed what dealers see');
  /* The storefront's catalog file already carries the pack units, so before activation only the display program
     differs: its unit "Display" exists only on the record (an HCPS decision). Activation is what brings it. */
  eq(cmp.body.lines_only_in_b.map(l=>l.split('|')[0]),['444DISPLAY'],'the only change activation made');
  ok(/\|Display\|1\|/.test(cmp.body.lines_only_in_b[0]),cmp.body.lines_only_in_b[0]);
});
await t('the real (frozen) Bemis line refuses every workflow write — even dry runs — and comes out byte-identical',async()=>{
  const attempts=[{action:'mc_register_source',kind:'price_list',title:'x',received_date:'2026-10-10',dry_run:true},{action:'mc_accept_source',source_id:5,reason:'x'},
    {action:'mc_import_source_rows',source_id:5,rows:[{code:'X',base_price:1}]},{action:'mc_approve_gate',gate:'stage',plan_hash:'a'.repeat(64),plan_kind:'records',reason:'x'},
    {action:'mc_set_freight_terms',terms:clone(fx.freight),trace:{source_id:6},dry_run:true},{action:'stage_record_source',source_id:5,rows:[{code:'7YR05310TSS',base_price:1}],dry_run:true},
    {action:'set_record_authority',authoritative:false},{action:'set_record_authority',authoritative:true,confirm_parity:true,dry_run:true}];
  for(const a of attempts){ const r=await call(C,Object.assign({manufacturer:REAL},a)); eq([r.status,r.body.error],[423,'line_frozen'],a.action); }
  const reads=['mc_match','mc_structure','mc_commercial'];
  for(const a of reads){ const r=await call(C,{action:a,manufacturer:REAL}); eq(r.status,200,a+' reads a frozen line'); }
  eq(realSnapshot(W),REAL_BEFORE,'the frozen line is unchanged');
});
await t('every write in the walkthrough was preceded by its dry run, and every approval was used exactly once',async()=>{
  const writes=LOG.filter(x=>!x.dry_run&&x.status===200&&/^(mc_register_source|mc_accept_source|mc_import_source_rows|mc_record_decision|mc_set_freight_terms|stage_record_source|set_record_authority)$/.test(x.action));
  for(const w of writes){ const i=LOG.indexOf(w); ok(LOG.slice(0,i).some(x=>x.action===w.action&&x.dry_run&&x.status===200)||w.action==='mc_record_decision'&&w.step==='freight decision','no dry run before '+w.step); }
  const gates=W.db.mfr_decisions.filter(d=>/^gate:/.test(d.field)&&d.manufacturer===COPY);
  eq(gates.map(g=>[g.field,!!g.used_at]),[['gate:stage',false],['gate:stage',true],['gate:stage',true],['gate:activate',true]],'the decoy approval stays unused; the three real ones are spent');
});
if(process.env.MCFLOW_LOG) fs.writeFileSync(process.env.MCFLOW_LOG,JSON.stringify({steps:LOG,db:{decisions:W.db.mfr_decisions.filter(d=>d.manufacturer===COPY),runs:W.db.mfr_verification_runs.map(({checks,...r})=>Object.assign(r,{checks:(checks||[]).map(c=>({id:c.id,pass:c.pass,severity:c.severity}))})),
  sources:W.db.mfr_sources.filter(s=>s.manufacturer===COPY),records:W.db.product_skus.filter(r=>r.manufacturer===COPY).map(({code_norm,updated_at,updated_by,...x})=>x),
  meta:W.db.manufacturer_meta}},null,1));
console.log(`mc guided workflow (Bemis copy): ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

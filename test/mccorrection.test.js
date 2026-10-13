/* Manufacturer Center — partial publications, the current Gold Standard, saved President edits and the published-page
   correction (Angelo 2026-10-12, after runs #17–#19 and the Assurance publication), end to end in the Release B
   sandbox (test/mcenrich.world.js) through the REAL handlers:
     · publishing ONE approved page while other approved / Ready pages stay unpublished passes: those pages are
       Waiting / unchanged, never "missing / 0 cards" (the bug behind runs #17–#19); finalize passes;
     · a later publication while a page is already live: the live page is neither held nor republished, stays
       untouched, and the visibility checks expect it (publish_execute and finalize);
     · the saved President edit stays visible after Use proposed replaces it (approval_state.edit_saved);
     · a regression_fix scoped to one published page corrects exactly description / features / specs from the
       President's saved edits: dry run → approve → execute → finalize; every other page, every photo, the card image
       and everything commercial unchanged; the fix is spent; the enrichment window is neither needed nor spent;
     · the scoped fix opens nothing else (product-content, catalog-api), and the correction refuses areas outside it;
     · goldStandardOf: the newest finalized PASS is the status; later failed runs are history. */
const path=require('path');
const {S,ROOT,world,PC,call,withWin,approvePages,WIN}=require('./mcenrich.world.js');
const MC=require(path.join(ROOT,'_mc.js'));
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,4).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const pageOf=(plan,code)=>plan.pages.find(p=>p.skus.some(s=>s.code===code));
const cat=(W,b)=>S.call(S.mod(W),Object.assign({manufacturer:S.REAL},b));
async function enrichToReady(C){
  let plan=(await call(C,{action:'enrich_plan'})).body;
  for(const p of plan.pages){ await call(C,withWin({action:'enrich_page',page_key:p.page_key})); for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:p.page_key})); if(!im.body.remaining) break; } }
  plan=(await call(C,{action:'enrich_plan'})).body;
  const seat=pageOf(plan,'7YR05310TSS').page_key;
  for(const [code,img] of [['7YR05310TSS','R85320TSS-000-F'],['7YE05310TSS','E85320TSS-000-F']])
    await call(C,withWin({action:'enrich_resolve',page_key:seat,issue:'needs_image',choice:'use_source_image',value:{code,image_url:'https://www.toiletseats.com/assets/'+img+'.jpg'},reason:'official top view'}));
  await call(C,withWin({action:'enrich_page',page_key:seat})); for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:seat})); if(!im.body.remaining) break; }
  plan=(await call(C,{action:'enrich_plan'})).body;
  for(const p of plan.pages.filter(p=>p.status!=='ready')) await call(C,withWin({action:'enrich_resolve',page_key:p.page_key,issue:'hold',choice:'hold_back',reason:'source hold'}));
  return (await call(C,{action:'enrich_plan'})).body;
}
async function publish(C){
  const d=(await call(C,{action:'publish_plan'})).body; if(!d.publishable) throw new Error('not publishable: '+JSON.stringify(d.problems));
  const a=await call(C,{action:'publish_approve',plan_hash:d.plan_hash,reason:'test'}); if(a.status!==200) throw new Error('approve '+JSON.stringify(a.body));
  const did=a.body.decision.id;
  for(let i=0;i<20;i++){ const r=await call(C,{action:'publish_promote',decision_id:did}); if(r.status!==200) throw new Error('promote '+JSON.stringify(r.body)); if(!r.body.remaining) break; }
  const x=await call(C,{action:'publish_execute',decision_id:did});
  return { dry:d, did, exec:x };
}
const EDIT_DESC='Raised toilet seat is elevated 3" to make sitting and standing easier. Innovative shield under the ring keeps everything in the bowl and is easy to clean unlike other raised toilet seats or risers. Wide, comfortable ring designed to eliminate pressure points. Seat is securely fastened to eliminate concerns about falling. A secure seat is critical to your independence. Support Arms for this seat sold separately.';
const EDIT_FEAT=['Raised 3" to make sitting and standing easier','Reverse-funnel shield design keeps everything directed toward the bowl',
  'Self-sustaining hinges keep the seat in position until you close it, so it won’t slam, and let the ring and cover be placed upright for standing use and thorough cleaning'];
const EDIT_SPECS=[{label:'Material',value:'Plastic'}];

(async()=>{
let W, C, plan, assist, seat, rise;
await t('setup: 3 Ready pages, 4 held back',async()=>{
  W=world(); C=PC(W); plan=await enrichToReady(C);
  eq(plan.pages.filter(p=>p.status==='ready').length,3);
  assist=pageOf(plan,'7YA0AS100').page_key; seat=pageOf(plan,'7YR05310TSS').page_key; rise=pageOf(plan,'7YA04505T').page_key;
});
let didA;
await t('REGRESSION (runs #17–#19): publishing ONE approved page while two Ready pages wait — dry run, execute and post-check pass; the waiting pages keep their current cards',async()=>{
  await approvePages(C,'proposed',[assist]);
  const r=await publish(C); didA=r.did;
  eq([r.dry.summary.enriched_pages_live,r.dry.summary.waiting_for_approval,r.dry.summary.held_on_current_cards,r.dry.summary.missing,r.dry.summary.accounted],[1,2,4,0,9]);
  eq(r.exec.status,200,JSON.stringify(r.exec.body.checks&&r.exec.body.checks.filter(c=>!c.pass)).slice(0,800));
  ok(r.exec.body.checks.every(c=>c.pass),'every post-check passes');
  const acc=r.exec.body.checks.find(c=>c.id==='accounting'); eq([acc.detail.enriched_pages_ready,acc.detail.waiting_for_approval,acc.detail.missing],[1,2,0]);
  eq(W.db.product_content.filter(x=>x.manufacturer===S.REAL&&x.status==='published').map(x=>x.page_key),[assist]);
  ok(!W.db.mfr_verification_runs.some(x=>x.result==='fail'),'no failed run recorded');
});
await t('a later publication while Assist is live: Assist is not held, not republished, untouched; execute passes with Assist expected visible',async()=>{
  /* the President edits Assurance's text, then (as happened) replaces those selections with Use proposed */
  const st=(await call(C,{action:'approval_state'})).body.pages.find(p=>p.page_key===seat);
  ok(st&&st.areas,'Assurance is approvable');
  let r=await call(C,{action:'approval_record',selections:[{page_key:seat,area:'specs',choice:'edit',value:{items:EDIT_SPECS}},{page_key:seat,area:'features',choice:'edit',value:{items:EDIT_FEAT}},{page_key:seat,area:'description',choice:'edit',value:{text:EDIT_DESC}}]});
  eq(r.status,200,JSON.stringify(r.body).slice(0,300));
  await approvePages(C,'proposed',[seat,rise]);   // Use proposed on every area — over the edits
  const st2=(await call(C,{action:'approval_state'})).body.pages.find(p=>p.page_key===seat);
  for(const id of ['description','features','specs']){ const a=st2.areas.find(x=>x.id===id);
    eq([a.choice,a.selected],['use_proposed',true],id); ok(a.edit_saved&&!a.edit_saved.active&&!a.edit_saved.stale,id+': the saved edit is still shown (not active)'); }
  eq(st2.areas.find(x=>x.id==='specs').edit_saved.value,{items:EDIT_SPECS});
  const assistBefore=JSON.stringify(W.db.product_content.find(x=>x.page_key===assist));
  const p=await publish(C);
  eq([p.dry.summary.enriched_pages_live,p.dry.summary.already_live_unchanged,p.dry.summary.held_on_current_cards],[2,1,4]);
  ok(!p.dry.held.some(h=>h.page_key===assist),'a live page is not held');
  eq(p.exec.status,200,JSON.stringify(p.exec.body.checks&&p.exec.body.checks.filter(c=>!c.pass)).slice(0,800));
  ok(p.exec.body.checks.find(c=>c.id==='live_rows_untouched').pass,'live rows untouched');
  eq(JSON.stringify(W.db.product_content.find(x=>x.page_key===assist)),assistBefore,'Assist row byte-identical');
  const fin=await cat(W,{action:'mc_publish_finalize',decision_id:p.did}); eq(fin.status,200,JSON.stringify(fin.body.failed||fin.body).slice(0,500));
  ok(fin.body.checks.find(c=>c.id==='only_approved_pages_visible').pass,'finalize expects the page that was live before');
  ok(W.db.mfr_decisions.find(d=>d.id===WIN).used_at,'the publication spent the enrichment window');
  /* (as on production: the published Assurance carries the proposals, not the edits) */
  ok(!(W.db.product_content.find(x=>x.page_key===seat).specs||[]).every(s=>s.label==='Material'),'published with the proposed specs');
});
await t('goldStandardOf: the newest finalized PASS is the status; failed runs after it are history; the overview and line carry it',async()=>{
  const g=MC.goldStandardOf([{id:20,phase:'post',result:'pass',fingerprint:'f20',run_at:'2026-10-13T03:05:32Z'},{id:19,phase:'release',result:'fail',run_at:'2026-10-12T20:03:17Z'},
    {id:16,phase:'release',result:'fail',run_at:'2026-10-12T15:02:17Z'},{id:15,phase:'release',result:'pass',run_at:'2026-10-12T03:02:52Z'},{id:12,phase:'post',result:'pass',fingerprint:'f12',run_at:'2026-10-11T03:53:00Z'}]);
  eq([g.id,g.result,g.later_failed],[20,'pass',0]);
  const h=MC.goldStandardOf([{id:21,phase:'release',result:'fail',run_at:'2026-10-14T01:00:00Z'},{id:20,phase:'post',result:'pass',fingerprint:'f20',run_at:'2026-10-13T03:05:32Z'}]);
  eq([h.id,h.later_failed,h.latest_attempt.id],[20,1,21]);
  eq(MC.goldStandardOf([{id:3,phase:'release',result:'pass',run_at:'x'}]),null,'a release run is not a Gold Standard');
  const ov=await S.call(S.mod(W),{action:'mc_overview'}); const b=ov.body.lines.find(l=>l.slug===S.REAL); ok(b.gold_standard&&b.gold_standard.result==='pass','overview gold_standard');
  const ln=await cat(W,{action:'mc_line'}); ok(ln.body.gold_standard&&ln.body.gold_standard.id===b.gold_standard.id,'line gold_standard');
});
let rf, edits;
await t('regression fix scoped to the Assurance page: recorded through mc_record_decision; a non-live page or an outside area is refused',async()=>{
  let r=await cat(W,{action:'mc_record_decision',kind:'regression_fix',field:'page:'+seat,reason:'x',hcps_value:{scope:'content_correction',page_key:seat,areas:['description','title']}});
  eq([r.status,r.body.error],[400,'bad_scope']);
  const heldPk=plan.pages.find(p=>p.status==='held_back').page_key;
  r=await cat(W,{action:'mc_record_decision',kind:'regression_fix',field:'page:'+heldPk,reason:'x',hcps_value:{scope:'content_correction',page_key:heldPk,areas:['description']}});
  eq([r.status,r.body.error],[400,'not_a_live_page']);
  r=await cat(W,{action:'mc_record_decision',kind:'regression_fix',field:'page:'+seat,reason:'Restore the President-approved Assurance text',hcps_value:{scope:'content_correction',page_key:seat,areas:['description','features','specs'],page_name:'Assurance'}});
  eq(r.status,200,JSON.stringify(r.body)); rf=r.body.decision.id;
  edits=W.db.mfr_decisions.filter(d=>d.kind==='content_approval'&&d.field==='page:'+seat&&d.hcps_value.choice==='edit');
  eq(edits.length,3);
});
await t('the scoped fix opens nothing else: product-content and catalog-api refuse it for any other write',async()=>{
  const before=JSON.stringify(W.db.product_content);
  let r=await call(C,{action:'set_content',page_key:rise,description:'sneaky',regression_fix:{decision_id:rf,reason:'x'}});
  eq(r.status,423,JSON.stringify(r.body).slice(0,200)); ok(/scoped to correcting/.test(r.body.message),r.body.message);
  r=await cat(W,{action:'save_override',code:'7YA04505T',patch:{name:'x'},regression_fix:{decision_id:rf,reason:'x'}});
  eq(r.status,423,JSON.stringify(r.body).slice(0,200));
  eq(JSON.stringify(W.db.product_content),before,'nothing changed'); ok(!W.db.mfr_decisions.find(d=>d.id===rf).used_at,'fix not spent');
});
await t('correction_record: only areas inside the fix; the text copied from the President\'s approvals (a different text is refused)',async()=>{
  const id=a=>edits.find(d=>d.hcps_value.area===a).id;
  let r=await call(C,{action:'correction_record',regression_fix_id:rf,corrections:[{area:'title',value:{text:'x'}}]}); eq([r.status,r.body.error],[400,'outside_scope']);
  r=await call(C,{action:'correction_record',regression_fix_id:rf,corrections:[{area:'description',from_decision:id('description'),value:{text:'other'}}]}); eq([r.status,r.body.error],[400,'source_mismatch']);
  const n=W.db.mfr_decisions.length;
  r=await call(C,{action:'correction_record',regression_fix_id:rf,corrections:['description','features','specs'].map(a=>({area:a,from_decision:id(a)}))});
  eq(r.status,200,JSON.stringify(r.body)); eq(W.db.mfr_decisions.length,n+3);
  /* (the correction decisions never leak into a draft page's approval) */
  const st=(await call(C,{action:'correction_state',regression_fix_id:rf})).body;
  eq(st.areas.map(a=>[a.id,!!a.corrected,a.saved_edit&&a.saved_edit.decision===id(a.id)]),[['description',true,true],['features',true,true],['specs',true,true]]);
});
let cp;
await t('correction dry run: exactly description / features / specs change; title, photos, option photos, card image, documents identical; other pages unchanged; 9/9, 0 missing, 0 duplicates, 0 commercial; read-only',async()=>{
  const before=JSON.stringify(W.db);
  const r=await call(C,{action:'correction_plan',regression_fix_id:rf}); eq(r.status,200,JSON.stringify(r.body).slice(0,400)); cp=r.body;
  eq(JSON.stringify(W.db),before,'nothing written');
  eq(cp.publishable,true,JSON.stringify(cp.problems));
  eq(cp.changes.map(c=>c.area),['description','features','specs']);
  eq(cp.changes.find(c=>c.area==='description').after.description,EDIT_DESC);
  eq(cp.changes.find(c=>c.area==='features').after.features,EDIT_FEAT);
  eq(cp.changes.find(c=>c.area==='specs').after.specs,EDIT_SPECS);
  eq(cp.unchanged.identical,true);
  const s=cp.summary; eq([s.active_skus,s.accounted,s.missing,s.duplicates,s.commercial_changes,s.pages_corrected,s.cards_today,s.cards_after],[9,9,0,0,0,1,s.cards_today,s.cards_today]);
  ok(cp.preview.pass,'dealer preview passes');
  ok(!/1,000|1000 lb|Stay.Tite|Snap 2 Secure/i.test(JSON.stringify(cp.changes.map(c=>c.after))),'no 1,000-lb claim or fastening name');
});
let cdid;
await t('approve → execute: only the three areas change on Assurance; Assist, Rise and every held row byte-identical; the fix spent; no window used',async()=>{
  let r=await call(C,{action:'correction_approve',regression_fix_id:rf,plan_hash:'0'.repeat(64),reason:'x'}); eq([r.status,r.body.error],[409,'dry_run_stale']);
  r=await call(C,{action:'correction_approve',regression_fix_id:rf,plan_hash:cp.plan_hash,reason:'Restore the President-approved Assurance text'}); eq(r.status,200,JSON.stringify(r.body)); cdid=r.body.decision.id;
  const D=W.db.mfr_decisions.find(d=>d.id===cdid); eq([D.kind,D.hcps_value.correction.regression_fix,D.hcps_value.window],['content_publication',rf,null]);
  const others=JSON.stringify(W.db.product_content.filter(x=>x.manufacturer===S.REAL&&x.page_key!==seat));
  const seatBefore=JSON.parse(JSON.stringify(W.db.product_content.find(x=>x.page_key===seat)));
  const skusBefore=JSON.stringify(W.db.product_skus);
  r=await call(C,{action:'publish_execute',decision_id:cdid}); eq([r.status,r.body.error],[409,'approval_invalid'],'not a publication');
  r=await call(C,{action:'correction_execute',regression_fix_id:rf,decision_id:cdid}); eq(r.status,200,JSON.stringify(r.body.checks&&r.body.checks.filter(c=>!c.pass)).slice(0,800));
  ok(r.body.checks.every(c=>c.pass),'every post-check passes');
  const now=W.db.product_content.find(x=>x.page_key===seat);
  const changed=Object.keys(Object.assign({},seatBefore,now)).filter(k=>JSON.stringify(seatBefore[k])!==JSON.stringify(now[k])).sort();
  ok(changed.every(k=>['description','features','clinical_applications','specs','billing_codes','published_at','reviewed_by'].includes(k)),'changed: '+changed.join(','));
  eq([now.description,now.features,now.specs],[EDIT_DESC,EDIT_FEAT,EDIT_SPECS]);
  ['image','images_gallery','skus','card_image','name','options','documents','videos'].forEach(k=>eq(JSON.stringify(now[k]),JSON.stringify(seatBefore[k]),k+' unchanged'));
  eq(JSON.stringify(W.db.product_content.filter(x=>x.manufacturer===S.REAL&&x.page_key!==seat)),others,'every other page byte-identical');
  eq(JSON.stringify(W.db.product_skus),skusBefore,'commercial records untouched');
  ok(W.db.mfr_decisions.find(d=>d.id===rf).used_at,'the fix is spent');
  r=await call(C,{action:'correction_execute',regression_fix_id:rf,decision_id:cdid}); eq(r.status,423,'a spent fix opens nothing');
});
await t('finalize: new Gold Standard (post · pass) recording the correction; the enrichment window untouched; rollback then refused',async()=>{
  const winBefore=JSON.stringify(W.db.mfr_decisions.filter(d=>d.kind==='enrichment_window'));
  W.db.mfr_decisions.push({id:9907,manufacturer:S.REAL,kind:'enrichment_window',field:'enrichment_window',reason:'open window',decided_by:'Angelo',decided_at:'2026-10-13T03:05:59Z',used_at:null,hcps_value:{scope:'content_drafts'}});
  const r=await cat(W,{action:'mc_publish_finalize',decision_id:cdid}); eq(r.status,200,JSON.stringify(r.body.failed||r.body).slice(0,600));
  eq(r.body.window_closed,null,'no window closed');
  ok(!W.db.mfr_decisions.find(d=>d.id===9907).used_at,'the open window stays open');
  const run=W.db.mfr_verification_runs.find(x=>x.id===r.body.run_id); eq([run.phase,run.result],['post','pass']);
  const pc=run.checks.find(c=>c.id==='publication'); eq(pc.detail.correction.regression_fix,rf);
  const rb=await cat(W,{action:'mc_publish_rollback',decision_id:cdid,reason:'x'}); ok(rb.status!==200||!rb.body.rolled_back,'rollback refused once Gold Standard');
  /* (the sandbox does not stamp run_at — the database does, now(): give the saved runs their order) */
  W.db.mfr_verification_runs.forEach(x=>{ if(!x.run_at) x.run_at=new Date(Date.UTC(2026,9,13,4,0,0)+x.id*1000).toISOString(); });
  const v=await cat(W,{action:'mc_verify',phase:'regression',save:false}); eq(v.body.result,'pass',JSON.stringify(v.body.failed));
  ok(v.body.checks.find(c=>c.id==='content_fingerprint').detail.baseline===run.checks.find(c=>c.id==='content_fingerprint').detail.fingerprint,'the correction run is the content baseline');
  ok(winBefore.length>0);
});
await t('a live page changed behind a later publication is caught (live_rows_untouched) and rolled back',async()=>{
  const W3=world(); const C3=PC(W3); const pl=await enrichToReady(C3);
  const as=pageOf(pl,'7YA0AS100').page_key; await approvePages(C3,'proposed',[as]); eq((await publish(C3)).exec.status,200);
  await approvePages(C3,'proposed');
  const d=(await call(C3,{action:'publish_plan'})).body; const a=(await call(C3,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  for(let i=0;i<20;i++){ const r=await call(C3,{action:'publish_promote',decision_id:a}); if(!r.body.remaining) break; }
  const real=W3.fetch; let done=false;
  W3.fetch=async(u,o)=>{ const res=await real(u,o); if(!done && /rpc\/mfr_content_publish$/.test(String(u)) && res.ok){ done=true; W3.db.product_content.find(x=>x.page_key===as).reviewed_by='behind the plan'; } return res; };
  const C3b=PC(W3); const r=await call(C3b,{action:'publish_execute',decision_id:a});
  eq([r.status,r.body.rolled_back],[409,true],JSON.stringify(r.body).slice(0,300)); ok(r.body.checks.some(c=>c.id==='live_rows_untouched'&&!c.pass),'caught by live_rows_untouched');
});
await t('unit: correctionPlan refuses a correction outside the fix and any field outside the areas it names',async()=>{
  const PUB=require(path.join(ROOT,'_publish.js'));
  const row={page_key:'p',manufacturer:'bemis',status:'published',disabled:false,description:'old',features:['a'],specs:[{label:'Shape',value:'Elongated'}],name:'N',image:null,images_gallery:[],skus:[]};
  const rfx={id:7,kind:'regression_fix',manufacturer:'bemis',used_at:null,hcps_value:{scope:'content_correction',page_key:'p',areas:['description']}};
  const dec=(id,area,value)=>({id,kind:'content_approval',field:'page:p',hcps_value:{area,choice:'edit',value,correction:7}});
  const base={slug:'bemis',rf:rfx,pages:[{page_key:'p',name:'P',status:'published',skus:[{code:'X'}]}],drafts:[row],records:[],meta:null,preview:{pass:true,checks:[],summary:{}}};
  let P=PUB.correctionPlan(Object.assign({},base,{decisions:[dec(1,'description',{text:'new'})]}));
  eq([P.publishable,P.after.description,P.after.specs],[true,'new',row.specs],JSON.stringify(P.problems));
  P=PUB.correctionPlan(Object.assign({},base,{decisions:[dec(1,'description',{text:'new'}),dec(2,'specs',{items:[{label:'M',value:'P'}]})]}));
  ok(!P.publishable && P.problems.some(x=>/outside regression_fix 7/.test(x)) && JSON.stringify(P.after.specs)===JSON.stringify(row.specs),'a correction outside the fix is refused and never applied');
  const was=PUB.CORRECTION_FIELDS.description; PUB.CORRECTION_FIELDS.description=[];
  try{ P=PUB.correctionPlan(Object.assign({},base,{decisions:[dec(1,'description',{text:'new'})]})); ok(!P.publishable && P.problems.some(x=>/outside its scope: description/.test(x)),'a field outside the named areas is refused: '+JSON.stringify(P.problems)); }
  finally{ PUB.CORRECTION_FIELDS.description=was; }
  P=PUB.correctionPlan(Object.assign({},base,{decisions:[dec(1,'description',{text:'new'})],rf:Object.assign({},rfx,{used_at:'x'})})); ok(!P.publishable,'a spent fix');
  P=PUB.correctionPlan(Object.assign({},base,{decisions:[dec(1,'description',{text:'new'})],preview:{pass:false,checks:[{id:'x',pass:false}],summary:{}}})); ok(!P.publishable,'a failing preview');
});
await t('a correction approval goes stale when any other page changes (Rise edited behind it)',async()=>{
  const W2=world(); const C2=PC(W2); const pl=await enrichToReady(C2); await approvePages(C2,'proposed'); const p=await publish(C2); eq(p.exec.status,200);
  const sk=pageOf(pl,'7YR05310TSS').page_key, rs=pageOf(pl,'7YA04505T').page_key;
  const f=await cat(W2,{action:'mc_record_decision',kind:'regression_fix',field:'page:'+sk,reason:'x',hcps_value:{scope:'content_correction',page_key:sk,areas:['specs']}}); const id=f.body.decision.id;
  eq((await call(C2,{action:'correction_record',regression_fix_id:id,corrections:[{area:'specs',value:{items:EDIT_SPECS}}]})).status,200);
  const d=(await call(C2,{action:'correction_plan',regression_fix_id:id})).body; eq(d.publishable,true,JSON.stringify(d.problems));
  const a=(await call(C2,{action:'correction_approve',regression_fix_id:id,plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  W2.db.product_content.find(x=>x.page_key===rs).description='changed behind the correction';
  const before=JSON.stringify(W2.db.product_content.find(x=>x.page_key===sk));
  const r=await call(C2,{action:'correction_execute',regression_fix_id:id,decision_id:a}); eq([r.status,r.body.error],[409,'approval_invalid']);
  eq(JSON.stringify(W2.db.product_content.find(x=>x.page_key===sk)),before,'nothing changed');
  ok(!W2.db.mfr_decisions.find(x=>x.id===id).used_at,'fix not spent');
});
console.log(`mc partial publication, Gold Standard status & published-page correction: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

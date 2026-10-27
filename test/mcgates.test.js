/* Manufacturer Center Phase 6 — the approval gates and the match, rule by rule (the end-to-end walkthrough is
   test/mcflow.test.js). Pure rules first (_mc.js), then the server paths that the walkthrough does not reach:
   a record that changes after the pre-activation run, a failing run, a run of another line, an approval of
   another line, and the dry runs of every write. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const MC=require(path.join(ROOT,'_mc.js'));
const GATES=require('./mc-gates.js');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const H='b'.repeat(64);
(async()=>{
await t('gate rule: kind, gate, line, single use and the approved plan must all match',async()=>{
  const d={id:5,kind:'acceptance',field:'gate:stage',manufacturer:'x',used_at:null,hcps_value:{plan_hash:H,plan_kind:'records'}};
  eq(MC.gateProblem(d,{manufacturer:'x',gate:'stage',want:{plan_hash:H,plan_kind:'records'}}),null);
  ok(MC.gateProblem(null,{manufacturer:'x',gate:'stage'}),'missing');
  ok(MC.gateProblem(Object.assign({},d,{kind:'interpretation'}),{manufacturer:'x',gate:'stage'}),'kind');
  ok(MC.gateProblem(d,{manufacturer:'x',gate:'activate'}),'gate');
  ok(MC.gateProblem(d,{manufacturer:'y',gate:'stage'}),'line');
  ok(MC.gateProblem(Object.assign({},d,{used_at:'2026-10-10T00:00:00Z'}),{manufacturer:'x',gate:'stage'}),'used');
  ok(MC.gateProblem(d,{manufacturer:'x',gate:'stage',want:{plan_hash:'c'.repeat(64),plan_kind:'records'}}),'plan');
  ok(MC.gateProblem(d,{manufacturer:'x',gate:'stage',want:{plan_hash:H,plan_kind:'freight'}}),'plan kind');
  eq(MC.gateProblem(Object.assign({},d,{hcps_value:{plan_kind:'records',plan_hash:H}}),{manufacturer:'x',gate:'stage',want:{plan_hash:H,plan_kind:'records'}}),null,'key order (jsonb) does not matter');
});
await t('activation rule: a passing pre-activation run of this line, newer than every record change',async()=>{
  const run={id:3,manufacturer:'x',phase:'pre',result:'pass',run_at:'2026-10-10T20:00:00Z'};
  eq(MC.activationRunProblem(run,{manufacturer:'x',lastRecordChange:'2026-10-10T19:59:59Z'}),null);
  ok(MC.activationRunProblem(null,{manufacturer:'x'}),'missing');
  ok(MC.activationRunProblem(Object.assign({},run,{manufacturer:'y'}),{manufacturer:'x'}),'line');
  ok(MC.activationRunProblem(Object.assign({},run,{phase:'post'}),{manufacturer:'x'}),'phase');
  ok(MC.activationRunProblem(Object.assign({},run,{result:'fail'}),{manufacturer:'x'}),'fail');
  ok(/changed after run/.test(MC.activationRunProblem(run,{manufacturer:'x',lastRecordChange:'2026-10-10T20:00:01Z'})),'record changed');
});
await t('plan hash: the same plan hashes the same whatever the key order; any value change moves it',async()=>{
  eq(MC.planHash({a:1,b:[{x:1,y:2}]}),MC.planHash({b:[{y:2,x:1}],a:1}));
  ok(MC.planHash({a:1})!==MC.planHash({a:1.01}),'value'); ok(/^[0-9a-f]{64}$/.test(MC.planHash({})),'hex');
});
await t('case quantity as written: "2/CS" → 2, "4" → 4; blank, "Each", "1" → none (a decision is needed)',async()=>{
  eq([MC.parseCaseQty('2/CS'),MC.parseCaseQty('4'),MC.parseCaseQty(6),MC.parseCaseQty('Case of 12'),MC.parseCaseQty(null),MC.parseCaseQty(''),MC.parseCaseQty('Each'),MC.parseCaseQty('1')],[2,4,6,12,null,null,null,null]);
});
await t('match: source facts and HCPS interpretation stay apart; the latest decision wins; a pack-only rule never touches single items',async()=>{
  const src=[{code:'P1',base_price:20,msrp:12,map:12,parsed_case_qty:2,raw:{'Master Case Qty':'2/CS'}},{code:'S1',base_price:9,msrp:15,map:null,parsed_case_qty:null,raw:{}}];
  const dec=[{id:1,kind:'interpretation',field:'uom',code:null,decided_at:'2026-01-01',hcps_value:{uom:'Case',applies_to:'packs'}},
             {id:5,kind:'interpretation',field:'msrp_basis',code:null,decided_at:'2026-01-01',hcps_value:{msrp_basis:'each',applies_to:'packs'}},
             {id:2,kind:'interpretation',field:'uom',code:'S1',decided_at:'2026-01-02',hcps_value:{uom:'Each',case_qty:1}},
             {id:3,kind:'interpretation',field:'uom',code:'S1',decided_at:'2026-01-03',hcps_value:{uom:'Single'}},
             {id:4,kind:'regression_fix',field:'uom',code:'S1',decided_at:'2026-01-04',hcps_value:{uom:'Nope'}}];
  const m=MC.matchLine({sourceRows:src,records:[{code:'OLD',status:'active',base_price:1}],storefrontCodes:['P1'],decisions:dec,normCode:norm});
  const r=c=>m.rows.find(x=>x.code===c);
  eq([r('P1').source.base_price,r('P1').hcps.uom,r('P1').hcps.msrp_basis],[20,'Case','each'],'facts kept, interpretation beside them');
  eq([r('S1').hcps.uom,r('S1').hcps.case_qty,r('S1').hcps.msrp_basis],['Single',1,undefined],'latest wins; pack rule not applied; a regression_fix is not an interpretation');
  eq([r('OLD').status,r('OLD').needs_decision.map(n=>n.field)],['not_in_source',['status']],'a record the source drops needs a decision');
  eq(m.summary.ready_to_stage,2); eq(m.stage_rows.find(x=>x.code==='S1').uom,'Single');
});

/* Server paths */
function world(extra){ const W=M.createWorld({ serialIds:GATES.SERIAL, tables:Object.assign({ manufacturer_meta:[{slug:'n1',record_authoritative:false},{slug:'n2'}],
  product_skus:[{manufacturer:'n1',code:'A',base_price:10,status:'active',updated_at:'2026-10-10T10:00:00Z'}], custom_products:[{manufacturer:'n1',code:'A',base_price:10,active:true}],
  product_overrides:[], product_content:[], mfr_decisions:[], mfr_verification_runs:[], price_imports:[],
  mfr_sources:[{id:39,manufacturer:'n1',kind:'price_list',title:'L0',status:'accepted',received_date:'2026-10-09'},{id:38,manufacturer:'n2',kind:'price_list',title:'N2',status:'accepted',received_date:'2026-10-09'}] }, extra||{}) });
  const inner=W.fetch; W.fetch=async(u,o)=>{ u=String(u); if(u.startsWith('https://ordering.test/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return inner(u,o); }; return W; }
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:'https://ordering.test'},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
const run=(W,o)=>{ const id=700+W.db.mfr_verification_runs.length; W.db.mfr_verification_runs.push(Object.assign({id,manufacturer:'n1',phase:'pre',result:'pass',checks:[],fingerprint:'f',run_at:'2026-10-10T12:00:00Z'},o||{})); return id; };
await t('Approval 2 is refused for a failing run, a post run, another line\'s run, or a run older than the last record change',async()=>{
  const W=world(), C=mod(W);
  for(const [o,why] of [[{result:'fail'},'did not pass'],[{phase:'post'},'pre-activation'],[{manufacturer:'n2'},'belongs to'],[{run_at:'2026-10-10T09:00:00Z'},'changed after']]){
    const id=run(W,o); const r=await call(C,{action:'mc_approve_gate',manufacturer:'n1',gate:'activate',run_id:id,reason:'x'});
    eq([r.status,r.body.error],[409,'activation_run_invalid'],why); ok(new RegExp(why).test(r.body.message),r.body.message); }
  eq(W.db.mfr_decisions.length,0,'nothing recorded');
});
await t('activation is refused when the record changes after the approval was given (verify again)',async()=>{
  const W=world(), C=mod(W); const id=run(W);
  const ap=await call(C,{action:'mc_approve_gate',manufacturer:'n1',gate:'activate',run_id:id,reason:'ok'}); eq(ap.status,200,JSON.stringify(ap.body));
  W.db.product_skus[0].updated_at='2026-10-10T13:00:00Z';     // a record write after the run
  const r=await call(C,{action:'set_record_authority',manufacturer:'n1',authoritative:true,confirm_parity:true,approval_decision_id:ap.body.approval.id});
  eq([r.status,r.body.error,W.db.manufacturer_meta[0].record_authoritative],[409,'activation_run_invalid',false]);
});
await t('an approval of another line, or of the other gate, is refused',async()=>{
  const W=world(), C=mod(W); const id=run(W,{manufacturer:'n2'}); W.db.product_skus.push({manufacturer:'n2',code:'B',base_price:1,status:'active',updated_at:'2026-10-10T10:00:00Z'});
  const other=await call(C,{action:'mc_approve_gate',manufacturer:'n2',gate:'activate',run_id:id,reason:'n2'}); eq(other.status,200,JSON.stringify(other.body));
  const r=await call(C,{action:'set_record_authority',manufacturer:'n1',authoritative:true,confirm_parity:true,approval_decision_id:other.body.approval.id}); eq([r.status,r.body.error],[409,'approval_invalid']);
  const st=await call(C,{action:'mc_approve_gate',manufacturer:'n1',gate:'stage',plan_hash:H,plan_kind:'records',reason:'x'});
  const r2=await call(C,{action:'set_record_authority',manufacturer:'n1',authoritative:true,confirm_parity:true,approval_decision_id:st.body.approval.id}); eq([r2.status,r2.body.error],[409,'approval_invalid']);
});
await t('activation is refused without an accepted price-list source (commercial facts unverified)',async()=>{
  const W=world({mfr_sources:[{id:40,manufacturer:'n1',kind:'price_list',title:'L',status:'received',received_date:'2026-10-10'},{id:42,manufacturer:'n1',kind:'terms',title:'T',status:'accepted',received_date:'2026-10-10'}]}), C=mod(W);
  const id=run(W); const ap=await call(C,{action:'mc_approve_gate',manufacturer:'n1',gate:'activate',run_id:id,reason:'ok'}); eq(ap.status,200,JSON.stringify(ap.body));
  const r=await call(C,{action:'set_record_authority',manufacturer:'n1',authoritative:true,confirm_parity:true,approval_decision_id:ap.body.approval.id});
  eq([r.status,r.body.error,W.db.manufacturer_meta[0].record_authoritative],[409,'no_accepted_source',false]);
  eq(W.db.mfr_decisions.filter(d=>d.used_at).length,0,'approval not spent');
});
await t('approving needs a reason and a real plan hash; the approval dry run records nothing',async()=>{
  const W=world(), C=mod(W);
  eq((await call(C,{action:'mc_approve_gate',manufacturer:'n1',gate:'stage',plan_hash:H,plan_kind:'records'})).status,400,'reason');
  eq((await call(C,{action:'mc_approve_gate',manufacturer:'n1',gate:'stage',plan_hash:'xyz',plan_kind:'records',reason:'r'})).status,400,'hash');
  eq((await call(C,{action:'mc_approve_gate',manufacturer:'n1',gate:'publish',reason:'r'})).status,400,'gate');
  const d=await call(C,{action:'mc_approve_gate',manufacturer:'n1',gate:'stage',plan_hash:H,plan_kind:'records',reason:'r',dry_run:true}); eq([d.status,W.db.mfr_decisions.length],[200,0]);
});
await t('every new write answers a dry run that writes nothing',async()=>{
  const W=world({mfr_sources:[{id:40,manufacturer:'n1',kind:'price_list',title:'L',status:'received',received_date:'2026-10-10'},{id:41,manufacturer:'n1',kind:'price_list',title:'L2',status:'accepted',received_date:'2026-10-10'}]}), C=mod(W);
  const n=W.writes.length;
  for(const b of [{action:'mc_register_source',kind:'price_list',title:'T',received_date:'2026-10-10'},{action:'mc_accept_source',source_id:40,reason:'r'},
                  {action:'mc_import_source_rows',source_id:41,rows:[{code:'A',base_price:1}]},{action:'mc_record_decision',kind:'interpretation',field:'uom',reason:'r'},
                  {action:'mc_approve_gate',gate:'stage',plan_hash:H,plan_kind:'records',reason:'r'},{action:'set_record_authority',authoritative:false}]){
    const r=await call(C,Object.assign({manufacturer:'n1',dry_run:true},b)); eq([r.status,r.body.dry_run],[200,true],b.action); }
  eq(W.writes.length,n,'nothing was written');
});
await t('only an accepted price list is imported; a received date is required to register',async()=>{
  const W=world({mfr_sources:[{id:40,manufacturer:'n1',kind:'price_list',title:'L',status:'received',received_date:'2026-10-10'},{id:42,manufacturer:'n1',kind:'terms',title:'T',status:'accepted',received_date:'2026-10-10'}]}), C=mod(W);
  eq((await call(C,{action:'mc_import_source_rows',manufacturer:'n1',source_id:40,rows:[{code:'A'}]})).body.error,'source_not_accepted');
  eq((await call(C,{action:'mc_import_source_rows',manufacturer:'n1',source_id:42,rows:[{code:'A'}]})).body.error,'source_not_accepted');
  eq((await call(C,{action:'mc_import_source_rows',manufacturer:'n2',source_id:40,rows:[{code:'A'}]})).body.error,'unknown_source');
  eq((await call(C,{action:'mc_register_source',manufacturer:'n1',kind:'price_list',title:'T'})).status,400);
  eq((await call(C,{action:'mc_register_source',manufacturer:'n1',kind:'price_list',title:'T',received_date:'2026-10-10',effective_date_status:'stated'})).status,400,'stated needs the date');
});
await t('president only: a signed-in rep, an inactive president, a bad token and no token are refused every workflow action — read or write — before anything is read',async()=>{
  const W=M.createWorld({ tokens:{'tok-rep':'rep@hcps.test','tok-old':'old@hcps.test','tok-pres':'angelo@hcps.test'}, serialIds:GATES.SERIAL, tables:{
    staff_users:[{email:'rep@hcps.test',role:'rep',active:true},{email:'old@hcps.test',role:'president',active:false},{email:'angelo@hcps.test',role:'president',active:true}],
    manufacturer_meta:[{slug:'n1'}], product_skus:[], mfr_decisions:[], mfr_verification_runs:[], mfr_sources:[] }});
  const C=M.load('catalog-api.js',W,{ORDERING_BASE:'https://ordering.test'},ROOT);
  const as=(tok,b)=>M.call(C,b,{headers:tok?{authorization:'Bearer '+tok}:{}});
  const acts=[{action:'mc_overview'},{action:'mc_match',manufacturer:'n1'},{action:'mc_structure',manufacturer:'n1'},{action:'mc_commercial',manufacturer:'n1'},
    {action:'mc_register_source',manufacturer:'n1',kind:'price_list',title:'T',received_date:'2026-10-10'},{action:'mc_accept_source',manufacturer:'n1',source_id:1,reason:'r'},
    {action:'mc_import_source_rows',manufacturer:'n1',source_id:1,rows:[{code:'A'}]},{action:'mc_record_decision',manufacturer:'n1',kind:'interpretation',field:'uom',reason:'r'},
    {action:'mc_approve_gate',manufacturer:'n1',gate:'stage',plan_hash:H,plan_kind:'records',reason:'r'},{action:'mc_set_freight_terms',manufacturer:'n1',terms:{groups:[]},trace:{source_id:1}},
    {action:'stage_record_source',manufacturer:'n1',source_file:'f',rows:[{code:'A',base_price:1}]},{action:'set_record_authority',manufacturer:'n1',authoritative:true,confirm_parity:true},
    {action:'mc_verify',manufacturer:'n1',phase:'pre'},{action:'mc_compare_runs',a:1,b:2}];
  const before=W.writes.length;
  for(const a of acts){
    eq((await as('tok-rep',a)).status,403,'rep: '+a.action); eq((await as('tok-old',a)).status,401,'inactive president: '+a.action);
    eq((await as('tok-bad',a)).status,401,'bad token: '+a.action); eq((await as(null,a)).status,401,'no token: '+a.action); }
  eq(W.writes.length,before,'nothing written');
  ok(!W.calls.some(c=>/\/rest\/v1\/(mfr_|product_skus|manufacturer_meta|price_imports)/.test(c.url)),'no line data was even read for a refused caller');
  eq((await as('tok-pres',{action:'mc_overview'})).status===403,false,'the president gets through');
});
console.log(`mc approval gates: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

/* Manufacturer Center Release A — the content freeze through the REAL handlers (catalog-api, product-content,
   images-api) against the in-memory PostgREST fake. The database guard itself is proven in
   test/mc-content-freeze.pg.test.js; here: every content write a function offers is refused on a frozen line
   before anything is written, with a plain 423; an unfrozen line is untouched; a regression_fix opens one
   request and is spent; an enrichment window opens hidden-draft work in product-content only (never
   publishing, never another line, never once closed, never images-api or catalog-api); windows are opened
   and closed only through their own actions, with dry runs; the self-test reports content rows beside the
   commercial ones and fails when the content guard is missing; the database's own refusal reads as 423. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const MC=require(path.join(ROOT,'_mc.js'));
const OB='https://ordering.test';
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const clone=v=>JSON.parse(JSON.stringify(v));
const NOW='2026-10-11T12:00:00Z';
function seed(){ return {
  manufacturer_meta:[{slug:'bemis',frozen:true,frozen_at:NOW,frozen_reason:'Gold Standard',record_authoritative:true,category_map:{},logo_url:'b.jpg',enriched_only:false,active:true},
    {slug:'ovation-medical',frozen:true,frozen_at:NOW,frozen_reason:'Gold Standard',record_authoritative:true,category_map:{},logo_url:'o.jpg',enriched_only:false,active:true},
    {slug:'pedifix',frozen:false,record_authoritative:false,category_map:{},logo_url:'p.jpg',enriched_only:false,active:true}],
  product_content:[{id:'pc1',manufacturer:'ovation-medical',page_key:'gen2',name:'Gen 2',status:'published',disabled:false,category:'Bracing',skus:[{sku:'61000-210'}],images_gallery:[],image:null},
    {id:'pc2',manufacturer:'pedifix',page_key:'p1',name:'PediFix',status:'pending_review',disabled:false,category:'Bracing',skus:[{sku:'P1'}],images_gallery:[],image:null},
    {id:'pc3',manufacturer:'bemis',page_key:'draft1',name:'Assurance draft',status:'pending_review',disabled:false,category:'Bath Safety',skus:[{sku:'7YR05310TSS'}],images_gallery:[],image:null}],
  product_content_history:[{id:1,manufacturer:'ovation-medical',page_key:'gen2',action:'set_meta',before:[{manufacturer:'ovation-medical',page_key:'gen2',name:'Old'}],after:[],undone:false}],
  product_content_sources:[], product_related:[], product_overrides:[{manufacturer:'bemis',code:'7YR05310TSS',patch:{image:'a.jpg'}}],
  custom_products:[{manufacturer:'bemis',code:'444DISPLAY',name:'Display',base_price:634.86,active:true},{manufacturer:'pedifix',code:'P1',name:'P1',base_price:5,active:true}],
  product_media:[{id:'m1',manufacturer:'ovation-medical',code:'61000-210',kind:'image',url:'x.jpg',sort:0},{id:'m2',manufacturer:'pedifix',code:'P1',kind:'image',url:'p.jpg',sort:0}],
  product_links:[], product_images:[{manufacturer:'bemis',code:'7YR05310TSS',url:'legacy.jpg'},{manufacturer:'pedifix',code:'P1',url:'legacy-p.jpg'}],
  featured_products:[], product_skus:[{manufacturer:'bemis',code:'7YR05310TSS',status:'active',base_price:109.98}],
  mfr_decisions:[{id:11,manufacturer:'ovation-medical',kind:'regression_fix',field:'image',reason:'fix the Gen 2 photo',decided_by:'Angelo',used_at:null},
    {id:12,manufacturer:'ovation-medical',kind:'regression_fix',field:'x',reason:'spent',decided_by:'Angelo',used_at:NOW},
    {id:13,manufacturer:'bemis',kind:'enrichment_window',field:'enrichment_window',reason:'Bemis product pages',decided_by:'Angelo',used_at:null},
    {id:14,manufacturer:'bemis',kind:'interpretation',field:'uom',reason:'not a window',decided_by:'Angelo',used_at:null}],
  mfr_sources:[], mfr_verification_runs:[], staff_users:[{email:'angelo@hcps.us',role:'president',active:true}] }; }
function world(opts){
  opts=opts||{};
  const W=M.createWorld({tables:Object.assign(seed(),opts.tables||{})});
  W.tokens['pres']='angelo@hcps.us';
  const inner=W.fetch; W.stored=[];
  W.fetch=async(u,o)=>{ u=String(u); const m=((o&&o.method)||'GET').toUpperCase();
    for(const f of (opts.failOn||[])) if(f.method===m && u.includes(f.match)) return {ok:false,status:f.status||500,headers:{get:()=>null},text:async()=>f.body||'boom',json:async()=>JSON.parse(f.body||'{}')};
    if(u.startsWith(OB+'/data/manufacturers.json')){ const L=[{slug:'bemis',name:'BEMIS Assurance'},{slug:'ovation-medical',name:'Ovation Medical'},{slug:'pedifix',name:'PediFix'}];
      return {ok:true,status:200,json:async()=>L,text:async()=>JSON.stringify(L)}; }
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,text:async()=>'',json:async()=>null};
    if(u.includes('/storage/v1/object/')){ W.stored.push(u); return {ok:true,status:200,headers:{get:()=>null},text:async()=>'{}',json:async()=>({}),arrayBuffer:async()=>new ArrayBuffer(4)}; }
    if(u.includes('/rest/v1/rpc/mfr_freeze_guard_selftest')) return {ok:true,status:200,text:async()=>JSON.stringify(opts.commercialSelftest||[{line:'bemis',attempt:'record price +1 cent',result:'blocked'}]),json:async()=>opts.commercialSelftest};
    if(u.includes('/rest/v1/rpc/mfr_content_guard_selftest')){ if(opts.noContentGuard) return {ok:false,status:404,text:async()=>'{"code":"PGRST202"}',json:async()=>({})};
      return {ok:true,status:200,text:async()=>JSON.stringify(opts.contentSelftest||[{line:'bemis',attempt:'add a draft page',result:'blocked',expect:'blocked'},{line:'bemis',attempt:'window: add a hidden draft page',result:'allowed',expect:'allowed'},{line:'bemis',attempt:'edit a live page',result:'nothing to try',expect:'blocked'}])}; }
    return inner(u,o); };
  return W;
}
const load=(W,f)=>M.load(f,W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const asPres=(C,b)=>M.call(C,b,{token:'pres'});
const asCat=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
const snap=W=>JSON.stringify(Object.keys(W.db).filter(k=>k!=='mfr_decisions').sort().map(k=>[k,W.db[k]]));
const writesTo=(W,re)=>W.calls.filter(c=>c.method!=='GET' && re.test(String(c.url)));

const PC_WRITES=[
  {action:'set_meta',page_key:'gen2',patch:{name:'x'}}, {action:'set_content',page_key:'gen2',patch:{description:'x'}},
  {action:'save_fields',page_key:'gen2',patch:{category:'x'}}, {action:'set_status',page_key:'gen2',status:'hidden'},
  {action:'set_status',page_key:'gen2',status:'published'}, {action:'create_product',page_key:'new',name:'New'},
  {action:'delete_product',page_key:'gen2'}, {action:'split',page_key:'gen2',skus:['61000-210'],name:'x'},
  {action:'move_skus',page_key:'gen2',to:'other',skus:['61000-210']}, {action:'set_sku',page_key:'gen2',sku:{sku:'Z'}},
  {action:'save_skus',page_key:'gen2',skus:[{sku:'61000-210'}]}, {action:'remove_skus',page_key:'gen2',skus:['61000-210']},
  {action:'rename_sku',page_key:'gen2',from:'61000-210',to:'X'}, {action:'merge_products',page_key:'gen2',from:['x']},
  {action:'bulk',page_keys:['gen2'],patch:{status:'hidden'}}, {action:'save_sizing',page_key:'gen2',rows:[]},
  {action:'upload_image',page_key:'gen2',filename:'a.jpg',contentType:'image/jpeg',data:'AAAA'}, {action:'upload_file',page_key:'gen2',filename:'a.pdf',contentType:'application/pdf',data:'AAAA'},
  {action:'rehost',page_key:'gen2',url:'https://elsewhere.test/a.jpg'}, {action:'ingest_source',page_key:'gen2',source:'website',data:{name:'x'}},
  {action:'approve',page_key:'gen2',patch:{name:'x'}}, {action:'reject',page_key:'gen2'}, {action:'approve_all'},
  {action:'upsert',rows:[{manufacturer:'ovation-medical',page_key:'gen2',name:'x'}]}, {action:'save_related',page_key:'gen2',code:'61000-210',items:[]},
  {action:'undo',id:1}];

(async()=>{
await t('rules: every product-content write is listed; a window covers only hidden-draft work and never publishing',async()=>{
  eq(PC_WRITES.map(x=>x.action).filter((a,i,s)=>s.indexOf(a)===i).sort(),[...MC.PC_WRITE_ACTIONS].filter(a=>a!=='recategorize').sort());
  ok(!MC.PC_WINDOW_ACTIONS.has('save_related') && !MC.PC_WINDOW_ACTIONS.has('recategorize'),'related and cross-line moves are outside');
  eq(MC.windowProblem({action:'set_status',status:'published'})!==null,true); eq(MC.windowProblem({action:'set_status',status:'hidden'}),null);
  eq(MC.windowProblem({action:'bulk',patch:{status:'active'}})!==null,true); eq(MC.windowProblem({action:'upsert',rows:[{status:'discontinued'}]})!==null,true);
  eq(MC.windowProblem({action:'create_product'}),null);
  eq(['save_override','set_category','set_category_map','set_category_order','clear_derived_categories','set_listing_mode','add_media','update_media','delete_media','reorder_media','save_link','clear_link','save_logo','clear_logo'].every(a=>MC.isFrozenProtected({action:a})),true);
  eq(MC.isFrozenProtected({action:'set_featured'}),false,'featured tiles are outside the freeze (documented)');
  eq(MC.exceptionProblem({id:1,kind:'enrichment_window',manufacturer:'bemis',used_at:NOW},'enrichment_window','bemis'),'the enrichment window 1 is closed');
});

await t('product-content: every write on a frozen line is refused 423 before anything is written',async()=>{
  for(const p of PC_WRITES){
    const W=world(); const C=load(W,'product-content.js'); const before=snap(W);
    const r=await asPres(C,Object.assign({manufacturer:'ovation-medical'},p));
    eq([r.status,r.body.error],[423,'line_frozen'],p.action+': '+JSON.stringify(r.body).slice(0,200));
    eq(snap(W),before,p.action+' wrote nothing'); eq(W.stored.length,0,p.action+' stored no file');
  }
});
await t('product-content: reads still work on a frozen line; an unfrozen line is untouched',async()=>{
  const W=world(); const C=load(W,'product-content.js');
  for(const p of [{action:'history'},{action:'structure_review'},{action:'taxonomy'},{action:'find_duplicates',candidate:{name:'x'}}]){
    const r=await asPres(C,Object.assign({manufacturer:'ovation-medical'},p)); ok(r.status!==423,p.action+' was refused: '+JSON.stringify(r.body).slice(0,200)); }
  const r=await asPres(C,{action:'set_meta',manufacturer:'pedifix',page_key:'p1',patch:{name:'PediFix 2'}});
  eq(r.status,200,JSON.stringify(r.body)); eq(W.db.product_content.find(x=>x.page_key==='p1').name,'PediFix 2');
});
await t('product-content: undo of a frozen line\'s change is refused even when the request names another line',async()=>{
  const W=world(); const C=load(W,'product-content.js'); const before=snap(W);
  const r=await asPres(C,{action:'undo',manufacturer:'pedifix',id:1}); eq([r.status,r.body.error],[423,'line_frozen']); eq(snap(W),before);
});
await t('product-content: a regression_fix of that line opens one request, rides on the write, and is spent',async()=>{
  const W=world(); const C=load(W,'product-content.js');
  const r=await asPres(C,{action:'set_meta',manufacturer:'ovation-medical',page_key:'gen2',patch:{name:'Gen 2 (fixed)'},regression_fix:{decision_id:11,reason:'photo was wrong'}});
  eq(r.status,200,JSON.stringify(r.body)); eq(W.db.product_content.find(x=>x.page_key==='gen2').name,'Gen 2 (fixed)');
  ok(writesTo(W,/product_content\?/).every(c=>c.headers['x-hcps-regression-fix']==='11'),'the fix rides on the write');
  ok(W.db.mfr_decisions.find(d=>d.id===11).used_at,'spent');
  const again=await asPres(C,{action:'set_meta',manufacturer:'ovation-medical',page_key:'gen2',patch:{name:'again'},regression_fix:{decision_id:11,reason:'again'}});
  eq([again.status,again.body.error],[423,'regression_fix_invalid']);
  for(const [id,why] of [[12,'spent'],[13,'a window is not a fix']]){
    const x=await asPres(C,{action:'set_meta',manufacturer:'ovation-medical',page_key:'gen2',patch:{name:'x'},regression_fix:{decision_id:id,reason:'r'}});
    eq(x.status,423,why); }
  const noReason=await asPres(C,{action:'set_meta',manufacturer:'ovation-medical',page_key:'gen2',patch:{name:'x'},regression_fix:{decision_id:11}});
  eq(noReason.status,400);
});
await t('product-content: Bemis\'s enrichment window opens hidden-draft work, with the window on every write',async()=>{
  const W=world(); const C=load(W,'product-content.js');
  for(const p of [{action:'create_product',page_key:'assurance',name:'Assurance Raised Seat'},{action:'set_content',page_key:'draft1',patch:{description:'From the Assurance page'}},
                  {action:'save_fields',page_key:'draft1',patch:{category:'Bath Safety',subcategory:'Toilet Seats'}},{action:'ingest_source',page_key:'draft1',source:'website',data:{name:'x'}},
                  {action:'set_status',page_key:'draft1',status:'approved'}]){
    const r=await asPres(C,Object.assign({manufacturer:'bemis',enrichment_window:{decision_id:13}},p));
    ok(r.status!==423 && r.status<500,p.action+': '+JSON.stringify(r.body).slice(0,200)); }
  const w=W.calls.filter(c=>c.method!=='GET' && /product_content/.test(c.url) && !/history/.test(c.url));
  ok(w.length>0 && w.every(c=>c.headers['x-hcps-enrichment-window']==='13'),'the window rides on every content write');
  ok(!W.db.mfr_decisions.find(d=>d.id===13).used_at,'a window is not spent by using it');
});
await t('product-content: the window never publishes, never reaches related products or another line, and a closed or wrong one opens nothing',async()=>{
  const cases=[[{action:'set_status',manufacturer:'bemis',page_key:'draft1',status:'published',enrichment_window:{decision_id:13}},'outside_enrichment_window'],
    [{action:'bulk',manufacturer:'bemis',page_keys:['draft1'],patch:{status:'active'},enrichment_window:{decision_id:13}},'outside_enrichment_window'],
    [{action:'upsert',manufacturer:'bemis',rows:[{manufacturer:'bemis',page_key:'x',status:'published'}],enrichment_window:{decision_id:13}},'outside_enrichment_window'],
    [{action:'save_related',manufacturer:'bemis',page_key:'draft1',code:'7YR05310TSS',items:[],enrichment_window:{decision_id:13}},'outside_enrichment_window'],
    [{action:'set_meta',manufacturer:'ovation-medical',page_key:'gen2',patch:{name:'x'},enrichment_window:{decision_id:13}},'enrichment_window_invalid'],
    [{action:'set_meta',manufacturer:'bemis',page_key:'draft1',patch:{name:'x'},enrichment_window:{decision_id:14}},'enrichment_window_invalid'],
    [{action:'set_meta',manufacturer:'bemis',page_key:'draft1',patch:{name:'x'},enrichment_window:{decision_id:'abc'}},'enrichment_window_incomplete']];
  for(const [b,err] of cases){ const W=world(); const C=load(W,'product-content.js'); const before=snap(W);
    const r=await asPres(C,b); eq(r.body.error,err,JSON.stringify(b)); eq(snap(W),before,'nothing written: '+b.action); }
  const W=world(); W.db.mfr_decisions.find(d=>d.id===13).used_at=NOW; const C=load(W,'product-content.js');
  const r=await asPres(C,{action:'set_meta',manufacturer:'bemis',page_key:'draft1',patch:{name:'x'},enrichment_window:{decision_id:13}});
  eq([r.status,r.body.error],[423,'enrichment_window_invalid'],'a closed window'); ok(/closed/.test(r.body.message),r.body.message);
});
await t('product-content: a change spanning a frozen line and another is refused whole; re-categorize skips frozen lines and names them',async()=>{
  let W=world(), C=load(W,'product-content.js'), before=snap(W);
  const r=await asPres(C,{action:'upsert',manufacturer:'pedifix',rows:[{manufacturer:'pedifix',page_key:'p1',name:'x'},{manufacturer:'bemis',page_key:'draft1',name:'x'}]});
  eq([r.status,r.body.error],[423,'line_frozen']); eq(snap(W),before);
  /* an exception covers its own line only: a fix for Ovation sent with Bemis rows refuses the whole request (never half-written) */
  W=world(); C=load(W,'product-content.js'); before=snap(W);
  const both=await asPres(C,{action:'upsert',manufacturer:'ovation-medical',rows:[{manufacturer:'ovation-medical',page_key:'gen2',name:'x'},{manufacturer:'bemis',page_key:'draft1',name:'x'}],regression_fix:{decision_id:11,reason:'r'}});
  eq([both.status,both.body.error],[423,'line_frozen'],JSON.stringify(both.body)); ok(/one line at a time/.test(both.body.message),both.body.message);
  eq(snap(W),before); ok(!W.db.mfr_decisions.find(d=>d.id===11).used_at,'the fix is not spent');
  W=world(); C=load(W,'product-content.js');
  const rc=await asPres(C,{action:'recategorize',from:'Bracing',to:'Orthopedic Bracing & Supports'});
  eq([rc.status,rc.body.updated,rc.body.skipped_frozen],[200,1,['ovation-medical']],JSON.stringify(rc.body));
  eq(W.db.product_content.map(x=>x.manufacturer+':'+x.category).sort(),['bemis:Bath Safety','ovation-medical:Bracing','pedifix:Orthopedic Bracing & Supports']);
});
await t('product-content: a freeze state that can\'t be read refuses; the database\'s own refusal reads as 423',async()=>{
  let W=world({failOn:[{method:'GET',match:'/rest/v1/manufacturer_meta'}]}), C=load(W,'product-content.js'), before=snap(W);
  let r=await asPres(C,{action:'set_meta',manufacturer:'pedifix',page_key:'p1',patch:{name:'x'}}); eq([r.status,r.body.error],[503,'freeze_state_unreadable']); eq(snap(W),before);
  W=world({failOn:[{method:'PATCH',match:'/rest/v1/product_content?',status:400,body:'{"code":"P0001","message":"line_frozen: pedifix is frozen (Gold Standard). A change to product_content needs a regression_fix decision."}'}]});
  C=load(W,'product-content.js');
  r=await asPres(C,{action:'set_status',manufacturer:'pedifix',page_key:'p1',status:'hidden'});
  eq([r.status,r.body.error],[423,'line_frozen'],JSON.stringify(r.body)); ok(/pedifix is frozen/.test(r.body.message),r.body.message);
});
await t('product-content: approve keeps only editable fields and is logged',async()=>{
  const W=world(); const C=load(W,'product-content.js');
  const r=await asPres(C,{action:'approve',manufacturer:'pedifix',page_key:'p1',patch:{name:'Approved name',status:'published',disabled:false,manufacturer:'bemis',page_key:'evil'}});
  eq(r.status,200,JSON.stringify(r.body)); const p=W.db.product_content.find(x=>x.id==='pc2');
  eq([p.name,p.status,p.manufacturer,p.page_key],['Approved name','approved','pedifix','p1'],'status, line and key are not patchable');
  ok(W.db.product_content_history.some(h=>h.action==='approve'&&h.manufacturer==='pedifix'),'logged');
});

await t('images-api: on a frozen line upload, clear and an applied migration are refused; a dry run and an unfrozen line are not',async()=>{
  for(const b of [{action:'upload',manufacturer:'bemis',code:'7YR05310TSS',filename:'a.jpg',contentType:'image/jpeg',data:'AAAA'},{action:'clear',manufacturer:'bemis',code:'7YR05310TSS'},
                  {action:'migrate_legacy',manufacturer:'bemis',apply:true},{action:'upload',manufacturer:'bemis',code:'7YR05310TSS',filename:'a.jpg',contentType:'image/jpeg',data:'AAAA',enrichment_window:{decision_id:13}}]){
    const W=world(); const C=load(W,'images-api.js'); const before=snap(W);
    const r=await asCat(C,b); eq([r.status,r.body.error],[423,b.enrichment_window?'outside_enrichment_window':'line_frozen'],b.action+': '+JSON.stringify(r.body).slice(0,200)); eq(snap(W),before); eq(W.stored.length,0,'no file stored');
    if(b.enrichment_window) ok(/never opens catalog-layer images/.test(r.body.message),'images-api refuses a window outright: '+r.body.message); }
  const W=world(); const C=load(W,'images-api.js');
  const dry=await asCat(C,{action:'migrate_legacy',manufacturer:'bemis'}); eq(dry.status,200,'a dry run reads only');
  const all=await asCat(C,{action:'migrate_legacy',apply:true}); eq([all.status,all.body.skipped_frozen],[200,['bemis']],JSON.stringify(all.body).slice(0,300));
  ok(!writesTo(W,/manufacturer=eq\.bemis|"manufacturer":"bemis"/).length && !W.calls.some(c=>c.method!=='GET'&&c.body&&JSON.stringify(c.body).includes('"bemis"')),'nothing written for Bemis');
});
await t('images-api: a regression_fix of that line opens the write and is spent',async()=>{
  const W=world({tables:{mfr_decisions:seed().mfr_decisions.concat([{id:21,manufacturer:'bemis',kind:'regression_fix',field:'image',reason:'wrong photo',decided_by:'Angelo',used_at:null}])}});
  const C=load(W,'images-api.js');
  const r=await asCat(C,{action:'clear',manufacturer:'bemis',code:'444DISPLAY',regression_fix:{decision_id:21,reason:'wrong photo'}});
  eq(r.status,200,JSON.stringify(r.body).slice(0,200));
  const w=W.calls.filter(c=>c.method!=='GET'&&/product_overrides|custom_products|product_content\?/.test(c.url));
  ok(w.length>0 && w.every(c=>c.headers['x-hcps-regression-fix']==='21'),'the fix rides on the write ('+w.length+')');
  ok(W.db.mfr_decisions.find(d=>d.id===21).used_at,'spent');
});

const CAT_CONTENT=[{action:'save_override',manufacturer:'bemis',code:'7YR05310TSS',patch:{name:'x'}},{action:'save_override',manufacturer:'bemis',code:'7YR05310TSS',patch:{image:'y.jpg'}},
  {action:'set_category',manufacturer:'bemis',code:'444DISPLAY',category:'x'},{action:'set_category_map',manufacturer:'bemis',map:{}},{action:'set_category_order',manufacturer:'bemis',order:[]},
  {action:'clear_derived_categories',manufacturer:'bemis'},{action:'set_listing_mode',manufacturer:'bemis',enriched_only:true},
  {action:'add_media',manufacturer:'ovation-medical',code:'61000-210',kind:'image',url:'n.jpg'},{action:'update_media',id:'m1',title:'x'},{action:'delete_media',id:'m1'},{action:'reorder_media',ids:['m1']},
  {action:'save_link',manufacturer:'bemis',code:'7YR05310TSS',url:'https://x'},{action:'clear_link',manufacturer:'bemis',code:'7YR05310TSS'},
  {action:'save_logo',slug:'bemis',url:'new.jpg'},{action:'clear_logo',slug:'ovation-medical'}];
await t('catalog-api: every content action on a frozen line is refused 423 before anything is written (media rows by their line)',async()=>{
  for(const b of CAT_CONTENT){ const W=world(); const C=load(W,'catalog-api.js'); const before=snap(W);
    const r=await asCat(C,b); eq([r.status,r.body.error],[423,'line_frozen'],b.action+': '+JSON.stringify(r.body).slice(0,200)); eq(snap(W),before,b.action);
    ok(/protected like its prices/.test(r.body.message),r.body.message); }
});
await t('catalog-api: the same actions on an unfrozen line are not refused; featured tiles stay outside the freeze',async()=>{
  for(const b of [{action:'save_override',manufacturer:'pedifix',code:'P1',patch:{name:'x'}},{action:'set_listing_mode',manufacturer:'pedifix',enriched_only:true},
                  {action:'update_media',id:'m2',title:'x'},{action:'save_logo',slug:'pedifix',url:'n.jpg'},{action:'set_featured',manufacturer:'bemis',code:'7YR05310TSS'}]){
    const W=world(); const C=load(W,'catalog-api.js'); const r=await asCat(C,b); ok(r.status!==423,b.action+': '+JSON.stringify(r.body).slice(0,200)); }
});
await t('catalog-api: a regression_fix opens a content action on its own line and is spent',async()=>{
  const W=world(); const C=load(W,'catalog-api.js');
  const r=await asCat(C,{action:'delete_media',id:'m1',regression_fix:{decision_id:11,reason:'duplicate photo'}});
  eq(r.status,200,JSON.stringify(r.body)); ok(!W.db.product_media.some(x=>x.id==='m1'),'deleted'); ok(W.db.mfr_decisions.find(d=>d.id===11).used_at,'spent');
});
await t('catalog-api: an enrichment window never opens catalog-api',async()=>{
  const W=world(); const C=load(W,'catalog-api.js'); const before=snap(W);
  const r=await asCat(C,{action:'save_override',manufacturer:'bemis',code:'7YR05310TSS',patch:{name:'x'},enrichment_window:{decision_id:13}});
  eq([r.status,r.body.error],[423,'line_frozen']); eq(snap(W),before);
});
await t('windows: opened only through mc_open_enrichment_window (dry run first, frozen lines only, one at a time) and closed by a stamp',async()=>{
  const W=world({tables:{mfr_decisions:seed().mfr_decisions.filter(d=>d.id!==13)}}); const C=load(W,'catalog-api.js');
  eq((await asCat(C,{action:'mc_open_enrichment_window',manufacturer:'bemis'})).status,400,'a reason is required');
  const dry=await asCat(C,{action:'mc_open_enrichment_window',manufacturer:'bemis',reason:'Bemis product pages',dry_run:true});
  eq([dry.status,dry.body.would_record.kind,dry.body.would_record.hcps_value.scope],[200,'enrichment_window','content_drafts']);
  ok(dry.body.would_record.hcps_value.may_not_change.includes('dealer price')&&dry.body.would_record.hcps_value.may_not_change.includes('MSRP / MAP'),'the scope says what it can\'t touch');
  eq(W.db.mfr_decisions.filter(d=>d.kind==='enrichment_window').length,0,'the dry run recorded nothing');
  const open=await asCat(C,{action:'mc_open_enrichment_window',manufacturer:'bemis',reason:'Bemis product pages'}); eq(open.status,200,JSON.stringify(open.body));
  eq((await asCat(C,{action:'mc_open_enrichment_window',manufacturer:'bemis',reason:'again'})).body.error,'window_already_open');
  eq((await asCat(C,{action:'mc_open_enrichment_window',manufacturer:'pedifix',reason:'x'})).body.error,'not_frozen');
  eq((await asCat(C,{action:'mc_record_decision',manufacturer:'bemis',kind:'enrichment_window',field:'enrichment_window',reason:'sneak'})).body.error,'window_not_here');
  const ov=await asCat(C,{action:'mc_overview'}); ok(ov.body.lines.find(l=>l.slug==='bemis').enrichment_window===open.body.window.id,'overview shows the open window');
  const cdry=await asCat(C,{action:'mc_close_enrichment_window',manufacturer:'bemis',dry_run:true}); eq([cdry.status,!!cdry.body.would_close],[200,true]);
  ok(!W.db.mfr_decisions.find(d=>d.id===open.body.window.id).used_at,'the dry run closed nothing');
  const close=await asCat(C,{action:'mc_close_enrichment_window',manufacturer:'bemis'}); eq(close.status,200);
  ok(W.db.mfr_decisions.find(d=>d.id===open.body.window.id).used_at,'closed by its stamp');
  eq((await asCat(C,{action:'mc_close_enrichment_window',manufacturer:'bemis'})).body.error,'no_open_window');
});
await t('self-test: content rows beside the commercial ones, judged against what each expects; a missing content guard fails',async()=>{
  let W=world(); let C=load(W,'catalog-api.js'); let r=await asCat(C,{action:'mc_guard_selftest'});
  eq([r.status,r.body.pass,r.body.counts.commercial,r.body.counts.content,r.body.not_blocked.length],[200,true,1,3,0],JSON.stringify(r.body).slice(0,300));
  W=world({contentSelftest:[{line:'bemis',attempt:'add a gallery image',result:'NOT BLOCKED',expect:'blocked'}]}); C=load(W,'catalog-api.js'); r=await asCat(C,{action:'mc_guard_selftest'});
  eq([r.body.pass,r.body.not_blocked.length],[false,1]);
  W=world({contentSelftest:[{line:'bemis',attempt:'window: add a hidden draft page',result:'blocked',expect:'allowed'}]}); C=load(W,'catalog-api.js'); r=await asCat(C,{action:'mc_guard_selftest'});
  eq(r.body.pass,false,'a window that does not open is a failure too');
  W=world({noContentGuard:true}); C=load(W,'catalog-api.js'); r=await asCat(C,{action:'mc_guard_selftest'});
  eq([r.body.pass,!!r.body.content_error],[false,true]);
});
console.log(`mc content freeze (functions): ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

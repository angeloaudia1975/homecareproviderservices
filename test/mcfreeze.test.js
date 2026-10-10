/* Manufacturer Center Phase 2 — the freeze and safe staging, through the real catalog-api.
   (The database half of the freeze — mfr_freeze_guard — is tested against Postgres by
   test/mc-guard.pg.test.js.) */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const OB='https://ordering.test', FROZEN='bemis', OPEN='pedifix', FILE='Bemis Digital Price List 2026(20261010-175622).xlsx';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
function world(extra, opts){
  const W=M.createWorld(Object.assign({tables:Object.assign({
    manufacturer_meta:[{slug:FROZEN,frozen:true,record_authoritative:true},{slug:OPEN,frozen:false},{slug:'stage-line'}],
    product_content:[], custom_products:[], product_overrides:[{manufacturer:FROZEN,code:'7YR05310TSS',patch:{base_price:109.98}}],
    product_skus:[{manufacturer:FROZEN,code:'7YR05310TSS',base_price:109.98,msrp:109.99,map:109.99,status:'active',uom:'Case',case_qty:2}],
    mfr_decisions:[{id:7,manufacturer:FROZEN,kind:'regression_fix',field:'base_price',reason:'regression found',used_at:null},
                   {id:8,manufacturer:FROZEN,kind:'interpretation',field:'uom',reason:'x',used_at:null},
                   {id:9,manufacturer:OPEN,kind:'regression_fix',field:'x',reason:'other line',used_at:null},
                   {id:10,manufacturer:'stage-line',kind:'interpretation',field:'map',reason:'MAP withdrawn by the manufacturer',used_at:null}],
    mfr_sources:[{id:3,manufacturer:'stage-line',kind:'price_list',title:'List 2027',file_name:'list-2027.xlsx',status:'accepted',manufacturer_effective_date:'2027-01-01'},
                 {id:4,manufacturer:'stage-line',kind:'price_list',title:'Draft',file_name:'draft.xlsx',status:'under_review'}]},extra||{})},opts||{}));
  const inner=W.fetch; W.fetch=async(u,o)=>{ u=String(u); if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); const r=await inner(u,o); (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return r; };
  return W; }
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
const layerWrites=W=>W.writes.filter(w=>['product_skus','custom_products','product_overrides','manufacturer_meta'].includes(w.table));
(async()=>{
await t('frozen line: a price edit is refused before anything is written',async()=>{
  const W=world(); const C=mod(W); const n=W.writes.length;
  const r=await call(C,{action:'save_override',manufacturer:FROZEN,code:'7YR05310TSS',patch:{base_price:1}});
  eq([r.status,r.body.error],[423,'line_frozen']); eq(W.writes.length,n,'nothing written');
  eq(W.db.product_skus[0].base_price,109.98);
});
await t('frozen line: every commercial action is refused (staging, provenance, authority off, bulk price, retire, group)',async()=>{
  for(const b of [{action:'stage_record_source',source_file:'x',rows:[{code:'7YR05310TSS',base_price:1}]},
                  {action:'set_record_provenance',source_file:'x',codes:['7YR05310TSS']},
                  {action:'set_record_authority',authoritative:false},
                  {action:'bulk_price',rows:[{code:'7YR05310TSS',base_price:1}]},
                  {action:'retire_sku',code:'7YR05310TSS'},
                  {action:'set_group',code:'7YR05310TSS',group:'x'},
                  {action:'reconcile',apply:true}]){
    const W=world(); const C=mod(W); const n=W.writes.length;
    const r=await call(C,Object.assign({manufacturer:FROZEN},b));
    eq([b.action,r.status,r.body.error],[b.action,423,'line_frozen']); eq(W.writes.length,n,b.action+' wrote');
  }
});
await t('frozen line: a non-commercial edit (image only) still goes through',async()=>{
  const W=world(); const C=mod(W);
  const r=await call(C,{action:'save_override',manufacturer:FROZEN,code:'7YR05310TSS',patch:{image:'https://x/y.jpg'}});
  eq(r.status,200,JSON.stringify(r.body)); eq(W.db.product_overrides[0].patch.image,'https://x/y.jpg');
});
await t('frozen line: read-only reconcile still answers (no apply)',async()=>{
  const W=world(); const C=mod(W); const r=await call(C,{action:'reconcile',manufacturer:FROZEN}); eq(r.status,200,JSON.stringify(r.body).slice(0,200));
});
await t('unfrozen line: commercial actions proceed as before',async()=>{
  const W=world(); const C=mod(W);
  const r=await call(C,{action:'save_override',manufacturer:OPEN,code:'P1',patch:{base_price:5}}); eq(r.status,200,JSON.stringify(r.body));
});
await t('freeze state unreadable: the commercial action is refused, nothing written',async()=>{
  const W=world(null,{failRead:(tb)=>tb==='manufacturer_meta'?500:0}); const C=mod(W); const n=W.writes.length;
  const r=await call(C,{action:'save_override',manufacturer:OPEN,code:'P1',patch:{base_price:5}});
  eq([r.status,r.body.error],[503,'freeze_state_unreadable']); eq(W.writes.length,n);
});
await t('regression_fix: an unused fix for this line lets the change through, carries the token to the database, and is spent',async()=>{
  const W=world(); const C=mod(W);
  const r=await call(C,{action:'save_override',manufacturer:FROZEN,code:'7YR05310TSS',patch:{base_price:109.97},regression_fix:{decision_id:7,reason:'regression found'}});
  eq(r.status,200,JSON.stringify(r.body));
  const w=W.calls.filter(c=>c.method!=='GET'&&/product_skus|product_overrides/.test(c.url));
  ok(w.length&&w.every(c=>c.headers['x-hcps-regression-fix']==='7'),'every layer write carries the token: '+JSON.stringify(w.map(c=>c.headers['x-hcps-regression-fix'])));
  const d=W.db.mfr_decisions.find(x=>x.id===7); ok(d.used_at,'decision marked used');
  const again=await call(C,{action:'save_override',manufacturer:FROZEN,code:'7YR05310TSS',patch:{base_price:109.96},regression_fix:{decision_id:7,reason:'again'}});
  eq([again.status,again.body.error],[423,'regression_fix_invalid'],'single use');
});
await t('regression_fix: a decision of another kind or another line, or no reason, is refused',async()=>{
  for(const [rf,code,err] of [[{decision_id:8,reason:'x'},423,'regression_fix_invalid'],[{decision_id:9,reason:'x'},423,'regression_fix_invalid'],[{decision_id:7},400,'regression_fix_incomplete'],[{decision_id:999,reason:'x'},423,'regression_fix_invalid']]){
    const W=world(); const C=mod(W); const n=layerWrites(W).length;
    const r=await call(C,{action:'save_override',manufacturer:FROZEN,code:'7YR05310TSS',patch:{base_price:1},regression_fix:rf});
    eq([r.status,r.body.error],[code,err],JSON.stringify(rf)); eq(layerWrites(W).length,n);
  }
});
await t('the token is never sent without an approved fix, and is not left over for the next request',async()=>{
  const W=world(); const C=mod(W);
  await call(C,{action:'save_override',manufacturer:FROZEN,code:'7YR05310TSS',patch:{base_price:109.97},regression_fix:{decision_id:7,reason:'r'}});
  const before=W.calls.length;
  await call(C,{action:'save_override',manufacturer:OPEN,code:'P1',patch:{base_price:5}});
  ok(W.calls.slice(before).every(c=>!c.headers['x-hcps-regression-fix']),'no stale token');
});
await t('a database refusal (line_frozen from the trigger) reads as 423, not a 500',async()=>{
  const W=world(); const inner=W.fetch;
  W.fetch=async(u,o)=>{ if(String(u).includes('/rest/v1/product_overrides')&&o&&o.method&&o.method!=='GET') return {ok:false,status:400,text:async()=>JSON.stringify({code:'P0001',message:'line_frozen: pedifix is frozen (Gold Standard).'}),json:async()=>({})}; return inner(u,o); };
  const C=mod(W); const r=await call(C,{action:'save_override',manufacturer:OPEN,code:'P1',patch:{image:'x.jpg'}});
  eq([r.status,r.body.error],[423,'line_frozen']);
});
// ── SAFE STAGING ──
const SL='stage-line';
const stageWorld=()=>world({product_skus:[{manufacturer:SL,code:'A1',base_price:10,msrp:20,map:18,tiers:[{min_qty:2,price:9}],status:'active',uom:'Case',case_qty:4,source_file:'old.xlsx',effective_date:'2026-01-01'}]});
const stage=(C,extra)=>call(C,Object.assign({action:'stage_record_source',manufacturer:SL,source_file:'old.xlsx'},extra));
await t('safe staging: a field the source leaves out is kept (MAP, MSRP, tiers, UOM all survive a price-only row)',async()=>{
  const W=stageWorld(); const C=mod(W);
  const dry=await stage(C,{dry_run:true,rows:[{code:'A1',base_price:11}]}); eq(dry.status,200,JSON.stringify(dry.body));
  const p=dry.body.plan[0]; eq(p.changed,{base_price:[10,11]}); ok(p.not_in_source.includes('map')&&p.not_in_source.includes('tiers')&&p.not_in_source.includes('uom'),'not_in_source');
  const r=await stage(C,{rows:[{code:'A1',base_price:11}]}); eq(r.status,200,JSON.stringify(r.body));
  const rec=W.db.product_skus[0]; eq([rec.base_price,rec.msrp,rec.map,rec.tiers.length,rec.uom,rec.case_qty,rec.effective_date],[11,20,18,1,'Case',4,'2026-01-01']);
});
await t('safe staging: an explicit empty value is "would clear" — reported in the dry run, refused on write',async()=>{
  const W=stageWorld(); const C=mod(W);
  const dry=await stage(C,{dry_run:true,rows:[{code:'A1',base_price:10,map:null,tiers:null}]});
  eq(dry.body.plan[0].would_clear.sort(),['map','tiers']); eq(dry.body.would_clear_refused.map(x=>({code:x.code,fields:x.fields.slice().sort()})),[{code:'A1',fields:['map','tiers']}]);
  const n=W.writes.length; const r=await stage(C,{rows:[{code:'A1',base_price:10,map:null}]});
  eq([r.status,r.body.error],[409,'would_clear']); eq(W.writes.length,n,'nothing written'); eq(W.db.product_skus[0].map,18);
});
await t('safe staging: clearing works only with clear:[field] AND a recorded decision for this line',async()=>{
  let W=stageWorld(), C=mod(W);
  let r=await stage(C,{rows:[{code:'A1',map:null}],clear:['map']}); eq(r.status,409,'no decision');
  r=await stage(C,{rows:[{code:'A1',map:null}],clear:['map'],clear_decision_id:7}); eq(r.status,409,'another line\'s decision');
  r=await stage(C,{rows:[{code:'A1',map:null}],clear:['map'],clear_decision_id:10}); eq(r.status,200,JSON.stringify(r.body));
  eq([W.db.product_skus[0].map,W.db.product_skus[0].msrp],[null,20],'only MAP cleared');
});
await t('safe staging: unchanged values are reported unchanged and not rewritten',async()=>{
  const W=stageWorld(); const C=mod(W);
  const dry=await stage(C,{dry_run:true,rows:[{code:'A1',base_price:10,msrp:20,map:18,uom:'Case',case_qty:4,tiers:[{min_qty:2,price:9}]}]});
  eq(dry.body.plan[0].changed,{}); eq(dry.body.plan[0].unchanged.sort(),['base_price','case_qty','map','msrp','tiers','uom']);
});
await t('safe staging: a new file without a date never inherits the old file\'s effective date',async()=>{
  const W=stageWorld(); const C=mod(W);
  await stage(C,{source_file:'new.xlsx',rows:[{code:'A1',base_price:12}]}); eq([W.db.product_skus[0].source_file,W.db.product_skus[0].effective_date],['new.xlsx',null]);
});
await t('safe staging: a registered, accepted source is stamped with its id and its manufacturer date',async()=>{
  const W=stageWorld(); const C=mod(W);
  const r=await call(C,{action:'stage_record_source',manufacturer:SL,source_id:3,rows:[{code:'A1',base_price:12}]}); eq(r.status,200,JSON.stringify(r.body));
  const rec=W.db.product_skus[0]; eq([rec.source_id,rec.source_file,rec.effective_date],[3,'list-2027.xlsx','2027-01-01']);
  const notAcc=await call(C,{action:'stage_record_source',manufacturer:SL,source_id:4,rows:[{code:'A1',base_price:12}]}); eq([notAcc.status,notAcc.body.error],[409,'source_not_accepted']);
  const other=await call(C,{action:'stage_record_source',manufacturer:OPEN,source_id:3,rows:[{code:'A1',base_price:12}]}); eq([other.status,other.body.error],[400,'unknown_source']);
});
await t('safe staging: the new commercial fields (unit cost, MSRP/MAP basis) are staged and validated',async()=>{
  const W=stageWorld(); const C=mod(W);
  let r=await stage(C,{rows:[{code:'A1',dealer_unit_cost:3.5,msrp_basis:'each',map_basis:'order_unit'}]}); eq(r.status,200,JSON.stringify(r.body));
  eq([W.db.product_skus[0].dealer_unit_cost,W.db.product_skus[0].msrp_basis,W.db.product_skus[0].map_basis,W.db.product_skus[0].base_price],[3.5,'each','order_unit',10]);
  r=await stage(C,{rows:[{code:'A1',msrp_basis:'case'}]}); eq([r.status,r.body.error],[400,'bad_rows']);
});
console.log(`mc freeze + safe staging: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

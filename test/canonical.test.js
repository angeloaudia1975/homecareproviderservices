/* 2.2 — the canonical commercial write path, end to end.
   Loads the REAL catalog-api handler (unmodified file) against the repo's in-memory PostgREST
   fake, plus a fake deployed catalog file. Every assertion is on what the handler wrote. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const OB='https://ordering.test';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };

function world({files, tables, failOn}){
  const W=M.createWorld({tables:Object.assign({manufacturer_meta:[], product_overrides:[], custom_products:[], product_skus:[], product_content:[]}, tables||{})});
  const inner=W.fetch;
  const fixNorm=()=>{ (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); };
  W.fetch=async(url,opts)=>{
    const u=String(url), m=((opts&&opts.method)||'GET').toUpperCase();
    for(const f of (failOn||[])) if(f.method===m && u.includes(f.match)) { W.calls.push({url:u,method:m,failed:true}); return {ok:false,status:500,text:async()=>'boom',json:async()=>({})}; }
    if(u.startsWith(OB+'/data/')){ const slug=decodeURIComponent(u.slice((OB+'/data/').length).replace(/\.json.*$/,''));
      if(!(slug in (files||{}))) return {ok:false,status:404,text:async()=>'',json:async()=>null};
      return {ok:true,status:200,text:async()=>JSON.stringify(files[slug]),json:async()=>JSON.parse(JSON.stringify(files[slug]))}; }
    fixNorm(); const r=await inner(url,opts); fixNorm(); return r;
  };
  return W;
}
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const call=(m,body)=>M.call(m,body,{headers:{'x-analytics-token':'pass'}});
const writeIdx=(W,table,kind)=>W.writes.findIndex(w=>w.table===table && (!kind||w.kind===kind));

const LINE='ovation-medical';
const baseFile={[LINE]:[{code:'2001',base_price:100,msrp:null,tiers:[{minQty:1,price:100},{minQty:2,price:90}]},{code:'2002',base_price:50}]};
const migratedSkus=()=>[{manufacturer:LINE,code:'2001',base_price:100,msrp:200,msrp_auto:true,tiers:[{min_qty:2,price:90}],status:'active'},
                        {manufacturer:LINE,code:'2002',base_price:50,msrp:100,msrp_auto:true,status:'active'}];

(async()=>{
await t('price edit on a migrated line writes the record FIRST, then a marked projection',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()}}); const C=mod(W);
  const r=await call(C,{action:'save_override',manufacturer:LINE,code:'2001',patch:{base_price:110}});
  eq(r.status,200,'status');
  const rec=W.db.product_skus.find(x=>x.code==='2001');
  eq(rec.base_price,110,'record base'); eq(rec.msrp,220,'flagged MSRP follows its price');
  const iRec=W.writes.findIndex(w=>w.table==='product_skus'), iOv=writeIdx(W,'product_overrides');
  ok(iRec>=0 && iOv>iRec,'record write precedes the override write ('+iRec+','+iOv+')');
  const ov=W.db.product_overrides.find(o=>o.code==='2001').patch;
  eq(ov.base_price,110,'projection base'); eq(ov.msrp,220,'projection carries the derived msrp');
  ok(ov.record_projection && ov.record_projection.fields.includes('base_price'),'projection marked');
});
await t('the canonical edit does not come back through reconciliation as a conflict',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()}}); const C=mod(W);
  await call(C,{action:'save_override',manufacturer:LINE,code:'2001',patch:{base_price:110}});
  const r=await call(C,{action:'reconcile',manufacturer:LINE});
  eq(r.status,200,'status');
  eq(r.body.conflicts.filter(c=>c.code==='2001').map(c=>c.field),[],'no conflict for the edited SKU');
  eq(r.body.parity.drift,[],'shop and record agree');
  eq(r.body.canonical_edits,1,'canonical edit counted');
});
await t('a price edit also projects the ladder, so the old qty-1 rung cannot keep charging the old price',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()}}); const C=mod(W);
  await call(C,{action:'save_override',manufacturer:LINE,code:'2001',patch:{base_price:110}});
  eq(W.db.product_overrides.find(o=>o.code==='2001').patch.tiers.map(r=>r.min_qty+':'+r.price),['2:90'],'record ladder projected');
  const sk=migratedSkus(); delete sk[1].tiers;
  const W2=world({files:{[LINE]:[{code:'2002',base_price:50,tiers:[{minQty:1,price:50},{minQty:2,price:45}]}]},tables:{product_skus:sk}}); const C2=mod(W2);
  await call(C2,{action:'save_override',manufacturer:LINE,code:'2002',patch:{base_price:55}});
  eq(W2.db.product_overrides.find(o=>o.code==='2002').patch.tiers,[],'no ladder is projected as an explicit empty ladder');
});
await t('an unflagged MSRP is never rewritten by a price change',async()=>{
  const sk=migratedSkus(); sk[0].msrp=250; sk[0].msrp_auto=false;
  const W=world({files:baseFile,tables:{product_skus:sk}}); const C=mod(W);
  await call(C,{action:'save_override',manufacturer:LINE,code:'2001',patch:{base_price:110}});
  eq(W.db.product_skus.find(x=>x.code==='2001').msrp,250,'quoted MSRP kept');
});
await t('a failed record write saves nothing to the layers',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()},failOn:[{method:'PATCH',match:'/rest/v1/product_skus'}]}); const C=mod(W);
  const r=await call(C,{action:'save_override',manufacturer:LINE,code:'2001',patch:{base_price:110}});
  eq(r.status,502,'status'); eq(r.body.error,'record_write_failed','error');
  eq(W.db.product_overrides.length,0,'no override written');
});
await t('an unreadable record stops the save (never read as "not migrated")',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()},failOn:[{method:'GET',match:'/rest/v1/product_skus'}]}); const C=mod(W);
  const r=await call(C,{action:'save_override',manufacturer:LINE,code:'2001',patch:{base_price:110}});
  eq(r.status,502,'status'); eq(W.db.product_overrides.length,0,'no override written');
});
await t('a legacy (unmigrated) line keeps legacy behaviour exactly',async()=>{
  const W=world({files:{'strongback-mobility':[{code:'1007',base_price:300}]}}); const C=mod(W);
  const r=await call(C,{action:'save_override',manufacturer:'strongback-mobility',code:'1007',patch:{base_price:310}});
  eq(r.status,200,'status');
  eq(W.db.product_skus.length,0,'no record created');
  const ov=W.db.product_overrides[0].patch; eq(ov.base_price,310,'override'); ok(!ov.record_projection,'no projection marker');
});
await t('reconcile refuses when a layer cannot be read',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()},failOn:[{method:'GET',match:'/rest/v1/custom_products'}]}); const C=mod(W);
  const r=await call(C,{action:'reconcile',manufacturer:LINE});
  eq(r.status,503,'status'); eq(r.body.error,'layer_unreadable','error');
});
await t('price import refuses when the catalog file errors, and treats a missing file as empty',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()},failOn:[{method:'GET',match:OB+'/data/'}]}); const C=mod(W);
  const r=await call(C,{action:'bulk_price',manufacturer:LINE,rows:[{code:'2001',base_price:111}]});
  eq(r.status,503,'status'); eq(W.db.product_overrides.length,0,'nothing written');
  const W2=world({files:{}}); const C2=mod(W2);
  const r2=await call(C2,{action:'bulk_price',manufacturer:'abm-respiratory-care',rows:[{code:'X1',base_price:5,name:'X'}]});
  eq(r2.status,200,'404 file is an empty layer'); eq(r2.body.created,1,'created');
});
await t('price import writes the record first and projects onto the override',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()}}); const C=mod(W);
  const r=await call(C,{action:'bulk_price',manufacturer:LINE,rows:[{code:'2002',base_price:55,tiers:[{min_qty:2,price:52}]}]});
  eq(r.status,200,'status'); eq(r.body.record.written,1,'record write counted');
  const rec=W.db.product_skus.find(x=>x.code==='2002'); eq([rec.base_price,rec.msrp],[55,110],'record');
  const ov=W.db.product_overrides.find(o=>o.code==='2002').patch; eq([ov.base_price,ov.msrp],[55,110],'projection');
  ok(ov.record_projection.fields.includes('tiers'),'tiers projected');
});
await t('retire on a migrated line sets the record status, then hides on the layer',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()}}); const C=mod(W);
  const r=await call(C,{action:'retire_sku',manufacturer:LINE,code:'2002',reason:'do_not_list'});
  eq(r.status,200,'status'); eq(W.db.product_skus.find(x=>x.code==='2002').status,'not_listed','record status');
  eq(W.db.product_overrides.find(o=>o.code==='2002').patch.active,false,'layer hidden');
  const r2=await call(C,{action:'restore_sku',manufacturer:LINE,code:'2002'});
  eq(r2.status,200,'restore'); eq(W.db.product_skus.find(x=>x.code==='2002').status,'active','record back to active');
});
await t('clearing an override that carries record prices is refused',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()}}); const C=mod(W);
  await call(C,{action:'save_override',manufacturer:LINE,code:'2001',patch:{base_price:110}});
  const r=await call(C,{action:'clear_override',manufacturer:LINE,code:'2001'});
  eq(r.status,409,'status'); ok(W.db.product_overrides.some(o=>o.code==='2001'),'override kept');
});
await t('a layer write that bypasses the record is flagged loudly, never copied into it',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus(),manufacturer_meta:[{slug:LINE,record_authoritative:false,record_resync_error:null}]}}); const C=mod(W);
  await call(C,{action:'save_override',manufacturer:LINE,code:'2001',patch:{base_price:110}});
  eq(W.db.manufacturer_meta[0].record_resync_error,null,'clean after a canonical edit');
  const r=await call(C,{action:'clear_override',manufacturer:LINE,code:'2001',force:true});
  eq(r.status,200,'forced clear');
  ok(/^parity: 1 difference/.test(W.db.manufacturer_meta[0].record_resync_error||''),'drift recorded: '+W.db.manufacturer_meta[0].record_resync_error);
  eq(W.db.product_skus.find(x=>x.code==='2001').base_price,110,'record NOT rewritten from the layers');
});
await t('authority cannot be switched on without confirmed parity, and never rewrites the record',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus(),manufacturer_meta:[{slug:LINE,record_authoritative:false,record_resync_error:null}]}}); const C=mod(W);
  const before=JSON.stringify(W.db.product_skus);
  const r1=await call(C,{action:'set_record_authority',manufacturer:LINE,authoritative:true});
  eq(r1.status,409,'unconfirmed'); eq(W.db.manufacturer_meta[0].record_authoritative,false,'still off');
  W.db.product_skus[0].base_price=999;   // a record the shop does not show
  const r2=await call(C,{action:'set_record_authority',manufacturer:LINE,authoritative:true,confirm_parity:true});
  eq(r2.status,409,'drift blocks'); eq(r2.body.error,'parity_drift','error');
  W.db.product_skus[0].base_price=100;
  const r3=await call(C,{action:'set_record_authority',manufacturer:LINE,authoritative:true,confirm_parity:true});
  eq(r3.status,200,'parity → on'); eq(W.db.manufacturer_meta[0].record_authoritative,true,'on');
  eq(JSON.stringify(W.db.product_skus.map(({code_norm,...x})=>x)),JSON.stringify(JSON.parse(before).map(({code_norm,...x})=>x)),'record untouched');
});
await t('an added product save writes only the fields the person changed to the record',async()=>{
  const sk=migratedSkus(); sk.push({manufacturer:LINE,code:'3001',base_price:20,msrp:55,msrp_auto:false,map:30,status:'active'});
  const W=world({files:baseFile,tables:{product_skus:sk,custom_products:[{manufacturer:LINE,code:'3001',name:'A',base_price:20,msrp:40,map:null,active:true}]}}); const C=mod(W);
  const r=await call(C,{action:'save_product',manufacturer:LINE,changed:['base_price'],product:{code:'3001',name:'A',base_price:21,msrp:40,map:null}});
  eq(r.status,200,'status');
  const rec=W.db.product_skus.find(x=>x.code==='3001'); eq([rec.base_price,rec.msrp,rec.map],[21,55,30],'record: price changed, re-sent msrp/map untouched');
});
await t('a new product on a migrated line is created in the record too',async()=>{
  const W=world({files:baseFile,tables:{product_skus:migratedSkus()}}); const C=mod(W);
  const r=await call(C,{action:'save_product',manufacturer:LINE,product:{code:'3001',name:'New thing',base_price:20}});
  eq(r.status,200,'status');
  const rec=W.db.product_skus.find(x=>x.code==='3001'); ok(rec && rec.base_price===20 && rec.status==='active','record row created');
  eq(W.db.custom_products.find(x=>x.code==='3001').base_price,20,'projection on the added row');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

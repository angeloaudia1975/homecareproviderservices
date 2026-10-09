/* stage_record_source — a manufacturer source goes into the master record ONLY, and the answer
   says exactly what dealers would see change on activation. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const OB='https://ordering.test', LINE='strongback-mobility', FILE='Strongback Mobility · Dealer Pricing 2026 V2.pdf';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const files={[LINE]:[{code:'1007AB',base_price:556,msrp:949,tiers:[{minQty:1,price:556},{minQty:2,price:536},{minQty:8,price:526}]}]};
function world(extra,failWrite){
  const W=M.createWorld({tables:Object.assign({manufacturer_meta:[{slug:LINE}],product_content:[],product_skus:[],
    product_overrides:[{manufacturer:LINE,code:'1007AB',patch:{base_price:556,msrp:949,tiers:[{min_qty:1,price:556},{min_qty:2,price:536},{min_qty:8,price:526}]}}],
    custom_products:[{manufacturer:LINE,code:'A1000',base_price:124.98,msrp:249.95,map:249.95,active:true},{manufacturer:LINE,code:'RC100',base_price:5,msrp:10,map:10,active:true}]},extra||{}),
    failWrite:(m,tb)=>tb===failWrite?500:0});
  const inner=W.fetch; W.fetch=async(u,o)=>{ u=String(u); if(u.startsWith(OB+'/data/')){ const s=decodeURIComponent(u.slice((OB+'/data/').length).replace(/\.json.*$/,''));
    return s in files?{ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(files[s])),text:async()=>JSON.stringify(files[s])}:{ok:false,status:404,json:async()=>null,text:async()=>''}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); const r=await inner(u,o); (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return r; };
  return W; }
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
const ROWS=[
  {code:'1007AB',base_price:546,tiers:[{min_qty:2,price:526},{min_qty:8,price:516}],map:949,msrp:null,msrp_auto:false,uom:'Each'},
  {code:'A1000',base_price:162.47,tiers:[{min_qty:2,price:124.98}],map:249.95,msrp:null,msrp_auto:false},
  {code:'RC100',status:'not_listed',status_note:'Not on Rev C'}];
const stage=(C,extra)=>call(C,Object.assign({action:'stage_record_source',manufacturer:LINE,source_file:FILE,effective_date:'2026-08-27',rows:ROWS},extra||{}));
(async()=>{
await t('dry run: nothing written; the preview lists every dealer-facing change',async()=>{
  const W=world(); const C=mod(W); const n=W.writes.length;
  const r=await stage(C,{dry_run:true}); eq(r.status,200,JSON.stringify(r.body));
  eq(W.writes.length,n,'nothing written');
  const d=r.body.activation_preview.drift.map(x=>x.code+':'+x.field).sort();
  eq(d,['1007AB:base_price','1007AB:msrp','1007AB:tiers','A1000:base_price','A1000:msrp','A1000:tiers','RC100:status'].sort());
});
await t('apply: records only — no override, no added row touched',async()=>{
  const W=world(); const C=mod(W); const ov=JSON.stringify(W.db.product_overrides), cu=JSON.stringify(W.db.custom_products);
  const r=await stage(C); eq([r.status,r.body.staged],[200,['1007AB','A1000','RC100']]);
  eq([JSON.stringify(W.db.product_overrides),JSON.stringify(W.db.custom_products)],[ov,cu],'layers untouched');
  eq(W.writes.filter(w=>w.table!=='product_skus').length,0,'only the record');
  const rec=c=>W.db.product_skus.find(x=>x.code===c);
  eq([rec('1007AB').base_price,rec('1007AB').map,rec('1007AB').msrp,rec('1007AB').msrp_auto,rec('1007AB').source_file,rec('1007AB').effective_date],[546,949,null,false,FILE,'2026-08-27']);
  eq([rec('RC100').status,rec('A1000').tiers.map(x=>x.min_qty+':'+x.price)],['not_listed',['2:124.98']]);
});
await t('a second run updates in place (no duplicate records)',async()=>{
  const W=world(); const C=mod(W); await stage(C); await stage(C); eq(W.db.product_skus.length,3);
});
await t('refused on a record-authoritative line',async()=>{
  const W=world({manufacturer_meta:[{slug:LINE,record_authoritative:true}]}); const C=mod(W); const n=W.writes.length;
  const r=await stage(C); eq([r.status,r.body.error],[409,'line_is_authoritative']); eq(W.writes.length,n);
});
await t('bad rows are refused whole',async()=>{
  const W=world(); const C=mod(W); const n=W.writes.length;
  const r=await call(C,{action:'stage_record_source',manufacturer:LINE,source_file:FILE,rows:[{code:'X',base_price:0},{code:'Y',base_price:5,status:'gone'},{code:'Z',base_price:5},{code:'z',base_price:6}]});
  eq([r.status,r.body.bad.length,r.body.duplicates],[400,2,['Z']]); eq(W.writes.length,n);
});
await t('a write failure stops and names what was staged',async()=>{
  const W=world(null,'product_skus'); const C=mod(W);
  const r=await stage(C); eq([r.status,r.body.error,r.body.staged],[502,'stage_incomplete',[]]);
});
console.log(`stage: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

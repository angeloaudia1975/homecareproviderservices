/* 2.6 — structure_audit builds options exactly like the Partner 360 picker.
   Runs the REAL catalog-api structure_audit action (in-memory PostgREST fake) on fixtures shaped
   like the live Ovation records, and checks the copied picker is byte-identical to the shop's. */
const fs=require('fs'), path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOP=process.env.SHOP||path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html');
const OB='https://ordering.test', L='ovation-medical';
let fail=0,pass=0; async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
function run(tables, file){
  const W=M.createWorld({tables:Object.assign({product_content:[],product_related:[],custom_products:[],product_overrides:[],manufacturer_meta:[{slug:L,enriched_only:true}]},tables)});
  const inner=W.fetch; W.fetch=async(u,o)=>String(u).startsWith(OB)?{ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(file)),text:async()=>''}:inner(u,o);
  const C=M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
  return M.call(C,{action:'structure_audit',manufacturer:L},{headers:{'x-analytics-token':'pass'}});
}
const pg=(k,name,skus,x)=>Object.assign({manufacturer:L,page_key:k,name,status:'published',disabled:false,options:{},skus},x||{});
const kinds=r=>r.body.findings.filter(f=>f.severity==='fault').map(f=>f.kind+':'+f.page_key);
(async()=>{
await t('the copied picker is byte-identical to the storefront, and the shop picker is keyed by product page',async()=>{
  const ex=require(path.join(__dirname,'extract-picker.js'));
  const shop=fs.readFileSync(SHOP,'utf8'); const mine=fs.readFileSync(path.join(ROOT,'_shop_picker.js'),'utf8');
  const body=mine.slice(mine.indexOf('/* ---- BEGIN VERBATIM ---- */\n')+31, mine.indexOf('\n/* ---- END VERBATIM ---- */'));
  ok(body===ex.extract(shop),'_shop_picker.js has drifted from the shop page');
  const i=shop.indexOf('window.openProductDetail = async function'); const fn=shop.slice(i,i+3000).replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  ok(/const gk=groupKeyOf\(p\);/.test(fn) && /filter\(x=>groupKeyOf\(x\)===gk\)/.test(fn),'shop picker is not keyed by groupKeyOf');
});
await t('the three Ovation size pairs are NOT collisions (real names and sizes)',async()=>{
  const r=await run({product_content:[
    pg('compact-pro-rom','Compact Pro ROM Post-Op Knee Brace - Standard',[{sku:'51500',name:'Compact Pro ROM Post-Op Knee Brace – Standard',size:'Standard - Up to 29"'},{sku:'51508',name:'Compact Pro ROM Post-Op Knee Brace – X-Large',size:'X-Large - Up to 35"'}]),
    pg('nu-form-l0637','Nu-Form Universal Back Brace (L0637/L0650)',[{sku:'62007',name:'Nu-Form Universal Back Brace (L0637/L0650) – 30”-48”',size:'30”-48”'},{sku:'61008-2',name:'Nu-Form Universal Back Brace (L0637/L0650) – 4XL',size:'50" - 60"'}])]},
    [{code:'51500',group:'g1'},{code:'51508',group:'g1'},{code:'62007',group:'g2'},{code:'61008-2',group:'g2'}]);
  eq(r.status,200,'status'); eq(kinds(r),[],'no faults');
});
await t('an accessory sharing the splints\' catalog group is not offered as one of their sizes',async()=>{
  const r=await run({product_content:[pg('hybrid','Hybrid Night Splint',[{sku:'30014',name:'Hybrid Night Splint – Small to Medium'},{sku:'30016',name:'Hybrid Night Splint – Large to X-Large'}]),
    pg('strap','Hybrid Night Splint Accessory Strap',[{sku:'30000S',name:'Hybrid Night Splint Accessory Strap'}])]},
    [{code:'30014',group:'HNS'},{code:'30016',group:'HNS'},{code:'30000S',group:'HNS'}]);
  eq(kinds(r),[],'picker keyed by page: no crossing');
});
await t('casting tape: colours with their own catalog groups are one picker, 4 sizes × 4 colours, no gaps',async()=>{
  const sz=['2" x 4 Yd','3" x 4 Yd','4" x 4 Yd','5" x 5 Yd'], col=[['BL','Black'],['DB','Dark Blue'],['PK','Pink'],['WH','White']];
  const skus=[], file=[];
  sz.forEach((s,i)=>col.forEach(([c,cn])=>{ const code='CF00'+(i+2)+c; skus.push({sku:code,name:'Casting Tape – '+s+' '+cn}); file.push({code,group:c==='BL'?'black-'+i:'tape'}); }));
  const r=await run({product_content:[pg('casting-tape','Casting Tape',skus)]},file);
  eq(kinds(r),[],'no faults'); eq(r.body.gaps_total,0,'no gaps');
});
await t('two SKUs that ARE the same selection are still caught (and a missing combination is a gap, not a fault)',async()=>{
  const r=await run({product_content:[pg('boot','Boot',[{sku:'A',name:'Boot – Small Blue'},{sku:'B',name:'Boot – Small Blue'},{sku:'C',name:'Boot – Large Red'},{sku:'D',name:'Boot – Large Blue'}])]},
    [{code:'A'},{code:'B'},{code:'C'},{code:'D'}]);
  ok(r.body.findings.some(f=>f.kind==='variant_collision'&&f.severity==='fault'&&/A and B/.test(f.detail)),'collision found');
  ok(r.body.findings.some(f=>f.kind==='variant_gap'&&f.severity==='gap'),'Small+Red reported as a gap');
});
await t('identical entries in a one-list picker are a fault',async()=>{
  const r=await run({product_content:[pg('p','Pad',[{sku:'P1',name:'Pad – Regular'},{sku:'P2',name:'Pad – Regular'}])]},[{code:'P1'},{code:'P2'}]);
  eq(kinds(r),['sku_option_duplicated:p'],'dup');
});
await t('a stale options blob is reported as info, not a dealer fault',async()=>{
  const r=await run({product_content:[pg('gen2','Gen 2 Boot',[{sku:'10002BLUE',name:'Gen 2 – Small Blue'},{sku:'10002RED',name:'Gen 2 – Small Red'}],{options:{Color:['Blue']}})]},[{code:'10002BLUE'},{code:'10002RED'}]);
  const f=r.body.findings.find(x=>x.kind==='options_contradict_skus'); ok(f && f.severity==='info','info'); eq(kinds(r),[],'no faults');
});
await t('hidden SKUs and SKUs with no live page are not part of the dealer page',async()=>{
  const r=await run({product_content:[pg('p','Pad',[{sku:'P1',name:'Pad – Regular'},{sku:'P2',name:'Pad – Regular'}]),pg('d','Draft',[{sku:'Q1'},{sku:'Q2'}],{status:'pending_review'})],
    product_overrides:[{manufacturer:L,code:'P2',patch:{active:false}}]},[{code:'P1'},{code:'P2'},{code:'Q1'},{code:'Q2'}]);
  eq(kinds(r),[],'no faults');
});
await t('the authored size distinguishes SKUs whose names do not',async()=>{
  const r=await run({product_content:[pg('ts','Boot',[{sku:'T1',name:'Boot – Blue',size:'Small'},{sku:'T2',name:'Boot – Blue',size:'Large'}])]},[{code:'T1'},{code:'T2'}]);
  eq(kinds(r),[],'sizes make them distinct');
});
await t('a draft page listing a SKU first does not take it from the live page',async()=>{
  const r=await run({product_content:[pg('d','Draft',[{sku:'P1'}],{status:'pending_review'}),pg('p','Pad',[{sku:'P1',name:'Pad – Regular'},{sku:'P2',name:'Pad – Regular'}])]},[{code:'P1'},{code:'P2'}]);
  eq(kinds(r),['sku_option_duplicated:p'],'the live page owns P1, so its duplicate is seen');
});
await t('an unreadable layer is a 503, never an empty audit',async()=>{
  const W=M.createWorld({tables:{product_content:[],manufacturer_meta:[]}}); const inner=W.fetch;
  W.fetch=async(u,o)=>String(u).startsWith(OB)?{ok:false,status:500,json:async()=>null,text:async()=>'x'}:inner(u,o);
  const C=M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
  const r=await M.call(C,{action:'structure_audit',manufacturer:L},{headers:{'x-analytics-token':'pass'}}); eq(r.status,503,'status');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

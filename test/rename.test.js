/* rename_code moves everything that points at a part number — the master record first, then
   dealers' contract prices, then the catalog layers — or stops and says what it did.
   (Was: 2.2 — the canonical commercial write path harness, reused.)
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


const extra=()=>({product_links:[{manufacturer:LINE,code:'2002',label:'IFU',url:'u'}],product_media:[],featured_products:[{manufacturer:LINE,code:'2002',rank:1,active:true}],
  dealer_contract_prices:[{dealer_id:'d1',manufacturer:LINE,code:'2002',price:44,active:true},{dealer_id:'d2',manufacturer:LINE,code:'2001',price:80,active:true}]});
const rec=(W,c)=>W.db.product_skus.find(r=>r.code===c);
(async()=>{
await t('migrated line: the record moves FIRST, contract prices follow, the layers carry the RECORD\'s prices',async()=>{
  const W=world({files:baseFile,tables:Object.assign({product_skus:migratedSkus()},extra())}); const C=mod(W);
  const r=await call(C,{action:'rename_code',manufacturer:LINE,old_code:'2002',new_code:'2002-N',product:{name:'Two',base_price:1}});
  eq(r.status,200,'status '+JSON.stringify(r.body));
  eq([rec(W,'2002-N').base_price,rec(W,'2002-N').msrp,rec(W,'2002-N').status],[50,100,'active'],'new record carries the commercial fields');
  eq([rec(W,'2002').status,rec(W,'2002').superseded_by],['not_listed','2002-N'],'old record superseded, kept for history');
  eq(W.db.dealer_contract_prices.filter(x=>x.dealer_id==='d1').map(x=>x.code),['2002-N'],'contract price moved');
  eq(W.db.dealer_contract_prices.find(x=>x.dealer_id==='d2').code,'2001','other contracts untouched');
  eq(W.db.custom_products.find(x=>x.code==='2002-N').base_price,50,'added row uses the record price, not the browser\'s $1');
  eq([W.db.product_links[0].code,W.db.featured_products[0].code],['2002-N','2002-N'],'links and Featured moved');
  eq(W.db.product_overrides.find(o=>o.code==='2002').patch.active,false,'old code retired');
  const iRec=W.writes.findIndex(w=>w.table==='product_skus'), iCp=W.writes.findIndex(w=>w.table==='dealer_contract_prices'), iCu=W.writes.findIndex(w=>w.table==='custom_products');
  ok(iRec>=0 && iRec<iCp && iCp<iCu,'order: record, contracts, layers ('+[iRec,iCp,iCu]+')');
});
await t('a re-spelling (same part number) renames the record in place',async()=>{
  const skus=[{manufacturer:LINE,code:'abc-1',base_price:9,status:'active'}];
  const W=world({files:{[LINE]:[]},tables:Object.assign({product_skus:skus,custom_products:[{manufacturer:LINE,code:'abc-1',name:'x',base_price:9,active:true}]},extra())}); const C=mod(W);
  const r=await call(C,{action:'rename_code',manufacturer:LINE,old_code:'abc-1',new_code:'ABC1',was_custom:true,product:{name:'x'}});
  eq(r.status,200,'status '+JSON.stringify(r.body)); eq(W.db.product_skus.map(x=>x.code),['ABC1'],'one record, re-spelled');
});
await t('a dealer with contract prices on BOTH codes stops the rename before anything is written',async()=>{
  const t2=extra(); t2.dealer_contract_prices.push({dealer_id:'d1',manufacturer:LINE,code:'2002-N',price:40,active:true});
  const W=world({files:baseFile,tables:Object.assign({product_skus:migratedSkus()},t2)}); const C=mod(W); const n=W.writes.length;
  const r=await call(C,{action:'rename_code',manufacturer:LINE,old_code:'2002',new_code:'2002-N',product:{}});
  eq([r.status,r.body.error,r.body.dealers],[409,'contract_conflict',['d1']],'refused'); eq(W.writes.length,n,'nothing written');
});
await t('a code that exists only in the master record is a collision too',async()=>{
  const skus=migratedSkus(); skus.push({manufacturer:LINE,code:'9999',base_price:1,status:'not_listed'});
  const W=world({files:baseFile,tables:Object.assign({product_skus:skus},extra())}); const C=mod(W); const n=W.writes.length;
  const r=await call(C,{action:'rename_code',manufacturer:LINE,old_code:'2002',new_code:'9999',product:{}});
  eq([r.status,r.body.error],[409,'sku_in_use'],'refused'); eq(W.writes.length,n,'nothing written');
});
await t('an unreadable catalog file stops the rename — no write',async()=>{
  const W=world({files:baseFile,tables:Object.assign({product_skus:migratedSkus()},extra()),failOn:[{method:'GET',match:'/data/'}]}); const C=mod(W); const n=W.writes.length;
  const r=await call(C,{action:'rename_code',manufacturer:LINE,old_code:'2002',new_code:'2002-N',product:{}});
  eq(r.status,503,'status'); eq(W.writes.length,n,'nothing written');
});
await t('a failed step is reported with what was done — never swallowed',async()=>{
  const W=world({files:baseFile,tables:Object.assign({product_skus:migratedSkus()},extra()),failOn:[{method:'PATCH',match:'featured_products'}]}); const C=mod(W);
  const r=await call(C,{action:'rename_code',manufacturer:LINE,old_code:'2002',new_code:'2002-N',product:{}});
  eq([r.status,r.body.error,r.body.failed_step],[502,'rename_incomplete','featured_products'],'reported');
  ok(r.body.done.includes('master record') && r.body.done.includes('contract prices'),'done list: '+r.body.done.join(','));
});
await t('a record failure writes nothing else',async()=>{
  const W=world({files:baseFile,tables:Object.assign({product_skus:migratedSkus()},extra()),failOn:[{method:'POST',match:'product_skus'}]}); const C=mod(W);
  const r=await call(C,{action:'rename_code',manufacturer:LINE,old_code:'2002',new_code:'2002-N',product:{}});
  eq([r.status,r.body.failed_step],[502,'master record'],'stopped at the record');
  eq([W.db.dealer_contract_prices.find(x=>x.dealer_id==='d1').code, !!W.db.custom_products.find(x=>x.code==='2002-N')],['2002',false],'no contract or layer change');
});
await t('a line without a master record still moves contract prices',async()=>{
  const W=world({files:baseFile,tables:extra()}); const C=mod(W);
  const r=await call(C,{action:'rename_code',manufacturer:LINE,old_code:'2002',new_code:'2002-N',product:{base_price:50}});
  eq(r.status,200,'status'); eq(r.body.record_moved,false,'no record');
  eq(W.db.dealer_contract_prices.find(x=>x.dealer_id==='d1').code,'2002-N','contract moved');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exitCode=fail?1:0;
})();

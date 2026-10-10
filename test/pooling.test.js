/* Threshold-specific pooling (agreed 2026-10-09, Strongback Rev C): the 2+ break pools across the
   models family, 8+ counts the SKU alone, accessories never pool, Ovation (no pools) unchanged.
   Server (orders-api → _pricing → the shop's own engine) and browser (the shop page's own unitPrice)
   must agree; every tier writer must keep the pool. */
const path=require('path'), fs=require('fs'), vm=require('vm');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOP=process.env.SHOP_HTML||path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html');
const FEED=process.env.FEED_JS||path.join(__dirname,'..','..','homecareproviderservicesordering','netlify','functions','catalog-feed.js');
const OB='https://ordering.test', SB='strongback-mobility', OV='ovation-medical';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const canon=v=>JSON.stringify(v,(k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.keys(x).sort().reduce((o,k2)=>(o[k2]=x[k2],o),{}):x);
const eq=(a,b,w)=>{ if(canon(a)!==canon(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const F='strongback-models';
const model=(code,b,t2,t8)=>({manufacturer:SB,code,base_price:b,tiers:[{min_qty:2,price:t2,pool:F},{min_qty:8,price:t8}],map:1,msrp:null,msrp_auto:false,status:'active'});
const acc=(code,b,t2)=>({manufacturer:SB,code,base_price:b,tiers:t2?[{min_qty:2,price:t2}]:null,map:1,msrp:null,msrp_auto:false,status:'active'});
const RECORDS=[model('1003AB',527,497,487),model('1017',536,506,496),model('ES0001',240,220,215),model('R0001',320,295,285),acc('A1000',162.47,124.98),acc('A1001',162.47,124.98)];
const OVFILE=[{code:'B1',name:'Boot S',group:'Boot',base_price:50,tiers:[{minQty:1,price:50},{minQty:3,price:40}]},{code:'B2',name:'Boot M',group:'Boot',base_price:50,tiers:[{minQty:1,price:50},{minQty:3,price:40}]},{code:'A1',name:'Std',group:'',base_price:20,tiers:[{minQty:1,price:20},{minQty:2,price:18}]}];
function world(){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, tables:{ app_settings:[{key:'platform_state',value:{mode:'development'}}],
    manufacturers:[{slug:SB,name:'Strongback'},{slug:OV,name:'Ovation'}], manufacturer_meta:[{slug:SB,record_authoritative:true},{slug:OV}],
    dealers:[{id:'d1',parent_id:null}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
    dealer_contract_prices:[], product_overrides:[], product_images:[], product_links:[], product_media:[], product_content:[],
    /* The legacy layers carry the SAME ladder without pools (as Strongback does today): only the record's pool can pool. */
    custom_products:RECORDS.map(r=>({manufacturer:SB,code:r.code,name:r.code,base_price:r.base_price,tiers:(r.tiers||null)&&r.tiers.map(x=>({min_qty:x.min_qty,price:x.price})),active:true})),
    product_skus:JSON.parse(JSON.stringify(RECORDS)), orders:[], order_items:[] }});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')) return {ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})};
    if(u.startsWith(OB+'/data/')){ if(u.includes('/content/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
      const slug=decodeURIComponent(u.slice((OB+'/data/').length).replace(/\.json.*$/,''));
      if(slug===OV) return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(OVFILE)),text:async()=>JSON.stringify(OVFILE)};
      return {ok:false,status:404,json:async()=>null,text:async()=>''}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return inner(url,opts); };
  return W; }
const server=async(slug,lines)=>{ const W=world(); const C=M.load('orders-api.js',W,{ORDERING_BASE:OB},ROOT);
  const r=await M.call(C,{action:'price_check',orders:[{manufacturer_slug:slug,items:lines.map(([code,qty])=>({code,qty,unit:0}))}]},{headers:{authorization:'Bearer dealer'}});
  if(r.status!==200) throw new Error('price_check '+r.status+' '+JSON.stringify(r.body));
  return Object.fromEntries(r.body.orders[0].items.map(i=>[i.code,i.unit])); };
/* The browser: the shop page's own familyQty/tierQty/contractPrice/unitPrice over a CART. */
const html=fs.readFileSync(SHOP,'utf8');
const {grabDecl}=require(path.join(__dirname,'extract-picker.js'));
const engine=['function familyQty','function tierQty','function contractPrice','function unitPrice'].map(a=>grabDecl(html,a)).join('\n');
const browser=(products,lines)=>{ const ctx={CART:new Map(),AUTH:{prices:{}}}; vm.createContext(ctx); vm.runInContext(engine+';this.unitPrice=unitPrice;',ctx);
  const by=Object.fromEntries(products.map(p=>[p.code,p]));
  lines.forEach(([c,q])=>ctx.CART.set(c,{p:by[c],qty:q}));
  return Object.fromEntries(lines.map(([c,q])=>[c,ctx.unitPrice(by[c],q)])); };
const sbProducts=RECORDS.map(r=>Object.assign({},r,{manufacturer:SB,group:''}));
const both=async(lines,want,w)=>{ const s=await server(SB,lines); const b=browser(sbProducts,lines); eq(s,want,(w||'')+' server'); eq(b,want,(w||'')+' browser'); };
(async()=>{
await t('1 x 1003AB + 1 x R0001 → both 2+ (models pool at 2+)',()=>both([['1003AB',1],['R0001',1]],{'1003AB':497,'R0001':295}));
await t('1 x ES0001 + 1 x 1017 → both 2+',()=>both([['ES0001',1],['1017',1]],{'ES0001':220,'1017':506}));
await t('4 x 1003AB + 4 x 1017 → both stay at 2+, neither reaches 8+',()=>both([['1003AB',4],['1017',4]],{'1003AB':497,'1017':506}));
await t('8 x one model → that SKU gets 8+',()=>both([['1003AB',8]],{'1003AB':487}));
await t('8 x 1003AB + 1 x 1017 → 8+ on 1003AB, 2+ on 1017',()=>both([['1003AB',8],['1017',1]],{'1003AB':487,'1017':506}));
await t('1 model alone → 1-unit price',()=>both([['1017',1]],{'1017':536}));
await t('A1000 + A1001 → no cross-SKU pooling (each stays at 1-unit)',()=>both([['A1000',1],['A1001',1]],{'A1000':162.47,'A1001':162.47}));
await t('2 x A1000 → its own 2+',()=>both([['A1000',2]],{'A1000':124.98}));
await t('an accessory never joins the model family (1 x A1000 + 1 x 1003AB)',()=>both([['A1000',1],['1003AB',1]],{'A1000':162.47,'1003AB':527}));
await t('Ovation unchanged: catalog-group pooling exactly as before',async()=>{
  const s=await server(OV,[['B1',2],['B2',1],['A1',1]]); eq(s,{B1:40,B2:40,A1:20},'server');
  const ovP=OVFILE.map(p=>Object.assign({},p,{manufacturer:OV}));
  eq(browser(ovP,[['B1',2],['B2',1],['A1',1]]),{B1:40,B2:40,A1:20},'browser');
});
await t('the record feed carries the pool (catalog-feed and the server copy)',()=>{
  delete require.cache[require.resolve(FEED)]; const feed=require(FEED);
  const fr=(feed._feedRows||feed.feedRows||(feed._pure&&feed._pure.feedRows));
  if(!fr) throw new Error('catalog-feed exports no feedRows');
  eq(fr([RECORDS[0]])[0].tiers,[{min_qty:2,price:497,pool:F},{min_qty:8,price:487}],'catalog-feed');
  const P=require(path.join(ROOT,'_pricing.js')); const pr=P.feedRows||(P._pure&&P._pure.feedRows);
  eq(pr([RECORDS[0]])[0].tiers,[{min_qty:2,price:497,pool:F},{min_qty:8,price:487}],'_pricing');
});
// ---- every tier writer keeps the pool ----
const catWorld=()=>{ const W=M.createWorld({tables:{manufacturer_meta:[{slug:SB}],product_overrides:[],custom_products:[{manufacturer:SB,code:'1003AB',name:'x',base_price:527,active:true}],product_content:[],
  product_skus:[Object.assign({code_norm:'1003AB'},RECORDS[0])]}});
  const inner=W.fetch; W.fetch=async(u,o)=>{ u=String(u); if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return inner(u,o); }; return W; };
const cat=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
await t('a Product Catalog / Price Check save that sends tiers WITHOUT pools keeps them (record and projection)',async()=>{
  const W=catWorld(); const C=cat(W);
  const r=await call(C,{action:'save_override',manufacturer:SB,code:'1003AB',patch:{tiers:[{min_qty:2,price:499},{min_qty:8,price:487}]}});
  eq(r.status,200,JSON.stringify(r.body));
  eq(W.db.product_skus[0].tiers,[{min_qty:2,price:499,pool:F},{min_qty:8,price:487}],'record');
  eq(W.db.product_overrides[0].patch.tiers,[{min_qty:2,price:499,pool:F},{min_qty:8,price:487}],'projection');
});
await t('bulk price (Price Check) keeps the pool',async()=>{
  const W=catWorld(); const C=cat(W);
  const r=await call(C,{action:'bulk_price',manufacturer:SB,rows:[{code:'1003AB',base_price:527,tiers:[{min_qty:2,price:497},{min_qty:8,price:487}]}]});
  eq(r.status,200,JSON.stringify(r.body)); eq(W.db.product_skus[0].tiers[0].pool,F,'record keeps pool');
});
await t('staging stores the pool, and the preview reports a pool the storefront lacks',async()=>{
  const W=catWorld(); W.db.product_skus=[]; const C=cat(W);
  const r=await call(C,{action:'stage_record_source',manufacturer:SB,source_file:'Rev C',rows:[{code:'1003AB',base_price:527,tiers:[{min_qty:2,price:497,pool:F},{min_qty:8,price:487}],map:889,msrp_auto:false}],dry_run:true});
  eq(r.status,200,JSON.stringify(r.body)); eq(r.body.plan[0].after.tiers[0].pool,F,'kept');
  eq(r.body.activation_preview.drift.filter(d=>d.field==='tiers').map(d=>d.record),['2:497@strongback-models,8:487'],'pooling is a dealer-facing change');
});
console.log(`pooling: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

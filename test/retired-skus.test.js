/* RETIRED PART NUMBERS (owner, C3-06 closeout 2026-11-05): the 14 former PediFix reactivation candidates and the
   duplicate P3095-115 are never priced or ordered, whatever a file, an override or an added product says.
   Built on pricing.test.js's world: the REAL orders-api + _pricing.js running the storefront's own engine.
   (original header follows)
   Loads the REAL orders-api handler (with the real _pricing.js running the storefront's own
   engine) against the repo's in-memory PostgREST fake and a fake storefront site. Every
   assertion is on what the handler answered or wrote. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const OB='https://ordering.test';
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,3).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };

const LINE='pedifix';
const TIERS=[{minQty:1,price:50},{minQty:3,price:40}];
const FILE=()=>({[LINE]:[
  {manufacturer:LINE,code:'A1',name:'Standard item',group:'',base_price:50},
  {manufacturer:LINE,code:'S3',name:'Special until midnight Central',group:'',base_price:100,tiers:[{min_qty:4,price:90,until:'2027-01-01T06:00:00Z'}]},
  {manufacturer:LINE,code:'B1',name:'Boot S',group:'Boot',base_price:50,tiers:TIERS},
  {manufacturer:LINE,code:'B2',name:'Boot M',group:'Boot',base_price:50,tiers:TIERS},
  {manufacturer:LINE,code:'C1',name:'Contract item',group:'',base_price:20},
], manufacturers:[{slug:LINE,name:'PediFix'}]});

function world({files, tables, failRead, failWrite, fileStatus}){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, failRead, failWrite,
    tables:Object.assign({
      app_settings:[{key:'platform_state',value:{mode:'development'}}],
      manufacturers:[{slug:LINE,name:'PediFix'},{slug:'golden-technologies',name:'Golden'}],
      manufacturer_meta:[{slug:LINE}],
      dealers:[{id:'d1',parent_id:'m1',is_test:true},{id:'m1',parent_id:null}],
      dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}], dealer_manufacturers:require('./p0-entitle.js')('d1'),
      dealer_contract_prices:[
        {dealer_id:'m1',manufacturer:LINE,code:'C1',price:18,active:true},
        {dealer_id:'d1',manufacturer:LINE,code:'C1',price:17,active:true},
        {dealer_id:'m1',manufacturer:LINE,code:'X9',price:25,active:true}],
      product_overrides:[], custom_products:[{manufacturer:LINE,code:'X9',name:'Added product',base_price:30,active:true}],
      product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[],
      orders:[], order_items:[], tracking_requests:[], email_sends:[], intent_events:[], email_attribution:[],
    }, tables||{})});
  const inner=W.fetch; const fl=files||FILE();
  W.fetch=async(url,opts)=>{
    const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')){ const tok=String(((opts&&opts.headers)||{}).Authorization||'').replace(/^Bearer\s+/i,'');
      return tok==='dealer'?{ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})}:{ok:false,status:401,json:async()=>({})}; }
    if(u.startsWith(OB+'/data/')){
      if(fileStatus){ const st=fileStatus(u); if(st) return {ok:false,status:st,json:async()=>null,text:async()=>'boom'}; }
      const content=u.includes('/data/content/');
      const slug=decodeURIComponent(u.slice((OB+(content?'/data/content/':'/data/')).length).replace(/\.json.*$/,''));
      const src=content?{}:fl;
      if(!(slug in src)) return {ok:false,status:404,json:async()=>null,text:async()=>''};
      return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(src[slug]))};
    }
    if(u.startsWith('https://api.resend.com')) return {ok:true,status:200,json:async()=>({id:'m'})};
    return inner(url,opts);
  };
  return W;
}
const mod=W=>M.load('orders-api.js',W,{ORDERING_BASE:OB},ROOT);
const call=(C,body)=>M.call(C,body,{headers:{authorization:'Bearer dealer'}});
const order=(items,extra)=>Object.assign({manufacturer_slug:LINE,manufacturer_name:'PediFix',po:'PO1',items},extra||{});
const item=(r,code)=>r.body.orders[0].items.find(i=>i.code===code);
const setOverride=(W,code,patch)=>{ W.db.product_overrides=W.db.product_overrides.filter(o=>o.code!==code); W.db.product_overrides.push({manufacturer:LINE,code,patch}); };


const RETIRED=['8520','8521','8620','P3012','P3012-12','P3305','P3355-STR','6210-L-S','6210-L-M','6210-L-L','6210-M-S','6210-M-M','6210-M-L','6210-M-XL','P3095-115'];
const PFILE=()=>({[LINE]:[{manufacturer:LINE,code:'A1',name:'Standard item',group:'',base_price:50},{manufacturer:LINE,code:'P3095',name:'Kept',group:'',base_price:9},
  ...RETIRED.map(c=>({manufacturer:LINE,code:c,name:'Retired '+c,group:'',base_price:11}))], manufacturers:[{slug:LINE,name:'PediFix'}]});
(async()=>{
await t('every retired PediFix part number is unavailable and unpriced; the rest of the line prices as before',async()=>{
  const W=world({files:PFILE()}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50},{code:'P3095',qty:1,unit:9},...RETIRED.map(c=>({code:c,qty:1,unit:11}))])]});
  eq(r.status,200,'status'); eq(item(r,'A1').unit,50,'A1 priced'); eq(item(r,'P3095').unit,9,'P3095 (not the -115 duplicate) priced');
  for(const c of RETIRED){ eq([item(r,c).available,item(r,c).unit],[false,null],c); }
});
await t('an override switching one back ON, or an added product with the same code, never brings it back',async()=>{
  const W=world({files:PFILE(),tables:{product_overrides:[{manufacturer:LINE,code:'8520',patch:{active:true,base_price:5}}],
    custom_products:[{manufacturer:LINE,code:'6210-M-XL',name:'Re-added',base_price:7,active:true},{manufacturer:LINE,code:'p3012',name:'lower-case re-add',base_price:7,active:true}]}}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'8520',qty:1,unit:5},{code:'6210-M-XL',qty:1,unit:7},{code:'p3012',qty:1,unit:7}])]});
  for(const c of ['8520','6210-M-XL','p3012']) eq(item(r,c).available,false,c+' stays retired');
});
await t('a retired part number cannot be ordered: nothing is recorded',async()=>{
  const W=world({files:PFILE()}); const C=mod(W);
  const c=await call(C,{action:'create',orders:[order([{code:'8521',qty:1,unit:11}])],dealer:{}});
  ok(c.status>=400,'refused: '+c.status); eq([W.db.orders.length,W.db.order_items.length],[0,0],'nothing stored');
});
await t('the retirement is per line: the same code on another line is untouched',async()=>{
  const files={ 'ovation-medical':[{manufacturer:'ovation-medical',code:'8520',name:'Other line item',group:'',base_price:3}], manufacturers:[{slug:'ovation-medical',name:'Ovation'}]};
  const W=world({files,tables:{manufacturers:[{slug:'ovation-medical',name:'Ovation'}],manufacturer_meta:[{slug:'ovation-medical'}]}}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[{manufacturer_slug:'ovation-medical',manufacturer_name:'Ovation',po:'1',items:[{code:'8520',qty:1,unit:3}]}]});
  eq(r.body.orders[0].items[0].unit,3,'priced on its own line');
});
await t('the storefront and the order server share ONE list (engine copy carries it verbatim)',async()=>{
  const fs=require('fs'); const html=fs.readFileSync(path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html'),'utf8');
  const eng=require(path.join(ROOT,'_shop_engine.js')).SOURCE;
  const grab=s=>{ const i=s.indexOf('const RETIRED_SKUS='); return s.slice(i,s.indexOf('async function mergeCatalogEdits',i)); };
  ok(grab(html).length>100 && grab(html)===grab(eng),'same list in the shop and the server engine');
  for(const c of RETIRED) ok(grab(html).includes('"'+c+'"'),c+' listed');
});
await t('the Dealer Business Hub (dashboard.html: MSRP quotes, price-list export, favourites) uses the SAME list and drops them',async()=>{
  const fs=require('fs'); const html=fs.readFileSync(path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html'),'utf8');
  const dash=fs.readFileSync(path.join(__dirname,'..','..','homecareproviderservicesordering','public','dashboard.html'),'utf8');
  const list=s=>{ const i=s.indexOf('const RETIRED_SKUS='); return s.slice(i,s.indexOf('});',i)+3); };
  ok(list(dash).length>100 && list(dash)===list(html),'same list');
  ok(/if\(!code\|\|hidden\.has\(code\)\|\|isRetiredSku\(m\.slug,code\)\) continue;/.test(dash),'price list skips retired and switched-off codes');
  /* run the page's own filter */
  const vm=require('vm'); const ctx={}; vm.createContext(ctx);
  const fn=dash.slice(dash.indexOf('const RETIRED_SKUS='),dash.indexOf('async function loadPricing(){'));
  vm.runInContext(fn.replace('const RETIRED_SKUS','var RETIRED_SKUS')+';this.f=isRetiredSku;',ctx);
  ok(ctx.f('pedifix','8520')&&ctx.f('PediFix','p3012-12')&&!ctx.f('pedifix','P3095')&&!ctx.f('ovation-medical','8520'),'filter');
});
console.log(`\nretired skus: ${pass} passed, ${fail} failed`); process.exitCode=fail?1:0;
})();

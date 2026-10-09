/* 2.7 — the server is the final pricing authority.
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

const LINE='ovation-medical';
const TIERS=[{minQty:1,price:50},{minQty:3,price:40}];
const FILE=()=>({[LINE]:[
  {manufacturer:LINE,code:'A1',name:'Standard item',group:'',base_price:50},
  {manufacturer:LINE,code:'B1',name:'Boot S',group:'Boot',base_price:50,tiers:TIERS},
  {manufacturer:LINE,code:'B2',name:'Boot M',group:'Boot',base_price:50,tiers:TIERS},
  {manufacturer:LINE,code:'C1',name:'Contract item',group:'',base_price:20},
]});

function world({files, tables, failRead, failWrite, fileStatus}){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, failRead, failWrite,
    tables:Object.assign({
      app_settings:[{key:'platform_state',value:{mode:'development'}}],
      manufacturers:[{slug:LINE,name:'Ovation Medical'},{slug:'golden-technologies',name:'Golden'}],
      manufacturer_meta:[{slug:LINE}],
      dealers:[{id:'d1',parent_id:'m1',is_test:true},{id:'m1',parent_id:null}],
      dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
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
const order=(items,extra)=>Object.assign({manufacturer_slug:LINE,manufacturer_name:'Ovation Medical',po:'PO1',items},extra||{});
const item=(r,code)=>r.body.orders[0].items.find(i=>i.code===code);
const setOverride=(W,code,patch)=>{ W.db.product_overrides=W.db.product_overrides.filter(o=>o.code!==code); W.db.product_overrides.push({manufacturer:LINE,code,patch}); };

(async()=>{
await t('standard price: the server price is the list price, and an unchanged cart reports no change',async()=>{
  const W=world({}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:2,unit:50}])]});
  eq(r.status,200,'status'); eq(r.body.changed,false,'changed');
  eq(item(r,'A1').unit,50,'unit'); eq(item(r,'A1').line_total,100,'line'); eq(r.body.orders[0].subtotal,100,'subtotal');
});
await t('quantity tier: breaks apply on the family quantity, exactly as the shop computes it',async()=>{
  const W=world({}); const C=mod(W);
  const same=await call(C,{action:'price_check',orders:[order([{code:'B1',qty:2,unit:40},{code:'B2',qty:1,unit:40}])]});
  eq(same.body.changed,false,'2+1 of the family reach the 3+ rung'); eq(item(same,'B1').unit,40,'B1'); eq(item(same,'B2').unit,40,'B2');
  const alone=await call(C,{action:'price_check',orders:[order([{code:'B1',qty:2,unit:50}])]});
  eq(item(alone,'B1').unit,50,'2 alone stay on the first rung');
  const wrong=await call(C,{action:'price_check',orders:[order([{code:'B1',qty:2,unit:50},{code:'B2',qty:1,unit:50}])]});
  eq(wrong.body.changed,true,'a cart that missed the break is corrected'); eq(item(wrong,'B1').unit,40,'corrected');
});
await t('contract price: the branch row beats the master row, and the master row reaches an added product',async()=>{
  const W=world({}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'C1',qty:1,unit:17},{code:'X9',qty:1,unit:25}])]});
  eq(r.body.changed,false,'changed'); eq(item(r,'C1').unit,17,'branch contract'); eq(item(r,'X9').unit,25,'master contract on an added product');
  eq([item(r,'C1').contract,item(r,'X9').contract,],[17,25],'contract prices travel back to the browser');
  const n=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]}); eq(item(n,'A1').contract,null,'no contract');
});
await t('price increase while the cart was saved: reported with old and new, and create refuses to save',async()=>{
  const W=world({}); const C=mod(W); setOverride(W,'A1',{base_price:55});
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]});
  eq(r.body.changed,true,'changed'); eq([item(r,'A1').client_unit,item(r,'A1').unit],[50,55],'old → new');
  eq(item(r,'A1').commercial.base_price,55,'fresh commercial fields travel back to the browser');
  const c=await call(C,{action:'create',orders:[order([{code:'A1',qty:1,unit:50}])],dealer:{email:'d@x.com'}});
  eq(c.status,409,'refused'); eq(c.body.status,'prices_changed','reason'); eq(W.db.orders.length,0,'nothing saved');
});
await t('price decrease while the cart was saved: also reported, never silently applied',async()=>{
  const W=world({}); const C=mod(W); setOverride(W,'A1',{base_price:45});
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]});
  eq(r.body.changed,true,'changed'); eq([item(r,'A1').client_unit,item(r,'A1').unit],[50,45],'old → new');
  const c=await call(C,{action:'create',orders:[order([{code:'A1',qty:1,unit:50}])],dealer:{}});
  eq(c.status,409,'refused'); eq(W.db.orders.length,0,'nothing saved');
});
await t('price change between review and checkout: refused, then saved at the reviewed server price',async()=>{
  const W=world({}); const C=mod(W);
  const rev=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:2,unit:50}])]});
  eq(rev.body.changed,false,'reviewed at 50');
  setOverride(W,'A1',{base_price:52});                                 // the admin edits the price
  const c1=await call(C,{action:'create',orders:[order([{code:'A1',qty:2,unit:50}],{items_subtotal:100})],dealer:{}});
  eq(c1.status,409,'checkout refuses the unseen total'); eq(item(c1,'A1').unit,52,'new price returned'); eq(W.db.orders.length,0,'nothing saved');
  const c2=await call(C,{action:'create',orders:[order([{code:'A1',qty:2,unit:52}],{items_subtotal:1})],dealer:{}});
  eq(c2.status,200,'accepted after review'); eq(c2.body.saved,1,'saved');
  eq(W.db.order_items.map(i=>[i.code,i.unit_price,i.line_total]),[['A1',52,104]],'stored line');
  eq(W.db.orders[0].subtotal,104,'the stored subtotal is the server subtotal, not the browser\'s');
  eq(c2.body.orders[0].items[0].unit,52,'create answers with what it stored');
});
await t('a tampered unit price is never stored',async()=>{
  const W=world({}); const C=mod(W);
  const c=await call(C,{action:'create',orders:[order([{code:'A1',qty:1,unit:1}])],dealer:{}});
  eq(c.status,409,'refused'); eq(W.db.order_items.length,0,'nothing stored');
});
await t('a product no longer offered is flagged, not priced',async()=>{
  const W=world({}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'GONE',qty:1,unit:10}])]});
  eq(r.body.changed,true,'changed'); eq(item(r,'GONE').available,false,'unavailable'); eq(item(r,'GONE').unit,null,'no price');
});
await t('a layer that cannot be read stops the pricing (no order priced from a partial catalog)',async()=>{
  const W=world({failRead:(table)=>table==='product_overrides'?500:0}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]});
  eq(r.status,503,'status'); eq(r.body.status,'pricing_unavailable','reason');
  const c=await call(C,{action:'create',orders:[order([{code:'A1',qty:1,unit:50}])],dealer:{}});
  eq(c.status,503,'create refuses'); eq(W.db.orders.length,0,'nothing saved');
});
await t('a catalog file that cannot be read stops the pricing; a missing content file does not',async()=>{
  const W=world({fileStatus:u=>u.includes('/data/content/')?0:502}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]});
  eq(r.status,503,'catalog file unreadable');
});
await t('Golden orders pass through untouched (Golden prices its own orders)',async()=>{
  const W=world({}); const C=mod(W);
  const c=await call(C,{action:'create',orders:[{manufacturer_slug:'golden-technologies',po:'G1',items:[{code:'PR-1',qty:1,unit:999}],items_subtotal:999}],dealer:{}});
  eq(c.status,200,'saved'); eq(W.db.order_items.map(i=>i.unit_price),[999],'client price kept for Golden');
  ok(!W.calls.some(x=>/golden-technologies/.test(x.url)&&/product_overrides|\/data\//.test(x.url)),'no HCPS layers read for Golden');
});
await t('an authoritative master record prices the line; one with a parity error does not',async()=>{
  const sku={manufacturer:LINE,code:'A1',code_norm:'A1',base_price:60,status:'active'};
  const W=world({tables:{product_skus:[sku],manufacturer_meta:[{slug:LINE,record_authoritative:true}]}}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:60}])]});
  eq(item(r,'A1').unit,60,'record price');
  const W2=world({tables:{product_skus:[sku],manufacturer_meta:[{slug:LINE,record_authoritative:true,record_resync_error:'parity: 1 drift'}]}}); const C2=mod(W2);
  const r2=await call(C2,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]});
  eq(item(r2,'A1').unit,50,'layers stand while parity is broken');
  const W3=world({tables:{product_skus:[sku],manufacturer_meta:[{slug:LINE,record_authoritative:false}]}}); const C3=mod(W3);
  const r3=await call(C3,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]});
  eq(item(r3,'A1').unit,50,'not authoritative: layers stand');
});
await t('a disabled enrichment page is not read (the shop cannot see it either)',async()=>{
  const pg={manufacturer:LINE,page_key:'p1',status:'published',disabled:true,skus:[{sku:'A1',disabled:true}]};
  const W=world({tables:{product_content:[pg]}}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]});
  eq(item(r,'A1').available,true,'still offered'); eq(r.body.changed,false,'unchanged');
  pg.disabled=false; const W2=world({tables:{product_content:[pg]}}); const C2=mod(W2);
  const r2=await call(C2,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]});
  eq(item(r2,'A1').available,false,'a live page that switches the SKU off withdraws it');
});
await t('one code in two families is priced by the family the dealer chose, never guessed',async()=>{
  const files={[LINE]:[{manufacturer:LINE,code:'SR3',family:'RS',base_price:100},{manufacturer:LINE,code:'SR3',family:'RR',base_price:200}]};
  const W=world({files}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'SR3',family:'RR',qty:1,unit:200}])]});
  eq(item(r,'SR3').unit,200,'RR family'); eq(r.body.changed,false,'unchanged');
  const r2=await call(C,{action:'price_check',orders:[order([{code:'SR3',qty:1,unit:100}])]});
  eq(item(r2,'SR3').available,false,'ambiguous without a family');
});
await t('an order whose lines cannot be written is withdrawn — never recorded half, never confirmed',async()=>{
  const W=world({failWrite:(m,t)=>m==='POST'&&t==='order_items'?500:0}); const C=mod(W);
  const c=await call(C,{action:'create',orders:[order([{code:'A1',qty:1,unit:50}])],dealer:{email:'d@x.com'}});
  eq(c.status,503,'refused'); eq(c.body.status,'record_failed','reason'); eq(W.db.orders.length,0,'order row withdrawn');
  eq(W.db.tracking_requests.length,0,'no tracking request'); ok(!W.calls.some(x=>/resend/.test(x.url)),'no confirmation email');
});
await t('one manufacturer failing to record does not hide the ones that did',async()=>{
  let n=0; const W=world({failWrite:(m,t)=>m==='POST'&&t==='order_items'&&(n++===1)?500:0}); const C=mod(W);
  W.db.manufacturers.push({slug:'other-line',name:'Other'});
  const c=await call(C,{action:'create',orders:[order([{code:'A1',qty:1,unit:50}]),{manufacturer_slug:'golden-technologies',po:'G',items:[{code:'G1',qty:1,unit:5}],items_subtotal:5}],dealer:{}});
  eq([c.status,c.body.status,c.body.saved],[200,'partial',1],'partial'); eq(c.body.failed.map(f=>f.manufacturer_slug),['golden-technologies'],'which failed');
  eq(c.body.orders.map(o=>o.manufacturer_slug),[LINE],'which recorded'); eq(W.db.orders.length,1,'one row');
});
await t('a failed HCPS notification flags the dealer\'s own recorded order, and nobody else\'s',async()=>{
  const W=world({tables:{orders:[{id:'o1',dealer_id:'d1'},{id:'o2',dealer_id:'zz'}]}}); const C=mod(W);
  const r=await call(C,{action:'notification_failed',order_ids:['o1','o2']});
  eq(r.status,200,'ok'); ok(/email failed/.test(W.db.orders[0].admin_notes||''),'own order flagged'); eq(W.db.orders[1].admin_notes,undefined,'other dealer untouched');
});
await t('visible is not sellable: a discontinued page or SKU is refused, a hidden SKU is not offered',async()=>{
  const pages=[{manufacturer:LINE,page_key:'pd',status:'discontinued',disabled:false,skus:[{sku:'A1'}]},
               {manufacturer:LINE,page_key:'pl',status:'published',disabled:false,skus:[{sku:'B1',status:'discontinued'},{sku:'B2',status:'hidden'},{sku:'C1'}]}];
  const W=world({tables:{product_content:pages}}); const C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50},{code:'B1',qty:1,unit:50},{code:'B2',qty:1,unit:50},{code:'C1',qty:1,unit:20}])]});
  eq(['A1','B1','B2','C1'].map(c=>item(r,c).available),[false,false,false,true],'availability');
  const c=await call(C,{action:'create',orders:[order([{code:'A1',qty:1,unit:50}])],dealer:{}});
  eq([c.status,W.db.orders.length],[409,0],'a discontinued product cannot be ordered');
});
await t('an unauthenticated caller gets nothing priced',async()=>{
  const W=world({}); const C=mod(W);
  const r=await M.call(C,{action:'price_check',orders:[order([{code:'A1',qty:1,unit:50}])]},{});
  eq(r.body.status,'unauthorized','status');
});
console.log(`\npricing: ${pass} passed, ${fail} failed`); process.exitCode=fail?1:0;
})();

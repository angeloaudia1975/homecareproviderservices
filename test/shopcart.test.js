/* 2.7 (shop) — cart and checkout price security, end to end.
   The storefront's REAL cart code (re-pricing, "Price updated", submitOrder, hydrateCart) is lifted
   from the shop page and run against the REAL submit-order function and the REAL orders-api
   (with the real _pricing.js), all over the in-memory PostgREST fake. Nothing is simulated except
   the network, the DOM and the email provider. */
const fs=require('fs'), path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ORD=process.env.ORDER_REPO||path.join(__dirname,'..','..','homecareproviderservicesordering');
const ADMIN=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOP=process.env.SHOP||path.join(ORD,'public','index.html');
const SUBMIT=process.env.SUBMIT||path.join(ORD,'netlify','functions','submit-order.js');
const {grabDecl}=require(path.join(__dirname,'extract-picker.js'));
const html=fs.readFileSync(SHOP,'utf8');
const slice=(a,b)=>{ const i=html.indexOf(a), j=html.indexOf(b,i); if(i<0||j<0) throw new Error('anchor '+(i<0?a:b)); return html.slice(i,j); };
const lineOf=a=>{ const i=html.indexOf('\n'+a); if(i<0) throw new Error('anchor '+a); return html.slice(i+1,html.indexOf('\n',i+1)); };
const CODE=[lineOf('const money = '),lineOf('const esc = '),
  ...['function familyQty','function tierQty','function contractPrice','function unitPrice','const cartKey=','function groupCart','function linesSubtotal'].map(a=>grabDecl(html,a)),
  slice('/* ---------- SERVER PRICING','/* ---------- submit (one order'), slice('async function submitOrder(){','/* ---- Stage 6: submit one Golden order'), slice('function hydrateCart(saved){','/* ---- persistent cart')].join('\n');

let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,3).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const tick=()=>new Promise(r=>setTimeout(r,0));

const LINE='ovation-medical', OB='https://ordering.test', API='https://admin.test/orders-api';
const TIERS=[{minQty:1,price:50},{minQty:3,price:40}];
const FILE={[LINE]:[
  {manufacturer:LINE,code:'A1',name:'Standard item',group:'',base_price:50},
  {manufacturer:LINE,code:'B1',name:'Boot S',group:'Boot',base_price:50,tiers:TIERS},
  {manufacturer:LINE,code:'B2',name:'Boot M',group:'Boot',base_price:50,tiers:TIERS},
  {manufacturer:LINE,code:'C1',name:'Contract item',group:'',base_price:20}],
  'other-line':[{manufacturer:'other-line',code:'Z1',name:'Other item',group:'',base_price:10}]};

function env(opts){
  opts=opts||{};
  const W=M.createWorld({failRead:(t)=>(opts.failMeta||(opts.state&&opts.state.failMeta))&&t==='manufacturer_meta'?500:0, failWrite:(m,t,b)=>m==='POST'&&t==='order_items'&&(opts.failItems||(opts.failItemsFor&&[].concat(b)[0].code===opts.failItemsFor))?500:0, tables:{
    app_settings:[{key:'platform_state',value:{mode:'development'}}],
    manufacturers:[{slug:LINE,name:'Ovation Medical'},{slug:'golden-technologies',name:'Golden'},{slug:'other-line',name:'Other'}], manufacturer_meta:[{slug:LINE},{slug:'other-line'}],
    dealers:[{id:'d1',parent_id:null,is_test:true}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
    dealer_contract_prices:[{dealer_id:'d1',manufacturer:LINE,code:'C1',price:17,active:true}],
    product_overrides:[], custom_products:[], product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[],
    orders:[], order_items:[], tracking_requests:[], email_sends:[], intent_events:[], email_attribution:[]}});
  const emails=[], allMail=[], hits={price_check:0,create:0,submit:0};
  const inner=W.fetch;
  let ordersApi, submitFn;
  const router=async(url,o)=>{
    const u=String(url);
    if(u===API){ const b=JSON.parse(o.body); hits[b.action]=(hits[b.action]||0)+1;
      if(opts.beforeApi) await opts.beforeApi(b,W);
      const r=await ordersApi.handler({httpMethod:'POST',headers:Object.assign({},o.headers),body:o.body});
      return {ok:r.statusCode<300,status:r.statusCode,json:async()=>JSON.parse(r.body)}; }
    if(u==='/submit'){ hits.submit++; const r=await submitFn.handler({httpMethod:'POST',headers:Object.assign({},o.headers),body:o.body});
      return {ok:r.statusCode<300,status:r.statusCode,json:async()=>JSON.parse(r.body)}; }
    if(u.startsWith(M.BASE+'/auth/v1/user')) return String((o.headers||{}).Authorization||'')==='Bearer jwt'
      ?{ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})}:{ok:false,status:401,json:async()=>({})};
    if(u.startsWith(OB+'/data/')){ const content=u.includes('/data/content/');
      const slug=decodeURIComponent(u.slice((OB+(content?'/data/content/':'/data/')).length).replace(/\.json.*$/,''));
      if(content||!(slug in FILE)) return {ok:false,status:404,json:async()=>null};
      return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(FILE[slug]))}; }
    if(u.startsWith('https://api.resend.com')){ const m=JSON.parse(o.body); allMail.push(m); if(/^New order/.test(m.subject)) emails.push(m); return {ok:opts.emailFails?false:true,status:opts.emailFails?500:200,json:async()=>({id:'m'})}; }
    return inner(url,o);
  };
  W.fetch=router;
  ordersApi=M.load('orders-api.js',W,{ORDERING_BASE:OB},ADMIN);
  delete require.cache[require.resolve(SUBMIT)]; process.env.ORDERS_API=API; process.env.RESEND_API_KEY='re';
  submitFn=require(SUBMIT);
  global.fetch=router;
  /* the page */
  const toasts=[]; const fields={f_biz:'Biz',f_acct:'',f_contact:'Pat',f_email:'d@x.com',f_phone:'',f_addr:'',f_city:'',f_state:'',f_zip:''};
  const btn={disabled:false,textContent:'Place order →'};
  const $=sel=>sel==='#submitOrder'?btn:{value:fields[sel.slice(1)]||'',classList:{add(){},remove(){}}};
  const shop=new Function('fetch','$','toast','document','CONFIG','AUTH','PREVIEW','CART','MFR','DASH','state','window','console',
    `let SHIPTO_LABEL=""; function updateCart(){ } function closeCart(){ } function clearCartRemote(){ } async function ensureFreshSession(){ }
     function track(){ } function isGoldenSlug(s){ return s==='golden-technologies'; } function mfrInfo(s){ return {slug:s,name:s}; }
     function computeFreight(slug,lines){ return {rows:[],fee:0,itemsTotal:linesSubtotal(lines),actualNote:''}; }
     async function submitGoldenOrder(){ }
     ${CODE}
     return {submitOrder, hydrateCart, applyServerPrices, priceNoteHtml, priceBannerHtml, serverPriceCheck, unitPrice, PRICE_NOTES};`);
  const CART=new Map(), MFR={}, AUTH={status:'approved',session:{access_token:'jwt'},prices:Object.assign({},opts.prices||{})};
  const page=shop(router,$,m=>toasts.push(m),{querySelector:()=>null},{ORDERS_ENDPOINT:API,ORDER_ENDPOINT:'/submit'},AUTH,null,CART,MFR,{orders:[]},{},{},console);
  const prod=(code,x)=>Object.assign(JSON.parse(JSON.stringify(FILE[LINE].find(p=>p.code===code))),x||{});
  const add=(code,qty,x)=>{ const p=prod(code,x); CART.set(LINE+'::'+code,{p,qty}); MFR[LINE]={po:'PO-7',notes:''}; return p; };
  const setPrice=(code,patch)=>{ W.db.product_overrides=W.db.product_overrides.filter(o=>o.code!==code); W.db.product_overrides.push({manufacturer:LINE,code,patch}); };
  return {W,page,CART,MFR,AUTH,toasts,emails,allMail,hits,add,setPrice,btn,ordersApi:()=>ordersApi};
}
const saved=items=>({items,mfr:{[LINE]:{po:'PO-7',notes:''}}});
const settle=async()=>{ for(let i=0;i<20;i++) await tick(); };

(async()=>{
await t('standard price: a cart at the current price submits, and the order and email carry the server price',async()=>{
  const E=env(); E.add('A1',2);
  await E.page.submitOrder();
  eq(E.W.db.order_items.map(i=>[i.code,i.unit_price,i.line_total]),[['A1',50,100]],'stored');
  eq(E.emails.length,1,'one HCPS email'); ok(/\$50\.00/.test(E.emails[0].html)&&/\$100\.00/.test(E.emails[0].html),'email shows server prices');
  eq(E.CART.size,0,'cart cleared'); eq(E.page.PRICE_NOTES.size,0,'no notes');
  eq(E.hits.create,1,'recorded once, by submit-order');
});
await t('a Golden line is recorded by the page, the HCPS line only by submit-order — never twice',async()=>{
  const E=env(); E.add('A1',1);
  E.CART.set('golden-technologies::PR1',{p:{manufacturer:'golden-technologies',code:'PR1',name:'Chair',base_price:900},qty:1}); E.MFR['golden-technologies']={po:'G-1',notes:''};
  await E.page.submitOrder();
  eq(E.W.db.orders.map(o=>o.manufacturer).sort(),['golden-technologies',LINE].sort(),'one order each');
});
await t('if recording fails after the check, nothing is placed and the cart is kept',async()=>{
  const st={}; const E=env({state:st,beforeApi:(b)=>{ if(b.action==='create') st.failMeta=true; }}); E.add('A1',1);
  await E.page.submitOrder();
  eq([E.W.db.orders.length,E.emails.length,E.CART.size],[0,0,1],'nothing placed, cart kept');
  ok(E.toasts.some(m=>/nothing was submitted|nothing was placed/i.test(m)),'told: '+E.toasts.join(' | '));
});
await t('price increase while saved: the restored cart shows "Price updated" old → new and recalculates',async()=>{
  const E=env(); E.setPrice('A1',{base_price:55});
  E.page.hydrateCart(saved([{p:E.add('A1',1),qty:1}].map(x=>x))); await settle();
  const line=E.CART.get(LINE+'::A1'); eq(E.page.unitPrice(line.p,1),55,'cart now prices at 55');
  const note=E.page.priceNoteHtml(line.p); ok(/Price updated/.test(note)&&/\$50\.00/.test(note)&&/\$55\.00/.test(note),'note: '+note);
  ok(/Prices in your cart have changed/.test(E.page.priceBannerHtml()),'banner');
  eq(E.hits.create,0,'nothing submitted by restoring a cart');
});
await t('price decrease while saved: shown the same way, never applied silently',async()=>{
  const E=env(); E.setPrice('A1',{base_price:45});
  E.page.hydrateCart(saved([{p:E.add('A1',1),qty:1}])); await settle();
  const p=E.CART.get(LINE+'::A1').p; eq(E.page.unitPrice(p,1),45,'45');
  ok(/\$50\.00.*\$45\.00/.test(E.page.priceNoteHtml(p)),'old → new');
});
await t('quantity tier: a stale saved product gains the current ladder and the family break',async()=>{
  const E=env();
  const b1=E.add('B1',2,{tiers:null}), b2=E.add('B2',1,{tiers:null});
  E.page.hydrateCart(saved([{p:b1,qty:2},{p:b2,qty:1}])); await settle();
  const p=E.CART.get(LINE+'::B1').p; eq(E.page.unitPrice(p,2),40,'family of 3 reaches the 3+ rung');
  ok(/\$50\.00.*\$40\.00/.test(E.page.priceNoteHtml(p)),'note');
  const again=await E.page.serverPriceCheck(); eq(again.changed,false,'browser and server now agree');
});
await t('contract price: a stale contract price from sign-in is corrected once, not argued forever',async()=>{
  const E=env({prices:{[LINE+'::C1']:18}}); E.add('C1',1);
  const r=await E.page.serverPriceCheck(); eq(r.changed,true,'server says 17'); E.page.applyServerPrices(r);
  eq(E.AUTH.prices[LINE+'::C1'],17,'contract updated'); eq(E.page.unitPrice(E.CART.get(LINE+'::C1').p,1),17,'cart at 17');
  const r2=await E.page.serverPriceCheck(); eq(r2.changed,false,'agreed');
  await E.page.submitOrder(); eq(E.W.db.order_items.map(i=>i.unit_price),[17],'stored at contract');
});
await t('price change between review and checkout: nothing is submitted until the dealer has seen the new price',async()=>{
  const E=env(); E.add('A1',2);
  eq((await E.page.serverPriceCheck()).changed,false,'reviewed at 50');
  E.setPrice('A1',{base_price:52});
  await E.page.submitOrder();
  eq([E.hits.submit,E.W.db.orders.length,E.allMail.length],[0,0,0],'nothing submitted, recorded or emailed (no HCPS, dealer or tracking mail)');
  ok(E.toasts.some(m=>/Prices changed/.test(m)),'dealer told'); ok(/\$50\.00.*\$52\.00/.test(E.page.priceNoteHtml(E.CART.get(LINE+'::A1').p)),'line shows old → new');
  eq(E.CART.size,1,'cart kept for review');
  await E.page.submitOrder();
  eq(E.W.db.order_items.map(i=>[i.unit_price,i.line_total]),[[52,104]],'submitted at the reviewed price');
  ok(/\$52\.00/.test(E.emails[0].html),'email at 52');
  eq([E.W.db.orders.length,E.emails.length],[1,1],'exactly one order and one HCPS notification');
  const hist=await M.call(E.ordersApi(),{action:'list'},{headers:{authorization:'Bearer jwt'}});
  /* (the in-memory fake does not embed order_items, so the lines are joined from the table) */
  const H=hist.body.orders; eq(H.length,1,'one order in history');
  eq([H[0].subtotal,E.W.db.order_items.filter(x=>x.order_id===H[0].id).map(x=>[x.code,x.unit_price,x.line_total])],[104,[['A1',52,104]]],'order history = stored order');
  ok(/\$104\.00/.test(E.emails[0].html)&&/\$52\.00/.test(E.emails[0].html),'email = order history');
});
await t('a price change in the last moment (after the check, before the record) is refused by the server, not emailed',async()=>{
  let armed=true;
  const E=env({beforeApi:(b)=>{ if(b.action==='create'&&armed){ armed=false; E.setPrice('A1',{base_price:58}); } }}); E.add('A1',1);
  await E.page.submitOrder();
  eq([E.W.db.orders.length,E.emails.length],[0,0],'nothing recorded or emailed');
  ok(/\$50\.00.*\$58\.00/.test(E.page.priceNoteHtml(E.CART.get(LINE+'::A1').p)),'new price shown'); eq(E.CART.size,1,'cart kept');
});
await t('a withdrawn product blocks the order until it is removed',async()=>{
  const E=env(); E.add('A1',1); E.CART.set(LINE+'::GONE',{p:{manufacturer:LINE,code:'GONE',name:'Old',base_price:9},qty:1});
  await E.page.submitOrder();
  eq(E.W.db.orders.length,0,'nothing placed'); ok(/No longer available/.test(E.page.priceNoteHtml(E.CART.get(LINE+'::GONE').p)),'flagged');
  await E.page.submitOrder(); eq(E.hits.submit,0,'still blocked'); ok(E.toasts.some(m=>/no longer available/i.test(m)),'told to remove');
  E.CART.delete(LINE+'::GONE'); await E.page.submitOrder(); eq(E.W.db.orders.length,1,'placed after removal');
});
await t('pricing that cannot be confirmed submits nothing',async()=>{
  const E=env({failMeta:true}); E.add('A1',1);   // the line's meta cannot be read
  await E.page.submitOrder();
  eq([E.hits.submit,E.W.db.orders.length],[0,0],'nothing'); ok(E.toasts.some(m=>/could not be confirmed/.test(m)),'told');
});
await t('submit-order refuses a browser that is not signed in, and an out-of-date page',async()=>{
  const E=env(); const S=require(SUBMIT);
  const body=JSON.stringify({dealer:{business:'B',contact:'C',email:'d@x.com'},orders:[{manufacturer_slug:LINE,manufacturer_name:'O',po:'1',items:[{code:'A1',qty:1,unit:50}]}]});
  const r=await S.handler({httpMethod:'POST',headers:{},body}); eq(r.statusCode,401,'no sign-in');
  const r2=await S.handler({httpMethod:'POST',headers:{authorization:'Bearer jwt'},body:JSON.stringify({business:'B',contact:'C',email:'d@x.com',items:[]})}); eq(r2.statusCode,400,'legacy payload');
  eq([E.emails.length,E.hits.create],[0,0],'nothing emailed, orders-api never asked');
});
await t('the HCPS email carries the totals the server stored, not the browser\'s',async()=>{
  const E=env(); const S=require(SUBMIT);
  const body=JSON.stringify({dealer:{business:'B',contact:'C',email:'d@x.com'},orders:[{manufacturer_slug:LINE,manufacturer_name:'O',po:'1',items:[{code:'A1',qty:2,unit:50}],items_count:2,items_subtotal:1,freight_fee:0,estimated_total:1}]});
  const r=await S.handler({httpMethod:'POST',headers:{authorization:'Bearer jwt'},body}); eq(r.statusCode,200,'sent');
  ok(/\$100\.00/.test(E.emails[0].html) && !/\$1\.00/.test(E.emails[0].html),'server subtotal in the email'); ok(/\$100\.00/.test(E.emails[0].subject),'and in the subject');
});
await t('a tampered browser price is never emailed or stored',async()=>{
  const E=env(); const S=require(SUBMIT);
  const body=JSON.stringify({dealer:{business:'B',contact:'C',email:'d@x.com'},orders:[{manufacturer_slug:LINE,manufacturer_name:'O',po:'1',items:[{code:'A1',qty:1,unit:1}],items_subtotal:1,estimated_total:1}]});
  const r=await S.handler({httpMethod:'POST',headers:{authorization:'Bearer jwt'},body}); eq(r.statusCode,409,'refused');
  eq([E.emails.length,E.W.db.orders.length],[0,0],'nothing');
});
await t('if only the HCPS email fails, the order stands at the server price and the dealer is told',async()=>{
  const E=env({emailFails:true}); E.add('A1',1);
  await E.page.submitOrder();
  eq(E.W.db.order_items.map(i=>i.unit_price),[50],'recorded'); ok(E.toasts.some(m=>/recorded/.test(m)),'told'); eq(E.CART.size,0,'not resubmittable twice');
  eq(E.emails.length,2,'the HCPS email was retried once');
  ok(/HCPS order email failed/.test(E.W.db.orders[0].admin_notes||''),'the recorded order is flagged for staff');
});
await t('when one manufacturer\'s order cannot be recorded, only the recorded one is emailed and leaves the cart',async()=>{
  const E=env({failItemsFor:'Z1'}); E.add('A1',1);
  E.CART.set('other-line::Z1',{p:{manufacturer:'other-line',code:'Z1',name:'Other item',group:'',base_price:10},qty:1}); E.MFR['other-line']={po:'PO-9',notes:''};
  await E.page.submitOrder();
  eq(E.W.db.orders.map(o=>o.manufacturer),[LINE],'only Ovation recorded'); eq(E.emails.length,1,'only Ovation emailed');
  eq([...E.CART.keys()],['other-line::Z1'],'the unrecorded order stays in the cart'); ok(E.toasts.some(m=>/could not be recorded/.test(m)),'told');
});
await t('if the order cannot be persisted, no order email of any kind is sent and the cart is kept',async()=>{
  const E=env({failItems:true}); E.add('A1',1);
  await E.page.submitOrder();
  eq([E.W.db.orders.length,E.W.db.order_items.length,E.allMail.length,E.CART.size],[0,0,0,1],'nothing persisted, nothing sent, cart kept');
  ok(E.toasts.some(m=>/nothing was submitted|nothing was placed/i.test(m)),'told: '+E.toasts.join(' | '));
});
console.log(`\nshop cart: ${pass} passed, ${fail} failed`); process.exitCode=fail?1:0;
})();

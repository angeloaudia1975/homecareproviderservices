/* Strongback shipping & handling (confirmed 2026-10-09): $15 once per Strongback order that holds one
   or more accessories, whatever their number; models (wheelchairs, ErgoSteel, SEATA) ship included.
   One rule, the storefront's own computeFreight, run in the browser and on the server; the stored
   order, the HCPS email and the dealer confirmation all carry the server's figure. */
const path=require('path'), fs=require('fs'), vm=require('vm');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const SHOP=process.env.SHOP_HTML||path.join(SHOPD,'public','index.html');
const MFRS=process.env.MFRS_JSON||path.join(SHOPD,'public','data','manufacturers.json');
const SUBMIT=process.env.SUBMIT_JS||path.join(SHOPD,'netlify','functions','submit-order.js');
const OB='https://ordering.test', SB='strongback-mobility';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const mfrs=JSON.parse(fs.readFileSync(MFRS,'utf8'));
const ROWS=[['1003AB','Wheelchairs',527],['1017','Wheelchairs',536],['ES0001','Wheelchairs',240],['R0001','Rollator',320],
  ['SB100','Accessories',7.7],['A1000','Accessories',162.47],['A1001','Accessories',162.47],['A1004','Accessories',55],['A1005','Accessories',50]];
function world(){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, tables:{ app_settings:[{key:'platform_state',value:{mode:'live'}}],
    manufacturers:[{slug:SB,name:'Strongback Mobility'}], manufacturer_meta:[{slug:SB}],
    dealers:[{id:'d1',parent_id:null,is_test:false}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
    dealer_contract_prices:[], product_overrides:[{manufacturer:SB,code:'RC100',patch:{active:false,disposition:'not_offered'}}], product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[],
    custom_products:ROWS.map(([code,category,b])=>({manufacturer:SB,code,name:code,category,base_price:b,active:true})).concat([{manufacturer:SB,code:'RC100',name:'RC100',category:'Accessories',base_price:5,active:false}]),
    orders:[], order_items:[], tracking_requests:[], email_sends:[], intent_events:[], email_attribution:[] }});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')) return {ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})};
    if(u===OB+'/data/manufacturers.json') return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(mfrs))};
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    if(u.startsWith('https://api.resend.com')){ W.calls.push({url:u,method:'POST',body:JSON.parse(opts.body)}); return {ok:true,status:200,json:async()=>({id:'m'})}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return inner(url,opts); };
  return W; }
const mod=W=>M.load('orders-api.js',W,{ORDERING_BASE:OB,RESEND_API_KEY:'k'},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{authorization:'Bearer dealer'}});
const PRICE=Object.fromEntries(ROWS.map(([c,,b])=>[c,b]));
const ord=lines=>[{manufacturer_slug:SB,manufacturer_name:'Strongback Mobility',po:'P',items:lines.map(([code,qty])=>({code,qty,unit:PRICE[code]==null?0:PRICE[code]}))}];
const serverFreight=async lines=>{ const C=mod(world()); const r=await call(C,{action:'price_check',orders:ord(lines)});
  if(r.status!==200) throw new Error(JSON.stringify(r.body)); return r.body.orders[0]; };
/* The browser: the shop page's own computeFreight / linesSubtotal / unitPrice. */
const html=fs.readFileSync(SHOP,'utf8');
const {grabDecl}=require(path.join(__dirname,'extract-picker.js'));
const code=['function familyQty','function tierQty','function contractPrice','function unitPrice','function linesSubtotal','function computeFreight'].map(a=>grabDecl(html,a)).join('\n');
const browserFreight=lines=>{ const entry=mfrs.find(m=>m.slug===SB);
  const ctx={CART:new Map(),AUTH:{prices:{}},mfrInfo:s=>s===SB?entry:{slug:s}}; vm.createContext(ctx); vm.runInContext(code+';this.cf=computeFreight;',ctx);
  const by=Object.fromEntries(ROWS.map(([c,category,b])=>[c,{manufacturer:SB,code:c,category,base_price:b}]));
  const ls=lines.map(([c,q])=>({p:by[c],qty:q})); ls.forEach((l,i)=>ctx.CART.set(i,l)); return ctx.cf(SB,ls).fee; };
const CASES=[
 ['wheelchair only',[['1003AB',1]],0],['SEATA only',[['R0001',1]],0],['one accessory',[['SB100',1]],15],
 ['qty 10 of one accessory',[['A1004',10]],15],['two different accessories',[['A1000',1],['A1001',1]],15],
 ['wheelchair + accessory',[['1017',1],['SB100',1]],15],['SEATA + multiple accessories',[['R0001',1],['A1004',2],['SB100',3]],15],
 ['multiple wheelchairs + multiple accessories',[['1003AB',2],['1017',1],['ES0001',1],['A1000',1],['A1005',2]],15],
 ['A1005 4-pack only',[['A1005',1]],15],['A1005 + another accessory',[['A1005',1],['A1001',1]],15]];
(async()=>{
for(const [n,lines,want] of CASES){
  await t(`${n} → $${want} (browser = server)`,async()=>{
    const s=await serverFreight(lines); const b=browserFreight(lines);
    eq([s.freight_fee,b],[want,want],'freight'); eq(s.estimated_total,Math.round((s.subtotal+want)*100)/100,'total');
  });
}
await t('RC100 cannot be ordered (not offered → refused by the server)',async()=>{
  const C=mod(world()); const r=await call(C,{action:'price_check',orders:ord([['RC100',1]])});
  eq([r.body.orders[0].items[0].available,r.body.changed],[false,true]);
});
await t('stored order, dealer confirmation and HCPS email carry the same $15 and total',async()=>{
  const W=world(); const C=mod(W);
  const lines=[['1003AB',1],['A1005',1],['SB100',2]];
  const r=await call(C,{action:'create',dealer:{business:'B',email:'buyer@x.com',contact:'C'},orders:ord(lines)});
  eq(r.status,200,JSON.stringify(r.body));
  const o=W.db.orders[0]; eq([o.subtotal,o.freight_fee,o.estimated_total],[592.4,15,607.4],'stored');
  eq([r.body.orders[0].freight_fee,r.body.orders[0].estimated_total],[15,607.4],'returned to submit-order');
  const mail=W.calls.find(c=>/resend/.test(c.url)); ok(mail,'no confirmation');
  ok(/Freight: \$15\.00/.test(mail.body.text)&&/Total: \$607\.40/.test(mail.body.text),'dealer text: '+mail.body.text);
  ok(/Freight: \$15\.00/.test(mail.body.html),'dealer html');
  delete require.cache[require.resolve(SUBMIT)]; const S=require(SUBMIT);
  const browserOrder=[{manufacturer_slug:SB,manufacturer_name:'Strongback',po:'P',items:lines.map(([code,qty])=>({code,name:code,qty,unit:1})),freight_fee:0,freight_lines:[]}];
  const merged=S._applyServerPrices(browserOrder,r.body.orders)[0];
  eq([merged.freight_fee,merged.estimated_total],[15,607.4],'HCPS email order uses the server freight, not the browser figure');
  const em=S._buildEmail({business:'B',email:'b@x.com'},merged); ok(/Freight: \$15\.00 flat/.test(em.text),'HCPS text: '+em.text.slice(0,500));
});
await t('a wheelchair-only order stores $0 freight and its confirmation says Free',async()=>{
  const W=world(); const C=mod(W);
  const r=await call(C,{action:'create',dealer:{business:'B',email:'buyer@x.com',contact:'C'},orders:ord([['1017',1]])});
  eq([W.db.orders[0].freight_fee,W.db.orders[0].estimated_total],[0,536]);
  const mail=W.calls.find(c=>/resend/.test(c.url)); ok(/Freight: Free/.test(mail.body.text),'text: '+mail.body.text);
});
console.log(`freight: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

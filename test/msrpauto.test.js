/* MSRP has three states (agreed 2026-10-09): populated → shown; empty + msrp_auto not false →
   derived at 2x; empty + msrp_auto === false → NO MSRP. Proven through the real storefront engine
   (orders-api → _pricing → _shop_engine, the shop page's own text) and the admin parity check. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const OB='https://ordering.test';
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const LINE='ovation-medical';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function world({file,tables}){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'},
    tables:Object.assign({ app_settings:[{key:'platform_state',value:{mode:'development'}}],
      manufacturers:[{slug:LINE,name:'Ovation Medical'}], manufacturer_meta:[{slug:LINE}],
      dealers:[{id:'d1',parent_id:null}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
      dealer_contract_prices:[], product_overrides:[], custom_products:[], product_images:[], product_links:[], product_media:[],
      product_content:[], product_skus:[], orders:[], order_items:[] }, tables||{})});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')) return {ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})};
    if(u.startsWith(OB+'/data/')){ const content=u.includes('/data/content/'); if(content) return {ok:false,status:404,json:async()=>null,text:async()=>''};
      return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(file)),text:async()=>JSON.stringify(file)}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); });
    return inner(url,opts); };
  return W;
}
const priced=async(W,code)=>{ const C=M.load('orders-api.js',W,{ORDERING_BASE:OB},ROOT);
  const r=await M.call(C,{action:'price_check',orders:[{manufacturer_slug:LINE,items:[{code,qty:1,unit:0}]}]},{headers:{authorization:'Bearer dealer'}});
  if(r.status!==200) throw new Error('price_check '+r.status+' '+JSON.stringify(r.body));
  return r.body.orders[0].items[0].commercial; };
(async()=>{
await t('legacy behaviour kept: no MSRP and no flag → derived at 2x',async()=>{
  const c=await priced(world({file:[{code:'A1',name:'a',base_price:10}]}),'A1'); eq(c.msrp,20);
});
await t('a manufacturer MSRP is shown as is',async()=>{
  const c=await priced(world({file:[{code:'A1',name:'a',base_price:10,msrp:33}]}),'A1'); eq(c.msrp,33);
});
await t('msrp_auto false on the saved edit clears an MSRP an added row still carries (4900-Wrap)',async()=>{
  const W=world({file:[{code:'4900-Wrap',name:'w',base_price:19.5}],tables:{
    custom_products:[{manufacturer:LINE,code:'4900-Wrap',name:'w',base_price:9.95,msrp:19.9,msrp_auto:true,active:true}],
    product_overrides:[{manufacturer:LINE,code:'4900-Wrap',patch:{base_price:19.5,msrp:null,msrp_auto:false}}]}});
  const c=await priced(W,'4900-Wrap'); eq([c.base_price,c.msrp],[19.5,null]);
});
await t('the saved edit clears an MSRP the catalog FILE carries',async()=>{
  const W=world({file:[{code:'A1',name:'a',base_price:19.5,msrp:19.9}],tables:{product_overrides:[{manufacturer:LINE,code:'A1',patch:{msrp:null,msrp_auto:false}}]}});
  eq((await priced(W,'A1')).msrp,null);
});
await t('the saved edit clears an MSRP an ADDED product carries (no file row)',async()=>{
  const W=world({file:[],tables:{custom_products:[{manufacturer:LINE,code:'S2',name:'s',base_price:9.95,msrp:19.9,msrp_auto:true,active:true}],
    product_overrides:[{manufacturer:LINE,code:'S2',patch:{msrp:null,msrp_auto:false}}]}});
  eq((await priced(W,'S2')).msrp,null);
});
await t('the added-product COLUMN msrp_auto=false (its default) is not "no MSRP" — 28 live Ovation rows keep theirs',async()=>{
  const W=world({file:[],tables:{custom_products:[{manufacturer:LINE,code:'S1',name:'s',base_price:50,msrp:null,msrp_auto:false,active:true}]}});
  eq((await priced(W,'S1')).msrp,100);
});
await t('an added product whose SAVED EDIT says msrp_auto false and no MSRP shows none',async()=>{
  const W=world({file:[],tables:{custom_products:[{manufacturer:LINE,code:'S1',name:'s',base_price:50,msrp:null,msrp_auto:false,active:true}],
    product_overrides:[{manufacturer:LINE,code:'S1',patch:{msrp:null,msrp_auto:false}}]}});
  eq((await priced(W,'S1')).msrp,null);
});
await t('msrp_auto false WITH an MSRP keeps that MSRP',async()=>{
  const W=world({file:[{code:'A1',name:'a',base_price:10}],tables:{product_overrides:[{manufacturer:LINE,code:'A1',patch:{msrp:25,msrp_auto:false}}]}});
  eq((await priced(W,'A1')).msrp,25);
});
await t('an authoritative record that says "no MSRP" wins over a derived one',async()=>{
  const W=world({file:[{code:'A1',name:'a',base_price:10}],tables:{
    manufacturer_meta:[{slug:LINE,record_authoritative:true}],
    product_skus:[{manufacturer:LINE,code:'A1',base_price:10,msrp:null,msrp_auto:false,status:'active'}]}});
  eq((await priced(W,'A1')).msrp,null);
});
await t('a record that merely lacks an MSRP (msrp_auto true) keeps the derived one',async()=>{
  const W=world({file:[{code:'A1',name:'a',base_price:10}],tables:{
    manufacturer_meta:[{slug:LINE,record_authoritative:true}],
    product_skus:[{manufacturer:LINE,code:'A1',base_price:10,msrp:null,msrp_auto:true,status:'active'}]}});
  eq((await priced(W,'A1')).msrp,20);
});
// ---- admin parity: the same rule, so authority is never granted over a fabricated MSRP ----
const parity=async(tables,file)=>{ const W=M.createWorld({tables:Object.assign({manufacturer_meta:[{slug:LINE}],product_overrides:[],custom_products:[],product_content:[],product_skus:[]},tables)});
  const inner=W.fetch; W.fetch=async(u,o)=>{ u=String(u); if(u.startsWith(OB+'/data/')) return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(file)),text:async()=>JSON.stringify(file)}; (W.db.product_skus||[]).forEach(r=>{r.code_norm=norm(r.code);}); return inner(u,o); };
  const C=M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
  const r=await M.call(C,{action:'reconcile',manufacturer:LINE},{headers:{'x-analytics-token':'pass'}}); return r.body.parity; };
await t('parity: a storefront MSRP the record says does not exist is drift',async()=>{
  const p=await parity({custom_products:[{manufacturer:LINE,code:'W',base_price:19.5,msrp:19.9,active:true}],
    product_skus:[{manufacturer:LINE,code:'W',base_price:19.5,msrp:null,msrp_auto:false,status:'active'}]},[]);
  eq(p.drift.map(d=>d.field),['msrp']);
});
await t('parity: the saved edit that clears it settles the drift',async()=>{
  const p=await parity({custom_products:[{manufacturer:LINE,code:'W',base_price:19.5,msrp:19.9,active:true}],
    product_overrides:[{manufacturer:LINE,code:'W',patch:{msrp:null,msrp_auto:false}}],
    product_skus:[{manufacturer:LINE,code:'W',base_price:19.5,msrp:null,msrp_auto:false,status:'active'}]},[]);
  eq(p.drift,[]);
});
await t('parity: a record saying "no MSRP" where the storefront derives one is drift (activation would remove it)',async()=>{
  const p=await parity({custom_products:[{manufacturer:LINE,code:'V',base_price:10,msrp:null,msrp_auto:false,active:true}],
    product_skus:[{manufacturer:LINE,code:'V',base_price:10,msrp:null,msrp_auto:false,status:'active'}]},[]);
  eq(p.drift.map(d=>[d.field,d.layers]),[['msrp','derived 20']]);
});
await t('parity: a record that also derives (msrp_auto true) is not drift',async()=>{
  const p=await parity({custom_products:[{manufacturer:LINE,code:'V',base_price:10,msrp:null,active:true}],
    product_skus:[{manufacturer:LINE,code:'V',base_price:10,msrp:null,msrp_auto:true,status:'active'}]},[]);
  eq(p.drift,[]);
});
console.log(`msrp auto: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

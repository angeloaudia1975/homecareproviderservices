/* ACCESS4U DEALER PRICING POLICY (owner decision, Angelo 2026-10-27) — automated proof.
   · A dealer's PURCHASE price = the standard list (dealer_price) less HIS line discount (10 / 15 / 20 / other).
   · No rate on file = the line's default price (base_price = the default 15%).
   · MSRP and MAP are identical for every dealer on the same SKU, whatever the discount.
   · A contract price stays an absolute override and is never discounted again.
   · Family-specific pricing (one code in two ramp families) is kept: each family is discounted off its OWN list.
   Runs the REAL orders-api handler + _pricing.js (the storefront's own engine) against the in-memory PostgREST fake,
   and the storefront engine source directly. All figures are synthetic — no real price enters this public repo. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const ENGINE=require(path.join(ROOT,'_shop_engine.js'));
const LD=require(path.join(ROOT,'_line_discounts.js'));
const OB='https://ordering.test';
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,3).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };

const LINE='access4u';
/* Synthetic standard list 1000.00 → default 15% = 850.00; MSRP = list × 1.5 = 1500; MAP = 30% below MSRP = 1050. */
const P=(code,extra)=>Object.assign({manufacturer:LINE,code,name:'Item '+code,group:'',dealer_price:1000,base_price:850,msrp:1500,map:1050},extra||{});
const FILE=()=>({[LINE]:[ P('RR4x36'), P('PS5x5',{dealer_price:628,base_price:533.8,msrp:942,map:659.4}),
  P('SR3',{family:'RS',dealer_price:400,base_price:340,msrp:600,map:420}), P('SR3',{family:'RR',dealer_price:500,base_price:425,msrp:750,map:525}),
  P('TIERED',{tiers:[{minQty:1,price:850},{minQty:5,price:800}]}), P('NOLIST',{dealer_price:null}),
  P('RSU',{dealer_price:200,base_price:170,msrp:300,map:210,upgrades:[{label:'Picket',price_add:40},{label:'Guardrail',price_add:20}]}) ], manufacturers:[{slug:LINE,name:'Access4U'}]});

function world({rates, contract, failRead}){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, failRead, tables:{
    app_settings:[{key:'platform_state',value:{mode:'development'}}],
    manufacturers:[{slug:LINE,name:'Access4U'}], manufacturer_meta:[{slug:LINE}],
    dealers:[{id:'d1',parent_id:'m1',is_test:true},{id:'m1',parent_id:null}],
    dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}], dealer_manufacturers:require('./p0-entitle.js')('d1'),
    dealer_contract_prices:contract||[], dealer_line_discounts:rates||[],
    product_overrides:[], custom_products:[], product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[],
    orders:[], order_items:[], tracking_requests:[], email_sends:[], intent_events:[], email_attribution:[] }});
  const inner=W.fetch, fl=FILE();
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')){ const tok=String(((opts&&opts.headers)||{}).Authorization||'').replace(/^Bearer\s+/i,'');
      return tok==='dealer'?{ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})}:{ok:false,status:401,json:async()=>({})}; }
    if(u.startsWith(OB+'/data/')){ const content=u.includes('/data/content/');
      const slug=decodeURIComponent(u.slice((OB+(content?'/data/content/':'/data/')).length).replace(/\.json.*$/,''));
      const src=content?{}:fl; if(!(slug in src)) return {ok:false,status:404,json:async()=>null,text:async()=>''};
      return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(src[slug]))}; }
    if(u.startsWith('https://api.resend.com')) return {ok:true,status:200,json:async()=>({id:'m'})};
    return inner(url,opts); };
  return W;
}
const mod=W=>M.load('orders-api.js',W,{ORDERING_BASE:OB},ROOT);
const call=(C,body)=>M.call(C,body,{headers:{authorization:'Bearer dealer'}});
const order=items=>({manufacturer_slug:LINE,manufacturer_name:'Access4U',po:'PO1',items});
const rate=(dealer,pct)=>({dealer_id:dealer,manufacturer:LINE,discount_pct:pct,active:true});
async function priced(opts,code,family){
  const W=world(opts), C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([Object.assign({code,qty:1},family?{family}:{})])]});
  if(r.status!==200) throw new Error('status '+r.status+' '+JSON.stringify(r.body).slice(0,200));
  return r.body.orders[0].items[0];
}

(async()=>{
/* ── the server (orders-api → _pricing → the storefront engine) ── */
await t('different dealers, different purchase prices — MSRP and MAP identical on the same SKU',async()=>{
  const seen=[];
  for(const [label,opts,want] of [['new dealer (no rate → default 15%)',{},850],['10% dealer',{rates:[rate('d1',10)]},900],
      ['15% dealer',{rates:[rate('d1',15)]},850],['20% dealer',{rates:[rate('d1',20)]},800],['approved 12.5% dealer',{rates:[rate('d1',12.5)]},875]]){
    const it=await priced(opts,'RR4x36');
    eq(it.unit,want,label); seen.push({unit:it.unit,msrp:it.commercial.msrp,map:it.commercial.map,rate:it.rate});
  }
  eq([...new Set(seen.map(s=>s.unit))].length,4,'four distinct purchase prices across five dealers (10/15/20/12.5 + default=15)');
  eq([...new Set(seen.map(s=>s.msrp))],[1500],'MSRP never moves'); eq([...new Set(seen.map(s=>s.map))],[1050],'MAP never moves');
  eq(seen.map(s=>s.rate),[null,10,15,20,12.5],'the rate travels back so the browser prices the same way');
});
await t('rounding is to the cent from the list: 628.00 at 15% is 533.80, at 20% 502.40, at 12.5% 549.50',async()=>{
  eq((await priced({rates:[rate('d1',15)]},'PS5x5')).unit,533.8);
  eq((await priced({rates:[rate('d1',20)]},'PS5x5')).unit,502.4);
  eq((await priced({rates:[rate('d1',12.5)]},'PS5x5')).unit,549.5);
});
await t('a contract price wins and is never discounted again (no double discount)',async()=>{
  const it=await priced({rates:[rate('d1',20)],contract:[{dealer_id:'d1',manufacturer:LINE,code:'RR4x36',price:700,active:true}]},'RR4x36');
  eq(it.unit,700,'contract price as set'); eq(it.contract,700,'contract echoed'); eq(it.commercial.msrp,1500,'MSRP'); eq(it.commercial.map,1050,'MAP');
});
await t('a branch row overrides the master; the master rate reaches a branch with none',async()=>{
  eq((await priced({rates:[rate('m1',20)]},'RR4x36')).unit,800,'master rate on the branch');
  eq((await priced({rates:[rate('m1',20),rate('d1',10)]},'RR4x36')).unit,900,'branch rate wins');
  eq((await priced({rates:[Object.assign(rate('d1',20),{active:false})]},'RR4x36')).unit,850,'an inactive rate is ignored');
});
await t('family-specific pricing is kept: each ramp family is discounted off its OWN standard list',async()=>{
  const opts={rates:[rate('d1',20)]};
  const rs=await priced(opts,'SR3','RS'), rr=await priced(opts,'SR3','RR');
  eq([rs.unit,rr.unit],[320,400],'RS 400→320, RR 500→400'); eq([rs.family,rr.family],['RS','RR'],'families echoed');
  eq([rs.commercial.msrp,rr.commercial.msrp,rs.commercial.map,rr.commercial.map],[600,750,420,525],'each family keeps its own MSRP/MAP');
  const W=world(opts), C=mod(W); const r=await call(C,{action:'price_check',orders:[order([{code:'SR3',qty:1,unit:320}])]});
  eq(r.body.orders[0].items[0].available,false,'still refused without a family');
});
await t('a rate never touches quantity breaks, a product with no standard list, or another line',async()=>{
  eq((await priced({rates:[rate('d1',20)]},'TIERED')).unit,850,'breaks rule');
  eq((await priced({rates:[rate('d1',20)]},'NOLIST')).unit,850,'no list → default');
  eq((await priced({rates:[{dealer_id:'d1',manufacturer:'ovation-medical',discount_pct:20,active:true}]},'RR4x36')).unit,850,'another line');
});
await t('the stored order and its lines carry the discounted purchase price; a stale browser price is refused',async()=>{
  const W=world({rates:[rate('d1',10)]}), C=mod(W);
  const stale=await call(C,{action:'create',orders:[order([{code:'RR4x36',qty:2,unit:850}])],dealer:{}});
  eq(stale.status,409,'the default price is not this dealer\'s price'); eq(W.db.order_items.length,0,'nothing stored');
  const c=await call(C,{action:'create',orders:[order([{code:'RR4x36',qty:2,unit:900}])],dealer:{}});
  eq(c.status,200,'recorded'); eq(W.db.order_items.map(i=>[i.code,i.unit_price,i.line_total]),[['RR4x36',900,1800]],'stored line');
});
await t('an unreadable rate table stops pricing (never "no discount")',async()=>{
  const W=world({rates:[rate('d1',20)],failRead:tb=>tb==='dealer_line_discounts'?500:0}), C=mod(W);
  const r=await call(C,{action:'price_check',orders:[order([{code:'RR4x36',qty:1}])]});
  eq(r.status,503,'pricing unavailable');
});
await t('sign-in (dealer-auth me) hands the dealer his own rates with his contract prices; unreadable = unknown, not none',async()=>{
  const W=world({rates:[rate('m1',20),rate('d1',10)]}); const A=M.load('dealer-auth.js',W,{},ROOT);
  const r=await call(A,{action:'me'});
  eq(r.body.status,'approved','approved'); eq(r.body.rates,{[LINE]:10},'branch rate');
  const W2=world({rates:[rate('d1',10)],failRead:tb=>tb==='dealer_line_discounts'?500:0}); const A2=M.load('dealer-auth.js',W2,{},ROOT);
  const r2=await call(A2,{action:'me'});
  eq([r2.body.rates,r2.body.prices,r2.body.prices_unavailable],[null,null,true],'unknown, and the shop says so');
});
await t('railing upgrades: one configured line per upgrade, priced on the server off the configured standard list',async()=>{
  const q=async(opts,up,unit)=>{ const W=world(opts), C=mod(W); const r=await call(C,{action:'price_check',orders:[order([Object.assign({code:'RSU',qty:1},up?{upgrade:up}:{},unit!=null?{unit}:{})])]}); return r.body.orders[0].items[0]; };
  const plain=await q({}), pk=await q({},'Picket'), gr=await q({},'Guardrail');
  eq([plain.unit,pk.unit,gr.unit],[170,204,187],'default 15%: 200→170, 240→204, 220→187');
  eq([pk.commercial.msrp,pk.commercial.map],[360,252],'configured MSRP = 240 x 1.5, MAP 30% below');
  eq([gr.commercial.msrp,gr.commercial.map],[330,231],'guardrail 220 x 1.5 = 330, MAP 231');
  eq([plain.commercial.msrp,plain.commercial.map],[300,210],'plain part unchanged');
  eq([pk.upgrade,/Picket upgrade$/.test(pk.name)],['Picket',true],'upgrade echoed; the stored name says it');
  const r20=await q({rates:[rate('d1',20)]},'Picket'); eq([r20.unit,r20.commercial.msrp,r20.commercial.map],[192,360,252],'20% dealer: purchase only');
  const cp=await q({contract:[{dealer_id:'d1',manufacturer:LINE,code:'RSU',price:150,active:true}]},'Picket');
  eq(cp.unit,184,'contract covers the plain part; the upgrade adds at the default discount (150 + 34)');
  const cpr=await q({rates:[rate('d1',10)],contract:[{dealer_id:'d1',manufacturer:LINE,code:'RSU',price:150,active:true}]},'Picket');
  eq(cpr.unit,186,'contract + upgrade at the dealer rate (150 + 36), never a double discount on the contract');
  const bad=await q({},'Gold rail'); eq(bad.available,false,'an upgrade the product does not offer is refused');
  const none=await q({},'Picket'); eq(none.available,true,'sanity');
  const plainOnly=await (async()=>{ const W=world({}), C=mod(W); const r=await call(C,{action:'price_check',orders:[order([{code:'RR4x36',qty:1,upgrade:'Picket'}])]}); return r.body.orders[0].items[0]; })();
  eq(plainOnly.available,false,'a part without upgrades cannot be ordered with one');
});
await t('an upgraded line is stored with its configured price and name; the plain line beside it stays plain',async()=>{
  const W=world({}), C=mod(W);
  const c=await call(C,{action:'create',orders:[order([{code:'RSU',qty:1,unit:170},{code:'RSU',qty:2,upgrade:'Picket',unit:204}])],dealer:{}});
  eq(c.status,200,'recorded');
  eq(W.db.order_items.map(i=>[i.code,i.unit_price,i.line_total,/Picket upgrade$/.test(i.name)]),[['RSU',170,170,false],['RSU',204,408,true]],'two lines');
});
/* ── the module ── */
await t('rates: valid 0 < r < 100 with two decimals; a table not installed yet means no rates; any other failure throws',async()=>{
  eq([10,15,20,12.5,0.01,99.99].map(LD.validRate),[true,true,true,true,true,true]);
  eq([0,100,-5,'x',null,'',12.345,150].map(LD.validRate),[false,false,false,false,false,false,false,false]);
  eq(await LD.lineRates(async()=>{ throw new Error('Supabase 404: {"code":"PGRST205","message":"Could not find the table"}'); },'d1'),{},'missing table');
  let threw=false; try{ await LD.lineRates(async()=>{ throw new Error('Supabase 500: boom'); },'d1'); }catch(e){ threw=true; } eq(threw,true,'other failure');
  eq(await LD.lineRates(async()=>[{dealer_id:'m1',manufacturer:LINE,discount_pct:20},{dealer_id:'d1',manufacturer:LINE,discount_pct:10},{dealer_id:'d1',manufacturer:'x',discount_pct:0}],'d1','m1'),{[LINE]:10},'branch over master; invalid dropped');
});
/* ── the storefront engine text itself (what the shop runs in the browser) ── */
await t('the shop engine: contract → line rate → default; invalid rates and MSRP/MAP untouched',async()=>{
  const run=AUTH=>new Function('fetch','window','console','document','CONFIG','state','AUTH','PREVIEW','CART','mfrInfo',ENGINE.SOURCE+';return {unitPrice};')(
    null,{},console,{},{},{manufacturers:[]},AUTH,null,new Map(),s=>({slug:s}));
  const p=P('RR4x36'), before=JSON.stringify(p);
  eq(run({prices:{},rates:{}}).unitPrice(p,1),850,'default');
  eq(run({prices:{},rates:{[LINE]:20}}).unitPrice(p,1),800,'20%');
  eq(run({prices:{[LINE+'::RR4x36']:700},rates:{[LINE]:20}}).unitPrice(p,1),700,'contract first');
  for(const bad of [0,100,-10,'abc',null]) eq(run({prices:{},rates:{[LINE]:bad}}).unitPrice(p,1),850,'invalid '+bad);
  eq(run({prices:{}}).unitPrice(p,1),850,'no rates object at all (older session)');
  eq(JSON.stringify(p),before,'pricing never writes MSRP, MAP or anything else on the product');
});
console.log(`\na4u dealer discount: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

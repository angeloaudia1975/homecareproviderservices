// My Orders shows what the dealer paid (agreed 2026-10-09): the order-history API carries the
// freight and total the server stored on the order, and the shop's My Orders / recent orders show
// that total to the cent. Spend (cost) stays merchandise.
//   node test/orderhistory.test.js        (HIST_FILE / SHOP_FILE override the files under test)
const path=require('path'), fs=require('fs'), vm=require('vm');
const HIST=process.env.HIST_FILE||path.join(__dirname,'..','netlify','functions','order-history-api.js');
const SHOP=process.env.SHOP_FILE||path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html');
let pass=0, fail=0;
const t=async(n,f)=>{ try{ await f(); pass++; console.log('ok  ',n); }catch(e){ fail++; console.log('FAIL',n,'\n   ',e.message); } };
const eq=(a,b,m)=>{ const A=JSON.stringify(a),B=JSON.stringify(b); if(A!==B) throw new Error((m||'')+' got '+A+' want '+B); };

function loadHist(orders, sales){
  process.env.SUPABASE_URL='https://sb.test'; process.env.SUPABASE_SERVICE_ROLE='svc';
  const seen=[];
  global.fetch=async(url)=>{ const u=String(url); seen.push(u);
    const body = /auth\/v1\/user/.test(u) ? {id:'u1',email:'d@x.com'}
      : /dealer_users|dealers\?/.test(u) ? [{dealer_id:'D1',id:'D1',auth_user_id:'u1',status:'approved',business_name:'B',approved:true}]
      : /manufacturers\?/.test(u) ? [{slug:'strongback-mobility',name:'Strongback Mobility'}]
      : /monthly_sales/.test(u) ? (sales||[])
      : /orders\?/.test(u) ? orders : [];
    return {ok:true,status:200,text:async()=>JSON.stringify(body),json:async()=>body}; };
  delete require.cache[require.resolve(HIST)];
  return {mod:require(HIST), seen};
}
const ev=b=>({httpMethod:'POST',headers:{authorization:'Bearer jwt'},body:JSON.stringify(b)});
const ORD=[{id:'o1',manufacturer:'strongback-mobility',status:'submitted',po_number:'P',subtotal:7.7,freight_fee:15,estimated_total:22.7,submitted_at:'2026-10-10T04:00:00Z',order_items:[{code:'SB100',name:'Seatbelt',qty:1,unit_price:7.7,line_total:7.7}]},
           {id:'o0',manufacturer:'strongback-mobility',status:'cancelled',po_number:'Q',subtotal:300,freight_fee:null,estimated_total:null,submitted_at:'2026-10-06T04:00:00Z',order_items:[{code:'R0001',name:'SEATA',qty:1,unit_price:300,line_total:300}]}];

// ---- shop rendering harness: the helpers + loadOrders, run against a fake DOM node ----
const shop=fs.readFileSync(SHOP,'utf8');
const HUB=shop.indexOf('const cents=');   // the Business Hub script, where My Orders lives
const grab=(start,end)=>{ const i=shop.indexOf(start,HUB); if(i<0) throw new Error('missing '+start); const j=shop.indexOf(end,i); return shop.slice(i,j); };
function renderOrders(history){
  const helpers=grab('const cents=','const num=');
  const fn=grab('async function loadOrders(){','async function reqTracking(');
  const view={innerHTML:''};
  const ctx={HISTORY:history,$:()=>view,esc:s=>String(s==null?'':s),dateShort:d=>String(d).slice(0,10),srcPill:s=>s,statPill:s=>s,api:async()=>({orders:history}),HISTORY_ENDPOINT:''};
  vm.createContext(ctx); vm.runInContext(helpers+'\n'+fn+'\nthis.loadOrders=loadOrders;',ctx);
  return ctx.loadOrders().then(()=>view.innerHTML);
}

(async()=>{
await t('history carries the stored freight and total; cost stays merchandise',async()=>{
  const {mod,seen}=loadHist(ORD); const r=await mod.handler(ev({action:'history'})); const j=JSON.parse(r.body);
  const o=j.orders.find(x=>x.id==='o1'); eq([o.cost,o.freight,o.total],[7.7,15,22.7]);
  if(!seen.some(u=>/orders\?.*freight_fee,estimated_total/.test(u))) throw new Error('freight columns not read');
});
await t('an order stored before freight existed: freight null, total = merchandise',async()=>{
  const {mod}=loadHist(ORD); const j=JSON.parse((await mod.handler(ev({action:'history'}))).body);
  const o=j.orders.find(x=>x.id==='o0'); eq([o.cost,o.freight,o.total],[300,null,300]);
});
await t('dashboard spend stays merchandise; recent orders carry the total',async()=>{
  const {mod}=loadHist(ORD); const j=JSON.parse((await mod.handler(ev({action:'summary'}))).body);
  eq(j.allTime.spend,307.7,'spend'); const o=j.recent.find(x=>x.id==='o1'); eq([o.cost,o.freight,o.total],[7.7,15,22.7]);
});
await t('My Orders shows $22.70 incl. $15.00 freight, to the cent',async()=>{
  const html=await renderOrders([{id:'o1',date:'2026-10-10',source:'portal',status:'submitted',manufacturerName:'Strongback Mobility',lines:[{qty:1}],units:1,cost:7.7,freight:15,total:22.7},
                                {id:'o0',date:'2026-10-06',source:'portal',status:'cancelled',manufacturerName:'Strongback Mobility',lines:[{qty:1}],units:1,cost:300,freight:null,total:300}]);
  if(!/\$22\.70/.test(html)) throw new Error('no $22.70: '+html.slice(0,600));
  if(!/incl\. \$15\.00 freight/.test(html)) throw new Error('no freight note');
  if(/\$8</.test(html)) throw new Error('still shows the rounded merchandise $8');
  if(!/Total \(incl\. freight\)<\/td><td[^>]*>\$322\.70/.test(html)) throw new Error('footer total: '+html.slice(html.indexOf('tfoot'),html.indexOf('tfoot')+300));
});
await t('an imported row (no freight) shows its amount and no freight note',async()=>{
  const html=await renderOrders([{id:'MS',date:'2026-09-01',source:'imported',status:'delivered',manufacturerName:'Ovation',lines:[{qty:2}],units:2,cost:41.5,freight:null,total:41.5}]);
  if(!/\$41\.50/.test(html)||/freight<\/div>/.test(html)) throw new Error(html.slice(0,500));
});
console.log(`orderhistory: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

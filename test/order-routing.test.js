/* Owner's global order routing (2026-10-27, tracker #42): every HCPS dealer order is recorded, the owner's intake
   mailbox (angelo@homecareproviderservices.us) gets the full order, and NOTHING is sent to a manufacturer —
   HCPS places each order itself and confirms it to the dealer. Statuses tell the truth: received → placed by
   HCPS → confirmed by the manufacturer (with its confirmation # and the actual freight, recorded once). */
const path=require('path');
const M=require(path.join(__dirname,'phase0-mock.js'));
const ROOT=path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const SUBMIT=process.env.SUBMIT_JS||path.join(SHOPD,'netlify','functions','submit-order.js');
const fs=require('fs');
const OB='https://ordering.test';
let fail=0,pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n); }catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const mfrs=[{slug:'acme',name:'Acme',hasData:true,freight:{summary:'Actual freight.',groups:[],elseActual:true,actualNote:'Actual shipping charges apply to all orders.',otherLabel:'Acme freight — actual'}}];

function world(){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, tables:{ app_settings:[{key:'platform_state',value:{mode:'live'}}],
    manufacturers:[{slug:'acme',name:'Acme',contact_email:'orders@acme-manufacturer.example'}], manufacturer_meta:[{slug:'acme'}],
    dealers:[{id:'d1',parent_id:null,is_test:false}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
    dealer_manufacturers:[{dealer_id:'d1',manufacturer:'acme',active:true,status:'active'}],
    dealer_contract_prices:[], product_overrides:[], product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[],
    custom_products:[{manufacturer:'acme',active:true,code:'A1',name:'Widget',category:'X',base_price:10}],
    orders:[], order_items:[], tracking_requests:[], email_sends:[], intent_events:[], email_attribution:[] }});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')) return {ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})};
    if(u===OB+'/data/manufacturers.json') return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(mfrs))};
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    if(u.startsWith('https://api.resend.com')){ W.calls.push({url:u,method:'POST',body:JSON.parse(opts.body)}); return {ok:true,status:200,json:async()=>({id:'m'})}; }
    return inner(url,opts); };
  return W;
}

(async()=>{
await t('a recorded order emails ONLY the dealer (an order-received acknowledgment) — never the manufacturer',async()=>{
  const W=world(); const C=M.load('orders-api.js',W,{ORDERING_BASE:OB,RESEND_API_KEY:'k'},ROOT);
  const r=await M.call(C,{action:'create',dealer:{business:'B',email:'buyer@x.com',contact:'C'},orders:[{manufacturer_slug:'acme',po:'P1',items:[{code:'A1',qty:2,unit:10}]}]},{headers:{authorization:'Bearer dealer'}});
  eq(r.status,200,JSON.stringify(r.body).slice(0,200));
  const mails=W.calls.filter(c=>/resend/.test(c.url));
  eq(mails.map(m=>m.body.to).flat(),['buyer@x.com'],'recipients');
  ok(!JSON.stringify(mails).includes('acme-manufacturer'),'no manufacturer address anywhere');
  eq((W.db.tracking_requests||[]).length,0,'no automatic tracking request');
  const m=mails[0].body; ok(/HCPS received your order/.test(m.subject),m.subject);
  ok(/not a manufacturer confirmation/.test(m.text),'says it is an acknowledgment');
  ok(/Freight: pending/.test(m.text)&&/Actual shipping charges apply to all orders\./.test(m.text),'freight pending + the line note');
  ok(!/Total: \$/.test(m.text),'no final total while freight is pending');
  eq(W.db.orders[0].status,'submitted','stored as received');
});
await t('a dealer tracking request goes to HCPS only, never the manufacturer',async()=>{
  const src=fs.readFileSync(path.join(ROOT,'dealer-tools-api.js'),'utf8');
  ok(/const to = "angelo@homecareproviderservices\.us";/.test(src),'fixed HCPS recipient');
  ok(!/to = mfrContact/.test(src),'no manufacturer recipient');
});
await t('order statuses move one step at a time; the manufacturer confirmation records the actual freight once',async()=>{
  const W=M.createWorld({ tokens:{staff:'p@x.com'}, tables:{ staff_users:[{email:'p@x.com',role:'president',active:true}],
    orders:[{id:'o1',status:'submitted',subtotal:100,freight_fee:0,estimated_total:100,admin_notes:''}] }});
  const inner=W.fetch; W.fetch=async(u,o)=>String(u).startsWith(M.BASE+'/auth/v1/user')?{ok:true,status:200,json:async()=>({id:'s',email:'p@x.com'})}:inner(u,o);
  const C=M.load('orders-admin.js',W,{},ROOT);
  const go=b=>M.call(C,Object.assign({action:'set_status',id:'o1'},b),{headers:{authorization:'Bearer staff'}});
  eq((await go({status:'confirmed'})).status,409,'received → confirmed skips "placed"');
  eq((await go({status:'placed'})).status,200);
  eq((await go({status:'confirmed',mfr_confirmation:'SO-55',actual_freight:'-1'})).status,400,'negative freight refused');
  const r=await go({status:'confirmed',mfr_confirmation:'SO-55',actual_freight:42.5});
  eq([r.status,r.body.freight_fee,r.body.estimated_total],[200,42.5,142.5]);
  ok(/Manufacturer confirmation #SO-55 · actual freight \$42\.50 · final total \$142\.50/.test(W.db.orders[0].admin_notes),W.db.orders[0].admin_notes);
  eq((await go({status:'confirmed',actual_freight:50})).status,409,'a second confirmation cannot be recorded');
  eq(W.db.orders[0].freight_fee,42.5,'freight unchanged by the refused repeat');
});
await t('submit-order: the owner intake mailbox always gets the order; the email says it is NOT yet placed with the manufacturer',async()=>{
  const S=require(SUBMIT);
  eq(S._recipients(''),['orders@homecareproviderservices.us','angelo@homecareproviderservices.us']);
  eq(S._recipients('x@y.com'),['x@y.com','angelo@homecareproviderservices.us']);
  const e=S._buildEmail({business:'B',email:'b@x.com'},{manufacturer_name:'Acme',order_id:'o1',po:'P',items:[{code:'A1',name:'Widget',qty:1,unit:10}],items_count:1,items_subtotal:10,estimated_total:10,freight_fee:0,freight_lines:[{label:'Acme freight',status:'actual'}],freight_note:'Actual shipping charges apply to all orders.'},'2026-10-27T12:00:00Z');
  ok(/NOT yet placed with the manufacturer/.test(e.text)&&/HCPS order ID     : o1/.test(e.text),'status + id');
  ok(/Merchandise total: \$10\.00 \+ freight \(pending\)/.test(e.text),'pending total');
  ok(/NOT yet placed with Acme/.test(e.html),'html banner');
});
await t('submit-order: a part on the order twice (plain + railing upgrade) keeps each line\'s own recorded price',async()=>{
  const S=require(SUBMIT);
  const out=S._applyServerPrices([{manufacturer_slug:'a',items:[{code:'RS1x36',qty:1,unit:1},{code:'RS1x36',upgrade:'Picket',qty:1,unit:1}]}],
    [{manufacturer_slug:'a',subtotal:3,order_id:'o',items:[{code:'RS1x36',qty:1,unit:1,name:'Ramp'},{code:'RS1x36',upgrade:'Picket',qty:1,unit:2,name:'Ramp — Picket upgrade'}]}]);
  eq(out[0].items.map(i=>[i.unit,i.name]),[[1,'Ramp'],[2,'Ramp — Picket upgrade']]);
});
/* ---- C3-06: Order Review reads strictly and shows the new-account notice ---- */
function adminWorld(o){
  const W=M.createWorld({ tokens:{staff:'p@x.com'}, failRead:(t)=>(o.failOrders&&t==='orders'&&o.failOrders())||(o.failAcct&&t==='dealer_manufacturers')||(o.failDealers&&t==='dealers')?500:0, tables:{ staff_users:[{email:'p@x.com',role:'president',active:true}],
    dealers:[{id:'d1',business_name:'D One'},{id:'d2',business_name:'D Two'}], manufacturers:[{slug:'yuwell',name:'Yuwell'},{slug:'acme',name:'Acme'}],
    dealer_manufacturers:o.acct||[],
    orders:[{id:'y1',dealer_id:'d1',manufacturer:'yuwell',status:'submitted',subtotal:30,submitted_at:'2026-11-05T01:00:00Z',order_items:[]},
            {id:'y2',dealer_id:'d2',manufacturer:'yuwell',status:'submitted',subtotal:30,submitted_at:'2026-11-05T02:00:00Z',order_items:[]},
            {id:'y3',dealer_id:'d1',manufacturer:'yuwell',status:'cancelled',subtotal:30,submitted_at:'2026-11-05T03:00:00Z',order_items:[]},
            {id:'a1',dealer_id:'d1',manufacturer:'acme',status:'submitted',subtotal:10,submitted_at:'2026-11-05T04:00:00Z',order_items:[]}] }});
  const inner=W.fetch; W.fetch=async(u,x)=>String(u).startsWith(M.BASE+'/auth/v1/user')?{ok:true,status:200,json:async()=>({id:'s',email:'p@x.com'})}:inner(u,x);
  return M.load('orders-admin.js',W,{},ROOT);
}
const listOf=async C=>M.call(C,{action:'list'},{headers:{authorization:'Bearer staff'}});
await t('Order Review: "New Yuwell Manufacturer Account Required" on open Yuwell orders of dealers with no Yuwell account number',async()=>{
  const r=await listOf(adminWorld({acct:[{dealer_id:'d2',manufacturer:'yuwell',account_ref:'YW-2',active:true}]}));
  eq(r.status,200,JSON.stringify(r.body).slice(0,200));
  const by=Object.fromEntries(r.body.orders.map(o=>[o.id,o.account_notice]));
  eq([by.y1,by.y2,by.y3,by.a1],['New Yuwell Manufacturer Account Required','','',''],'d1 no account; d2 has one; cancelled and other lines never');
});
await t('Order Review: unreadable account numbers → the notice says "verify", never hidden',async()=>{
  const r=await listOf(adminWorld({failAcct:true}));
  eq(r.status,200); ok(/could not be checked — verify/.test(r.body.orders.find(o=>o.id==='y1').account_notice),'verify');
});
await t('Order Review: an unreadable order list is an error on screen, never an empty list',async()=>{
  let n=0; const r=await listOf(adminWorld({failOrders:()=>++n>1}));   // the table probe passes, the list read fails
  eq(r.status,503,JSON.stringify(r.body)); eq(r.body.error,'orders_unavailable');
});
await t('Order Review: unreadable dealer names are an error too (an order never shows without its dealer)',async()=>{
  const r=await listOf(adminWorld({failDealers:true})); eq(r.status,503,JSON.stringify(r.body));
  const r2=await listOf(adminWorld({})); eq(r2.body.orders.find(o=>o.id==='y1').dealer,'D One','dealer name shown');
});
await t('Order Review page shows the notice and the email-failed / resubmitted flags',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','src','admin','order-fulfillment.html'),'utf8');
  ok(/o\.account_notice/.test(html)&&/acctnote/.test(html),'notice badge'); ok(/resubmitted/i.test(html),'resubmitted flag'); ok(/j\.message/.test(html),'error message shown');
});
await t('submit-order: the intake email puts the account notice first, in the subject and the text',async()=>{
  const S=require(SUBMIT);
  const e=S._buildEmail({business:'B',email:'b@x.com'},{manufacturer_name:'Yuwell',order_id:'o9',po:'P',account_notice:'New Yuwell Manufacturer Account Required',items:[{code:'Y1',name:'Y',qty:1,unit:30}],items_count:1,items_subtotal:30,estimated_total:30,freight_fee:0,freight_lines:[]},'2026-11-05T12:00:00Z');
  ok(/^\[New account required\] New order/.test(e.subject),e.subject);
  ok(/New Yuwell Manufacturer Account Required/.test(e.html)&&/New Yuwell Manufacturer Account Required/.test(e.text),'html + text');
  ok(/not blocked/.test(e.html),'says the order was not blocked');
  const plain=S._buildEmail({business:'B'},{manufacturer_name:'Acme',order_id:'o1',po:'P',items:[],items_count:0,items_subtotal:0,estimated_total:0,freight_fee:0,freight_lines:[]},'2026-11-05T12:00:00Z');
  ok(/^New order/.test(plain.subject)&&!/Account Required/.test(plain.html+plain.text),'no notice without one');
});
console.log(`order routing: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

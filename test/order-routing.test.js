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
    dealer_manufacturers:[{dealer_id:'d1',manufacturer:'acme',active:true,status:'active',account_ref:(world.noAcct?null:'AC-1')}],
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
await t('owner 2026-11-06: an approved line with NO manufacturer account on file is recorded (never blocked) and HELD as Pending Manufacturer Account Setup — the head office identifier counts; Golden is never held here',async()=>{
  world.noAcct=true; const W=world(); world.noAcct=false; const C=M.load('orders-api.js',W,{ORDERING_BASE:OB,RESEND_API_KEY:'k'},ROOT);
  const r=await M.call(C,{action:'create',dealer:{business:'B',email:'buyer@x.com',contact:'C'},orders:[{manufacturer_slug:'acme',po:'P2',items:[{code:'A1',qty:1,unit:10}]}]},{headers:{authorization:'Bearer dealer'}});
  eq(r.status,200,JSON.stringify(r.body).slice(0,300)); eq(W.db.orders[0].status,'pending_account_setup','held');
  eq([r.body.orders[0].status,r.body.orders[0].account_hold],['pending_account_setup',true]);
  const m=W.calls.filter(c=>/resend/.test(c.url))[0].body; ok(/Pending Manufacturer Account Setup/.test(m.html)&&/Pending Manufacturer Account Setup/.test(m.text),'dealer told');
  ok(!/not held/.test(m.text),'never says it is not held');
  // a head-office identifier counts for its branch
  world.noAcct=true; const W2=world(); world.noAcct=false; W2.db.dealers.push({id:'hq',parent_id:null}); W2.db.dealers[0].parent_id='hq';
  W2.db.dealer_manufacturers.push({dealer_id:'hq',manufacturer:'acme',active:true,account_ref:'HQ-9'});
  const r2=await M.call(M.load('orders-api.js',W2,{ORDERING_BASE:OB,RESEND_API_KEY:'k'},ROOT),{action:'create',dealer:{business:'B',email:'buyer@x.com'},orders:[{manufacturer_slug:'acme',po:'P3',items:[{code:'A1',qty:1,unit:10}]}]},{headers:{authorization:'Bearer dealer'}});
  eq([r2.status,W2.db.orders[0].status],[200,'submitted'],'head office account counts');
  const A=require(path.join(ROOT,'_account_setup.js')); eq(await A.missingIdentifiers(async()=>{throw new Error('no read');},'d1',['golden-technologies']),[],'Golden never held (no read even)');
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
/* ---- owner 2026-11-06: releasing an order held for manufacturer account setup ---- */
function holdWorld(o){
  const W=M.createWorld({ tokens:{staff:'p@x.com'}, failWrite:o.failWrite, tables:{ staff_users:[{email:'p@x.com',role:'president',active:true}],
    dealers:[{id:'d1',business_name:'D One',parent_id:null}], manufacturers:[{slug:'acme',name:'Acme'}], manufacturer_meta:[{slug:'acme'}],
    dealer_manufacturers:[{dealer_id:'d1',manufacturer:'acme',active:true,account_ref:o.acct||null}],
    dealer_contract_prices:o.contract||[], product_overrides:[], product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[],
    custom_products:o.products||[{manufacturer:'acme',active:true,code:'A1',name:'Widget',category:'X',base_price:10}],
    orders:[{id:'h1',dealer_id:'d1',manufacturer:'acme',status:'pending_account_setup',subtotal:20,submitted_at:'2026-11-06T01:00:00Z',...(o.order||{})}],
    order_items:[{id:'i1',order_id:'h1',code:'A1',name:'Widget',qty:2,unit_price:10,line_total:20}] }});
  const inner=W.fetch; W.fetch=async(u,x)=>{ u=String(u); if(u.startsWith(M.BASE+'/auth/v1/user')) return {ok:true,status:200,json:async()=>({id:'s',email:'p@x.com'})};
    if(u===OB+'/data/manufacturers.json') return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(o.mfrs||mfrs))};
    if(o.file&&u===OB+'/data/acme.json') return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(o.file))};
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''}; return inner(u,x); };
  W.C=M.load('orders-admin.js',W,{ORDERING_BASE:OB},ROOT); return W;
}
const rel=(W,b)=>M.call(W.C,Object.assign({action:'release_account_hold',id:'h1'},b||{}),{headers:{authorization:'Bearer staff'}});
await t('a held order is released only once the account is on file; same prices → Received by HCPS, the same order (nothing re-entered)',async()=>{
  const W=holdWorld({}); const r=await rel(W); eq([r.status,r.body.error],[409,'account_not_set_up']); eq(W.db.orders[0].status,'pending_account_setup');
  const s=await M.call(W.C,{action:'set_status',id:'h1',status:'placed'},{headers:{authorization:'Bearer staff'}}); eq(s.status,409,'cannot be placed while held');
  const W0=holdWorld({acct:'AC-7'}); W0.db.order_items=[]; const r0=await rel(W0); eq([r0.status,r0.body.error],[409,'no_items'],'no lines read → never released'); eq(W0.db.orders[0].status,'pending_account_setup');
  const W2=holdWorld({acct:'AC-7'}); const r2=await rel(W2); eq([r2.status,r2.body.status,r2.body.changed,r2.body.subtotal],[200,'submitted',0,20],JSON.stringify(r2.body));
  eq([W2.db.orders[0].status,W2.db.orders.length],['submitted',1]); ok(/Release from Pending Manufacturer Account Setup started/.test(W2.db.orders[0].admin_notes)&&/Released by p@x\.com/.test(W2.db.orders[0].admin_notes),'audit note');
  const l=await M.call(W2.C,{action:'list'},{headers:{authorization:'Bearer staff'}}); eq(l.status,200);
});
await t('a price that changed since the dealer ordered needs the dealer\'s confirmation (noted) before release; then the new prices are stored',async()=>{
  const W=holdWorld({acct:'AC-7',contract:[{dealer_id:'d1',manufacturer:'acme',code:'A1',price:8,active:true}]});
  const r=await rel(W); eq([r.status,r.body.error],[409,'prices_changed'],JSON.stringify(r.body)); eq(r.body.lines[0].new_unit,8);
  eq(W.db.orders[0].status,'pending_account_setup','unchanged');
  const r2=await rel(W,{dealer_confirmed:true}); eq(r2.status,409,'a confirmation needs a note');
  const r2b=await rel(W,{dealer_confirmed:true,note:'Jim confirmed by phone 11/6'}); eq([r2b.status,r2b.body.error],[409,'prices_changed'],'a confirmation must name the figures shown');
  const r2n=await rel(W,{dealer_confirmed:true,confirmed:r.body.proposal}); eq(r2n.status,409,'the figures without a note are refused');
  const r2c=await rel(W,{dealer_confirmed:true,note:'x',confirmed:{lines:[{id:'i1',unit:9}],freight:null}}); eq(r2c.status,409,'other figures than the ones now proposed are refused');
  eq(W.db.orders[0].status,'pending_account_setup','still held');
  const r3=await rel(W,{dealer_confirmed:true,note:'Jim confirmed by phone 11/6',confirmed:r.body.proposal}); eq([r3.status,r3.body.subtotal],[200,16],JSON.stringify(r3.body));
  eq([W.db.order_items[0].unit_price,W.db.order_items[0].line_total,W.db.orders[0].subtotal],[8,16,16]);
  ok(/A1 \$10\.00 → \$8\.00/.test(W.db.orders[0].admin_notes)&&/dealer confirmation \/ check: Jim confirmed/.test(W.db.orders[0].admin_notes),'every change + confirmation recorded');
});
await t('release: a line sold in two price families (the order record keeps no family) keeps its checkout price and needs a by-hand check',async()=>{
  const W=holdWorld({acct:'AC-7',products:[{manufacturer:'acme',active:true,code:'A1',name:'Widget S',category:'X',base_price:10,family:'S'},{manufacturer:'acme',active:true,code:'A1',name:'Widget L',category:'X',base_price:14,family:'L'}]});
  const r=await rel(W); eq([r.status,r.body.error],[409,'manual_price_check'],JSON.stringify(r.body).slice(0,300)); eq(r.body.lines[0].kept,true);
  const r2=await rel(W,{kept_prices_checked:true,note:'checked family S on the dealer PO'}); eq([r2.status,r2.body.kept,r2.body.subtotal],[200,1,20],JSON.stringify(r2.body));
  eq(W.db.order_items[0].unit_price,10,'recorded price kept'); ok(/A1 kept at \$10\.00/.test(W.db.orders[0].admin_notes),'noted');
});
await t('release: a configured line that is now discontinued or breaks an order rule is unavailable, never kept at its old price',async()=>{
  const W=holdWorld({acct:'AC-7',products:[],file:[{code:'A1',name:'Widget',category:'X',base_price:10,min_order_qty:5,upgrades:[{label:'Rail',price_add:5}]}]});
  const r=await rel(W); eq([r.status,r.body.error],[409,'items_unavailable'],JSON.stringify(r.body).slice(0,300));
  const r2=await rel(W,{kept_prices_checked:true,note:'x'}); eq(r2.body.error,'items_unavailable'); eq(W.db.orders[0].status,'pending_account_setup','never released');
  const W2=holdWorld({acct:'AC-7',products:[],file:[{code:'A1',name:'Widget',category:'X',base_price:10,upgrades:[{label:'Rail',price_add:5}]}]});
  eq((await rel(W2)).body.error,'manual_price_check','an upgradeable code is flagged too');
});
await t('release: freight is re-worked by the shop rule; a freight change needs the same confirmation',async()=>{
  const fm=[{slug:'acme',name:'Acme',hasData:true,freight:{summary:'$15',groups:[{label:'Acme S&H',brandKeywords:['*'],flatFee:15}],elseActual:false}}];
  const W=holdWorld({acct:'AC-7',mfrs:fm,order:{freight_fee:0,estimated_total:20}});
  const r=await rel(W); eq([r.status,r.body.error,r.body.freight.new],[409,'prices_changed',15],JSON.stringify(r.body).slice(0,300));
  const rx=await rel(W,{dealer_confirmed:true,note:'ok',confirmed:{lines:r.body.proposal.lines,freight:null}}); eq(rx.status,409,'the new freight must be confirmed too');
  const r2=await rel(W,{dealer_confirmed:true,note:'ok by email',confirmed:r.body.proposal}); eq([r2.status,r2.body.freight_fee],[200,15],JSON.stringify(r2.body));
  eq([W.db.orders[0].freight_fee,W.db.orders[0].estimated_total],[15,35]);
  const Wn=holdWorld({acct:'AC-7',mfrs:fm,order:{freight_fee:null}}); const rn=await rel(Wn); eq([rn.status,rn.body.error],[409,'prices_changed'],'freight with none recorded needs confirmation too');
});
await t('release: a cancelled order is never touched, and a failed line write leaves the order HELD with the change noted',async()=>{
  const W=holdWorld({acct:'AC-7',order:{status:'cancelled'}}); const r=await rel(W); eq(r.status,409); eq(W.db.order_items[0].unit_price,10);
  /* cancelled by someone else while the release was being worked out → nothing is written */
  const W3=holdWorld({acct:'AC-7',contract:[{dealer_id:'d1',manufacturer:'acme',code:'A1',price:8,active:true}]});
  const p3=(await rel(W3)).body.proposal; const f3=W3.fetch; W3.fetch=async(u,x)=>{ if(/\/order_items\?/.test(String(u))&&(!x||!x.method||x.method==='GET')) W3.db.orders[0].status='cancelled'; return f3(u,x); };
  W3.C=M.load('orders-admin.js',W3,{ORDERING_BASE:OB},ROOT);
  const r3=await rel(W3,{dealer_confirmed:true,note:'ok',confirmed:p3}); eq([r3.status,r3.body.error],[409,'changed'],JSON.stringify(r3.body));
  eq([W3.db.orders[0].status,W3.db.order_items[0].unit_price,!!W3.db.orders[0].admin_notes],['cancelled',10,false],'untouched');
  const W2=holdWorld({acct:'AC-7',contract:[{dealer_id:'d1',manufacturer:'acme',code:'A1',price:8,active:true}],failWrite:(m,t)=>t==='order_items'&&m==='PATCH'?500:0});
  const p=(await rel(W2)).body.proposal; const r2=await rel(W2,{dealer_confirmed:true,note:'Jim ok',confirmed:p});
  eq([r2.status,r2.body.error],[502,'release_incomplete'],JSON.stringify(r2.body)); eq(W2.db.orders[0].status,'pending_account_setup','still held');
  ok(/A1 \$10\.00 → \$8\.00/.test(W2.db.orders[0].admin_notes),'the confirmed change is on record');
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

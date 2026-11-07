const fs=require('fs'),{execFileSync}=require('child_process');
const path=require('path'),os=require('os');
const ORD=process.env.ORDER_REPO||path.join(__dirname,'..','..','homecareproviderservicesordering');
const SHOP=path.join(ORD,'public','index.html'), SUB=path.join(ORD,'netlify','functions','submit-order.js');
const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mutsc-'));
const M=[
 ['shop','restored cart not re-priced','  repriceSavedCart();\n}',' \n}'],
 ['shop','ladder not refreshed','["base_price","dealer_price","msrp","map","tiers","group","price_note"]','["base_price","dealer_price","msrp","map","group","price_note"]'],
 ['shop','change not shown','PRICE_NOTES.set(k,{old:(prev&&prev.old!=null)?prev.old:Number(it.client_unit), now:Number(it.unit)}); n++;','n++;'],
 ['shop','pre-submit check ignores a change','if(chk.changed){ applyServerPrices(chk); updateCart(); toast("Prices changed since you last reviewed your cart — review the updated totals, then place your order again"); return; }',''],
 ['shop','unconfirmed price submitted','if(!chk){ toast("Pricing could not be confirmed right now — nothing was submitted. Please try again."); return; }',''],
 ['shop','server refusal treated as success','if(!j.recorded){ toast(j.error||"Could not submit — nothing was placed. Please try again."); return; }',''],
 ['shop','contract not refreshed','if(AUTH.prices){ if(it.contract!=null) AUTH.prices[ck]=Number(it.contract); else delete AUTH.prices[ck]; }',''],
 ['shop','withdrawn line not blocking','if([...CART.values()].some(({p})=>p._unavailable)){','if(false){'],
 ['shop','HCPS orders recorded twice','const payload={dealer, orders:hcpsOrders,','const payload={dealer, orders,'],
 ['shop','golden-only guard dropped','if(goldenOrders.length && !hcpsOrders.length){','if(false){'],
 ['submit','email sent despite a refused record','    if (res.status === 409 && rec && rec.status === "prices_changed")\n      return json(409','    if (false)\n      return json(409'],
 ['submit','server subtotal not used','items_subtotal: sub, estimated_total: r2(sub + fee),','items_subtotal: o.items_subtotal, estimated_total: o.estimated_total,'],
 ['submit','no sign-in required','if (!/^Bearer\\s+\\S+/i.test(auth)) return json(401','if (false) return json(401'],
 ['submit','email before persistence confirmed', 'if (!rec || !Array.isArray(rec.orders) || !rec.orders.length || (rec.status !== "recorded" && rec.status !== "partial"))', 'if (false)'],
 ['submit','unrecorded orders emailed', 'orders = applyServerPrices(orders.filter((o) => recordedSlugs.has(o.manufacturer_slug)), rec.orders);', 'orders = orders;'],
 ['submit','no retry', 'attempt < 2 &&', 'attempt < 1 &&'],
 ['submit','unsent order not flagged', 'if (unsent.length) { try { await callApi', 'if (false) { try { await callApi'],
 ['shop','partial order clears the whole cart', '(j.not_recorded||[]).forEach(sl=>keep.add(sl));', ''],
 ['submit','unrecorded order reported as placed', 'const notRecorded = orders.filter((o) => !recordedSlugs.has(o.manufacturer_slug) && !alreadySlugs.has(o.manufacturer_slug)).map((o) => o.manufacturer_slug);', 'const notRecorded = [];'],

 /* C3-06 — one checkout = one order; new manufacturer account notice */
 ['shop','no checkout key sent', 'hcpsOrders.forEach(o=>{ o.submission_key=checkoutKey(o,dealer); });', ''],
 ['shop','key kept after a recorded order', 'clearCheckoutKeys(hcpsOrders.map(', 'void(hcpsOrders.map('],
 ['shop','a changed order reuses the old key', 'if(cur&&cur.fp===fp&&', 'if(cur&&'],
 ['shop','one key for the whole cart', 'const m=Object.assign({},readCheckoutKeys()), fp=checkoutFingerprint(order,dealer), cur=m[order.manufacturer_slug];', 'const m=Object.assign({},readCheckoutKeys()), fp=JSON.stringify(CART.size), cur=m.all; order={manufacturer_slug:"all"};'],
 ['shop','notes not in the order key', 'order.po,order.notes||"",', 'order.po,'],
 ['shop','duplicate not told', 'dupNote?`Your order was already recorded', 'false?`Your order was already recorded'],
 ['shop','a new order told "already recorded"', 'if(j.status==="already_recorded") dupNote=true;', 'if(j.status==="already_recorded"||(j.already_recorded||[]).length) dupNote=true;'],
 ['submit','duplicate answer treated as a failure', 'if (res.ok && rec && Array.isArray(rec.already_recorded) && rec.already_recorded.length', 'if (false && res.ok && rec && Array.isArray(rec.already_recorded) && rec.already_recorded.length'],
 ['submit','already-recorded order reported not recorded', '!recordedSlugs.has(o.manufacturer_slug) && !alreadySlugs.has(o.manufacturer_slug)', '!recordedSlugs.has(o.manufacturer_slug)'],
 ['submit','notice dropped from the intake email', 'const notice = rec.account_notice ? { account_notice: String(rec.account_notice) } : {};', 'const notice = {};'],
 ['submit','notice dropped from the intake subject', 'const subject = (order.account_hold ? "[Pending account setup] " : order.account_notice ? "[New account required] " : "") +', 'const subject = "" +'],
 ['submit','held order not marked in the intake email', 'if (rec.account_hold === true) notice.account_hold = true;', ''],
 ['api','no duplicate check before recording', 'const already=keyCol?await recordedUnderKey(who.dealer_id,orders.map(keyOf)):[];', 'const already=[];'],
 ['api','key never stored', 'if(keyCol && keyOf(o)) row.submission_key=keyOf(o);', ''],
 ['api','unique-index race not caught', 'if(keyCol && keyOf(o) && /23505|duplicate key/i.test(String(e&&e.message))){', 'if(false){'],
 ['api','an order without lines counts as recorded', 'return (rows||[]).filter(o=>o.order_items.length).map(', 'return (rows||[]).map('],
 ['api','key not freed before the withdraw', 'if(keyCol && row.submission_key){ try{ await sb("PATCH"', 'if(false){ try{ await sb("PATCH"'],
 ['api','any probe failure read as "no column"', 'if(!(/Supabase 400/.test(m) && /42703|PGRST204|does not exist/i.test(m))){', 'if(false){'],
 ['api','manufacturer list failure swallowed', 'catch(e){ console.error("manufacturers read failed",e&&e.message); return json(503,', 'catch(e){ if(0) return json(503,'],
 ['api','duplicate manufacturers accepted', 'if(seen.has(k)) return json(400,', 'if(false) return json(400,'],
 ['api','already-recorded matched on key alone (another manufacturer)', 'already.some(r=>r.submission_key===keyOf(o)&&r.manufacturer_slug===slugOf(o))', 'already.some(r=>r.submission_key===keyOf(o))'],
 ['api','resubmission not noted', 'if(prev.indexOf("Dealer resubmitted this same order")<0) await sb(', 'if(false) await sb('],
 ['api','order without an account not held (owner 2026-11-06)', 'status:(cleanSlug&&acctMissing&&acctMissing.has(cleanSlug))?AS.STATUS:"submitted",', 'status:"submitted",'],
 ['api','held order not told to the dealer', 'su.account_hold=true; su.account_notice=AS.holdMessage(mfrName[su.slug]);', 'su.account_hold=false;'],
 ['api','unreadable account rows not flagged', 'if(acctMissing===null) for(const su of summaries) if(su.slug) su.account_notice=', 'if(false) for(const su of summaries) if(su.slug) su.account_notice='],
 ['api','key column required (breaks before the SQL)', 'if(!(/Supabase 400/.test(m) && /42703|PGRST204|does not exist/i.test(m))){', 'if(true){'],
 ['shop','browse-only line checked out anyway', 'if(noAcc.length){ toast(', 'if(false){ toast('],
 ['shop','browse-only test ignores the list', 'return !!(a&&Array.isArray(a.request_access)&&a.request_access.includes(slug));', 'return false;'],
 ['shop','request button never confirms', 'if(j&&j.ok){ ACCESS_REQUESTED.add(slug);', 'if(false){ ACCESS_REQUESTED.add(slug);'],
];
const API_DIR=path.join(__dirname,'..','netlify','functions');
let surv=0;
for(const [w,n,f,t] of M){ const P=w==='shop'?SHOP:w==='api'?path.join(API_DIR,'orders-api.js'):SUB; const src=fs.readFileSync(P,'utf8').replace(/\r\n/g,'\n'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  let envx;
  if(w==='api'){ const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mutapi-')); fs.cpSync(API_DIR,dir,{recursive:true}); fs.writeFileSync(path.join(dir,'orders-api.js'),src.replace(f,t)); envx=Object.assign({},process.env,{CAT_ROOT:dir}); }
  else { const out=MD+(w==='shop'?'/index.html':'/submit-order.js'); fs.writeFileSync(out,src.replace(f,t)); envx=Object.assign({},process.env, w==='shop'?{SHOP:out}:{SUBMIT:out}); }
  let k=false; try{execFileSync('node',[path.join(__dirname,'shopcart.test.js')],{stdio:'pipe',env:envx});}catch(e){k=true;}
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k)surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

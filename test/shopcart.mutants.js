const fs=require('fs'),{execFileSync}=require('child_process');
const path=require('path'),os=require('os');
const ORD=process.env.ORDER_REPO||path.join(__dirname,'..','..','homecareproviderservicesordering');
const SHOP=path.join(ORD,'public','index.html'), SUB=path.join(ORD,'netlify','functions','submit-order.js');
const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mutsc-'));
const M=[
 ['shop','restored cart not re-priced','  repriceSavedCart();\n}',' \n}'],
 ['shop','ladder not refreshed','["base_price","msrp","map","tiers","group","price_note"]','["base_price","msrp","map","group","price_note"]'],
 ['shop','change not shown','PRICE_NOTES.set(k,{old:(prev&&prev.old!=null)?prev.old:Number(it.client_unit), now:Number(it.unit)}); n++;','n++;'],
 ['shop','pre-submit check ignores a change','if(chk.changed){ applyServerPrices(chk); updateCart(); toast("Prices changed since you last reviewed your cart — review the updated totals, then place your order again"); return; }',''],
 ['shop','unconfirmed price submitted','if(!chk){ toast("Pricing could not be confirmed right now — nothing was submitted. Please try again."); return; }',''],
 ['shop','server refusal treated as success','if(!j.recorded){ toast(j.error||"Could not submit — nothing was placed. Please try again."); return; }',''],
 ['shop','contract not refreshed','if(AUTH.prices){ if(it.contract!=null) AUTH.prices[k]=Number(it.contract); else delete AUTH.prices[k]; }',''],
 ['shop','withdrawn line not blocking','if([...CART.values()].some(({p})=>p._unavailable)){','if(false){'],
 ['shop','HCPS orders recorded twice','body:JSON.stringify({action:"create",orders:goldenOrders,dealer})','body:JSON.stringify({action:"create",orders,dealer})'],
 ['shop','golden-only guard dropped','if(goldenOrders.length && AUTH.status===','if(AUTH.status==='],
 ['submit','email sent despite a refused record','    if (res.status === 409 && rec && rec.status === "prices_changed")\n      return json(409','    if (false)\n      return json(409'],
 ['submit','server subtotal not used','items_subtotal: sub, estimated_total: r2(sub + fee),','items_subtotal: o.items_subtotal, estimated_total: o.estimated_total,'],
 ['submit','no sign-in required','if (!/^Bearer\\s+\\S+/i.test(auth)) return json(401','if (false) return json(401'],
 ['submit','email before persistence confirmed', 'if (!rec || !Array.isArray(rec.orders) || !rec.orders.length || (rec.status !== "recorded" && rec.status !== "partial"))', 'if (false)'],
 ['submit','unrecorded orders emailed', 'orders = applyServerPrices(orders.filter((o) => recordedSlugs.has(o.manufacturer_slug)), rec.orders);', 'orders = orders;'],
 ['submit','no retry', 'attempt < 2 &&', 'attempt < 1 &&'],
 ['submit','unsent order not flagged', 'if (unsent.length) { try { await callApi', 'if (false) { try { await callApi'],
 ['shop','partial order clears the whole cart', '(j.not_recorded||[]).forEach(sl=>keep.add(sl));', ''],
 ['submit','unrecorded order reported as placed', 'const notRecorded = orders.filter((o) => !recordedSlugs.has(o.manufacturer_slug)).map((o) => o.manufacturer_slug);', 'const notRecorded = [];'],
];
let surv=0;
for(const [w,n,f,t] of M){ const P=w==='shop'?SHOP:SUB; const src=fs.readFileSync(P,'utf8').replace(/\r\n/g,'\n'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const out=MD+(w==='shop'?'/index.html':'/submit-order.js'); fs.writeFileSync(out,src.replace(f,t));
  const envx=Object.assign({},process.env, w==='shop'?{SHOP:out}:{SUBMIT:out});
  let k=false; try{execFileSync('node',[path.join(__dirname,'shopcart.test.js')],{stdio:'pipe',env:envx});}catch(e){k=true;}
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k)surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

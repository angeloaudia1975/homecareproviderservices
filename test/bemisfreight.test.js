/* Bemis freight in Bemis's own words (agreed 2026-10-10): $500+ = "Prepaid freight", below $500 =
   "$40.00 shipping & handling", at the cents either side of $500, in the cart, on the server, in the
   stored order and in both emails. Other lines keep their wording. Through the real code. */
const path=require('path'), fs=require('fs'), vm=require('vm');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const SHOP=process.env.SHOP_HTML||path.join(SHOPD,'public','index.html');
const MFRS=process.env.MFRS_JSON||path.join(SHOPD,'public','data','manufacturers.json');
const SUBMIT=process.env.SUBMIT_JS||path.join(SHOPD,'netlify','functions','submit-order.js');
const OB='https://ordering.test', LINE='bemis';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const mfrs=JSON.parse(fs.readFileSync(MFRS,'utf8'));
const AMT={B49999:499.99,B50000:500,B50001:500.01};
function shop(){
  const h=fs.readFileSync(SHOP,'utf8');
  const grab=(a,b)=>{ const i=h.indexOf(a); if(i<0) throw new Error('anchor '+a); return h.slice(i,h.indexOf(b,i)); };
  const code=grab('function computeFreight(slug,lines){','function grandTotal(){')+grab('function freightRowsHtml(f){','\n}\n')+'\n}';
  const ctx={ mfrInfo:s=>mfrs.find(m=>m.slug===s)||{}, unitPrice:p=>Number(p.base_price), linesSubtotal:L=>L.reduce((n,l)=>n+Number(l.p.base_price)*l.qty,0),
    money:n=>'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}), esc:s=>String(s).replace(/&/g,'&amp;') };
  vm.createContext(ctx); vm.runInContext(code+';this.computeFreight=computeFreight;this.freightRowsHtml=freightRowsHtml;',ctx); return ctx; }
function world(){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, tables:{ app_settings:[{key:'platform_state',value:{mode:'live'}}],
    manufacturers:[{slug:LINE,name:'Bemis'}], manufacturer_meta:[{slug:LINE}],
    dealers:[{id:'d1',parent_id:null,is_test:false}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
    dealer_contract_prices:[], product_overrides:[], product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[],
    custom_products:Object.entries(AMT).map(([code,b])=>({manufacturer:LINE,code,name:code,category:'Bath Safety',base_price:b,active:true})),
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
const ord=code=>[{manufacturer_slug:LINE,manufacturer_name:'Bemis',po:'P',items:[{code,qty:1,unit:AMT[code]}]}];
(async()=>{
await t('cart: $499.99 = "$40.00 shipping & handling · add $0.01 for prepaid freight"; $500.00 and $500.01 = "Prepaid freight"',async()=>{
  const S=shop(); const f=c=>S.computeFreight(LINE,[{p:{base_price:AMT[c],brand:'BEMIS'},qty:1}]);
  eq([f('B49999').fee,f('B50000').fee,f('B50001').fee],[40,0,0],'fees');
  const a=S.freightRowsHtml(f('B49999')), b=S.freightRowsHtml(f('B50000')), c=S.freightRowsHtml(f('B50001'));
  ok(/\$40\.00 shipping &amp; handling/.test(a)&&/add \$0\.01 for prepaid freight/.test(a),'under: '+a);
  ok(/Prepaid freight/.test(b)&&/Prepaid freight/.test(c),'at/over: '+b+' / '+c);
  const words=(a+b+c).replace(/<[^>]+>/g,' ');
  ok(!/FREE|free freight|to waive/i.test(words),'no generic free wording: '+words);
});
await t('other lines keep their words: Strongback "$15.00 freight" / Climbing Steps "FREE freight"',async()=>{
  const S=shop();
  const sb=S.freightRowsHtml(S.computeFreight('strongback-mobility',[{p:{base_price:50,category:'Accessories'},qty:1}]));
  const cs=S.freightRowsHtml(S.computeFreight('climbing-steps',[{p:{base_price:100,brand:'x'},qty:1}]));
  ok(/\$15\.00 freight/.test(sb)&&!/shipping &amp; handling<\/span><\/div>$/.test(sb),'strongback: '+sb);
  ok(/FREE freight/.test(cs),'climbing steps: '+cs);
});
await t('server: $40 / $0 / $0 at $499.99 / $500.00 / $500.01, rows carry Bemis words',async()=>{
  const got=[]; for(const c of Object.keys(AMT)){ const r=await call(mod(world()),{action:'price_check',orders:ord(c)}); const o=r.body.orders[0]; got.push([o.freight_fee,o.estimated_total]); }
  eq(got,[[40,539.99],[0,500],[0,500.01]]);
});
await t('dealer confirmation + HCPS email: "Prepaid freight" at $500, "$40.00 shipping & handling" under',async()=>{
  const S=require(SUBMIT);
  for(const [c,want,short] of [['B50000','Freight: Prepaid freight','Prepaid freight'],['B49999','Freight: $40.00 shipping & handling','$40.00 shipping & handling']]){
    const W=world(); const C=mod(W);
    const r=await call(C,{action:'create',dealer:{business:'B',email:'buyer@x.com',contact:'C'},orders:ord(c)}); eq(r.status,200,JSON.stringify(r.body));
    const mail=W.calls.find(x=>/resend/.test(x.url)); ok(mail,'no dealer email');
    ok(mail.body.text.includes(want),'dealer text: '+mail.body.text); ok(!/Freight: Free/.test(mail.body.text),'dealer says Free');
    ok(mail.body.html.includes(want.replace('&','&amp;')),'dealer html');
    const o=W.db.orders[0]; const rows=shop().computeFreight(LINE,[{p:{base_price:AMT[c],brand:'BEMIS'},qty:1}]).rows;  // the browser's rows, as submitted
    const m=S._buildEmail({business:'B',email:'b@x.com'},{manufacturer_name:'Bemis',manufacturer_slug:LINE,po:'P',items:[{code:c,name:c,qty:1,unit:AMT[c]}],items_count:1,items_subtotal:o.subtotal,estimated_total:o.estimated_total,freight_fee:o.freight_fee,freight_lines:JSON.parse(JSON.stringify(rows))});
    ok(m.text.includes('Freight: '+short),'HCPS text: '+m.text.split('\n').filter(l=>/Freight/.test(l)).join(' | '));
    ok(!/FREE/.test(m.html)&&m.html.includes(short.replace('&','&amp;')),'HCPS html');
  }
});
console.log(`bemis freight: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

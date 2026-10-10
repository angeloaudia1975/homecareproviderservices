/* Pack units (A1005, agreed 2026-10-09): quantity counts PACKS, the price is per pack, MAP per piece
   is labelled "each", and every confirmation says "4-pack (4 each)". Through the real engine. */
const path=require('path'), fs=require('fs'), vm=require('vm');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOP=process.env.SHOP_HTML||path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html');
const SUBMIT=process.env.SUBMIT_JS||path.join(__dirname,'..','..','homecareproviderservicesordering','netlify','functions','submit-order.js');
const OB='https://ordering.test', LINE='strongback-mobility';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
function world(){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, tables:{ app_settings:[{key:'platform_state',value:{mode:'live'}}],
    manufacturers:[{slug:LINE,name:'Strongback Mobility'}], manufacturer_meta:[{slug:LINE,record_authoritative:true}],
    dealers:[{id:'d1',parent_id:null,is_test:false}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
    dealer_contract_prices:[], product_overrides:[], product_images:[], product_links:[], product_media:[], product_content:[],
    custom_products:[{manufacturer:LINE,code:'A1005',name:'Strongback Cane Holder 4/Pk',base_price:50,msrp:24.95,active:true}],
    product_skus:[{manufacturer:LINE,code:'A1005',base_price:50,map:24.95,msrp:null,msrp_auto:false,uom:'4-pack',case_qty:4,status:'active'}],
    orders:[], order_items:[], tracking_requests:[], email_sends:[], intent_events:[], email_attribution:[] }});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')) return {ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})};
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    if(u.startsWith('https://api.resend.com')){ W.calls.push({url:u,method:'POST',body:JSON.parse(opts.body)}); return {ok:true,status:200,json:async()=>({id:'m'})}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return inner(url,opts); };
  return W; }
const mod=W=>M.load('orders-api.js',W,{ORDERING_BASE:OB,RESEND_API_KEY:'k'},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{authorization:'Bearer dealer'}});
(async()=>{
await t('server: qty 1 = one 4-pack at $50, qty 3 = $150; MAP stays per piece; no MSRP invented',async()=>{
  const C=mod(world());
  const r=await call(C,{action:'price_check',orders:[{manufacturer_slug:LINE,items:[{code:'A1005',qty:3,unit:50}]}]});
  const it=r.body.orders[0].items[0];
  eq([it.unit,it.line_total,it.commercial.map,it.commercial.msrp,r.body.changed],[50,150,24.95,null,false]);
});
await t('dealer confirmation email says "4-pack (4 each)"; the stored line is still one row per pack',async()=>{
  const W=world(); const C=mod(W);
  const r=await call(C,{action:'create',dealer:{business:'B',email:'buyer@x.com',contact:'C'},orders:[{manufacturer_slug:LINE,manufacturer_name:'Strongback',po:'P',items:[{code:'A1005',qty:1,unit:50}]}]});
  eq(r.status,200,JSON.stringify(r.body));
  eq([W.db.order_items.length,W.db.order_items[0].qty,W.db.order_items[0].unit_price],[1,1,50]);
  const mail=W.calls.find(c=>/resend/.test(c.url)); ok(mail,'no email');
  ok(/1 x Strongback Cane Holder 4\/Pk \(4-pack \(4 each\)\) @ \$50\.00/.test(mail.body.text),'text: '+mail.body.text);
  ok(/4-pack \(4 each\)/.test(mail.body.html),'html');
});
await t('HCPS order email (submit-order) says "4-pack (4 each)"',async()=>{
  delete require.cache[require.resolve(SUBMIT)]; const S=require(SUBMIT);
  const m=S._buildEmail({business:'B',email:'b@x.com'},{manufacturer_name:'Strongback',manufacturer_slug:LINE,po:'P',items:[{code:'A1005',name:'Cane Holder',qty:2,unit:50,uom:'4-pack',case_qty:4}],items_count:2,items_subtotal:100,estimated_total:100,freight_lines:[]});
  const txt=JSON.stringify(m); ok(/2 x Cane Holder \(A1005, 4-pack \(4 each\)\)/.test(txt),'text'); ok(/A1005 · 4-pack \(4 each\)/.test(txt),'html');
});
await t('Partner 360 card: "$50.00 per 4-pack", "Dealer order unit = 1 4-pack (4 each)", "MAP $24.95 each"; cart counts packs',async()=>{
  const h=fs.readFileSync(SHOP,'utf8');
  const grab=(a,b)=>h.slice(h.indexOf(a),h.indexOf(b,h.indexOf(a)));
  const code=grab('function packOf(p){','function priceHtml(p){')+grab('function priceHtml(p){','\n}\n')+'\n}';
  const ctx={state:{dealer:{}},contractPrice:()=>null,money:n=>'$'+Number(n).toFixed(2),esc:s=>String(s),dealerPriceNote:()=>'' };
  vm.createContext(ctx); vm.runInContext(code+';this.priceHtml=priceHtml;this.packOf=packOf;',ctx);
  const html=ctx.priceHtml({code:'A1005',base_price:50,map:24.95,msrp:null,uom:'4-pack',case_qty:4});
  ok(/per 4-pack/.test(html)&&/Dealer order unit = 1 4-pack \(4 each\)/.test(html)&&/MAP \$24\.95 each/.test(html),'card: '+html);
  ok(!/MSRP/.test(html),'no MSRP');
  const plain=ctx.priceHtml({code:'X',base_price:50,map:70});
  ok(!/each|per /.test(plain),'a normal product is unchanged: '+plain);
  const each=ctx.priceHtml({code:'1003AB',base_price:527,map:889,uom:'Each',case_qty:1});
  ok(!/Dealer order unit|per Each|each/.test(each),'a single unit is not a pack: '+each);
  ok(/\$\{qty\} × \$\{esc\(packOf\(p\)\.label\)\} = \$\{qty\*packOf\(p\)\.n\} each/.test(h),'cart line counts packs');
});
const BEMIS=process.env.BEMIS_JSON||path.join(__dirname,'..','..','homecareproviderservicesordering','public','data','bemis.json');
function card(){ const h=fs.readFileSync(SHOP,'utf8');
  const grab=(a,b)=>h.slice(h.indexOf(a),h.indexOf(b,h.indexOf(a)));
  const code=grab('function packOf(p){','function priceHtml(p){')+grab('function priceHtml(p){','\n}\n')+'\n}';
  const ctx={state:{dealer:{}},contractPrice:()=>null,money:n=>'$'+Number(n).toFixed(2),esc:s=>String(s),dealerPriceNote:()=>'' };
  vm.createContext(ctx); vm.runInContext(code+';this.priceHtml=priceHtml;',ctx); return ctx.priceHtml; }
await t('Bemis (2026-10-10): per-Case dealer price, MSRP and MAP "each"; a pack MSRP quoted per pack (Ovation) is unchanged',async()=>{
  const ph=card();
  const seat=ph({code:'7YR05310TSS',base_price:109.98,msrp:109.99,map:109.99,uom:'Case',case_qty:2,msrp_each:true});
  ok(/\$<\/sup>109<sup>\.98<\/sup> <span class="pnote">per Case<\/span>/.test(seat),'per Case: '+seat);
  ok(/Dealer order unit = 1 Case \(2 each\)/.test(seat),'order unit: '+seat);
  ok(/MSRP \$109\.99 each/.test(seat)&&/MAP \$109\.99 each/.test(seat),'MSRP/MAP each: '+seat);
  const arms=ph({code:'7YA05313GRY',base_price:119.96,msrp:59.99,map:59.99,uom:'Case',case_qty:4,msrp_each:true});
  ok(/MSRP \$59\.99 each/.test(arms),'a per-piece MSRP is weighed against the per-piece price ($29.99), not the case: '+arms);
  const ov=ph({code:'61000-210',base_price:139.95,msrp:279.9,uom:'10-pack',case_qty:10});
  ok(/MSRP \$279\.90<\/div>/.test(ov),'Ovation pack MSRP stays per pack: '+ov);
  ok(!/MSRP \$279\.90 each/.test(ov),'no "each" without msrp_each');
  ok(!/MSRP/.test(ph({code:'X',base_price:300,msrp:279.9,uom:'10-pack',case_qty:10})),'a per-pack MSRP below the pack price stays hidden');
  const st=ph({code:'7YE82350TC',base_price:54.99,msrp:109.99,map:109.99,uom:'Each',case_qty:1,msrp_each:true});
  ok(/MSRP \$109\.99<\/div>/.test(st)&&!/each|per /.test(st),'a single unit is never "each"/"per": '+st);
});
await t('Bemis catalog file = 2026 price list: Case + numeric qty, no derived unit price, Steadfast Each / 1',async()=>{
  const rows=JSON.parse(fs.readFileSync(BEMIS,'utf8')); const by={}; rows.forEach(r=>{ by[r.code]=r; });
  const want={'7YR05310TSS':[2,109.98,109.99,109.99],'7YE05310TSS':[2,109.98,109.99,109.99],'7YA05313GRY':[4,119.96,59.99,59.99],'7YA05313BLK':[4,119.96,59.99,59.99],
    '7YA06303TWA':[2,74.98,74.99,74.99],'7YA04505T':[3,119.97,79.99,79.99],'7YA0AS100':[2,99.98,99.99,99.99]};
  for(const [c,[q,bp,ms,mp]] of Object.entries(want)){ const r=by[c]; ok(r,'missing '+c);
    eq([r.uom,r.case_qty,r.base_price,r.msrp,r.map,r.msrp_each,r.price_note],['Case',q,bp,ms,mp,true,''],c);
    eq((r.tiers||[]).map(t=>[t.minQty,t.price]),[[1,bp]],c+' tiers');
    ok(!('unit_cost' in r),c+' carries a derived unit_cost'); }
  const s=by['7YE82350TC']; eq([s.uom,Number(s.case_qty),s.base_price,s.msrp,s.map,s.price_note],['Each',1,54.99,109.99,109.99,''],'Steadfast');
  ok(!('unit_cost' in s),'Steadfast unit_cost');
  rows.filter(r=>r.code!=='DO5300RD444').forEach(r=>ok(!/\/unit|MSRP \$/.test(r.price_note||''),r.code+' legacy note: '+r.price_note));
  ok(by['DO5300RD444'],'the retired display record is left as it was');
});
console.log(`pack units: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

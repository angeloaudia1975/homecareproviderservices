/* Private catalog preview (owner, 2026-10-27): orders-api preview_price_check / preview_order price a cart from the
   catalog files the preview page sends, but ONLY at the prices of the private record stored for exactly those rows;
   they never record an order, never email the dealer or a manufacturer, and send one copy of the HCPS email to the owner
   marked as a preview. A staff view-as-dealer token may run them; it may never create a real order. */
const path=require('path');
const M=require(path.join(__dirname,'phase0-mock.js'));
const ROOT=path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const CC=require(path.join(ROOT,'_catalog_commercial.js'));
const L=require(path.join(SHOPD,'scripts','p0-seed-lib.js'));
const OB='https://ordering.test';
let fail=0,pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n); }catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const FULL=[{manufacturer:'newco',code:'N1',name:'New thing',category:'X',base_price:40,msrp:80},{manufacturer:'newco',code:'N2',name:'Other',category:'X',base_price:5,msrp:10}];
const PUB=CC.splitCatalogFile(FULL).public;
const REC=L.planInitial('newco',FULL,PUB,'t').record;
const MFRS=[{slug:'newco',name:'NewCo',hasData:true,freight:{summary:'Actual.',groups:[],elseActual:true,actualNote:'Actual shipping charges apply to all orders.',otherLabel:'NewCo freight'}}];
function world(){
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, tables:{ app_settings:[{key:'platform_state',value:{mode:'live'}}],
    manufacturers:[{slug:'newco',name:'NewCo',contact_email:'orders@newco-mfr.example'}], manufacturer_meta:[{slug:'newco'}],
    dealers:[{id:'d1',parent_id:null,is_test:true}], dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
    dealer_manufacturers:[{dealer_id:'d1',manufacturer:'newco',active:true,status:'active'}],
    dealer_preview_tokens:[{token:'a'.repeat(48),dealer_id:'d1',expires_at:new Date(Date.now()+6e5).toISOString()},{token:'b'.repeat(48),dealer_id:'d1',expires_at:new Date(Date.now()-6e5).toISOString()}],
    catalog_file_commercial:[REC], dealer_contract_prices:[], dealer_line_discounts:[], product_overrides:[], product_images:[], product_links:[], product_media:[], product_content:[], product_skus:[], custom_products:[],
    orders:[], order_items:[], tracking_requests:[], email_sends:[], intent_events:[], email_attribution:[] }});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')) return {ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})};
    if(u===OB+'/data/manufacturers.json') return {ok:true,status:200,json:async()=>[]};   // production does not list the line yet
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    if(u.startsWith('https://api.resend.com')){ W.calls.push({url:u,method:'POST',body:JSON.parse(opts.body)}); return {ok:true,status:200,json:async()=>({id:'m'})}; }
    return inner(url,opts); };
  return W;
}
const body=(extra)=>Object.assign({dealer:{business:'B',email:'buyer@x.com',contact:'C'},catalog_files:{newco:JSON.parse(JSON.stringify(PUB))},manufacturers:MFRS,
  orders:[{manufacturer_slug:'newco',po:'P',items:[{code:'N1',qty:2,unit:40},{code:'N2',qty:1,unit:5}]}]},extra||{});
const run=async(W,b,hdr)=>M.call(M.load('orders-api.js',W,{ORDERING_BASE:OB,RESEND_API_KEY:'k'},ROOT),b,{headers:hdr||{authorization:'Bearer dealer'}});

(async()=>{
await t('preview_price_check prices the preview file at its stored private record',async()=>{
  const W=world(); const r=await run(W,body({action:'preview_price_check'}));
  eq([r.status,r.body.ok,r.body.changed],[200,true,false],JSON.stringify(r.body).slice(0,300));
  eq(r.body.orders[0].items.map(i=>i.unit),[40,5]);
});
await t('a file with no stored version is refused (no invented prices)',async()=>{
  const W=world(); const b=body({action:'preview_price_check'}); b.catalog_files.newco[0].name='Renamed';
  const r=await run(W,b); eq(r.status,503,JSON.stringify(r.body).slice(0,200));
});
await t('a preview file carrying a price is refused',async()=>{
  const W=world(); const b=body({action:'preview_price_check'}); b.catalog_files.newco[0].base_price=1;
  const r=await run(W,b); eq([r.status,r.body.status],[400,'bad_preview']);
});
await t('preview_order records nothing, emails neither dealer nor manufacturer, sends one marked copy to the owner',async()=>{
  const W=world(); const r=await run(W,body({action:'preview_order'}));
  eq([r.status,r.body.recorded],[200,false],JSON.stringify(r.body).slice(0,300));
  eq((W.db.orders||[]).length+(W.db.order_items||[]).length,0,'nothing stored');
  const to=W.calls.filter(c=>/resend/.test(c.url)).map(c=>c.body.to).flat();
  eq(to,['angelo@homecareproviderservices.us'],'only the owner copy');
  ok(/CATALOG PREVIEW — NOT AN ORDER/.test(W.calls.find(c=>/resend/.test(c.url)).body.subject),'marked');
  ok(/not a manufacturer confirmation/.test(r.body.dealer_email.text),'dealer acknowledgment rendered');
  ok(/NOT yet placed/.test(r.body.hcps_emails[0].text),'HCPS email rendered');
  ok(!JSON.stringify(W.calls).includes('newco-mfr'),'no manufacturer address');
});
await t('a staff view-as-dealer token runs the preview actions; an expired one does not; it never creates an order',async()=>{
  const W=world();
  const a=await run(W,body({action:'preview_price_check'}),{'x-hcps-preview':'a'.repeat(48)}); eq(a.status,200,JSON.stringify(a.body).slice(0,200));
  const b=await run(W,body({action:'preview_price_check'}),{'x-hcps-preview':'b'.repeat(48)}); eq(b.body.status,'unauthorized');
  const c=await run(W,body({action:'create'}),{'x-hcps-preview':'a'.repeat(48)}); eq(c.body.status,'unauthorized');
  eq((W.db.orders||[]).length,0);
});
await t('the real create ignores preview files (production files decide)',async()=>{
  const W=world(); const r=await run(W,body({action:'create'}));
  ok(r.status!==200 || !(r.body.orders||[]).length, 'a line production does not list is not ordered from a preview file: '+JSON.stringify(r.body).slice(0,200));
  eq((W.db.orders||[]).length,0);
});
await t('dealers-api preview_link accepts only a deploy preview of the ordering site',async()=>{
  const src=require('fs').readFileSync(path.join(ROOT,'dealers-api.js'),'utf8');
  const re=/\/\^https:\\\/\\\/\(deploy-preview-\\d\{1,5\}\|\[a-z0-9-\]\{1,40\}\)--hcpsonlineordering\\\.netlify\\\.app\$\//; ok(re.test(src),'host rule present');
  const rx=/^https:\/\/(deploy-preview-\d{1,5}|[a-z0-9-]{1,40})--hcpsonlineordering\.netlify\.app$/;
  eq(['https://deploy-preview-12--hcpsonlineordering.netlify.app','https://evil.com','https://x--hcpsonlineordering.netlify.app.evil.com','http://deploy-preview-1--hcpsonlineordering.netlify.app'].map(u=>rx.test(u)),[true,false,false,false]);
});
console.log(`catalog preview: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

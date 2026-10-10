/* Manufacturer Center Phase 3 — the verification suite (catalog-api mc_verify), end to end on a
   Bemis-shaped line: product card, cart, server pricing, freight thresholds, both emails, impact,
   retired SKUs, images, fingerprint. Plus: the server-side copies equal the storefront files. */
const path=require('path'), fs=require('fs');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const SHOP=process.env.SHOP_HTML||path.join(SHOPD,'public','index.html');
const OB='https://ordering.test', LINE='bemis';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const html=fs.readFileSync(SHOP,'utf8');
const FILE=[
  {manufacturer:LINE,code:'7YR05310TSS',name:'Assurance Round Seat',category:'Bath Safety',brand:'BEMIS',uom:'Case',case_qty:2,base_price:109.98,msrp:109.99,map:109.99,msrp_each:true,price_note:'',tiers:[{minQty:1,price:109.98}],image:'/assets/products/bemis/7YR05310TSS.jpg'},
  {manufacturer:LINE,code:'7YE82350TC',name:'Steadfast Seat',category:'Bath Safety',brand:'BEMIS',uom:'Each',case_qty:'1',base_price:54.99,msrp:109.99,map:109.99,price_note:'',tiers:[{minQty:1,price:54.99}],image:'/assets/products/bemis/7YE82350TC.jpg'},
  {manufacturer:LINE,code:'DO5300RD444',name:'Display (retired code)',category:'Bath Safety',brand:'BEMIS',uom:'Each',case_qty:'1',base_price:634.86,msrp:1269.72,price_note:'MSRP $1,269.72',tiers:[{minQty:1,price:634.86}],image:'/assets/products/bemis/DO5300RD444.jpg'}];
const MFRS=JSON.parse(fs.readFileSync(path.join(SHOPD,'public','data','manufacturers.json'),'utf8'));
function world(o){
  o=o||{};
  const rec=[{manufacturer:LINE,code:'7YR05310TSS',base_price:109.98,msrp:109.99,map:109.99,msrp_auto:false,status:'active',uom:'Case',case_qty:2,source_id:1,dealer_unit_cost:64.99},
             {manufacturer:LINE,code:'7YE82350TC',base_price:54.99,msrp:109.99,map:109.99,msrp_auto:false,status:'active',uom:'Each',case_qty:1,source_id:1,dealer_unit_cost:54.99},
             {manufacturer:LINE,code:'444DISPLAY',base_price:634.86,msrp:1269.72,map:1269.72,msrp_auto:false,status:'active',uom:'Display',case_qty:1,source_id:1,dealer_unit_cost:634.86},
             {manufacturer:LINE,code:'DO5300RD444',status:'discontinued'}];
  const W=M.createWorld({ tables:{
    manufacturer_meta:[{slug:LINE,record_authoritative:true,frozen:true,deferrals:[],freight_terms:null}],
    product_skus:(o.records||rec), product_content:[], product_links:[], product_media:[],
    product_overrides:o.overrides||[{manufacturer:LINE,code:'DO5300RD444',patch:{active:false}}],
    custom_products:[{manufacturer:LINE,code:'444DISPLAY',name:'Assurance Display Program',category:'Bath Safety',base_price:634.86,msrp:1269.72,map:1269.72,active:true,image:'/assets/products/bemis/DO5300RD444.jpg'}].concat(o.extraCustom||[]),
    mfr_sources:[{id:1,manufacturer:LINE,kind:'price_list',title:'Bemis Digital Price List 2026',legacy:false,status:'accepted',received_date:'2026-10-10',effective_date_status:'pending',manufacturer_effective_date:null}],
    price_imports:(o.imports||[{manufacturer:LINE,code:'7YR05310TSS',base_price:109.98,msrp:109.99,map:109.99,parsed_case_qty:2,parsed_unit_cost:64.99,source_id:1},
      {manufacturer:LINE,code:'7YE82350TC',base_price:54.99,msrp:109.99,map:109.99,parsed_case_qty:null,parsed_unit_cost:54.99,source_id:1},
      {manufacturer:LINE,code:'444DISPLAY',base_price:634.86,msrp:1269.72,map:1269.72,parsed_case_qty:null,parsed_unit_cost:634.86,source_id:1}]),
    mfr_decisions:[{id:1,manufacturer:LINE,code:'7YE82350TC',field:'uom',kind:'interpretation',hcps_value:{uom:'Each',case_qty:1}},
                   {id:2,manufacturer:LINE,code:'444DISPLAY',field:'uom',kind:'interpretation',hcps_value:{uom:'Display',case_qty:1}}],
    mfr_verification_runs:o.runs||[], dealer_contract_prices:[], dealer_carts:o.carts||[], dealers:[] }});
  const inner=W.fetch;
  W.fetch=async(u,opts)=>{ u=String(u);
    if(u===OB+'/index.html') return {ok:true,status:200,text:async()=>(o.html||html)};
    if(u===OB+'/data/bemis.json') return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(o.file||FILE))};
    if(u===OB+'/data/manufacturers.json') return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(MFRS))};
    if(u.startsWith(OB+'/data/')) return {ok:false,status:404,json:async()=>null,text:async()=>''};
    if(u.startsWith(OB+'/assets/')){ const bad=(o.brokenImages||[]).some(b=>u.endsWith(b)); return {ok:!bad,status:bad?404:200,headers:{get:k=>k==='content-type'?(bad?'text/html':'image/jpeg'):null}}; }
    (W.db.product_skus||[]).forEach(r=>{ r.code_norm=norm(r.code); }); return inner(u,opts); };
  return W; }
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
const verify=(C,extra)=>call(C,Object.assign({action:'mc_verify',manufacturer:LINE,phase:'baseline'},extra||{}));
const ck=(r,id)=>(r.body.checks||[]).find(c=>c.id===id)||{};
(async()=>{
await t('the server copies are the storefront files (engine, card/freight words, HCPS email)',async()=>{
  const EX=require(path.join(ROOT,'_extract.js'));
  eq(EX.extractEngine(html)===require(path.join(ROOT,'_shop_engine.js')).SOURCE,true,'engine');
  const want=require('./mc-copies.js').build();
  eq(fs.readFileSync(path.join(ROOT,'_shop_render.js'),'utf8')===want['_shop_render.js'],true,'_shop_render.js is stale: run node test/mc-copies.js');
  eq(fs.readFileSync(path.join(ROOT,'_hcps_email.js'),'utf8')===want['_hcps_email.js'],true,'_hcps_email.js is stale: run node test/mc-copies.js');
  eq(EX.extractEngine(html)===require('./extract-engine.js').extract(html),true,'runtime extractor = test extractor');
});
await t('a sound line passes every blocking check, and the run is saved',async()=>{
  const W=world(); const C=mod(W); const r=await verify(C);
  eq(r.status,200,JSON.stringify(r.body).slice(0,400));
  eq([r.body.result,r.body.failed],['pass',[]],JSON.stringify(r.body.checks.filter(c=>!c.pass)).slice(0,800));
  eq(W.db.mfr_verification_runs.length,1); eq(W.db.mfr_verification_runs[0].result,'pass');
  for(const id of ['engine_in_sync','render_in_sync','cart_template','full_field_parity','every_product_has_record','source_alignment','product_cards','cart_lines','browser_equals_server','freight_boundaries','emails','retired_refused','images','fingerprint']) ok(ck(r,id).pass,id+' missing or failed');
});
await t('freight boundaries: $499.99 = $40 shipping & handling, $500.00 and $500.01 = Prepaid freight',async()=>{
  const W=world(); const C=mod(W); const r=await verify(C);
  const rows=ck(r,'freight_boundaries').detail; ok(Array.isArray(rows),'rows');
  const at=v=>rows.find(x=>x.amount===v)||{};
  eq([at(499.99).fee,at(500).fee,at(500.01).fee],[40,0,0]);
  ok(/\$40\.00 shipping & handling/.test(at(499.99).words)&&/Prepaid freight/.test(at(500).words)&&/Prepaid freight/.test(at(500.01).words),JSON.stringify(rows));
});
await t('both emails carry "Case (2 each)" and the Bemis freight words',async()=>{
  const W=world(); const C=mod(W); const r=await verify(C); const d=ck(r,'emails').detail;
  ok(d.dealer_lines.some(l=>/Case \(2 each\)/.test(l))&&d.hcps_lines.some(l=>/7YR05310TSS, Case \(2 each\)/.test(l)),JSON.stringify(d));
  ok(/shipping & handling|Prepaid freight/.test(d.dealer_freight)&&/shipping & handling|Prepaid freight/.test(d.hcps_freight),JSON.stringify(d));
});
await t('stale storefront code fails the run (engine/render copies no longer match the live page)',async()=>{
  const W=world({html:html.replace('function packOf(p){','function packOf(p){ /* changed */')}); const C=mod(W); const r=await verify(C);
  eq(r.body.result,'fail'); ok(!ck(r,'render_in_sync').pass,'render_in_sync should fail');
});
await t('a changed pricing engine on the live page fails the run (engine copy stale)',async()=>{
  const W=world({html:html.replace('function unitPrice(p, qty){','function unitPrice(p, qty){ /* changed */')}); const C=mod(W); const r=await verify(C);
  eq(r.body.result,'fail'); ok(!ck(r,'engine_in_sync').pass,'engine_in_sync should fail'); ok(ck(r,'render_in_sync').pass,'render copy unaffected');
});
await t('a visible product with no master record fails the run',async()=>{
  const W=world({extraCustom:[{manufacturer:LINE,code:'NEW1',name:'Unrecorded',base_price:10,active:true,image:'/assets/products/bemis/7YR05310TSS.jpg'}]}); const C=mod(W); const r=await verify(C);
  eq(r.body.result,'fail'); eq(ck(r,'every_product_has_record').detail,['NEW1']);
});
await t('a record that disagrees with the source as received fails the run',async()=>{
  const W=world({imports:[{manufacturer:LINE,code:'7YR05310TSS',base_price:109.99,msrp:109.99,map:109.99,parsed_case_qty:2,parsed_unit_cost:64.99,source_id:1}]}); const C=mod(W); const r=await verify(C);
  eq(r.body.result,'fail'); eq(ck(r,'source_alignment').detail[0].field,'base_price');
});
await t('a missing case qty with no HCPS decision is flagged; a recorded decision clears it',async()=>{
  const W=world({imports:[{manufacturer:LINE,code:'7YE82350TC',base_price:54.99,msrp:109.99,map:109.99,parsed_case_qty:null,parsed_unit_cost:54.99,source_id:1}]});
  W.db.mfr_decisions=[]; const C=mod(W); const r=await verify(C);
  eq(r.body.result,'fail'); eq(ck(r,'source_alignment').detail[0].field,'case_qty');
});
await t('a derived "/unit" price note on a card fails the run',async()=>{
  const f=JSON.parse(JSON.stringify(FILE)); f[0].price_note='Case of 2 · $54.99/unit';
  const W=world({file:f}); const C=mod(W); const r=await verify(C);
  eq(r.body.result,'fail'); eq(ck(r,'product_cards').detail[0].issue,'derived per-unit price in note');
});
await t('a retired SKU that is still listed fails the run',async()=>{
  const W=world({overrides:[]}); const C=mod(W); const r=await verify(C);
  eq(r.body.result,'fail'); ok(ck(r,'retired_refused').detail.some(x=>x.code==='DO5300RD444'&&x.issue==='listed on Partner 360'),JSON.stringify(ck(r,'retired_refused')));
});
await t('a broken image fails the run (zero broken images)',async()=>{
  const W=world({brokenImages:['7YE82350TC.jpg']}); const C=mod(W); const r=await verify(C);
  eq(r.body.result,'fail'); ok(ck(r,'images').detail.broken.some(b=>/7YE82350TC/.test(b.url)),JSON.stringify(ck(r,'images')));
});
await t('a later run compares against the baseline fingerprint: unchanged passes; any dealer-facing change fails and names the line',async()=>{
  const W=world(); const C=mod(W); const base=await verify(C); eq(base.body.result,'pass');
  const same=await verify(C,{phase:'release'}); eq([same.body.result,same.body.baseline_run],['pass',W.db.mfr_verification_runs[0].id]);
  ok(ck(same,'fingerprint').pass,'unchanged fingerprint');
  const f=JSON.parse(JSON.stringify(FILE)); f[1].category='Toilet Safety';     // nothing but the dealer-facing category moves
  const C2=mod(W); const W2fetch=W.fetch; W.fetch=async(u,o)=>String(u)===OB+'/data/bemis.json'?{ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(f))}:W2fetch(u,o); global.fetch=W.fetch;
  const changed=await verify(C2,{phase:'release'}); eq([changed.body.result,changed.body.failed],['fail',['fingerprint']]);
  ok(ck(changed,'fingerprint').detail.now.some(l=>l.startsWith('7YE82350TC|')&&l.includes('|Toilet Safety|')),JSON.stringify(ck(changed,'fingerprint').detail.now));
});
await t('impact lists saved carts that hold this line',async()=>{
  const W=world({carts:[{dealer_id:'d1',cart:{items:[{qty:2,p:{code:'7YR05310TSS',manufacturer:LINE}}]},updated_at:'2026-10-01'}]}); const C=mod(W); const r=await verify(C);
  eq(ck(r,'impact').detail.saved_cart_lines,1);
});
await t('a run that cannot finish is an error, never a pass (unreadable storefront page)',async()=>{
  const W=world(); const inner=W.fetch; W.fetch=async(u,o)=>String(u)===OB+'/index.html'?{ok:false,status:503,text:async()=>''}:inner(u,o); const C=mod(W);
  const r=await verify(C); eq([r.status,r.body.error],[503,'verify_unreadable']); eq(W.db.mfr_verification_runs.length,0);
});
await t('mc_overview and mc_line read the register, decisions and runs (strict)',async()=>{
  const W=world(); const C=mod(W); await verify(C);
  const ov=await call(C,{action:'mc_overview'}); eq(ov.status,200,JSON.stringify(ov.body).slice(0,300));
  const b=ov.body.lines.find(l=>l.slug===LINE); eq([b.frozen,b.authoritative,b.source.title,b.decisions,b.last_run.result],[true,true,'Bemis Digital Price List 2026',2,'pass']);
  const ln=await call(C,{action:'mc_line',manufacturer:LINE}); eq([ln.body.sources.length,ln.body.decisions.length,ln.body.runs.length],[1,2,1]);
});
await t('an unreadable register is an error on screen, never an empty list',async()=>{
  const W=world(); const C=mod(W); const inner=W.fetch;
  W.fetch=async(u,o)=>/\/rest\/v1\/mfr_sources/.test(String(u))?{ok:false,status:500,text:async()=>'boom',json:async()=>({})}:inner(u,o); global.fetch=W.fetch;
  const r=await call(C,{action:'mc_overview'}); eq([r.status,r.body.error],[503,'mc_unreadable']);
});
await t('mc_record_decision records who decided and refuses an empty reason or unknown kind',async()=>{
  const W=world(); const C=mod(W);
  let r=await call(C,{action:'mc_record_decision',manufacturer:LINE,kind:'regression_fix',field:'base_price',code:'7YR05310TSS',reason:'Live card shows the wrong price'}); eq(r.status,200,JSON.stringify(r.body));
  eq([r.body.decision.kind,r.body.decision.used_at==null],['regression_fix',true]);
  r=await call(C,{action:'mc_record_decision',manufacturer:LINE,kind:'regression_fix',field:'x',reason:'  '}); eq(r.status,400);
  r=await call(C,{action:'mc_record_decision',manufacturer:LINE,kind:'whim',field:'x',reason:'y'}); eq(r.status,400);
});
console.log(`mc verify: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

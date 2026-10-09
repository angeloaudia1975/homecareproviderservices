/* A failed read is not "no data" — Featured Products and contract prices (agreed 2026-10-09).
   Real handlers, in-memory PostgREST with forced read failures. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const OB='https://ordering.test';
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };

const LINE='climbing-steps';
const FILES={manufacturers:[{slug:LINE,name:'Climbing Steps',hasData:true}],[LINE]:[{code:'MP-P08',name:'Sidekick',category:'Bath',base_price:10}]};
function world(failTable, fileFail){
  const W=M.createWorld({tables:{
    featured_products:[{manufacturer:LINE,code:'MP-P08',name:'Sidekick',rank:1,active:true}],
    custom_products:[], product_overrides:[], product_content:[],
    dealers:[{id:'d1',business_name:'Dealer One',parent_id:null,state:'OH'}],
    dealer_manufacturers:[{dealer_id:'d1',manufacturer:LINE,active:true,account_ref:'A1'}],
    dealer_contract_prices:[{dealer_id:'d1',manufacturer:LINE,code:'MP-P08',price:7.5,active:true,name:null,note:null}],
    dealer_preview_tokens:[{token:'p1',dealer_id:'d1',expires_at:'2999-01-01T00:00:00Z',used_at:null}],
    dealer_addresses:[], geocache:[],
  }, failRead:(table)=>table===failTable?500:0});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(OB+'/data/')){ const slug=decodeURIComponent(u.slice((OB+'/data/').length).replace(/\.json.*$/,''));
      if(fileFail===slug) return {ok:false,status:502,text:async()=>'',json:async()=>{throw new Error('x');}};
      if(!(slug in FILES)) return {ok:false,status:404,text:async()=>'',json:async()=>null};
      return {ok:true,status:200,text:async()=>JSON.stringify(FILES[slug]),json:async()=>JSON.parse(JSON.stringify(FILES[slug]))}; }
    return inner(url,opts); };
  return W;
}
const env={ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB};
const get=(C,qs)=>C.handler({httpMethod:'GET',headers:{'x-analytics-token':'pass'},queryStringParameters:qs||{},body:null})
  .then(r=>({status:r.statusCode,body:JSON.parse(r.body||'{}')}));

(async()=>{
// ---- Featured Products (admin) ----
await t('Featured: a readable line is served',async()=>{
  const C=M.load('featured-api.js',world(),env,ROOT); const r=await get(C,{manufacturer:LINE});
  eq(r.status,200,'status'); eq(Object.keys(r.body.featured),['MP-P08'],'featured');
});
for(const tbl of ['featured_products','custom_products','product_overrides','product_content']){
  await t('Featured: an unreadable '+tbl+' is a 503, not an empty list',async()=>{
    const C=M.load('featured-api.js',world(tbl),env,ROOT); const r=await get(C,{manufacturer:LINE});
    eq([r.status,r.body.error],[503,'layer_unreadable'],'status');
  });
}
await t('Featured: an unreadable catalog file is a 503; a missing one (404) is an empty line',async()=>{
  let C=M.load('featured-api.js',world(null,LINE),env,ROOT); let r=await get(C,{manufacturer:LINE}); eq(r.status,503,'502 file');
  C=M.load('featured-api.js',world(),env,ROOT); r=await get(C,{manufacturer:'no-such-line'}); eq(r.status,200,'404 file');
});
await t('Featured: the overview list fails loudly too',async()=>{
  const C=M.load('featured-api.js',world('featured_products'),env,ROOT); const r=await get(C,{});
  eq([r.status,r.body.error],[503,'layer_unreadable'],'status');
});

// ---- Contract prices: the dealer session (dealer-auth) ----
const preview=C=>C.handler({httpMethod:'POST',headers:{},body:JSON.stringify({action:'preview',token:'p1'})}).then(r=>({status:r.statusCode,body:JSON.parse(r.body)}));
await t('dealer session: contract prices load',async()=>{
  const C=M.load('dealer-auth.js',world(),env,ROOT); const r=await preview(C);
  eq([r.status,r.body.status,r.body.prices,r.body.prices_unavailable],[200,'approved',{[LINE+'::MP-P08']:7.5},undefined],'payload');
});
await t('dealer session: unreadable contract prices are UNKNOWN (null + flag), never "none" — and the dealer stays signed in',async()=>{
  const C=M.load('dealer-auth.js',world('dealer_contract_prices'),env,ROOT); const r=await preview(C);
  eq([r.status,r.body.status,r.body.prices,r.body.prices_unavailable],[200,'approved',null,true],'payload');
});

// ---- Contract prices: the admin editor (dealers-api) ----
await t('Contract Pricing editor: an unreadable list is a 503, not "no contract prices"',async()=>{
  const C=M.load('dealers-api.js',world('dealer_contract_prices'),env,ROOT);
  const r=await M.call(C,{action:'list_contract_prices',dealer_id:'d1'},{headers:{'x-analytics-token':'pass'}});
  eq([r.status,r.body.error],[503,'layer_unreadable'],'status');
});

console.log(`strict reads: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

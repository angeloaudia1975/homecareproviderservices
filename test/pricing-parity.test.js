/* 2.7 — the server prices with the storefront's own code, and this test is what keeps it so.
   _shop_engine.js must be the shop page's engine text exactly; feedRows and recordAuthority must
   give the same answers as the shop's catalog-feed. Any drift fails here, before a deploy. */
const fs=require('fs'), path=require('path');
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const ORD=process.env.ORDER_REPO||path.join(__dirname,'..','..','homecareproviderservicesordering');
let fail=0,pass=0; function t(n,f){ try{ f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const P=require(path.join(ROOT,'_pricing.js'));
t('the server engine is the shop page engine, byte for byte',()=>{
  const ex=require(path.join(__dirname,'extract-engine.js'));
  const shop=fs.readFileSync(path.join(ORD,'public','index.html'),'utf8');
  if(require(path.join(ROOT,'_shop_engine.js')).SOURCE!==ex.extract(shop))
    throw new Error('_shop_engine.js has drifted from the shop page — regenerate it with test/extract-engine.js');
});
const FEED=require(path.join(ORD,'netlify','functions','catalog-feed.js'));
t('feedRows answers exactly like catalog-feed',()=>{
  const rows=[{code:'B',base_price:'10.5',msrp:null,msrp_auto:true,map:'',tiers:[{min_qty:6,price:9},{min_qty:'2',price:'9.5'},{min_qty:'x',price:1}],uom:'EA',case_qty:'12',option_label:'Small'},
              {code:'A',base_price:null,tiers:[],price_note:'call',hcpcs:'L4361'},{code:3,base_price:0,tiers:[{min_qty:'z',price:1}]}];
  eq(P.feedRows(JSON.parse(JSON.stringify(rows))),FEED.feedRows(JSON.parse(JSON.stringify(rows))),'feedRows');
});
t('recordAuthority answers exactly like catalog-feed',()=>{
  for(const m of [null,[],[{}],[{record_authoritative:true}],[{record_authoritative:true,record_resync_error:'parity: 2'}],[{record_authoritative:'true'}],[{record_authoritative:false}]])
    eq(P.recordAuthority(m),FEED.recordAuthority(m),JSON.stringify(m));
});
t('contract prices are read exactly as dealer-auth builds them',()=>{
  const src=fs.readFileSync(path.join(ROOT,'dealer-auth.js'),'utf8');
  for(const frag of ['dealer_contract_prices?dealer_id=in.(${ids.join(",")})&active=eq.true&select=dealer_id,manufacturer,code,price',
                     '(a.dealer_id===dealer_id?1:0)-(b.dealer_id===dealer_id?1:0)','prices[`${r.manufacturer}::${r.code}`]=Number(r.price)'])
    if(!src.includes(frag)) throw new Error('dealer-auth contract-price logic changed: '+frag);
});
console.log(`\npricing parity: ${pass} passed, ${fail} failed`); process.exitCode=fail?1:0;

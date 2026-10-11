/* Manufacturer Center Phase 4 (approved 2026-10-10): MSRP / MAP basis reaches the storefront.
   product_skus.msrp_basis / map_basis ('each' | 'order_unit' | empty) travel through catalog-feed (and the
   server's copy, _pricing.feedRows) and decide whether a PACK card reads "MSRP $x each" / "MAP $x each".
   An empty basis keeps the storefront's standing rule exactly — MSRP "each" only for msrp_each rows, MAP
   "each" on every pack — so a line whose record carries no basis cannot change. A single item never gets
   a basis label. Unknown words are ignored, never guessed at. */
const path=require('path'), fs=require('fs');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const SHOP=process.env.SHOP_HTML||path.join(SHOPD,'public','index.html');
const FEED=process.env.FEED_JS||path.join(SHOPD,'netlify','functions','catalog-feed.js');
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const EX=require(path.join(ROOT,'_extract.js'));
let fail=0, pass=0;
function t(name,fn){ try{ fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const html=fs.readFileSync(SHOP,'utf8');
const R=new Function('state','contractPrice',EX.extractRender(html)+';return {priceHtml,msrpIsEach,mapIsEach,packOf};')({dealer:{}},()=>null);
const text=h=>String(h).replace(/<\/div>/g,' </div>').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const reconcile=new Function(EX.grabDecl(html,'function reconcileShopPrices')+';return reconcileShopPrices;')();
const pack=(o)=>Object.assign({code:'P1',base_price:100,msrp:80,map:60,uom:'Case',case_qty:2},o||{});
const single=(o)=>Object.assign({code:'S1',base_price:40,msrp:80,map:60,uom:'Each',case_qty:1},o||{});

t('no basis = the standing rule, unchanged: MSRP "each" only with msrp_each, MAP "each" on a pack, nothing on a single item',()=>{
  eq([R.msrpIsEach(pack()),R.mapIsEach(pack())],[false,true]);
  eq([R.msrpIsEach(pack({msrp_each:true})),R.mapIsEach(pack({msrp_each:true}))],[true,true]);
  eq([R.msrpIsEach(single({msrp_each:true})),R.mapIsEach(single())],[false,false]);
});
t('a basis on the record decides: each / order_unit for MSRP and MAP independently',()=>{
  eq(R.msrpIsEach(pack({msrp_basis:'each'})),true,'msrp each');
  eq(R.msrpIsEach(pack({msrp_basis:'order_unit',msrp_each:true})),false,'record order_unit beats the catalog row flag');
  eq(R.mapIsEach(pack({map_basis:'order_unit'})),false,'map order_unit');
  eq(R.mapIsEach(pack({map_basis:'each'})),true,'map each');
  eq([R.msrpIsEach(single({msrp_basis:'each'})),R.mapIsEach(single({map_basis:'each'}))],[false,false],'never on a single item');
});
t('an unknown basis word is ignored (falls back to the standing rule)',()=>{
  eq([R.msrpIsEach(pack({msrp_basis:'per_case',msrp_each:true})),R.mapIsEach(pack({map_basis:'EACH'}))],[true,true]);
  eq(R.msrpIsEach(pack({msrp_basis:'Each'})),false);
});
t('the card: MSRP each is weighed against the per-piece price; per order unit against the case price',()=>{
  const e=text(R.priceHtml(pack({msrp_basis:'each',map_basis:'each'})));
  ok(/MSRP \$80\.00 each/.test(e)&&/MAP \$60\.00 each/.test(e),e);
  const o=text(R.priceHtml(pack({msrp_basis:'order_unit',map_basis:'order_unit',msrp:150})));
  ok(/MSRP \$150\.00(?! each)/.test(o)&&/MAP \$60\.00(?! each)/.test(o),o);
  const hidden=text(R.priceHtml(pack({msrp_basis:'order_unit'})));     // MSRP 80 under a 100 case price: not shown
  ok(!/MSRP/.test(hidden),hidden);
});
t('the card with no basis is byte-identical to the pre-Phase-4 rule on every shape',()=>{
  const legacy=p=>{ const k=R.packOf(p); const me=!!(k&&p.msrp_each===true); const fl=me?Number(p.base_price)/k.n:Number(p.base_price);
    return { msrp:(p.msrp!=null&&Number(p.msrp)>fl)?('MSRP $'+Number(p.msrp).toFixed(2)+(me?' each':'')):'', map:(p.map!=null&&Number(p.map)>0)?('MAP $'+Number(p.map).toFixed(2)+(k?' each':'')):'' }; };
  for(const p of [pack(),pack({msrp_each:true}),pack({msrp:150}),pack({msrp:150,msrp_each:true}),single(),single({msrp:30}),pack({map:null}),pack({case_qty:3,uom:''})]){
    const tx=text(R.priceHtml(p)), L=legacy(p);
    for(const [k,re] of [['msrp',/MSRP/],['map',/MAP/]]){
      if(!L[k]){ ok(!re.test(tx),JSON.stringify(p)+' → '+tx); continue; }
      ok(tx.includes(L[k]),JSON.stringify(p)+' → '+tx);
      if(!L[k].endsWith(' each')) ok(!tx.includes(L[k]+' each'),JSON.stringify(p)+' → '+tx);
    }
  }
});
t('the record basis reaches the product only on an authoritative line, and only the two known words',()=>{
  const mk=()=>[{code:'P1',base_price:100,uom:'Case',case_qty:2}];
  const rows=[{code:'P1',base_price:100,msrp_basis:'order_unit',map_basis:'each'}];
  let p=mk(); reconcile(p,rows,true); eq([p[0].msrp_basis,p[0].map_basis],['order_unit','each']);
  p=mk(); reconcile(p,rows,false); eq([p[0].msrp_basis,p[0].map_basis],[undefined,undefined],'not authoritative: untouched');
  p=mk(); reconcile(p,[{code:'P1',base_price:100,msrp_basis:'case',map_basis:'EACH'}],true); eq([p[0].msrp_basis,p[0].map_basis],[undefined,undefined],'unknown words ignored');
  p=[{code:'P1',base_price:100,uom:'Case',case_qty:2,msrp_each:true}]; reconcile(p,[{code:'P1',base_price:100}],true);
  eq([p[0].msrp_basis,p[0].msrp_each],[undefined,true],'a record with no basis leaves the catalog row rule in place');
});
t('catalog-feed reads and sends the basis; the server copy (_pricing.feedRows) is identical',()=>{
  const src=fs.readFileSync(FEED,'utf8');
  ok(/&select=code,option_label,base_price,msrp,msrp_auto,map,tiers,price_note,uom,hcpcs,case_qty,msrp_basis,map_basis`/.test(src),'feed select must read msrp_basis,map_basis');
  const shopFeed=require(FEED).feedRows, srvFeed=require(path.join(ROOT,'_pricing.js')).feedRows;
  const rows=[{code:'B',base_price:10,case_qty:2,msrp_basis:'each',map_basis:'order_unit'},{code:'A',base_price:5,msrp_basis:'bogus',map_basis:'per_case'},{code:'C',base_price:7}];
  const a=shopFeed(rows), b=srvFeed(rows);
  eq(a,b,'shop feed = server copy');
  eq(a.map(r=>[r.code,r.msrp_basis,r.map_basis]),[['A',undefined,undefined],['B','each','order_unit'],['C',undefined,undefined]]);
});

console.log(`msrp/map basis: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);

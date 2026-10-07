/* 2.3 — Product Catalog sends only changed fields. Executes the REAL editProduct, draftChanges
   and saveProduct lifted from catalog.html, captures the request they send, then replays that
   request through the REAL catalog-api handler and checks what lands on the override. */
const fs=require('fs');
const UI=process.env.UI||require('path').join(__dirname,'..','src','admin','catalog.html');
const html=fs.readFileSync(UI,'utf8');
function grab(name){ const i=html.indexOf(name); if(i<0) throw new Error('anchor '+name);
  let j=html.indexOf('{',i), d=0; for(;j<html.length;j++){ if(html[j]==='{')d++; else if(html[j]==='}'){d--; if(!d) break;} } return html.slice(i,j+1); }
const src=['function editProduct(code){','function draftChanges(orig, draft, tiers){','async function saveProduct(){'].map(a=>{ try{ return grab(a);}catch(e){ return ''; } }).join('\n');
function ui(product){
  const sent=[];
  const env={ effProducts:()=>[product], render(){}, toast(m){ env.lastToast=m; }, confirm:()=>true,
    normSku:c=>String(c).toUpperCase(), offerMergeInstead(){}, loadMfr:async()=>{}, localApply(){}, localOverride(){}, touched(){},
    api:async(q,o)=>{ sent.push(JSON.parse(o.body)); return {}; },
    apiRaw:async(q,o)=>{ sent.push(JSON.parse(o.body)); return {ok:true,status:200,body:{ok:true}}; },
    tiersOf:p=>(p.tiers||[]).map(t=>({min_qty:t.min_qty,price:t.price})), SLUG:'ovation-medical', DETAIL:{custom:[]} };
  const f=new Function(...Object.keys(env),'let PDRAFT=null;\n'+src+'\nreturn {editProduct,saveProduct,get:()=>PDRAFT,set:(k,v)=>{PDRAFT[k]=v;},draftChanges:typeof draftChanges==="function"?draftChanges:null};');
  return Object.assign(f(...Object.values(env)),{sent,env});
}
let fail=0; const ok=(c,m)=>{ console.log((c?'ok  ':'FAIL')+' '+m); if(!c) fail++; };
(async()=>{
  const prod={kind:'catalog',code:'2001',name:'Brace – Large',category:'Back',subcategory:'Back Braces',group:'brace',base_price:100,msrp:200,map:null,image:'x.jpg',description:'d',price_note:'',active:true,tiers:[{min_qty:2,price:90}]};
  // price-only edit
  let U=ui(prod); U.editProduct('2001'); U.set('base_price','110'); await U.saveProduct();
  const req=U.sent.find(b=>b.action==='save_override');
  ok(req && JSON.stringify(Object.keys(req.patch))==='["base_price"]','a price edit sends only base_price ('+(req&&Object.keys(req.patch))+')');
  // name edit sends name only
  U=ui(prod); U.editProduct('2001'); U.set('name','Brace – L'); await U.saveProduct();
  const r2=U.sent.find(b=>b.action==='save_override'); ok(r2 && JSON.stringify(Object.keys(r2.patch))==='["name"]','a rename sends only name');
  // nothing changed sends nothing
  U=ui(prod); U.editProduct('2001'); await U.saveProduct(); ok(U.sent.length===0 && /No changes/.test(U.env.lastToast||''),'no change, no request');
  // tier edit
  U=ui(prod); U.editProduct('2001'); U.set('tiers',[{min_qty:2,price:85}]); await U.saveProduct();
  const r3=U.sent.find(b=>b.action==='save_override'); ok(r3 && JSON.stringify(Object.keys(r3.patch))==='["tiers"]','a ladder edit sends only tiers');
  // added product: full row, but changed list names only the price
  const added=Object.assign({},prod,{kind:'custom',code:'3001'});
  U=ui(added); U.editProduct('3001'); U.set('base_price','21'); await U.saveProduct();
  const r4=U.sent.find(b=>b.action==='save_product'); ok(r4 && JSON.stringify(r4.changed)==='["base_price"]' && !('_orig' in r4.product),'added product names only the changed field');
  ok(!U.sent.some(b=>b.action==='save_override'),'added product: no group override when group unchanged');
  U=ui(added); U.editProduct('3001'); await U.saveProduct(); ok(U.sent.length===0,'added product, nothing changed: no request');

  // replay the price-only request through the real handler on a migrated line
  const M=require(require('path').join(__dirname,'phase0-mock.js'));
  const OB='https://ordering.test';
  const W=M.createWorld({tables:{product_overrides:[],custom_products:[],manufacturer_meta:[],
    product_skus:[{manufacturer:'ovation-medical',code:'2001',code_norm:'2001',base_price:100,msrp:200,msrp_auto:true,tiers:[{min_qty:2,price:90}],status:'active'}]}});
  const inner=W.fetch; W.fetch=async(u,o)=>String(u).startsWith(OB)?{ok:true,status:200,json:async()=>[{code:'2001',base_price:100,name:'Brace – Large',category:'Back'}],text:async()=>''}:inner(u,o);
  const C=M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},process.env.CAT_ROOT||require('path').join(__dirname,'..','netlify','functions'));
  const res=await M.call(C,req,{headers:{'x-analytics-token':'pass'}});
  const pa=(W.db.product_overrides[0]||{}).patch||{};
  ok(res.status===200,'handler accepted it');
  ok(!('name' in pa) && !('category' in pa) && !('description' in pa) && !('subcategory' in pa),'override pins no name/category/description — enrichment rename and Structure Map move still flow');
  ok(pa.base_price===110 && W.db.product_skus[0].base_price===110,'price reached the record and the projection');
  // shop rule: _nameFromOverride / _catFromOverride are set only by a non-empty name/category
  ok(!(pa.name!=null && pa.name!=='') && !(pa.category!=null && pa.category!==''),'shop would not pin name or category');
  console.log(fail?`\n${fail} FAILED`:'\nALL PASS'); process.exit(fail?1:0);
})();

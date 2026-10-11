/* Release B — the Advanced Product Editor (src/admin/product-content-review.html) has NO commercial write path:
     · its commercial rule is exactly catalog-api's (_mc.js COMMERCIAL_ACTIONS / OVERRIDE_COMMERCIAL_KEYS);
     · catalogPost() refuses every commercial request without sending anything, and still sends the rest;
     · publishToCatalog() never creates a catalog SKU: a SKU already on the record is used, a new one is listed for
       Manufacturer Center → Sources;
     · Price Check is now a read-only commercial summary with the link to Manufacturer Center; no price input, no
       price import, no bulk price, no auto-MSRP, no "price" box on New product. */
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const MC=require(path.join(ROOT,'_mc.js'));
const HTML=fs.readFileSync(process.env.EDITOR_HTML||path.join(__dirname,'..','src','admin','product-content-review.html'),'utf8');
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const grab=(re,w)=>{ const m=re.exec(HTML); if(!m) throw new Error('not found: '+w); return m[0]; };
function sandbox(fetchImpl, catalog){
  const src=[grab(/const MC_COMMERCIAL_ACTIONS=\[[^\]]*\];/,'actions'), grab(/const MC_OVERRIDE_COMMERCIAL_KEYS=\[[^\]]*\];/,'keys'),
    grab(/function isCommercialBody\(b\)\{[\s\S]*?\n\}/,'isCommercialBody'), grab(/async function catalogPost\(body\)\{[\s\S]*?\n\}/,'catalogPost'),
    grab(/async function publishToCatalog\(prod, collisions\)\{[\s\S]*?\n\}/,'publishToCatalog')].join('\n');
  const ctx={ fetch:fetchImpl, authHeaders:()=>({}), MFR:'pedifix', masterStale:()=>{}, _newSkusForMc:[], catalogGet:async()=>catalog||{products:[],custom:[]}, console };
  vm.createContext(ctx); vm.runInContext(src+';this.isCommercialBody=isCommercialBody;this.catalogPost=catalogPost;this.publishToCatalog=publishToCatalog;this.A=MC_COMMERCIAL_ACTIONS;this.K=MC_OVERRIDE_COMMERCIAL_KEYS;',ctx);
  return ctx;
}
(async()=>{
await t('the editor\'s commercial rule is exactly catalog-api\'s',async()=>{
  const S=sandbox(async()=>{ throw new Error('no fetch'); });
  eq([...S.A].sort(),[...MC.COMMERCIAL_ACTIONS].sort(),'actions'); eq([...S.K].sort(),[...MC.OVERRIDE_COMMERCIAL_KEYS].sort(),'override keys');
  const bodies=[{action:'save_override',patch:{base_price:1}},{action:'save_override',patch:{name:'x'}},{action:'save_override',patch:{},replace:true},{action:'reconcile',apply:true},
    {action:'reconcile'},{action:'bulk_price'},{action:'save_product'},{action:'set_category'},{action:'catalog_audit'},{action:'rename_code'},{action:'merge_products'}];
  eq(bodies.map(b=>S.isCommercialBody(b)),bodies.map(b=>MC.isCommercialAction(b)));
});
await t('catalogPost refuses every commercial request without sending it; the rest still go through',async()=>{
  const sent=[]; const S=sandbox(async(u,o)=>{ sent.push(JSON.parse(o.body)); return {ok:true,status:200,json:async()=>({ok:true})}; });
  for(const a of MC.COMMERCIAL_ACTIONS){ const r=await S.catalogPost({action:a,manufacturer:'pedifix'}); eq([r.ok,r.status,r.json.error],[false,409,'commercial_in_mc'],a); }
  for(const k of MC.OVERRIDE_COMMERCIAL_KEYS){ const r=await S.catalogPost({action:'save_override',manufacturer:'pedifix',code:'P1',patch:{[k]:1}}); eq(r.json.error,'commercial_in_mc',k); }
  eq(sent.length,0,'nothing commercial was sent');
  const r=await S.catalogPost({action:'set_category',manufacturer:'pedifix',codes:['P1'],category:'Foot Care'}); eq(r.ok,true); eq(sent.length,1);
  ok(/Manufacturer Center/.test((await S.catalogPost({action:'bulk_price'})).json.message),'the refusal says where prices are set');
});
await t('publishToCatalog never creates a catalog SKU: an existing one is used, a new one is listed for Manufacturer Center',async()=>{
  const sent=[]; const S=sandbox(async(u,o)=>{ sent.push(o&&o.body); return {ok:true,status:200,json:async()=>({ok:true})}; },{products:[{code:'P1'}],custom:[{code:'P2'}]});
  eq(await S.publishToCatalog({code:'P1',base_price:9},[]),{ok:false,duplicate:true});
  eq((await S.publishToCatalog({code:'p2'},[])).duplicate,true,'case-blind');
  const r=await S.publishToCatalog({code:'NEW-1',base_price:9},[]); eq([r.ok,r.duplicate,r.commercial],[false,false,true]);
  eq(S._newSkusForMc,['NEW-1']); eq(sent.length,0,'no request sent');
});
await t('Price Check is a read-only commercial summary: no price inputs, imports, bulk or auto-MSRP; the link to Manufacturer Center is there',async()=>{
  const fn=grab(/function renderPriceAudit\(\)\{[\s\S]*?\n\}/,'renderPriceAudit');
  ok(!/<input|<select|<textarea|contenteditable/i.test(fn),'no input in the summary');
  ok(/Open Commercial &amp; Pricing in Manufacturer Center/.test(fn),'the link');
  for(const gone of ['doPriceSaveRow','doPriceBulkApply','doPriceImportApply','openPriceImport','doAutoMsrpAll','doReconcileGroup','paFixSku','np-skuprice','data-act="price-save"','price-import-apply'])
    ok(HTML.indexOf(gone)<0,'still present: '+gone);
  ok(/manufacturer-center\.html#line='\+encodeURIComponent\(MFR\)\+'&tab=commercial'/.test(HTML),'deep link to Commercial & freight');
});
await t('the page is the Advanced Product Editor, says it is for unusual cases, and points everyday enrichment to Manufacturer Center',async()=>{
  ok(/<title>HCPS Admin — Advanced Product Editor<\/title>/.test(HTML)); ok(/<h1>Advanced Product Editor<\/h1>/.test(HTML));
  ok(/For unusual cases\./.test(HTML) && /Continue Product Enrichment/.test(HTML),'banner');
});
console.log(`mc advanced editor — no commercial write path: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

/* ONE ANSWER TO "WHAT CATEGORY IS THIS?" — the Structure Map runs the shared resolver.
   1. Drift: the resolver block in product-content-review.html is the _catalog-join.js one.
   2. Behaviour: every page row on the Structure Map lands where the server's per-SKU
      `derived` category (catalog-api GET, the shop's rule) puts its SKUs — pinned, mapped,
      draft, disabled, added rows, unknown SKUs, split pages.
   3. The reads the map is built from fail loudly (503), never as an empty catalog/map. */
const fs=require('fs'), path=require('path'), vm=require('vm');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const HTML=process.env.PCR_HTML||path.join(__dirname,'..','src','admin','product-content-review.html');
const JOIN=require(path.join(ROOT,'_catalog-join.js'));
const OB='https://ordering.test';
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };

const html=fs.readFileSync(HTML,'utf8');
const block=(()=>{ const a=html.indexOf('// <shared:resolveCategory>'), b=html.indexOf('// </shared:resolveCategory>');
  if(a<0||b<0) throw new Error('shared resolver block missing from product-content-review.html'); return html.slice(a,b); })();
const ctx={}; vm.createContext(ctx);
vm.runInContext(block+'\n;this.R=SMJ_resolveCategory;this.P=smPageCategory;this.V=SMJ_isVisible;this.VS=SMJ_VISIBLE_STATUSES;',ctx);

// Strip comments/whitespace, and the one alias line the copy needs to see the same helper names.
const bodyOf=src=>{ src=String(src); const i=src.indexOf('{'); return src.slice(i)
  .replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'')
  .replace(/const str = SMJ_str, isVisible = SMJ_isVisible;/,'').replace(/\s+/g,''); };

function world({files, tables, failRead}){
  const W=M.createWorld({tables:Object.assign({manufacturer_meta:[], product_overrides:[], custom_products:[], product_skus:[], product_content:[],
    product_links:[], product_media:[], featured_products:[]}, tables||{}), failRead});
  const inner=W.fetch;
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(OB+'/data/')){ const slug=decodeURIComponent(u.slice((OB+'/data/').length).replace(/\.json.*$/,''));
      if(files && files.__fail===slug) return {ok:false,status:502,text:async()=>'bad gateway',json:async()=>{throw new Error('x');}};
      if(!(slug in (files||{}))) return {ok:false,status:404,text:async()=>'',json:async()=>null};
      return {ok:true,status:200,text:async()=>JSON.stringify(files[slug]),json:async()=>JSON.parse(JSON.stringify(files[slug]))}; }
    return inner(url,opts); };
  return W;
}
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const get=(C,qs)=>C.handler({httpMethod:'GET',headers:{'x-analytics-token':'pass'},queryStringParameters:qs||{},body:null})
  .then(r=>({status:r.statusCode,body:JSON.parse(r.body||'{}')}));

const LINE='climbing-steps';
const MAP={'Shower Chairs':'Bath Safety','Stairlifts':'Home Access'};
const FILE={[LINE]:[
  {code:'MP-P08',name:'Sidekick',category:'Bathroom',base_price:10},
  {code:'MP-P09',name:'Other',category:'Bathroom',base_price:10},
  {code:'MS-P02-GEN',name:'Genesis',category:'Mobility',base_price:10},
  {code:'DRAFT-1',name:'Draft',category:'Bathroom',base_price:10},
  {code:'OFF-1',name:'Off',category:'Bathroom',base_price:10},
  {code:'SPLIT-A',name:'A',category:'Bathroom',base_price:10},
  {code:'SPLIT-B',name:'B',category:'Bathroom',base_price:10},
]};
const PAGES=[
  {manufacturer:LINE,page_key:'sidekick',name:'Sidekick',status:'published',subcategory:'Shower Chairs',category:'Bathroom',skus:[{sku:'MP-P08'},{sku:'MP-P09'}]},
  {manufacturer:LINE,page_key:'genesis',name:'Genesis',status:'discontinued',subcategory:'Stairlifts',category:'Mobility',skus:[{sku:'MS-P02-GEN'}]},
  {manufacturer:LINE,page_key:'draft',name:'Draft',status:'draft',subcategory:'Shower Chairs',category:'Bathroom',skus:[{sku:'DRAFT-1'}]},
  {manufacturer:LINE,page_key:'off',name:'Off',status:'published',disabled:true,subcategory:'Shower Chairs',category:'Bathroom',skus:[{sku:'OFF-1'}]},
  {manufacturer:LINE,page_key:'split',name:'Split',status:'published',subcategory:'Shower Chairs',category:'Bathroom',skus:[{sku:'SPLIT-A'},{sku:'SPLIT-B'}]},
  {manufacturer:LINE,page_key:'added',name:'Added',status:'published',subcategory:'Grab Bars',category:'Bathroom',skus:[{sku:'ADD-1'}]},
  {manufacturer:LINE,page_key:'ghost',name:'Ghost',status:'published',subcategory:'Ghost Sub',category:'Bathroom',skus:[{sku:'NOPE-9'}]},
];
const TABLES=()=>({
  manufacturer_meta:[{slug:LINE,category_map:MAP,category_order:null,enriched_only:false}],
  product_content:JSON.parse(JSON.stringify(PAGES)),
  custom_products:[{manufacturer:LINE,code:'ADD-1',name:'Added',category:'Grab Bars & Rails',base_price:5,active:true}],
  product_overrides:[{manufacturer:LINE,code:'SPLIT-B',patch:{category:'Pinned Heading'}}],
});

(async()=>{
await t('the Structure Map resolver is the shared one, byte for byte (comments aside)',async()=>{
  eq(bodyOf(ctx.R),bodyOf(JOIN.resolveCategory),'resolveCategory drifted');
  eq(Array.from(ctx.VS),JOIN.VISIBLE_STATUSES,'visible statuses drifted');
  for(const pg of [null,{status:'published'},{status:'active'},{status:'discontinued'},{status:'draft'},{status:'approved'},{status:'published',disabled:true}])
    eq(ctx.V(pg),JOIN.isVisible(pg),'isVisible '+JSON.stringify(pg));
});

await t('every page row lands where the server files its SKUs (pinned, mapped, draft, disabled, added, split)',async()=>{
  const W=world({files:FILE,tables:TABLES()}); const C=mod(W);
  const r=await get(C,{manufacturer:LINE}); eq(r.status,200,'GET '+JSON.stringify(r.body).slice(0,200));
  const derived=r.body.derived;
  // Build exactly what openStructureMap builds.
  const catalog={}, pinned={};
  r.body.products.forEach(x=>{ catalog[String(x.code)]={category:x.category||'',kind:'catalog'}; });
  r.body.custom.forEach(x=>{ catalog[String(x.code)]={category:x.category||'',kind:'custom'}; });
  Object.keys(r.body.overrides).forEach(c=>{ const v=r.body.overrides[c].category; if(v!=null&&v!=='') pinned[c]=v; });
  for(const pg of PAGES){
    const out=ctx.P(pg,pg.skus.map(s=>s.sku),catalog,pinned,MAP);
    const server=[...new Set(pg.skus.map(s=>derived[s.sku]).filter(Boolean).map(d=>d.category))];
    if(server.length) eq(out.categories.slice().sort(),server.slice().sort(),'page '+pg.page_key);
  }
  const P=k=>ctx.P(PAGES.find(p=>p.page_key===k),PAGES.find(p=>p.page_key===k).skus.map(s=>s.sku),catalog,pinned,MAP);
  eq(P('sidekick').category,'Bath Safety','published page: the map files it');
  eq(P('genesis').category,'Home Access','discontinued page is visible: the map files it');
  eq([P('draft').category,P('draft').onPublish],['Bathroom','Bath Safety'],'draft page keeps its catalog category; the map is only a preview');
  eq([P('off').category,P('off').onPublish],['Bathroom','Bath Safety'],'switched-off page is not visible');
  eq([P('split').split,P('split').categories],[true,['Bath Safety','Pinned Heading']],'a pin on one SKU splits the page, it does not drag the other SKU');
  eq(P('added').category,'Grab Bars & Rails','an added row files by its own category (no map entry)');
  eq(P('ghost').category,'Bathroom','a page whose SKU the catalog never heard of falls back to the page');
});

await t('smRows itself files each page by the shared resolver (draft keeps its catalog category; pin splits)',async()=>{
  const fnSrc=html.slice(html.indexOf('function smRows(){'),html.indexOf('function smTree('));
  const c2={}; vm.createContext(c2);
  vm.runInContext(block+`
    var SM_NONE='(none)'; var PUBLIC_SET=new Set(['published','active','discontinued']);
    var pages={}; var SM={};
    function structureFlags(){ return []; }
    function skusOf(k){ return (pages[k].skus||[]).map(s=>({sku:String(s.sku)})); }
  `+fnSrc+';this.smRows=smRows;this.setup=(p,sm)=>{pages=p;SM=sm;};',c2);
  const pg={}; PAGES.forEach(p=>{ pg[p.page_key]=p; });
  const catalog={}; FILE[LINE].forEach(x=>{ catalog[x.code]={category:x.category,kind:'catalog'}; }); catalog['ADD-1']={category:'Grab Bars & Rails',kind:'custom'};
  c2.setup(pg,{map:MAP,pinned:{'SPLIT-B':'Pinned Heading'},catalog});
  const rows=Object.fromEntries(c2.smRows().map(r=>[r.k,r]));
  eq([rows.sidekick.cat,rows.genesis.cat,rows.draft.cat,rows.draft.onPublish,rows.off.cat,rows.added.cat],
     ['Bath Safety','Home Access','Bathroom','Bath Safety','Bathroom','Grab Bars & Rails'],'rows');
  eq([rows.split.split,rows.split.pinned],[true,true],'split page flagged');
});
await t('the old page-level rule would have disagreed (so this test can fail)',async()=>{
  // Old smRows: any pin on the page wins for the whole page; map applied to drafts too.
  const old=(pg,pinnedAny)=>pinnedAny || (pg.subcategory && MAP[pg.subcategory]) || pg.category;
  ok(old(PAGES[2],null)!==ctx.P(PAGES[2],['DRAFT-1'],{'DRAFT-1':{category:'Bathroom',kind:'catalog'}},{},MAP).category,'draft');
});

await t('an unreadable catalog file is a 503, never an empty catalog',async()=>{
  const W=world({files:Object.assign({__fail:LINE},FILE),tables:TABLES()}); const C=mod(W);
  const r=await get(C,{manufacturer:LINE}); eq([r.status,r.body.error],[503,'layer_unreadable'],'status');
});
await t('a line with no deployed file yet (404) is still an empty catalog, not an error',async()=>{
  const W=world({files:{},tables:TABLES()}); const C=mod(W);
  const r=await get(C,{manufacturer:LINE}); eq(r.status,200,'status'); eq(r.body.products,[],'empty');
});
for(const tbl of ['product_overrides','custom_products','product_content','manufacturer_meta','featured_products','product_media','product_links']){
  await t('an unreadable '+tbl+' is a 503 on the line read',async()=>{
    const W=world({files:FILE,tables:TABLES(),failRead:(table)=>table===tbl?500:0}); const C=mod(W);
    const r=await get(C,{manufacturer:LINE}); ok(r.status>=500,'status '+r.status+' '+JSON.stringify(r.body).slice(0,120));
  });
}
await t('an unreadable manufacturer_meta is a 503 on the line list (no map ≠ unread map)',async()=>{
  const W=world({files:Object.assign({manufacturers:[{slug:LINE,name:'CS',hasData:true}]},FILE),tables:TABLES(),failRead:(table)=>table==='manufacturer_meta'?500:0}); const C=mod(W);
  const r=await get(C,{}); eq([r.status,r.body.error],[503,'layer_unreadable'],'status');
});
await t('the page refuses to draw the map from a failed read',async()=>{
  const fn=html.slice(html.indexOf('async function openStructureMap(){'),html.indexOf('/* ── THE ORDER DEALERS SEE'));
  ok(!/\.catch\(\(\)=>\(\{\}\)\)/.test(fn),'lenient .catch(()=>({})) is back');
  ok(/Could not read the catalog/.test(fn) && /return;/.test(fn),'no loud failure path');
  ok(/smPageCategory\(/.test(html.slice(html.indexOf('function smRows(){'),html.indexOf('function smTree('))),'smRows does not use the shared resolver');
});

console.log(`structure resolver: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

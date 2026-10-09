/* 2.4 — one image authority. Runs the REAL images-api, product-content and featured-api
   handlers against the repo's in-memory PostgREST fake (+ fake storage and catalog file). */
const M=require(process.env.MOCK||require('path').join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||require('path').join(__dirname,'..','netlify','functions');
const OB='https://ordering.test';
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const L='ovation-medical';
function world(tables, files, failOn){
  const W=M.createWorld({tables:Object.assign({product_overrides:[],custom_products:[],product_content:[],product_images:[],product_content_history:[],featured_products:[],staff_users:[]},tables||{})});
  const inner=W.fetch; W.stored=[];
  W.fetch=async(u,o)=>{ u=String(u); const m=((o&&o.method)||'GET').toUpperCase();
    for(const f of (failOn||[])) if(f.method===m && u.includes(f.match)) return {ok:false,status:500,text:async()=>'boom',json:async()=>({})};
    if(u.startsWith(OB+'/data/')){ const s=decodeURIComponent(u.slice((OB+'/data/').length).replace(/\.json.*$/,'')); const F=files||{};
      if(!(s in F)) return {ok:false,status:404,text:async()=>'',json:async()=>null}; return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(F[s])),text:async()=>JSON.stringify(F[s])}; }
    if(u.includes('/storage/v1/object/')){ W.stored.push(u); return {ok:true,status:200,text:async()=>'{}',json:async()=>({})}; }
    return inner(u,o); };
  return W;
}
const load=(W,f)=>M.load(f,W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const call=(m,b,o)=>M.call(m,b,Object.assign({headers:{'x-analytics-token':'pass'}},o||{}));
const pg=(k,skus,extra)=>Object.assign({manufacturer:L,page_key:k,name:k,status:'published',image:null,images_gallery:[],skus:skus.map(s=>typeof s==='string'?{sku:s}:s)},extra||{});
const files={[L]:[{code:'A1',name:'A one',image:'/assets/a1.jpg'},{code:'B1'},{code:'B2'},{code:'C1',image:'/assets/c1.jpg'}]};
const img=(u,p)=>({url:u,primary:!!p});

(async()=>{
await t('pure: a gallery always ends with exactly one primary, and the image follows it',async()=>{
  const P=require(ROOT+'/images-api.js')._pure;
  eq(P.normalizeGallery([img('a'),img('b')],'b').gallery.map(x=>x.primary),[false,true],'matches image');
  eq(P.normalizeGallery([img('a'),img('b')],null).image,'a','first when nothing matches');
  eq(P.normalizeGallery([img('a',1),img('b',1)],null).gallery.filter(x=>x.primary).length,1,'extra primaries demoted');
  eq(P.normalizeGallery([], 'x').image,'x','no gallery keeps the image');
  const pi=P.normalizeGallery([img('a'),img('b')],'p');
  eq([pi.image,pi.gallery.map(x=>[x.url,x.primary])],['p',[['p',true],['a',false],['b',false]]],'a page image outside the gallery becomes its primary (what dealers were shown)');
});
await t('pure: SKU photo → page primary → catalog override → added → file',async()=>{
  const P=require(ROOT+'/images-api.js')._pure;
  const page=pg('p',[{sku:'A1',image:'sku.jpg'},'A2'],{images_gallery:[img('g1'),img('g2',1)],image:'old.jpg'});
  eq(P.resolveImage({code:'A1',page}).source,'sku','sku first');
  eq(P.resolveImage({code:'A2',page}).url,'g2','page primary, not the stale image');
  eq(P.resolveImage({code:'A2',page:pg('q',['A2'],{images_gallery:[img('g1'),img('g2')],image:'g2'})}).url,'g2','no-primary gallery honours the page image');
  eq(P.resolveImage({code:'Z',page:null,override:{image:'ov.jpg'},base:{image:'f.jpg'}}).source,'catalog-override','override over file');
  eq(P.resolveImage({code:'Z',page:null,custom:{image:'c.jpg'},base:{image:'f.jpg'}}).source,'catalog-added','added over file');
});
await t('upload to a single-SKU product sets the page primary (old primary kept) and logs history',async()=>{
  const W=world({product_content:[pg('a',['A1'],{images_gallery:[img('old.jpg',1)],image:'old.jpg'})]},files); const C=load(W,'images-api.js');
  const r=await call(C,{action:'upload',manufacturer:L,code:'A1',data:'aGk=',contentType:'image/png'});
  eq([r.status,r.body.wrote],[200,'page_primary'],'response');
  const p=W.db.product_content[0]; eq(p.image,r.body.url,'image is the new primary');
  eq(p.images_gallery.filter(x=>x.primary).map(x=>x.url),[r.body.url],'one primary');
  ok(p.images_gallery.some(x=>x.url==='old.jpg'&&!x.primary),'old photo kept, demoted');
  eq(W.db.product_images.length,0,'legacy table not written');
  eq(W.db.product_content_history.length,1,'history logged');
});
await t('upload on a multi-SKU product asks whole product vs this SKU, and "this SKU" writes only that SKU',async()=>{
  const W=world({product_content:[pg('b',['B1','B2'],{images_gallery:[img('pg.jpg',1)],image:'pg.jpg'})]},files); const C=load(W,'images-api.js');
  const r1=await call(C,{action:'upload',manufacturer:L,code:'B1',data:'aGk='});
  eq([r1.status,r1.body.error],[409,'scope_required'],'asks'); eq(W.stored.length,0,'nothing stored before the choice');
  const r2=await call(C,{action:'upload',manufacturer:L,code:'B1',scope:'sku',data:'aGk='});
  eq(r2.body.wrote,'sku','sku');
  const p=W.db.product_content[0]; eq(p.image,'pg.jpg','product photo unchanged');
  eq(p.skus.find(s=>s.sku==='B1').image,r2.body.url,'B1 has its own'); ok(!p.skus.find(s=>s.sku==='B2').image,'B2 untouched');
});
await t('a SKU with no product page keeps its photo on the catalog override, merged with what is there',async()=>{
  const W=world({product_overrides:[{manufacturer:L,code:'C1',patch:{base_price:10,name:'Kept'}}]},files); const C=load(W,'images-api.js');
  const r=await call(C,{action:'upload',manufacturer:L,code:'C1',data:'aGk='});
  eq(r.body.wrote,'catalog_override','where'); const pa=W.db.product_overrides[0].patch;
  eq([pa.image,pa.base_price,pa.name],[r.body.url,10,'Kept'],'merged');
});
await t('removing a product page photo is refused here (Enrichment manages the gallery)',async()=>{
  const W=world({product_content:[pg('a',['A1'],{images_gallery:[img('g.jpg',1)],image:'g.jpg'})]},files); const C=load(W,'images-api.js');
  const r=await call(C,{action:'clear',manufacturer:L,code:'A1'}); eq([r.status,r.body.error],[409,'page_photo'],'refused');
  eq(W.db.product_content[0].image,'g.jpg','untouched');
});
await t('GET shows what dealers see, with its source',async()=>{
  const W=world({product_content:[pg('a',['A1'],{images_gallery:[img('g.jpg',1)],image:'g.jpg'})],product_images:[{manufacturer:L,code:'A1',url:'legacy.jpg'}]},files); const C=load(W,'images-api.js');
  const r=await M.call(C,null,{method:'GET',qs:{manufacturer:L},headers:{'x-analytics-token':'pass'}});
  const a=r.body.products.find(p=>p.code==='A1'), c=r.body.products.find(p=>p.code==='C1');
  eq([a.image,a.source,a.legacy],['g.jpg','page','legacy.jpg'],'A1'); eq([c.image,c.source],['/assets/c1.jpg','catalog-file'],'C1');
});
await t('GET matches part numbers exactly, as the storefront does: a switched-off lower-case row does not hide its upper-case twin',async()=>{
  const W=world({product_overrides:[{manufacturer:L,code:'a1',patch:{active:false}},{manufacturer:L,code:'c1',patch:{image:'/wrong.jpg'}}],
                 custom_products:[{manufacturer:L,code:'b9',name:'old',active:false},{manufacturer:L,code:'B9',name:'Added',active:true,image:'/b9.jpg'},{manufacturer:L,code:'b1',name:'lower-case added',active:true}]},files);
  const C=load(W,'images-api.js');
  const r=await M.call(C,null,{method:'GET',qs:{manufacturer:L},headers:{'x-analytics-token':'pass'}});
  const by=Object.fromEntries(r.body.products.map(p=>[p.code,p]));
  ok(by.A1,'A1 listed'); eq(by.C1.image,'/assets/c1.jpg','c1 override does not apply to C1'); eq(by.B9&&by.B9.image,'/b9.jpg','added B9 listed with its photo'); ok(by.b1&&by.B1,'an added "b1" is its own product beside the file\'s "B1", as in the shop');
});
await t('migration dry run writes nothing and classifies every legacy row',async()=>{
  const T={product_content:[pg('a',['A1'],{images_gallery:[img('g.jpg',1)],image:'g.jpg'}),pg('b',['B1','B2'])],
    product_overrides:[{manufacturer:L,code:'C1',patch:{image:'ov.jpg'}}],
    product_images:[{manufacturer:L,code:'A1',url:'up-a1.jpg'},{manufacturer:L,code:'B1',url:'up-b1.jpg'},{manufacturer:L,code:'C1',url:'up-c1.jpg'},{manufacturer:L,code:'D9',url:'up-d9.jpg'}]};
  const W=world(T,files); const C=load(W,'images-api.js'); const before=JSON.stringify(W.db);
  const r=await call(C,{action:'migrate_legacy',manufacturer:L});
  eq(r.body.dry_run,true,'dry run'); eq(JSON.stringify(W.db),before,'nothing written');
  const by=Object.fromEntries(r.body.report[0].plan.map(p=>[p.code,p.class]));
  eq(by,{A1:'collision',B1:'page_has_no_image',C1:'shadowed',D9:'catalog_fallback'},'classes');
});
await t('migration apply never replaces an approved primary; moves only the safe rows; keeps the legacy table',async()=>{
  const T={product_content:[pg('a',['A1'],{images_gallery:[img('g.jpg',1)],image:'g.jpg'}),pg('b',['B1','B2'])],
    product_overrides:[{manufacturer:L,code:'C1',patch:{image:'ov.jpg'}}],
    product_images:[{manufacturer:L,code:'A1',url:'up-a1.jpg'},{manufacturer:L,code:'B1',url:'up-b1.jpg'},{manufacturer:L,code:'C1',url:'up-c1.jpg'},{manufacturer:L,code:'D9',url:'up-d9.jpg'}]};
  const W=world(T,files); const C=load(W,'images-api.js');
  const r=await call(C,{action:'migrate_legacy',manufacturer:L,apply:true});
  eq(W.db.product_overrides.find(o=>o.code==='C1').patch.image,'ov.jpg','shadowed: the photo dealers see is kept');
  eq(r.body.report[0].applied.map(x=>x.code+':'+x.action).sort(),['B1:set_primary','D9:set_override_image'],'applied');
  eq(W.db.product_content.find(p=>p.page_key==='a').image,'g.jpg','collision untouched');
  eq(W.db.product_content.find(p=>p.page_key==='b').image,'up-b1.jpg','empty page got its photo');
  eq(W.db.product_overrides.find(o=>o.code==='D9').patch.image,'up-d9.jpg','fallback moved');
  eq(W.db.product_images.length,4,'legacy rows kept');
  const r2=await call(C,{action:'migrate_legacy',manufacturer:L,apply:true,decisions:{A1:'gallery'}});
  const pa=W.db.product_content.find(p=>p.page_key==='a');
  eq([pa.image,pa.images_gallery.length],['g.jpg',2],'a decision adds, still not replacing the primary');
});
await t('an unreadable layer stops the migration',async()=>{
  const W=world({product_images:[{manufacturer:L,code:'D9',url:'u.jpg'}]},files,[{method:'GET',match:'/rest/v1/product_overrides'}]); const C=load(W,'images-api.js');
  const r=await call(C,{action:'migrate_legacy',manufacturer:L,apply:true}); eq(r.status,503,'status'); eq(W.db.product_overrides.length,0,'nothing written');
});
await t('Enrichment save: a gallery saved without a primary gets one, and the image follows',async()=>{
  const W=world({product_content:[pg('a',['A1'],{images_gallery:[img('g1.jpg',1)],image:'g1.jpg'})],staff_users:[{email:'angelo@hcps.us',role:'president',active:true}]},files);
  W.tokens['pres']='angelo@hcps.us';
  const C=load(W,'product-content.js');
  const r=await M.call(C,{action:'save_fields',manufacturer:L,page_key:'a',patch:{images_gallery:[img('g1.jpg'),img('new.jpg')]}},{token:'pres'});
  eq(r.status,200,'saved'); const p=W.db.product_content[0];
  eq(p.images_gallery.filter(x=>x.primary).map(x=>x.url),['g1.jpg'],'primary restored from the page image');
  const r2=await M.call(C,{action:'save_fields',manufacturer:L,page_key:'a',patch:{images_gallery:[img('new.jpg')]}},{token:'pres'});
  eq(W.db.product_content[0].image,'new.jpg','deleting the primary moves the image to the remaining photo');
  W.db.product_content[0].image='/legacy-page.jpg'; W.db.product_content[0].images_gallery=[img('x.jpg')];
  await M.call(C,{action:'save_fields',manufacturer:L,page_key:'a',patch:{images_gallery:[img('x.jpg'),img('y.jpg')]}},{token:'pres'});
  eq([W.db.product_content[0].image,W.db.product_content[0].images_gallery.map(g=>[g.url,g.primary])],['/legacy-page.jpg',[['/legacy-page.jpg',true],['x.jpg',false],['y.jpg',false]]],'a page image that was never in the gallery is kept as its primary');
});
await t('Featured Products shows the same photo dealers see (page primary, not the legacy upload)',async()=>{
  const W=world({product_content:[pg('a',['A1'],{images_gallery:[img('g.jpg',1)],image:'g.jpg'})],product_images:[{manufacturer:L,code:'A1',url:'legacy.jpg'}]},files);
  const C=load(W,'featured-api.js');
  const r=await M.call(C,null,{method:'GET',qs:{manufacturer:L},headers:{'x-analytics-token':'pass'}});
  eq(r.body.products.find(p=>p.code==='A1').image,'g.jpg','page photo');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

/* Manufacturer Center Release B — Product Enrichment end to end, in the Phase 6 sandbox (test/mcflow.world.js): the
   frozen Bemis-shaped line with its real catalog file, an open enrichment window, and manufacturer pages served from
   test/fixtures/mfr-pages (the live site's structure, test wording). Through the REAL product-content handler:
     · Products: the active SKUs become proposed pages (shape / colour variants share a page, the display asks for a
       grouping decision, the retired SKU is left out) — derived, not hard-coded; nothing is written;
     · Auto-Enrich: refused without the window; with it, every page becomes a HIDDEN draft with copy, features, specs and
       warranty from the source only, provenance per field, photos copied into the window's own folder (never
       overwriting), and nothing commercial or dealer-visible touched — product_skus, the catalog layer, media, links
       and line settings are byte-identical, and the line's full verification reads the same fingerprint;
     · Review Issues: the six statuses with evidence; resolutions need a reason, are recorded as content_resolution
       decisions (append-only, superseding), and close their issue; a held-back page stops blocking. */
const path=require('path'), fs=require('fs');
const {S,M,ROOT,FX,WIN,world,PC,call,withWin,bytes}=require('./mcenrich.world.js');
const E=require(path.join(ROOT,'_enrich.js'));
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,3).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const COMMERCIAL=['product_skus','product_overrides','custom_products','product_media','product_links','manufacturer_meta','mfr_sources','mfr_verification_runs'];
const snapC=W=>JSON.stringify(COMMERCIAL.map(k=>[k,W.db[k]||null]));
async function runAll(C,W){
  const plan=(await call(C,{action:'enrich_plan'})).body;
  for(const p of plan.pages){
    const r=await call(C,withWin({action:'enrich_page',page_key:p.page_key}));
    ok(r.status===200,p.page_key+': '+JSON.stringify(r.body).slice(0,300));
    for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:p.page_key})); ok(im.status===200,'images '+p.page_key+': '+JSON.stringify(im.body).slice(0,300)); if(!im.body.remaining) break; }
  }
  return (await call(C,{action:'enrich_plan'})).body;
}

(async()=>{
let W, C, verify, base, after;
await t('Products: 9 active SKUs become 7 proposed pages — shapes and colours share a page, the display asks, the retired SKU is left out; nothing written',async()=>{
  W=world(); C=PC(W); await call(C,{action:'enrich_plan'}); const before=JSON.stringify(W.db);   // (the sandbox fills code_norm on its first read)
  const r=await call(C,{action:'enrich_plan'}); eq(r.status,200,JSON.stringify(r.body).slice(0,300));
  const b=r.body;
  eq([b.active,b.pages.length,b.window&&b.window.id,b.frozen],[9,7,WIN,true]);
  eq(b.excluded.map(x=>x.code),['DO5300RD444']);
  const by=k=>b.pages.find(p=>p.skus.some(s=>s.code===k));
  eq(by('7YR05310TSS').skus.map(s=>s.code+':'+s.option),['7YR05310TSS:Round','7YE05310TSS:Elongated']);
  eq(by('7YA05313GRY').options,{Color:['Gray','Black']});
  eq([by('444DISPLAY').bundle,by('444DISPLAY').skus.length],[true,1]);
  ok(b.pages.every(p=>p.status==='not_enriched'),'nothing enriched yet');
  eq(JSON.stringify(W.db),before,'a plan writes nothing');
});
await t('page grouping is presentation only: the shared page creates no pricing family and changes no commercial field',async()=>{
  const p=E.planPages({records:W.db.product_skus.filter(r=>r.manufacturer===S.REAL),catalog:require(path.join(__dirname,'..','..','homecareproviderservicesordering','public','data','bemis.json')),custom:[],overrides:[],pages:[]});
  const seat=p.pages.find(x=>x.skus.length===2&&x.options.Shape);
  ok(!('tiers' in seat) && !('pool' in seat) && !('base_price' in seat.skus[0]) && !('msrp' in seat.skus[0]),'no commercial field on a proposed page');
});
await t('Auto-Enrich without the window is refused on the frozen line; nothing is written or fetched for writing',async()=>{
  const W2=world(), C2=PC(W2);
  const pk=(await call(C2,{action:'enrich_plan'})).body.pages[0].page_key; const before=JSON.stringify(W2.db);
  for(const a of ['enrich_page','enrich_images','enrich_resolve','enrich_set_image']){
    const r=await call(C2,{action:a,page_key:pk,issue:'needs_grouping',choice:'own_page',reason:'x'}); eq([r.status,r.body.error],[423,'line_frozen'],a+' '+JSON.stringify(r.body).slice(0,200)); }
  eq(JSON.stringify(W2.db),before); eq(W2.store.length,0);
});
await t('baseline verification of the frozen line (nothing saved)',async()=>{
  const CA=S.mod(W); verify=async()=>{ const r=await S.call(CA,{action:'mc_verify',manufacturer:S.REAL,phase:'release',save:false}); ok(r.status===200,JSON.stringify(r.body).slice(0,300)); return r.body; };
  base=await verify(); eq(base.result,'pass',JSON.stringify(base.failed));
});
let plan, snapBefore;
await t('Auto-Enrich with the window: every page drafted HIDDEN; nothing commercial, catalog-layer, media, links or line settings touched',async()=>{
  snapBefore=snapC(W);
  plan=await runAll(C,W);
  const rows=W.db.product_content.filter(r=>r.manufacturer===S.REAL);
  eq(rows.length,7,'one draft per proposed page');
  ok(rows.every(r=>['pending_review','approved','hidden','rejected'].indexOf(r.status)>=0 && !E.isVisibleRow(r)),'every draft hidden');
  eq(snapC(W),snapBefore,'commercial master, catalog layer, media, links and line settings unchanged');
  eq(plan.visible_drafts,0);
});
await t('ZERO dealer-facing change: the frozen line verifies the same — same result, same fingerprint, every check the same',async()=>{
  after=await verify();
  eq([after.result,after.fingerprint],[base.result,base.fingerprint]);
  eq(JSON.stringify(after.checks.map(c=>[c.id,c.pass])),JSON.stringify(base.checks.map(c=>[c.id,c.pass])));
  eq(W.db.mfr_verification_runs.length,0,'save:false saved no run');
});
await t('photos: every copy is filed under product-content/bemis/drafts/w50/<page>/ and never overwrites; drafts link only those copies',async()=>{
  ok(W.store.length>0,'photos were copied');
  ok(W.store.every(x=>x.path.startsWith('bemis/drafts/w'+WIN+'/') && x.upsert==='false'),JSON.stringify(W.store.slice(0,3)));
  const rows=W.db.product_content.filter(r=>r.manufacturer===S.REAL);
  const prefix=M.BASE+'/storage/v1/object/public/product-content/bemis/drafts/w'+WIN+'/';
  const MCm=require(path.join(ROOT,'_mc.js'));
  for(const r of rows) for(const u of MCm.rowMediaUrls(r)) ok(u.startsWith(prefix),r.page_key+' links '+u);
  ok(rows.every(r=>!r.image || (r.images_gallery||[]).some(g=>g.primary && g.url===r.image)),'the page photo is the gallery primary');
});
const page=k=>plan.pages.find(p=>p.skus.some(s=>s.code===k));
await t('source matching: a landing page is followed to the matching product page; a bundle page is never taken for an accessory',async()=>{
  const seat=page('7YR05310TSS').draft, arms=page('7YA05313GRY').draft, assist=page('7YA0AS100').draft, rise=page('7YA04505T').draft;
  eq(seat.sources.map(s=>s.role),['landing','product']); ok(/never-loosens-and-super-grip-bumpers-2/.test(seat.sources[1].url),seat.sources[1].url);
  eq(arms.sources.map(s=>s.role),['landing','related'],'the arms read the parts of the seat-with-arms page about the arms');
  ok(!arms.gallery.some(u=>/E85320TSSA/.test(u)),'no photo from the bundle page');
  eq(assist.sources.map(s=>s.role),['landing','product']);
  eq(rise.sources.map(s=>s.role),['product']);
});
await t('copy, features and specs come only from the source; warranty is blank when the source states none; provenance per field',async()=>{
  const rise=page('7YA04505T').draft;
  ok(/two independent locks/.test(rise.description),rise.description);
  eq(rise.features.length,5);
  const src=fs.readFileSync(path.join(FX,'rise.html'),'utf8');
  ok(rise.specs.length>=6 && rise.specs.every(s=>src.indexOf(s.value)>=0),'every spec value appears on the source page: '+JSON.stringify(rise.specs));
  ok(!rise.specs.some(s=>/^brand$/i.test(s.label)),'brand is not a spec');
  eq(plan.pages.map(p=>p.draft.warranty),plan.pages.map(()=>null),'no source states warranty terms — every warranty blank');
  ok(plan.pages.every(p=>/not stated/.test(p.draft.provenance.warranty||'')),'warranty provenance says "not stated"');
  ok(/manufacturer page — https:\/\/www\.toiletseats\.com\/p\/4-5-inch/.test(rise.provenance.description),rise.provenance.description);
  const steadfast=page('7YE82350TC').draft; ok(/HCPS catalog line only/.test(steadfast.provenance.description),steadfast.provenance.description);
});
await t('a website retail price never creates a commercial conflict; the retail model is an alias in provenance, not a dealer spec',async()=>{
  const rise=page('7YA04505T');
  ok(!rise.issues.some(i=>i.type==='conflict'),'no conflict from the $89.99 retail price: '+JSON.stringify(rise.issues));
  ok(!rise.draft.specs.some(s=>/model/i.test(s.label)),'no model-number spec: '+JSON.stringify(rise.draft.specs));
  ok(/Retail Model A84505T 000 — alias only; the HCPS SKU is the ordering code/.test(rise.draft.provenance.retail_model||''),rise.draft.provenance.retail_model);
  const row=W.db.product_content.find(r=>r.page_key===rise.page_key); eq(row.aliases,['A84505T 000']);
  ok(!JSON.stringify(row).includes('89.99'),'the retail price is nowhere on the draft');
});
await t('first-person manufacturer wording is made neutral without adding or dropping facts',async()=>{
  const d=page('7YA04505T').draft.description;
  ok(/Bemis’s patented Dual Lock keeps the seat from loosening\./.test(d) && !/\b[Oo]ur\b|EMPOWERING/.test(d) && /300 lbs/.test(d),d);
});
await t('a landing or bundle page is never a component\'s description: the arms keep the catalog line and need a product source',async()=>{
  const arms=page('7YA05313GRY');
  ok(!/attach to the seat in seconds|raised seat lifts/.test(arms.draft.description),'no bundle-page text: '+arms.draft.description);
  ok(/HCPS catalog line only/.test(arms.draft.provenance.description),arms.draft.provenance.description);
  eq(arms.status,'needs_content'); ok(arms.issues.some(i=>/No product-specific manufacturer source/.test(i.title)),JSON.stringify(arms.issues));
  eq(arms.draft.features,[],'no features borrowed from the bundle');
});
await t('photos: the main photo is a product photo (never landing promo art); resized copies of one photo collapse to the largest',async()=>{
  const seat=page('7YR05310TSS').draft, rise=page('7YA04505T').draft;
  ok(/E85320TSS-000/.test(seat.image),'seat main photo is a product photo: '+seat.image);
  ok(!seat.gallery.some(u=>/landing/.test(u)),'no landing promo art on a page with a product page');
  const ps=rise.gallery.filter(u=>/A84505T-000-P/.test(u)); eq(ps.length,1,'one copy of the P photo'); ok(/__Fill/.test(ps[0]),'the larger copy kept: '+ps[0]);
});
await t('Review Issues: each page gets one of the six statuses, from real evidence',async()=>{
  const st=k=>page(k).status;
  eq(st('7YR05310TSS'),'needs_image','Round and Elongated share one photo');
  ok(page('7YR05310TSS').issues.some(i=>i.type==='needs_image' && /7YR05310TSS and 7YE05310TSS/.test(i.title)),JSON.stringify(page('7YR05310TSS').issues));
  eq(st('7YA04505T'),'ready','a retail price on the manufacturer page is not a conflict');
  eq(st('7YE82350TC'),'needs_content','Steadfast has no manufacturer page');
  eq(st('444DISPLAY'),'needs_grouping');
  eq(st('7YA0AS100'),'ready'); eq(st('7YA05313GRY'),'needs_content','the arms have only a bundle page');
  eq(st('7YA06303TWA'),'needs_content','the bidet attachment: only a bundle page');
  eq(Object.entries(plan.counts).sort(),[['needs_content',3],['needs_grouping',1],['needs_image',1],['ready',2]]);
});
await t('resolutions: a reason is required; a dry run records nothing; recorded as content_resolution; the issue closes',async()=>{
  const pk=page('444DISPLAY').page_key; const nDec=W.db.mfr_decisions.length;
  let r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_grouping',choice:'own_page'})); eq([r.status,r.body.error],[400,'reason_required']);
  r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_grouping',choice:'nonsense',reason:'x'})); eq([r.status,r.body.error],[400,'bad_resolution']);
  r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_grouping',choice:'own_page',reason:'dealers browse displays',dry_run:true}));
  eq([r.status,r.body.would_record.kind,r.body.would_record.field],[200,'content_resolution','page:'+pk]); eq(W.db.mfr_decisions.length,nDec);
  r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_grouping',choice:'own_page',reason:'dealers browse displays'}));
  eq(r.status,200,JSON.stringify(r.body).slice(0,300)); eq(W.db.mfr_decisions.length,nDec+1);
  const d=W.db.mfr_decisions[W.db.mfr_decisions.length-1]; eq([d.kind,d.field,d.hcps_value.issue,d.hcps_value.choice,d.supersedes_id],['content_resolution','page:'+pk,'needs_grouping','own_page',null]);
  ok(!r.body.classify.issues.some(i=>i.type==='needs_grouping'),'grouping issue closed');
  eq(r.body.classify.status,'needs_content','next: the display has no source page');
});
await t('a later choice supersedes the earlier one (never rewrites it); holding a page back stops it blocking',async()=>{
  const pk=page('444DISPLAY').page_key;
  let r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_grouping',choice:'hidden_order_by_code',reason:'changed my mind'}));
  const ds=W.db.mfr_decisions.filter(d=>d.field==='page:'+pk); eq(ds.length,2); eq(ds[1].supersedes_id,ds[0].id); eq(ds[0].hcps_value.choice,'own_page','the first is kept as it was');
  r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_content',choice:'hold_back',reason:'no display page yet'}));
  eq([r.body.classify.status,r.body.classify.blocking],['held_back',false]);
});
await t('a manufacturer page you reject is not read again; choosing "same product" brings it back',async()=>{
  const pk=page('7YA04505T').page_key;
  let r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'conflict',choice:'different_product',reason:'not sure it is the same seat'}));
  eq(r.status,200);
  r=await call(C,withWin({action:'enrich_page',page_key:pk})); eq(r.status,200,JSON.stringify(r.body).slice(0,200));
  eq(r.body.sources.length,0,'the rejected page is not read again');
  r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'conflict',choice:'same_product',reason:'Bemis confirmed it is the same seat'}));
  r=await call(C,withWin({action:'enrich_page',page_key:pk})); eq(r.body.sources.map(s=>s.role),['product']);
  for(let i=0;i<5;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:pk})); if(!im.body.remaining) break; }
  const p=(await call(C,{action:'enrich_plan'})).body.pages.find(x=>x.page_key===pk); eq(p.status,'ready',JSON.stringify(p.issues));
});
await t('Needs image: uploading the Elongated photo under the window clears the shared-photo issue; a photo from elsewhere is refused',async()=>{
  const pk=page('7YR05310TSS').page_key;
  let r=await call(C,withWin({action:'enrich_set_image',page_key:pk,code:'7YE05310TSS',url:'https://www.toiletseats.com/assets/x.jpg'})); eq([r.status,r.body.error],[400,'not_a_draft_copy']);
  const up=await call(C,withWin({action:'upload_image',page_key:pk,filename:'elongated.jpg',content_type:'image/jpeg',content_base64:bytes('elong').toString('base64')}));
  eq(up.status,200); ok(up.body.url.indexOf('/product-content/bemis/drafts/w'+WIN+'/')>0,up.body.url);
  r=await call(C,withWin({action:'enrich_set_image',page_key:pk,code:'7YE05310TSS',url:up.body.url.replace('/drafts/w'+WIN+'/','/drafts/w'+(WIN+1)+'/')})); eq([r.status,r.body.error],[400,'not_a_draft_copy'],'another window\'s folder');
  r=await call(C,withWin({action:'enrich_set_image',page_key:pk,code:'7YE05310TSS',url:up.body.url}));
  eq(r.status,200,JSON.stringify(r.body).slice(0,300)); ok(!r.body.classify.issues.some(i=>i.type==='needs_image'),JSON.stringify(r.body.classify.issues));
});
await t('an official per-option photo chosen in Review Issues replaces the shared photo and survives a re-run',async()=>{
  const pk=page('7YR05310TSS').page_key;
  let r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_image',choice:'use_source_image',value:{code:'7YR05310TSS'},reason:'x'})); eq([r.status,r.body.error],[400,'bad_resolution'],'a photo address is required');
  for(const [code,f] of [['7YR05310TSS','R85320TSS-000-P.jpg'],['7YE05310TSS','E85320TSS-000-F.jpg']]){
    r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_image',choice:'use_source_image',value:{code,image_url:'https://www.toiletseats.com/assets/'+f,why:'Bemis product page for this shape'},reason:'Official Bemis photo for this shape'}));
    eq(r.status,200,JSON.stringify(r.body).slice(0,200)); }
  for(let k=0;k<2;k++){ r=await call(C,withWin({action:'enrich_page',page_key:pk})); eq(r.status,200); for(let i=0;i<6;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:pk})); if(!im.body.remaining) break; } }
  const p=(await call(C,{action:'enrich_plan'})).body.pages.find(x=>x.page_key===pk);
  ok(!p.issues.some(i=>i.type==='needs_image'),JSON.stringify(p.issues));
  const sk=p.draft.sku_images; ok(/R85320TSS-000-P/.test(sk.find(s=>s.code==='7YR05310TSS').image) && /E85320TSS-000-F/.test(sk.find(s=>s.code==='7YE05310TSS').image),JSON.stringify(sk));
});
await t('an official source added in Review Issues is read on the re-run (Steadfast)',async()=>{
  const pk=page('7YE82350TC').page_key; const url='https://www.toiletseats.com/p/elongated-open-front-plastic-elevated-toilet-seat-with-3-inch-lift-in-white-never-loosens/';
  let r=await call(C,withWin({action:'enrich_resolve',page_key:pk,issue:'needs_content',choice:'rerun_with_source',value:{source_url:url},reason:'Official Bemis Steadfast page'})); eq(r.status,200);
  r=await call(C,withWin({action:'enrich_page',page_key:pk})); eq(r.body.sources.map(s=>s.role),['product']);
  for(let i=0;i<6;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:pk})); if(!im.body.remaining) break; }
  const p=(await call(C,{action:'enrich_plan'})).body.pages.find(x=>x.page_key===pk);
  eq(p.status,'ready',JSON.stringify(p.issues)); ok(/E82350TC-000-P/.test(p.draft.image),p.draft.image);
  ok(/Retail Model E82350TC 000/.test(p.draft.provenance.retail_model),'alias recorded');
});
await t('re-running is stable: same page keys, the same draft updated (no duplicate), the window stamped on every draft',async()=>{
  const keys=(await call(C,{action:'enrich_plan'})).body.pages.map(p=>p.page_key).sort();
  const pk=page('7YA0AS100').page_key; await call(C,withWin({action:'enrich_page',page_key:pk}));
  eq((await call(C,{action:'enrich_plan'})).body.pages.map(p=>p.page_key).sort(),keys);
  eq(W.db.product_content.filter(r=>r.manufacturer===S.REAL && r.page_key===pk).length,1);
});
await t('after everything: still zero dealer-facing change, commercial data untouched, no run saved',async()=>{
  const v=await verify(); eq([v.result,v.fingerprint],[base.result,base.fingerprint]); eq(snapC(W),snapBefore);
  ok(W.db.product_content.filter(r=>r.manufacturer===S.REAL).every(r=>!E.isVisibleRow(r)),'every Bemis page still hidden');
});
await t('a photo that fails to copy is recorded, never linked (zero broken images)',async()=>{
  const W3=world({brokenImage:'A84505T-000-F',htmlImage:'A84505T-000-S'}), C3=PC(W3);
  const pl=await runAll(C3,W3); const rise=pl.pages.find(p=>p.skus.some(s=>s.code==='7YA04505T')).draft;
  eq(rise.images.failed.map(f=>f.error).sort(),['HTTP 404','not an image (text/html)']); ok(!rise.gallery.some(u=>/A84505T-000-[FS]/.test(u)),'the failed photos are not on the draft');
  ok(rise.gallery.length>=1,'the photo that copied is');
  /* a SKU already on a LIVE page is never drafted over — enrichment writes hidden drafts only */
  W3.db.product_content.push({id:'live1',manufacturer:'bemis',page_key:'assist-live',name:'Assist',status:'published',disabled:false,skus:[{sku:'7YA0AS100'}]});
  const pl2=(await call(C3,{action:'enrich_plan'})).body, pg=pl2.pages.find(p=>p.skus.some(s=>s.code==='7YA0AS100'));
  eq(pg.live_page,'assist-live'); const before=JSON.stringify(W3.db.product_content);
  const rr=await call(C3,withWin({action:'enrich_page',page_key:pg.page_key})); eq([rr.status,rr.body.error],[409,'live_page']); eq(JSON.stringify(W3.db.product_content),before);
});
console.log(`mc enrichment (Bemis sandbox): ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

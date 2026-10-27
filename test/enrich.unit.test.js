/* Release B — the Product Enrichment engine (netlify/functions/_enrich.js), pure: page proposals, page reading,
   source-only facts, photos, statuses and resolutions, on small hand-made inputs. */
const path=require('path');
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const E=require(path.join(ROOT,'_enrich.js'));
let fail=0, pass=0;
function t(n,f){ try{ f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const rec=(code,extra)=>Object.assign({code,status:'active',base_price:10,msrp:20},extra||{});
const cat=(code,name,url,extra)=>Object.assign({code,name,details_url:url||'',category:'Bath Safety',subcategory:'Toilet Seats',image:'/assets/products/x/'+code+'.jpg'},extra||{});

t('variants: shape, colour, side and size words come off the stem; the stem keeps everything else',()=>{
  eq(E.variantOf('Knee Brace — Left, Large'),{stem:'Knee Brace',dims:{Side:'Left',Size:'Large'}});
  eq(E.variantOf('Assurance Round Raised Toilet Seat with Clean Shield, 3"').dims,{Shape:'Round'});
  eq(E.variantOf('Grab Bar 24 in').dims,{},'no variant word');
  eq(E.variantOf('Blueprint Walker').dims,{},'"Blue" inside a word is not a colour');
});
t('proposals: variants on one manufacturer page share a page; different manufacturer pages, different names or a display never do',()=>{
  const P=E.planPages({records:[rec('A1'),rec('A2'),rec('B1'),rec('B2'),rec('K1'),rec('R1',{status:'discontinued'}),rec('Z1',{base_price:0})],
    catalog:[cat('A1','Walker — Blue','https://m/w'),cat('A2','Walker — Red','https://m/w'),cat('B1','Cane — Black','https://m/c1'),cat('B2','Cane — Gray','https://m/c2'),
      cat('K1','Walker Display Kit','https://m/w'),cat('R1','Old thing'),cat('Z1','Unpriced Seat')],custom:[],overrides:[],pages:[]});
  const by=c=>P.pages.find(p=>p.skus.some(s=>s.code===c));
  eq(by('A1').skus.map(s=>s.code+':'+s.option),['A1:Blue','A2:Red']); eq(by('A1').options,{Color:['Blue','Red']});
  ok(by('B1')!==by('B2'),'different manufacturer pages are different pages');
  ok(by('K1').bundle && by('K1').skus.length===1,'a display is never merged');
  eq(P.excluded,[{code:'R1',why:'retired on the commercial record (discontinued)'}]);
  eq(by('Z1').skus[0].price_ok,false);
});
t('proposals: a catalog-layer name wins; an existing draft keeps its page key; a live page is reported, never proposed over',()=>{
  const P=E.planPages({records:[rec('A1'),rec('A2')],catalog:[cat('A1','Seat'),cat('A2','Other')],custom:[],overrides:[{code:'A1',patch:{name:'Renamed Seat'}}],
    pages:[{page_key:'my-draft',status:'pending_review',skus:[{sku:'A1'}],draft_window:7},{page_key:'live',status:'published',disabled:false,skus:[{sku:'A2'}]}]});
  eq(P.pages.find(p=>p.skus[0].code==='A1').name,'Renamed Seat'); eq(P.pages.find(p=>p.skus[0].code==='A1').page_key,'my-draft');
  eq(P.pages.find(p=>p.skus[0].code==='A1').existing,{page_key:'my-draft',status:'pending_review',draft_window:7});
  eq(P.pages.find(p=>p.skus[0].code==='A2').live_page,'live'); eq(P.live.length,1);
});
t('page keys: readable, cut at a word, never two alike',()=>{
  eq(E.slug('Rise 4.5" Raised Toilet Seat with Arms & Dual-Lock Security'),'rise-4-5-in-raised-toilet-seat-with-arms-and-dual-lock');
  const P=E.planPages({records:[rec('A'),rec('B')],catalog:[cat('A','Same Name','https://m/1'),cat('B','Same Name','https://m/2')],custom:[],overrides:[],pages:[]});
  eq(P.pages.map(p=>p.page_key).sort(),['same-name','same-name-2']);
});
t('reading a page: description, bullets, label/value specs across sub-sections, model, MSRP; navigation and scripts ignored',()=>{
  const h=`<html><head><title>T</title><script>var x="<h2>Product Description</h2>"</script></head><body><nav><a href="/p/x">Shop</a><h2>Product Description</h2></nav>
    <h1>Thing</h1><div>Model # ABC123 000</div><div>$45.00 MSRP</div><h2>Product Description</h2><div>A long enough description sentence for the page. And another.</div>
    <ul><li>Feature one</li><li>Feature two</li></ul><h2>Specifications</h2><ul><li>Material:</li><li>Steel</li><li>Weight Capacity: 300 lbs</li><li>Width: 20 in Height: 10 in</li></ul><h3>Dimensions</h3><dl><dt>Width:</dt><dd>20 in</dd></dl></body></html>`;
  const x=E.extractPage(h,'https://m/p/thing');
  eq([x.model,x.msrp,x.product],['ABC123 000',45,true]);
  ok(/long enough description/.test(x.description) && !/<h2>/.test(x.description),x.description);
  eq(x.features,['Feature one','Feature two']);
  eq(x.specs.map(s=>s.label+'='+s.value),['Material=Steel','Weight Capacity=300 lbs','Width=20 in','Height=10 in']);
  eq(x.warranty,null,'no warranty stated');
});
t('warranty only when the page states terms; a link called "Warranty" is a document, not a warranty',()=>{
  const a=E.extractPage('<h2>Product Description</h2><div>Sturdy seat for daily use. Backed by a limited 5-year warranty against defects.</div><a href="/w.pdf">Manufacturer Warranty</a>','https://m/p');
  ok(a.warranty && /limited 5-year warranty/.test(a.warranty.text),JSON.stringify(a.warranty));
  const b=E.extractPage('<h2>Product Description</h2><div>Sturdy seat for daily use and more words here.</div><a href="/w.pdf">Manufacturer Warranty</a>','https://m/p');
  eq(b.warranty,null); eq(b.documents,[{label:'Manufacturer Warranty',url:'https://m/w.pdf'}]);
});
t('photos: lazy-load attributes, the largest srcset entry, og:image and JSON-LD; icons, logos and trackers skipped',()=>{
  const h=`<img src="/blank.gif" data-src="/a/MOD1-P.jpg" alt="p"><img srcset="/a/s.jpg 300w, /a/big.jpg 1200w"><img src="/icons/star-icon.png"><img src="https://www.facebook.com/tr?id=1">
    <meta property="og:image" content="https://cdn.m/og.jpg"><script type="application/ld+json">{"@type":"Product","name":"X","image":["https://cdn.m/ld.jpg"],"sku":"MOD1"}</script>`;
  const x=E.extractPage(h,'https://m/p');
  eq(x.images.map(i=>i.url),['https://m/a/MOD1-P.jpg','https://m/a/big.jpg','https://cdn.m/og.jpg','https://cdn.m/ld.jpg']);
  eq(x.model,'MOD1','model from JSON-LD');
});
t('matching: the product page that names this product; a bundle with another kind of product is refused but kept as "related"',()=>{
  const page={name:'Assurance Support Arms, Set of 2',skus:[{name:'Assurance Support Arms, Set of 2 — Gray'}]};
  const landing={url:'https://m/assurance/',links:[{href:'https://m/p/elongated-raised-toilet-seat-with-support-arms/',text:'Shop'},{href:'https://m/p/raised-toilet-seat-clean-shield/',text:'Shop'},{href:'https://m/p/',text:'All'}]};
  const r=E.pickProductLink(page,landing);
  eq(r.href,null); eq(r.related,'https://m/p/elongated-raised-toilet-seat-with-support-arms/');
  const seat={name:'Assurance Raised Toilet Seat with Clean Shield, 3"',skus:[{name:'Assurance Round Raised Toilet Seat with Clean Shield, 3"'}]};
  eq(E.pickProductLink(seat,landing).href,'https://m/p/raised-toilet-seat-clean-shield/');
});
t('catalog facts no source states are evidence for a Conflict; facts the source states are not',()=>{
  eq(E.unsupportedFacts('1000 lb seat capacity, raised 3"','Wide ring with a weight capacity of 1000 lbs. Raised 3 inches.'),[]);
  eq(E.unsupportedFacts('350 lb capacity per arm','Arms are rated to 300 lbs each.'),['350 lb']);
});
t('photos assembled: gallery deduplicated by bytes, a primary, per-SKU photos, shared photos found, failures kept off the draft',()=>{
  const page={skus:[{code:'R'},{code:'E'}]}, row={skus:[{sku:'R'},{sku:'E'}]};
  const a=E.assembleImages(page,row,[{role:'gallery',url:'u1',sha:'s1'},{role:'gallery',url:'u2',sha:'s1'},{role:'sku',code:'R',url:'u3',sha:'s3'},{role:'sku',code:'E',url:'u4',sha:'s3'},{role:'gallery',src:'x',error:'HTTP 404'}]);
  eq(a.images_gallery.map(g=>[g.url,g.primary]),[['u1',true]]); eq(a.image,'u1'); eq(a.skus.map(s=>s.image),['u3','u4']);
  eq(a.shared.map(s=>s.codes),[['R','E']]); eq(a.failed,[{src:'x',error:'HTTP 404'}]);
});
t('statuses: Conflict > grouping > content > image > category > Ready; a held-back page stops blocking; a resolution closes its issue',()=>{
  const page={page_key:'p',name:'P',skus:[{code:'A',price_ok:true}]};
  const good={description:'x'.repeat(90),features:['a','b','c'],category:'C',subcategory:'S',images_gallery:[{url:'u',primary:true}],image:'u',enrichment_flags:{mc:{sources:[{role:'product',url:'https://m'}],images_done:true}}};
  eq(E.classify(page,good,[]).status,'ready');
  eq(E.classify(page,Object.assign({},good,{category:null,subcategory:null}),[]).status,'needs_category');
  eq(E.classify(page,Object.assign({},good,{images_gallery:[],image:null}),[]).status,'needs_image');
  eq(E.classify(page,Object.assign({},good,{features:['a']}),[]).status,'needs_content');
  eq(E.classify(Object.assign({},page,{bundle:true}),good,[]).status,'needs_grouping');
  const conf=Object.assign({},good,{enrichment_flags:{mc:Object.assign({},good.enrichment_flags.mc,{conflicts:[{kind:'source_identity',title:'?',evidence:{page:'a',record:'b'}}]})}});
  eq(E.classify(page,conf,[]).status,'conflict');
  eq(E.classify(page,conf,[{id:1,kind:'content_resolution',field:'page:p',hcps_value:{issue:'conflict',choice:'same_product'}}]).status,'ready');
  eq(E.classify({page_key:'p',name:'P',skus:[{code:'A',price_ok:false}]},good,[]).status,'conflict','no price on the record');
  const held=E.classify(page,Object.assign({},good,{features:[]}),[{id:2,kind:'content_resolution',field:'page:p',hcps_value:{issue:'needs_content',choice:'hold_back'}}]);
  /* Angelo 2026-10-11: a source hold keeps its issues listed (marked held), it just stops blocking */
  eq([held.status,held.blocking,held.issues.length,held.issues[0].held,held.held],['held_back',false,1,true,true]);
  const held2=E.classify(page,Object.assign({},good,{features:[]}),[{id:3,kind:'content_resolution',field:'page:p',hcps_value:{issue:'hold',choice:'hold_back'}}]);
  eq([held2.status,held2.issues.map(i=>i.type)],['held_back',['needs_content']],'the hold has its own issue key: a source added later is not superseded');
  eq(E.CHOICES.hold.map(c=>c.id),['hold_back']);
  eq(E.classify(page,null,[]).status,'not_enriched');
});
t('resolutions: the latest decision per issue wins; choices are validated, with the input each needs',()=>{
  const r=E.resolutionsFor([{id:1,kind:'content_resolution',field:'page:p',hcps_value:{issue:'needs_grouping',choice:'own_page'}},{id:5,kind:'content_resolution',field:'page:p',hcps_value:{issue:'needs_grouping',choice:'hidden_order_by_code'}},
    {id:3,kind:'conflict',field:'page:p',hcps_value:{issue:'needs_grouping',choice:'x'}},{id:4,kind:'content_resolution',field:'page:q',hcps_value:{issue:'needs_grouping',choice:'own_page'}}],'p');
  eq(r.needs_grouping.choice,'hidden_order_by_code');
  eq(E.resolutionProblem('needs_content','rerun_with_source',{}),'a source URL (http or https) is required');
  eq(E.resolutionProblem('needs_content','rerun_with_source',{source_url:'https://m/p'}),null);
  eq(E.resolutionProblem('needs_category','set_category',{}),'a category is required');
  ok(E.resolutionProblem('conflict','publish_now',{}),'not a choice');
});
t('a draft is built without a single commercial field and without inventing a warranty or specs',()=>{
  const page={page_key:'p',name:'P',options:{},skus:[{code:'A',name:'P',option:'',catalog_description:'Short line.',category:'C',subcategory:'S'}]};
  const d=E.buildDraft(page,[],{slug:'m'});
  for(const k of ['base_price','msrp','map','tiers','uom','case_qty','price_note']) ok(!(k in d.row),'commercial field '+k);
  eq([d.row.warranty,d.row.specs,d.row.status],[null,[],'pending_review']);
  ok(/catalog line only/.test(d.row.field_provenance.description),'provenance says where the copy came from');
});
t('displays are never merged, not even with each other; variants still are',()=>{
  const P=E.planPages({records:[rec('D1'),rec('D2')],catalog:[cat('D1','Floor Display — Gray','https://m/d'),cat('D2','Floor Display — Black','https://m/d')],custom:[],overrides:[],pages:[]});
  eq(P.pages.length,2); ok(P.pages.every(p=>p.bundle&&p.skus.length===1),'two displays, two pages, each asking for a decision');
});
t('matching: a candidate naming another kind of product loses to one that does not, even with more shared words; a bundle is never the product page',()=>{
  const seat={name:'Raised Toilet Seat Clean Shield',skus:[{name:'Raised Toilet Seat Clean Shield'}]};
  const land={url:'https://m/l/',links:[{href:'https://m/p/raised-toilet-seat-clean-shield-elongated-with-support-arms/',text:''},{href:'https://m/p/raised-toilet-seat-clean/',text:''}]};
  eq(E.pickProductLink(seat,land).href,'https://m/p/raised-toilet-seat-clean/');
  const arms={name:'Assurance Clean Shield Elongated Support Arms',skus:[{name:'Assurance Clean Shield Elongated Support Arms'}]};
  const land2={url:'https://m/l/',links:[{href:'https://m/p/assurance-clean-shield-elongated-seat-with-support-arms/',text:''}]};
  const r=E.pickProductLink(arms,land2); eq([r.href,r.related],[null,'https://m/p/assurance-clean-shield-elongated-seat-with-support-arms/']);
});
t('specs come only from specification sections — a "Label: value" line in the description is not a spec',()=>{
  const x=E.extractPage('<h2>Product Description</h2><div>Plenty of description text for this product here.</div><ul><li>Weight limit: 300 lbs</li></ul><h2>Specifications</h2><ul><li>Material:</li><li>Plastic</li></ul>','https://m/p');
  eq(x.specs.map(s=>s.label),['Material']); eq(x.features,['Weight limit: 300 lbs']);
});
t('a draft with no manufacturer source needs content even when the catalog line is long and lists features',()=>{
  const page={page_key:'p',name:'P',skus:[{code:'A',price_ok:true}]};
  const row={description:'y'.repeat(200),features:['a','b','c'],category:'C',subcategory:'S',images_gallery:[{url:'u',primary:true}],image:'u',enrichment_flags:{mc:{sources:[],images_done:true}}};
  const c=E.classify(page,row,[]); eq(c.status,'needs_content'); ok(c.issues.some(i=>/No manufacturer page/.test(i.title)),JSON.stringify(c.issues));
});
t('editorial: first-person wording is neutral — "our" becomes the brand\'s, a pure first-person slogan sentence is dropped, facts stay',()=>{
  eq(E.neutralize('Our patented Dual Lock keeps it tight. Seat weight limit: 300 lbs. We\'re EMPOWERING INDEPENDENCE.','Bemis'),'Bemis’s patented Dual Lock keeps it tight. Seat weight limit: 300 lbs.');
  eq(E.neutralize('Top priority for our 4.5" seat is security.','Bemis'),'Top priority for Bemis’s 4.5" seat is security.');
  eq(E.neutralize('We tested it to 300 lbs.','Bemis'),'Bemis tested it to 300 lbs.','a first-person sentence with a fact keeps the fact');
});
t('a catalog figure no manufacturer source states is left out of the draft (350 lb per arm), and no retail model becomes a spec',()=>{
  const page={page_key:'arms',name:'Arms',options:{},skus:[{code:'A',name:'Arms',option:'',catalog_description:'For the Assurance toilet seats. 350 lb capacity per arm. Sold as a set of 2.',category:'C',subcategory:'S'}]};
  const landing={url:'https://m/l/',role:'landing',extract:{text:'Optional support arms can be added.',images:[],documents:[],videos:[],model:'',product:false}};
  const d=E.buildDraft(page,[landing],{slug:'m',brand:'Bemis'});
  ok(!/350/.test(d.row.description) && /Sold as a set of 2\./.test(d.row.description),d.row.description);
  ok(/left out until a Bemis source confirms it: 350 lb/.test(d.row.field_provenance.description),d.row.field_provenance.description);
  const prod={url:'https://m/p/',role:'product',extract:{text:'Model #ABC 000',model:'ABC 000',product:true,description:'A good seat for daily use, rated and tested.',features:['a','b','c'],specs:[{label:'Model No.',value:'ABC 000',evidence:'x'},{label:'Shape',value:'Round',evidence:'y'}],warranty:null,documents:[],videos:[],images:[],msrp:89.99}};
  const p2=Object.assign({},page,{skus:[Object.assign({},page.skus[0],{catalog_description:''})]});
  const d2=E.buildDraft(p2,[prod],{slug:'m',brand:'Bemis',records:{A:{msrp:79.99}}});
  eq(d2.row.specs,[{label:'Shape',value:'Round'}]); eq(d2.report.conflicts,[],'no conflict from a retail price');
  ok(/Bemis Retail Model ABC 000/.test(d2.row.field_provenance.retail_model),'retail model kept in provenance');
});
t('photos: promo art never leads; promo-only means no main photo; an official per-option photo wins over the catalog one',()=>{
  const page={skus:[{code:'R'},{code:'E'}]}, row={skus:[{sku:'R'},{sku:'E'}]};
  const a=E.assembleImages(page,row,[{role:'gallery',src:'https://m/assurance-landing-page-seat-fb.jpg',url:'u1',sha:'s1',bytes:5,promo:true},{role:'gallery',src:'https://m/E85-000-F.jpg',url:'u2',sha:'s2',bytes:5}]);
  /* Angelo 2026-10-11: badge / promo art is never dealer-facing — not even a thumbnail; it is kept as withheld */
  eq(a.image,'u2'); eq(a.images_gallery.map(g=>[g.url,g.primary]),[['u2',true]]); eq(a.withheld_promo.map(w=>w.url),['u1']);
  const b=E.assembleImages({skus:[{code:'X'}]},{skus:[{sku:'X'}]},[{role:'gallery',src:'https://m/banner.jpg',url:'u1',sha:'s1',promo:true}]);
  eq([b.image,b.promo_only],[null,true]);
  const c=E.imageCandidates({skus:[{code:'R',catalog_image:'/a/R.jpg'},{code:'E',catalog_image:'/a/E.jpg'}]},[],'https://o',{R:{url:'https://m/R85-P.jpg',why:'round'}});
  eq(c.map(x=>[x.role,x.code,x.src]),[['sku','R','https://m/R85-P.jpg'],['sku','E','https://o/a/E.jpg']]);
  eq(E.skuImageChoices([{id:1,kind:'content_resolution',field:'page:p',hcps_value:{choice:'use_source_image',code:'R',image_url:'https://a/1.jpg'}},{id:2,kind:'content_resolution',field:'page:p',hcps_value:{choice:'use_source_image',code:'R',image_url:'https://a/2.jpg'}}],'p').R.url,'https://a/2.jpg');
  eq(E.resolutionProblem('needs_image','use_source_image',{code:'R',image_url:'http://a/x.jpg'}),'an https photo address and the SKU it is for are required');
  eq(E.resolutionProblem('needs_image','use_source_image',{code:'R',image_url:'https://a/x.jpg'}),null);
});
t('a landing page\'s images are not used when a product page exists',()=>{
  const prod={role:'product',extract:{product:true,model:'E85320TSS 000',images:[{url:'https://m/E85320TSS-000-F.jpg'}]}};
  const land={role:'landing',extract:{images:[{url:'https://m/assurance-landing-page-seat-fb.jpg'}]}};
  eq(E.imageCandidates({name:'Assurance seat',skus:[{name:'Assurance seat'}]},[land,prod],'https://o').map(c=>c.src),['https://m/E85320TSS-000-F.jpg']);
});
t('catalog names vs the manufacturer: a term the page never names, or shows only in badges while its copy names another system, is a discrepancy',()=>{
  eq(E.namedTerms('Open-front ring, raised 3", with the Stay-Tite installation system.'),['Stay-Tite']);
  eq(E.namedTerms('Assist Non-Elevated Premium Toilet Seat with Arms and Stay Tite Installation System'),['Stay Tite']);
  eq(E.systemNames('Seat is securely fastened with Snap 2 Secure system (installation tool included).'),['Snap 2 Secure']);
  const page={page_key:'s',name:'Steadfast',skus:[{code:'7YE82350TC',catalog_description:'Open-front ring, raised 3", with the Stay-Tite installation system.'}]};
  const mk=(desc,text)=>({url:'https://m/p',role:'product',extract:{product:true,model:'E1 000',description:'Raised 3 inches. '+desc,features:[],specs:[],documents:[],videos:[],images:[],text:'Raised 3 inches. '+(text||desc)}});
  let b=E.buildDraft(page,[mk('Fastened with Snap 2 Secure system.','Never Loosens Stay·Tite® Fastened with Snap 2 Secure system.')],{brand:'Bemis'});
  eq(b.report.conflicts.map(c=>c.kind),['catalog_name']); ok(/Snap 2 Secure/.test(b.report.conflicts[0].title));
  b=E.buildDraft(page,[mk('Fastened with Snap 2 Secure system.')],{brand:'Bemis'}); ok(/never names it/.test(b.report.conflicts[0].title));
  b=E.buildDraft(page,[mk('The Stay·Tite fastening system keeps it secure.')],{brand:'Bemis'}); eq(b.report.conflicts,[],'the same name with Bemis spelling');
  b=E.buildDraft(page,[mk('A raised seat.','Never Loosens Stay·Tite® A raised seat.')],{brand:'Bemis'}); eq(b.report.conflicts,[],'shown in badges and no rival system named');
  eq(E.CHOICES.catalog_name.map(c=>c.id),['use_source','keep_catalog_name']);
  eq(E.classify({page_key:'s',skus:[{code:'X',price_ok:true}]},{description:'x'.repeat(90),features:['a','b','c'],category:'c',image:'https://x/a.jpg',enrichment_flags:{mc:{images_done:true,sources:[{role:'product'}],conflicts:[{kind:'catalog_name',title:'t'}]}}},[]).issues[0].resolution_key,'catalog_name');
});
t('messages name no other manufacturer (AirAvant page said "Bemis\'s landing page")',()=>{
  const c=E.classify({page_key:'a',skus:[{code:'BNG500',price_ok:true}]},{description:'x'.repeat(90),features:['a','b','c'],category:'c',image:'https://x/a.jpg',enrichment_flags:{mc:{images_done:true,sources:[{role:'landing',url:'https://bongorx.com/'}],conflicts:[]}}},[]);
  const i=c.issues.find(x=>x.type==='needs_content'); ok(i&&/^The manufacturer's landing page/.test(i.detail)&&!/Bemis/.test(JSON.stringify(c)),JSON.stringify(i));
});
console.log(`enrich engine (pure): ${pass} passed, ${fail} failed`); process.exit(fail?1:0);

/* 2.5 (admin) — the admin join resolves category, group and image exactly as the shop does. */
const J=require((process.env.CAT_ROOT||require('path').join(__dirname,'..','netlify','functions'))+'/_catalog-join.js');
let fail=0; const ok=(c,m)=>{ console.log((c?'ok  ':'FAIL')+' '+m); if(!c) fail++; };
const map={'Back Braces':'Back & Spine'};
const live={page_key:'l',status:'published',subcategory:'Back Braces',skus:[{sku:'A'}]};
const draft={page_key:'d',status:'pending_review',subcategory:'Back Braces',skus:[{sku:'B'}]};
ok(J.resolveCategory({product:{category:'Backs'},page:live,categoryMap:map}).category==='Back & Spine','live page: the map files it');
ok(J.resolveCategory({product:{category:'Backs'},page:draft,categoryMap:map}).category==='Backs','draft page: the shop keeps the catalog category, so the admin does');
ok(J.resolveCategory({product:{category:'Backs',subcategory:'Back Braces'},page:null,categoryMap:map}).category==='Backs','no page: no map, as in the shop');
ok(J.resolveCategory({product:{category:'Pinned',category_from_override:true},page:live,categoryMap:map}).category==='Pinned','a pin still wins');
const idx=J.indexPages({p1:{variant_group:'G'},p2:{variant_group:'G'}});
ok(idx.byGroup.G==='p2','variant group: last page wins, as in the shop');
const jn=J.buildJoin({products:[{code:'A',image:'cat.jpg'},{code:'C',image:'cat.jpg'}],pages:{l:Object.assign({},live,{skus:[{sku:'A',image:'sku.jpg'},{sku:'C'}],image:'pg.jpg',images_gallery:[{url:'g1.jpg'},{url:'pg.jpg'}]})},categoryMap:map});
const by=Object.fromEntries(jn.rows.map(r=>[r.code,r]));
ok(by.A.image==='sku.jpg','SKU photo first'); ok(by.C.image==='pg.jpg','gallery without a primary honours the page image');
{ const j3=J.buildJoin({products:[{code:'D1'},{code:'D2'},{code:'D3'},{code:'D4'}],enrichedOnly:true,pages:{
    d:Object.assign({},live,{page_key:'d',status:'discontinued',skus:[{sku:'D1'}]}),
    e:Object.assign({},live,{page_key:'e',skus:[{sku:'D2',status:'discontinued'},{sku:'D3',status:'hidden'},{sku:'D4'}]})},categoryMap:map});
  const b3=Object.fromEntries(j3.rows.map(r=>[r.code,r]));
  ok(b3.D1.visible && !b3.D1.sellable,'a discontinued page: visible, not sellable (as the shop shows it)');
  ok(b3.D2.visible && !b3.D2.sellable,'a SKU marked discontinued: visible, not sellable');
  ok(!b3.D3.visible,'a SKU marked hidden: not visible');
  ok(b3.D4.visible && b3.D4.sellable,'a current SKU: visible and sellable');
  ok(J.statusFor(b3.D1,{}).status==='discontinued','the completion board counts it apart, like retired'); }
{ const jd=J.buildJoin({products:[{code:'FCOM-02'},{code:'fcom-02',active:false},{code:'MP-P09'},{code:'mp-p09'}],pages:{}});
  const bd=Object.fromEntries(jd.rows.map(r=>[r.code,r]));
  ok(!bd['FCOM-02'].duplicate_of.length,'a retired lower-case twin does not make the live SKU a duplicate');
  ok(bd['MP-P09'].duplicate_of.join()==='mp-p09' && bd['mp-p09'].duplicate_of.join()==='MP-P09','two ACTIVE rows with the same part number are still a conflict'); }
{ const j2=J.buildJoin({products:[{code:'E',image:'cat.jpg'},{code:'F',image:'cat.jpg'}],pages:{
    e:Object.assign({},live,{page_key:'e',skus:[{sku:'E'}],image:'page-only.jpg',images_gallery:[{url:'g1.jpg'},{url:'g2.jpg'}]}),
    f:Object.assign({},live,{page_key:'f',skus:[{sku:'F'}],image:null,images_gallery:[{url:'f1.jpg'},{url:'f2.jpg'}]})},categoryMap:map});
  const b2=Object.fromEntries(j2.rows.map(r=>[r.code,r]));
  ok(b2.E.image==='page-only.jpg','no primary: a page image outside the gallery is the photo'); ok(b2.F.image==='f1.jpg','no primary, no page image: the first photo'); }
console.log(fail?`\n${fail} FAILED`:'\nALL PASS'); process.exit(fail?1:0);

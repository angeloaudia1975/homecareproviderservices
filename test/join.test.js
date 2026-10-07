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
console.log(fail?`\n${fail} FAILED`:'\nALL PASS'); process.exit(fail?1:0);

/* Mutants for the Structure Map's shared resolver + strict reads.
   HTML mutants rewrite product-content-review.html (PCR_HTML); server mutants rewrite
   catalog-api.js / _catalog-join.js in a temp copy of the functions dir (CAT_ROOT). */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const HTML=path.join(__dirname,'..','src','admin','product-content-review.html');
const rd=f=>fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
const M=[
 // the page
 ['html','map applies to draft pages again', 'const livePage = page && isVisible(page) ? page : null;\n  const sub = (livePage && str(livePage.subcategory)) || str(p.subcategory);\n  if (p.category_from_override', 'const livePage = page;\n  const sub = (livePage && str(livePage.subcategory)) || str(p.subcategory);\n  if (p.category_from_override'],
 ['html','disabled pages count as visible', "const SMJ_isVisible = pg => !!pg && pg.disabled !== true && SMJ_VISIBLE", "const SMJ_isVisible = pg => !!pg && SMJ_VISIBLE"],
 ['html','pin ignored', 'if (p.category_from_override && internal)\n    return { category: internal, source: "pinned"', 'if (false)\n    return { category: internal, source: "pinned"'],
 ['html','page category instead of the SKU record', "const product={category: (pin!=null&&pin!=='')?pin:rec.category, kind: rec.kind,", "const product={category: (pin!=null&&pin!=='')?pin:page.category, kind: rec.kind,"],
 ['html','one pin drags the whole page', "const pin=pinned[String(code)];", "const pin=skuCodes.map(c=>pinned[String(c)]).find(v=>v!=null&&v!=='');"],
 ['html','lenient map read is back', "      get('/.netlify/functions/catalog-api'),", "      fetch('/.netlify/functions/catalog-api',{headers:h}).then(r=>r.json()).catch(()=>({})),"],
 ['html','smRows keeps its own resolver', "    const r=smPageCategory(p, skus.map(x=>x.sku), catalog, pinned, map);\n    const dealer=r.category;", "    const r=smPageCategory(p, skus.map(x=>x.sku), catalog, pinned, map);\n    const dealer=r.pinned?r.category:((sub&&map[sub])||internal);"],
 ['html','statuses drift', 'const SMJ_VISIBLE_STATUSES = ["published", "active", "discontinued"];', 'const SMJ_VISIBLE_STATUSES = ["published", "active"];'],
 // the server
 ['cat','catalog file lenient again', '          catalogFile(slug),\n          sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,name,category,base_price,msrp,map,msrp_auto,image,description,active,tiers,price_note,updated_at`),', '          fetchJson(`${ORDERING_BASE}/data/${slug}.json`).catch(()=>[]),\n          sb("GET",`custom_products?manufacturer=eq.${encodeURIComponent(slug)}&select=code,name,category,base_price,msrp,map,msrp_auto,image,description,active,tiers,price_note,updated_at`),'],
 ['cat','overrides lenient again', 'sb("GET",`product_overrides?manufacturer=eq.${encodeURIComponent(slug)}&select=code,patch,updated_at`),\n          sb("GET",`featured_products', 'sb("GET",`product_overrides?manufacturer=eq.${encodeURIComponent(slug)}&select=code,patch,updated_at`).catch(()=>[]),\n          sb("GET",`featured_products'],
 ['cat','meta lenient on the list', '            sb("GET","manufacturer_meta?select=slug,logo_url,enriched_only,category_order,category_map"),', '            sb("GET","manufacturer_meta?select=slug,logo_url,enriched_only,category_order,category_map").catch(()=>[]),'],
 ['cat','loadPages forgets disabled', 'select=page_key,name,status,disabled,category,subcategory,description', 'select=page_key,name,status,category,subcategory,description'],
 ['cat','loadPages lenient', 'variant_group&limit=5000`);', 'variant_group&limit=5000`).catch(()=>[]);'],
 ['cat','loadMeta lenient', 'select=slug,enriched_only,category_order,category_map`);', 'select=slug,enriched_only,category_order,category_map`).catch(()=>[]);'],
 ['join','server map applies to drafts', 'const livePage = page && isVisible(page) ? page : null;', 'const livePage = page;'],
];
let surv=0;
for(const [where,n,f,t] of M){
  const file=where==='html'?HTML:path.join(DIR,where==='cat'?'catalog-api.js':'_catalog-join.js');
  const src=rd(file); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'smr-'));
  for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  const env=Object.assign({},process.env,{CAT_ROOT:MD});
  if(where==='html'){ const h=path.join(MD,'pcr.html'); fs.writeFileSync(h,src.replace(f,t)); env.PCR_HTML=h; }
  else fs.writeFileSync(path.join(MD,where==='cat'?'catalog-api.js':'_catalog-join.js'),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'structure-resolver.test.js')],{stdio:'pipe',env}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

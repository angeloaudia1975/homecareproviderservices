const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const files=['images-api.js','product-content.js','featured-api.js'];
const M=[
 ['images-api.js','sku photo not first', "    if(sx && str(sx.image)) return { url:str(sx.image), source:\"sku\" };\n    const n=normalizeGallery", "    if(false) return { url:str(sx.image), source:\"sku\" };\n    const n=normalizeGallery"],
 ['images-api.js','no-primary gallery ignores the page image', "  if(i<0){ i=g.findIndex(x=>str(x.url)===str(image));\n    if(i<0 && str(image)){", "  if(i<0){ i=-1;\n    if(i<0 && str(image)){"],
 ['images-api.js','page image outside the gallery ignored', "    if(i<0 && str(image)){ g.unshift({url:str(image), source:\"page-image\", caption:\"\"}); i=0; }\n    if(i<0) i=0; }\n  g.forEach((x,k)=>{ x.primary=(k===i); });\n  return { gallery:g, image:g[i].url };\n}\n/* What a dealer", "    if(i<0) i=0; }\n  g.forEach((x,k)=>{ x.primary=(k===i); });\n  return { gallery:g, image:g[i].url };\n}\n/* What a dealer"],
 ['images-api.js','overrides matched case-insensitively', "const om={}; L.overrides.forEach(o=>{ om[String(o.code)]=o.patch||{}; });", "const om={}; L.overrides.forEach(o=>{ om[up(o.code)]=o.patch||{}; om[String(o.code)]=o.patch||{}; });"],
 ['images-api.js','added rows matched case-insensitively', "      const have=new Set(rows.map(r=>String(r.code)));\n      L.custom.forEach(c=>{ if(!have.has(String(c.code)))", "      const have=new Set(rows.map(r=>up(r.code)));\n      L.custom.forEach(c=>{ if(!have.has(up(c.code)))"],
 ['product-content.js','save: page image outside gallery ignored', "    if (i < 0 && s(image)) { g.unshift({ url: s(image), source: 'page-image', caption: '' }); i = 0; }", ""],
 ['images-api.js','override loses to the file', "  if(override && str(override.image)) return { url:str(override.image), source:\"catalog-override\" };", ""],
 ['images-api.js','collision auto-replaces primary', "    return Object.assign(row,{class:\"collision\", action:\"needs_decision\"", "    return Object.assign(row,{class:\"collision\", action:\"set_primary\""],
 ['images-api.js','shadowed row overwrites catalog photo', "      if(cur && cur!==url) return Object.assign(row,{class:\"shadowed\", action:\"none\",", "      if(cur && cur!==url) return Object.assign(row,{class:\"shadowed\", action:\"set_override_image\","],
 ['images-api.js','dry run applies', "          if(b.apply===true){\n            const idx=pageIndex(L.pages);", "          if(true){\n            const idx=pageIndex(L.pages);"],
 ['images-api.js','multi-SKU upload does not ask', "        if(page && !scope) return json(409,{error:\"scope_required\"", "        if(false) return json(409,{error:\"scope_required\""],
 ['images-api.js','new photo not put first', "  const n=normalizeGallery([{url, primary:true, caption:\"\", source:\"product-images\"}].concat(g), url);", "  const n=normalizeGallery(g.concat([{url, primary:true, caption:\"\", source:\"product-images\"}]), url);"],
 ['images-api.js','override write replaces the patch', "  const patch=Object.assign({},(ex&&ex[0]&&ex[0].patch)||{});\n  if(url) patch.image=url; else delete patch.image;", "  const patch={};\n  if(url) patch.image=url; else delete patch.image;"],
 ['images-api.js','upload still writes the legacy table', "        let wrote;\n        if(page && scope===\"sku\")", "        let wrote; await sb(\"POST\",\"product_images\",{manufacturer:mfr,code,url},{Prefer:\"resolution=merge-duplicates,return=minimal\"});\n        if(page && scope===\"sku\")"],
 ['images-api.js','page photo removable here', "          return json(409,{error:\"page_photo\"", "          await writeSkuImage(mfr, page, code, null, actor); return json(200,{ok:true,cleared:\"x\"});\n          return json(409,{error:\"page_photo\""],
 ['images-api.js','failed read treated as empty', "    sb(\"GET\",`product_overrides?manufacturer=eq.${enc(mfr)}&select=code,patch`),\n    sb(\"GET\",`product_content", "    sb(\"GET\",`product_overrides?manufacturer=eq.${enc(mfr)}&select=code,patch`).catch(()=>[]),\n    sb(\"GET\",`product_content"],
 ['product-content.js','save does not normalise', "        if ('images_gallery' in patch) {\n          /* A photo the person", "        if (false) {\n          /* A photo the person"],
 ['featured-api.js','featured ignores the page', "page:pidx[String(code).trim().toUpperCase()]||null", "page:null"],
 ['product-content.js','deleted primary resurrected', "keepImg && was.includes(String(keepImg).trim())", "false && was.includes(String(keepImg).trim())"],
];
let surv=0;
for(const [file,n,f,t] of M){
  const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1;
  if(c!==1){ console.log(`BAD ANCHOR(${c}) ${n}`); surv++; continue; }
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'img-'));
  for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,process.env.IMG_TEST||'images.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++;
}
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

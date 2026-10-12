/* Mutants for Manufacturer Center Release B (Product Enrichment and the Advanced Editor's commercial lock). Each edit must
   make one of test/enrich.unit.test.js, test/mcenrich.test.js, test/mceditor.commercial.test.js fail. */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions'), EDITOR=path.join(__dirname,'..','src','admin','product-content-review.html');
const JS=[
 ['_enrich.js','a retired SKU proposed','    if((r.status || "active") !== "active"){ excluded.push','    if(false){ excluded.push'],
 ['_enrich.js','a display merged with other pages','    const key = it.bundle ? "bundle:" + it.k : (v.stem','    const key = (v.stem'],
 ['_enrich.js','variants on different manufacturer pages share a page',' + "|" + it.details_url.toLowerCase().replace(/\\/+$/, ""));',');'],
 ['_enrich.js','a draft listing a SKU hides the live page that lists it','    const visible = holders.filter(isVisibleRow);','    const visible = holders.slice(0, 1).filter(isVisibleRow);'],
 ['_enrich.js','another kind of product not penalised','  return { score: shared - 2 * foreign.length','  return { score: shared'],
 ['_enrich.js','a bundle page taken as the product page','  if(best && best.score >= 3 && !best.foreign.length) return','  if(best && best.score >= 3) return'],
 ['_enrich.js','photos taken from a bundle page','if(!s || !s.extract || s.role === "related" || (hasProduct','if(!s || !s.extract || (hasProduct'],
 ['_enrich.js','a warranty link read as warranty terms','/warrant/i.test(s) && /(year|lifetime|limited|months?|days?)/i.test(s) &&','/warrant/i.test(s) &&'],
 ['_enrich.js','a default warranty when the source states none','    warranty: warranty ? warranty.text : null,','    warranty: warranty ? warranty.text : "Standard manufacturer warranty.",'],
 ['_enrich.js','specs read from any section','  for(const sec of secs.filter(s => SPEC_H.test(s.heading))){','  for(const sec of secs){'],
 ['_enrich.js','a draft written dealer-visible','manufacturer: opts.slug, page_key: page.page_key, name: page.name, status: "pending_review",','manufacturer: opts.slug, page_key: page.page_key, name: page.name, status: "published",'],
 ['_enrich.js','a retail model shown as a dealer spec','!/^(brand)$/i.test(s.label) && !RETAIL_MODEL_LABEL.test(s.label)','!/^(brand)$/i.test(s.label)'],
 ['_enrich.js','first-person copy left as written','    description = neutralize(description, opts.brand);\n',''],
 ['_enrich.js','an unconfirmed catalog figure kept in the draft','    if(unsup.length) cd = norm(','    if(false) cd = norm('],
 ['_enrich.js','landing promo art used beside a product page','s.role === "related" || (hasProduct && s.role !== "product")) continue;','s.role === "related") continue;'],
 ['_enrich.js','promo art allowed to lead','  pool = pool.filter(d => !d.promo);\n','  pool = pool.filter(d => d.promo).concat(pool.filter(d => !d.promo));\n'],
 ['_enrich.js','resized copies of one photo kept twice','x.some(y => y.sha === d.sha || photoStem(y.src) === photoStem(d.src))','x.some(y => y.sha === d.sha)'],
 ['_enrich.js','the smaller copy kept','.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0]','.sort((a, b) => (a.bytes || 0) - (b.bytes || 0))[0]'],
 ['_enrich.js','an official option photo ignored','    if(pick){ add(pick.url','    if(false){ add(pick.url'],
 ['_enrich.js','a catalog name the page never names not flagged','      if(!onPage) flagged.push(','      if(false) flagged.push('],
 ['_enrich.js','a badge-only catalog name beside a rival system not flagged','      else if(!inCopy && rival.length) flagged.push(','      else if(false) flagged.push('],
 ['_enrich.js','a name discrepancy resolved as a same/different-product conflict','c.kind === "catalog_fact" || c.kind === "catalog_name" ? c.kind : "conflict"','c.kind === "catalog_fact" ? c.kind : "conflict"'],
 ['_enrich.js','Bemis spelling (Stay·Tite) not matched to the catalog (Stay-Tite)','const nameKey = t => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");','const nameKey = t => String(t || "").toLowerCase();'],
 ['_enrich.js','a bundle page counted as a product source','  const noSource = !(mc.sources || []).some(s => s.role === "product");','  const noSource = !anySource;'],
 ['_enrich.js','a failed photo linked','  const ok = done.filter(d => d.url && !d.error);','  const ok = done.map(d => Object.assign({ url: d.src, sha: d.src }, d));'],
 ['_enrich.js','two options sharing one photo not found','.filter(([, c]) => c.length > 1)','.filter(() => false)'],
 ['_enrich.js','a resolved conflict still open','    if(r) continue;\n','\n'],
 ['_enrich.js','the earliest decision wins','.sort((a, b) => a.id - b.id)\n    .forEach(d => { const v = d.hcps_value','.sort((a, b) => b.id - a.id)\n    .forEach(d => { const v = d.hcps_value'],
 ['_enrich.js','a held-back page still blocks','blocking: !held && status !== "ready", held };','blocking: status !== "ready", held };'],
 ['_enrich.js','a page without a source called fine','    else if(noSource) add("needs_content", "No manufacturer page found"','    else if(false) add("needs_content", "No manufacturer page found"'],
 ['_enrich.js','a page with only a bundle page called fine','    if(noSource && anySource) add("needs_content"','    if(false) add("needs_content"'],
 ['product-content.js','enrichment writes over a live page','        if (page.live_page || ENRICH.isVisibleRow(cur)) return reply(409','        if (false) return reply(409'],
 ['product-content.js','a rejected manufacturer page read again','.filter(u => u && u !== rejected))].slice(0, 2);','.filter(u => u))].slice(0, 2);'],
 ['product-content.js','a non-image copied as a photo',"    if (!/^image\\/(jpeg|jpg|png|webp|gif)$/.test(ct)) return { error: 'not an image (' + (ct || 'no type') + ')' };\n",""],
 ['product-content.js','a resolution recorded without a reason',"          if (!reason) return reply(400, { ok: false, error: 'reason_required'","          if (false) return reply(400, { ok: false, error: 'reason_required'"],
 ['product-content.js','a later choice not linked to the earlier one',"supersedes_id: prev ? prev.id : null };","supersedes_id: null };"],
 ['product-content.js','a resolution dry run records it',"          if (body.dry_run === true) return reply(200, { ok: true, dry_run: true, would_record: rec });\n",""],
 ['product-content.js','a photo from elsewhere put on a draft',"          if (url.indexOf(own) !== 0 || /[?#\\s]/.test(url.slice(own.length))) return reply(400","          if (false) return reply(400"],
 ['_mc.js','enrichment writes outside the gate','  "enrich_page","enrich_images","enrich_resolve","enrich_set_image"]);\n/* …and the ones','  ]);\n/* …and the ones'],
];
const HTMLM=[
 ['the editor sends commercial writes','  if(isCommercialBody(body)) return {ok:false,status:409','  if(false) return {ok:false,status:409'],
 ['the editor creates catalog SKUs again','  if(have.has(String(prod.code).toUpperCase())) return {ok:false, duplicate:true};\n',''],
 ['a price input back in the commercial summary',"<td><b>${pmoney(v.base)}</b></td>","<td><input value=\"${pmoney(v.base)}\"></td>"],
];
const TESTS=['enrich.unit.test.js','mcenrich.test.js','mceditor.commercial.test.js','mccontentfreeze.test.js'];
let surv=0, killed=0;
function run(env){ for(const tf of TESTS){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env,timeout:300000}); }catch(e){ return true; } } return false; }
for(const [file,n,f,t] of JS){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mcen-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t));
  const k=run(Object.assign({},process.env,{CAT_ROOT:MD})); console.log((k?'killed  ':'SURVIVED')+' '+n); if(k) killed++; else surv++; fs.rmSync(MD,{recursive:true,force:true}); }
for(const [n,f,t] of HTMLM){ const src=fs.readFileSync(EDITOR,'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) html: ${n}`);surv++;continue;}
  const tmp=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'mcen-h-')),'editor.html'); fs.writeFileSync(tmp,src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'mceditor.commercial.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{EDITOR_HTML:tmp}),timeout:120000}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' html: '+n); if(k) killed++; else surv++; }
console.log(surv?`${surv} survived (${killed} killed)`:`all ${killed} mutants killed`); process.exit(surv?1:0);

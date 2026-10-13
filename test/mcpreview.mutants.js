/* Mutants for Manufacturer Center Release C (Dealer Preview) and the source holds it relies on. Each edit must make
   test/mcpreview.test.js or test/enrich.unit.test.js fail. */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const JS=[
 ['_preview.js','held drafts treated as published','r && readyKeys.has(r.page_key) && !have.has(r.page_key)','r && !have.has(r.page_key)'],
 ['_preview.js','a Ready draft placed over a live page','r && readyKeys.has(r.page_key) && !have.has(r.page_key)','r && readyKeys.has(r.page_key)'],
 ['_preview.js','the internal report handed to the shop','delete x.enrichment_flags; ',''],
 ['_preview.js','a missing SKU not counted','    if(!pc.length || !pp) missing.push(c);','    if(false) missing.push(c);'],
 ['_preview.js','a duplicate card not counted','    if(pc.length > 1 || (pBy[norm(c)] || []).length > 1 || tc.length > 1) dupes.push(c);','    if(false) dupes.push(c);'],
 ['_preview.js','a commercial change not counted','    if(diffs.length) commercial.push({ code: c, diffs });','    if(false) commercial.push({ code: c, diffs });'],
 ['_preview.js','a changed held SKU not caught','    if(!isReady && tp && pp && canon(strip(tp)) !== canon(strip(pp))){','    if(false){'],
 ['_preview.js','a retired SKU listed unnoticed','const retiredListed = retired.filter(r => tBy[norm(r.code)] || pBy[norm(r.code)])','const retiredListed = retired.filter(r => false)'],
 ['_preview.js','a Ready page missing a SKU unnoticed','    else if(want !== got) pageFaults.push(','    else if(false) pageFaults.push('],
 ['_preview.js','held words leaking unnoticed','leakNeedles.filter(n => propJson.indexOf(n) >= 0 && todayJson.indexOf(n) < 0 && readyJson.indexOf(n) < 0)','leakNeedles.filter(n => false)'],
 ['_preview.js','a Ready page excused for words it never had','const readyJson = JSON.stringify(drafts.filter(d => d && ready.some(r => r.page_key === d.page_key))','const readyJson = JSON.stringify(drafts.filter(d => d)'],
 ['_preview.js','enriched-only ignored','!(meta && meta.enriched_only === true),','true,'],
 ['_preview.js','freight words not compared','m2(fT.fee) === m2(fP.fee) && fw(fT) === fw(fP)','true'],
 ['_preview.js','the staff note on every card','      staff_note: held ? (waiting ? WAITING_NOTE : HELD_NOTE) : null,','      staff_note: HELD_NOTE,'],
 ['_preview.js','a page waiting for approval labelled as held for source review','      staff_note: held ? (waiting ? WAITING_NOTE : HELD_NOTE) : null,','      staff_note: held ? HELD_NOTE : null,'],
 ['_preview.js','storefront photos shown from the admin site (broken)','      image: abs(cardImage), card_image_chosen: ci, media,','      image: cardImage || "", card_image_chosen: ci, media,'],
 ['product-content.js','the proposal shows nothing new','return want.test(path) ? PREVIEW.proposedContentRows(rows, rowsAsPublished, keys) : rows;','return rows;'],
 ['_enrich.js','a source hold hides its issues','  return { status, label: STATUS_LABEL[status], issues, resolutions: res,','  return { status, label: STATUS_LABEL[status], issues: held ? [] : issues, resolutions: res,'],
 ['_enrich.js','a source hold not recognised','  const held = !!((res.hold && res.hold.choice === "hold_back") ||','  const held = !!((false) ||'],
 ['_enrich.js','badge art kept as a thumbnail','  pool = pool.filter(d => !d.promo);\n',''],
];
const TESTS=['enrich.unit.test.js','mcpreview.test.js','mcapproval.test.js'];
let surv=0, killed=0;
function run(env){ for(const tf of TESTS){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env,timeout:400000}); }catch(e){ return true; } } return false; }
for(const [file,n,f,t] of JS){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mcpv-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t));
  const k=run(Object.assign({},process.env,{CAT_ROOT:MD})); console.log((k?'killed  ':'SURVIVED')+' '+n); if(k) killed++; else surv++; fs.rmSync(MD,{recursive:true,force:true}); }
console.log(surv?`${surv} survived (${killed} killed)`:`all ${killed} mutants killed`); process.exit(surv?1:0);

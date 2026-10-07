const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const SRC=path.join(__dirname,'..','netlify','functions','catalog-api.js'), src=fs.readFileSync(SRC,'utf8');
const MD=fs.mkdtempSync(path.join(os.tmpdir(),'canon-')); fs.mkdirSync(MD,{recursive:true}); fs.copyFileSync(path.join(__dirname,'..','netlify','functions','_catalog-join.js'),MD+'/_catalog-join.js');
const M=[
 ['projection votes again (marker ignored)', "if(pj.hit){ const v = pick ? pick(pj.value) : pj.value;", "if(false){ const v = pick ? pick(pj.value) : pj.value;"],
 ['override written before the record', "        if(Object.keys(want).length){\n          let cc;\n          try{ cc=await commitCommercial(b.manufacturer, codeK, want, b.reviewer||\"product-catalog\"); }", "        if(false){\n          let cc;\n          try{ cc=await commitCommercial(b.manufacturer, codeK, want, b.reviewer||\"product-catalog\"); }"],
 ['record failure swallowed in save_override', "          catch(err){ return json(502,{error:\"record_write_failed\", message:\n            \"The master price record could not be updated, so nothing was saved: \"+String((err&&err.message)||err).slice(0,300)}); }\n          if(cc.migrated) merged=applyProjection(merged, cc.projection, wantStatus);", "          catch(err){ cc={migrated:false}; }\n          if(cc.migrated) merged=applyProjection(merged, cc.projection, wantStatus);"],
 ['failed record read treated as unmigrated', "  const rows=await sb(\"GET\",`product_skus?manufacturer=eq.${encodeURIComponent(mfr)}&select=code&limit=1`);\n  return !!(rows&&rows.length);", "  const rows=await sb(\"GET\",`product_skus?manufacturer=eq.${encodeURIComponent(mfr)}&select=code&limit=1`).catch(()=>[]);\n  return !!(rows&&rows.length);"],
 ['msrp rule dropped', "  if(newBase!=null && newBase>0 && !(\"msrp\" in want) && autoAfter){", "  if(false){"],
 ['msrp rule ignores the flag', "  if(newBase!=null && newBase>0 && !(\"msrp\" in want) && autoAfter){", "  if(newBase!=null && newBase>0 && !(\"msrp\" in want)){"],
 ['ladder not projected with a price', "  if(\"base_price\" in (want||{}) || \"tiers\" in (want||{})){\n    const lad=cleanTiers(after.tiers);", "  if(\"tiers\" in (want||{})){\n    const lad=cleanTiers(after.tiers);"],
 ['empty ladder projected as null', "    projection.tiers=lad?lad:[];", "    projection.tiers=lad?lad:null;"],
 ['projection not marked', "  if(fields.size) out.record_projection={fields:[...fields].sort(), at:new Date().toISOString()};", ""],
 ['reconcile reads lenient again', "            sb(\"GET\",`custom_products?manufacturer=eq.${e(mfr)}&select=*`),\n            sb(\"GET\",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch`),", "            sb(\"GET\",`custom_products?manufacturer=eq.${e(mfr)}&select=*`).catch(()=>[]),\n            sb(\"GET\",`product_overrides?manufacturer=eq.${e(mfr)}&select=code,patch`),"],
 ['catalog file 5xx read as empty', "  if(!r.ok) throw new Error(`catalog file for ${mfr}: HTTP ${r.status}`);", "  if(!r.ok) return [];"],
 ['missing file treated as an error', "  if(r.status===404) return [];\n  if(!r.ok) throw", "  if(!r.ok) throw"],
 ['bulk import skips the record', "          if(migratedLine){\n            const want={};", "          if(false){\n            const want={};"],
 ['retire does not touch record status', "          try{ const cc=await commitCommercial(mfr, code, {status:st, status_note:patch.disposition_note}, b.reviewer||\"retire\");", "          try{ const cc={migrated:false};"],
 ['restore does not reactivate record', "        { try{ const cc=await commitCommercial(mfr, code, {status:LIVE_STATUS}, b.reviewer||\"restore\");", "        { try{ const cc={migrated:false};"],
 ['clear_override guard removed', "        if(prC && Array.isArray(prC.fields) && prC.fields.length && b.force!==true)", "        if(false)"],
 ['flush mirrors nothing but reports nothing', "      await noteParity(slug, report.drift.length ? parityMessage(report) : null);", "      await noteParity(slug, null);"],
 ['authority without confirmation', "        if(b.confirm_parity!==true)\n", "        if(false)\n"],
 ['authority despite drift', "        if(stats.drift.length)\n          return json(409,{error:\"parity_drift\"", "        if(false)\n          return json(409,{error:\"parity_drift\""],
 ['parity ignores price differences', "      if(a!=null && b!=null && a!==b) drift.push({code:r.code, field:f, layers:a, record:b});", "      if(false) drift.push({code:r.code, field:f, layers:a, record:b});"],
 ['new product not created in record', "    }else{\n      await sb(\"POST\",\"product_skus\",", "    }else if(false){\n      await sb(\"POST\",\"product_skus\","],
];
let surv=0;
for(const [n,f,t] of M){ const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  fs.writeFileSync(MD+'/catalog-api.js',src.replace(f,t));
  let k=false; try{execFileSync('node',[path.join(__dirname,'canonical.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})});}catch(e){k=true;}
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k)surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

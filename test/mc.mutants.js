/* Mutants for Manufacturer Center Phases 2–3: each edit must make mcfreeze.test.js or mcverify.test.js fail. */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const M=[
 ['catalog-api.js','freeze gate skipped','      const frozenRefusal=await freezeGate(b, me);\n      if(frozenRefusal) return frozenRefusal;\n',''],
 ['catalog-api.js','freeze state read failure ignored','  catch(e){ return json(503,{error:"freeze_state_unreadable"','  catch(e){ return null; return json(503,{error:"freeze_state_unreadable"'],
 ['catalog-api.js','regression fix of any kind accepted','  if(!dd || dd.kind!=="regression_fix" || dd.manufacturer!==slug || dd.used_at)','  if(!dd)'],
 ['catalog-api.js','regression fix without a reason accepted','  if(!(id>0) || !reason) return json(400','  if(!(id>0)) return json(400'],
 ['catalog-api.js','token not sent to the database','  const fix=(method!=="GET" && REGRESSION) ? {"x-hcps-regression-fix":String(REGRESSION.id)} : {};','  const fix={};'],
 ['catalog-api.js','regression fix never spent','  if(REGRESSION && res && res.statusCode < 300){','  if(false){'],
 ['catalog-api.js','database refusal shown as 500','  if(res && res.statusCode >= 500 && /line_frozen/.test(String(res.body||""))){','  if(false){'],
 ['_mc.js','reconcile apply not commercial','  if(b.action === "reconcile") return b.apply === true;','  if(b.action === "reconcile") return false;'],
 ['_mc.js','retire not commercial','"merge_layers","merge_layers_bulk","merge_products","merge_products_bulk","unmerge_layers","unmerge_product",\n  "clear_override","set_group"]);','"merge_layers","merge_layers_bulk","merge_products","merge_products_bulk","unmerge_layers","unmerge_product",\n  "clear_override"]);'],
 ['_mc.js','omitted field written as empty','  const present = STAGE_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(r, f));','  const present = STAGE_FIELDS.filter(f => f !== "status" && f !== "status_note");'],
 ['_mc.js','clearing allowed without approval','        const approved = clearSet.has(f) && clearApproved;','        const approved = true;'],
 ['_mc.js','clearing allowed without a decision','        const approved = clearSet.has(f) && clearApproved;','        const approved = clearSet.has(f);'],
 ['catalog-api.js','old file date carried over','          else if(!before || String(before.source_file||"")!==file) o.effective_date=null;','          else {}'],
 ['catalog-api.js','unaccepted source staged','          if(source.status!=="accepted") return json(409','          if(false) return json(409'],
 ['_mc.js','engine drift ignored','  add(check("engine_in_sync", "Server pricing engine = live storefront code", engineSame,','  add(check("engine_in_sync", "Server pricing engine = live storefront code", true,'],
 ['_mc.js','render drift ignored','  add(check("render_in_sync", "Server card/freight rendering = live storefront code", renderSame,','  add(check("render_in_sync", "Server card/freight rendering = live storefront code", true,'],
 ['_mc.js','unrecorded products allowed','    add(check("every_product_has_record", "Every visible product has an active master record", !noRecord.length,','    add(check("every_product_has_record", "Every visible product has an active master record", true,'],
 ['_mc.js','source mismatch ignored','      [["base_price", i.base_price, r.base_price], ["msrp", i.msrp, r.msrp], ["map", i.map, r.map], ["dealer_unit_cost", i.parsed_unit_cost, r.dealer_unit_cost]]','      [["msrp", i.msrp, r.msrp], ["map", i.map, r.map], ["dealer_unit_cost", i.parsed_unit_cost, r.dealer_unit_cost]]'],
 ['_mc.js','missing case qty without decision allowed','      else if(i.parsed_case_qty == null) mis.push({ code: i.code, field: "case_qty", source: null, record: r.case_qty, note: "no case qty in source and no HCPS decision" });',''],
 ['_mc.js','derived unit notes allowed','    if(/\\$[\\d,.]+\\s*\\/\\s*unit/i.test(note)) cardIssues.push','    if(false) cardIssues.push'],
 ['_mc.js','retired listing ignored','    listed.forEach(r => rIssues.push({ code: r.code, issue: "listed on Partner 360" }));',''],
 ['_mc.js','broken images ignored','  add(check("images", "Every product image loads", !broken.length && !incomplete,','  add(check("images", "Every product image loads", true,'],
 ['_mc.js','fingerprint change ignored','    add(check("fingerprint", "Line fingerprint unchanged since baseline run #" + d.baseline.id, d.baseline.fingerprint === fp,','    add(check("fingerprint", "Line fingerprint unchanged since baseline run #" + d.baseline.id, true,'],
 ['_mc.js','blocking failures do not fail the run','  return { manufacturer: slug, result: failed.length ? "fail" : "pass",','  return { manufacturer: slug, result: "pass",'],
 ['catalog-api.js','run not saved','        if(b.save!==false){','        if(false){'],
 ['catalog-api.js','unreadable register read as empty','        }catch(e){ return json(503,{error:"mc_unreadable", message:"Manufacturer Center could not read its records: "','        }catch(e){ lines=[]; meta=[]; sources=[]; decisions=[]; runs=[]; } if(false){ return json(503,{error:"mc_unreadable", message:"Manufacturer Center could not read its records: "'],
 ['catalog-api.js','decision without a reason recorded','        if(!slug||!field||!reason) return json(400','        if(!slug||!field) return json(400'],
];
let surv=0;
for(const [file,n,f,to] of M){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1;
  if(c!==1){ console.log(`BAD ANCHOR(${c}) ${n}`); surv++; continue; }
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mc-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,to));
  const env=Object.assign({},process.env,{CAT_ROOT:MD});
  let k=false; for(const tf of ['mcfreeze.test.js','mcverify.test.js']){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env}); }catch(e){ k=true; break; } }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

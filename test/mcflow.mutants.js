/* Mutants for Manufacturer Center Phase 6 (the guided workflow, the approval gates, the dry runs and the frozen
   read-only rule): each edit must make test/mcflow.test.js or test/mcgates.test.js fail. */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const M=[
 ['catalog-api.js','a non-president reaches Manufacturer Center','    if(me.role!=="president") return json(403,{error:"President only"});','    if(false) return json(403,{error:"President only"});'],
 ['catalog-api.js','staging written without Approval 1','        const g1=await gateCheck(mfr,"stage",b.approval_decision_id,{plan_hash:stageHash, plan_kind:"records"});\n        if(g1.error) return g1.error;','        const g1={decision:{id:0}};'],
 ['catalog-api.js','staging approval never spent','        await useDecision(g1.decision.id, by);\n',''],
 ['_mc.js','approval covers any plan','  for(const [k, v] of Object.entries(want || {})) if(canon(hv[k]) !== canon(v))','  for(const [k, v] of []) if(canon(hv[k]) !== canon(v))'],
 ['_mc.js','used approval accepted again','  if(d.used_at) return','  if(false) return'],
 ['_mc.js','another line\'s approval accepted','  if(d.manufacturer !== manufacturer) return','  if(false) return'],
 ['_mc.js','any decision accepted as an approval','  if(d.kind !== "acceptance" || d.field !== "gate:" + gate) return','  if(false) return'],
 ['catalog-api.js','activation without Approval 2','        if(b.dry_run!==true || b.approval_decision_id!=null){\n          g2=await gateCheck(slug,"activate",b.approval_decision_id,null);\n          if(g2.error) return g2.error;','        if(b.dry_run!==true || b.approval_decision_id!=null){\n          g2={decision:{id:0,hcps_value:{}}};'],
 ['catalog-api.js','activation run not re-checked','          const runP=await activationRunCheck(slug, g2.decision.hcps_value&&g2.decision.hcps_value.run_id);\n          if(runP) return runP;\n',''],
 ['catalog-api.js','activation approval never spent','        await useDecision(g2.decision.id, String((me&&me.email)||"president").slice(0,80));\n',''],
 ['catalog-api.js','activation dry run writes','        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,manufacturer:slug,authoritative:true,parity:','        if(false) return json(200,{ok:true,dry_run:true,manufacturer:slug,authoritative:true,parity:'],
 ['_mc.js','failing run accepted for activation','  if(run.result !== "pass") return','  if(false) return'],
 ['_mc.js','any phase accepted for activation','  if(run.phase !== "pre") return','  if(false) return'],
 ['_mc.js','record change after the run ignored','  if(lastRecordChange && String(lastRecordChange) > String(run.run_at)) return','  if(false) return'],
 ['_mc.js','another line\'s run accepted','  if(run.manufacturer !== manufacturer) return "run "','  if(false) return "run "'],
 ['catalog-api.js','freight written without Approval 1','          const g=await gateCheck(slug,"stage",b.approval_decision_id,{plan_hash:fh, plan_kind:"freight"}); if(g.error) return g.error;','          const g={decision:{id:0}};'],
 ['catalog-api.js','untraced freight terms accepted','        if(!(sid>0)&&!(did>0)) return json(400,{error:"trace_required"','        if(false) return json(400,{error:"trace_required"'],
 ['catalog-api.js','invalid freight terms accepted','          if(!before.engine.validFreightTerms(clean)) return','          if(false) return'],
 ['catalog-api.js','freight dry run writes','          if(b.dry_run===true) return json(200,{ok:true,dry_run:true,plan_hash:fh','          if(false) return json(200,{ok:true,dry_run:true,plan_hash:fh'],
 ['catalog-api.js','an approval forged as an ordinary decision','        if(/^gate:/i.test(field)) return json(400,{error:"gate_not_here"','        if(false) return json(400,{error:"gate_not_here"'],
 ['catalog-api.js','decision dry run writes','        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,decision:row});\n',''],
 ['catalog-api.js','registration dry run writes','        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,would_insert:row,','        if(false) return json(200,{ok:true,dry_run:true,would_insert:row,'],
 ['catalog-api.js','acceptance dry run writes','        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,would_update:','        if(false) return json(200,{ok:true,dry_run:true,would_update:'],
 ['catalog-api.js','import dry run writes','        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,would_insert:out.length,','        if(false) return json(200,{ok:true,dry_run:true,would_insert:out.length,'],
 ['catalog-api.js','approval dry run records','        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,would_record:row});\n        let ins; try{ ins=await sb("POST","mfr_decisions",row,{Prefer:"return=representation"}); }\n        catch(err){ return json(502,{error:"approval_not_recorded"','        let ins; try{ ins=await sb("POST","mfr_decisions",row,{Prefer:"return=representation"}); }\n        catch(err){ return json(502,{error:"approval_not_recorded"'],
 ['catalog-api.js','a source imported twice','        if(have&&have.length) return json(409,{error:"already_imported"','        if(false) return json(409,{error:"already_imported"'],
 ['catalog-api.js','an unaccepted source imported','        if(src.status!=="accepted"||src.kind!=="price_list") return json(409','        if(false) return json(409'],
 ['catalog-api.js','a source registered without a received date','        if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(rec)) return json(400,{error:"received_date','        if(false) return json(400,{error:"received_date'],
 ['catalog-api.js','a stored file overwritten','"x-upsert":"false"},body:bytes});','"x-upsert":"true"},body:bytes});'],
 ['catalog-api.js','Approval 2 for any run','          const p=await activationRunCheck(slug, b.run_id); if(p) return p;\n',''],
 ['_mc.js','workflow writes allowed on a frozen line','  "mc_register_source","mc_accept_source","mc_import_source_rows","mc_approve_gate","mc_set_freight_terms"]);','  "mc_noop"]);'],
 ['_mc.js','a pack-only decision applied to single items','      if(lineWide && d.hcps_value.applies_to === "packs" && !isPack) continue;\n',''],
 ['_mc.js','a SKU with no unit staged without a decision','      if(proposed.case_qty == null && proposed.uom == null) needs.push','      if(false) needs.push'],
 ['_mc.js','a regression_fix read as an interpretation','const DECIDING_KINDS = ["interpretation", "conflict", "exception"];','const DECIDING_KINDS = ["interpretation", "conflict", "exception", "regression_fix"];'],
 ['_mc.js','older decision wins','    .slice().sort((a, b) => String(a.decided_at || "").localeCompare(String(b.decided_at || "")) || (a.id || 0) - (b.id || 0));','    .slice().sort((a, b) => String(b.decided_at || "").localeCompare(String(a.decided_at || "")) || (b.id || 0) - (a.id || 0));'],
 ['_mc.js','plan hash depends on key order','Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}") : JSON.stringify(v === undefined ? null : v);','Object.keys(v).map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}") : JSON.stringify(v === undefined ? null : v);'],
];
let surv=0;
for(const [file,n,f,t] of M){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mcflow-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t)); const env=Object.assign({},process.env,{CAT_ROOT:MD});
  let k=false; for(const tf of ['mcgates.test.js','mcflow.test.js']){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env,timeout:240000}); }catch(e){ k=true; break; } }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

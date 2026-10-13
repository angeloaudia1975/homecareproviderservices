/* Mutants for Angelo's 2026-10-12 fixes: partial publications (runs #17–#19), pages already live, the current Gold
   Standard, saved President edits and the published-page correction under a scoped regression_fix. Each edit must make
   test/mccorrection.test.js (or test/mcapproval.test.js / test/mcpublish.test.js) fail. No SQL changed. */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const JS=[
 ['product-content.js','the post-check counts a waiting Ready page as missing (runs #17–#19)','pages: PUBLISH.pagesForPublication(S2.pages, PL.approval.pages), drafts: X2.pages,','pages: S2.pages, drafts: X2.pages,'],
 ['_publish.js','a page already live treated as held','  const held = (pages || []).filter(p => !isReady(p) && !isLive(p));','  const held = (pages || []).filter(p => !isReady(p));'],
 ['_publish.js','the pages already live forgotten by the visibility checks','  return [...new Set((Array.isArray(a.pages) ? a.pages : []).concat(Array.isArray(a.live_before) ? a.live_before : []))].sort();','  return [...new Set((Array.isArray(a.pages) ? a.pages : []))].sort();'],
 ['product-content.js','a live page changed behind a publication not caught','(PL.live || []).every((h, n) => PUBLISH.canon(liveNow[n]) === PUBLISH.canon(h.row))','true'],
 ['_approval.js','the saved edit hidden once another choice is active','    a.edit_saved = es ? {','    a.edit_saved = es && chosen && chosen.choice === "edit" ? {'],
 ['_mc.js','a later failed run shown as the status','  const g = list.find(r => r.result === "pass" && (r.phase === "baseline" || r.phase === "post") && r.fingerprint);','  const g = list[0] && list[0].result === "pass" ? list[0] : null;'],
 ['_mc.js','the scoped fix accepted as a general pass','  if(v && v.scope === "content_correction") return "regression_fix "','  if(false) return "regression_fix "'],
 ['_publish.js','a correction changes fields outside its scope','    if(outside.length) problems.push(','    if(false) problems.push('],
 ['_publish.js','a correction may name an area outside the fix','  Object.keys(corr).forEach(a => { if(areas.indexOf(a) < 0) problems.push(','  Object.keys(corr).forEach(a => { if(false) problems.push('],
 ['_publish.js','other pages left out of the correction hash','    others: others.map(o => [o.page_key, o.row]), decisions: lineDecisions,','    others: [], decisions: lineDecisions,'],
 ['_publish.js','a spent fix accepted','  if(rf.used_at) return "regression_fix " + rf.id + " is already used";','  if(false) return "";'],
 ['product-content.js','correction text that differs from the approval accepted','                if (value && PUBLISH.canon(value) !== PUBLISH.canon(d.hcps_value.value)) return reply(400','                if (false) return reply(400'],
 ['product-content.js','an outdated correction approval carried out','          if (D.hcps_value.plan_hash !== CP.plan_hash) return reply(409','          if (false) return reply(409'],
 ['product-content.js','the fix never spent','            try { await fetch(rest(`mfr_decisions?id=eq.${rf.id}&used_at=is.null`), { method: \'PATCH\'','            try { if (false) await fetch(rest(`mfr_decisions?id=eq.${rf.id}&used_at=is.null`), { method: \'PATCH\''],
 ['catalog-api.js','a correction spends the enrichment window','const open=(D.hcps_value&&D.hcps_value.correction)?[]:await sb(','const open=await sb('],
 ['catalog-api.js','finalize forgets the pages already live','want=PUB.expectedVisible(D.hcps_value);','want=((D.hcps_value&&D.hcps_value.pages)||[]).slice().sort();'],
];
let surv=0, killed=0;
const TESTS=['mccorrection.test.js','mcapproval.test.js','mcpublish.test.js'];
for(const [file,n,f,t] of JS){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mccor-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t)); const env=Object.assign({},process.env,{CAT_ROOT:MD});
  let k=false; for(const tf of TESTS){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env,timeout:900000}); }catch(e){ k=true; break; } }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(k) killed++; else surv++; fs.rmSync(MD,{recursive:true,force:true}); }
console.log(surv?`${surv} survived (${killed} killed)`:`all ${killed} mutants killed`); process.exit(surv?1:0);

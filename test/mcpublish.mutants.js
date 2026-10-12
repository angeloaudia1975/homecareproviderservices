/* Mutants for Manufacturer Center Release D (Publish & Verify). Each function edit must make test/mcpublish.test.js
   (or test/enrich.unit.test.js) fail; each SQL edit must make test/mc-publication.pg.test.js fail (skipped — and not
   counted — when there is no Postgres). */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync,spawnSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions'), SQL=path.join(__dirname,'..','supabase','mc_release_d_publication.sql');
const JS=[
 ['_publish.js','a held page published','  const isReady = p => p.status === "ready";','  const isReady = p => p.status === "ready" || p.status === "held_back";'],
 ['_publish.js','the same picture promoted twice (duplicate thumbnail)','    return same ? same.url : u;','    return u;'],
 ['_publish.js','an option photo left in the draft folder','    if(o.image) o.image = used(o.image, "option photo · " + o.sku);','    if(false) o.image = used(o.image, "option photo · " + o.sku);'],
 ['_publish.js','held drafts left out of the plan hash','    held: heldOut.map(h => ({ page_key: h.page_key, status: h.status, issues: h.issues, holds: h.holds, row: h.row })),','    held: [],'],
 ['_publish.js','the commercial record left out of the plan hash','    decisions: lineDecisions, records: (records || []).slice()','    decisions: lineDecisions, records: [].slice()'],
 ['_publish.js','a failing dealer preview approved anyway','  else if(!preview.pass) problems.push(','  else if(false) problems.push('],
 ['product-content.js','a stale dry run approved','            if (String(body.plan_hash || \'\') !== PL.plan_hash) return reply(409','            if (false) return reply(409'],
 ['product-content.js','an outdated approval carried out','          if (!D.hcps_value || D.hcps_value.plan_hash !== PL.plan_hash) return reply(409','          if (!D.hcps_value) return reply(409'],
 ['product-content.js','published before the live photos exist','          if (missing.length) return reply(409','          if (false) return reply(409'],
 ['product-content.js','a changed draft photo copied anyway','                if (ENRICH.sha256(buf) !== it.sha) throw new Error','                if (false) throw new Error'],
 ['product-content.js','a failed verification not rolled back','          let rolled = null; try { rolled = await rpc(\'mfr_content_publication_rollback\', { p_decision: did, p_by: who }); }','          let rolled = null; try { rolled = { ok: true }; }'],
 ['product-content.js','live ≠ approved not checked','            add(\'live_equals_approved\', \'Live dealer view = the approved dry run, product by product\', cmp.same,','            add(\'live_equals_approved\', \'Live dealer view = the approved dry run, product by product\', true,'],
 ['product-content.js','a held page made visible not caught','add(\'only_approved_pages_visible\', \'Exactly the approved pages are visible (no held page)\', PUBLISH.canon(visible) === PUBLISH.canon(PL.approval.pages.slice().sort()),','add(\'only_approved_pages_visible\', \'Exactly the approved pages are visible (no held page)\', true,'],
 ['catalog-api.js','finalize leaves the window open','          if(open&&open[0]){ await sb("PATCH"','          if(false){ await sb("PATCH"'],
 ['catalog-api.js','a publication finalized twice','        if((passRuns||[]).some(r=>(r.checks||[]).some(c=>c&&c.id==="publication"&&c.detail&&Number(c.detail.decision)===did)))','        if(false)'],
 ['_mc.js','the content fingerprint never enforced','      true, { fingerprint: cfp, products: contentLines.length, lines: contentLines, gold: !!d.contentGold }, d.contentGold ? "blocking" : "advisory"));','      true, { fingerprint: cfp, products: contentLines.length, lines: contentLines, gold: !!d.contentGold }, "advisory"));'],
 ['_mc.js','a content change not caught','wasC.detail.fingerprint === cfp,','true,'],
 ['_enrich.js','a published page shown as a live-page conflict','    if(own){ p.published = own.page_key; p.page_key = own.page_key; }','    if(false){ p.published = own.page_key; p.page_key = own.page_key; }'],
];
const SQLM=[
 ['a page changed after the dry run published anyway','    if cur is distinct from (d.hcps_value -> \'before\' -> k) then','    if false then'],
 ['a draft-folder image published','    bad := public.mfr_live_media_problem(aft, d.manufacturer);','    bad := null;'],
 ['a wrong plan hash accepted','  if coalesce(d.hcps_value ->> \'plan_hash\', \'\') = \'\' or d.hcps_value ->> \'plan_hash\' <> coalesce(p_plan_hash, \'\') then','  if false then'],
 ['an approval writes pages it does not name','           and (d.hcps_value -> \'pages\') ? OLD.page_key\n','\n'],
 ['the Gold Standard rolled back','  if exists (select 1 from public.mfr_verification_runs r','  if false and exists (select 1 from public.mfr_verification_runs r'],
 ['a spent approval reused','  if d.used_at is not null then\n    raise exception \'publication_refused: decision % is already spent','  if false then\n    raise exception \'publication_refused: decision % is already spent'],
 ['publish executable by anon','    execute \'revoke all on function public.mfr_content_publish(bigint, text, text) from anon\';','    execute \'grant execute on function public.mfr_content_publish(bigint, text, text) to anon\';'],
];
let surv=0, killed=0;
const TESTS=['mcpublish.test.js','enrich.unit.test.js'];
for(const [file,n,f,t] of JS){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mcpub-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t)); const env=Object.assign({},process.env,{CAT_ROOT:MD});
  let k=false; for(const tf of TESTS){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env,timeout:900000}); }catch(e){ k=true; break; } }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(k) killed++; else surv++; fs.rmSync(MD,{recursive:true,force:true}); }
const pg=spawnSync(process.env.PGTEST_PSQL||'psql',['-X','-q','-d','postgres','-c','select 1'],{encoding:'utf8'});
if(pg.status!==0) console.log('SQL mutants skipped: no Postgres');
else for(const [n,f,t] of SQLM){ const src=fs.readFileSync(SQL,'utf8'); const c=src.split(f).length-1; if(c<1){console.log(`BAD ANCHOR(${c}) sql: ${n}`);surv++;continue;}
  const tmp=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'mcpub-s-')),'d.sql'); fs.writeFileSync(tmp,src.split(f).join(t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'mc-publication.pg.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{MC_D_SQL:tmp}),timeout:300000}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' sql: '+n); if(k) killed++; else surv++; }
console.log(surv?`${surv} survived (${killed} killed)`:`all ${killed} mutants killed`); process.exit(surv?1:0);

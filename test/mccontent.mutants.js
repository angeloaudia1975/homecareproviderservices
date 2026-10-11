/* Mutants for Manufacturer Center Release A (the content freeze + enrichment windows). Each edit must make a test
   fail: the function edits test/mccontentfreeze.test.js (and the drafts proof), the SQL edits
   test/mc-content-freeze.pg.test.js (skipped — and so not counted — when there is no Postgres). */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync,spawnSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const REPO=path.join(__dirname,'..');
const JS=[
 ['_mc.js','content actions not protected on a frozen line','function isFrozenProtected(b){ return isCommercialAction(b) || !!(b && CONTENT_ACTIONS.has(b.action)); }','function isFrozenProtected(b){ return isCommercialAction(b); }'],
 ['catalog-api.js','media rows not traced to their line','  if(!slug && MC.MEDIA_ID_ACTIONS.has(b.action)){','  if(false){'],
 ['_mc.js','a window publishes through set_status','  if(a === "set_status" && isVisibleStatus(b.status)) return publishing;\n',''],
 ['_mc.js','a window publishes through bulk','  if(a === "bulk" && b.patch && isVisibleStatus(b.patch.status)) return publishing;\n',''],
 ['_mc.js','a window publishes through upsert','if(rows.some(r => r && isVisibleStatus(r.status))) return publishing;','if(false) return publishing;'],
 ['_mc.js','a window reaches related products','"merge_products","delete_product","create_product","save_sizing","bulk","undo"]);','"merge_products","delete_product","create_product","save_sizing","bulk","undo","save_related"]);'],
 ['_mc.js','any decision kind accepted as an exception','  if(d.kind !== kind) return','  if(false) return'],
 ['_mc.js','another line\'s exception accepted','  if(d.manufacturer !== slug) return','  if(false) return'],
 ['_mc.js','a spent fix or closed window accepted','  if(d.used_at != null) return kind','  if(false) return kind'],
 ['_mc.js','a change spanning a frozen line and another let through','  if(L.length > 1) return { refusal: { status: 423, body: { ok: false, error: "line_frozen"','  if(false) return { refusal: { status: 423, body: { ok: false, error: "line_frozen"'],
 ['_mc.js','an unreadable freeze state treated as not frozen','  catch(e){ return { refusal: { status: 503, body: { ok: false, error: "freeze_state_unreadable",','  catch(e){ return open; return { refusal: { status: 503, body: { ok: false, error: "freeze_state_unreadable",'],
 ['_mc.js','an applied migration not counted as a write','(b.action === "migrate_legacy" && b.apply === true)','b.action === "migrate_legacy"'],
 ['images-api.js','an enrichment window opens images-api','const g=await MC.contentGate({body:b, lines:[mfr], read:path=>sb("GET",path), windowRule:null});','const g=await MC.contentGate({body:b, lines:[mfr], read:path=>sb("GET",path), windowRule:MC.windowProblem});'],
 ['images-api.js','images-api writes skip the gate','      if(MC.isImageWrite(b) && mfr){','      if(false){'],
 ['images-api.js','a migration across lines writes frozen lines','        if(b.apply===true && !mfr){','        if(false){'],
 ['images-api.js','the regression_fix not sent with image writes','...(method!=="GET"?IMG_EXCEPTION:{}),','...({}),'],
 ['images-api.js','an image regression_fix never spent','  if(IMG_REGRESSION && res && res.statusCode<300){','  if(false){'],
 ['product-content.js','product-content writes skip the gate','      if (MC.PC_WRITE_ACTIONS.has(action) && action !== \'recategorize\') {','      if (false) {'],
 ['product-content.js','undo not traced to the changed line','        if (action === \'undo\' && body.id != null) {','        if (false) {'],
 ['product-content.js','upsert rows not traced to their lines','        if (action === \'upsert\') (Array.isArray(body.rows)','        if (false) (Array.isArray(body.rows)'],
 ['product-content.js','the exception not sent with content writes','  }, EXCEPTION_HEADERS, extra || {});','  }, extra || {});'],
 ['product-content.js','a content regression_fix never spent','  if (PC_REGRESSION && res && res.statusCode < 300) {','  if (false) {'],
 ['product-content.js','the database\'s refusal not read as 423','res.statusCode >= 400 && res.statusCode !== 423 && /line_frozen/.test(String(res.body || \'\'))','false'],
 ['product-content.js','re-categorize moves frozen lines\' pages','        const rows = (all || []).filter(r => frozenSlugs.indexOf(r.manufacturer) < 0);','        const rows = (all || []);'],
 ['product-content.js','approve patches any field','if (SAVE_FIELDS.indexOf(k) >= 0 && k !== \'manufacturer\') extra[k] = body.patch[k];','extra[k] = body.patch[k];'],
 ['product-content.js','approve not logged','        if (r.ok) await logHistory({ manufacturer: m, page_key: body.page_key, action: action,','        if (false) await logHistory({ manufacturer: m, page_key: body.page_key, action: action,'],
 ['catalog-api.js','a window opened on an unfrozen line','        if(meta[0].frozen!==true) return json(409,{error:"not_frozen"','        if(false) return json(409,{error:"not_frozen"'],
 ['catalog-api.js','two windows open at once','        if(open&&open.length) return json(409,{error:"window_already_open"','        if(false) return json(409,{error:"window_already_open"'],
 ['catalog-api.js','opening a window has no dry run','        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,would_record:row});\n        let ins; try{ ins=await sb("POST","mfr_decisions",row,{Prefer:"return=representation"}); }\n        catch(e2){ return json(502,{error:"window_not_opened"','        let ins; try{ ins=await sb("POST","mfr_decisions",row,{Prefer:"return=representation"}); }\n        catch(e2){ return json(502,{error:"window_not_opened"'],
 ['catalog-api.js','closing a window has no dry run','        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,would_close:open[0],stamp});\n',''],
 ['catalog-api.js','a window recorded as an ordinary decision','        if(kind==="enrichment_window") return json(400,{error:"window_not_here"','        if(false) return json(400,{error:"window_not_here"'],
 ['catalog-api.js','the self-test ignores what each attempt expects','const notBlocked=rows.filter(x=>x.result!==x.expect && SKIP.indexOf(x.result)<0);','const notBlocked=rows.filter(x=>x.result==="NOT BLOCKED");'],
 ['catalog-api.js','the self-test passes without the content guard','pass:commercialRows.length>0 && contentRows.length>0 && !contentError && !notBlocked.length,','pass:commercialRows.length>0 && !notBlocked.length,'],
 ['catalog-api.js','the overview hides an open window',' enrichment_window:((dec.find(x=>x.kind==="enrichment_window"&&!x.used_at))||{}).id||null,',''],
];
const SQLF='mc_release_a_content_freeze.sql';
const SQL=[
 ['a window lets a visible page through','    if not coalesce(vis_old, false) and not coalesce(vis_new, false) then','    if true then'],
 ['a window covers every protected table',"  if win ~ '^\\d+$' and TG_TABLE_NAME in ('product_content', 'product_content_sources')","  if win ~ '^\\d+$'"],
 ['a window of another line opens this one',"where d.id = win::bigint and d.kind = 'enrichment_window' and d.manufacturer = v_slug and d.used_at is null) then","where d.id = win::bigint and d.kind = 'enrichment_window' and d.used_at is null) then"],
 ['a closed window still opens',"where d.id = win::bigint and d.kind = 'enrichment_window' and d.manufacturer = v_slug and d.used_at is null) then","where d.id = win::bigint and d.kind = 'enrichment_window' and d.manufacturer = v_slug) then"],
 ['a window moves rows between lines','     and (v_old is null or v_old = v_slug) and (v_new is null or v_new = v_slug)\n',''],
 ['hiding the whole line not guarded','              or NEW.active is distinct from OLD.active\n',''],
 ['related products not guarded',"foreach t in array array['product_content','product_content_sources','product_media','product_links','product_related','product_overrides','custom_products'] loop","foreach t in array array['product_content','product_content_sources','product_media','product_links','product_overrides','custom_products'] loop"],
 ['every update let through',"      touched := (to_jsonb(NEW) - 'updated_at' - 'updated_by' - 'code_norm') is distinct from (to_jsonb(OLD) - 'updated_at' - 'updated_by' - 'code_norm');","      touched := false;"],
 ['another line\'s regression_fix opens this one',"where d.id = tok::bigint and d.kind = 'regression_fix' and d.manufacturer = v_slug and d.used_at is null) then","where d.id = tok::bigint and d.kind = 'regression_fix' and d.used_at is null) then"],
 ['two windows may be open at once','create unique index if not exists mfr_decisions_one_open_window\n  on public.mfr_decisions (manufacturer) where kind = \'enrichment_window\' and used_at is null;','select 1;'],
 ['the self-test calls a miss a block',"when sqlerrm = 'mc_selftest_not_blocked' then (case when a.expect = 'allowed' then 'allowed' else 'NOT BLOCKED' end)","when sqlerrm = 'mc_selftest_not_blocked' then 'blocked'"],
 ['anon may execute the guard',"execute 'revoke all on function public.mfr_content_guard() from anon'","perform 1"],
 ['a row moved INTO a frozen line not checked','    if v_new is not null then select m.frozen into f_new','    if false then select m.frozen into f_new'],
];
let surv=0, killed=0;
for(const [file,n,f,t] of JS){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mccontent-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t)); const env=Object.assign({},process.env,{CAT_ROOT:MD});
  let k=false; for(const tf of ['mccontentfreeze.test.js','mccontentdrafts.test.js']){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env,timeout:240000}); }catch(e){ k=true; break; } }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(k) killed++; else surv++; fs.rmSync(MD,{recursive:true,force:true}); }
const pg=spawnSync(process.env.PGTEST_PSQL||'psql',['-X','-q','-d','postgres','-c','select 1'],{encoding:'utf8'});
if(pg.status!==0) console.log('SQL mutants skipped: no Postgres');
else for(const [n,f,t] of SQL){ const src=fs.readFileSync(path.join(REPO,'supabase',SQLF),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) sql: ${n}`);surv++;continue;}
  const R=fs.mkdtempSync(path.join(os.tmpdir(),'mccontent-sql-'));
  fs.cpSync(path.join(REPO,'supabase'),path.join(R,'supabase'),{recursive:true}); fs.cpSync(path.join(REPO,'test'),path.join(R,'test'),{recursive:true});
  fs.copyFileSync(path.join(REPO,'migrate-phase2-product-skus.sql'),path.join(R,'migrate-phase2-product-skus.sql'));
  fs.writeFileSync(path.join(R,'supabase',SQLF),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(R,'test','mc-content-freeze.pg.test.js')],{stdio:'pipe',env:process.env,timeout:240000}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' sql: '+n); if(k) killed++; else surv++; fs.rmSync(R,{recursive:true,force:true}); }
console.log(surv?`${surv} survived (${killed} killed)`:`all ${killed} mutants killed`); process.exit(surv?1:0);

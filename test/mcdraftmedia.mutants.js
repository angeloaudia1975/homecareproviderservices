/* Mutants for Manufacturer Center Release B gate 1 (draft media under an enrichment window). Each edit must make a
   test fail: the function edits test/mcdraftmedia.test.js (and the Release A freeze tests), the SQL edits
   test/mc-draft-media.pg.test.js (skipped — and so not counted — when there is no Postgres). */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync,spawnSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const REPO=path.join(__dirname,'..');
const JS=[
 ['_mc.js','a window accepted on an unfrozen line it does not belong to','    if(!frozen.length){\n      const id = parseInt(typeof ew === "object" ? ew.decision_id : ew, 10);','    if(false){\n      const id = parseInt(typeof ew === "object" ? ew.decision_id : ew, 10);'],
 ['_mc.js','a window accepted across several lines','    if(L.length > 1) return { refusal: { status: 423, body: { ok: false, error: "enrichment_window_invalid"','    if(false) return { refusal: { status: 423, body: { ok: false, error: "enrichment_window_invalid"'],
 ['_mc.js','images-api takes a window','    if(!windowRule) return { refusal: { status: 423, body: { ok: false, error: "outside_enrichment_window"','    if(false) return { refusal: { status: 423, body: { ok: false, error: "outside_enrichment_window"'],
 ['_mc.js','the image rule ignores the window number','"/drafts/w" + parseInt(winId, 10) + "/[^?#\\\\s]+$"','"/drafts/w" + parseInt(winId, 10) + "[^?#\\\\s]*$"'],
 ['_mc.js','the image rule ignores the host','"^https://[a-z0-9]+\\\\.supabase\\\\.co/storage','"^https://[^/]+/storage'],
 ['_mc.js','options not inspected for images','["image", "images_gallery", "skus", "options"].forEach','["image", "images_gallery", "skus"].forEach'],
 ['product-content.js','window uploads not filed under the window folder',"  return PC_WINDOW ? MC.draftMediaPrefix(m, PC_WINDOW.id) + key : `${m}/${pageKey}`;","  return `${m}/${pageKey}`;"],
 ['product-content.js','the page key not cleaned inside the window folder',"const key = String(pageKey || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'page';","const key = String(pageKey || '');"],
 ['product-content.js','the window not taken from the gate','        PC_WINDOW = g.window || null;\n',''],
 ['product-content.js','window uploads may overwrite',"'content-type': ct, 'x-upsert': PC_WINDOW ? 'false' : 'true' },\n          body: buf","'content-type': ct, 'x-upsert': 'true' },\n          body: buf"],
 ['product-content.js','another folder\'s HCPS file reused under a window',"&& (!PC_WINDOW || MC.isDraftMediaUrl(src, m, PC_WINDOW.id))) return reply(200, { ok: true, url: src, skipped: true });",") return reply(200, { ok: true, url: src, skipped: true });"],
];
const SQLF='mc_release_b_draft_media.sql';
const SQL=[
 ['a window edits a page it did not build',"    if TG_OP <> 'INSERT' and OLD.draft_window is distinct from win::bigint then","    if false then"],
 ['a draft may carry a live status switched off',"    if TG_OP <> 'DELETE' and NEW.status in ('published','active','discontinued') then\n      raise exception 'line_frozen: % — under an enrichment window a draft never gets","    if false then\n      raise exception 'line_frozen: % — under an enrichment window a draft never gets"],
 ['images on a draft not checked',"    if bad_url is not null then","    if false then"],
 ['the draft is not stamped with its window',"    NEW.draft_window := win::bigint;\n",""],
 ['the image rule ignores the window number',"|| '/drafts/w' || p_win::text || '/[^?#[:space:]]+$';","|| '/drafts/w' || p_win::text || '[^?#[:space:]]*$';"],
 ['the image rule ignores the line folder',"         || regexp_replace(p_slug, '([^a-z0-9])', '\\\\\\1', 'g') || '/drafts/w'","         || '[^/]+' || '/drafts/w'"],
 ['the image rule accepts any host',"pre := '^https://[a-z0-9]+\\.supabase\\.co/storage","pre := '^https://[^/]+/storage"],
 ['the image rule accepts a query string',"'/[^?#[:space:]]+$';","'/.+$';"],
 ['the gallery not inspected',"jsonb_build_array(p_row -> 'image', p_row -> 'images_gallery', p_row -> 'skus', p_row -> 'options'),","jsonb_build_array(p_row -> 'image', p_row -> 'skus', p_row -> 'options'),"],
 ['SKU and option images not inspected',"jsonb_build_array(p_row -> 'image', p_row -> 'images_gallery', p_row -> 'skus', p_row -> 'options'),","jsonb_build_array(p_row -> 'image', p_row -> 'images_gallery'),"],
 ['relative catalog paths treated as not links',"    if u ~* '^\\s*(https?:|//|/)' and u !~ pre then","    if u ~* '^\\s*https?:' and u !~ pre then"],
 ['a closed window tested as open (self-test)',"              update public.mfr_decisions set used_at = now(), used_by = 'mfr_content_guard_selftest' where id = wid;\n",""],
 ['another line\'s window tested as its own (self-test)',"              perform set_config('request.headers', json_build_object('x-hcps-enrichment-window', w2::text)::text, true);\n",""],
 ['content_resolution not a decision kind',"'acceptance','enrichment_window','content_resolution'));","'acceptance','enrichment_window'));"],
 ['the image rule executable by anon',"    execute 'revoke all on function public.mfr_draft_media_problem(jsonb, text, bigint) from anon';\n",""],
];
let surv=0, killed=0;
for(const [file,n,f,t] of JS){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mcdm-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t)); const env=Object.assign({},process.env,{CAT_ROOT:MD});
  let k=false; for(const tf of ['mcdraftmedia.test.js','mccontentfreeze.test.js']){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env,timeout:240000}); }catch(e){ k=true; break; } }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(k) killed++; else surv++; fs.rmSync(MD,{recursive:true,force:true}); }
const pg=spawnSync(process.env.PGTEST_PSQL||'psql',['-X','-q','-d','postgres','-c','select 1'],{encoding:'utf8'});
if(pg.status!==0) console.log('SQL mutants skipped: no Postgres');
else for(const [n,f,t] of SQL){ const src=fs.readFileSync(path.join(REPO,'supabase',SQLF),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) sql: ${n}`);surv++;continue;}
  const R=fs.mkdtempSync(path.join(os.tmpdir(),'mcdm-sql-'));
  fs.cpSync(path.join(REPO,'supabase'),path.join(R,'supabase'),{recursive:true}); fs.cpSync(path.join(REPO,'test'),path.join(R,'test'),{recursive:true});
  fs.copyFileSync(path.join(REPO,'migrate-phase2-product-skus.sql'),path.join(R,'migrate-phase2-product-skus.sql'));
  fs.writeFileSync(path.join(R,'supabase',SQLF),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(R,'test','mc-draft-media.pg.test.js')],{stdio:'pipe',env:process.env,timeout:240000}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' sql: '+n); if(k) killed++; else surv++; fs.rmSync(R,{recursive:true,force:true}); }
console.log(surv?`${surv} survived (${killed} killed)`:`all ${killed} mutants killed`); process.exit(surv?1:0);

/* Mutants for Approve Content & Images (2026-10-12). Each function edit must make test/mcapproval.test.js (or, for the
   older paths it touches, test/mcpublish.test.js) fail; each SQL edit must make test/mc-approval.pg.test.js fail
   (skipped — and not counted — when there is no Postgres). */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync,spawnSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions'), SQL=path.join(__dirname,'..','supabase','mc_release_d1_content_approval.sql');
const JS=[
 ['_approval.js','an undecided area takes the proposal','if(c === "edit" && a.selected) return edit(a.value); return keep(); };','if(c === "edit" && a.selected) return edit(a.value); return proposed(); };'],
 ['_approval.js','an undecided option photo takes the suggestion','    else o.image = gallery.length ? (op.current.image || null) : null;','    else o.image = op.proposed.image || null;'],
 ['_approval.js','a kept current option photo dropped once the page has a gallery','    else o.image = gallery.length ? (op.current.image || null) : null;','    else o.image = null;'],
 ['_approval.js','a stale selection still counts','    const same = canon(cur) === canon(prop), basis = basisOf(cur, prop), s = sel[id] || null;\n    const stale = !!(s && s.basis && s.basis !== basis);','    const same = canon(cur) === canon(prop), basis = basisOf(cur, prop), s = sel[id] || null;\n    const stale = false;'],
 ['_approval.js','a page approved with areas still waiting','  const waiting = areas.filter(a => !a.approved).map(a => a.label);','  const waiting = areas.filter(a => false).map(a => a.label);'],
 ['_approval.js','a photo that is not the page\'s own accepted for an option','    if(choice === "use_image" && !st.candidates.some(c => c.url === str(value && value.url)) && !isUpload(st.upload_prefix, str(value && value.url))) return','    if(false) return'],
 ['_approval.js','a foreign photo accepted in the gallery','    if(urls.some(u => !st.candidates.some(c => c.url === u) && !isUpload(st.upload_prefix, u))) return','    if(false) return'],
 ['_approval.js','withheld promo art offered','  const add = c => { if(!c.url || withheld.has(c.url)) return;','  const add = c => { if(!c.url) return;'],
 ['_approval.js','an Auto-Enrich copy passed off as an upload','u.slice(prefix.length).indexOf("/") < 0','true'],
 ['_approval.js','a new grouping published without the President\'s choice','  const publish = grouping.same || (grouping.selected && grouping.choice === "use_proposed");','  const publish = true;'],
 ['_approval.js','an edit loses its source provenance','    if(choice === "edit" && a.provenance) hv.provenance = a.provenance; }','    }'],
 ['_publish.js','an unapproved page published','  const approvedFor = p => { const a = approvals[p.page_key]; return !!(a && a.complete && a.publish && approved[p.page_key]); };','  const approvedFor = p => !!approved[p.page_key];'],
 ['_publish.js','a photo nobody approved let into the plan','    if(unapproved.length){','    if(false){'],
 ['_publish.js','selections left out of the plan hash','d.kind === "enrichment_window" || d.kind === "content_approval"))','d.kind === "enrichment_window"))'],
 ['_publish.js','the approved content not carried in the publication','  return { after: Object.assign(fields, {','  return { after: Object.assign({}, {'],
 ['product-content.js','anyone records an approval','          if (!president) return reply(403, { ok: false, error: \'president_only\', message: \'Only the President approves dealer-facing content and images.','          if (false) return reply(403, { ok: false, error: \'president_only\', message: \'Only the President approves dealer-facing content and images.'],
 ['product-content.js','an approval recorded with no window','          if (!S.window) return reply(409, { ok: false, error: \'no_enrichment_window\'','          if (false) return reply(409, { ok: false, error: \'no_enrichment_window\''],
 ['product-content.js','the preview shows the raw proposals','map(k => Object.assign({}, X.pages.find(r => r.page_key === k), A.approved[k]));\n            const V = await dealerViews(m, X, S, shown','map(k => X.pages.find(r => r.page_key === k));\n            const V = await dealerViews(m, X, S, shown'],
 ['product-content.js','the plan built from the raw drafts','  const base = { slug: m, window: win, publicBase: PUBLIC_PC(), pages: S.pages, drafts: X.pages, decisions: X.decisions, info, approvals: A.states, approved: A.approved };','  const base = { slug: m, window: win, publicBase: PUBLIC_PC(), pages: S.pages, drafts: X.pages, decisions: X.decisions, info, approvals: A.states, approved: Object.fromEntries(Object.keys(A.approved).map(k => [k, X.pages.find(r => r.page_key === k)])) };'],
];
const SQLM=[
 ['the approved content never written','    nw := jsonb_populate_record(rw, public.mfr_approved_content(aft));','    nw := rw;'],
 ['rollback leaves the approved content in place','    nw := jsonb_populate_record(rw, public.mfr_approved_content(b));','    nw := rw;'],
 ['the content filter lets status through',"   where k = any (array['name',","   where k = any (array['status','name',"],
 ['content_approval not a decision kind',",'content_publication','content_approval'));",",'content_publication'));"],
 ['the content filter executable by anon',"    execute 'revoke all on function public.mfr_approved_content(jsonb) from anon';","    execute 'grant execute on function public.mfr_approved_content(jsonb) to anon';"],
 ['a draft photo published with approved content','    bad := public.mfr_live_media_problem(aft, d.manufacturer);','    bad := null;'],
];
let surv=0, killed=0;
const TESTS=['mcapproval.test.js','mcpublish.test.js'];
for(const [file,n,f,t] of JS){ const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'mcapr-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t)); const env=Object.assign({},process.env,{CAT_ROOT:MD});
  let k=false; for(const tf of TESTS){ try{ execFileSync('node',[path.join(__dirname,tf)],{stdio:'pipe',env,timeout:900000}); }catch(e){ k=true; break; } }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(k) killed++; else surv++; fs.rmSync(MD,{recursive:true,force:true}); }
const pg=spawnSync(process.env.PGTEST_PSQL||'psql',['-X','-q','-d','postgres','-c','select 1'],{encoding:'utf8'});
if(pg.status!==0) console.log('SQL mutants skipped: no Postgres');
else for(const [n,f,t] of SQLM){ const src=fs.readFileSync(SQL,'utf8'); const c=src.split(f).length-1; if(c<1){console.log(`BAD ANCHOR(${c}) sql: ${n}`);surv++;continue;}
  const tmp=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'mcapr-s-')),'d1.sql'); fs.writeFileSync(tmp,src.split(f).join(t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'mc-approval.pg.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{MC_D1_SQL:tmp}),timeout:300000}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' sql: '+n); if(k) killed++; else surv++; }
console.log(surv?`${surv} survived (${killed} killed)`:`all ${killed} mutants killed`); process.exit(surv?1:0);

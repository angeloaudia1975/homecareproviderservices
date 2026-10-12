/* Approve Content & Images (Angelo 2026-10-12) — end to end in the Release B sandbox (test/mcenrich.world.js: the frozen
   Bemis-shaped line with its real catalog file; the publication functions mirrored from Release D + the content-approval
   SQL, proven in Postgres by test/mc-approval.pg.test.js). Bemis enriched to the Release C end state (3 Ready, 4 held),
   with NO content approval yet — exactly where the real line stands after the #531 rollback. Through the REAL handlers:
     · the approval screen is read-only and shows, per Ready page and area, the Current Dealer View next to the proposal;
       no selection = keep current; held pages are not approvable;
     · with no selection nothing is publishable and the Approved New Dealer View IS the current dealer view (the four
       SKUs whose photos #531 changed show their original catalog photos);
     · AN UNSELECTED PROPOSED PHOTO CANNOT REACH A PUBLISH PLAN: not by default, not by recording a photo that is not
       one of the page's own, not by a tampered approved row, not after the selection that named it is replaced;
     · only the President records; only under an open window; a selection is tied to what was on screen (stale when
       the proposal changes); a change after the dry run invalidates the publication approval;
     · Keep current on every area publishes the pages with today's copy and photos (no photo copied at all); a mix of
       choices publishes exactly those choices (edits keep their provenance), kept current photos copied live when the
       page has its own gallery; grouping kept as today leaves Assurance on its two cards, unpublished;
     · publish → live dealer view = the approved one; rollback restores the drafts, content included. */
const path=require('path');
const {S,M,ROOT,world,PC,call,withWin}=require('./mcenrich.world.js');
const AP=require(path.join(ROOT,'_approval.js'));
const PUB=require(path.join(ROOT,'_publish.js'));
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,4).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const DRAFT=/\/drafts\/w\d+\//;
const pageOf=(plan,code)=>plan.pages.find(p=>p.skus.some(s=>s.code===code));
const FOUR=['7YA0AS100','7YR05310TSS','7YE05310TSS','7YA04505T'];
async function releaseC(C){
  let plan=(await call(C,{action:'enrich_plan'})).body;
  for(const p of plan.pages){ await call(C,withWin({action:'enrich_page',page_key:p.page_key})); for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:p.page_key})); if(!im.body.remaining) break; } }
  plan=(await call(C,{action:'enrich_plan'})).body;
  const seat=pageOf(plan,'7YR05310TSS').page_key;
  for(const [code,img] of [['7YR05310TSS','R85320TSS-000-F'],['7YE05310TSS','E85320TSS-000-F']])
    await call(C,withWin({action:'enrich_resolve',page_key:seat,issue:'needs_image',choice:'use_source_image',value:{code,image_url:'https://www.toiletseats.com/assets/'+img+'.jpg'},reason:'official top view'}));
  await call(C,withWin({action:'enrich_page',page_key:seat})); for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:seat})); if(!im.body.remaining) break; }
  plan=(await call(C,{action:'enrich_plan'})).body;
  for(const p of plan.pages.filter(p=>p.status!=='ready')) await call(C,withWin({action:'enrich_resolve',page_key:p.page_key,issue:'hold',choice:'hold_back',reason:'source hold'}));
  return (await call(C,{action:'enrich_plan'})).body;
}
const state=async C=>(await call(C,{action:'approval_state'})).body;
const record=(C,sel)=>call(C,{action:'approval_record',selections:Array.isArray(sel)?sel:[sel]});
const A=(pg,id)=>pg.areas.find(a=>a.id===id);
const opt=(pg,code)=>A(pg,'option_images').options.find(o=>o.code===code);
/* every image URL a plan could write */
const planUrls=d=>JSON.stringify(d.ready.map(r=>[r.after_photos,r.promote]));
async function promoteAll(C,did){ let r; for(let i=0;i<20;i++){ r=await call(C,{action:'publish_promote',decision_id:did}); if(r.status!==200||!r.body.remaining) break; } return r; }
/* Keep current, explicitly, on every area that differs (grouping: the proposal, so the page is published at all) */
const keepAll=(pg,grouping)=>pg.areas.filter(a=>!a.same && a.id!=='option_images').map(a=>({page_key:pg.page_key,area:a.id,
    choice:a.id==='grouping'?(grouping||'use_proposed'):(a.choices.includes('keep_current')?'keep_current':'use_proposed')}))
  .concat(A(pg,'option_images').options.filter(o=>!o.same).map(o=>({page_key:pg.page_key,area:'option_image',code:o.code,choice:'keep_current'})));

(async()=>{
let W, C, plan, st, today;
await t('setup: the Release C end state — 3 Ready pages, 4 held — and no content approval recorded',async()=>{
  W=world(); C=PC(W); plan=await releaseC(C);
  eq(plan.pages.filter(p=>p.status==='ready').length,3); eq(plan.pages.filter(p=>p.status==='held_back').length,4);
  ok(!W.db.mfr_decisions.some(d=>d.kind==='content_approval'),'no selection yet');
  W.tokens.ops='ops@hcps.us'; (W.db.staff_users=W.db.staff_users||[]).push({email:'ops@hcps.us',name:'Ops Admin',role:'admin',rep_name:null,active:true});
});
await t('the approval screen is read-only: per Ready page, every area with the Current Dealer View next to the proposal; held pages are not approvable',async()=>{
  const before=JSON.stringify(W.db), stored=W.store.length;
  st=await state(C); eq(JSON.stringify(W.db),before,'nothing written'); eq(W.store.length,stored,'nothing copied');
  const ready=st.pages.filter(p=>p.areas); eq(ready.map(p=>p.codes.slice().sort().join('+')).sort(),['7YA04505T','7YA0AS100','7YE05310TSS+7YR05310TSS']);
  for(const p of ready){
    eq(p.areas.map(a=>a.id),AP.AREAS.map(a=>a.id),p.name+': every area');
    eq([p.status,p.complete],['waiting_for_approval',false],p.name);
    ok(p.checklist.every(c=>typeof c.approved==='boolean'),'checklist');
    ok(p.areas.filter(a=>a.id!=='option_images').every(a=>!a.selected && (a.same ? a.choice==='no_change' : (a.choices.includes('keep_current') ? a.choice==='keep_current' : a.choice===null))),p.name+': no selection = keep current (nothing chosen for the combined card\'s title)');
    ok(A(p,'option_images').options.every(o=>!o.selected && o.choice==='keep_current'),p.name+': option photos keep current');
    ok(A(p,'images').current.gallery.every(u=>/\/assets\/products\/bemis\//.test(u)),'current = the catalog photos');
    ok(A(p,'images').proposed.gallery.every(u=>DRAFT.test(u)),'proposed = the draft copies');
    ok(p.candidates.some(c=>c.kinds.includes('current')) && p.candidates.some(c=>c.kinds.includes('proposed')),'both kinds of photo offered');
    ok(p.candidates.every(c=>/^https?:/.test(c.display)),'every photo displayable on the admin origin');
  }
  const seat=ready.find(p=>p.codes.includes('7YR05310TSS'));
  eq(A(seat,'grouping').same,false,'Round + Elongated are two cards today'); eq(A(seat,'title').choices,['use_proposed','edit'],'the combined card has no current title');
  ok(seat.candidates.some(c=>c.duplicate_of),'the same picture under two addresses is flagged');
  for(const code of ['7YA0AS100','7YA04505T']){ const p=ready.find(x=>x.codes.includes(code)); eq([A(p,'grouping').same,A(p,'title').same,A(p,'category').same],[true,true,true],code+': nothing to decide where nothing differs'); }
  const held=st.pages.filter(p=>!p.areas); eq(held.length,4); ok(held.every(p=>p.status==='not_ready'),'held pages are not approvable');
});
await t('NO SELECTION: nothing is publishable, and the Approved New Dealer View IS the current dealer view (original photos on the four SKUs #531 changed)',async()=>{
  const d=(await call(C,{action:'publish_plan'})).body;
  eq(d.publishable,false); ok(d.problems.some(x=>/no page has the President's content & image approval/.test(x)),JSON.stringify(d.problems));
  eq(d.ready.length,0); eq(d.awaiting.length,3); ok(!DRAFT.test(planUrls(d)),'no draft photo anywhere in the plan');
  const pv=(await call(C,{action:'enrich_preview'})).body; eq(pv.pass,true,JSON.stringify(pv.checks.filter(c=>!c.pass)).slice(0,400));
  eq([pv.views.current,pv.views.approved,pv.note],['Current Dealer View','Approved New Dealer View','Preview only — switching views does not select content or images.']);
  today=pv.today;
  for(const code of FOUR){
    const a=pv.proposed.find(k=>k.codes.includes(code)), b=pv.today.find(k=>k.codes.includes(code));
    const oa=a.options.find(o=>o.code===code), ob=b.options.find(o=>o.code===code);
    eq([oa.image,a.description,a.features,a.specs],[ob.image,b.description,b.features,b.specs],code+' approved view = current view');
    ok(new RegExp('/assets/products/bemis/'+code+'\\.jpg$').test(oa.image),code+' shows its original catalog photo: '+oa.image);
  }
  ok(!DRAFT.test(JSON.stringify(pv.proposed)),'no draft photo in the Approved New Dealer View');
  eq(pv.proposed.filter(k=>k.codes.includes('7YR05310TSS')||k.codes.includes('7YE05310TSS')).length,2,'Assurance stays on its two cards until the grouping is chosen');
});
await t('only the President records, only under an open window; a photo that is not one of the page\'s own is refused; nothing recorded on refusal',async()=>{
  const n=W.db.mfr_decisions.length; const p=st.pages.find(p=>p.areas&&p.codes.includes('7YA0AS100'));
  let r=await M.call(C,{action:'approval_record',manufacturer:S.REAL,page_key:p.page_key,area:'description',choice:'use_proposed'},{token:'ops'});
  eq([r.status,r.body.error],[403,'president_only']);
  r=await record(C,{page_key:p.page_key,area:'option_image',code:'7YA0AS100',choice:'use_image',value:{url:'https://www.toiletseats.com/assets/A8AS100-000-P.jpg'}}); eq([r.status,r.body.error],[400,'bad_selection'],'the manufacturer\'s own address (not a copy here)');
  const other=st.pages.find(x=>x.areas&&x.codes.includes('7YA04505T')).candidates.find(c=>c.kinds.includes('proposed')).url;
  r=await record(C,{page_key:p.page_key,area:'images',choice:'custom',value:{gallery:[{url:other}]}}); eq([r.status,r.body.error],[400,'bad_selection'],'another page\'s photo');
  r=await record(C,{page_key:p.page_key,area:'images',choice:'custom',value:{gallery:[]}}); eq(r.status,400,'an empty gallery');
  r=await record(C,{page_key:p.page_key,area:'description',choice:'edit',value:{text:'  '}}); eq(r.status,400,'an empty edit');
  r=await record(C,[{page_key:p.page_key,area:'description',choice:'keep_current'},{page_key:p.page_key,area:'nonsense',choice:'keep_current'}]); eq(r.status,400,'one bad selection refuses the batch');
  const held=st.pages.find(x=>!x.areas); r=await record(C,{page_key:held.page_key,area:'description',choice:'keep_current'}); eq([r.status,r.body.error],[404,'not_approvable']);
  eq(W.db.mfr_decisions.length,n,'nothing recorded');
  const w=W.db.mfr_decisions.find(d=>d.kind==='enrichment_window'); w.used_at='2026-10-12T00:00:00Z';
  r=await record(C,{page_key:p.page_key,area:'description',choice:'keep_current'}); eq([r.status,r.body.error],[409,'no_enrichment_window']); w.used_at=null;
  eq(W.db.mfr_decisions.length,n,'still nothing recorded');
});
await t('KEEP CURRENT on every area (the explicit choice): the pages publish with today\'s copy and photos — no photo copied, no draft link, no proposed word',async()=>{
  const ready=st.pages.filter(p=>p.areas); const sel=ready.flatMap(p=>keepAll(p));
  const r=await record(C,sel); eq(r.status,200,JSON.stringify(r.body).slice(0,300));
  ok(W.db.mfr_decisions.filter(d=>d.kind==='content_approval').every(d=>d.decided_by && d.reason && d.hcps_value.basis && d.hcps_value.window!=null),'each selection recorded with who, why, what was on screen and the window');
  st=await state(C); ok(st.pages.filter(p=>p.areas).every(p=>p.complete && p.status==='approved'),JSON.stringify(st.pages.filter(p=>p.areas).map(p=>[p.name,p.waiting])));
  const d=(await call(C,{action:'publish_plan'})).body; eq(d.publishable,true,JSON.stringify(d.problems));
  eq(d.ready.length,3); eq(d.summary.photos_promoted,0,'nothing to copy: every photo is today\'s'); ok(!DRAFT.test(planUrls(d)),'no draft photo');
  for(const pg of d.ready) for(const o of pg.after_photos.options) ok(!o.image,'option photo left to the catalog (today\'s photo): '+JSON.stringify(o));
  const C2=PC(W); const ap=(await call(C2,{action:'publish_approve',plan_hash:d.plan_hash,reason:'Keep current — test'})).body; ok(ap.ok,JSON.stringify(ap));
  const after=W.db.mfr_decisions.find(x=>x.id===ap.decision.id).hcps_value.after;
  for(const k of Object.keys(after)){ const a=after[k];
    eq([a.description,a.tagline,a.warranty,a.features,a.specs,a.documents,a.videos,a.source_url,a.subcategory],[null,null,null,[],[],[],[],null,null],k+': every kept area empty → today\'s copy');
    ok(!/Removes the need|lifts the user|two independent locks/.test(JSON.stringify(a)),k+': no proposed sentence'); }
  /* the publication itself: live dealer view = approved = today's for the four SKUs */
  const ex=(await call(C2,{action:'publish_execute',decision_id:ap.decision.id})); eq(ex.status,200,JSON.stringify(ex.body).slice(0,500));
  const pv=(await call(C2,{action:'enrich_preview'})).body;
  for(const code of FOUR){ const k=pv.today.find(c=>c.codes.includes(code)), o=k.options.find(o=>o.code===code), t0=today.find(c=>c.codes.includes(code)).options.find(o=>o.code===code);
    eq(o.image,t0.image,code+' live photo unchanged'); ok(k.enriched,code+' now on its published page'); }
  /* rollback: the drafts come back exactly, content included */
  const rb=await S.call(S.mod(W),{action:'mc_publish_rollback',manufacturer:S.REAL,decision_id:ap.decision.id,reason:'test'}); eq([rb.status,rb.body.rolled_back],[200,true]);
  const rows=W.db.product_content.filter(x=>Object.keys(after).includes(x.page_key));
  ok(rows.length===3 && rows.every(x=>x.status!=='published' && x.description),'drafts restored (hidden) with their proposed copy — the window stamp is the database\'s work, proven in Postgres: '+JSON.stringify(rows.map(x=>[x.status,x.draft_window,!!x.description])));
});
await t('PROOF: an unselected proposed photo cannot make it into a publish plan — default, foreign address, tampered row, replaced selection',async()=>{
  /* a fresh sandbox: Assist gets ONE suggested photo for its option; everything else kept current */
  const W2=world(), C2=PC(W2); await releaseC(C2);
  let s2=await state(C2); const pg=s2.pages.find(p=>p.areas&&p.codes.includes('7YA0AS100'));
  const proposed=pg.candidates.filter(c=>c.kinds.includes('proposed')).map(c=>c.url); ok(proposed.length>=2,'several suggestions');
  const chosen=proposed[1];
  const sel=s2.pages.filter(p=>p.areas).flatMap(p=>keepAll(p)).filter(x=>!(x.page_key===pg.page_key&&x.area==='option_image'));
  sel.push({page_key:pg.page_key,area:'option_image',code:'7YA0AS100',choice:'use_image',value:{url:chosen}});
  eq((await record(C2,sel)).status,200);
  let d=(await call(C2,{action:'publish_plan'})).body; eq(d.publishable,true,JSON.stringify(d.problems));
  const promoted=d.ready.flatMap(r=>r.promote); eq(promoted.map(x=>x.from),[chosen],'exactly the one chosen photo is copied');
  const urls=planUrls(d); proposed.filter(u=>u!==chosen).forEach(u=>ok(urls.indexOf(u)<0,'unselected suggestion absent: '+u));
  /* a tampered approved row (a suggestion nobody picked slipped into the gallery) is refused by the plan itself */
  s2=await state(C2); const st2=s2.pages.find(p=>p.page_key===pg.page_key);
  const row=W2.db.product_content.find(r=>r.page_key===pg.page_key);
  const stObj=AP.approvalState({page:{page_key:pg.page_key,name:pg.name,skus:pg.codes.map(code=>({code}))},row,products:[],todayCards:[],decisions:W2.db.mfr_decisions});
  const tampered=Object.assign(AP.approvedRow(row,stObj),{images_gallery:[{url:proposed[0],primary:true}],image:proposed[0]});
  const info={}; [proposed[0],chosen].forEach((u,n)=>{ info[u]={sha:String(n+1).repeat(64),src:u}; });
  const P=PUB.buildPlan({slug:S.REAL,window:null,publicBase:'https://x/storage/v1/object/public/product-content/',pages:[{page_key:pg.page_key,name:pg.name,status:'ready',skus:pg.codes.map(code=>({code}))}],
    drafts:[row],decisions:[],info,approvals:{[pg.page_key]:Object.assign({},stObj,{complete:true,publish:true})},approved:{[pg.page_key]:tampered},preview:{pass:true,checks:[],summary:{}}});
  eq(P.publishable,false); ok(P.problems.some(x=>/a photo nobody approved would be published/.test(x)),JSON.stringify(P.problems)); eq(P.ready.length,0);
  /* the selection replaced by Keep current: the photo leaves the plan */
  eq((await record(C2,{page_key:pg.page_key,area:'option_image',code:'7YA0AS100',choice:'keep_current'})).status,200);
  d=(await call(C2,{action:'publish_plan'})).body; ok(planUrls(d).indexOf(chosen)<0,'replaced selection: photo gone'); eq(d.summary.photos_promoted,0);
  ok(st2,'(state read)');
});
await t('a selection is tied to what was on screen: when the proposal changes (re-enrichment), it is stale and the page waits again',async()=>{
  const W3=world(), C3=PC(W3); await releaseC(C3);
  const s3=await state(C3); const pg=s3.pages.find(p=>p.areas&&p.codes.includes('7YA04505T'));
  eq((await record(C3,keepAll(pg))).status,200); ok((await state(C3)).pages.find(p=>p.page_key===pg.page_key).complete,'approved');
  const row=W3.db.product_content.find(r=>r.page_key===pg.page_key); row.description='A different proposal from a re-run of Auto-Enrich, long enough to read as a description.';
  const s4=(await state(C3)).pages.find(p=>p.page_key===pg.page_key); const a=A(s4,'description');
  eq([a.stale,a.selected,a.approved,s4.complete],[true,false,false,false]); ok(s4.waiting.includes('Description'),JSON.stringify(s4.waiting));
});
await t('a change of selection after the dry run invalidates the publication approval: promote and execute refuse, nothing copied',async()=>{
  const W4=world(), C4=PC(W4); await releaseC(C4);
  const s4=await state(C4); eq((await record(C4,s4.pages.filter(p=>p.areas).flatMap(p=>keepAll(p)))).status,200);
  const d=(await call(C4,{action:'publish_plan'})).body; const a=(await call(C4,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  const pg=s4.pages.find(p=>p.areas&&p.codes.includes('7YA0AS100'));
  /* even a change that would publish the same bytes (keep current → no option-specific photo: both leave today's photo) */
  eq((await record(C4,{page_key:pg.page_key,area:'option_image',code:'7YA0AS100',choice:'none'})).status,200);
  const d2=(await call(C4,{action:'publish_plan'})).body; eq(JSON.stringify(d2.ready.map(r=>r.after_photos)),JSON.stringify(d.ready.map(r=>r.after_photos)),'(the same photos either way)');
  eq((await call(C4,{action:'publish_promote',decision_id:a})).body.error,'approval_invalid','a changed selection, same result: still invalid');
  eq((await record(C4,{page_key:pg.page_key,area:'description',choice:'use_proposed'})).status,200);
  const stored=W4.store.length;
  eq((await call(C4,{action:'publish_promote',decision_id:a})).body.error,'approval_invalid');
  eq((await call(C4,{action:'publish_execute',decision_id:a})).body.error,'approval_invalid');
  eq(W4.store.length,stored); ok(!W4.db.product_content.some(r=>r.manufacturer===S.REAL&&r.status==='published'),'nothing published');
});
await t('ANY selection change after the dry run invalidates it — even on a page that is not being published',async()=>{
  const W7=world(), C7=PC(W7); await releaseC(C7);
  const s7=await state(C7); const assist=s7.pages.find(p=>p.areas&&p.codes.includes('7YA0AS100')), rise=s7.pages.find(p=>p.areas&&p.codes.includes('7YA04505T'));
  eq((await record(C7,keepAll(assist).concat([{page_key:rise.page_key,area:'description',choice:'keep_current'}]))).status,200);
  const d=(await call(C7,{action:'publish_plan'})).body; eq([d.publishable,d.ready.length],[true,1]);
  const a=(await call(C7,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  eq((await record(C7,{page_key:rise.page_key,area:'description',choice:'use_proposed'})).status,200,'Rise is still waiting either way');
  eq((await call(C7,{action:'publish_promote',decision_id:a})).body.error,'approval_invalid');
});
await t('a mix of choices publishes exactly those choices: an edit keeps its provenance; a custom gallery (ordered, primary first) copies only the chosen photos; a kept current option photo is copied live; the same picture twice becomes one copy',async()=>{
  const W5=world(), C5=PC(W5); await releaseC(C5);
  const s5=await state(C5); const pg=s5.pages.find(p=>p.areas&&p.codes.includes('7YR05310TSS'));
  const prop=A(pg,'images').proposed.gallery; ok(prop.length>=2,'two suggestions');
  const sel=s5.pages.filter(p=>p.areas&&p.page_key!==pg.page_key).flatMap(p=>keepAll(p)).concat([
    {page_key:pg.page_key,area:'grouping',choice:'use_proposed'},
    {page_key:pg.page_key,area:'title',choice:'edit',value:{text:'Assurance Raised Toilet Seat, 3" (approved)'}},
    {page_key:pg.page_key,area:'description',choice:'edit',value:{text:'The President\'s own description of the Assurance seat.'}},
    {page_key:pg.page_key,area:'features',choice:'use_proposed'},{page_key:pg.page_key,area:'specs',choice:'keep_current'},
    {page_key:pg.page_key,area:'documents',choice:'keep_current'},
    {page_key:pg.page_key,area:'images',choice:'custom',value:{gallery:[{url:prop[1]},{url:prop[0]}]}},
    {page_key:pg.page_key,area:'option_image',code:'7YR05310TSS',choice:'keep_current'},
    {page_key:pg.page_key,area:'option_image',code:'7YE05310TSS',choice:'use_image',value:{url:opt(pg,'7YE05310TSS').proposed.image}}]);
  eq((await record(C5,sel)).status,200);
  const s6=(await state(C5)).pages.find(p=>p.page_key===pg.page_key); ok(s6.complete,JSON.stringify(s6.waiting));
  const d=(await call(C5,{action:'publish_plan'})).body; eq(d.publishable,true,JSON.stringify(d.problems));
  const r=d.ready.find(x=>x.page_key===pg.page_key);
  eq(r.after_photos.gallery.length,2,'two gallery photos'); ok(r.after_photos.main===r.after_photos.gallery[0],'primary first');
  const rowNow=W5.db.product_content.find(x=>x.page_key===pg.page_key);
  const live=r.promote.filter(x=>!x.kept_current), kept=r.promote.filter(x=>x.kept_current);
  ok(live.every(x=>[prop[0],prop[1],opt(pg,'7YE05310TSS').proposed.image].includes(x.from)),'only chosen suggestions copied: '+JSON.stringify(live.map(x=>x.from)));
  eq(kept.length,1,'the Round option keeps today\'s photo, copied live because the page now has its own gallery'); ok(/\/assets\/products\/bemis\/7YR05310TSS\.jpg$/.test(kept[0].from),kept[0].from);
  eq(live.length,2,'two new live copies: the two gallery photos'); ok(r.deduped.some(x=>x.why==='same bytes'),'the Elongated option photo IS a gallery photo: one copy, '+JSON.stringify(r.deduped));
  const ap=(await call(C5,{action:'publish_approve',plan_hash:d.plan_hash,reason:'mixed'})).body; const after=W5.db.mfr_decisions.find(x=>x.id===ap.decision.id).hcps_value.after[pg.page_key];
  eq([after.name,after.description,after.specs],['Assurance Raised Toilet Seat, 3" (approved)','The President\'s own description of the Assurance seat.',[]]);
  eq(after.features,rowNow.features,'features as proposed');
  ok(after.field_provenance.president_approval.description.choice==='edit' && after.field_provenance.president_approval.description.decision,'the edit is recorded on the page');
  const dec=W5.db.mfr_decisions.filter(x=>x.kind==='content_approval'&&x.hcps_value.area==='description'&&x.field==='page:'+pg.page_key).pop();
  eq(dec.hcps_value.provenance,(rowNow.field_provenance||{}).description,'the edit keeps the source\'s provenance'); ok(dec.hcps_value.provenance,'(the draft had a source for its description)');
  ok(!/\/drafts\//.test(JSON.stringify(after)),'the approved page names live copies only (and no draft link hides in its provenance)');
  await promoteAll(C5,ap.decision.id); const ex=await call(C5,{action:'publish_execute',decision_id:ap.decision.id}); eq(ex.status,200,JSON.stringify(ex.body).slice(0,600));
  const live2=W5.db.product_content.find(x=>x.page_key===pg.page_key); eq([live2.status,live2.description,live2.name],['published','The President\'s own description of the Assurance seat.','Assurance Raised Toilet Seat, 3" (approved)']);
  ok(!/\/drafts\//.test(JSON.stringify([live2.image,live2.images_gallery,live2.skus])),'live copies only');
});
await t('grouping kept as today: Assurance stays on its two current cards and is not published; the other pages publish',async()=>{
  const W6=world(), C6=PC(W6); await releaseC(C6);
  const s6=await state(C6); const seat=s6.pages.find(p=>p.areas&&p.codes.includes('7YR05310TSS'));
  const sel=s6.pages.filter(p=>p.areas).flatMap(p=>p.page_key===seat.page_key?keepAll(p,'keep_current'):keepAll(p));
  eq((await record(C6,sel)).status,200);
  const s7=(await state(C6)).pages.find(p=>p.page_key===seat.page_key); eq([s7.status,s7.publish],['kept_as_today',false]);
  const d=(await call(C6,{action:'publish_plan'})).body; eq(d.publishable,true,JSON.stringify(d.problems));
  ok(!d.ready.some(r=>r.page_key===seat.page_key),'Assurance not in the plan'); ok(d.awaiting.some(a=>a.page_key===seat.page_key),'listed as not published');
  eq([d.summary.cards_today,d.summary.cards_after,d.summary.missing,d.summary.duplicates],[9,9,0,0],'two Assurance cards remain');
});
await t('unit: approvedRow — no selection keeps every area as today (null / empty), never a proposal; checklist reads Title ✓ …',async()=>{
  const row={page_key:'p',name:'Proposed name',description:'Proposed description long enough',features:['f1'],specs:[{label:'a',value:'b'}],warranty:'w',documents:[{url:'https://d/x.pdf'}],videos:['v'],source_url:'https://s',
    subcategory:'Sub',category:'Cat',images_gallery:[{url:'https://h/storage/v1/object/public/product-content/bemis/drafts/w1/p/a.jpg',primary:true}],image:'https://h/storage/v1/object/public/product-content/bemis/drafts/w1/p/a.jpg',
    skus:[{sku:'X1',name:'Proposed X1',image:'https://h/storage/v1/object/public/product-content/bemis/drafts/w1/p/b.jpg',images:['https://h/storage/v1/object/public/product-content/bemis/drafts/w1/p/c.jpg']}],enrichment_flags:{mc:{images:[]}}};
  const s=AP.approvalState({page:{page_key:'p',name:'P',skus:[{code:'X1'}]},row,products:[{code:'X1',name:'Catalog X1',description:'Catalog copy',image:'/assets/products/bemis/X1.jpg',category:'Cat',subcategory:'Old'}],
    todayCards:[{name:'Catalog X1',codes:['X1']}],decisions:[]});
  const out=AP.approvedRow(row,s);
  eq([out.name,out.description,out.features,out.specs,out.warranty,out.documents,out.videos,out.source_url,out.subcategory,out.image,out.images_gallery],['Catalog X1',null,[],[],null,[],[],null,null,null,[]]);
  eq(out.skus,[{sku:'X1',images:[]}],'no option name, no option photo: the catalog\'s');
  ok(!/drafts/.test(JSON.stringify(out)),'no draft link anywhere');
  eq(AP.checklist(s).filter(c=>!c.approved).map(c=>c.label),['Title','Description','Features','Specs','Warranty','Documents & videos','Category','Images','Option images']);
});
await t('unit: promo art Auto-Enrich withheld is never offered; an "upload" must be the President\'s own file in this page\'s folder (never an Auto-Enrich copy, another page or a query string)',async()=>{
  const D='https://h.supabase.co/storage/v1/object/public/product-content/bemis/drafts/w7/p/';
  const row={page_key:'p',name:'P',images_gallery:[{url:D+'rehost/1-a.jpg'}],skus:[{sku:'X1'}],enrichment_flags:{mc:{images:[{url:D+'rehost/1-a.jpg',sha:'a'},{url:D+'rehost/2-promo.jpg',sha:'b'}],image_withheld:[{url:D+'rehost/2-promo.jpg'}]}}};
  const s=AP.approvalState({page:{page_key:'p',name:'P',skus:[{code:'X1'}]},row,products:[{code:'X1',name:'X1',image:'/assets/products/bemis/X1.jpg'}],todayCards:[{name:'X1',codes:['X1']}],decisions:[],uploadPrefix:D});
  ok(!s.candidates.some(c=>/promo/.test(c.url)),'withheld promo art not offered');
  ok(AP.selectionProblem(s,'option_image','use_image',{url:D+'rehost/2-promo.jpg'},'X1'),'withheld promo art refused as a selection');
  eq([AP.isUpload(D,D+'1791-mine.jpg'),AP.isUpload(D,D+'rehost/2-promo.jpg'),AP.isUpload(D,D.replace('/p/','/q/')+'x.jpg'),AP.isUpload(D,D+'x.jpg?v=1'),AP.isUpload(D,D+'x.pdf'),AP.isUpload(null,D+'x.jpg')],[true,false,false,false,false,false]);
  eq(AP.selectionProblem(s,'option_image','use_image',{url:D+'1791-mine.jpg'},'X1'),null,'the President\'s own upload is accepted');
});
console.log(`mc content & image approval: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

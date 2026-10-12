/* Manufacturer Center Release D — Publish & Verify, end to end in the Release B sandbox (test/mcenrich.world.js: the
   frozen Bemis-shaped line with its real catalog file; the publication functions mirrored from
   supabase/mc_release_d_publication.sql, whose SQL is proven in Postgres by test/mc-publication.pg.test.js).
   Bemis enriched to Release C's end state (3 Ready, 4 held), then through the REAL handlers:
     · the dry run (read-only): 9 cards today → 8 after, all 9 SKUs, 3 pages live, 4 held on their current cards,
       0 missing / duplicates / commercial changes, DO5300RD444 excluded; every page and photo promotion listed;
       the Assurance option photo that IS a gallery photo becomes ONE live copy (no duplicate thumbnail);
     · approval is tied to the exact dry run: a stale hash is refused; anything changed after approval invalidates it;
     · nothing is published before every live copy exists; publishing writes exactly the 3 Ready pages, live photos
       only, held drafts untouched; the live dealer view equals the approved one; the approval is spent;
     · a refused or failed publication changes nothing / rolls back to the previous safe view and records the run;
     · finalize: the full verification passes, the run is saved as the new Gold Standard (with the content
       fingerprint), the enrichment window is spent, rollback is then refused; the held drafts stay hidden with their
       issues for a future window. */
const path=require('path');
const {S,ROOT,world,PC,call,withWin,approvePages}=require('./mcenrich.world.js');
const PUB=require(path.join(ROOT,'_publish.js'));
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,3).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const pageOf=(plan,code)=>plan.pages.find(p=>p.skus.some(s=>s.code===code));
async function releaseC(W,C){
  let plan=(await call(C,{action:'enrich_plan'})).body;
  for(const p of plan.pages){ await call(C,withWin({action:'enrich_page',page_key:p.page_key})); for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:p.page_key})); if(!im.body.remaining) break; } }
  plan=(await call(C,{action:'enrich_plan'})).body;
  const seat=pageOf(plan,'7YR05310TSS').page_key;
  for(const [code,img] of [['7YR05310TSS','R85320TSS-000-F'],['7YE05310TSS','E85320TSS-000-F']])
    await call(C,withWin({action:'enrich_resolve',page_key:seat,issue:'needs_image',choice:'use_source_image',value:{code,image_url:'https://www.toiletseats.com/assets/'+img+'.jpg'},reason:'official top view'}));
  await call(C,withWin({action:'enrich_page',page_key:seat})); for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:seat})); if(!im.body.remaining) break; }
  plan=(await call(C,{action:'enrich_plan'})).body;
  for(const p of plan.pages.filter(p=>p.status!=='ready')) await call(C,withWin({action:'enrich_resolve',page_key:p.page_key,issue:'hold',choice:'hold_back',reason:'source hold'}));
  /* (2026-10-12) nothing publishes without the President's content & image approval: here he takes every proposal */
  await approvePages(C,'proposed');
  return (await call(C,{action:'enrich_plan'})).body;
}
async function promoteAll(C,did){ let r; for(let i=0;i<20;i++){ r=await call(C,{action:'publish_promote',decision_id:did}); if(r.status!==200||!r.body.remaining) break; } return r; }
const finalize=(W,did,extra)=>S.call(S.mod(W),Object.assign({action:'mc_publish_finalize',manufacturer:S.REAL,decision_id:did},extra||{}));

(async()=>{
let W, C, plan, dry, did, held0;
await t('setup: Release C end state — 3 Ready pages, 4 held back',async()=>{
  W=world(); C=PC(W); plan=await releaseC(W,C);
  eq(plan.pages.filter(p=>p.status==='ready').length,3); eq(plan.pages.filter(p=>p.status==='held_back').length,4);
  held0=JSON.stringify(W.db.product_content.filter(r=>plan.pages.find(p=>p.page_key===r.page_key&&p.status==='held_back')));
});
await t('the dry run is read-only and reads: 9 cards today → 8 after; 9/9 SKUs; 3 pages live; 4 held on current cards; 0 missing / duplicates / commercial changes; DO5300RD444 excluded',async()=>{
  const before=JSON.stringify(W.db), stored=W.store.length;
  const r=await call(C,{action:'publish_plan'}); eq(r.status,200,JSON.stringify(r.body).slice(0,400)); dry=r.body;
  eq(JSON.stringify(W.db),before,'nothing written'); eq(W.store.length,stored,'nothing copied');
  eq(dry.publishable,true,JSON.stringify(dry.problems));
  const s=dry.summary; eq([s.cards_today,s.cards_after,s.active_skus,s.accounted,s.missing,s.duplicates,s.commercial_changes,s.enriched_pages_live,s.held_on_current_cards],[9,8,9,9,0,0,0,3,4]);
  eq(s.retired_excluded,['DO5300RD444']);
  eq(dry.ready.map(p=>p.skus.slice().sort().join('+')).sort(),['7YA04505T','7YA0AS100','7YE05310TSS+7YR05310TSS']);
  eq(dry.held.map(h=>h.skus.slice().sort().join('+')).sort(),['444DISPLAY','7YA05313BLK+7YA05313GRY','7YA06303TWA','7YE82350TC']);
  ok(dry.held.every(h=>h.issues.length && h.holds.some(x=>/^hold:hold_back#/.test(x))),'held issues and holds listed');
  ok(dry.preview.pass,'the dealer preview of the publication passes');
});
await t('every page and every photo promotion is listed; live copies only, under bemis/live/<page>/; no draft link survives',async()=>{
  for(const p of dry.ready){
    ok(p.promote.length>0,p.name+' has photos');
    for(const x of p.promote){ ok(PUB.isDraftUrl(x.from),'from a draft copy: '+x.from); ok(new RegExp('/storage/v1/object/public/product-content/bemis/live/'+p.page_key+'/[0-9a-f]{24}\\.(jpg|png|webp|gif)$').test(x.to),'to a live copy: '+x.to); }
    ok(!/\/drafts\//.test(JSON.stringify(p.after_photos)),p.name+': no draft link after');
    eq(new Set(p.promote.map(x=>x.sha)).size,p.promote.length,p.name+': one live copy per picture');
  }
});
await t('Assurance: the Elongated option photo that IS a gallery photo becomes ONE live copy (no duplicate thumbnail); Round keeps its own photo',async()=>{
  const a=dry.ready.find(p=>p.skus.includes('7YR05310TSS')); const opt=c=>a.after_photos.options.find(o=>o.sku===c).image;
  ok(a.after_photos.gallery.includes(opt('7YE05310TSS')),'Elongated option photo = a gallery photo URL');
  ok(!a.after_photos.gallery.includes(opt('7YR05310TSS')),'Round photo is its own');
  ok(opt('7YR05310TSS')!==opt('7YE05310TSS'),'two options, two photos');
  ok(a.deduped.some(d=>d.why==='same bytes'),JSON.stringify(a.deduped));
  /* the storefront rule (pageImageFor): a thumbnail equal to the hero is hidden — so Elongated's detail shows its photo once */
  const thumbs=a.after_photos.gallery.filter(u=>u!==opt('7YE05310TSS')); eq(thumbs.length,a.after_photos.gallery.length-1);
});
await t('approval is tied to the exact dry run: a stale plan hash is refused and nothing is recorded; the dry-run approval writes nothing',async()=>{
  const n=W.db.mfr_decisions.length;
  let r=await call(C,{action:'publish_approve',plan_hash:'0'.repeat(64),reason:'x'}); eq([r.status,r.body.error],[409,'dry_run_stale']);
  r=await call(C,{action:'publish_approve',plan_hash:dry.plan_hash,reason:''}); eq(r.status,400);
  r=await call(C,{action:'publish_approve',plan_hash:dry.plan_hash,reason:'Approve & Publish Bemis',dry_run:true}); eq([r.status,r.body.dry_run,r.body.would_record.pages.length,r.body.would_record.photos>0],[200,true,3,true]);
  eq(W.db.mfr_decisions.length,n,'nothing recorded');
});
await t('anything changed after approval invalidates it (a decision recorded on a held page): promote and execute refuse, nothing copied',async()=>{
  let r=await call(C,{action:'publish_approve',plan_hash:dry.plan_hash,reason:'Approve & Publish Bemis'}); eq(r.status,200,JSON.stringify(r.body)); const stale=r.body.decision.id;
  const heldPk=dry.held.find(h=>h.skus.includes('7YA06303TWA')).page_key;
  eq((await call(C,withWin({action:'enrich_resolve',page_key:heldPk,issue:'hold',choice:'hold_back',reason:'still waiting on Bemis'}))).status,200);
  const stored=W.store.length;
  r=await call(C,{action:'publish_promote',decision_id:stale}); eq([r.status,r.body.error],[409,'approval_invalid']);
  r=await call(C,{action:'publish_execute',decision_id:stale}); eq([r.status,r.body.error],[409,'approval_invalid']);
  eq(W.store.length,stored); ok(!W.db.product_content.some(r=>r.manufacturer===S.REAL&&r.status==='published'),'nothing published');
});
await t('a new dry run and approval; nothing is published before every live copy exists',async()=>{
  dry=(await call(C,{action:'publish_plan'})).body; eq(dry.publishable,true);
  const r=await call(C,{action:'publish_approve',plan_hash:dry.plan_hash,reason:'Approve & Publish Bemis — Release D'}); eq(r.status,200); did=r.body.decision.id;
  const x=await call(C,{action:'publish_execute',decision_id:did}); eq([x.status,x.body.error],[409,'photos_not_live']);
  ok(!W.db.product_content.some(r=>r.manufacturer===S.REAL&&r.status==='published'),'nothing published');
});
await t('promote: every approved photo copied once to its live path, never overwriting; nothing dealer-visible yet',async()=>{
  const r=await promoteAll(C,did); eq([r.status,r.body.remaining,r.body.failed.length],[200,0,0],JSON.stringify(r.body).slice(0,300));
  const live=W.store.filter(s=>/^bemis\/live\//.test(s.path)); ok(live.length===dry.ready.reduce((n,p)=>n+p.promote.length,0),'one upload per live copy ('+live.length+')');
  ok(live.every(s=>s.upsert==='false'),'x-upsert false');
  const again=await promoteAll(C,did); eq(again.body.promoted,again.body.of,'re-running is a no-op'); eq(W.store.filter(s=>/^bemis\/live\//.test(s.path)).length,live.length,'no second upload');
  ok(!W.db.product_content.some(r=>r.manufacturer===S.REAL&&r.status==='published'),'still nothing published');
});
await t('execute: exactly the 3 Ready pages published, live photos only; held drafts untouched; the live dealer view = the approved one; the approval spent',async()=>{
  const r=await call(C,{action:'publish_execute',decision_id:did}); eq(r.status,200,JSON.stringify(r.body).slice(0,800));
  ok(r.body.checks.every(c=>c.pass),JSON.stringify(r.body.checks.filter(c=>!c.pass)));
  const pub=W.db.product_content.filter(x=>x.manufacturer===S.REAL&&x.status==='published');
  eq(pub.map(x=>x.page_key).sort(),dry.ready.map(p=>p.page_key).sort());
  ok(pub.every(x=>x.draft_window==null && !/\/drafts\//.test(JSON.stringify([x.image,x.images_gallery,x.skus]))),'no draft stamp or link on a live page');
  eq(JSON.stringify(W.db.product_content.filter(r=>dry.held.some(h=>h.page_key===r.page_key))).length>0,true);
  ok(dry.held.every(h=>{ const row=W.db.product_content.find(r=>r.page_key===h.page_key); return row && row.status!=='published'; }),'held hidden');
  ok(W.db.mfr_decisions.find(d=>d.id===did).used_at,'approval spent');
  const again=await call(C,{action:'publish_execute',decision_id:did}); eq([again.status,again.body.error],[409,'approval_spent']);
  const pl=(await call(C,{action:'enrich_plan'})).body;
  eq(pl.pages.filter(p=>p.status==='published').length,3,'Review Issues: 3 published'); eq(pl.pages.filter(p=>p.status==='held_back').length,4,'4 still held, issues kept');
  ok(pl.pages.filter(p=>p.status==='held_back').every(p=>p.issues.length),'held issues intact');
});
await t('finalize: full verification passes, saved as the new Gold Standard with the content fingerprint, the window spent; rollback then refused',async()=>{
  const dryF=await finalize(W,did,{dry_run:true}); eq([dryF.status,dryF.body.would_pass],[200,true],JSON.stringify(dryF.body.failed||dryF.body).slice(0,400));
  eq(W.db.mfr_verification_runs.length,0,'the finalize dry run saved nothing');
  const r=await finalize(W,did); eq(r.status,200,JSON.stringify(r.body).slice(0,600));
  const run=W.db.mfr_verification_runs.find(x=>x.id===r.body.run_id); eq([run.phase,run.result],['post','pass']);
  ok(run.checks.some(c=>c.id==='publication'&&c.detail.decision===did),'publication recorded');
  const cf=run.checks.find(c=>c.id==='content_fingerprint'); ok(cf && cf.severity==='blocking' && cf.detail.fingerprint,'content fingerprint is part of the Gold Standard');
  ok(W.db.mfr_decisions.find(d=>d.kind==='enrichment_window'&&d.manufacturer===S.REAL).used_at,'window spent');
  const rb=await S.call(S.mod(W),{action:'mc_publish_rollback',manufacturer:S.REAL,decision_id:did,reason:'test'}); ok(rb.status!==200||!rb.body.rolled_back,'rollback refused once Gold Standard');
  eq(W.db.product_content.filter(x=>x.manufacturer===S.REAL&&x.status==='published').length,3);
  const f2=await finalize(W,did); eq([f2.status,f2.body.error],[409,'already_finalized']);
  /* the next regression run reads the new Gold Standard: same price fingerprint and content fingerprint */
  const v=await S.call(S.mod(W),{action:'mc_verify',manufacturer:S.REAL,phase:'regression',save:false}); eq(v.body.result,'pass',JSON.stringify(v.body.failed));
  ok(v.body.checks.find(c=>c.id==='content_fingerprint').pass && v.body.checks.find(c=>c.id==='content_fingerprint').severity==='blocking','content fingerprint enforced');
});
await t('the held drafts stay hidden and unchanged for a future window',async()=>{
  const heldNow=W.db.product_content.filter(r=>dry.held.some(h=>h.page_key===r.page_key));
  /* (the window stamp itself is the database's work — proven in Postgres by test/mc-publication.pg.test.js, adoption included) */
  ok(heldNow.length===4 && heldNow.every(r=>['published','active','discontinued'].indexOf(r.status)<0),'hidden');
  eq(JSON.stringify(heldNow.map(r=>[r.page_key,r.status,r.description,r.image]).sort()),JSON.stringify(JSON.parse(held0).map(r=>[r.page_key,r.status,r.description,r.image]).sort()),'unchanged since Release C');
});
await t('a refused publication changes nothing (forced database refusal)',async()=>{
  const W2=world(); const C2=PC(W2); await releaseC(W2,C2);
  const d=(await call(C2,{action:'publish_plan'})).body; const a=(await call(C2,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  await promoteAll(C2,a); const before=JSON.stringify(W2.db.product_content);
  W2.failPublishAt='x'; const r=await call(C2,{action:'publish_execute',decision_id:a}); eq([r.status,r.body.error],[409,'publication_refused']);
  eq(JSON.stringify(W2.db.product_content),before,'nothing changed'); ok(!W2.db.mfr_decisions.find(x=>x.id===a).used_at,'approval not spent');
});
await t('a failed post-publish check rolls back to the previous safe view, records the failed run, and never rolls forward',async()=>{
  const W3=world(); const C3=PC(W3); await releaseC(W3,C3);
  const d=(await call(C3,{action:'publish_plan'})).body; const a=(await call(C3,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  await promoteAll(C3,a); const before=JSON.parse(JSON.stringify(W3.db.product_content));
  /* a held page becomes visible behind the publication's back (between publish and verify) */
  const held=W3.db.product_content.find(r=>r.page_key===d.held[0].page_key);
  const realFetch=W3.fetch; let tampered=false;
  W3.fetch=async(u,o)=>{ const res=await realFetch(u,o); if(!tampered && /rpc\/mfr_content_publish$/.test(String(u)) && res.ok){ tampered=true; held.status='published'; } return res; };
  const C3b=PC(W3); const r=await call(C3b,{action:'publish_execute',decision_id:a});
  eq([r.status,r.body.error,r.body.rolled_back],[409,'verification_failed',true],JSON.stringify(r.body).slice(0,600));
  ok(r.body.checks.some(c=>c.id==='only_approved_pages_visible'&&!c.pass),'the check that caught it');
  const pubNow=W3.db.product_content.filter(x=>d.ready.some(p=>p.page_key===x.page_key));
  ok(pubNow.every(x=>{ const b=before.find(y=>y.page_key===x.page_key); return ['status','draft_window','image','images_gallery','skus'].every(f=>JSON.stringify(x[f]==null?null:x[f])===JSON.stringify(b[f]==null?null:b[f])); }),'the 3 pages are back exactly as before');
  const run=W3.db.mfr_verification_runs.find(x=>x.result==='fail'); ok(run && run.checks.some(c=>c.id==='rolled_back'&&c.pass),'failed run recorded');
  const again=await call(C3b,{action:'publish_execute',decision_id:a}); eq(again.body.error,'approval_spent','no silent roll-forward: a new dry run and approval are needed');
});
await t('manual rollback before finalizing (e.g. the storefront check failed): restored, recorded',async()=>{
  const W4=world(); const C4=PC(W4); await releaseC(W4,C4);
  const d=(await call(C4,{action:'publish_plan'})).body; const a=(await call(C4,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  await promoteAll(C4,a); eq((await call(C4,{action:'publish_execute',decision_id:a})).status,200);
  const r=await S.call(S.mod(W4),{action:'mc_publish_rollback',manufacturer:S.REAL,decision_id:a,reason:'phone layout wrong'}); eq([r.status,r.body.rolled_back],[200,true]);
  ok(!W4.db.product_content.some(x=>x.manufacturer===S.REAL&&x.status==='published'),'nothing live');
  ok(W4.db.mfr_verification_runs.some(x=>x.result==='fail'&&x.checks.some(c=>c.id==='publication'&&c.detail.reason==='phone layout wrong')),'recorded');
});
await t('the approval also goes stale when a commercial record or a held draft changes, or a draft photo changes before promotion',async()=>{
  const W5=world(); const C5=PC(W5); await releaseC(W5,C5);
  let d=(await call(C5,{action:'publish_plan'})).body, a=(await call(C5,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  /* a commercial field dealers never see (it changes no card), so only the record itself carries it into the hash */
  const rec=W5.db.product_skus.find(r=>r.manufacturer===S.REAL&&r.code==='7YE82350TC'); const was=rec.status_note; rec.status_note='changed after approval';
  eq((await call(C5,{action:'publish_promote',decision_id:a})).body.error,'approval_invalid','a commercial change'); rec.status_note=was;
  if(was===undefined) delete rec.status_note;
  const heldRow=W5.db.product_content.find(r=>r.page_key===d.held[0].page_key); const desc=heldRow.description; heldRow.description='changed behind the plan';
  eq((await call(C5,{action:'publish_promote',decision_id:a})).body.error,'approval_invalid','a held draft change'); heldRow.description=desc;
  eq((await call(C5,{action:'publish_promote',decision_id:a})).status,200,'restored: the same plan again');
  /* a draft photo replaced in storage after approval: the copy is refused, nothing goes live */
  const W6=world(); const C6=PC(W6); await releaseC(W6,C6);
  d=(await call(C6,{action:'publish_plan'})).body; a=(await call(C6,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  const k=Object.keys(W6.blob).find(x=>/\/drafts\/w\d+\//.test(x)); W6.blob[k]={body:Buffer.alloc(5000,7),type:'image/jpeg'};
  let r; for(let i=0;i<10;i++){ r=await call(C6,{action:'publish_promote',decision_id:a}); if(r.status!==200||!r.body.remaining) break; }
  ok(r.status===502 && r.body.failed.some(f=>/changed since the dry run/.test(f.error)),JSON.stringify(r.body).slice(0,300));
  eq((await call(C6,{action:'publish_execute',decision_id:a})).body.error,'photos_not_live');
});
await t('a line whose preview fails cannot be approved (enriched only would drop the held SKUs)',async()=>{
  const W7=world(); const C7=PC(W7); await releaseC(W7,C7);
  W7.db.manufacturer_meta.forEach(m=>{ if(m.slug===S.REAL) m.enriched_only=true; });
  const d=(await call(C7,{action:'publish_plan'})).body; eq(d.publishable,false); ok(d.problems.some(x=>/preview of the publication fails/.test(x)),JSON.stringify(d.problems));
  const r=await call(C7,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'}); eq([r.status,r.body.error],[409,'not_publishable']);
});
await t('a published page changed between publish and verify is caught (live ≠ approved) and rolled back',async()=>{
  const W8=world(); const C8=PC(W8); await releaseC(W8,C8);
  const d=(await call(C8,{action:'publish_plan'})).body; const a=(await call(C8,{action:'publish_approve',plan_hash:d.plan_hash,reason:'x'})).body.decision.id;
  await promoteAll(C8,a);
  const realFetch=W8.fetch; let done=false;
  W8.fetch=async(u,o)=>{ const res=await realFetch(u,o); if(!done && /rpc\/mfr_content_publish$/.test(String(u)) && res.ok){ done=true; const r=W8.db.product_content.find(x=>x.page_key===d.ready[0].page_key); r.description='Edited behind the approval'; } return res; };
  const C8b=PC(W8); const r=await call(C8b,{action:'publish_execute',decision_id:a});
  eq([r.status,r.body.rolled_back],[409,true]); ok(r.body.checks.some(c=>c.id==='live_equals_approved'&&!c.pass),JSON.stringify(r.body.checks.map(c=>c.id+':'+c.pass)));
});
await t('after the Gold Standard, a content change on a published page fails the regression verification (content fingerprint)',async()=>{
  const r=W.db.product_content.find(x=>x.manufacturer===S.REAL&&x.status==='published'); const was=r.description; r.description='A silent content regression';
  const v=await S.call(S.mod(W),{action:'mc_verify',manufacturer:S.REAL,phase:'regression',save:false});
  eq(v.body.result,'fail'); ok(v.body.failed.includes('content_fingerprint'),JSON.stringify(v.body.failed));
  r.description=was; const v2=await S.call(S.mod(W),{action:'mc_verify',manufacturer:S.REAL,phase:'regression',save:false}); eq(v2.body.result,'pass');
});
console.log(`mc publish & verify (Release D): ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

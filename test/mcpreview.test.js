/* Manufacturer Center Release C — Dealer Preview, in the Release B sandbox (test/mcenrich.world.js: the frozen
   Bemis-shaped line with its real catalog file). Bemis is enriched, three pages made Ready, the other four held back
   for source review — then the REAL product-content handler builds the preview with the storefront's own merge:
     · all 9 active SKUs on exactly one card, today and proposed; 0 missing, 0 duplicates; the retired SKU off both;
     · the Ready pages are one card each — Round + Elongated one card with two distinct options;
     · held-back SKUs keep today's product byte for byte (current catalog card), with a staff-only note that never
       enters a product a dealer receives;
     · nothing commercial moves (price, MSRP, MAP, tiers, UOM / case qty, price words, freight);
     · held drafts' copy and photos never reach the proposed dealer view; today's view carries no draft photo;
     · the preview writes nothing (the whole sandbox is byte-identical) and the line's verification fingerprint holds;
     · a line switched to 'enriched only' would drop held SKUs — the preview says so and fails. */
const path=require('path');
const {S,ROOT,WIN,world,PC,call,withWin}=require('./mcenrich.world.js');
const PV=require(path.join(ROOT,'_preview.js'));
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,3).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
async function enrichAll(C){
  const plan=(await call(C,{action:'enrich_plan'})).body;
  for(const p of plan.pages){ await call(C,withWin({action:'enrich_page',page_key:p.page_key}));
    for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:p.page_key})); if(!im.body.remaining) break; } }
  return (await call(C,{action:'enrich_plan'})).body;
}
const pageOf=(plan,code)=>plan.pages.find(p=>p.skus.some(s=>s.code===code));
async function readyAndHeld(W,C){
  let plan=await enrichAll(C);
  /* Round + Elongated: an official photo per option (Release B decisions 324/325), then a re-run */
  const seat=pageOf(plan,'7YR05310TSS').page_key;
  for(const [code,img] of [['7YR05310TSS','R85320TSS-000-F'],['7YE05310TSS','E85320TSS-000-F']])
    eq((await call(C,withWin({action:'enrich_resolve',page_key:seat,issue:'needs_image',choice:'use_source_image',value:{code,image_url:'https://www.toiletseats.com/assets/'+img+'.jpg'},reason:'official top view, viewed'}))).status,200);
  await call(C,withWin({action:'enrich_page',page_key:seat})); for(let i=0;i<10;i++){ const im=await call(C,withWin({action:'enrich_images',page_key:seat})); if(!im.body.remaining) break; }
  plan=(await call(C,{action:'enrich_plan'})).body;
  /* every page that is not Ready is held back for source review */
  for(const p of plan.pages.filter(p=>p.status!=='ready'))
    eq((await call(C,withWin({action:'enrich_resolve',page_key:p.page_key,issue:'hold',choice:'hold_back',reason:'source hold (Angelo)'}))).status,200);
  return (await call(C,{action:'enrich_plan'})).body;
}

(async()=>{
let W, C, plan, pv;
await t('the sandbox: 3 Ready pages (Assist, Assurance Round + Elongated, Rise) and 4 held back, with their issues still listed',async()=>{
  W=world(); C=PC(W); plan=await readyAndHeld(W,C);
  eq(plan.pages.filter(p=>p.status==='ready').map(p=>p.skus.map(s=>s.code).join('+')).sort(),['7YA04505T','7YA0AS100','7YR05310TSS+7YE05310TSS']);
  const held=plan.pages.filter(p=>p.status==='held_back'); eq(held.length,4);
  ok(held.every(p=>!p.blocking && p.issues.length && p.issues.every(i=>i.held===true)),'held pages keep their issues, listed and not blocking');
});
await t('Preview Bemis as Dealer: read-only — the whole sandbox is byte-identical afterwards',async()=>{
  const before=JSON.stringify(W.db), stored=W.store.length;
  const r=await call(C,{action:'enrich_preview'}); eq(r.status,200,JSON.stringify(r.body).slice(0,400)); pv=r.body;
  eq(JSON.stringify(W.db),before,'nothing written'); eq(W.store.length,stored,'nothing copied to storage');
  eq(pv.read_only,true);
});
await t('the summary: 3 enriched pages ready, 4 held back, 9 active SKUs accounted for, 0 missing, 0 duplicates, 0 commercial changes',async()=>{
  const s=pv.summary; eq([s.enriched_pages_ready,s.held_back,s.active_skus,s.accounted,s.missing,s.duplicates,s.commercial_changes],[3,4,9,9,0,0,0]);
  eq(s.retired_excluded,['DO5300RD444']);
  const failed=pv.checks.filter(c=>!c.pass); eq(failed.map(c=>c.id),[],JSON.stringify(failed).slice(0,600)); eq(pv.pass,true);
});
await t('every active SKU is on exactly one card, today and proposed; the retired SKU is on neither',async()=>{
  const codes=pv.skus.map(s=>s.code).sort(); eq(codes.length,9);
  for(const s of pv.skus){ eq([s.today_card.length,s.proposed_card.length],[1,1],s.code); ok(s.orderable_today && s.orderable_proposed,s.code+' orderable'); ok(s.commercial_same,s.code); }
  const all=list=>list.flatMap(c=>c.codes); for(const L of [pv.today,pv.proposed]){ const a=all(L); eq(a.length,new Set(a).size,'no SKU twice'); ok(a.indexOf('DO5300RD444')<0,'retired off'); }
});
await t('Round + Elongated render as ONE enriched card with two distinct options and their own photos',async()=>{
  const c=pv.proposed.filter(k=>k.codes.includes('7YR05310TSS')); eq(c.length,1); const k=c[0];
  eq([k.enriched,k.codes.sort().join('+'),k.options.length],[true,'7YE05310TSS+7YR05310TSS',2]);
  /* the storefront's own picker words (variantLabel): the SKU name after the page name, which contains the option */
  const L=k.options.map(o=>o.label); eq(new Set(L).size,2); ok(/Round/.test(L.find(l=>/Round/.test(l))||'') && L.some(l=>/Elongated/.test(l)),JSON.stringify(L));
  const r=k.options.find(o=>o.code==='7YR05310TSS'), e=k.options.find(o=>o.code==='7YE05310TSS');
  ok(/R85320TSS-000-F/.test(r.image) && /E85320TSS-000-F/.test(e.image),r.image+' / '+e.image);
  ok(r.cart.sub.indexOf('7YR05310TSS')===0 && /Round/.test(r.cart.sub) && /Unit \$/.test(r.cart.money),JSON.stringify(r.cart));
  ok(k.staff_note===null,'an enriched card carries no staff note');
});
await t('held-back products keep their current catalog cards, marked for staff only — the note never enters dealer data',async()=>{
  for(const code of ['7YE82350TC','7YA05313BLK','7YA05313GRY','7YA06303TWA','444DISPLAY']){
    const k=pv.proposed.find(c=>c.codes.includes(code)); ok(k && !k.enriched && k.staff_note===PV.HELD_NOTE,code+' '+JSON.stringify(k&&{e:k.enriched,n:k.staff_note}));
    const tk=pv.today.find(c=>c.codes.includes(code)); eq([k.name,k.description,k.image,k.options.map(o=>o.price_text)],[tk.name,tk.description,tk.image,tk.options.map(o=>o.price_text)],code+' same card as today'); }
  ok(pv.today.every(c=>c.staff_note===null),'today has no staff notes');
  ok(pv.proposed.every(c=>c.options.every(o=>JSON.stringify(o).indexOf('enrichment held')<0)),'the note is not in any option or cart line');
  ok(pv.checks.find(c=>c.id==='held_items_unchanged').pass,'held SKUs byte-identical');
});
await t('today vs proposed: today no card is enriched; proposed, exactly the Ready pages are',async()=>{
  ok(pv.today.every(c=>!c.enriched),'today: current catalog cards only');
  eq(pv.proposed.filter(c=>c.enriched).map(c=>c.page_key).sort(),pv.ready_pages.map(p=>p.page_key).sort());
});
await t('after the preview the line verification still reads the same fingerprint (nothing dealer-facing changed)',async()=>{
  const CA=S.mod(W); const v=await S.call(CA,{action:'mc_verify',manufacturer:S.REAL,phase:'release',save:false}); eq(v.status,200);
  const C2=PC(W); C=C2;   // (loading catalog-api took the world's fetch; reload product-content on the same world)
  const v2=await S.call(S.mod(W),{action:'mc_verify',manufacturer:S.REAL,phase:'release',save:false}); eq(v2.body.fingerprint,v.body.fingerprint);
  eq(W.db.mfr_verification_runs.length,0,'no run saved');
});
await t('a line switched to "enriched only" would drop the held SKUs — the preview says so and fails',async()=>{
  const W2=world(); const C2=PC(W2); await readyAndHeld(W2,C2);
  W2.db.manufacturer_meta.forEach(m=>{ if(m.slug===S.REAL) m.enriched_only=true; });
  const r=await call(C2,{action:'enrich_preview'}); eq(r.status,200);
  const f=r.body.checks.filter(c=>!c.pass).map(c=>c.id); ok(f.includes('enriched_only_off') && f.includes('all_active_skus_represented'),JSON.stringify(f));
  eq(r.body.summary.missing,5,'the 5 held SKUs (Steadfast, Support Arms ×2, Bidet, Display)'); eq(r.body.pass,false);
});
await t('unit: a held draft treated as published would leak — the leak and held-unchanged checks catch it',async()=>{
  const rows=PV.proposedContentRows([{page_key:'live',status:'published'}],[{page_key:'a',status:'pending_review',enrichment_flags:{x:1}},{page_key:'live',status:'pending_review'},{page_key:'b',status:'pending_review'}],new Set(['a','live']));
  eq(rows.map(r=>r.page_key+':'+r.status),['live:published','a:published'],'only Ready drafts, never over a live page'); ok(!('enrichment_flags' in rows[1]),'internal report stripped');
});
await t('unit: the accounting catches a duplicate card, a commercial change, a moved held SKU, a retired SKU listed, a split Ready page and new held words',async()=>{
  const PICK=require(path.join(ROOT,'_shop_picker.js'));
  const R={priceHtml:p=>'<span class="price">$'+Number(p.base_price).toFixed(2)+'</span>',freightRowsHtml:()=>'',packOf:()=>null,money:n=>'$'+Number(n).toFixed(2)};
  const eng={unitPrice:p=>Number(p.base_price),computeFreight:()=>({fee:0,rows:[]})};
  const rec=[{code:'A',base_price:10,status:'active'},{code:'B',base_price:20,status:'active'},{code:'H',base_price:5,status:'active'},{code:'X',base_price:1,status:'retired'}];
  const prod=(code,price,extra)=>Object.assign({code,name:code,base_price:price},extra||{});
  const pages=[{page_key:'pa',name:'Page A',status:'ready',skus:[{code:'A'},{code:'B'}]},{page_key:'ph',name:'Held',status:'held_back',skus:[{code:'H'}]}];
  const today=[prod('A',10),prod('B',20),prod('H',5)];
  const good=[prod('A',10,{_pageKey:'pa',_encPage:'Page A',_skuOption:'Round'}),prod('B',20,{_pageKey:'pa',_encPage:'Page A',_skuOption:'Elongated'}),prod('H',5)];
  const run=(proposed,drafts)=>PV.buildPreview({slug:'s',records:rec,meta:{},pages,drafts:drafts||[],R,PICK,today:{products:today,engine:eng},proposed:{products:proposed,engine:eng}});
  const bad=r=>r.checks.filter(c=>!c.pass).map(c=>c.id);
  eq(bad(run(good)),[]);
  ok(bad(run(good.concat([prod('H',5,{group:'other'})]))).includes('no_duplicates'),'a SKU on two cards');
  ok(bad(run([good[0],prod('B',21,{_pageKey:'pa',_encPage:'Page A',_skuOption:'Elongated'}),good[2]])).includes('commercial_unchanged'),'a price moved');
  ok(bad(run([good[0],good[1],prod('H',5,{description:'new words'})])).includes('held_items_unchanged'),'a held SKU changed');
  ok(bad(run(good.concat([prod('X',1)]))).includes('retired_excluded'),'a retired SKU listed');
  ok(bad(run([good[0],prod('B',20,{_skuOption:'Elongated'}),good[2]])).includes('ready_pages_one_card'),'a Ready page split over two cards');
  ok(bad(run([good[0],good[1],prod('H',5,{description:'A held draft sentence that dealers have never seen before today'})],[{page_key:'ph',description:'A held draft sentence that dealers have never seen before today'}])).includes('held_content_not_shown'),'held words leaked');
  ok(bad(run(good.slice(0,2))).includes('all_active_skus_represented'),'a SKU missing');
  const f=PV.buildPreview({slug:'s',records:rec,meta:{},pages,drafts:[],R,PICK,today:{products:today,engine:eng},proposed:{products:good,engine:{unitPrice:eng.unitPrice,computeFreight:()=>({fee:9,rows:[]})}}});
  ok(bad(f).includes('freight_unchanged'),'freight moved');
});
console.log(`mc dealer preview (Release C): ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

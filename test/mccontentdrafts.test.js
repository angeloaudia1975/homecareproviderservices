/* Manufacturer Center Release A — hidden drafts change nothing a dealer sees. The full verification (storefront
   engine and render code, cards, cart, freight, emails, fingerprint) runs on the Bemis-shaped frozen line of the
   Phase 6 sandbox (test/mcflow.world.js), then again after hidden draft pages for every one of its SKUs are added
   in every hidden state an enrichment window can leave (pending review, approved, hidden, rejected, published but
   disabled): same result, same fingerprint, same check by check. A control then makes ONE page visible and the
   fingerprint moves — so the comparison can see a real change. */
const S=require('./mcflow.world.js');
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n);}catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
const canonChecks=cs=>JSON.stringify((cs||[]).map(c=>[c.id,c.pass,c.severity]));
(async()=>{
  const W=S.world(), C=S.mod(W);
  const verify=async()=>{ const r=await S.call(C,{action:'mc_verify',manufacturer:S.REAL,phase:'release',save:false}); ok(r.status===200,JSON.stringify(r.body).slice(0,300)); return r.body; };
  let base;
  await t('baseline: the frozen Bemis-shaped line verifies, nothing saved',async()=>{
    base=await verify(); eq([base.result,base.run_id],['pass',null],JSON.stringify(base.failed));
    eq(W.db.mfr_verification_runs.length,0,'save:false saves no run');
  });
  await t('hidden drafts for every SKU, in every hidden state, change nothing: same result, same fingerprint, same checks',async()=>{
    const codes=S.fx.source.rows.map(r=>r.code);
    const states=[['pending_review',false],['approved',false],['hidden',false],['rejected',false],['published',true]];
    states.forEach(([status,disabled],i)=>W.db.product_content.push({id:'d'+i,manufacturer:S.REAL,page_key:'draft-'+status+(disabled?'-disabled':''),
      name:'DRAFT '+status, description:'Draft copy that must not show', features:['a','b','c'], category:'Bath Safety', subcategory:'Toilet Seats',
      image:'https://draft.invalid/'+i+'.jpg', images_gallery:[{url:'https://draft.invalid/'+i+'.jpg',primary:true}], skus:codes.map(c=>({sku:c})), status, disabled}));
    const after=await verify();
    eq([after.result,after.fingerprint],[base.result,base.fingerprint],'fingerprint');
    eq(canonChecks(after.checks),canonChecks(base.checks),'every check reads the same');
  });
  await t('control: one VISIBLE page moves the fingerprint (the comparison can see a real change)',async()=>{
    const codes=S.fx.source.rows.map(r=>r.code);
    W.db.product_content.push({id:'vis',manufacturer:S.REAL,page_key:'visible-page',name:'VISIBLE PAGE',description:'Shown',features:['a'],category:'Bath Safety',subcategory:'Toilet Seats',
      image:'https://draft.invalid/v.jpg', images_gallery:[{url:'https://draft.invalid/v.jpg',primary:true}], skus:[{sku:codes[0]}], status:'published', disabled:false});
    const after=await verify();
    ok(after.fingerprint!==base.fingerprint,'a published page changed what dealers see, and the fingerprint shows it');
  });
  console.log(`mc content drafts (zero dealer change): ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

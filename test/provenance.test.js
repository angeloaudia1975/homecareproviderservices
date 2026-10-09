/* set_record_provenance — the approved source file is stamped on the master record, and only there. */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const OB='https://ordering.test';
const norm=c=>String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const LINE='climbing-steps', FILE='Climbing Steps 2026 Pricing website 982026.xlsx';
function world(failRead,failWrite){
  const W=M.createWorld({tables:{manufacturer_meta:[],product_overrides:[{manufacturer:LINE,code:'MP-P08',patch:{base_price:297.49}}],custom_products:[],product_content:[],
    product_skus:[{manufacturer:LINE,code:'MP-P08',base_price:297.49,map:424.99,msrp:1049.99,status:'active',source_file:'old.xls'},
                  {manufacturer:LINE,code:'FCOM-02',base_price:1399.99,status:'active'},
                  {manufacturer:LINE,code:'OLD-1',base_price:5,status:'not_listed'}].map(r=>Object.assign(r,{code_norm:norm(r.code)}))},
    failRead:(tb)=>tb===failRead?500:0, failWrite:(m,tb)=>tb===failWrite?500:0});
  const inner=W.fetch; W.fetch=async(u,o)=>String(u).startsWith(OB)?{ok:false,status:404,text:async()=>'',json:async()=>null}:inner(u,o); return W;
}
const mod=W=>M.load('catalog-api.js',W,{ANALYTICS_TOKEN:'pass',ORDERING_BASE:OB},ROOT);
const call=(C,b)=>M.call(C,b,{headers:{'x-analytics-token':'pass'}});
const rec=(W,c)=>W.db.product_skus.find(r=>r.code===c);
(async()=>{
await t('stamps the file and date on the listed records only — no price, no layer',async()=>{
  const W=world(); const C=mod(W); const before=JSON.stringify(W.db.product_overrides);
  const r=await call(C,{action:'set_record_provenance',manufacturer:LINE,codes:['MP-P08','fcom-02'],source_file:FILE,effective_date:'2026-09-08'});
  eq([r.status,r.body.stamped],[200,['MP-P08','FCOM-02']],'answer');
  eq([rec(W,'MP-P08').source_file,rec(W,'MP-P08').effective_date,rec(W,'MP-P08').base_price,rec(W,'MP-P08').map],[FILE,'2026-09-08',297.49,424.99],'record');
  eq(rec(W,'OLD-1').source_file,undefined,'retired record untouched');
  eq(JSON.stringify(W.db.product_overrides),before,'layers untouched');
  eq(W.writes.filter(w=>w.table!=='product_skus').length,0,'no other table written');
});
await t('a code with no record, or a retired one, stops everything',async()=>{
  for(const codes of [['MP-P08','NOPE'],['MP-P08','OLD-1']]){
    const W=world(); const C=mod(W); const n=W.writes.length;
    const r=await call(C,{action:'set_record_provenance',manufacturer:LINE,codes,source_file:FILE});
    eq([r.status,r.body.error],[409,'not_stamped'],'refused '+codes); eq(W.writes.length,n,'nothing written');
  }
});
await t('an unreadable record is a 503 and nothing is written',async()=>{
  const W=world('product_skus'); const C=mod(W); const n=W.writes.length;
  const r=await call(C,{action:'set_record_provenance',manufacturer:LINE,codes:['MP-P08'],source_file:FILE});
  eq(r.status,503); eq(W.writes.length,n);
});
await t('a failed write says what was stamped',async()=>{
  const W=world(null,'product_skus'); const C=mod(W);
  const r=await call(C,{action:'set_record_provenance',manufacturer:LINE,codes:['MP-P08'],source_file:FILE});
  eq([r.status,r.body.error,r.body.stamped],[502,'provenance_incomplete',[]]);
});
await t('dry run writes nothing and shows the current provenance',async()=>{
  const W=world(); const C=mod(W); const n=W.writes.length;
  const r=await call(C,{action:'set_record_provenance',manufacturer:LINE,codes:['MP-P08'],source_file:FILE,dry_run:true});
  eq([r.status,r.body.before[0].source_file],[200,'old.xls']); eq(W.writes.length,n);
});
await t('bad input is refused',async()=>{
  const C=mod(world());
  eq((await call(C,{action:'set_record_provenance',manufacturer:LINE,codes:['MP-P08']})).status,400,'no file');
  eq((await call(C,{action:'set_record_provenance',manufacturer:LINE,source_file:FILE})).status,400,'no codes');
  eq((await call(C,{action:'set_record_provenance',manufacturer:LINE,codes:['MP-P08'],source_file:FILE,effective_date:'9/8/2026'})).status,400,'date');
});
console.log(`provenance: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();

/* REQUEST ACCESS (owner, C3-06 closeout 2026-11-05) — a dealer who can BROWSE a line but is not set up to ORDER it
   (no active dealer_manufacturers row of its own) sees "Request access"; the request goes to HCPS staff and grants
   NOTHING. Runs the REAL dealer-auth and dealer-tools-api handlers against the in-memory PostgREST fake.
     node test/request-access.test.js */
const path=require('path');
const M=require(process.env.MOCK||path.join(__dirname,'phase0-mock.js'));
const ROOT=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
let fail=0, pass=0;
async function t(n,f){ try{ await f(); pass++; console.log('ok   '+n); }catch(e){ fail++; console.log('FAIL '+n+'\n     '+(e&&e.stack||e).toString().split('\n').slice(0,3).join('\n     ')); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };

function world(o){
  o=o||{};
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, failRead:o.failRead, failWrite:o.failWrite, missingTables:o.missingTables,
    uniquePartial:{dealer_access_requests:[{cols:['dealer_id','manufacturer'],where:r=>r.status==='new'}]}, tables:{
    manufacturer_meta:o.meta||[{slug:'yuwell',active:true}],
    app_settings:[{key:'platform_state',value:{mode:'development'}}],
    manufacturers:[{slug:'yuwell',name:'Yuwell'},{slug:'access4u',name:'Access4U'},{slug:'ovation-medical',name:'Ovation Medical'},{slug:'ohio-medical',name:'Ohio Medical'}],
    dealers:[{id:'d1',parent_id:null,business_name:'No Grid Pharmacy',state:'KY',city:'London',rep_email:'greg@homecareproviderservices.us',is_test:false}],
    dealer_users:[{uid:'u1',status:'approved',dealer_id:'d1',email:'d@x.com'}],
    dealer_manufacturers:o.dm||[], dealer_contract_prices:[], dealer_line_discounts:[], geocache:[],
    dealer_access_requests:o.requests||[], carts:[] }});
  const inner=W.fetch; W.mail=[];
  W.fetch=async(url,opts)=>{ const u=String(url);
    if(u.startsWith(M.BASE+'/auth/v1/user')){ const tok=String(((opts&&opts.headers)||{}).Authorization||'').replace(/^Bearer\s+/i,'');
      return tok==='dealer'?{ok:true,status:200,json:async()=>({id:'u1',email:'d@x.com'})}:{ok:false,status:401,json:async()=>({})}; }
    if(u.startsWith('https://api.resend.com')){ W.mail.push(JSON.parse(opts.body)); return {ok:!o.mailFails,status:o.mailFails?500:200,json:async()=>({id:'m'})}; }
    return inner(url,opts); };
  return W;
}
const call=(C,body)=>M.call(C,body,{headers:{authorization:'Bearer dealer'}});
const tools=W=>M.load('dealer-tools-api.js',W,{RESEND_API_KEY:'k'},ROOT);
const writesTo=(W,table)=>W.calls.filter(c=>c.method!=='GET'&&String(c.url||'').includes('/rest/v1/'+table));

(async()=>{
await t('sign-in: a dealer with NO ordering grid gets its territory lines as browse-only (request_access)',async()=>{
  const W=world(); const r=await call(M.load('dealer-auth.js',W,{},ROOT),{action:'me'});
  const a=r.body.access; ok(a,'access computed');
  const browse=[...new Set([...(a.your_accounts||[]),...(a.available||[])])].sort();
  ok(browse.includes('yuwell')&&browse.includes('access4u'),'territory lines shown: '+browse);
  eq(a.request_access,browse,'every browse line needs access — the order server would refuse them all');
});
await t('sign-in: a dealer with an ordering grid has no browse-only lines (it orders what it carries)',async()=>{
  const W=world({dm:[{dealer_id:'d1',manufacturer:'yuwell',active:true},{dealer_id:'d1',manufacturer:'access4u',active:true,account_ref:'A-1'}]});
  const r=await call(M.load('dealer-auth.js',W,{},ROOT),{action:'me'});
  eq(r.body.access.request_access,[],'nothing to request'); eq([...r.body.access.your_accounts,...r.body.access.available].sort(),['access4u','yuwell']);
});
await t('a request records the ask, emails HCPS staff (owner + the dealer\'s rep), and grants NOTHING',async()=>{
  const W=world(); const r=await call(tools(W),{action:'access_request',manufacturer:'yuwell'});
  eq([r.status,r.body.ok,r.body.saved,r.body.notified],[200,true,true,true],JSON.stringify(r.body));
  eq(W.db.dealer_access_requests.map(x=>[x.dealer_id,x.manufacturer,x.status,x.requested_by]),[['d1','yuwell','new','d@x.com']]);
  eq(W.mail.length,1,'one email'); ok(/angelo@homecareproviderservices\.us/.test(W.mail[0].to.join(','))&&/greg@/.test(W.mail[0].to.join(',')),'to staff: '+W.mail[0].to);
  ok(/Nothing has been granted/.test(W.mail[0].html)&&/No Grid Pharmacy/.test(W.mail[0].subject),'explains nothing was granted');
  eq(writesTo(W,'dealer_manufacturers').length,0,'no access row written'); eq(W.db.dealer_manufacturers.length,0,'no access granted');
  ok(!W.mail.some(m=>/yuwell\.com|manufacturer@/i.test(m.to.join(','))),'nothing to a manufacturer');
});
await t('an open request is "already" — no second row, no second email (an old decided one does not block)',async()=>{
  const old=world({requests:[{dealer_id:'d1',manufacturer:'yuwell',status:'declined',created_at:'2026-01-01T00:00:00Z'}]});
  eq((await call(tools(old),{action:'access_request',manufacturer:'yuwell'})).body.saved,true,'a new ask after a decided one');
  const W=world({requests:[{dealer_id:'d1',manufacturer:'yuwell',status:'new',created_at:'2026-01-01T00:00:00Z'}]});
  const r=await call(tools(W),{action:'access_request',manufacturer:'yuwell'});
  eq([r.body.ok,r.body.already],[true,true]); eq([W.db.dealer_access_requests.length,W.mail.length],[1,0]);
});
await t('a line the dealer already carries, an unknown / switched-off / retired line, Golden, and a dealer WITH a grid are not requested',async()=>{
  const W=world({dm:[{dealer_id:'d1',manufacturer:'yuwell',active:true}],meta:[{slug:'yuwell',active:true},{slug:'access4u',active:false}]}); const C=tools(W);
  eq((await call(C,{action:'access_request',manufacturer:'yuwell'})).body.already_carried,true,'carried');
  const G=world({dm:[{dealer_id:'d1',manufacturer:'yuwell',active:true}],meta:[{slug:'yuwell',active:true},{slug:'access4u',active:true}]});
  eq((await call(tools(G),{action:'access_request',manufacturer:'access4u'})).status,400,'a grid dealer has nothing browse-only'); eq(G.mail.length,0);
  /* a dealer with NO grid: each refusal below is its own reason */
  const N=world({meta:[{slug:'yuwell',active:true},{slug:'access4u',active:false}]}); const D=tools(N);
  eq((await call(D,{action:'access_request',manufacturer:'access4u'})).status,400,'switched-off line');
  eq((await call(D,{action:'access_request',manufacturer:'nope-line'})).status,400,'unknown');
  eq((await call(D,{action:'access_request',manufacturer:'ohio-medical'})).status,400,'retired');
  eq((await call(D,{action:'access_request',manufacturer:'golden-technologies'})).status,400,'golden');
  eq((await call(D,{action:'access_request',manufacturer:"x');drop"})).status,400,'bad slug');
  eq([W.db.dealer_access_requests.length,W.mail.length,N.db.dealer_access_requests.length,N.mail.length],[0,0,0,0],'nothing recorded or sent');
});
await t('not signed in: refused',async()=>{
  const W=world(); const r=await M.call(tools(W),{action:'access_request',manufacturer:'yuwell'},{headers:{}});
  eq([r.body.ok,r.body.status],[false,'unauthorized']); eq(W.mail.length,0);
});
await t('without the record (table missing / write refused) nothing is emailed — the button can never send unlimited email',async()=>{
  const W=world({missingTables:['dealer_access_requests']}); const C=tools(W);
  for(let i=0;i<3;i++){ const r=await call(C,{action:'access_request',manufacturer:'yuwell'}); eq([r.status,r.body.ok],[503,false]); }
  eq(W.mail.length,0,'no email');
  const W2=world({failWrite:(m,t)=>m==='POST'&&t==='dealer_access_requests'?500:0}); const r2=await call(tools(W2),{action:'access_request',manufacturer:'yuwell'});
  eq([r2.status,W2.mail.length],[503,0],'a refused write sends nothing');
});
await t('two requests at the same moment: one row, one email (the open-request index decides)',async()=>{
  const W=world(); const C=tools(W);
  const rs=await Promise.all([1,2].map(()=>call(C,{action:'access_request',manufacturer:'yuwell'})));
  eq([W.db.dealer_access_requests.length,W.mail.length],[1,1]); ok(rs.every(r=>r.body.ok===true),'both answered ok');
});
await t('a decided request that the dealer asks for again: only status=new blocks',async()=>{
  const W=world({requests:[{dealer_id:'d1',manufacturer:'yuwell',status:'approved'}]});
  eq((await call(tools(W),{action:'access_request',manufacturer:'yuwell'})).body.saved,true);
});
await t('an unreadable dealer or line is an error, never a guess',async()=>{
  const W=world({failRead:t=>t==='dealer_manufacturers'?500:0}); const r=await call(tools(W),{action:'access_request',manufacturer:'yuwell'});
  eq([r.status,W.mail.length],[503,0]);
});
await t('storefront: a browse-only catalog explains how to get access — never "pricing could not be loaded"',async()=>{
  const fs=require('fs'), vm=require('vm');
  const html=fs.readFileSync(path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html'),'utf8');
  const i=html.indexOf('function renderProducts(){'), j=html.indexOf('const m=cvLine();',i);
  const head=html.slice(i,j)+'}';
  const helpers=html.slice(html.indexOf('/* REQUEST ACCESS (owner, C3-06'),html.indexOf('function renderBanner(){'));
  const run=(acc,source)=>{ const host={innerHTML:''}; const ctx={AUTH:{access:acc},state:{products:[],active:'yuwell',manufacturers:[{slug:'yuwell',name:'Yuwell'}]},
    $:()=>host, RENDER:{}, document:{body:{classList:{add(){}}}}, CATALOG_SOURCE:{yuwell:{source}}, esc:x=>String(x), toast(){}, PREVIEW:null};
    vm.createContext(ctx); vm.runInContext(helpers+'\n'+head+'\nrenderProducts();',ctx); return host.innerHTML; };
  const a=run({request_access:['yuwell']},'unavailable');
  ok(/Request access to order Yuwell/.test(a)&&!/Pricing could not be loaded/.test(a),a);
  ok(/Pricing could not be loaded/.test(run({request_access:[]},'unavailable')),'a carried line keeps the real error');
  const note=vm.runInContext('accessNoticeHtml("yuwell")',(()=>{ const c={AUTH:{access:{request_access:['yuwell']}},state:{manufacturers:[{slug:'yuwell',name:'Yuwell'}]},esc:x=>String(x).replace(/'/g,'&#039;'),toast(){},PREVIEW:null}; vm.createContext(c); vm.runInContext(helpers,c); return c; })());
  ok(/data-slug="yuwell"/.test(note)&&/requestAccess\(this\.dataset\.slug,this\)/.test(note)&&!/You can browse this catalog/.test(note),'notice: '+note);
});
console.log(`\nrequest access: ${pass} passed, ${fail} failed`); process.exitCode=fail?1:0;
})();

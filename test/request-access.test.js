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
  const W=M.createWorld({ tokens:{dealer:'d@x.com'}, failRead:o.failRead, failWrite:o.failWrite, missingTables:o.missingTables, tables:{
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
await t('a repeat within 24 h is "already" — no second row, no second email',async()=>{
  const W=world({requests:[{dealer_id:'d1',manufacturer:'yuwell',status:'new',created_at:new Date().toISOString()}]});
  const r=await call(tools(W),{action:'access_request',manufacturer:'yuwell'});
  eq([r.body.ok,r.body.already],[true,true]); eq([W.db.dealer_access_requests.length,W.mail.length],[1,0]);
});
await t('a line the dealer already carries, an unknown line, a retired line and Golden are not requested',async()=>{
  const W=world({dm:[{dealer_id:'d1',manufacturer:'yuwell',active:true}]}); const C=tools(W);
  eq((await call(C,{action:'access_request',manufacturer:'yuwell'})).body.already_carried,true,'carried');
  eq((await call(C,{action:'access_request',manufacturer:'nope-line'})).status,400,'unknown');
  eq((await call(C,{action:'access_request',manufacturer:'ohio-medical'})).status,400,'retired');
  eq((await call(C,{action:'access_request',manufacturer:'golden-technologies'})).status,400,'golden');
  eq((await call(C,{action:'access_request',manufacturer:"x');drop"})).status,400,'bad slug');
  eq([W.db.dealer_access_requests.length,W.mail.length],[0,0],'nothing recorded or sent');
});
await t('not signed in: refused',async()=>{
  const W=world(); const r=await M.call(tools(W),{action:'access_request',manufacturer:'yuwell'},{headers:{}});
  eq([r.body.ok,r.body.status],[false,'unauthorized']); eq(W.mail.length,0);
});
await t('before the table exists the email still reaches staff; with neither, the dealer is told to retry',async()=>{
  const W=world({missingTables:['dealer_access_requests']}); const r=await call(tools(W),{action:'access_request',manufacturer:'yuwell'});
  eq([r.body.ok,r.body.saved,W.mail.length],[true,false,1]); ok(/only record/.test(W.mail[0].text),'email says it is the only record');
  const W2=world({missingTables:['dealer_access_requests'],mailFails:true}); const r2=await call(tools(W2),{action:'access_request',manufacturer:'yuwell'});
  eq([r2.status,r2.body.ok],[503,false],'not silently lost');
});
await t('an unreadable dealer or line is an error, never a guess',async()=>{
  const W=world({failRead:t=>t==='dealer_manufacturers'?500:0}); const r=await call(tools(W),{action:'access_request',manufacturer:'yuwell'});
  eq([r.status,W.mail.length],[503,0]);
});
console.log(`\nrequest access: ${pass} passed, ${fail} failed`); process.exitCode=fail?1:0;
})();

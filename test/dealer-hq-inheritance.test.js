const assert=require("node:assert/strict");
const {createWorld,load,call,standardSeed,t,done}=require("./phase0-mock");
const m="golden-technologies";
function seed(){
 const s=standardSeed({
   dealers:[
     {id:"hq-family",business_name:"ARH Corporate",hcps_account:"190122",active:true,parent_id:null},
     {id:"child-blank",business_name:"ARH Branch A",hcps_account:"190123",parent_id:"hq-family"},
     {id:"child-new",business_name:"ARH Branch B",hcps_account:"190124",parent_id:"hq-family"},
     {id:"child-special",business_name:"ARH Branch C",hcps_account:"190125",parent_id:"hq-family"},
     {id:"unrelated",business_name:"Outside Company",parent_id:null},
   ],
   dealer_manufacturers:[
     {dealer_id:"hq-family",manufacturer:m,account_ref:"HQ-777",active:true},
     {dealer_id:"child-blank",manufacturer:m,account_ref:null,active:false},
     {dealer_id:"child-blank",manufacturer:"bemis",account_ref:null,active:false},
     {dealer_id:"child-special",manufacturer:m,account_ref:"BRANCH-123",active:true},
     {dealer_id:"unrelated",manufacturer:m,account_ref:null,active:true},
   ],
 });
 return s;
}
const ref=(w,id,manufacturer=m)=>(w.db.dealer_manufacturers||[]).find(r=>r.dealer_id===id&&r.manufacturer===manufacturer);
(async()=>{
 await t("Dealer Manager access save fills blank HQ branches; respects existing branch numbers and line activation",async()=>{
  const w=createWorld(seed());
  const r=await call(load("dealers-api.js",w),{action:"access",dealer_id:"hq-family",manufacturers:[m]},{token:"pres"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.ok,true);
  assert.equal(r.body.branch_sync.filled,2);
  assert.equal(ref(w,"child-blank").account_ref,"HQ-777");
  assert.equal(ref(w,"child-blank").active,false,"do not activate an intentionally disabled line");
  assert.equal(ref(w,"child-new").account_ref,"HQ-777");
  assert.equal(ref(w,"child-special").account_ref,"BRANCH-123");
  assert.equal(ref(w,"unrelated").account_ref,null);
  assert.equal(ref(w,"hq-family").account_ref,"HQ-777");
 });
 await t("Branch-level access saves never fan out to HQ or sibling locations",async()=>{
  const w=createWorld(seed());
  const r=await call(load("dealers-api.js",w),{action:"access",dealer_id:"child-special",manufacturers:[m]},{token:"pres"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.branch_sync.reason,"branch");
  assert.equal(ref(w,"child-new"),undefined);
  assert.equal(ref(w,"child-special").account_ref,"BRANCH-123");
 });
 await t("Dealer 360 manufacturer account number save already propagates to blank branches",async()=>{
  const w=createWorld(seed());
  const r=await call(load("crm-api.js",w),{action:"save_account_ref",dealer_id:"hq-family",manufacturer:"bemis",account_ref:"B-456"},{token:"pres"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(ref(w,"hq-family","bemis").account_ref,"B-456");
  assert.equal(ref(w,"child-blank","bemis").account_ref,"B-456");
  assert.equal(ref(w,"child-blank","bemis").active,false,"inherit account number but preserve branch ordering switch");
  assert.equal(ref(w,"child-new","bemis").account_ref,"B-456");
  assert.equal(ref(w,"child-new","bemis").active,false,"an identifier never opens ordering (Dealer Manager decides)");
  assert.ok(ref(w,"hq-family","bemis").verified_at&&ref(w,"hq-family","bemis").verified_ref==="B-456","HCPS-entered = verified at once");
  assert.equal(ref(w,"hq-family","bemis").active,false,"a line with no ordering row is not opened by typing a number");
  assert.ok(ref(w,"child-blank","bemis").verified_at,"inherited identifier verified with it");
  assert.equal(ref(w,"child-special","bemis").account_ref,"B-456");
 });
 await t("A failed account-number save is an error, never a silent ok; an existing row keeps its ordering switch",async()=>{
  const s=seed(); s.failWrite=(meth,table)=>/dealer_manufacturers/.test(table)?500:0; const w=createWorld(s);
  const r=await call(load("crm-api.js",w),{action:"save_account_ref",dealer_id:"child-blank",manufacturer:m,account_ref:"X-1"},{token:"pres"});
  assert.equal(r.status,502,JSON.stringify(r.body));
  const w2=createWorld(seed());
  const r2=await call(load("crm-api.js",w2),{action:"save_account_ref",dealer_id:"child-blank",manufacturer:m,account_ref:"jamesmed-login"},{token:"pres"});
  assert.equal(r2.status,200,JSON.stringify(r2.body)); assert.equal(ref(w2,"child-blank").active,false,"ordering switch unchanged"); assert.equal(ref(w2,"child-blank").verified_ref,"jamesmed-login","a username is a valid identifier");
  const r3=await call(load("crm-api.js",w2),{action:"save_account_ref",dealer_id:"child-blank",manufacturer:m,account_ref:""},{token:"pres"});
  assert.equal(r3.status,200); assert.equal(ref(w2,"child-blank").verified_at,null,"clearing the number clears verification");
  /* Dealer 360 shows every identifier on file as verified (owner rule 2026-11-06), blank ones not */
  { const s6=seed(); const w6=createWorld(s6); w6.db.dealer_manufacturers.push({dealer_id:"hq-family",manufacturer:"pedifix",account_ref:"OLD-1",active:true},{dealer_id:"hq-family",manufacturer:"dalton",account_ref:"  ",active:true});
    const c6=await call(load("crm-api.js",w6),{action:"contacts",dealer_id:"hq-family"},{token:"pres"}); const ac=(c6.body.accounts||[]);
    assert.equal((ac.find(a=>a.slug==="pedifix")||{}).verified,true,"on file = verified"); assert.equal((ac.find(a=>a.slug==="dalton")||{}).verified,false,"blank is not"); }
  /* the dealer's own row saved, then the branch fill fails: never "nothing was changed" — saved, with a warning */
  let n=0; const s4=seed(); s4.failWrite=(meth,table)=>/dealer_manufacturers/.test(table)&&++n>1?500:0; const w4=createWorld(s4);
  const r4=await call(load("crm-api.js",w4),{action:"save_account_ref",dealer_id:"hq-family",manufacturer:"bemis",account_ref:"B-9"},{token:"pres"});
  assert.equal(r4.status,200,JSON.stringify(r4.body)); assert.equal(r4.body.family_incomplete,true); assert.ok(/branches could not all be updated/.test(r4.body.warning));
  assert.equal(ref(w4,"hq-family","bemis").account_ref,"B-9");
  /* an unreadable family is reported, never treated as "no branches" */
  const s5=seed(); s5.failRead=(t)=>t==="dealers"?500:0; const w5=createWorld(s5);
  const r5=await call(load("crm-api.js",w5),{action:"save_account_ref",dealer_id:"hq-family",manufacturer:"bemis",account_ref:"B-10"},{token:"pres"});
  assert.equal(r5.status,200,JSON.stringify(r5.body)); assert.equal(r5.body.family_incomplete,true);
 });
 await t("Nonmanagement staff cannot edit HQ manufacturer numbers through Dealer Manager",async()=>{
  const w=createWorld(seed());
  const r=await call(load("dealers-api.js",w),{action:"access",dealer_id:"hq-family",manufacturers:[m]},{token:"greg"});
  assert.equal(r.status,403);
  assert.equal(ref(w,"child-new"),undefined);
 });
 await t("Dealer Manager GET includes parent IDs for ID-based family navigation",async()=>{
  const w=createWorld(seed());
  const r=await load("dealers-api.js",w).handler({httpMethod:"GET",headers:{authorization:"Bearer pres"}});
  assert.equal(r.statusCode,200);
  const rows=JSON.parse(r.body).dealers;
  assert.equal(rows.find(d=>d.id==="child-new").parent_id,"hq-family");
  assert.equal(rows.find(d=>d.id==="hq-family").parent_id,null);
 });
 done("HQ family navigation/account inheritance");
})().catch(e=>{console.error(e);process.exitCode=1});
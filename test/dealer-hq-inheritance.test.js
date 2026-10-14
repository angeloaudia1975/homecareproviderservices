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
  assert.equal(ref(w,"child-special","bemis").account_ref,"B-456");
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
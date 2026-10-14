const test=require("node:test");
const assert=require("node:assert/strict");
const S=require("../netlify/functions/_dealer_status");
test("only explicitly inactive accounts are filtered",()=>{
  assert.equal(S.isActive({active:true}),true);
  assert.equal(S.isActive({active:null}),true);
  assert.equal(S.isActive({active:false}),false);
  assert.equal(S.isActive(null),false);
});
test("activeIds excludes inactive dealers and preserves independent locations",async()=>{
  let query="";const ids=await S.activeIds(async path=>{query=path;return [
    {id:"corp",active:false},{id:"mobility-plus-buford",active:true},{id:"another",active:null}
  ];});
  assert.match(query,/select=id,active/);
  assert.deepEqual([...ids].sort(),["another","mobility-plus-buford"]);
});
test("isDealerActive fails closed for missing or inactive dealers",async()=>{
  const rows=async url=>url.includes("corp")?[{id:"corp",active:false}]:[{id:"branch",active:true}];
  assert.equal(await S.isDealerActive(rows,"corp"),false);
  assert.equal(await S.isDealerActive(rows,"branch"),true);
  assert.equal(await S.isDealerActive(rows,""),false);
  assert.equal(await S.isDealerActive(async()=>[],"unknown"),false);
});

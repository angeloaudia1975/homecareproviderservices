const test=require("node:test");
const assert=require("node:assert/strict");
const F=require("../src/admin/dealer-family.js");
const dealers=[
 {id:"hq",name:"King Drug HQ",hcps_account:"190023",active:true,parent_id:null},
 {id:"east",name:"King Drug East",hcps_account:"190024",city:"London",state:"KY",active:true,parent_id:"hq"},
 {id:"west",name:"King Drug West",hcps_account:"190025",active:false,parent_id:"hq"},
 {id:"private",name:"Private branch",parent_id:"another-hq"},
 {id:"same-name",name:"King Drug East",hcps_account:"OTHER",active:true,parent_id:"another-hq"},
];
test("HQ lists branch IDs and separate location account numbers",()=>{
 const html=F.render(dealers[0],dealers);
 assert.match(html,/href="\/admin\/dealer\.html\?id=east"/);
 assert.match(html,/href="\/admin\/dealer\.html\?id=west"/);
 assert.match(html,/HCPS # 190024/);assert.match(html,/HCPS # 190025/);
 assert.doesNotMatch(html,/Private branch|OTHER/);
 assert.match(html,/Inactive/);
});
test("Branch links to HQ and sibling but not itself",()=>{
 const html=F.render(dealers[1],dealers);
 assert.match(html,/id=hq/);assert.match(html,/id=west/);
 assert.doesNotMatch(html,/href="\/admin\/dealer\.html\?id=east"/);
 assert.match(html,/aria-current="page"/);
});
test("Never reveals branches outside the staff-scoped list",()=>{
 const html=F.render(dealers[0],[dealers[0],dealers[1]]);
 assert.match(html,/id=east/);assert.doesNotMatch(html,/id=west|Private branch/);
});
test("Standalone dealer has no redundant family navigation",()=>assert.equal(F.render({id:"alone",parent_id:null},dealers),""));
test("Escapes hostile names, links by immutable ID",()=>{
 const h={id:"x",name:"HQ",parent_id:null};
 const child={id:"y",name:"<img src=x onerror=alert(1)>",parent_id:"x"};
 const html=F.render(h,[h,child]);
 assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
});
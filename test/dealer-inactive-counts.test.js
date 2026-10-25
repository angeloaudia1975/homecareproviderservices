// Summary count regression: inactive dealer histories are retained but do not count as active work.
const assert=require("node:assert/strict");
const {createWorld,load,call,standardSeed,t,done}=require("./phase0-mock");
const seed=()=>{
  const S=standardSeed({
    dealer_tasks:[
      {id:"inactive-manual",dealer_id:"d-ang",title:"Old manual task",status:"open",source:"manual",assigned_rep:"Angelo Audia"},
      {id:"active-auto",dealer_id:"d-greg",title:"New task",status:"open",source:"auto",assigned_rep:"Greg Campbell"}
    ],
    dealer_engagement:[
      {dealer_id:"d-ang",status:"dormant"},
      {dealer_id:"d-greg",status:"healthy"}
    ],
    app_settings:[{key:"automation_config",value:{engine_enabled:false,email_enabled:false}}],
  });
  S.tables.dealers.find(d=>d.id==="d-ang").active=false;
  S.tables.dealers.find(d=>d.id==="d-greg").active=true;
  return S;
};
(async()=>{
  await t("management badge agrees with visible open tasks",async()=>{
    const w=createWorld(seed());
    const api=load("crm-api.js",w);
    const badge=await call(api,{action:"task_count"},{token:"pres"});
    const list=await call(api,{action:"my_tasks"},{token:"pres"});
    assert.equal(badge.status,200,JSON.stringify(badge.body));
    assert.equal(badge.body.count,1);
    assert.equal(list.body.tasks.length,1);
    assert.equal(list.body.tasks[0].id,"active-auto");
    assert.equal(w.db.dealer_tasks.length,2,"retained tasks, no mutation");
  });
  await t("rep badge agrees with active open-task list",async()=>{
    const w=createWorld(seed());
    const api=load("crm-api.js",w);
    const badge=await call(api,{action:"task_count"},{token:"greg"});
    const list=await call(api,{action:"my_tasks"},{token:"greg"});
    assert.equal(badge.status,200,JSON.stringify(badge.body));
    assert.equal(badge.body.count,list.body.tasks.length);
    assert.equal(badge.body.count,1);
  });
  await t("automation counts omit inactive cached engagement rows",async()=>{
    const w=createWorld(seed());
    const api=load("crm-api.js",w);
    const r=await call(api,{action:"automation_status"},{token:"pres"});
    assert.equal(r.status,200,JSON.stringify(r.body));
    assert.equal(r.body.engagement.dormant||0,0);
    assert.equal(r.body.engagement.healthy,1);
    assert.equal(w.db.dealer_engagement.length,2,"cached history not deleted");
  });
  done("Dealer inactive summary counts");
})().catch(e=>{console.error(e);process.exitCode=1});

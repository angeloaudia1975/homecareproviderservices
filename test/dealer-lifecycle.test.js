// In-memory read/write acceptance test. Never reaches HCPS production.
const assert=require("node:assert/strict");
const {createWorld,load,call,standardSeed,t,done}=require("./phase0-mock");
const CORP="00000000-0000-4000-8000-0000000000c1";
const BRANCH="00000000-0000-4000-8000-0000000000b1";
const seed=()=>standardSeed({
  dealers:[{id:CORP,business_name:"Mobility Plus LLC",active:true,rep_name:"Angelo Audia"},
           {id:BRANCH,business_name:"Mobility Plus Buford",active:true,rep_name:"Greg Campbell"}],
  dealer_tasks:[{id:"auto-1",dealer_id:CORP,status:"open",source:"auto",reason:"dormant",title:"Dormant account"},
                {id:"intent-1",dealer_id:CORP,status:"open",source:"intent",reason:"intent",title:"Call dealer"},
                {id:"manual-1",dealer_id:CORP,status:"open",source:"manual",title:"Old manual history"}],
  email_queue:[{id:"mail-1",dealer_id:CORP,status:"queued",contact_email:"test@example.org",template:"dormant"}],
  monthly_sales:[{id:"sale-1",dealer_id:CORP,manufacturer:"golden-technologies",period:"2026-09-01",amount:500}],
});
(async()=>{
  await t("management deactivates one account, preserves history and franchise siblings",async()=>{
    const w=createWorld(seed());
    const r=await call(load("dealers-api.js",w),{action:"set_active",dealer_id:CORP,active:false,reason:"Invalid corporate account"},{token:"pres"});
    assert.equal(r.status,200,JSON.stringify(r.body));
    assert.equal(r.body.active,false);assert.equal(r.body.tasks_dismissed,2);assert.equal(r.body.emails_canceled,1);
    assert.equal(w.db.dealers.find(d=>d.id===CORP).active,false);
    assert.equal(w.db.dealers.find(d=>d.id===BRANCH).active,true);
    assert.equal(w.db.monthly_sales.length,1);
    assert.equal(w.db.dealer_tasks.find(t=>t.id==="manual-1").status,"open");
    assert.ok(w.db.dealer_activity.some(a=>a.subject==="Dealer account deactivated"&&/Invalid corporate account/.test(a.detail)));
    const q=await call(load("crm-api.js",w),{action:"my_tasks",status:"open"},{token:"pres"});
    assert.equal(q.status,200,JSON.stringify(q.body));
    assert.equal(q.body.tasks.some(t=>t.dealer_id===CORP),false);
    const history=await call(load("crm-api.js",w),{action:"my_tasks",status:"dismissed"},{token:"pres"});
    assert.equal(history.body.tasks.filter(t=>t.dealer_id===CORP).length,2);
  });
  await t("only management may change status and reason is required",async()=>{
    const w=createWorld(seed());
    const noReason=await call(load("dealers-api.js",w),{action:"set_active",dealer_id:CORP,active:false},{token:"pres"});
    assert.equal(noReason.status,400);
    const rep=await call(load("dealers-api.js",w),{action:"set_active",dealer_id:CORP,active:false,reason:"x"},{token:"greg"});
    assert.equal(rep.status,403);
    assert.equal(w.db.dealers.find(d=>d.id===CORP).active,true);
  });
  await t("reactivation restores queue eligibility but does not revive dismissed auto tasks",async()=>{
    const w=createWorld(seed());
    const api=load("dealers-api.js",w);
    const a=await call(api,{action:"set_active",dealer_id:CORP,active:false,reason:"closed"},{token:"pres"});
    assert.equal(a.status,200);
    const b=await call(api,{action:"set_active",dealer_id:CORP,active:true,reason:"Reopened"},{token:"pres"});
    assert.equal(b.status,200);
    assert.equal(w.db.dealers.find(d=>d.id===CORP).active,true);
    assert.equal(w.db.dealer_tasks.filter(t=>t.dealer_id===CORP&&t.status==="open"&&t.source==="auto").length,0);
    const q=await call(load("crm-api.js",w),{action:"my_tasks",status:"open"},{token:"pres"});
    assert.equal(q.body.tasks.some(t=>t.id==="manual-1"),true);
  });
  done("Dealer lifecycle acceptance");
})().catch(e=>{console.error(e);process.exitCode=1;});

const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const src=fs.readFileSync(path.join(DIR,'catalog-api.js'),'utf8').replace(/\r\n/g,'\n');
const M=[
 ['record not moved', 'if(migrated && oldRec){\n            await step("master record"', 'if(false){\n            await step("master record"'],
 ['old record left active', 'status:"not_listed",superseded_by:newCode,', 'superseded_by:newCode,'],
 ['contract prices left behind', 'if(onOld.size) await step("contract prices"', 'if(false) await step("contract prices"'],
 ['contract conflict ignored', 'if(both.length) return json(409,{error:"contract_conflict"', 'if(false) return json(409,{error:"contract_conflict"'],
 ['record collision ignored', '.concat((recRows||[]).map(x=>({code:String(x.code),name:"",price:x.base_price,kind:"record"})))', ''],
 ['browser price trusted', 'base_price:rc?rc.base_price:num(p.base_price)', 'base_price:num(p.base_price)'],
 ['failures swallowed again', 'catch(err){ throw Object.assign(new Error(String((err&&err.message)||err)),{step:name}); } };', 'catch(err){ } };'],
 ['lenient catalog read', '            catalogFile(mfr),\n            sb("GET",`custom_products?manufacturer=eq.${eN(mfr)}&select=code,name,base_price,active`),\n            lineMigrated(mfr),', '            fetchJson(`${ORDERING_BASE}/data/${mfr}.json`).catch(()=>[]),\n            sb("GET",`custom_products?manufacturer=eq.${eN(mfr)}&select=code,name,base_price,active`),\n            lineMigrated(mfr),'],
 ['layers before record', '          /* 1. The master record first. */\n          const oldRec=(recRows||[]).find(r=>r.code_norm===nOld)||null;', '          const oldRec=(recRows||[]).find(r=>r.code_norm===nOld)||null;\n          await sb("POST","custom_products?on_conflict=manufacturer,code",{manufacturer:mfr,code:newCode,name:"early",active:true},{Prefer:"resolution=merge-duplicates,return=minimal"});'],
];
let surv=0;
for(const [n,f,t] of M){ const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'ren-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,'catalog-api.js'),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'rename.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

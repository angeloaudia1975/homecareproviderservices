const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const src=fs.readFileSync(path.join(DIR,'catalog-api.js'),'utf8').replace(/\r\n/g,'\n');
const M=[
 ['missing codes ignored','if(missing.length||inactive.length) return json(409,{error:"not_stamped"','if(false) return json(409,{error:"not_stamped"'],
 ['retired records stamped','else if(r.status!==LIVE_STATUS) inactive.push(c);',''],
 ['read failure swallowed','catch(err){ return json(503,{error:"layer_unreadable",message:String((err&&err.message)||err)}); }\n        const byNorm={};','catch(err){ rows=[]; }\n        const byNorm={};'],
 ['write failure swallowed','            return json(502,{error:"provenance_incomplete",stamped,failed:r.code,','            continue; return json(502,{error:"provenance_incomplete",stamped,failed:r.code,'],
 ['dry run writes',"if(b.dry_run===true) return json(200,{ok:true,dry_run:true,would_stamp","if(false) return json(200,{ok:true,dry_run:true,would_stamp"],
 ['price touched too','{source_file:file.slice(0,160), effective_date:eff||null, updated_at:now','{source_file:file.slice(0,160), effective_date:eff||null, base_price:0, updated_at:now'],
 ['date unchecked',"if(eff && !/^\\d{4}-\\d{2}-\\d{2}$/.test(eff)) return json(400,{error:\"effective_date must be YYYY-MM-DD\"});\n        const codes=","if(false) return json(400,{error:\"effective_date must be YYYY-MM-DD\"});\n        const codes="],
];
let surv=0;
for(const [n,f,t] of M){ const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'prov-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,'catalog-api.js'),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'provenance.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

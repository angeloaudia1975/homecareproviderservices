const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const SRC=path.join(__dirname,'..','src','admin','catalog.html'), src=fs.readFileSync(SRC,'utf8');
const M=[
 ['no snapshot taken', "  PDRAFT._orig=JSON.parse(JSON.stringify(PDRAFT));\n", ""],
 ['patch sends everything again', "    const patch=Object.assign({},changes);\n", "    const patch={name:PDRAFT.name,category:PDRAFT.category,base_price:Number(PDRAFT.base_price),tiers};\n"],
 ['name always counted as changed', "    if(s(draft[k])!==s(o[k])) out[k]=", "    if(k===\"name\"||s(draft[k])!==s(o[k])) out[k]="],
 ['prices compared as text', "  [\"base_price\",\"msrp\",\"map\"].forEach(k=>{ if(n(draft[k])!==n(o[k])) out[k]=n(draft[k]); });", "  [\"base_price\",\"msrp\",\"map\"].forEach(k=>{ if(true) out[k]=n(draft[k]); });"],
 ['ladder change ignored', "  if(lad(tiers)!==lad(o.tiers)) out.tiers=tiers;", ""],
 ['changed list not sent for added', "      product:{...prodOut,tiers}, changed:isEdit?Object.keys(changes):null})});", "      product:{...prodOut,tiers}, changed:null})});"],
 ['no-change guard removed', "  if(isEdit && !Object.keys(changes).length){ PDRAFT=null; render(); toast(\"No changes to save\"); return; }\n", ""],
];
let surv=0;
for(const [n,f,t] of M){ const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  fs.writeFileSync(path.join(os.tmpdir(),'chg-catalog.html'),src.replace(f,t));
  let k=false; try{execFileSync('node',[path.join(__dirname,'changedonly.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{UI:path.join(os.tmpdir(),'chg-catalog.html')})});}catch(e){k=true;}
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k)surv++; }
// server-side: changed list ignored
const asrc=fs.readFileSync(path.join(__dirname,'..','netlify','functions','catalog-api.js'),'utf8'); const MD=fs.mkdtempSync(path.join(os.tmpdir(),'chg-')); fs.mkdirSync(MD,{recursive:true}); fs.copyFileSync(path.join(__dirname,'..','netlify','functions','_catalog-join.js'),MD+'/_catalog-join.js');
const f="          if(Array.isArray(b.changed)){\n            const allow"; if(asrc.split(f).length!==2){console.log('BAD ANCHOR server');surv++;}
fs.writeFileSync(MD+'/catalog-api.js',asrc.replace(f,"          if(false){\n            const allow"));
{ let k=false; try{execFileSync('node',[path.join(__dirname,'canonical.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})});}catch(e){k=true;}
  console.log((k?'killed  ':'SURVIVED')+' server ignores the changed list'); if(!k)surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

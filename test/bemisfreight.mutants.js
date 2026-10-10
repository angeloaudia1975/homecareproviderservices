const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const ex=require('./extract-engine.js');
const files={shop:path.join(SHOPD,'public','index.html'),mfrs:path.join(SHOPD,'public','data','manufacturers.json'),submit:path.join(SHOPD,'netlify','functions','submit-order.js'),orders:path.join(DIR,'orders-api.js'),pricing:path.join(DIR,'_pricing.js')};
const M=[
 ['shop','free row drops the manufacturer words','rows.push(Object.assign({label:g.label,status:"free"},words));','rows.push({label:g.label,status:"free"});'],
 ['shop','cart says FREE freight','${esc(r.freeLabel||"FREE freight")}','FREE freight'],
 ['shop','cart flat fee says freight','${esc(r.flatLabel||"freight")}','freight'],
 ['shop','$500.00 not yet prepaid','if(g.freeAt!=null&&sub>=g.freeAt){','if(g.freeAt!=null&&sub>g.freeAt){'],
 ['mfrs','Bemis words missing','"freeLabel": "Prepaid freight",','"freeLabelX": "Prepaid freight",'],
 ['mfrs','Strongback wording changed too','"flatFee": 15','"flatFee": 15, "flatLabel": "shipping & handling"'],
 ['orders','dealer email says Free','const f=L.find(r=>r.status==="free"&&r.freeLabel); return f?f.freeLabel:"Free";','return "Free";'],
 ['orders','dealer email drops shipping & handling','return money(fee)+(f?" "+f.flatLabel:"");','return money(fee);'],
 ['submit','HCPS terms say FREE freight','r.status === "free" ? (r.freeLabel || "FREE freight")','r.status === "free" ? "FREE freight"'],
 ['submit','HCPS summary says FREE','if (lines.length) return free ? free.freeLabel : "FREE";','if (lines.length) return "FREE";'],
];
const engineFor=src=>{ const old=fs.readFileSync(path.join(DIR,'_shop_engine.js'),'utf8'); const i=old.indexOf('module.exports = { SOURCE: ')+'module.exports = { SOURCE: '.length;
  let j=i+1,e=false; for(;j<old.length;j++){const c=old[j]; if(e){e=false;continue;} if(c==='\\'){e=true;continue;} if(c==='"')break;}
  return old.slice(0,i)+JSON.stringify(ex.extract(src))+old.slice(j+1); };
let surv=0;
for(const [w,n,f,t] of M){ const src=fs.readFileSync(files[w],'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'bfr-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  const env=Object.assign({},process.env,{CAT_ROOT:MD}); const mut=src.replace(f,t);
  if(w==='shop'){ const h=path.join(MD,'shop.html'); fs.writeFileSync(h,mut); env.SHOP_HTML=h; fs.writeFileSync(path.join(MD,'_shop_engine.js'),engineFor(mut)); }
  else if(w==='mfrs'){ const h=path.join(MD,'m.json'); fs.writeFileSync(h,mut); env.MFRS_JSON=h; }
  else if(w==='submit'){ const h=path.join(MD,'submit-order.js'); fs.writeFileSync(h,mut); env.SUBMIT_JS=h; }
  else fs.writeFileSync(path.join(MD,w==='orders'?'orders-api.js':'_pricing.js'),mut);
  let k=false; try{ execFileSync('node',[path.join(__dirname,'bemisfreight.test.js')],{stdio:'pipe',env}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

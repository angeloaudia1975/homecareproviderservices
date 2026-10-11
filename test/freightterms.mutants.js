/* Mutants for Manufacturer Center Phase 5 (freight terms as data): each edit must make
   test/freightterms.test.js fail. Verifier-side freight mutants live in test/mc.mutants.js. */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const ex=require('./extract-engine.js');
const files={shop:path.join(SHOPD,'public','index.html'),pricing:path.join(DIR,'_pricing.js')};
const M=[
 ['shop','record terms ignored',"  const f=JSON.parse(JSON.stringify(terms)); delete f.trace;\n  return {freight:f, source:'record', invalid:false};","  return {freight:file, source:file?'file':'none', invalid:false};"],
 ['shop','invalid record used anyway',"  if(!validFreightTerms(terms)) return","  if(false) return"],
 ['shop','record mixed into the file entry',"const f=JSON.parse(JSON.stringify(terms));","const f=Object.assign(JSON.parse(JSON.stringify(file||{})),JSON.parse(JSON.stringify(terms)));"],
 ['shop','trace reaches the freight rule'," delete f.trace;",""],
 ['shop','empty rule accepted',"  return t.groups.length>0 || t.elseActual===true;","  return true;"],
 ['shop','thresholds and fees not checked',"    if(!num(g.freeAt)||!num(g.flatUnder)||!num(g.flatFee)||!num(g.flatBelow)) return false;\n",""],
 ['shop','threshold as text accepted',"const num=v=>v==null||(typeof v==='number'&&isFinite(v)&&v>=0);","const num=v=>v==null||(isFinite(v)&&v>=0);"],
 ['shop','negative fee accepted',"const num=v=>v==null||(typeof v==='number'&&isFinite(v)&&v>=0);","const num=v=>v==null||(typeof v==='number'&&isFinite(v));"],
 ['shop','group without a selector accepted',"    if(!(list(g.categories)||list(g.brandKeywords))) return false;\n",""],
 ['shop','group without a label accepted',"if(!isObj(g)||typeof g.label!=='string'||g.label.trim()==='') return false;","if(!isObj(g)) return false;"],
 ['shop','unknown mode accepted',"return t.mode==='per_item' && num(t.threshold);","return num(t.threshold);"],
 ['shop','elseActual type unchecked',"  if(t.elseActual!=null&&typeof t.elseActual!=='boolean') return false;\n",""],
 ['shop','storefront does not read freight_terms',",category_map,freight_terms`",",category_map`"],
 ['shop','storefront ignores the record',"const ft=freightTermsFor(m.freight, fm[m.slug]); m.freight=ft.freight;","const ft=freightTermsFor(m.freight, null); m.freight=ft.freight;"],
 ['shop','invalid record not reported',"      if(ft.invalid) try{ console.warn(","      if(false) try{ console.warn("],
 ['pricing','server does not read freight_terms',",record_resync_error,freight_terms`),",",record_resync_error`),"],
 ['pricing','server ignores the record',"    mfrEntry.freight = ft.freight;","    ;"],
];
const engineFor=shopSrc=>{ const old=fs.readFileSync(path.join(DIR,'_shop_engine.js'),'utf8'); const i=old.indexOf('module.exports = { SOURCE: ')+'module.exports = { SOURCE: '.length;
  let j=i+1,esc=false; for(;j<old.length;j++){const c=old[j]; if(esc){esc=false;continue;} if(c==='\\'){esc=true;continue;} if(c==='"')break;}
  return old.slice(0,i)+JSON.stringify(ex.extract(shopSrc))+old.slice(j+1); };
let surv=0;
for(const [w,n,f,t] of M){ const src=fs.readFileSync(files[w],'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'fterms-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  const env=Object.assign({},process.env,{CAT_ROOT:MD}); const mut=src.replace(f,t);
  if(w==='shop'){ const h=path.join(MD,'shop.html'); fs.writeFileSync(h,mut); env.SHOP_HTML=h; fs.writeFileSync(path.join(MD,'_shop_engine.js'),engineFor(mut)); }
  else fs.writeFileSync(path.join(MD,'_pricing.js'),mut);
  let k=false; try{ execFileSync('node',[path.join(__dirname,'freightterms.test.js')],{stdio:'pipe',env}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

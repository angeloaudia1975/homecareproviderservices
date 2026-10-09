const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const ex=require('./extract-engine.js');
const files={shop:path.join(SHOPD,'public','index.html'),submit:path.join(SHOPD,'netlify','functions','submit-order.js'),orders:path.join(DIR,'orders-api.js'),pricing:path.join(DIR,'_pricing.js')};
const M=[
 ['shop','record unit not copied','    if(authoritative){ if(m.uom != null && m.uom !== "") p.uom = m.uom; if(m.case_qty != null) p.case_qty = Number(m.case_qty); }','    '],
 ['shop','MAP not labelled each','MAP ${money(mapv)}${packOf(p)?" each":""}','MAP ${money(mapv)}'],
 ['shop','pack note missing','function packNote(p){ const k=packOf(p); return k ? `Dealer order unit = 1 ${k.label} (${k.n} each)` : ""; }','function packNote(p){ return ""; }'],
 ['shop','single units treated as packs','  if(!(n>1)) return null;','  if(!(n>0)) return null;'],
 ['submit','HCPS email drops the pack','  if (n > 1) return `${u || n + "-pack"} (${n} each)`;','  if (false) return "";'],
 ['orders','dealer email drops the pack','  if(n>1) return `${u||n+"-pack"} (${n} each)`;','  if(false) return "";'],
 ['pricing','server forgets the unit','    if (Number(l.p.case_qty) > 1) unitBits.case_qty = Number(l.p.case_qty);','    '],
];
const engineFor=shopSrc=>{ const old=fs.readFileSync(path.join(DIR,'_shop_engine.js'),'utf8'); const i=old.indexOf('module.exports = { SOURCE: ')+'module.exports = { SOURCE: '.length;
  let j=i+1,esc=false; for(;j<old.length;j++){const c=old[j]; if(esc){esc=false;continue;} if(c==='\\'){esc=true;continue;} if(c==='"')break;}
  return old.slice(0,i)+JSON.stringify(ex.extract(shopSrc))+old.slice(j+1); };
let surv=0;
for(const [w,n,f,t] of M){ const src=fs.readFileSync(files[w],'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'pack-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  const env=Object.assign({},process.env,{CAT_ROOT:MD});
  const mut=src.replace(f,t);
  if(w==='shop'){ const h=path.join(MD,'shop.html'); fs.writeFileSync(h,mut); env.SHOP_HTML=h; fs.writeFileSync(path.join(MD,'_shop_engine.js'),engineFor(mut)); }
  else if(w==='submit'){ const s=path.join(MD,'submit-order.js'); fs.writeFileSync(s,mut); env.SUBMIT_JS=s; }
  else fs.writeFileSync(path.join(MD,w==='orders'?'orders-api.js':'_pricing.js'),mut);
  let k=false; try{ execFileSync('node',[path.join(__dirname,'packunit.test.js')],{stdio:'pipe',env}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

/* Mutants for the three-state MSRP rule. Shop-text mutants are applied to the shop page and the
   engine is re-extracted from the mutated page into a temp functions dir. */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const SHOP=path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html');
const ex=require('./extract-engine.js');
const shop=fs.readFileSync(SHOP,'utf8'); const cat=fs.readFileSync(path.join(DIR,'catalog-api.js'),'utf8'); const pri=fs.readFileSync(path.join(DIR,'_pricing.js'),'utf8');
const M=[
 ['shop','fillMsrp fabricates anyway',"  if(p.msrp_auto===false) return p;     // MSRP deliberately absent","  // removed"],
 ['shop','flag ignored on layers',"  if(!layer || layer.msrp_auto!==false) return row;","  if(true) return row;"],
 ['shop','flag kept but MSRP not cleared','  if(layer.msrp==null || layer.msrp==="") row.msrp=null;','  '],
 ['shop','override flag not read on added rows',"      noMsrpRule(row, pa);\n","\n"],
 ['shop','record "none" loses',"      if(authoritative){ p.msrp = null; p.msrp_auto = false; delete p._msrp_suggested; }","      if(false){}"],
 ['cat','derived MSRP not checked','      else if(f==="msrp" && a==null && b==null && r.msrp_auto===false && l.msrp_auto!==false','      else if(false && l.msrp_auto!==false'],
 ['pri','feed drops false','    else if (r.msrp_auto === false) o.msrp_auto = false;','    '],
 ['cat','parity blind to fabricated MSRP','      else if(f==="msrp" && a!=null && b==null && r.msrp_auto===false) drift.push','      else if(false) drift.push'],
 ['cat','parity ignores the flag on added rows','    noMsrp(row,pa);\n    row.hidden=cu.active===false','    row.hidden=cu.active===false'],
];
const mkEngine=(shopSrc)=>{ const old=fs.readFileSync(path.join(DIR,'_shop_engine.js'),'utf8'); const i=old.indexOf('module.exports = { SOURCE: ')+'module.exports = { SOURCE: '.length;
  const dec=JSON.parse; let j=i+1, esc=false; for(;j<old.length;j++){ const ch=old[j]; if(esc){esc=false;continue;} if(ch==='\\'){esc=true;continue;} if(ch==='"') break; }
  return old.slice(0,i)+JSON.stringify(ex.extract(shopSrc))+old.slice(j+1); };
let surv=0;
for(const [w,n,f,t] of M){ const src=w==='shop'?shop:(w==='cat'?cat:pri); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'msrp-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  if(w==='shop') fs.writeFileSync(path.join(MD,'_shop_engine.js'),mkEngine(shop.replace(f,t)));
  else fs.writeFileSync(path.join(MD,w==='cat'?'catalog-api.js':'_pricing.js'),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'msrpauto.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

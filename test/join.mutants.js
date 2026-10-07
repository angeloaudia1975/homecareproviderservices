const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions'); const src=fs.readFileSync(path.join(DIR,'_catalog-join.js'),'utf8');
const M=[['draft pages file again',"  const livePage = page && isLive(page) ? page : null;","  const livePage = page;"],
 ['map without a page',"  if (livePage && map && sub && map[sub])","  if (map && sub && map[sub])"],
 ['group first-wins',"if (g) byGroup[g] = k; });","if (g && !byGroup[g]) byGroup[g] = k; });"],
 ['sku photo ignored',"    const image = (sxEntryImg(idx, code)) || pagePrimary","    const image = pagePrimary"],
 ['no-primary ignores page image',"    if (gi < 0) { gi = gl.findIndex(g => str(g.url) === str(pg && pg.image)); if (gi < 0) gi = 0; }","    if (gi < 0) { gi = 0; }"]];
let surv=0; for(const [n,f,t] of M){ const c=src.split(f).length-1; if(c!==1){console.log('BAD ANCHOR '+n);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'join-')); fs.writeFileSync(path.join(MD,'_catalog-join.js'),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,process.env.JOIN_TEST||'join.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const read=f=>fs.readFileSync(path.join(DIR,f),'utf8').replace(/\r\n/g,'\n');
const M=[
 ['authoritative line staged','        if(meta&&meta[0]&&meta[0].record_authoritative===true)\n          return json(409','        if(false)\n          return json(409'],
 ['dry run writes',"        if(b.dry_run===true) return json(200,{ok:true,dry_run:true,plan,activation_preview:preview,would_clear_refused:refused});","        "],
 ['writes a layer too','            staged.push(p.code);','            await sb("POST","product_overrides?on_conflict=manufacturer,code",{manufacturer:mfr,code:p.code,patch:{base_price:p.after.base_price}},{Prefer:"resolution=merge-duplicates,return=minimal"}); staged.push(p.code);'],
 ['always inserts','            if(p.action==="update"){','            if(false){'],
 ['write failure swallowed','            return json(502,{error:"stage_incomplete",staged,failed:p.code,','            continue; return json(502,{error:"stage_incomplete",staged,failed:p.code,'],
 ['bad rows accepted','        if(sp.bad.length||sp.duplicates.length) return json(400','        if(false) return json(400'],
 ['added ladder hidden from preview','    else if(strictTiers && !la && lb) drift.push','    else if(false) drift.push'],
 ['provenance dropped','        const prov=r=>{ const o={source_file:file.slice(0,160)};','        const prov=r=>{ const o={};'],
 ['msrp_auto forced true','      const row = { code, status: vals.status || LIVE_STATUS, msrp_auto: vals.msrp_auto === true };','      const row = { code, status: vals.status || LIVE_STATUS, msrp_auto: true };','_mc.js'],
];
let surv=0;
for(const [n,f,t,file] of M){ const fn=file||'catalog-api.js', src=read(fn); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'stg-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,fn),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,'stage.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

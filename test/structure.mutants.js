const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=process.env.CAT_ROOT||path.join(__dirname,'..','netlify','functions');
const M=[
 ['catalog-api.js','picker keyed by catalog group again', "  const pickerKey=p=>PICK.groupKeyOf(p);", "  const pickerKey=p=>(p.group||p.code);"],
 ['catalog-api.js','enrichment SKU name ignored', "if(nm && !p._nameFromOverride) p.name=nm;", ""],
 ['catalog-api.js','authored size ignored', "if(opt) p._skuOption=opt;\n", "\n"],
 ['catalog-api.js','hidden SKUs kept', "if(pa.active===false) q._hidden=true; return q; }).filter(p=>!p._hidden);", "return q; });"],
 ['catalog-api.js','draft pages own SKUs', "  const live=(pages||[]).filter(pg=>LIVEST.indexOf(pg.status)>=0 && pg.disabled!==true);", "  const live=(pages||[]).filter(pg=>pg.disabled!==true);"],
 ['catalog-api.js','disabled pages own SKUs', "  const live=(pages||[]).filter(pg=>LIVEST.indexOf(pg.status)>=0 && pg.disabled!==true);", "  const live=(pages||[]).filter(pg=>LIVEST.indexOf(pg.status)>=0);"],
 ['catalog-api.js','discontinued pages left out of the picker', '  const LIVEST=["published","active","discontinued"];', '  const LIVEST=["published","active"];'],
 ['catalog-api.js','collision check off', "            if(hit && hit.code!==v.code){", "            if(false){"],
 ['catalog-api.js','duplicate check off', "          if(dup.length) add(\"sku_option_duplicated\",", "          if(false) add(\"sku_option_duplicated\","],
 ['catalog-api.js','gaps counted as faults', "STRUCTURE_GAP_KINDS[f.kind]?\"gap\":\"fault\"", "\"fault\""],
 ['catalog-api.js','contradictions counted as faults', "accessory_in_sku_list:1, options_contradict_skus:1 };", "accessory_in_sku_list:1 };"],
 ['catalog-api.js','read failure swallowed', "        catch(err){ return json(503,{error:\"layer_unreadable\", message:\"The structure audit could not read a layer: \"", "        catch(err){ return json(200,{ok:true,findings:[],findings_total:0, message:\"\""],
 ['_shop_picker.js','copied picker drifts', "function groupKeyOf(p){ return p._pageKey || p.group || p.code; }", "function groupKeyOf(p){ return p.group || p._pageKey || p.code; }"],
];
let surv=0;
for(const [file,n,f,t] of M){
  const src=fs.readFileSync(path.join(DIR,file),'utf8'); const c=src.split(f).length-1;
  if(c!==1){ console.log(`BAD ANCHOR(${c}) ${n}`); surv++; continue; }
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'st2-'));
  for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  fs.writeFileSync(path.join(MD,file),src.replace(f,t));
  let k=false; try{ execFileSync('node',[path.join(__dirname,process.env.ST2_TEST||'structure.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{CAT_ROOT:MD})}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++;
}
// the shop going back to catalog-group pickers
{ const SHOP=process.env.SHOP||path.join(__dirname,'..','..','homecareproviderservicesordering','public','index.html'); const s=fs.readFileSync(SHOP,'utf8');
  const f="    const gk=groupKeyOf(p);\n    const variants=sortVariants((state.products||[]).filter(x=>groupKeyOf(x)===gk));";
  if(s.split(f).length!==2){ console.log('BAD ANCHOR shop'); surv++; }
  else { const tmp=path.join(os.tmpdir(),'st2-shop.html'); fs.writeFileSync(tmp,s.replace(f,"    const gk=(p.group||p.code);\n    const variants=sortVariants((state.products||[]).filter(x=>((x.group||x.code)===gk)));"));
    let k=false; try{ execFileSync('node',[path.join(__dirname,process.env.ST2_TEST||'structure.test.js')],{stdio:'pipe',env:Object.assign({},process.env,{SHOP:tmp})}); }catch(e){ k=true; }
    console.log((k?'killed  ':'SURVIVED')+' shop picker back to catalog group'); if(!k) surv++; } }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

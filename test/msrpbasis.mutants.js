/* Mutants for Manufacturer Center Phase 4 (MSRP / MAP basis on the storefront): each edit must make
   test/msrpbasis.test.js fail. Verifier-side basis mutants live in test/mc.mutants.js. */
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const files={shop:path.join(SHOPD,'public','index.html'),feed:path.join(SHOPD,'netlify','functions','catalog-feed.js'),pricing:path.join(DIR,'_pricing.js')};
const M=[
 ['shop','record MSRP basis ignored',"function msrpIsEach(p){ if(!packOf(p)) return false; const b=p&&p.msrp_basis; return (b==='each'||b==='order_unit') ? b==='each' : p.msrp_each===true; }","function msrpIsEach(p){ if(!packOf(p)) return false; return p.msrp_each===true; }"],
 ['shop','record MAP basis ignored',"function mapIsEach(p){ if(!packOf(p)) return false; const b=p&&p.map_basis; return (b==='each'||b==='order_unit') ? b==='each' : true; }","function mapIsEach(p){ if(!packOf(p)) return false; return true; }"],
 ['shop','MSRP basis labels a single item',"function msrpIsEach(p){ if(!packOf(p)) return false;","function msrpIsEach(p){"],
 ['shop','MAP basis labels a single item',"function mapIsEach(p){ if(!packOf(p)) return false;","function mapIsEach(p){"],
 ['shop','unknown MSRP basis word trusted',"const b=p&&p.msrp_basis; return (b==='each'||b==='order_unit') ? b==='each'","const b=p&&p.msrp_basis; return b ? b==='each'"],
 ['shop','MSRP no-basis default flipped',"? b==='each' : p.msrp_each===true; }","? b==='each' : false; }"],
 ['shop','MAP no-basis default flipped',"const b=p&&p.map_basis; return (b==='each'||b==='order_unit') ? b==='each' : true; }","const b=p&&p.map_basis; return (b==='each'||b==='order_unit') ? b==='each' : false; }"],
 ['shop','card MAP ignores the basis','MAP ${money(mapv)}${mapIsEach(p)?" each":""}','MAP ${money(mapv)}${packOf(p)?" each":""}'],
 ['shop','card MSRP ignores the basis','const msrpPack=packOf(p), msrpEach=msrpIsEach(p);','const msrpPack=packOf(p), msrpEach=!!(msrpPack && p.msrp_each===true);'],
 ['shop','basis copied on a line that is not authoritative','    if(authoritative){ if(m.msrp_basis === "each"','    if(true){ if(m.msrp_basis === "each"'],
 ['shop','record basis never copied','p.msrp_basis = m.msrp_basis;',';'],
 ['shop','any record basis word copied','if(m.map_basis === "each" || m.map_basis === "order_unit") p.map_basis = m.map_basis;','if(m.map_basis) p.map_basis = m.map_basis;'],
 ['feed','feed does not read the basis columns','uom,hcpcs,case_qty,msrp_basis,map_basis` +','uom,hcpcs,case_qty` +'],
 ['feed','feed drops the MSRP basis','    if (r.msrp_basis === "each" || r.msrp_basis === "order_unit") o.msrp_basis = r.msrp_basis;\n',''],
 ['feed','feed passes any basis word','    if (r.map_basis === "each" || r.map_basis === "order_unit") o.map_basis = r.map_basis;','    if (r.map_basis) o.map_basis = r.map_basis;'],
 ['pricing','server copy drops the MAP basis','    if (r.map_basis === "each" || r.map_basis === "order_unit") o.map_basis = r.map_basis;\n',''],
];
let surv=0;
for(const [w,n,f,t] of M){ const src=fs.readFileSync(files[w],'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'basis-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  const env=Object.assign({},process.env,{CAT_ROOT:MD}); const mut=src.replace(f,t);
  if(w==='shop'){ const h=path.join(MD,'shop.html'); fs.writeFileSync(h,mut); env.SHOP_HTML=h; }
  else if(w==='feed'){ const h=path.join(MD,'catalog-feed.js'); fs.writeFileSync(h,mut); env.FEED_JS=h; }
  else fs.writeFileSync(path.join(MD,'_pricing.js'),mut);
  let k=false; try{ execFileSync('node',[path.join(__dirname,'msrpbasis.test.js')],{stdio:'pipe',env}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

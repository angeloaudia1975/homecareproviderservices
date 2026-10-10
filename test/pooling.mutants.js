const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const ex=require('./extract-engine.js');
const files={shop:path.join(SHOPD,'public','index.html'),feed:path.join(SHOPD,'netlify','functions','catalog-feed.js'),cat:path.join(DIR,'catalog-api.js'),pricing:path.join(DIR,'_pricing.js')};
const M=[
 ['shop','pools ignored','const tq=(t&&t.pool)?poolQty(t.pool):q;','const tq=q;'],
 ['shop','8+ pools too','const tq=(t&&t.pool)?poolQty(t.pool):q;','const tq=poolQty(t.pool||"x");'],
 ['shop','accessories pool by line','        if(cp.manufacturer===p.manufacturer && Array.isArray(cp.tiers) && cp.tiers.some(r=>r&&r.pool===name)){','        if(cp.manufacturer===p.manufacturer){'],
 ['shop','own line double-counted','      if(!seen) n+=(parseInt(qty)||1);','      n+=(parseInt(qty)||1);'],
 ['shop','pool lost on authoritative copy',"+ (x.pool ? '@' + x.pool : ''))","+ '')"],
 ['feed','feed drops pool','        .map(t => (t.pool ? { min_qty: Number(t.min_qty), price: Number(t.price), pool: String(t.pool) }','        .map(t => (false ? null'],
 ['pricing','server feed drops pool','        .map(t => (t.pool ? { min_qty: Number(t.min_qty), price: Number(t.price), pool: String(t.pool) }','        .map(t => (false ? null'],
 ['cat','validator strips pool','.slice(0,40); if(pl) o.pool=pl; return o; })','.slice(0,40); return o; })'],
 ['cat','a later save drops the pool','  if("tiers" in want){ const v=keepPools(want.tiers, c.tiers);','  if("tiers" in want){ const v=cleanTiers(want.tiers);'],
 ['cat','preview blind to pools','    return r.length?r.map(x=>x.min_qty+":"+x.price+(x.pool?"@"+x.pool:"")).join(","):""; };','    return r.length?r.map(x=>x.min_qty+":"+x.price).join(","):""; };'],
];
const engineFor=src=>{ const old=fs.readFileSync(path.join(DIR,'_shop_engine.js'),'utf8'); const i=old.indexOf('module.exports = { SOURCE: ')+'module.exports = { SOURCE: '.length;
  let j=i+1,e=false; for(;j<old.length;j++){const c=old[j]; if(e){e=false;continue;} if(c==='\\'){e=true;continue;} if(c==='"')break;}
  return old.slice(0,i)+JSON.stringify(ex.extract(src))+old.slice(j+1); };
let surv=0;
for(const [w,n,f,t] of M){ const src=fs.readFileSync(files[w],'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'pool-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  const env=Object.assign({},process.env,{CAT_ROOT:MD}); const mut=src.replace(f,t);
  if(w==='shop'){ const h=path.join(MD,'shop.html'); fs.writeFileSync(h,mut); env.SHOP_HTML=h; fs.writeFileSync(path.join(MD,'_shop_engine.js'),engineFor(mut)); }
  else if(w==='feed'){ const h=path.join(MD,'catalog-feed.js'); fs.writeFileSync(h,mut); env.FEED_JS=h; }
  else fs.writeFileSync(path.join(MD,w==='cat'?'catalog-api.js':'_pricing.js'),mut);
  let k=false; try{ execFileSync('node',[path.join(__dirname,'pooling.test.js')],{stdio:'pipe',env}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

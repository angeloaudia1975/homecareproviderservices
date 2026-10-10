const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const DIR=path.join(__dirname,'..','netlify','functions');
const SHOPD=path.join(__dirname,'..','..','homecareproviderservicesordering');
const ex=require('./extract-engine.js');
const files={shop:path.join(SHOPD,'public','index.html'),mfrs:path.join(SHOPD,'public','data','manufacturers.json'),submit:path.join(SHOPD,'netlify','functions','submit-order.js'),orders:path.join(DIR,'orders-api.js'),pricing:path.join(DIR,'_pricing.js')};
const M=[
 ['shop','category groups ignored','      const match=cats.length ? cats.includes(String(ln.p.category||"").trim().toLowerCase())','      const match=false ? 0'],
 ['mfrs','charged per accessory line','"flatFee": 15','"flatFee": 15, "perLine": true, "freeAt": 1e9, "flatBelow": 1'],
 ['mfrs','accessories ship free','"flatFee": 15','"freeAt": 0'],
 ['pricing','server skips freight','  if (freightCfg) out.forEach((o, oi) => {','  if (false) out.forEach((o, oi) => {'],
 ['orders','freight not stored','if(!PRICING.isGolden(slug) && o.freight_fee!=null){ row.freight_fee=','if(false){ row.freight_fee='],
 ['orders','confirmation omits freight','<div style="text-align:right;font-size:13px;font-weight:700;color:#1b2733;margin:6px 10px 0">Subtotal: ${money(s.subtotal)}</div>${freightLineHtml(s)}</div>`;','<div style="text-align:right;font-size:13px;font-weight:700;color:#1b2733;margin:6px 10px 0">Subtotal: ${money(s.subtotal)}</div></div>`;'],
 ['submit','HCPS email trusts the browser freight','    const serverFreight = rec.freight_fee != null && Number.isFinite(Number(rec.freight_fee));','    const serverFreight = false;'],
];
const engineFor=src=>{ const old=fs.readFileSync(path.join(DIR,'_shop_engine.js'),'utf8'); const i=old.indexOf('module.exports = { SOURCE: ')+'module.exports = { SOURCE: '.length;
  let j=i+1,e=false; for(;j<old.length;j++){const c=old[j]; if(e){e=false;continue;} if(c==='\\'){e=true;continue;} if(c==='"')break;}
  return old.slice(0,i)+JSON.stringify(ex.extract(src))+old.slice(j+1); };
let surv=0;
for(const [w,n,f,t] of M){ const src=fs.readFileSync(files[w],'utf8'); const c=src.split(f).length-1; if(c!==1){console.log(`BAD ANCHOR(${c}) ${n}`);surv++;continue;}
  const MD=fs.mkdtempSync(path.join(os.tmpdir(),'frt-')); for(const x of fs.readdirSync(DIR)) if(/\.js$/.test(x)) fs.copyFileSync(path.join(DIR,x),path.join(MD,x));
  const env=Object.assign({},process.env,{CAT_ROOT:MD}); const mut=src.replace(f,t);
  if(w==='shop'){ const h=path.join(MD,'shop.html'); fs.writeFileSync(h,mut); env.SHOP_HTML=h; fs.writeFileSync(path.join(MD,'_shop_engine.js'),engineFor(mut)); }
  else if(w==='mfrs'){ const h=path.join(MD,'m.json'); fs.writeFileSync(h,mut); env.MFRS_JSON=h; }
  else if(w==='submit'){ const h=path.join(MD,'submit-order.js'); fs.writeFileSync(h,mut); env.SUBMIT_JS=h; }
  else fs.writeFileSync(path.join(MD,w==='orders'?'orders-api.js':'_pricing.js'),mut);
  let k=false; try{ execFileSync('node',[path.join(__dirname,'freight.test.js')],{stdio:'pipe',env}); }catch(e){ k=true; }
  console.log((k?'killed  ':'SURVIVED')+' '+n); if(!k) surv++; }
console.log(surv?`${surv} survived`:'all mutants killed'); process.exit(surv?1:0);

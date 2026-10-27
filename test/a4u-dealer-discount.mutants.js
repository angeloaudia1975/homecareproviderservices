/* Mutation check for the dealer line-discount policy: each mutant breaks one rule; the test must FAIL on every one,
   and PASS on the clean copy (control). Copies netlify/functions to a temp dir per mutant (CAT_ROOT). */
const fs=require('fs'), path=require('path'), os=require('os'), {spawnSync}=require('child_process');
const SRC=path.join(__dirname,'..','netlify','functions');
const ENG='_shop_engine.js', LDF='_line_discounts.js', PR='_pricing.js', DA='dealer-auth.js', OA='orders-api.js';
/* the engine SOURCE is a JSON string: mutate the decoded text, re-encode */
const eng=f=>(txt)=>{ const m=require(path.join(SRC,ENG)); const s=f(m.SOURCE); if(s===m.SOURCE) throw new Error('engine mutant did not apply');
  return txt.slice(0,txt.indexOf('module.exports = { SOURCE: '))+'module.exports = { SOURCE: '+JSON.stringify(s)+' };\n'; };
const sub=(a,b)=>txt=>{ if(!txt.includes(a)) throw new Error('anchor missing: '+a.slice(0,50)); return txt.replace(a,b); };
const MUTANTS=[
  ['control (no change)', null, null],
  ['engine: rate never applied', ENG, eng(s=>s.replace('  const lr=lineRatePrice(p);\n  if(lr!=null) return lr;\n',''))],
  ['engine: rate checked before the contract (double-discount path)', ENG, eng(s=>s.replace('  const cp=contractPrice(p);\n  if(cp!=null) return (p&&p._upgrade)','  const lr0=lineRatePrice(p); if(lr0!=null) return lr0;\n  const cp=contractPrice(p);\n  if(cp!=null) return (p&&p._upgrade)'))],
  ['engine: rate applied on the default price instead of the list', ENG, eng(s=>s.replace('const list=Number(p.dealer_price);','const list=Number(p.base_price);'))],
  ['engine: rate applied over quantity breaks', ENG, eng(s=>s.replace('  if(Array.isArray(p.tiers) && p.tiers.length) return null;\n  return Math.round',"  return Math.round"))],
  ['engine: any number accepted as a rate', ENG, eng(s=>s.replace('if(!isFinite(rate) || rate<=0 || rate>=100) return null;','if(!isFinite(rate)) return null;'))],
  ['engine: rate also discounts MSRP', ENG, eng(s=>s.replace('  return Math.round(Number((list*(100-rate)).toFixed(6)))/100;\n}','  p.msrp=Math.round(Number(p.msrp)*(100-rate))/100;\n  return Math.round(Number((list*(100-rate)).toFixed(6)))/100;\n}'))],
  ['engine: upgrade added at list (no discount)', ENG, eng(s=>s.replace("base_price:r2(cl*(100-d0)/100)});","base_price:r2(cl)});"))],
  ['engine: upgrade MSRP left at the plain part', ENG, eng(s=>s.replace("if(isFinite(msrp)&&msrp>0){ q.msrp=r2(cl*ratio(msrp,list)); delete q._msrp_suggested; }",""))],
  ['engine: contract ignores the upgrade', ENG, eng(s=>s.replace("if(cp!=null) return (p&&p._upgrade) ? Math.round(Number(((cp+upgradeAddPurchase(p))*100).toFixed(6)))/100 : cp;","if(cp!=null) return cp;"))],
  ['engine: any upgrade label accepted', ENG, eng(s=>s.replace("const u=(Array.isArray(p&&p.upgrades)?p.upgrades:[]).find(x=>x&&x.label===label);","const u=(Array.isArray(p&&p.upgrades)?p.upgrades:[])[0]||{price_add:1};"))],
  ['server: upgrade ignored', PR, sub('const p = p0 && up ? (L.engine.withUpgrade(p0, up) || null) : p0;','const p = p0;')],
  ['module: master overrides branch', LDF, sub("(a.dealer_id === dealerId ? 1 : 0) - (b.dealer_id === dealerId ? 1 : 0)","(b.dealer_id === dealerId ? 1 : 0) - (a.dealer_id === dealerId ? 1 : 0)")],
  ['module: inactive rows count', LDF, sub("&active=eq.true&select=dealer_id","&select=dealer_id")],
  ['module: every read failure means "no rates"', LDF, sub("if (MISSING.test(String((e && e.message) || e))) return rates; throw e;","return rates;")],
  ['server: rates not passed to the engine', PR, sub('prices: contract || {}, rates: rates || {} };','prices: contract || {} };')],
  ['server: rate not echoed to the browser', OA, sub('rate:it.rate==null?null:it.rate,','')],
  ['sign-in: rates not returned', DA, sub('dealer,lines,access,cart,prices,rates,','dealer,lines,access,cart,prices,')],
];
let killed=0, bad=0;
for(const [name,file,fn] of MUTANTS){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ldm-'));
  for(const f of fs.readdirSync(SRC)) if(f.endsWith('.js')) fs.copyFileSync(path.join(SRC,f),path.join(dir,f));
  if(file){ const p=path.join(dir,file); fs.writeFileSync(p,fn(fs.readFileSync(p,'utf8'))); }
  const r=spawnSync(process.execPath,[path.join(__dirname,'a4u-dealer-discount.test.js')],{env:Object.assign({},process.env,{CAT_ROOT:dir}),encoding:'utf8',timeout:240000});
  const passed=r.status===0;
  if(!file){ console.log((passed?'ok   ':'BAD  ')+name+(passed?'':' — the clean copy fails')); if(!passed) bad++; }
  else { console.log((passed?'LIVE ':'killed ')+name); if(passed) bad++; else killed++; }
  fs.rmSync(dir,{recursive:true,force:true});
}
console.log(`\na4u dealer discount mutants: ${killed}/${MUTANTS.length-1} killed${bad?' — '+bad+' problem(s)':''}`); process.exit(bad?1:0);

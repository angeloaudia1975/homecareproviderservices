/* Mutation check for test/golden-integration-b3.test.js — every mutant breaks one rule of the B3 configurator surface on the HCPS
   side (golden-proxy `config` → Golden /v1/config); the test must FAIL on each one and
   PASS on the control. Edits the file in place and always restores it.   node test/golden-integration-b3.mutants.js */
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const M=[
  [null,'control (no change)',null,null],
  ['golden-proxy.js','dealer price kept when Golden hides prices','const price = (o, k, v) => { if(pv && num(v) != null) o[k] = v; return o; };','const price = (o, k, v) => { if(num(v) != null) o[k] = v; return o; };'],
  ['golden-proxy.js','quote price kept when Golden hides prices','    if(pv){ if(num(q.unit_price) != null)','    if(true){ if(num(q.unit_price) != null)'],
  ['golden-proxy.js','non-https swatch passed through','hex: /^#[0-9a-f]{6}$/i.test(String(x.hex)) ? x.hex : null, swatch: httpsOrNull(x.swatch),','hex: /^#[0-9a-f]{6}$/i.test(String(x.hex)) ? x.hex : null, swatch: x.swatch,'],
  ['golden-proxy.js','unknown stock status passed through','status: oneOf(x.status, STATUS) || "out"','status: x.status'],
  ['golden-proxy.js','unknown fabric tab passed through','.filter(t => t && CFG_FABRICS.includes(t.key))','.filter(t => t)'],
  ['golden-proxy.js','malformed size passed through','(Array.isArray(c.sizes) ? c.sizes : []).filter(x => x && CFG_SKU_RE.test(String(x.sku)))','(Array.isArray(c.sizes) ? c.sizes : []).filter(x => x)'],
  ['golden-proxy.js','malformed selection sent to Golden','if(!CFG_SKU_RE.test(sku) || (color && !CFG_COLOR_RE.test(color))','if(false && (color && !CFG_COLOR_RE.test(color))'],
  ['golden-proxy.js','footrest sent without being asked','if(b.footrest === true) cfgQuery.footrest = "1";','cfgQuery.footrest = "1";'],
  ['golden-proxy.js','Golden refusal shown as available','if(!r.ok && action === "config" && r.status === 400 && r.error === "bad_request") return json(200, Object.assign({ ok:true, enabled:true, available:false, reason:"not_offered" }, extra));',''],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b3.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; console.log('killed ',label); } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);

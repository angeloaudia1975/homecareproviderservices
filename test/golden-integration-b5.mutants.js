/* Mutation check for test/golden-integration-b5.test.js — each mutant breaks one rule of the B5 history / order
   surface on the HCPS side; the test must FAIL on each and PASS on the control.   node test/golden-integration-b5.mutants.js */
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const M=[
  [null,'control (no change)',null,null],
  ['golden-proxy.js','history switch ignored','if((action === "history" || action === "order") && f.golden_p360_history !== true) return','if(false) return'],
  ['golden-proxy.js','unknown history params forwarded','histQuery = {};','histQuery = Object.assign({}, b); delete histQuery.action;'],
  ['golden-proxy.js','limit unbounded','b.limit < 1 || b.limit > 50','b.limit < 1'],
  ['golden-proxy.js','malformed order ref forwarded','if(typeof b.order_ref !== "string" || !ORDER_REF_RE.test(b.order_ref)) return json(400','if(typeof b.order_ref !== "string") return json(400'],
  ['golden-proxy.js','amounts shown when prices are hidden','if(pv && o.totals && typeof o.totals === "object") out.totals','if(o.totals && typeof o.totals === "object") out.totals'],
  ['golden-proxy.js','history partial instead of all-or-nothing','if(!list || list.some(o => !o)) return','if(!list) return'],
  ['golden-proxy.js','answer for another order shown','if(!o || o.order_ref !== histRef) return','if(!o) return'],
  ['golden-proxy.js','unsafe tracking text passed','(typeof x.tracking_number === "string" && /^[A-Za-z0-9 -]{0,80}$/.test(x.tracking_number)) ? x.tracking_number : ""','str(x.tracking_number, 80) || ""'],
  ['golden-proxy.js','lifecycle events not allow-listed','.filter(e => e && HEVENTS.includes(e.type))','.filter(e => e)'],
  ['golden-proxy.js','staff preview reads production history','if(who.preview && (action === "validate_order" || action === "history" || action === "order"))','if(who.preview && (action === "validate_order"))'],
  ['golden-proxy.js','unknown order source relabelled','|| !["portal","golden","linked"].includes(o.source)) return null;',') return null;'],
  ['golden-proxy.js','order 404 shown as unavailable','if(r.status === 404 && action === "order") return json(200','if(false) return json(200'],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b5.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; console.log('killed ',label); } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);

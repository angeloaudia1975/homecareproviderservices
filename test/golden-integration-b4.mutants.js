/* Mutation check for test/golden-integration-b4.test.js — every mutant breaks one rule of the B4a quote surface on the HCPS
   side (golden-proxy `quote` → Golden POST /v1/quote); the test must FAIL on each one and PASS on the control.
   Edits the file in place and always restores it.   node test/golden-integration-b4.mutants.js */
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const M=[
  [null,'control (no change)',null,null],
  ['golden-proxy.js','browser fields forwarded to Golden','lines.push(o);','lines.push(Object.assign({}, l, o));'],
  ['golden-proxy.js','qty above the cap accepted','qty < 1 || qty > QUOTE_MAX_QTY','qty < 1'],
  ['golden-proxy.js','too many lines accepted','if(!ls || !ls.length || ls.length > QUOTE_MAX_LINES) return null;','if(!ls || !ls.length) return null;'],
  ['golden-proxy.js','colour not required','!CFG_SKU_RE.test(sku) || !CFG_COLOR_RE.test(color) ||','!CFG_SKU_RE.test(sku) ||'],
  ['golden-proxy.js','partial quote shown','if(lines.length !== q.lines.length) return null;',''],
  ['golden-proxy.js','unknown total fields passed','const totals = { subtotal: t.subtotal,','const totals = { ...t, subtotal: t.subtotal,'],
  ['golden-proxy.js','unknown shipment group passed','filter(s => s && GROUPS.includes(s.group) &&','filter(s => s &&'],
  ['golden-proxy.js','bad hash accepted','|| !/^[0-9a-f]{64}$/.test(String(q.quote_hash))) return null;',') return null;'],
  ['golden-proxy.js','ordering_enabled not checked','if(!q || g.ordering_enabled !== false)','if(!q)'],
  ['golden-proxy.js','quote sent as GET','method: (action === "quote" || action === "validate_order" || ordering) ? "POST" : "GET"','method: (action === "validate_order" || ordering) ? "POST" : "GET"'],
  ['golden-proxy.js','prices_not_visible hidden as outage','r.status === 403 && r.error === "prices_not_visible" ? "prices_not_visible" :','r.status === 403 && r.error === "prices_not_visible" ? null :'],
  ['golden-proxy.js','a typed address forwarded as ship-to','    out.ship_to = { id };   // only the id','    out.ship_to = Object.assign({}, b.ship_to, { id });   // only the id'],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b4.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; console.log('killed ',label); } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);

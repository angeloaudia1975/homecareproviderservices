/* Mutation check for test/golden-integration-b2.test.js — every mutant breaks one rule of the B2 surface on the HCPS
   side (catalog/inventory through golden-proxy and the preview test-key path); the test must FAIL on each one and
   PASS on the control. Edits the file in place and always restores it.   node test/golden-integration-b2.mutants.js */
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const M=[
  [null,'control (no change)',null,null],
  ['golden-proxy.js','price kept when Golden hides prices','if(pricesVisible && (typeof p.dealer_price','if((typeof p.dealer_price'],
  ['golden-proxy.js','unknown product fields passed through','for(const k of PRODUCT_KEYS) if(p[k] !== undefined) o[k] = p[k];','Object.assign(o, p);'],
  ['golden-proxy.js','non-https image passed through','o.image = httpsOrNull(p.image);','o.image = p.image;'],
  ['golden-proxy.js','unknown stock status passed through','["in","low","out","on_request"].includes(i.status))','true)'],
  ['golden-proxy.js','stale assumed fresh when missing','stale: g.stale !== false,','stale: g.stale === true,'],
  ['golden-proxy.js','preview allowed for a dealer sign-in','if(!who.preview || !ORDERING_PREVIEW_ORIGIN.test(origin))','if(!ORDERING_PREVIEW_ORIGIN.test(origin))'],
  ['golden-proxy.js','preview allowed from any origin','if(!who.preview || !ORDERING_PREVIEW_ORIGIN.test(origin))','if(!who.preview)'],
  ['golden-proxy.js','preview uses the production key','env: envName || undefined,','env: undefined,'],
  ['_golden_client.js','test key may reach production Golden','base: PREVIEW_BASE_RE.test(b) ? b : "", usable: !!kid && S2S.secretUsable(secret) && PREVIEW_BASE_RE.test(b) && distinct','base: b, usable: !!kid && S2S.secretUsable(secret) && distinct'],
  ['_golden_client.js','test key may equal the production key','&& PREVIEW_BASE_RE.test(b) && distinct };','&& PREVIEW_BASE_RE.test(b) };'],
  ['golden-proxy.js','orders action reachable','const ACTIONS = { eligibility: "/v1/eligibility", catalog: "/v1/catalog", inventory: "/v1/inventory" };','const ACTIONS = { eligibility: "/v1/eligibility", catalog: "/v1/catalog", inventory: "/v1/inventory", orders: "/v1/orders" };'],
  ['golden-proxy.js','branch refusal hidden','const branch = r.status === 403 && r.error === "branch_not_permitted";','const branch = false;'],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b2.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; console.log('killed ',label); } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);

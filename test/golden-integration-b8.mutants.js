#!/usr/bin/env node
// Mutation check for test/golden-integration-b8.test.js — every §4j rule of golden-proxy (scooters, accessories, beds,
// Golden-quoted freight) must be caught.
"use strict";
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const P='golden-proxy.js';
const M=[
  [null,'control (no change)',null,null],
  [P,'price forwarded on a mobility line','const o = { kind: "mobility", sku, qty }; if(color) o.color = color; return o;','const o = Object.assign({}, l, { kind: "mobility", sku, qty }); if(color) o.color = color; return o;'],
  [P,'accessory of a chair accepted','if(!ACC_ID_RE.test(sku) || !(MOB_SKU_RE.test(forSku) || BED_SKU_RE.test(forSku))) return null;','if(!ACC_ID_RE.test(sku)) return null;'],
  [P,'white-glove on a base accepted','if((delivery === "wg" && config !== "set") || (l.rural === true && delivery !== "wg")) return null;',''],
  [P,'mobility qty not bounded','if(!Number.isInteger(qty) || qty < 1 || qty > QUOTE_MAX_QTY) return null;\n  if(l.kind === "mobility"){','if(l.kind === "mobility"){'],
  [P,'unknown kind accepted','  return null;\n}\nfunction readQuoteBody(b){','  return { kind: l.kind, sku: up(l.sku), qty };\n}\nfunction readQuoteBody(b){'],
  [P,'freight not included shown as a normal quote','if(!(t.freight_total >= 0) || !q.freight || q.freight.included !== !fq) return null;','if(!(t.freight_total >= 0) || !q.freight) return null;'],
  [P,'to-be-quoted flag dropped','if(fq){ totals.freight_quote_required = true; if(!totals.shipments.some(s => s.freight_quote)) return null; }',''],
  [P,'flag without a marked shipment accepted','if(!totals.shipments.some(s => s.freight_quote)) return null; }','}'],
  [P,'freight acknowledgement forced on','if(b.freight_quote_ack === true) out.freight_quote_ack = true;','out.freight_quote_ack = true;'],
  [P,'non-boolean acknowledgement accepted','if(b.freight_quote_ack != null && typeof b.freight_quote_ack !== "boolean") return null;',''],
  [P,'acknowledgement refusal not named on placement','if(r.status === 409 && code === "freight_quote_ack_required") return json(200, Object.assign(base, { reason:"freight_quote_ack_required", new_attempt:true }, extra));',''],
  [P,'acknowledgement refusal not named on validation','freight_quote_ack_required:"freight_quote_ack_required",',''],
  [P,'scooter panel asked with chair fields','      if(cfgQuery.fabric){','      if(true){ cfgQuery.fabric = cfgQuery.fabric || "std";'],
  [P,'option prices shown when hidden','if(pv && num(o.dealer_price) != null) out.dealer_price = o.dealer_price;','if(num(o.dealer_price) != null) out.dealer_price = o.dealer_price;'],
  [P,'option quantities shown to an unlinked dealer','const qty = (x, v) => { if(linked && Number.isInteger(v)) x.qty = v; return x; };\n  const acc','const qty = (x, v) => { if(Number.isInteger(v)) x.qty = v; return x; };\n  const acc'],
  [P,'unknown history freight status passed on','if(o.freight_status === "to_be_quoted" || o.freight_status === "charged_by_golden") out.freight_status = o.freight_status;','if(o.freight_status) out.freight_status = o.freight_status;'],
  [P,'bed line facts dropped from the quote','if(l.kind === "bed") Object.assign(x, { size: oneOf(l.size, BED_SIZES), config: oneOf(l.config, BED_CONFIGS), delivery: oneOf(l.delivery, BED_DELIVERIES), rural: l.rural === true });',''],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b8.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);

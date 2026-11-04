#!/usr/bin/env node
// Mutation check for test/golden-integration-b6.test.js — every B6 placement rule of golden-proxy must be caught.
"use strict";
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const M=[
  [null,'control (no change)',null,null],
  ['golden-proxy.js','staff view-as token may place','    if(ordering && who.preview) return json(403, { ok:false, error:"preview_not_allowed" });\n',''],
  ['golden-proxy.js','ordering switch ignored','if(ordering && f.golden_p360_ordering !== true) return','if(false) return'],
  ['golden-proxy.js','checkout switch not required to place','if((action === "validate_order" || ordering) && f.golden_p360_checkout !== true)','if(action === "validate_order" && f.golden_p360_checkout !== true)'],
  ['golden-proxy.js','preview orders switch ignored','if(pf.golden_p360_preview_orders !== true) return json(403','if(false) return json(403'],
  ['golden-proxy.js','any dealer may use the Golden preview','if(!isTest) return json(403, { ok:false, error:"preview_not_allowed" });',''],
  ['golden-proxy.js','a branch of a non-TEST head office counts as TEST','  if(!d.parent_id) return true;\n','  return true;\n'],
  ['golden-proxy.js','preview origin not required for a dealer','      if(!ORDERING_PREVIEW_ORIGIN.test(origin)) return json(403, { ok:false, error:"preview_not_allowed" });\n      if(!who.preview){','      if(!who.preview){'],
  ['golden-proxy.js','sent as validate (mode not submit)','if(action === "place_order") quoteBody.mode = "submit";',''],
  ['golden-proxy.js','placement sent as GET','method: (action === "quote" || action === "validate_order" || ordering) ? "POST" : "GET"','method: (action === "quote" || action === "validate_order") ? "POST" : "GET"'],
  ['golden-proxy.js','unknown outcome reported as not placed','return json(200, Object.assign({ ok:true, enabled:true, available:true, placed:null, reason:"outcome_unknown", retry:true }, extra));\n    }\n    if(ordering){','return json(200, Object.assign({ ok:true, enabled:true, available:true, placed:false, reason:"golden_unavailable" }, extra));\n    }\n    if(ordering){'],
  ['golden-proxy.js','a non-201 success accepted as placed','if(ordering && !(r.ok && r.status === 201)){','if(ordering && !r.ok){'],
  ['golden-proxy.js','in-progress treated as definite','const definite = { not_validated:"revalidate", validation_expired:"revalidate", duplicate_po:"duplicate_po",','const definite = { idempotency_in_progress:"revalidate", not_validated:"revalidate", validation_expired:"revalidate", duplicate_po:"duplicate_po",'],
  ['golden-proxy.js','a conflict / other-dealer key reported as not placed','if(code === "idempotency_conflict" || code === "attempt_other_dealer") return json(200, Object.assign({ ok:true, enabled:true, available:true, placed:null, reason:"unconfirmed", retry:false }, extra));','if(code === "idempotency_conflict" || code === "attempt_other_dealer") return json(200, Object.assign({ ok:true, enabled:true, available:true, placed:false, definite:true, reason:"unconfirmed" }, extra));'],
  ['golden-proxy.js','gate scope (golden:read) treated as definite','order_scope:"ordering_unavailable", prices_not_visible','scope:"ordering_unavailable", order_scope:"ordering_unavailable", prices_not_visible'],
  ['golden-proxy.js','definite flag missing','const base = { ok:true, enabled:true, available:true, placed:false, definite:true };','const base = { ok:true, enabled:true, available:true, placed:false };'],
  ['golden-proxy.js','5xx treated as a definite refusal','if(r.status >= 400 && r.status < 500 && definite[code])','if(definite[code] || r.status >= 500)'],
  ['golden-proxy.js','placement answer for another quote accepted','  if(String(q.quote_hash) !== String(sentHash)) return null;   // an answer for another quote is not this order\n',''],
  ['golden-proxy.js','any order ref accepted','const PLACED_REF_RE = /^P\\d{1,12}$/;','const PLACED_REF_RE = /^[A-Z]\\w*$/;'],
  ['golden-proxy.js','placement status not checked','g.placed !== true || g.status !== "submitted" ||','g.placed !== true ||'],
  ['golden-proxy.js','unknown placement fields pass','return { order_ref: g.order_ref, status: "submitted"','return { ...g, order_ref: g.order_ref, status: "submitted"'],
  ['golden-proxy.js','notification words unchecked','order_desk: oneOf(n.order_desk, NOTE_STATES) || "failed", dealer_confirmation: oneOf(n.dealer_confirmation, NOTE_STATES) || "failed"','order_desk: n.order_desk, dealer_confirmation: n.dealer_confirmation, to: n.to'],
  ['golden-proxy.js','prices_changed not a new attempt','reason:"prices_changed", new_attempt:true','reason:"prices_changed", new_attempt:false'],
  ['golden-proxy.js','HCPS switch not applied to the Place order button','v.ordering_enabled = v.ordering_enabled === true && hcpsOrdering;','v.ordering_enabled = v.ordering_enabled === true;'],
  ['golden-proxy.js','staff preview sees Place order','envName = "preview"; hcpsOrdering = !who.preview;','envName = "preview"; hcpsOrdering = true;'],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b6.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; console.log('killed ',label); } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);

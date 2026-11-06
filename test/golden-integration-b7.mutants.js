#!/usr/bin/env node
// Mutation check for test/golden-integration-b7.test.js — every B7 account / address rule must be caught.
"use strict";
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const FN=path.join(__dirname,'..','netlify','functions');
const M=[
  [null,'control (no change)',null,null],
  ['golden-proxy.js','account gate ignored','if(!envName && who.accountGate){','if(false){'],
  ['golden-proxy.js','a location without a number still reaches Golden','if(!a.ok) return json(200, { ok:true, enabled:false, reason: a.reason });','if(!a.ok){}'],
  ['golden-proxy.js','sub_dealer not the number holder','acct = a.acct; c = { sub_dealer: a.owner, sub_branch: null };','acct = a.acct;'],
  ['golden-proxy.js','number not sent to Golden','acct ? { acct } : {}','{}'],
  ['golden-proxy.js','HCPS ship-to switch ignored','if(envName || !who.hcpsShipTo || !acct) return json(400','if(envName || !acct) return json(400'],
  ['golden-proxy.js','reviewed address not checked on place','(!e || !e.usable || quoteBody.ship_to_reviewed !== GA.shipId(e))','(!e || !e.usable)'],
  ['golden-proxy.js','changed address reported as definite not placed','placed:null, reason:"unconfirmed", detail:"ship_to_changed", retry:false','placed:false, definite:true, reason:"ship_to_changed"'],
  ['golden-proxy.js','browser hcps- id accepted','if(!SHIP_ID_RE.test(id) || /^hcps-/.test(id)) return null;','if(!SHIP_ID_RE.test(id)) return null;'],
  ['_golden_addresses.js','head office number not inherited','const ids = [d.id].concat(d.parent_id && UUID_RE.test(String(d.parent_id)) ? [d.parent_id] : []);','const ids = [d.id];'],
  ['_golden_addresses.js','two numbers on a dealer allowed','if(nums.length > 1) return { ok:false, reason:"golden_account_ambiguous" };',''],
  ['_golden_addresses.js','numbers not trimmed when matching','.filter(r => normAcct(r.account_ref) === acct)','.filter(r => String(r.account_ref) === acct)'],
  ['_golden_addresses.js','branch on another account joins the book','if(!d || seen.has(d.id) || other.has(d.id)) continue;','if(!d || seen.has(d.id)) continue;'],
  ['_golden_addresses.js','TEST dealers in a real book','if(d.is_test === true && !opts.includeTest) continue;',''],
  ['_golden_addresses.js','inactive dealers in the book','if(d.active === false) continue;',''],
  ['_golden_addresses.js','removed saved addresses listed','&removed_at=is.null&select=id,name,address,address2','&select=id,name,address,address2'],
  ['_golden_addresses.js','another account\'s saved addresses listed','golden_ship_addresses?account_no=eq.${enc(acct)}&removed_at','golden_ship_addresses?removed_at'],
  ['_golden_addresses.js','any state accepted','if(!US_STATES.has(v.state)) return { ok:false, field:"state" };',''],
  ['_golden_addresses.js','markup accepted','if(/[<>]/.test(Object.values(v).join(""))) return { ok:false, field:"text" };',''],
  ['_golden_addresses.js','id ignores address2','JSON.stringify(KEYS.map(k => h[k]))','JSON.stringify(KEYS.filter(k => k !== "address2").map(k => h[k]))'],
  ['golden-addresses-api.js','staff preview may write','if(who.preview && b.action !== "list") return json(403','if(false) return json(403'],
  ['golden-addresses-api.js','edit not limited to this account','`golden_ship_addresses?id=eq.${enc(m[1])}&account_no=eq.${enc(acct)}&removed_at=is.null`,\n            Object.assign','`golden_ship_addresses?id=eq.${enc(m[1])}&removed_at=is.null`,\n            Object.assign'],
  ['golden-addresses-api.js','remove not limited to this account','"PATCH", `golden_ship_addresses?id=eq.${enc(m[1])}&account_no=eq.${enc(acct)}&removed_at=is.null`, { removed_at','"PATCH", `golden_ship_addresses?id=eq.${enc(m[1])}&removed_at=is.null`, { removed_at'],
  ['golden-addresses-api.js','location address removable','if(!m) return json(400, { ok:false, error:"not_removable" });',''],
  ['golden-addresses-api.js','default may name another account\'s address','const e = bk.entries.find(x => x.ref === ref && x.usable);','const e = { ref };'],
  ['golden-addresses-api.js','stale default kept','const hit = savedRef ? usable.find(e => e.ref === savedRef) : null;','const hit = savedRef ? { ref: savedRef } : null;'],
  ['golden-addresses-api.js','ambiguous destination pre-selected','(!savedRef && usable.length === 1 ? usable[0].ref : null)','(usable.length ? usable[0].ref : null)'],
  ['golden-addresses-api.js','invalid address saved','if(!v.ok) return json(400, { ok:false, error:"invalid", field: v.field });',''],
];
let killed=0, bad=0;
for(const [file,label,find,repl] of M){
  let orig=null, p=null;
  if(file){ p=path.join(FN,file); orig=fs.readFileSync(p,'utf8'); const n=orig.split(find).length-1;
    if(n!==1){ console.log('BAD ANCHOR ('+n+')',label); bad++; continue; } fs.writeFileSync(p,orig.replace(find,repl)); }
  try{
    const r=spawnSync(process.execPath,[path.join(__dirname,'golden-integration-b7.test.js')],{encoding:'utf8'});
    const failed=r.status!==0;
    if(!file){ if(failed){ console.log('CONTROL FAILED'); bad++; } else console.log('control passes'); }
    else if(failed){ killed++; } else { bad++; console.log('SURVIVED',label); }
  } finally { if(p) fs.writeFileSync(p,orig); }
}
console.log(`\n${killed}/${M.length-1} mutants killed${bad?', '+bad+' problem(s)':''}`);
process.exit(bad?1:0);

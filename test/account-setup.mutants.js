/* Owner directive 2026-11-06 — ordering authorization vs manufacturer account setup: mutants for the hold, its release, the
   HCPS-entered verification and the Account Center filter. Each must make a suite fail.  node test/account-setup.mutants.js */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const AS = F('_account_setup.js'), OA = F('orders-admin.js'), AO = F('_accountorg.js'), DT = F('dealer-tools-api.js');
const ACF = F('_account_center.js'), DR = F('_verification_dryrun.js');
const M = [
  { f: F('crm-api.js'), from: "const vOk=l=>!!String(l.account_ref||\"\").trim();", to: "const vOk=l=>!!l.verified_at;", why: 'Dealer 360 not verified by presence' },
  { f: F('dealers-api.js'), from: "else await sbSend(\"POST\",\"dealer_manufacturers?on_conflict=dealer_id,manufacturer\",{dealer_id:cl.dealer_id,manufacturer:cl.manufacturer,account_ref:cl.account_ref,active:false", to: "else await sbSend(\"POST\",\"dealer_manufacturers?on_conflict=dealer_id,manufacturer\",{dealer_id:cl.dealer_id,manufacturer:cl.manufacturer,account_ref:cl.account_ref,active:true", why: 'claim verify grants ordering' },
  { f: ACF, from: "if (ref.trim()) return Object.assign({ status: \"verified\"", to: "if (false) return Object.assign({ status: \"verified\"", why: 'identifier on file not verified' },
  { f: ACF, from: "ordering: !!(dm && dm.active !== false) },\n    claim", to: "ordering: true },\n    claim", why: 'verified treated as ordering' },
  { f: ACF, from: "if (ref.trim())", to: "if (ref)", why: 'blank identifier verified' },
  { f: DR, from: "current: 'Verified', proposed", to: "current: 'Pending', proposed", why: 'identifier list says pending' },
  { f: AS, from: "if (d && d[0] && d[0].parent_id) ids.push(String(d[0].parent_id));", to: "", why: 'head-office identifier ignored' },
  { f: AS, from: "(r) => String(r.account_ref == null ? '' : r.account_ref).trim()", to: "(r) => true", why: 'blank identifier counted as an account' },
  { f: AS, from: "(s) => s && !GOLDEN.has(s)", to: "(s) => s", why: 'Golden held' },
  { f: OA, from: "if(missing.length) return json(409,{error:\"account_not_set_up\"", to: "if(false) return json(409,{error:\"account_not_set_up\"", why: 'released without an account' },
  { f: OA, from: "if(!same) return json(409,{error:\"prices_changed\"", to: "if(false) return json(409,{error:\"prices_changed\"", why: 'changed price released without the dealer' },
  { f: OA, from: "const same=c&&b.dealer_confirmed===true&&note", to: "const same=c&&b.dealer_confirmed===true", why: 'confirmation without a note' },
  { f: OA, from: "proposal.lines.every(x=>c.lines.some(y=>String(y&&y.id)===String(x.id)&&Math.abs(num(y.unit)-x.unit)<0.005))", to: "true", why: 'confirmation not tied to the figures shown' },
  { f: F('_pricing.js'), from: "|| !!(p0 && Array.isArray(p0.upgrades) && p0.upgrades.length)", to: "", why: 'upgradeable code not flagged' },
  { f: OA, from: "if(n.configurable && !(n.available===false && (n.rule||n.discontinued)))", to: "if(n.configurable)", why: 'configured line breaking a rule kept' },
  { f: OA, from: "&&((proposal.freight==null&&(c.freight==null))||(proposal.freight!=null&&c.freight!=null&&Math.abs(num(c.freight)-proposal.freight)<0.005))", to: "", why: 'freight not part of the confirmation' },
  { f: OA, from: "const frChanged=newFr!=null&&(oldFr==null?newFr>0:Math.abs(newFr-oldFr)>=0.005);", to: "const frChanged=oldFr!=null&&newFr!=null&&Math.abs(newFr-oldFr)>=0.005;", why: 'freight with none recorded not confirmed' },
  { f: OA, from: "if(kept.length && !(b.kept_prices_checked===true && note))", to: "if(false)", why: 'configured line released without a by-hand check' },
  { f: OA, from: "return {id:i.id,code:i.code,name:i.name,qty:i.qty,old_unit:old,new_unit:old,kept:true};", to: "{}", why: 'configured line re-priced from its code alone' },
  { f: OA, from: "const newFr=(kept.length||po.freight_fee==null)?oldFr:r2(num(po.freight_fee));", to: "const newFr=oldFr;", why: 'freight not re-worked' },
  { f: OA, from: "for(const l of changed){\n        try{ await sbSend(\"PATCH\"", to: "for(const l of []){\n        try{ await sbSend(\"PATCH\"", why: 'new prices not stored' },
  { f: OA, from: "return json(502,{error:\"release_incomplete\"", to: "continue; return json(502,{error:\"release_incomplete\"", why: 'failed line write still released' },
  { f: OA, from: "const g=await sbSend(\"PATCH\",`orders?id=eq.${encodeURIComponent(b.id)}&status=eq.${encodeURIComponent(AS.STATUS)}`", to: "const g=await sbSend(\"PATCH\",`orders?id=eq.${encodeURIComponent(b.id)}`", why: 'cancelled order touched' },
  { f: OA, from: "const NEXT={pending_account_setup:[\"cancelled\"],", to: "const NEXT={pending_account_setup:[\"placed\",\"cancelled\"],", why: 'held order placed directly' },
  { f: OA, from: "if(!Array.isArray(its)||!its.length) return json(409", to: "if(false) return json(409", why: 'released with no lines read' },
  { f: F('orders-api.js'), from: "acctUnchecked=true; acctMissing=new Set(acctSlugs.filter(s=>!AS.GOLDEN.has(String(s))));", to: "acctUnchecked=true; acctMissing=new Set();", why: 'unreadable account → not held (fail open)' },
  { f: F('_pricing.js'), from: "const configurable = same.length > 1 ||", to: "const configurable = false &&", why: 'two-family code not flagged' },
  { f: AO, from: "} catch (e) { return { saved: true, verified: true, verified_at: at, verified_by: who, family_filled: 0, family_incomplete: true }; }", to: "} catch (e) { throw e; }", why: 'family read failure hides the saved number' },
  { f: AO, from: "const ver = ref ? { verified_at: at, verified_by: who, verified_ref: ref }", to: "const ver = ref ? { verified_at: null, verified_by: null, verified_ref: null }", why: 'HCPS entry not verified' },
  { f: AO, from: "Object.assign({ dealer_id: dealerId, manufacturer: slug, account_ref: ref, active: false }, ver)", to: "Object.assign({ dealer_id: dealerId, manufacturer: slug, account_ref: ref, active: true }, ver)", why: 'identifier opens ordering' },
  { f: AO, from: "account_ref: ref, active: false }, ver));", to: "account_ref: ref, active: true }, ver));", why: 'branch identifier opens ordering' },
  { f: DT, from: ".filter((x) => x.status !== \"none\" ||", to: ".filter((x) => true ||", why: 'unapproved lines listed' },
  { f: DT, from: "&& String(loc.golden_status || \"None\") !== \"None\")", to: "&& false)", why: 'Golden prospect hidden' },
  { f: DT, from: "return g ? \"Golden account #\" : \"HCPS account\";", to: "return \"HCPS account\";", why: 'Golden number labelled HCPS account' },
];
const SUITES = ['order-routing.test.js', 'dealer-hq-inheritance.test.js', 'account-center.test.js', 'shopcart.test.js', 'verification-dryrun.test.js'];
const run = () => { for (const t of SUITES) { const r = spawnSync(process.execPath, [path.join(__dirname, t)], { encoding: 'utf8', env: process.env }); if (r.status !== 0) return r; } return { status: 0 }; };
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [], bad = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { bad.push(m.why); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`account-setup mutants: ${k}/${M.length - bad.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}${bad.length ? ' — missing anchors: ' + bad.join('; ') : ''}`);
process.exit(s.length || bad.length ? 1 : 0);

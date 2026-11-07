/* Owner directive 2026-11-06 — ordering authorization vs manufacturer account setup: mutants for the hold, its release, the
   HCPS-entered verification and the Account Center filter. Each must make a suite fail.  node test/account-setup.mutants.js */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const AS = F('_account_setup.js'), OA = F('orders-admin.js'), AO = F('_accountorg.js'), DT = F('dealer-tools-api.js');
const M = [
  { f: AS, from: "if (d && d[0] && d[0].parent_id) ids.push(String(d[0].parent_id));", to: "", why: 'head-office identifier ignored' },
  { f: AS, from: "(r) => String(r.account_ref == null ? '' : r.account_ref).trim()", to: "(r) => true", why: 'blank identifier counted as an account' },
  { f: AS, from: "(s) => s && !GOLDEN.has(s)", to: "(s) => s", why: 'Golden held' },
  { f: OA, from: "if(missing.length) return json(409,{error:\"account_not_set_up\"", to: "if(false) return json(409,{error:\"account_not_set_up\"", why: 'released without an account' },
  { f: OA, from: "if(changed.length && !(b.dealer_confirmed===true && note))", to: "if(false)", why: 'changed price released without the dealer' },
  { f: OA, from: "&& note))", to: "))", why: 'confirmation without a note' },
  { f: OA, from: "for(const l of changed) await sbSend(\"PATCH\"", to: "for(const l of []) await sbSend(\"PATCH\"", why: 'new prices not stored' },
  { f: OA, from: "const NEXT={pending_account_setup:[\"cancelled\"],", to: "const NEXT={pending_account_setup:[\"placed\",\"cancelled\"],", why: 'held order placed directly' },
  { f: OA, from: "if(!Array.isArray(cur.order_items)||!cur.order_items.length) return json(409", to: "if(false) return json(409", why: 'released with no lines read' },
  { f: AO, from: "const ver = ref ? { verified_at: at, verified_by: who, verified_ref: ref }", to: "const ver = ref ? { verified_at: null, verified_by: null, verified_ref: null }", why: 'HCPS entry not verified' },
  { f: AO, from: "Object.assign({ dealer_id: dealerId, manufacturer: slug, account_ref: ref, active: false }, ver)", to: "Object.assign({ dealer_id: dealerId, manufacturer: slug, account_ref: ref, active: true }, ver)", why: 'identifier opens ordering' },
  { f: AO, from: "account_ref: ref, active: false }, ver));", to: "account_ref: ref, active: true }, ver));", why: 'branch identifier opens ordering' },
  { f: DT, from: ".filter((x) => x.status !== \"none\"),", to: ",", why: 'unapproved lines listed' },
  { f: DT, from: "return g ? \"Golden account #\" : \"HCPS account\";", to: "return \"HCPS account\";", why: 'Golden number labelled HCPS account' },
];
const SUITES = ['order-routing.test.js', 'dealer-hq-inheritance.test.js', 'account-center.test.js'];
const run = () => { for (const t of SUITES) { const r = spawnSync(process.execPath, [path.join(__dirname, t)], { encoding: 'utf8', env: process.env }); if (r.status !== 0) return r; } return { status: 0 }; };
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [], bad = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { bad.push(m.why); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`account-setup mutants: ${k}/${M.length - bad.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}${bad.length ? ' — missing anchors: ' + bad.join('; ') : ''}`);
process.exit(s.length || bad.length ? 1 : 0);

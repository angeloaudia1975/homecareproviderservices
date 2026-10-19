/* Mutation check for Dealer 360 › HCPS Academy: test/academy-d360.test.js must fail on every mutant. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const D = path.join(__dirname, '..', 'netlify', 'functions', '_academy_d360.js'), C = path.join(__dirname, '..', 'netlify', 'functions', 'crm-api.js');
const M = [
  { f: C, from: 'if(!(await FL.flagOn(sbGet,"academy_dealer360"))) return json(200,{ok:true,enabled:false});', to: '', why: 'switch ignored' },
  { f: D, from: "exam: { attempts: done.length, passed: done.some(a => a.passed === true),", to: "exam: { score: (done[0] || {}).score, attempts: done.length, passed: done.some(a => a.passed === true),", why: 'score read and shown', also: ['select=enrollment_id,passed,submitted_at`', 'select=enrollment_id,passed,submitted_at,score`'] },
  { f: D, from: "&status=eq.completed&select=enrollment_id`", to: "&select=enrollment_id`", why: 'viewed counted as completed' },
  { f: D, from: "a.submitted_at);", to: "true);", why: 'unsubmitted attempts counted' },
  { f: D, from: "      if (c.test_course) continue;   // TEST courses are never counted in real figures\n", to: '', why: 'TEST course counted' },
  { f: D, from: "return c.expires_at && Date.parse(c.expires_at) <= now ? 'expired' : 'valid';", to: "return 'valid';", why: 'expired shown as valid' },
  { f: D, from: "left <= EXPIRING_DAYS };", to: "false };", why: 'expiring soon never flagged' },
  { f: D, from: "&status=eq.pending&select=dealer_id,expires_at`", to: "&select=dealer_id,expires_at`", why: 'accepted/revoked invitations counted' },
  { f: D, from: "i => !i.expires_at || Date.parse(i.expires_at) > now", to: "i => true", why: 'expired invitations counted' },
  { f: D, from: "const active = m.status === 'active' && (l.status || 'active') === 'active';", to: "const active = true;", why: 'ended access shown as active' },
  { f: D, from: "&select=id,full_name,status`", to: "&select=id,full_name,status,email`", why: 'email read (then shown)', also: ["    out.people.push({ name: l.full_name || 'Learner',", "    out.people.push({ email: l.email, name: l.full_name || 'Learner',"] },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'academy-d360.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { s.push(m.why + ' (missing)'); continue; }
  let x = o.replace(m.from, m.to); if (m.also) x = x.replace(m.also[0], m.also[1]); fs.writeFileSync(m.f, x); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`academy-d360 mutants: ${k}/${M.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}`); process.exit(s.length ? 1 : 0);

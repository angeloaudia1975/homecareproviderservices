/* Mutation check for the route-access security fix (test/sr-access.test.js). Each mutant breaks ONE safeguard in memory
   (phase0-mock's loader; nothing on disk changes) and the suite must fail; the CONTROL must pass.
     node test/sr-access.mutants.js */
const { spawnSync } = require('child_process');
const path = require('path');
const RR = '_route_reach.js', RA = 'routes-api.js', ES = 'email-sync-api.js', AI = 'ai-email-api.js', RC = 'rep-command-api.js';
const M = {
  CONTROL: { file: RR, control: true, from: 'const enc = encodeURIComponent;', to: 'const enc = encodeURIComponent; /* control */' },
  own_route_counts: { file: RR, from: '&& low(r.owner_email) !== me &&', to: '&&' },
  any_role_assigns: { file: RR, from: 'u => low(u.role) === "president" && u.active !== false', to: 'u => u.active !== false' },
  inactive_president: { file: RR, from: 'low(u.role) === "president" && u.active !== false', to: 'low(u.role) === "president"' },
  visit_any_rep: { file: RR, from: '&rep_email=eq.${enc(me)}&${STARTED}', to: '&${STARTED}' },
  visit_not_started: { file: RR, from: '&rep_email=eq.${enc(me)}&${STARTED}', to: '&rep_email=eq.${enc(me)}' },
  reach_swallows_errors: { file: RR, from: 'const rs = await sbGet(`rep_routes?assigned_to_email=eq.${enc(me)}&select=*&limit=1000`);',
    to: 'let rs; try { rs = await sbGet(`rep_routes?assigned_to_email=eq.${enc(me)}&select=*&limit=1000`); } catch (e) { rs = []; }' },
  save_unchecked: { file: RA, from: 'if(off.length){ const names=row.stops.filter(', to: 'if(false){ const names=row.stops.filter(' },
  no_lock: { file: RA, from: 'locked=new Set(off.filter(id=>!mine(vmap[id])));', to: 'locked=new Set();' },
  lock_keeps_contacts: { file: RA, from: 'return {...x, contact_name:"", contact_email:"", contact_phone:"", contacts:[], visit:x.visit?{status:x.visit.status||null}:null, locked:true,', to: 'return {...x, locked:true,' ,
    also: { from: 'const ids=[...new Set(stops.filter(s=>!s._locked).map(', to: 'const ids=[...new Set(stops.map(' } },
  owner_adds_to_handed: { file: RA, from: 'if(added.length && !isBoss(me) && handedOver){', to: 'if(false){' },
  archived_still_grants: { file: RR, from: '(rs || []).filter(r => !r.archived_at)', to: '(rs || [])' },
  visit_recipients_all_contacts: { file: RR, from: "if(!rid){\n    for(const x of (c || [])) if(verifiedContact(x)) allowed.add(low(x.email));\n  } else {", to: "for(const x of (c || [])) if(verifiedContact(x)) allowed.add(low(x.email));\n  if(!rid){\n  } else {" },
  typed_attendee_allowed: { file: RR, from: 'if(status !== "unverified") allowed.add(email);', to: 'allowed.add(email);' },
  self_added_verified: { file: RR, from: 'EMAIL.test(low(x.email)) && !self.has(String(x.id));', to: 'EMAIL.test(low(x.email));' },
  approval_any_visit: { file: RR, from: 'const approved = new Set(rid ? approvedOf(rep && rep[0] && rep[0].summary) : []);', to: 'const approved = new Set(rid ? approvedOf(rep && rep[0] && rep[0].summary) : []); for(const x of (p || [])) approved.add(low(x.email_snapshot));' },
  rep_approves: { file: RA, from: 'if(!boss) return json(403,{error:"President only"});\n        const email=String(b.email', to: 'const email=String(b.email' },
  approve_non_attendee: { file: RA, from: 'if(!(parts||[]).some(x=>String(x.email_snapshot||"").trim().toLowerCase()===email))', to: 'if(false)' },
  approve_no_reason: { file: RA, from: 'if(reason.length<3) return json(400', to: 'if(false) return json(400' },
  rep_forges_approval: { file: RA, from: 'approved_recipients:(r.summary&&Array.isArray(r.summary.approved_recipients))?r.summary.approved_recipients:[],', to: 'approved_recipients:(b.summary&&b.summary.approved_recipients)||[],' },
  assign_no_review: { file: RA, from: 'if(b.review||String(b.review_code||"")!==reviewCode){', to: 'if(b.review){' },
  review_ignores_stops: { file: RA, from: 'JSON.stringify([id,email,stopsNow.map(x=>String(x.dealer_id))])', to: 'JSON.stringify([id,email])' },
  locked_keeps_visit: { file: RA, from: 'visit:x.visit?{status:x.visit.status||null}:null, locked:true,', to: 'locked:true,' },
  followup_not_own_visit: { file: RA, from: '"visit_email_save","generate_followup","send_followup"]);', to: '"visit_email_save"]);' },
  send_any_recipient: { file: ES, from: 'const strangers=[to].concat(cc.map(x=>x.toLowerCase())).filter(a=>!allowed.has(a));', to: 'const strangers=[];' },
  send_any_route: { file: ES, from: '&& await RR.authorizedRoute(me.email, route, sbGet)) grant={kind:"route"};', to: ') grant={kind:"route"};' },
  ai_full_context: { file: AI, from: 'const ctx=visitOnly\n', to: 'const ctx=false\n' },
  ai_any_template: { file: AI, from: 'if(tk==="visit_followup" && b.visit_report_id){', to: 'if(b.visit_report_id){' },
  prep_unfiltered: { file: RC, from: 'prepIds=prepIds.filter(id=>!no.has(id));', to: ';' },
};
const TABLE = path.join(__dirname, 'sr-access.mutants.table.json');
require('fs').writeFileSync(TABLE, JSON.stringify(M));
const tablePath = TABLE.replace(/\.json$/, '.js');
require('fs').writeFileSync(tablePath, 'module.exports=' + JSON.stringify(M) + ';\n');
let killed = 0, total = 0; const bad = [];
for (const [name, m] of Object.entries(M)) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'sr-access.test.js')], { env: Object.assign({}, process.env, { P0_MUTANT: name, P0_MUTANT_TABLE: tablePath }), encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (/MUTANT ANCHOR NOT FOUND/.test(out)) { bad.push(name + ' (anchor)'); console.log('ANCHOR?  ' + name); continue; }
  const f = (out.match(/(\d+) failed/) || [])[1]; const dead = !f || +f > 0;
  if (m.control) { console.log((dead ? 'CONTROL DIED ' : 'control survived ') + name); if (dead) bad.push(name); continue; }
  total++; if (dead) { killed++; console.log('killed   ' + name); } else { bad.push(name); console.log('SURVIVED ' + name); }
}
require('fs').unlinkSync(TABLE); require('fs').unlinkSync(tablePath);
console.log(`\n${killed}/${total} killed${bad.length ? ', problems: ' + bad.join(', ') : ''}`);
process.exitCode = bad.length ? 1 : 0;

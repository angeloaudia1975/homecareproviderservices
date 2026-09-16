/* Mutation harness for who a heads-up or follow-up reaches.

   Every mutant here still sends an email. That is the point: the failures worth guarding against
   are the ones that look exactly like success — a contact missing from the list nobody notices is
   missing, a copy quietly dropped, a typo swallowed, a greeting left addressed to the wrong
   person, an address offered that cannot be written to.

   Three sources are mutated: the list the server sends down, the picker in the field app, and the
   copy handling at the point of send. Every anchor must occur exactly once in its own file.
   CONTROL is a genuine no-op and must SURVIVE; if it dies the harness is failing everything. */
const fs = require('fs');
const suite = require('./recipients.test');

const apiSrc  = fs.readFileSync(suite.API, 'utf8');
const pageSrc = fs.readFileSync(suite.PAGE, 'utf8');
const mailSrc = fs.readFileSync(suite.MAIL, 'utf8');

const MUTANTS = [
  { name: 'CONTROL — a comment, changing nothing', where: 'api',
    from: '  const seen=new Set(), out=[];',
    to:   '  const seen=new Set(), out=[]; /* control */',
    expect: 'survive' },

  // --- the list the server sends down
  { name: 'send down only the first contact again, which is the original complaint', where: 'api',
    from: '  (contacts||[]).forEach(c=>{ if(c) add(c.name, c.email, c.title||c.role, "contact"); });',
    to:   '  [(contacts||[])[0]].forEach(c=>{ if(c) add(c.name, c.email, c.title||c.role, "contact"); });' },

  { name: 'offer the shared account inbox above the named buyer', where: 'api',
    from: '  (contacts||[]).forEach(c=>{ if(c) add(c.name, c.email, c.title||c.role, "contact"); });\n  if(dealer) add(dealer.contact_name, dealer.email, "", "account");',
    to:   '  if(dealer) add(dealer.contact_name, dealer.email, "", "account");\n  (contacts||[]).forEach(c=>{ if(c) add(c.name, c.email, c.title||c.role, "contact"); });' },

  { name: 'list contacts that have no usable address', where: 'api',
    from: '    if(!EMAIL_RE.test(e)) return;',
    to:   '    if(false) return;' },

  { name: 'stop collapsing the same person on the contact row and the account', where: 'api',
    from: '    const k=e.toLowerCase(); if(seen.has(k)) return; seen.add(k);',
    to:   '    const k=e.toLowerCase();' },

  { name: 'drop the account fallback, so an account with no contact rows has nobody', where: 'api',
    from: '  if(dealer) add(dealer.contact_name, dealer.email, "", "account");',
    to:   '  ;' },

  { name: 'stop marking which entry is the account inbox', where: 'api',
    from: '  if(dealer) add(dealer.contact_name, dealer.email, "", "account");',
    to:   '  if(dealer) add(dealer.contact_name, dealer.email, "", "contact");' },

  // --- the picker in the field app
  { name: 'leave an offline cached day with an empty picker', where: 'page',
    from: '  const e=String((s&&s.contact_email)||"").trim();\n  return e?[{name:String((s&&s.contact_name)||"").trim(),email:e,title:"",source:"contact"}]:[];',
    to:   '  return [];' },

  { name: 'prefer the old single address over the list when both are there', where: 'page',
    from: '  if(list.length) return list;',
    to:   '  if(false) return list;' },

  { name: 'only split typed addresses on commas', where: 'page',
    from: '  return String(text==null?"":text).replace(/[<>]/g," ").split(/[,;\\s]+/).map(x=>x.trim()).filter(Boolean);',
    to:   '  return String(text==null?"":text).split(/,/).map(x=>x.trim()).filter(Boolean);' },

  { name: 'SWALLOW A MISTYPED ADDRESS instead of reporting it', where: 'page',
    from: '    if(!RCPT_RE.test(a)){ bad.push(a); return; }',
    to:   '    if(!RCPT_RE.test(a)){ return; }' },

  { name: 'accept anything as an address, so a typo reaches Outlook', where: 'page',
    from: '    if(!RCPT_RE.test(a)){ bad.push(a); return; }',
    to:   '    if(false){ bad.push(a); return; }' },

  { name: 'put everyone in To, so nobody is the person being written to', where: 'page',
    from: '  return { to:good[0]||"", cc:good.slice(1), bad:bad };',
    to:   '  return { to:good.join(","), cc:[], bad:bad };' },

  { name: 'send only to the first person picked and drop the rest', where: 'page',
    from: '  return { to:good[0]||"", cc:good.slice(1), bad:bad };',
    to:   '  return { to:good[0]||"", cc:[], bad:bad };' },

  { name: 'stop collapsing a repeated address, so someone is written to twice', where: 'page',
    from: '    const k=a.toLowerCase(); if(seen.has(k)) return; seen.add(k);',
    to:   '    const k=a.toLowerCase();' },

  // --- the greeting
  { name: 'leave the greeting addressed to whoever was drafted first', where: 'page',
    from: '  return String(body==null?"":body).replace(/^(\\s*)Hi [^,\\n]{1,40},/, (m,lead)=>lead+"Hi "+first+",");',
    to:   '  return body;' },

  { name: 'rewrite EVERY "Hi <name>," in the body, not just the greeting', where: 'page',
    from: '  return String(body==null?"":body).replace(/^(\\s*)Hi [^,\\n]{1,40},/, (m,lead)=>lead+"Hi "+first+",");',
    to:   '  return String(body==null?"":body).replace(/Hi [^,\\n]{1,40},/g, ()=>"Hi "+first+",");' },

  { name: 'insert the name through a replacement string, where "$&" is an instruction', where: 'page',
    from: '  return String(body==null?"":body).replace(/^(\\s*)Hi [^,\\n]{1,40},/, (m,lead)=>lead+"Hi "+first+",");',
    to:   '  return String(body==null?"":body).replace(/^(\\s*)Hi [^,\\n]{1,40},/, "$1Hi "+first+",");' },

  { name: 'greet with the full name rather than the first name', where: 'page',
    from: '  const first=String(name==null?"":name).trim().split(/\\s+/)[0]||"";',
    to:   '  const first=String(name==null?"":name).trim();' },

  // --- the send
  { name: 'let a malformed copy through to Graph, failing the whole send', where: 'mail',
    from: "        if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(a)) return false;",
    to:   "        if(false) return false;" },

  { name: 'copy the recipient on their own email', where: 'mail',
    from: "      const ccSeen=new Set([String(b.to||\"\").trim().toLowerCase()]);",
    to:   "      const ccSeen=new Set();" },

  { name: 'stop collapsing a repeated copy', where: 'mail',
    from: "        const k=a.toLowerCase(); if(ccSeen.has(k)) return false; ccSeen.add(k); return true;",
    to:   "        return true;" },
];

const SOURCES = { api: apiSrc, page: pageSrc, mail: mailSrc };
let bad = 0;
console.log('mutant                                                              src  anchors  result');
console.log('-'.repeat(96));

for(const m of MUTANTS){
  const src = SOURCES[m.where];
  const hits = src.split(m.from).length - 1;
  if(hits !== 1){
    console.log(m.name.padEnd(64) + m.where.padStart(5) + String(hits).padStart(9) + '   ANCHOR NOT UNIQUE — mutant is meaningless');
    bad++; continue;
  }
  const mutated = src.replace(m.from, m.to);
  const args = { api: [mutated, pageSrc, mailSrc], page: [apiSrc, mutated, mailSrc], mail: [apiSrc, pageSrc, mutated] }[m.where];
  let r;
  try { r = suite.run.apply(null, args); }
  catch(e){ r = { pass: 0, fail: -1, report: 'threw: ' + e.message }; }

  const survived = r.fail === 0;
  const wantSurvive = m.expect === 'survive';
  if(survived !== wantSurvive) bad++;

  const verdict = survived
    ? (wantSurvive ? 'survived (correct — no-op)' : 'SURVIVED — untested behaviour')
    : (wantSurvive ? 'KILLED — harness is broken' : 'killed by ' + r.fail + ' test(s)');
  console.log(m.name.padEnd(64) + m.where.padStart(5) + String(hits).padStart(9) + '   ' + verdict);
}

console.log('-'.repeat(96));
console.log(bad === 0
  ? 'All mutants behaved as required (control survived, every real mutant killed).'
  : bad + ' mutant(s) did not behave as required.');
process.exit(bad ? 1 : 0);

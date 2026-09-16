/* Who a heads-up or a follow-up is sent to — behaviour suite.
   Lifts the real functions out of routes-api.js, scheduled-routes.html and email-sync-api.js and
   runs them.

   These decide which addresses a real email reaches. The failure they exist for is not a crash:
   before this, every stop carried exactly one address — whichever contact row came back first —
   so an account where three people deal with us could only ever be written to at one of them, and
   a rep who wanted anyone else had to remember the address and type it into a single box.

   The dangerous direction is silence. An address quietly dropped, a typo quietly ignored, a
   greeting left addressed to the wrong person: each one looks like a sent email. */
const fs = require('fs');
const path = require('path');

const API  = process.env.ROUTES_API || path.join(__dirname, '..', 'netlify', 'functions', 'routes-api.js');
const PAGE = process.env.ROUTES_HTML || path.join(__dirname, '..', 'src', 'admin', 'scheduled-routes.html');
const MAIL = process.env.EMAIL_API || path.join(__dirname, '..', 'netlify', 'functions', 'email-sync-api.js');

function lift(src, name){
  const anchor = 'function ' + name + '(';
  const at = src.indexOf(anchor);
  if(at < 0) throw new Error('anchor not found: ' + name);
  if(src.indexOf(anchor, at + 1) >= 0) throw new Error('anchor not unique: ' + name);
  let i = src.indexOf('{', at), depth = 0, end = -1;
  for(; i < src.length; i++){
    const c = src[i];
    if(c === '{') depth++;
    else if(c === '}'){ depth--; if(depth === 0){ end = i + 1; break; } }
  }
  if(end < 0) throw new Error('unbalanced braces: ' + name);
  return src.slice(at, end);
}
function constLine(src, name, where){
  const re = new RegExp('const ' + name + '\\s*=\\s*[^\\n]*;');
  const m = re.exec(src);
  if(!m) throw new Error(name + ' not found in ' + where);
  return m[0];
}

/* The Cc hardening in email-sync-api is inline in the handler, not a function, so the suite runs
   the real lines rather than a paraphrase of them: they are lifted verbatim and wrapped. */
function ccFilterFrom(src){
  const start = src.indexOf('const ccSeen=new Set(');
  if(start < 0) throw new Error('the cc filter is gone from email-sync-api.js');
  const end = src.indexOf('});', start);
  if(end < 0) throw new Error('could not read the end of the cc filter');
  const body = src.slice(start, end + 3);
  return new Function('b', body + '\n return cc;');
}

function load(apiSrc, pageSrc, mailSrc){
  const api  = apiSrc  !== undefined ? apiSrc  : fs.readFileSync(API, 'utf8');
  const page = pageSrc !== undefined ? pageSrc : fs.readFileSync(PAGE, 'utf8');
  const mail = mailSrc !== undefined ? mailSrc : fs.readFileSync(MAIL, 'utf8');
  const js = constLine(api, 'EMAIL_RE', 'routes-api.js') + '\n' + lift(api, 'stopRecipients') + '\n'
           + constLine(page, 'RCPT_RE', 'scheduled-routes.html') + '\n'
           + lift(page, 'recipientRows') + '\n' + lift(page, 'parseEmails') + '\n'
           + lift(page, 'splitRecipients') + '\n' + lift(page, 'swapGreeting') + '\n'
           + 'module.exports={stopRecipients,recipientRows,parseEmails,splitRecipients,swapGreeting};';
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  mod.exports.ccFilter = ccFilterFrom(mail);
  return mod.exports;
}

let pass = 0, fail = 0;
const out = [];
function t(name, fn){
  try { fn(); pass++; out.push('  ok   ' + name); }
  catch(e){ fail++; out.push('  FAIL ' + name + '\n         ' + e.message); }
}
function eq(a, b, what){
  if(JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((what || 'value') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}
function ok(v, msg){ if(!v) throw new Error(msg || 'expected truthy'); }

function run(apiSrc, pageSrc, mailSrc){
  const M = load(apiSrc, pageSrc, mailSrc);
  pass = 0; fail = 0; out.length = 0;
  const emails = l => l.map(x => x.email);

  /* ---- the list the server sends down ------------------------------------- */
  t('THE ONE THAT STARTED THIS — every contact comes down, not just the first', () => {
    const l = M.stopRecipients([
      { name: 'Bryant Boston', email: 'bryant@glasgowrx.com', title: 'Owner' },
      { name: 'Stacey Wilson', email: 'stacey@glasgowrx.com', title: 'Buyer' },
      { name: 'Pat Reed', email: 'billing@glasgowrx.com', role: 'Billing' },
    ], { contact_name: 'Front desk', email: 'info@glasgowrx.com' });
    eq(emails(l), ['bryant@glasgowrx.com', 'stacey@glasgowrx.com', 'billing@glasgowrx.com', 'info@glasgowrx.com'], 'list');
    eq(l[2].title, 'Billing', 'role stands in for a missing title');
  });

  t('the account address comes last and says what it is', () => {
    /* A named buyer must be offered above a shared inbox — the other way round is how a personal
       note ends up read by whoever happens to open info@. */
    const l = M.stopRecipients([{ name: 'Stacey', email: 'stacey@x.com' }], { email: 'info@x.com' });
    eq(emails(l), ['stacey@x.com', 'info@x.com'], 'order');
    eq([l[0].source, l[1].source], ['contact', 'account'], 'sources');
  });

  t('a contact with no address is left out rather than shown and unusable', () => {
    const l = M.stopRecipients([
      { name: 'No Email', email: '' }, { name: 'Bad', email: 'not-an-address' },
      { name: 'Real', email: 'real@x.com' },
    ], null);
    eq(emails(l), ['real@x.com'], 'only the usable one');
  });

  t('the same person on the contact row and the account is one entry', () => {
    const l = M.stopRecipients([{ name: 'Stacey', email: 'Stacey@X.com' }], { email: 'stacey@x.com' });
    eq(emails(l), ['Stacey@X.com'], 'deduped, keeping the first spelling');
  });

  t('an account with nothing on file yields an empty list, not a fake entry', () => {
    eq(M.stopRecipients([], { email: '' }), [], 'empty');
    eq(M.stopRecipients(null, null), [], 'nothing at all');
  });

  /* ---- the picker in the field app ---------------------------------------- */
  t('A DAY CACHED BEFORE THIS SHIPPED STILL HAS A RECIPIENT', () => {
    /* The app runs offline from a cached day. If an old cache meant an empty picker, the rep
       would be standing in the shop unable to send anything at all. */
    const rows = M.recipientRows({ contact_name: 'Bryant Boston', contact_email: 'bryant@glasgowrx.com' });
    eq(rows.length, 1, 'one row');
    eq(rows[0].email, 'bryant@glasgowrx.com', 'from the single address the old cache carries');
  });

  t('the new list wins over the single address when both are present', () => {
    const rows = M.recipientRows({ contact_email: 'old@x.com',
      contacts: [{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'b@x.com' }] });
    eq(emails(rows), ['a@x.com', 'b@x.com'], 'list');
  });

  t('a stop with no address at all gives an empty picker, not a blank row', () => {
    eq(M.recipientRows({}), [], 'nothing');
    eq(M.recipientRows(null), [], 'no stop');
  });

  /* ---- what a person types ------------------------------------------------ */
  t('a typed box accepts the ways people actually type addresses', () => {
    eq(M.parseEmails('a@x.com, b@x.com'), ['a@x.com', 'b@x.com'], 'commas');
    eq(M.parseEmails('a@x.com; b@x.com'), ['a@x.com', 'b@x.com'], 'semicolons');
    eq(M.parseEmails('a@x.com b@x.com'), ['a@x.com', 'b@x.com'], 'spaces');
    eq(M.parseEmails('Stacey Wilson <stacey@x.com>'), ['Stacey', 'Wilson', 'stacey@x.com'], 'a pasted pair');
    eq(M.parseEmails('   '), [], 'blank');
    eq(M.parseEmails(null), [], 'nothing');
  });

  /* ---- who ends up in To and who in Cc ------------------------------------ */
  t('THE FIRST PICKED IS THE To, THE REST ARE COPIED', () => {
    const r = M.splitRecipients(['stacey@x.com', 'bryant@x.com', 'billing@x.com']);
    eq(r.to, 'stacey@x.com', 'to');
    eq(r.cc, ['bryant@x.com', 'billing@x.com'], 'cc');
    eq(r.bad, [], 'nothing rejected');
  });

  t('one person is a plain email with nobody copied', () => {
    const r = M.splitRecipients(['stacey@x.com']);
    eq([r.to, r.cc.length], ['stacey@x.com', 0], 'single');
  });

  t('A TYPO IS REPORTED, NEVER SILENTLY DROPPED', () => {
    /* Dropping it would send the email and let the rep believe it reached someone it never did. */
    const r = M.splitRecipients(['stacey@x.com', 'bryant@x', 'billing@x.com']);
    eq(r.to, 'stacey@x.com', 'to');
    eq(r.cc, ['billing@x.com'], 'the good ones still go');
    eq(r.bad, ['bryant@x'], 'and the bad one is handed back to be shown');
  });

  t('the same address twice is one recipient, whatever the case', () => {
    const r = M.splitRecipients(['Stacey@X.com', 'stacey@x.com', 'STACEY@x.COM']);
    eq([r.to, r.cc.length], ['Stacey@X.com', 0], 'collapsed');
  });

  t('nothing picked is not a send', () => {
    eq(M.splitRecipients([]).to, '', 'empty');
    eq(M.splitRecipients(['', '   ']).to, '', 'blanks');
    eq(M.splitRecipients(null).to, '', 'nothing');
  });

  /* ---- the greeting ------------------------------------------------------- */
  t('THE GREETING FOLLOWS WHO IT IS ADDRESSED TO', () => {
    const body = 'Hi Bryant,\n\nThis is Angelo Audia with HomeCare Provider Services.';
    eq(M.swapGreeting(body, 'Stacey Wilson'),
       'Hi Stacey,\n\nThis is Angelo Audia with HomeCare Provider Services.', 'swapped');
  });

  t('only the greeting line changes — never the body the rep wrote', () => {
    const body = 'Hi Bryant,\n\nStacey asked about the Hi Bryant, order last week.';
    const outp = M.swapGreeting(body, 'Stacey');
    ok(outp.indexOf('Stacey asked about the Hi Bryant, order') >= 0, 'the body was rewritten too');
    eq(outp.split('\n')[0], 'Hi Stacey,', 'first line');
  });

  t('a body with no greeting is left completely alone', () => {
    const body = 'Following up on this morning — I will send the pricing over.';
    eq(M.swapGreeting(body, 'Stacey'), body, 'untouched');
  });

  t('an address with no name behind it leaves the greeting as drafted', () => {
    const body = 'Hi Bryant,\n\nthanks again.';
    eq(M.swapGreeting(body, ''), body, 'empty name');
    eq(M.swapGreeting(body, '   '), body, 'blank name');
  });

  t('a name that looks like a regex replacement is written literally', () => {
    // "$&" in a replacement string means "the whole match"; as a name it means a person.
    eq(M.swapGreeting('Hi Bryant,\n\nx', '$& Jones').split('\n')[0], 'Hi $&,', 'literal');
  });

  /* ---- the send itself ---------------------------------------------------- */
  t('A MISTYPED COPY CANNOT FAIL THE WHOLE SEND', () => {
    /* Graph rejects the entire message if one ccRecipient is malformed, and the rep is told the
       email did not go with no hint that a colleague's address is why. */
    eq(M.ccFilter({ to: 'stacey@x.com', cc: ['bryant@x.com', 'nonsense', 'billing@x.com'] }),
       ['bryant@x.com', 'billing@x.com'], 'the usable copies still go');
  });

  t('the recipient is never also copied to themselves', () => {
    eq(M.ccFilter({ to: 'Stacey@X.com', cc: ['stacey@x.com', 'bryant@x.com'] }), ['bryant@x.com'], 'de-duped against to');
  });

  t('the same copy twice is one copy', () => {
    eq(M.ccFilter({ to: 'a@x.com', cc: ['b@x.com', 'B@X.com'] }), ['b@x.com'], 'collapsed');
  });

  t('no copies at all is an empty list, not a crash', () => {
    eq(M.ccFilter({ to: 'a@x.com' }), [], 'missing');
    eq(M.ccFilter({ to: 'a@x.com', cc: null }), [], 'null');
    eq(M.ccFilter({ to: 'a@x.com', cc: 'b@x.com' }), [], 'a string is not a list');
  });

  return { pass, fail, report: out.join('\n') };
}

module.exports = { run, load, lift, API, PAGE, MAIL };

if(require.main === module){
  const r = run();
  console.log(r.report);
  console.log('\n' + r.pass + ' passed, ' + r.fail + ' failed');
  process.exit(r.fail ? 1 : 0);
}

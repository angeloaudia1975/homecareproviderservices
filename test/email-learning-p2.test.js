/* HCPS Smart Email Learning, Phase 2 — learning, end to end through the REAL handlers on the mock world (synthetic data only).
   - the analyser is pure code: masks names, dealers, dates, numbers, addresses; suggests only 3+ sends across 2+ dealers
   - "Look for patterns" records suggestions only; it never decides, never calls an AI service or any outside address
   - only the President decides, as the verified sign-in (never a name in the request), with a reason, from the current version
   - versions, rollback and reset through the owner page API; refusals map to clear HTTP answers
   - approved rules change no email in Phase 2: no generator reads them
   - the daily job learns only while email_learning_suggest is exactly true
     node test/email-learning-p2.test.js */
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
const FAKE = require('./email-learning-p2.fake');
const L = load('_email_learn.js', createWorld(standardSeed({})));   // through the mock loader, so mutants reach it

const D = ['0a0a0a0a-0000-4000-8000-00000000000a', '0b0b0b0b-0000-4000-8000-00000000000b', '0c0c0c0c-0000-4000-8000-00000000000c'];
const NAMES = ['Sampletown Medical', 'Exampleville Pharmacy', 'Testburg Home Care'];
let n = 0;
const uid = () => `${String(++n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
// One synthetic edited send. The owner deletes the "hope" line, rewrites the closing and changes the greeting.
function edited(i, o) {
  const dn = NAMES[i % 3], who = ['Pat', 'Lee', 'Kim'][i % 3];
  return Object.assign({ id: uid(), email_type: 'previsit_headsup', dealer_id: D[i % 3], sent_at: `2026-10-${String(10 + i).padStart(2, '0')}T15:00:00Z`, edited: true,
    content_purged_at: null, created_at: '2026-10-01T10:00:00Z', author_email: 'angelo@hcps.us', template: 'previsit', generator: 'routes-api',
    original_subject: `HCPS will be in your area — Tuesday, March ${i + 3}`, sent_subject: `HCPS will be in your area — Tuesday, March ${i + 3}`,
    original_body: `Hi ${who},\n\nI hope this email finds you well. I will be at ${dn} on Tuesday, March ${i + 3} around 10:30 am to walk through the new lift chairs. Please let me know if you have any questions.\n\nSam Rep\nHCPS`,
    sent_body: `Good morning ${who},\n\nI will be at ${dn} on Tuesday, March ${i + 3} around 10:30 am to walk through the new lift chairs. Want me to bring the fall catalog?\n\nSam Rep\nHCPS` }, o || {});
}
function world(opts) {
  opts = opts || {};
  const S = standardSeed({
    dealers: D.map((id, i) => ({ id, business_name: NAMES[i], rep_name: 'Angelo Audia', parent_id: null, state: 'TN' })),
    app_settings: [{ key: 'phase2_flags', value: Object.assign({ email_learning_capture: true }, opts.flags || {}) }],
    email_drafts: opts.drafts || [], email_learning_rules: [], email_learning_profiles: [], email_learning_rule_events: [],
  });
  S.rpc = FAKE.rpc();
  if (opts.missing) S.missingTables = ['email_learning_rules', 'email_learning_profiles', 'email_learning_rule_events'];
  return { S, w: createWorld(S) };
}
// A decision carries the status the owner sees on screen (taken from the world unless the test sets it).
const api = (w, b, token) => {
  if (b && b.action === 'decide' && !('expected_status' in b)) { const r = ((w.db && w.db.email_learning_rules) || []).find(x => x.id === b.rule_id); b = Object.assign({}, b, { expected_status: r ? r.status : 'suggested' }); }
  return call(load('email-learning-api.js', w), b, { token: token || 'pres' });
};

(async () => {
  // ── the analyser (pure) ─────────────────────────────────────────────────
  await t('masking: names, dealer, dates, times, phone, email, link, money and numbers never survive', () => {
    const m = L.mask('Hi Pat Smith, call 615-555-0100 or pat@sampletown.test about $1,250 on March 3rd at 10:30 am — see www.example.test and ask Jennifer at Sampletown Medical about 12 chairs.', { dealer: 'Sampletown Medical' });
    for (const bad of ['Pat', 'Smith', '615', 'pat@', '1,250', 'March', '10:30', 'www.', 'Jennifer', 'Sampletown', '12']) assert.ok(!m.includes(bad), bad + ' in ' + m);
    for (const ph of ['{name}', '{phone}', '{email}', '{amount}', '{date}', '{time}', '{link}', '{dealer}', '{number}']) assert.ok(m.includes(ph), ph + ' missing in ' + m);
    assert.ok(/Tuesday/.test(L.mask('Ask about the catalog on Tuesday.')), 'weekdays stay');
  });
  await t('masking: names at the start of a sentence, after titles or ":", in lowercase, other dealers, bare domains, spelled-out addresses', () => {
    const cases = [['Pat Jones asked about the chair.', ['Pat', 'Jones']], ['Tom liked the demo.', ['Tom']], ['Mr. Smith will stop by.', ['Smith']],
      ['Ask for Dr. Lee.', ['Lee']], ['Contact: Mary Baker can help.', ['Mary', 'Baker']], ['Williams Brothers liked it.', ['Williams', 'Brothers']],
      ['Golden Rule Pharmacy wants a demo.', ['Golden', 'Rule', 'Pharmacy']], ['Visit acmemedical.com today.', ['acmemedical']], ['Write bob at acme dot com.', ['bob', 'acme']]];
    for (const [txt, bad] of cases) { const m = L.mask(txt); for (const b of bad) assert.ok(!m.includes(b), `${b} survives in "${m}"`); }
    assert.ok(!/pat/i.test(L.mask('thanks pat', { names: ['Pat'] })));
    const e = L.editsOf({ original_body: 'Hi pat,\n\nI will be there.', sent_body: 'Hi pat,\n\nI will be there. thanks pat, see you soon!', original_subject: 'a', sent_subject: 'a' }, {});
    const vals = JSON.stringify(e.map(x => Object.values(x.pattern))); assert.ok(!/pat/i.test(vals), 'the greeted name is masked in any case: ' + vals);
    for (const ok of ['Please let me know if you have any questions.', 'I hope this email finds you well.', 'Thanks again for your time.'])
      assert.strictEqual(L.mask(ok), ok, 'ordinary sentences stay readable');
  });
  await t('safe evidence: a digit or "@" left after masking, or only placeholders, is never kept', () => {
    assert.ok(L.safePhrase('I hope this email finds you well'));
    for (const s of ['Room 4B', 'see you in room 4b today', 'write to x@y', 'x@y', '{name} {date}', 'ok', 'a'.repeat(201)]) assert.ok(!L.safePhrase(s), s);
  });
  await t('masking over-masks: names after "(", quotes, dashes, "/", a comma with no space, other alphabets; spelled-out and unusual addresses', () => {
    const cases = [['Please ask for (Sarah) at the front desk.', /Sarah/], ['Thanks,Pat for the help.', /Pat/], ['Our rep —Sarah— will call.', /Sarah/],
      ['Talk to Bob/Alice tomorrow.', /Bob|Alice/], ['Say hi to “Golden Rule” for me.', /Golden|Rule/], ['Ask José or Émile at the desk.', /Jos|mile|é|É/],
      ['Write to pat(at)acme(dot)com today.', /pat|acme/], ['Write to pat [at] acme [dot] ai today.', /pat|acme/], ['See acmemedical.ai for details.', /acme/],
      ["Ask for 'Greg' when you call.", /Greg/], ['Talk to Mr.Smith soon.', /Smith/], ['Ask for O’Brien at the front.', /Brien/]];
    for (const [x, leak] of cases) { const m = L.mask(x, { dealer: 'Golden Rule Pharmacy' }); assert.ok(!leak.test(m), x + ' → ' + m); }
    // other character forms: full-width digits and "＠", "_at_" / "-at-", the ideographic full stop, a zero-width space in a name
    for (const [x, leak] of [['Call ５５５-１２３-４５６７ or email pat＠acme.com anytime.', /[５１２３４６７＠]|pat|acme|\d/], ['Write pat _at_ acme _dot_ com today.', /pat|acme/],
      ['Write pat -at- acme -dot- com today.', /pat|acme/], ['See acme。com for more.', /acme/], ['Write pat｛at｝acme｛dot｝com.', /pat|acme/], ['Ask Sa\u200brah at the desk.', /Sa|rah/]]) {
      const m = L.mask(x); assert.ok(!leak.test(m), x + ' → ' + m);
    }
    for (const x of ['Call ５５５ today please.', 'Mail pat＠acme please.', 'Ask for Ρat soon.', 'Call me ①②③ soon.']) assert.ok(!L.safePhrase(x), x);
    assert.ok(L.safePhrase(L.mask("As discussed, I've attached the sheet.")) && /I've/.test(L.mask("As discussed, I've attached the sheet.")), 'I\'ve is not a name');
    for (const x of ['Call ５５５ １２３ ４５６７', 'Write pat＠acme', 'Ask for José']) assert.strictEqual(L.cleanInstruction(x), null, x);
    // fail closed: anything still looking like a name or a non-ASCII letter is never kept as evidence
    for (const x of ['Talk to josé soon.', 'Ask for Zebulon here.', 'Write pat(at)acme']) assert.ok(!L.safePhrase(x), x);
    for (const x of ['Thanks for meeting with us today.', 'Please let me know if you have questions.', 'Hi {name}, thanks for your time.', 'I think {name} will call.'])
      assert.ok(L.safePhrase(L.mask(x)), x);
  });
  await t('the edits of one email: greeting, deleted line, rewritten line', () => {
    const e = L.editsOf(edited(0), { dealer: NAMES[0] }).map(x => x.kind + ':' + JSON.stringify(x.pattern));
    assert.ok(e.some(x => x.startsWith('greeting:') && x.includes('Good morning {name}')), e.join('\n'));
    assert.ok(e.some(x => x.startsWith('remove_phrase:') || x.startsWith('replace_phrase:')), e.join('\n'));
    assert.ok(!e.join(' ').match(/[0-9@]|Pat|Sampletown/), 'masked: ' + e.join(' '));
  });
  await t('threshold: 2 sends — nothing; 3 sends to 1 dealer — nothing; 3 sends to 2 dealers — suggested', () => {
    assert.strictEqual(L.analyze([edited(0), edited(1)]).suggestions.length, 0);
    assert.strictEqual(L.analyze([edited(0), edited(3), edited(6)]).suggestions.length, 0, 'all to dealer 0');
    const r = L.analyze([edited(0), edited(1), edited(3)]);
    assert.ok(r.suggestions.length >= 2); for (const s of r.suggestions) { assert.ok(s.sends >= 3 && s.dealers >= 2); assert.strictEqual(s.email_type, 'previsit_headsup'); }
    assert.ok(!JSON.stringify(r.suggestions.map(s => [s.pattern, s.examples])).match(/[0-9@]/));
  });
  await t('only sent, edited emails with their text count; each email counts once', () => {
    const r = L.analyze([edited(0), edited(1), edited(2, { edited: false }), edited(3, { sent_at: null }), edited(4, { original_body: null, sent_body: null })]);
    assert.strictEqual(r.scanned, 2); assert.strictEqual(r.suggestions.length, 0);
    const dup = edited(0); const r2 = L.analyze([dup, dup, dup, edited(1)]);
    assert.strictEqual(r2.suggestions.length, 0, 'the same email three times is one email');
  });
  await t('the same edit across email types is suggested once for "every type"; keys are stable', () => {
    const mix = [edited(0), edited(1, { email_type: 'visit_followup' }), edited(2, { email_type: 'follow_up' })];
    const r = L.analyze(mix); assert.ok(r.suggestions.length > 0); for (const s of r.suggestions) assert.strictEqual(s.email_type, 'all');
    assert.deepStrictEqual(L.analyze(mix).suggestions.map(s => s.rule_key), r.suggestions.map(s => s.rule_key));
    assert.ok(r.suggestions.every(s => /^[0-9a-f]{32}$/.test(s.rule_key)));
  });
  await t('shorter: a cut of a quarter or more over 3 emails / 2 dealers becomes a length rule', () => {
    const long = 'We have new lift chair models in stock this month and I would like to show you the full range when I visit next week with samples.';
    const e = i => edited(i, { original_body: `Hi Pat,\n\n${long} ${long}\n\nSam`, sent_body: `Hi Pat,\n\n${long}\n\nSam` });
    const s = L.analyze([e(0), e(1), e(2)]).suggestions.find(x => x.kind === 'shorter');
    assert.ok(s && /shorter/.test(s.instruction), JSON.stringify(s));
  });
  await t('owner wording: 3–300 characters, no email address or link', () => {
    assert.strictEqual(L.cleanInstruction('  Keep it   short. '), 'Keep it short.');
    for (const s of ['', 'ok', 'x'.repeat(301), 'Mail me at a@b.test', 'See https://x.test', 'Call 615 555 0100.', 'Mention the $20 fee.', 'Visit on 10/31.'])
      assert.strictEqual(L.cleanInstruction(s), null, s);
    assert.strictEqual(L.cleanInstruction('Keep it shorter — about 30%.'), 'Keep it shorter — about 30%.', 'a percentage is fine');
  });

  // ── owner page API ──────────────────────────────────────────────────────
  const three = () => [edited(0), edited(1), edited(3)];
  await t('only the President: no sign-in 401; Greg and Lori 403 for every learning action', async () => {
    const { w } = world({ drafts: three() });
    assert.strictEqual((await call(load('email-learning-api.js', w), { action: 'rules' }, {})).status, 401);
    for (const tok of ['greg', 'lori']) for (const a of ['rules', 'analyze', 'decide', 'versions', 'rollback'])
      assert.strictEqual((await api(w, { action: a }, tok)).status, 403, tok + ' ' + a);
  });
  await t('"Look for patterns": records suggestions only, with masked evidence; no AI or outside call', async () => {
    const { S, w } = world({ drafts: three() });
    const r = await api(w, { action: 'analyze' });
    assert.strictEqual(r.status, 200); assert.ok(r.body.summary.inserted >= 2, JSON.stringify(r.body));
    assert.ok(w.db.email_learning_rules.every(x => x.status === 'suggested'));
    assert.ok(!JSON.stringify(w.db.email_learning_rules.map(x => [x.pattern, x.examples])).match(/[0-9@]|Pat|Lee|Sampletown|Exampleville/));
    assert.strictEqual(w.outbound.length, 0, 'nothing leaves HCPS: ' + JSON.stringify(w.outbound.map(o => o.kind + ' ' + o.url)));
    assert.strictEqual(w.db.email_learning_profiles.length, 0, 'a suggestion never approves');
    const again = await api(w, { action: 'analyze' });
    assert.strictEqual(again.body.summary.inserted, 0); assert.strictEqual(w.db.email_learning_rules.length, r.body.summary.inserted);
  });
  await t('only the President\'s own emails are learned from (a rep\'s captured drafts never count, even if present)', async () => {
    const greg = [edited(0), edited(1), edited(3)].map(d => Object.assign(d, { author_email: 'greg@hcps.us' }));
    const { w } = world({ drafts: greg });
    const r = await api(w, { action: 'analyze' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.summary.scanned, 0); assert.strictEqual((w.db.email_learning_rules || []).length, 0);
    const mixed = [edited(0), edited(1)].concat([edited(3)].map(d => Object.assign(d, { author_email: 'greg@hcps.us' })));
    const w2 = world({ drafts: mixed }).w; await api(w2, { action: 'analyze' });
    assert.strictEqual((w2.db.email_learning_rules || []).length, 0, 'two of the President\'s + one of Greg\'s is not three');
  });
  await t('a decision without the status on screen is refused before the database', async () => {
    const { w } = world({ drafts: three() }); await api(w, { action: 'analyze' });
    const id = w.db.email_learning_rules[0].id;
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'approve', reason: 'Mine', expected_version: 0, expected_status: '' })).status, 400);
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'approve', reason: 'Mine', expected_version: 0, expected_status: 'approved' })).status, 409, 'stale screen');
    assert.strictEqual(w.db.email_learning_rules[0].status, 'suggested');
  });
  await t('a rejected edit does not come back under another email type', async () => {
    // The edit appears once in each of three types → suggested once for "every type"; the owner rejects it.
    const mix = [edited(0), edited(1, { email_type: 'visit_followup' }), edited(2, { email_type: 'follow_up' })];
    const { w } = world({ drafts: mix });
    await api(w, { action: 'analyze' });
    const all = w.db.email_learning_rules.filter(x => x.email_type === 'all'); assert.ok(all.length > 0);
    let v = 0;
    for (const r of all) { const d = await api(w, { action: 'decide', rule_id: r.id, decision: 'reject', reason: 'Not how I write', expected_version: v }); assert.strictEqual(d.status, 200); }
    // Later the same edits reach 3 sends / 2 dealers inside visit_followup alone.
    w.db.email_drafts.push(edited(4, { email_type: 'visit_followup' }), edited(5, { email_type: 'visit_followup' }), edited(7, { email_type: 'visit_followup' }));
    const r2 = await api(w, { action: 'analyze' });
    assert.strictEqual(r2.body.summary.inserted, 0, JSON.stringify(r2.body.summary)); assert.ok(r2.body.summary.already_decided > 0);
    assert.ok(w.db.email_learning_rules.every(x => x.status === 'rejected'));
  });
  await t('dry run: a preview, nothing written', async () => {
    const { S, w } = world({ drafts: three() });
    const r = await api(w, { action: 'analyze', dry_run: true });
    assert.strictEqual(r.status, 200); assert.ok(r.body.preview.length >= 2); assert.strictEqual(w.db.email_learning_rules.length, 0);
    assert.strictEqual(w.writes.filter(x => x.kind === 'rpc').length, 0);
  });
  await t('decide: the President from the sign-in (a name in the request is ignored), reason required, current version only', async () => {
    const { S, w } = world({ drafts: three() });
    await api(w, { action: 'analyze' });
    const id = w.db.email_learning_rules[0].id;
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'approve', reason: '', expected_version: 0 })).status, 422);
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'nuke', reason: 'Mine', expected_version: 0 })).status, 400);
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'approve', reason: 'Mine', instruction: 'Mail a@b.test', expected_version: 0 })).status, 422);
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'approve', reason: 'Mine', instruction: 'See https://x.test first', expected_version: 0 })).status, 422);
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'approve', reason: 'ok', expected_version: 0 })).status, 422);
    assert.strictEqual(w.writes.filter(x => x.kind === 'rpc' && x.fn === 'hcps_email_rule_decide').length, 0, 'refused before the database');
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'approve', reason: 'Mine', expected_version: 3 })).status, 409);
    const r = await api(w, { action: 'decide', rule_id: id, decision: 'approve', reason: 'This is how I write', by: 'greg@hcps.us', expected_version: 0 });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.version, 1);
    const call1 = w.writes.filter(x => x.kind === 'rpc' && x.fn === 'hcps_email_rule_decide').pop();
    assert.strictEqual(call1.p.by, 'angelo@hcps.us', 'the decider is the sign-in');
    assert.strictEqual(w.db.email_learning_profiles[0].created_by, 'angelo@hcps.us');
    assert.strictEqual((await api(w, { action: 'decide', rule_id: id, decision: 'reject', reason: 'Not mine', expected_version: 1 })).status, 409, 'an approved rule is retired, not rejected');
  });
  await t('versions, reword, retire, rollback and reset through the page API', async () => {
    const { S, w } = world({ drafts: three() });
    await api(w, { action: 'analyze' });
    const [a, b] = w.db.email_learning_rules.map(x => x.id);
    await api(w, { action: 'decide', rule_id: a, decision: 'approve', reason: 'Mine', expected_version: 0 });
    await api(w, { action: 'decide', rule_id: b, decision: 'approve', reason: 'Mine', expected_version: 1 });
    assert.strictEqual((await api(w, { action: 'decide', rule_id: a, decision: 'edit', instruction: 'Skip the pleasantries.', reason: 'Clearer', expected_version: 2 })).body.version, 3);
    assert.strictEqual((await api(w, { action: 'decide', rule_id: b, decision: 'retire', reason: 'Not right', expected_version: 3 })).body.version, 4);
    const v = await api(w, { action: 'versions' });
    assert.strictEqual(v.status, 200); assert.deepStrictEqual(v.body.versions.map(x => x.version), [4, 3, 2, 1]);
    assert.strictEqual((await api(w, { action: 'rollback', to_version: 2, reason: '', expected_version: 4 })).status, 422);
    assert.strictEqual((await api(w, { action: 'rollback', to_version: 2, reason: 'Go back', expected_version: 1 })).status, 409);
    const rb = await api(w, { action: 'rollback', to_version: 2, reason: 'Go back', expected_version: 4 });
    assert.strictEqual(rb.status, 200); assert.strictEqual(rb.body.version, 5);
    assert.strictEqual(w.db.email_learning_rules.filter(x => x.status === 'approved').length, 2);
    const rs = await api(w, { action: 'rollback', to_version: 0, reason: 'Start over', expected_version: 5 });
    assert.strictEqual(rs.status, 200); assert.strictEqual(rs.body.status, 'reset');
    assert.strictEqual(w.db.email_learning_rules.filter(x => x.status === 'approved').length, 0);
    const st = await api(w, { action: 'status' });
    assert.strictEqual(st.body.learning.version, 6); assert.strictEqual(st.body.learning.applied_to_emails, false);
  });
  await t('before the Phase 2 migration: status says not installed; learning actions 503; Phase 1 still works', async () => {
    const { w } = world({ drafts: three(), missing: true });
    const s = await api(w, { action: 'status' });
    assert.strictEqual(s.status, 200); assert.strictEqual(s.body.learning.installed, false);
    for (const a of ['rules', 'analyze', 'versions']) assert.strictEqual((await api(w, { action: a })).status, 503, a);
    assert.strictEqual((await api(w, { action: 'list' })).status, 200);
  });
  await t('daily job: learns only while email_learning_suggest is exactly true', async () => {
    for (const [flags, expect] of [[{}, 0], [{ email_learning_suggest: 'true' }, 0], [{ email_learning_suggest: 1 }, 0], [{ email_learning_suggest: true }, 1]]) {
      const { S, w } = world({ drafts: three(), flags });
      S.rpc.hcps_email_draft_purge_expired = () => ({ status: 200, body: 0 });
      const r = await load('email-learning-purge-cron.js', w).handler({});
      assert.strictEqual(r.statusCode, 200, r.body);
      assert.strictEqual(w.db.email_learning_rules.length > 0 ? 1 : 0, expect, JSON.stringify(flags) + ' ' + r.body);
      assert.ok(w.db.email_learning_rules.every(x => x.status === 'suggested'));
    }
  });
  await t('Phase 2 applies nothing: no generator, editor or send path reads the learned rules', () => {
    const fn = f => fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', f), 'utf8');
    for (const f of ['ai-email-api.js', 'routes-api.js', 'email-sync-api.js', 'campaign-api.js', '_ai_style.js', '_email_learning.js'])
      assert.ok(!/email_learning_rules|email_learning_profiles|_email_learn(?:_run)?\.js/.test(fn(f)), f);
  });
  done('Email learning P2');
})().catch(e => { console.log('CRASH', e); process.exitCode = 1; });

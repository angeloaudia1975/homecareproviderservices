/* HCPS Smart Email Learning, Phase 3 part 1 — _email_rules_apply.js (synthetic data only).
   Proves: off unless the switch is exactly true AND the draft is the ACTIVE President's (re-checked in staff_users); the
   current numbered version's snapshot is what applies; the type's own rules first, then "every type"; at most 2 masked
   examples; wording that is not plain text (digits except a percentage, "@", links, other characters) is left out; a
   retired rule is left out; any read failure = not applied, never an error; the style guide stays first and wins; and no
   email generator uses this module yet.
     node test/email-learning-p3.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
// Loaded through the mutant-aware loader (phase0-mock), so test/email-learning.mutants.js can break it in memory.
const { load } = require('./phase0-mock');
const A = load('_email_rules_apply.js', { fetch: async () => { throw new Error('no network in this test'); } });

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }

const R1 = '0a000000-0000-4000-8000-000000000001', R2 = '0a000000-0000-4000-8000-000000000002', R3 = '0a000000-0000-4000-8000-000000000003';
const PRES = { email: 'owner@hcps.test', role: 'president' };
function world(o) {
  o = o || {};
  const db = {
    staff_users: o.staff || [{ email: 'owner@hcps.test', role: 'president', active: true }, { email: 'greg@hcps.test', role: 'rep', active: true }],
    email_learning_profiles: o.versions || [
      { version: 1, rules: [{ id: R1, email_type: 'previsit_headsup', kind: 'remove_phrase', instruction: 'Old wording.' }] },
      { version: 2, rules: [
        { id: R1, email_type: 'previsit_headsup', kind: 'remove_phrase', instruction: 'Don’t write “I hope this email finds you well”.' },
        { id: R2, email_type: 'all', kind: 'shorter', instruction: 'Keep it shorter — you usually cut about 30% of the draft.' },
        { id: R3, email_type: 'visit_followup', kind: 'add_phrase', instruction: 'End the email with: “Talk soon”.' }] }],
    email_learning_rules: o.rules || [
      { id: R1, status: 'approved', examples: ['− I hope this email finds you well', '− Hope you are doing well'] },
      { id: R2, status: 'approved', examples: [] },
      { id: R3, status: 'approved', examples: ['+ Talk soon'] }],
  };
  const calls = [];
  const sbGet = async (p) => {
    calls.push(p);
    if (o.fail && o.fail.test(p)) throw new Error('forced read failure');
    const [table, q] = p.split('?');
    if (table === 'staff_users') { const em = decodeURIComponent((q.match(/email=eq\.([^&]+)/) || [])[1] || ''); return db.staff_users.filter(u => u.email === em); }
    if (table === 'email_learning_profiles') return db.email_learning_profiles.slice().sort((a, b) => b.version - a.version).slice(0, 1);
    if (table === 'email_learning_rules') { const ids = ((q.match(/id=in\.\(([^)]*)\)/) || [])[1] || '').split(','); return db.email_learning_rules.filter(r => ids.includes(r.id) && r.status === 'approved'); }
    throw new Error('unexpected read ' + p);
  };
  return { sbGet, calls, db };
}
const ON = { email_learning_apply: true };

(async () => {
  await t('switch: off when missing, false, "true" or 1 — and nothing is read', async () => {
    for (const f of [undefined, {}, { email_learning_apply: false }, { email_learning_apply: 'true' }, { email_learning_apply: 1 }]) {
      const w = world(); const r = await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', f);
      assert.strictEqual(r.active, false); assert.strictEqual(r.reason, 'switch_off'); assert.strictEqual(r.addendum, ''); assert.strictEqual(w.calls.length, 0);
    }
  });
  await t('only the ACTIVE President: a rep, a role claim the database does not confirm, or a former President get nothing', async () => {
    let w = world(); assert.strictEqual((await A.approvedFor(w.sbGet, { email: 'greg@hcps.test', role: 'rep' }, 'previsit_headsup', ON)).reason, 'not_president');
    w = world(); assert.strictEqual((await A.approvedFor(w.sbGet, { email: 'greg@hcps.test', role: 'president' }, 'previsit_headsup', ON)).reason, 'not_president', 'role taken from staff_users');
    w = world({ staff: [{ email: 'owner@hcps.test', role: 'president', active: false }] });
    assert.strictEqual((await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON)).reason, 'not_president');
    assert.strictEqual((await A.approvedFor(w.sbGet, null, 'previsit_headsup', ON)).reason, 'not_president');
  });
  await t('the CURRENT version applies: the type\'s own rules first, then "every type"; another type\'s rule is not used', async () => {
    const w = world(); const r = await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON);
    assert.strictEqual(r.active, true); assert.strictEqual(r.version, 2);
    assert.deepStrictEqual(r.rules.map(x => x.id), [R1, R2]);
    assert.ok(!/Old wording|Talk soon/.test(r.addendum), r.addendum);
  });
  await t('at most 2 masked examples, from the rules in use', async () => {
    const w = world({ rules: [{ id: R1, status: 'approved', examples: ['− a one', '− a two', '− a three'] }, { id: R2, status: 'approved', examples: ['− a four'] }, { id: R3, status: 'approved', examples: [] }] });
    const r = await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON);
    assert.deepStrictEqual(r.examples, ['− a one', '− a two']);
  });
  await t('wording that is not plain text is left out (digits except a percentage, "@", links, other characters, newlines kept to one line)', () => {
    assert.strictEqual(A.cleanLine('Keep it shorter — about 30%.'), 'Keep it shorter — about 30%.');
    assert.strictEqual(A.cleanLine('Say thanks\nand close.'), 'Say thanks and close.');
    for (const s of ['Call 615 555 0100.', 'Mention the $20 fee.', 'Write to pat@acme.com.', 'See https://x.test first.', 'Ask for José.', 'Call ５５５ soon.', 'ok', 'x'.repeat(301)])
      assert.strictEqual(A.cleanLine(s), null, s);
    const rules = A.rulesFor([{ id: R1, email_type: 'all', instruction: 'Call 615 555 0100.' }, { id: R2, email_type: 'all', instruction: 'Be brief.' }, { id: R3, email_type: 'all', instruction: 'be brief.' }], 'follow_up');
    assert.deepStrictEqual(rules.map(r => r.id), [R2], 'bad wording left out; the same wording twice used once');
  });
  await t('a rule retired since the version was cut is left out; none left = not active', async () => {
    let w = world({ rules: [{ id: R1, status: 'retired', examples: [] }, { id: R2, status: 'approved', examples: [] }] });
    let r = await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON);
    assert.deepStrictEqual(r.rules.map(x => x.id), [R2]);
    w = world({ rules: [{ id: R1, status: 'retired', examples: [] }, { id: R2, status: 'retired', examples: [] }] });
    r = await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON);
    assert.strictEqual(r.active, false); assert.strictEqual(r.reason, 'no_rules_for_type'); assert.strictEqual(r.version, 2);
  });
  await t('no version yet / a reset to no rules / no rule for this type = not active', async () => {
    let w = world({ versions: [] }); assert.strictEqual((await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON)).reason, 'no_version');
    w = world({ versions: [{ version: 3, rules: [] }] }); assert.strictEqual((await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON)).reason, 'no_rules_for_type');
    w = world({ versions: [{ version: 4, rules: [{ id: R3, email_type: 'visit_followup', instruction: 'End the email with: “Talk soon”.' }] }] });
    assert.strictEqual((await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON)).reason, 'no_rules_for_type');
  });
  await t('any read failure = not applied, never an error (staff, versions, rules)', async () => {
    for (const re of [/^staff_users/, /^email_learning_profiles/, /^email_learning_rules/]) {
      const w = world({ fail: re }); const r = await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON);
      assert.strictEqual(r.active, false); assert.strictEqual(r.reason, 'unreadable'); assert.strictEqual(r.addendum, '');
    }
  });
  await t('the addendum keeps the style guide first, forbids invented facts, and explains placeholders', async () => {
    const w = world(); const r = await A.approvedFor(w.sbGet, PRES, 'previsit_headsup', ON);
    assert.ok(/on top of the style guide/i.test(r.addendum) && /follow the style guide and the facts/i.test(r.addendum));
    assert.ok(/Never invent a name, date, time, price, product, promotion or commitment/.test(r.addendum));
    assert.ok(/never copy a placeholder/i.test(r.addendum));
    assert.strictEqual(A.promptAddendum([], []), '');
  });
  await t('no email generator uses this module yet (Phase 3 wiring is a separate, reviewed step)', () => {
    const dir = path.join(__dirname, '..', 'netlify', 'functions');
    const users = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== '_email_rules_apply.js')
      .filter(f => /_email_rules_apply/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.deepStrictEqual(users, []);
  });
  console.log(`\nEmail learning P3 (apply): ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();

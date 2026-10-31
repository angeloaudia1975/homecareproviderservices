/* HCPS Smart Email Learning, Phase 3 — the generators end to end through the REAL handlers on the mock world (synthetic data only).
   - every switch off (the production state): the Dealer 360 / visit follow-up prompt and the heads-up are exactly as before, no AI
     heads-up call, nothing recorded about shape
   - email_styles: the chosen style (or the default) goes in AFTER the style guide; the editors are told the styles exist
   - email_learning_apply: the owner's approved rules go in after the style guide — only for the President's own drafts
   - the no-invention guards: an invented price / promotion / date triggers ONE rewrite naming it; if it stays, the rep is told
   - email_ai_headsup: the AI heads-up is used only when it keeps the checked day and time and invents nothing; otherwise the
     fixed template, with a warning; a past / far-off day, a zone-less or already-passed time are left out
   - PR #71: a rep still cannot draft a heads-up for a dealer outside his reach, AI on or off; the heads-up prompt carries no
     account data
     node test/email-learning-p3.flow.test.js */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
const FAKE = require('./email-learning.fake');
const HU = require('../netlify/functions/_headsup.js');

const UA = '0a0a0a0a-0000-4000-8000-00000000000a', UG = '0b0b0b0b-0000-4000-8000-00000000000b';
const R1 = '0c0c0c0c-0000-4000-8000-00000000000c';
const iso = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 864e5));
const IN3 = iso(3);
function world(opts) {
  opts = opts || {};
  const S = standardSeed({
    dealers: [{ id: UA, business_name: 'Sampletown Medical', rep_name: 'Angelo Audia', parent_id: null, email: 'pat@sampletown.test', contact_name: 'Pat Example', state: 'TN' },
      { id: UG, business_name: 'Exampleville Pharmacy', rep_name: 'Greg Campbell', parent_id: null, email: 'lee@exampleville.test', contact_name: 'Lee Sample', state: 'KY' }],
    app_settings: [{ key: 'phase2_flags', value: Object.assign({ email_learning_capture: true }, opts.flags || {}) }],
    dealer_visit_reports: [], email_drafts: [], monthly_sales: [{ dealer_id: UA, manufacturer: 'golden', period: '2026-08-01', amount: 1200 }],
    email_learning_profiles: [{ version: 1, rules: [{ id: R1, email_type: 'all', kind: 'remove_phrase', instruction: 'Don’t write “I hope this email finds you well”.' }] }],
    email_learning_rules: [{ id: R1, status: 'approved', examples: ['− I hope this email finds you well'] }],
  });
  S.rpc = Object.assign(FAKE.rpc(), { hcps_email_draft_shape: (p, db) => { (db.email_draft_shapes = db.email_draft_shapes || []).push(p); return { status: 200, body: { ok: true, status: 'recorded' } }; } });
  const prompts = [];
  const answers = (opts.ai || [{ subject: 'PR519 for Sampletown', body: 'Hi Pat,\n\nThe PR519 suits your lift chair line.\n\nWould Tuesday or Thursday suit a quick review?' }]).slice();
  S.ai = body => { prompts.push(body.messages[0].content); const a = answers.length > 1 ? answers.shift() : answers[0]; return typeof a === 'function' ? a(body) : a; };
  const w = createWorld(S); w.prompts = prompts; return w;
}
const aiCalls = w => w.outbound.filter(x => x.kind === 'ai').length;
const draft = (w, who, o) => call(load('ai-email-api.js', w, { ANTHROPIC_API_KEY: 'k' }), Object.assign({ action: 'draft', dealer_id: who === 'greg' ? UG : UA, template: 'follow_up', contact_name: 'Pat Example' }, o || {}), { token: who || 'pres' });
const heads = (w, who, o) => call(load('routes-api.js', w, { ANTHROPIC_API_KEY: 'k' }), Object.assign({ action: 'previsit_draft', dealer_id: who === 'greg' ? UG : UA, date: IN3, eta: '11:21 AM EST', contact_name: 'Pat Example' }, o || {}), { token: who || 'pres' });
// The heads-up exactly as it was written before Phase 3 (copied from routes-api at d0f7449), so "off" can be proven word for word.
function oldHeadsup(repName, first, dateStr, eta, opp) {
  const prettyDate = s => { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); };
  const when = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? prettyDate(dateStr) : '';
  const greet = first ? `Hi ${first},` : 'Hi there,';
  const arrive = eta ? `I expect to be in your area${when ? ` on ${when}` : ''} around ${eta}` : (when ? `I'm planning to be in your area on ${when}` : "I'm planning to be in your area soon");
  const oppLine = opp ? `\n\nWhile I'm there I'd also like to show you ${opp} — I think it could be a good fit for your business.` : '';
  return { subject: `HCPS will be in your area${when ? ` — ${when}` : ''}`,
    body: `${greet}\n\nThis is ${repName} with HomeCare Provider Services. ${arrive}, and I'd love to stop by for a few minutes to review how things are going and make sure your lines and pricing are set up the way you need.${oppLine}\n\nThe arrival time is an estimate — I'll be moving between accounts that day — but I'll do my best to reach you close to then. If a different time works better, just reply and let me know.\n\nLooking forward to seeing you.` };
}

(async () => {
  // ── everything off = today ───────────────────────────────────────────────
  await t('all switches off: the Dealer 360 prompt has no style and no learned rules; no Phase 3 fields; no shape recorded', async () => {
    const w = world(), r = await draft(w);
    assert.ok(r.body.ok, JSON.stringify(r.body));
    assert.ok(!/Writing style for this email/.test(w.prompts[0]) && !/approved writing preferences/.test(w.prompts[0]));
    assert.deepStrictEqual(r.body.features, { styles: false, checked: false }); assert.strictEqual(r.body.style, undefined); assert.strictEqual(r.body.learning, undefined);
    assert.strictEqual((w.db.email_draft_shapes || []).length, 0); assert.strictEqual(aiCalls(w), 1);
  });
  await t('all switches off: the heads-up is the old template word for word, with no AI call and no Phase 3 fields', async () => {
    for (const [date, eta, opp, clean] of [[IN3, '11:21 AM EST', '', '11:21 AM EST'], ['2026-11-03', '9:05 am', 'the PR519', '9:05 AM'], ['', '', '', ''], ['bad', '1:21 AM EST', '', ''], [iso(-5), '10:00 AM CST', '', '10:00 AM CST']]) {
      const w = world(), r = await heads(w, 'pres', { date, eta, opportunity: opp });
      const want = oldHeadsup('Angelo Audia', 'Pat', date, clean, opp);
      assert.strictEqual(r.body.subject, want.subject); assert.strictEqual(r.body.body, want.body);
      assert.strictEqual(aiCalls(w), 0); assert.strictEqual(r.body.features, undefined); assert.strictEqual(r.body.ai, undefined);
    }
  });

  // ── writing styles ───────────────────────────────────────────────────────
  await t('email_styles: the chosen style goes in after the style guide; an unknown style is the default; the editor is told', async () => {
    const w = world({ flags: { email_styles: true } });
    const r = await draft(w, 'pres', { style: 'consultative' });
    assert.ok(/Writing style for this email — Consultative Sales/.test(w.prompts[0]));
    assert.ok(w.prompts[0].indexOf('Writing style for this email') > w.prompts[0].indexOf('Style Guide') || /Style Guide/i.test(w.prompts[0]) === false);
    assert.strictEqual(r.body.style, 'consultative'); assert.strictEqual(r.body.features.styles, true); assert.strictEqual(r.body.features.style_list.length, 3);
    const r2 = await draft(w, 'pres', { style: '<script>' }); assert.strictEqual(r2.body.style, 'professional_friendly');
    assert.ok(/Professional & Friendly/.test(w.prompts[w.prompts.length - 1]));
    assert.ok((w.db.email_draft_shapes || []).some(s => s.style === 'consultative' && s.ai === true), 'the shape is recorded for the President');
  });

  // ── learned rules ────────────────────────────────────────────────────────
  await t('email_learning_apply: approved rules shape the President\'s draft (after the style guide), never Greg\'s', async () => {
    const w = world({ flags: { email_learning_apply: true } });
    const r = await draft(w);
    assert.ok(/approved writing preferences/.test(w.prompts[0]) && /I hope this email finds you well/.test(w.prompts[0]));
    assert.deepStrictEqual(r.body.learning, { version: 1, rules: 1 });
    assert.ok((w.db.email_draft_shapes || []).some(s => s.profile_version === 1));
    const g = await draft(w, 'greg'); assert.ok(g.body.ok);
    assert.ok(!/approved writing preferences/.test(w.prompts[w.prompts.length - 1])); assert.strictEqual(g.body.learning, undefined);
  });

  // ── no-invention guards ──────────────────────────────────────────────────
  await t('guards: an invented promotion and price trigger one rewrite naming them; a clean rewrite is used with no warning', async () => {
    const w = world({ flags: { email_styles: true }, ai: [
      { subject: 'Special offer', body: 'Hi Pat,\n\nWe have a 20% discount and free freight this month — $499 off the PR519.\n\nInterested?' },
      { subject: 'PR519 for Sampletown', body: 'Hi Pat,\n\nThe PR519 suits your lift chair line.\n\nWould Tuesday or Thursday suit?' }] });
    const r = await draft(w);
    assert.strictEqual(aiCalls(w), 2); assert.ok(/stated things the facts above do not support/.test(w.prompts[1]) && /free freight/.test(w.prompts[1]) && /\$499/.test(w.prompts[1]));
    assert.ok(/PR519 suits/.test(r.body.body)); assert.strictEqual(r.body.warnings, undefined);
  });
  await t('guards: when the rewrite still invents, the rep is told exactly what to check', async () => {
    const bad = { subject: 'Free freight', body: 'Hi Pat,\n\nYour order ships today with free freight.\n\nWant it?' };
    const w = world({ flags: { email_styles: true }, ai: [bad, bad] });
    const r = await draft(w);
    assert.ok(Array.isArray(r.body.warnings) && r.body.warnings.some(x => /free freight/i.test(x)) && r.body.warnings.some(x => /ships today/i.test(x)), JSON.stringify(r.body.warnings));
  });
  await t('guards: purchase history is allowed when the account has it, never on a draft written without it', async () => {
    const w = world({ flags: { email_styles: true }, ai: [{ subject: 'Golden reorder', body: 'Hi Pat,\n\nYour last order of Golden was in August, so you may be due.\n\nShall I send a quote?' }] });
    const r = await draft(w); assert.strictEqual(r.body.warnings, undefined, JSON.stringify(r.body.warnings));
  });

  await t('guards: a draft for an account with no purchase history may not claim one', async () => {
    const w = world({ flags: { email_styles: true }, ai: [{ subject: 'Reorder', body: 'Hi Lee,\n\nYour last order was a while ago.\n\nShall I send a quote?' }] });
    const r = await draft(w, 'greg', { contact_name: 'Lee Sample' });
    assert.ok(Array.isArray(r.body.warnings) && r.body.warnings.some(x => /Your last order/.test(x)), JSON.stringify(r.body));
  });
  await t('switches are on only when exactly true ("true" as text, 1 or "yes" are off)', async () => {
    for (const v of ['true', 1, 'yes']) {
      const w = world({ flags: { email_styles: v, email_ai_headsup: v, email_learning_apply: v } });
      const r = await draft(w, 'pres', { style: 'consultative' }); assert.strictEqual(r.body.features.styles, false); assert.ok(!/Writing style/.test(w.prompts[0]));
      assert.ok(!/approved writing preferences/.test(w.prompts[0]));
      const h = await heads(w); assert.strictEqual(h.body.ai, undefined); assert.strictEqual(h.body.features, undefined);
    }
  });

  // ── AI heads-up ─────────────────────────────────────────────────────────
  const when = HU.prettyDate(IN3);
  await t('email_ai_headsup: a clean AI heads-up that keeps the day and the time is used', async () => {
    const w = world({ flags: { email_ai_headsup: true }, ai: [{ subject: `Stopping by ${when}`, body: `Hi Pat,\n\nThis is Angelo with HomeCare Provider Services. I plan to stop by on ${when} around 11:21 AM EST — an estimate, as I move between accounts.\n\nIf another time suits better, just reply.` }] });
    const r = await heads(w);
    assert.strictEqual(r.body.ai, true, JSON.stringify(r.body)); assert.ok(/around 11:21 AM EST/.test(r.body.body)); assert.strictEqual(r.body.features.ai, true);
    const p = w.prompts[0];
    assert.ok(!/Sampletown|pat@sampletown|golden|1200/i.test(p), 'the heads-up prompt carries no account data'); assert.ok(/Estimated arrival: 11:21 AM EST/.test(p));
  });
  await t('email_ai_headsup: an AI heads-up that invents (twice) is replaced by the fixed template, with a warning', async () => {
    const bad = { subject: 'Free freight!', body: `Hi Pat,\n\nI'll be there on ${when} around 11:21 AM EST (an estimate) with free freight on every order and samples I'll bring.` };
    const w = world({ flags: { email_ai_headsup: true }, ai: [bad, bad] });
    const r = await heads(w);
    assert.strictEqual(r.body.ai, false); assert.strictEqual(r.body.body, HU.templateDraft({ repName: 'Angelo Audia', first: 'Pat', when: IN3, eta: '11:21 AM EST', opp: '' }).body);
    assert.ok(r.body.warnings.some(x => /couldn't confirm/.test(x)));
  });
  await t('email_ai_headsup: an AI heads-up that drops the arrival time is rewritten, then replaced by the template', async () => {
    const vague = { subject: 'Visit', body: `Hi Pat,\n\nI'll stop by on ${when}.` };
    const w = world({ flags: { email_ai_headsup: true }, ai: [vague, vague] });
    const r = await heads(w); assert.strictEqual(r.body.ai, false); assert.ok(/left out the estimated arrival/.test(w.prompts[1]));
  });
  await t('email_ai_headsup: the AI service failing never blocks the heads-up', async () => {
    const w = world({ flags: { email_ai_headsup: true }, ai: [{ status: 500, body: { error: { message: 'down' } } }] });
    const r = await heads(w); assert.ok(r.body.ok); assert.strictEqual(r.body.ai, false); assert.ok(r.body.warnings.some(x => /standard heads-up/.test(x)));
  });
  await t('checks: a past day, a far-off day, a time without a zone and a time already passed are left out (neutral wording)', async () => {
    const flags = { email_styles: true };
    let r = await heads(world({ flags }), 'pres', { date: iso(-2) });
    assert.ok(/in your area soon/.test(r.body.body) && !/around/.test(r.body.body) && r.body.warnings.some(x => /already passed/.test(x)));
    r = await heads(world({ flags }), 'pres', { date: iso(200) });
    assert.ok(/in your area soon/.test(r.body.body) && r.body.warnings.some(x => /looks wrong/.test(x)));
    r = await heads(world({ flags }), 'pres', { eta: '11:21 AM' });
    assert.ok(!/11:21/.test(r.body.body) && r.body.warnings.some(x => /no time zone/.test(x)));
    r = await heads(world({ flags }), 'pres', { date: iso(0), eta: '7:00 AM EST' });
    if (new Date().getUTCHours() >= 13) assert.ok(!/7:00/.test(r.body.body) && r.body.warnings.some(x => /already passed/.test(x)), JSON.stringify(r.body));
    r = await heads(world({ flags }), 'pres', {});
    assert.ok(new RegExp(`on ${when} around 11:21 AM EST`).test(r.body.body), r.body.body);
  });

  // ── PR #71 access rules hold ─────────────────────────────────────────────
  await t('PR #71: Greg cannot draft a heads-up for the President\'s dealer, AI on or off', async () => {
    for (const flags of [{}, { email_ai_headsup: true, email_styles: true, email_learning_apply: true }]) {
      const w = world({ flags }); const r = await call(load('routes-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'previsit_draft', dealer_id: UA, date: IN3, eta: '11:21 AM EST' }, { token: 'greg' });
      assert.ok(r.status === 403 || r.body.ok === false, JSON.stringify(r)); assert.strictEqual(aiCalls(w), 0);
    }
  });
  await t('PR #71: Greg cannot draft a Dealer 360 email for the President\'s dealer with every Phase 3 switch on', async () => {
    const w = world({ flags: { email_ai_headsup: true, email_styles: true, email_learning_apply: true } });
    const r = await call(load('ai-email-api.js', w, { ANTHROPIC_API_KEY: 'k' }), { action: 'draft', dealer_id: UA, template: 'follow_up' }, { token: 'greg' });
    assert.strictEqual(r.status, 403); assert.strictEqual(aiCalls(w), 0);
  });
  // ── owner page: Redact ───────────────────────────────────────────────────
  await t('Redact (API): President only, a reason, a known status; the actor is the sign-in, never the request; not installed = 503', async () => {
    const w = world(); const seen = [];
    w.db.email_learning_rules[0].status = 'approved';
    const S2 = { rpc: { hcps_email_rule_redact: p => { seen.push(p); return { status: 200, body: { ok: true, status: 'redacted', rule_status: 'retired', version: 2 } }; } } };
    const fetch0 = w.fetch; w.fetch = async (u, o) => { const m = String(u).match(/rpc\/(hcps_email_rule_redact)$/); if (m) { const p = JSON.parse(o.body).p; return { ok: true, status: 200, text: async () => JSON.stringify(S2.rpc[m[1]](p).body), json: async () => S2.rpc[m[1]](p).body }; } return fetch0(u, o); };
    const L = load('email-learning-api.js', w);
    const body = { action: 'redact', rule_id: R1, reason: 'Holds a name', expected_version: 1, expected_status: 'approved', by: 'greg@hcps.us' };
    assert.strictEqual((await call(L, body, { token: 'greg' })).status, 403);
    assert.strictEqual((await call(L, Object.assign({}, body, { reason: 'x' }), { token: 'pres' })).status, 422);
    assert.strictEqual((await call(L, Object.assign({}, body, { rule_id: 'nope' }), { token: 'pres' })).status, 400);
    assert.strictEqual((await call(L, Object.assign({}, body, { expected_status: 'gone' }), { token: 'pres' })).status, 400);
    const r = await call(L, body, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(seen[0].by, 'angelo@hcps.us', 'the actor is the verified sign-in');
    const w2 = world(); const L2 = load('email-learning-api.js', w2);
    const r2 = await call(L2, body, { token: 'pres' }); assert.strictEqual(r2.status, 503); assert.strictEqual(r2.body.error, 'redact_not_installed');
  });
  done('Email learning P3 (generators)');
})();

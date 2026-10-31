/* HCPS Smart Email Learning, Phase 3 — the pure pieces: the no-invention guards (_draft_guards.js), the writing styles
   (_email_styles.js) and the heads-up checks / AI draft (_headsup.js). Synthetic drafts only; no network.
     node test/email-learning-p3.guards.test.js */
const assert = require('assert');
const { load } = require('./phase0-mock');
const DG = load('_draft_guards.js', { fetch: async () => { throw new Error('no network'); } });
const ST = load('_email_styles.js', { fetch: async () => { throw new Error('no network'); } });
const HU = load('_headsup.js', { fetch: async () => { throw new Error('no network'); } });

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); } }
const kinds = (d, f) => DG.check(d, f).problems.map(p => p.kind + ':' + p.text);
const B = body => ({ subject: 'Subject', body });

(async () => {
  await t('a clean draft against its facts has no findings', () => {
    assert.deepStrictEqual(kinds(B('Hi Pat, I plan to stop by on Tuesday, November 3 around 11:21 AM EST — an estimate.'),
      { source: ['Tuesday, November 3'], dates: ['2026-11-03'], times: ['11:21 AM EST'], weekdays: true }), []);
  });
  await t('times: a time not given is a finding; the same time written differently is not', () => {
    const f = { times: ['11:21 AM EST'] };
    assert.deepStrictEqual(kinds(B('around 11:21am'), f), []);
    assert.deepStrictEqual(kinds(B('around 11:21 a.m.'), f), []);
    assert.deepStrictEqual(kinds(B('around 2 PM'), f), ['time:2 PM']);
    assert.deepStrictEqual(kinds(B('by noon'), f), ['time:noon']);
    assert.deepStrictEqual(kinds(B('I am here'), f), [], '"am" alone is not a time');
  });
  await t('zones: a zone of another region is a finding; EST / ET / Eastern are one region', () => {
    const f = { times: ['11:21 AM EST'] };
    assert.deepStrictEqual(kinds(B('11:21 AM ET'), f), []); assert.deepStrictEqual(kinds(B('11:21 AM Eastern Time'), f), []);
    assert.deepStrictEqual(kinds(B('11:21 AM CST'), f), ['zone:CST']);
  });
  await t('dates: written as month-day, ISO or slashes, all compared as the same calendar day', () => {
    const f = { dates: ['2026-11-03'] };
    for (const s of ['on November 3', 'on Nov. 3rd', 'on 11/3', 'on 2026-11-03', 'on November 3, 2026']) assert.deepStrictEqual(kinds(B(s), f), [], s);
    assert.deepStrictEqual(kinds(B('on November 4'), f), ['date:November 4']);
    assert.deepStrictEqual(kinds(B('in March 2026'), f), [], 'a month and year is not a day');
    assert.deepStrictEqual(kinds(B('you may 3 times'), f), [], '"may" in lower case is not a month');
  });
  await t('weekdays: checked only for the heads-up; then only the weekday of a given date (or one named in the facts)', () => {
    assert.deepStrictEqual(kinds(B('Would Tuesday or Thursday suit?'), {}), [], 'a proposed next step elsewhere');
    const f = { dates: ['2026-11-03'], weekdays: true };   // 2026-11-03 is a Tuesday
    assert.deepStrictEqual(kinds(B('see you Tuesday'), f), []);
    assert.deepStrictEqual(kinds(B('see you Wednesday'), f), ['weekday:Wednesday']);
    assert.strictEqual(DG.weekdayOf(2026, 11, 3), 'tuesday');
  });
  await t('prices and percentages: only amounts the facts hold, however they are written', () => {
    const f = { source: ['Total sales on file: $12,345', 'up 30% on last year'] };
    assert.deepStrictEqual(kinds(B('over $12,345 so far, up 30 percent'), f), []);
    assert.deepStrictEqual(kinds(B('save $50 — 10% off'), f).sort(), ['percent:10%', 'price:$50', 'promotion:10% off', 'promotion:save $'].sort());
    assert.deepStrictEqual(kinds(B('a $1.5k order'), { source: ['$1,500'] }), []);
  });
  await t('promotions, stock and shipping: only when the facts speak of them', () => {
    assert.deepStrictEqual(kinds(B('Free freight on your next order'), {}), ['promotion:Free freight']);
    assert.deepStrictEqual(kinds(B('Free freight on your next order'), { source: ['Promotion: free freight through December'] }), []);
    assert.deepStrictEqual(kinds(B('It is in stock and ships today'), {}).sort(), ['availability:in stock', 'availability:ships today']);
    assert.deepStrictEqual(kinds(B('Lead times are short'), {}), ['availability:Lead times']);
  });
  await t('purchase history: only for a draft given the account\'s history', () => {
    assert.deepStrictEqual(kinds(B('Your last order was in August'), {}), ['history:Your last order']);
    assert.deepStrictEqual(kinds(B('Your last order was in August'), { history: true }), []);
    assert.deepStrictEqual(kinds(B('you have been buying the PR519'), {}), ['history:you have been buying']);
  });
  await t('commitments: a guarantee, warranty, price match or "I\'ll bring" needs the same word in the facts', () => {
    assert.deepStrictEqual(kinds(B('We guarantee the price'), {}), ['commitment:guarantee']);
    assert.deepStrictEqual(kinds(B("I'll bring samples"), {}), ["commitment:I'll bring"]);
    assert.deepStrictEqual(kinds(B("I'll bring samples"), { source: ['Rep commitments: bring two samples'] }), []);
    assert.deepStrictEqual(kinds(B('It carries a lifetime warranty'), { source: ['Warranty: lifetime on frame'] }), []);
    assert.deepStrictEqual(kinds(B('No-obligation, risk-free trial'), {}).sort(), ['commitment:No-obligation', 'commitment:risk-free', 'promotion:free trial'].sort());
  });
  await t('typographic quotes and full-width characters do not hide a claim', () => {
    assert.deepStrictEqual(kinds(B('I’ll bring samples'), {}), ["commitment:I'll bring"]);
    assert.deepStrictEqual(kinds(B('save ＄５０'), {}).sort(), ['price:$50', 'promotion:save $']);
  });
  await t('review M1: the forms that used to slip through are findings now', () => {
    const f = { source: ['Wednesday, November 4'], dates: ['2026-11-04'], times: ['11:30 AM CST'], weekdays: true };
    const has = (txt, kind) => assert.ok(kinds(B(txt), f).some(k => k.startsWith(kind + ':')), `${txt} → ${JSON.stringify(kinds(B(txt), f))}`);
    for (const x of ['at 14:30', 'at 11.45am', "at 3 o'clock", 'at two thirty', 'half past two', 'nine in the morning']) has(x, 'time');
    for (const x of ['on the 5th', 'tomorrow', 'next week', 'this weekend']) has(x, 'date');
    has('see you Thurs.', 'weekday');
    for (const x of ['1,200 bucks', 'fifty dollars', 'a few hundred bucks']) has(x, 'price');
    has('15 pct off', 'percent');
    for (const x of ['a 2-for-1 deal', 'special savings', 'complimentary freight', 'at no extra cost', 'buy one, get one']) has(x, 'promotion');
    for (const x of ['I give you my word', 'rest assured', 'without fail']) has(x, 'commitment');
    assert.deepStrictEqual(kinds(B('around 11:30 AM CST on Wednesday, November 4, an estimate'), f), [], 'the given day and time stay clean');
    assert.deepStrictEqual(kinds(B('the 4th works'), f), [], 'the given day as an ordinal');
    assert.deepStrictEqual(kinds(B('Would Tuesday or next week suit?'), {}), [], 'outside the heads-up a proposed day is a next step');
    assert.deepStrictEqual(kinds(B('up 30% on last year, 11:30 visits'), { source: ['up 30% on last year', '11:30 AM CST'] }), []);
  });
  await t('the rewrite note names each finding; the warnings tell the rep what to check', () => {
    const p = DG.check(B('Free freight and $50 off'), {}).problems;
    const n = DG.rewriteNote(p); assert.ok(/"Free freight" \(promotion or discount\)/.test(n) && /"\$50"/.test(n));
    assert.ok(DG.warningsFor(p).every(w => /^Check before sending:/.test(w))); assert.strictEqual(DG.rewriteNote([]), '');
  });

  // ── styles ──
  await t('styles: three, a known key or the default; the block never allows new facts', () => {
    assert.deepStrictEqual(ST.styleList().map(x => x.key), ['professional_friendly', 'consultative', 'brief_direct']);
    assert.strictEqual(ST.styleKey('BRIEF_direct'), 'brief_direct'); assert.strictEqual(ST.styleKey('nope'), 'professional_friendly'); assert.strictEqual(ST.styleKey(null), 'professional_friendly');
    for (const k of Object.keys(ST.STYLES)) assert.ok(/never adds a fact, product, price, date, promotion or commitment/.test(ST.styleBlock(k)) && ST.styleBlock(k).includes(ST.STYLES[k].label));
    assert.ok(ST.styleBlock('__proto__').includes('Professional & Friendly'));
  });

  // ── heads-up checks ──
  const NOW = Date.parse('2026-10-31T15:00:00Z');   // 10:00 AM CDT, Saturday 31 October 2026
  await t('checkDate: a real date from today to 120 days ahead; else left out with a reason', () => {
    const w = [];
    assert.strictEqual(HU.checkDate('2026-10-31', w, NOW), '2026-10-31'); assert.strictEqual(HU.checkDate('2027-02-28', w, NOW), '2027-02-28'); assert.strictEqual(w.length, 0);
    assert.strictEqual(HU.checkDate('2026-10-30', w, NOW), ''); assert.ok(/already passed/.test(w.pop()));
    assert.strictEqual(HU.checkDate('2027-03-31', w, NOW), ''); assert.ok(/looks wrong/.test(w.pop()));
    assert.strictEqual(HU.checkDate('2026-02-30', w, NOW), ''); assert.ok(/couldn't be read/.test(w.pop()));
    assert.strictEqual(HU.checkDate('', w, NOW), ''); assert.strictEqual(w.length, 0);
  });
  await t('checkEta: needs a known zone and a day, and must not have passed', () => {
    const w = [];
    assert.strictEqual(HU.checkEta('11:21 AM EST', '2026-11-03', w, NOW), '11:21 AM EST'); assert.strictEqual(w.length, 0);
    assert.strictEqual(HU.checkEta('11:21 AM', '2026-11-03', w, NOW), ''); assert.ok(/no time zone/.test(w.pop()));
    assert.strictEqual(HU.checkEta('11:21 AM XYZ', '2026-11-03', w, NOW), ''); assert.ok(/no time zone/.test(w.pop()));
    assert.strictEqual(HU.checkEta('11:21 AM EST', '', w, NOW), ''); assert.ok(/doesn't name a day/.test(w.pop()));
    assert.strictEqual(HU.checkEta('9:30 AM CDT', '2026-10-31', w, NOW), ''); assert.ok(/already passed/.test(w.pop()), '9:30 CDT is before 10:00 CDT');
    assert.strictEqual(HU.checkEta('10:30 AM CDT', '2026-10-31', w, NOW), '10:30 AM CDT');
    assert.strictEqual(HU.checkEta('10:30 AM CT', '2026-10-31', w, NOW), '10:30 AM CT', 'a generic zone is read through its region\'s clock');
    assert.strictEqual(HU.checkEta('9:30 AM CT', '2026-10-31', w, NOW), ''); assert.ok(/already passed/.test(w.pop()));
  });
  await t('the template: unchanged wording, the day and time only when given', () => {
    const d = HU.templateDraft({ repName: 'Rep Sample', first: 'Pat', when: '2026-11-03', eta: '11:21 AM EST', opp: '' });
    assert.strictEqual(d.subject, 'HCPS will be in your area — Tuesday, November 3');
    assert.ok(d.body.startsWith('Hi Pat,\n\nThis is Rep Sample with HomeCare Provider Services. I expect to be in your area on Tuesday, November 3 around 11:21 AM EST,'));
    assert.ok(/in your area soon/.test(HU.templateDraft({ repName: 'R', first: '', when: '', eta: '', opp: '' }).body));
  });
  await t('aiDraft: keeps a clean draft; one rewrite; template on a second failure or an AI error', async () => {
    const f = { repName: 'Rep Sample', first: 'Pat', when: '2026-11-03', eta: '11:21 AM EST', opp: '' };
    const good = { subject: 'Tuesday, November 3', body: 'Hi Pat, I plan to be there on Tuesday, November 3 around 11:21 AM EST — an estimate.' };
    const bad = { subject: 'Visit', body: 'Hi Pat, on Tuesday, November 3 around 11:21 AM EST (estimate) — free freight too!' };
    let asked = [];
    let r = await HU.aiDraft(f, { ask: async p => { asked.push(p); return good; }, styleGuide: 'GUIDE', extra: '' });
    assert.ok(r.ok && asked.length === 1 && asked[0].indexOf('GUIDE') < asked[0].indexOf('These are the ONLY facts'));
    asked = []; const seq = [bad, good];
    r = await HU.aiDraft(f, { ask: async p => { asked.push(p); return seq.shift(); }, styleGuide: 'G' });
    assert.ok(r.ok && asked.length === 2 && /free freight/.test(asked[1]));
    r = await HU.aiDraft(f, { ask: async () => bad, styleGuide: 'G' }); assert.strictEqual(r.reason, 'guard_refused');
    r = await HU.aiDraft(f, { ask: async () => ({ err: 'ai_status_500' }), styleGuide: 'G' }); assert.strictEqual(r.ok, false);
    r = await HU.aiDraft(f, { ask: async () => ({ subject: 'x', body: 'Hi Pat, see you Tuesday, November 3 around 11:21 AM EST, estimate. Just checking in!' }), styleGuide: 'G',
      findBanned: s => /just checking in/i.test(s) ? ['just checking in'] : [] });
    assert.strictEqual(r.ok, false, 'a phrase the style guide forbids counts too');
  });
  await t('aiDraft: a draft that names the day but drops the arrival time is never kept', async () => {
    const f = { repName: 'R', first: 'Pat', when: '2026-11-03', eta: '11:21 AM EST', opp: '' };
    const noTime = { subject: 'Tuesday, November 3', body: 'Hi Pat, I plan to stop by on Tuesday, November 3 — the time is an estimate.' };
    const r = await HU.aiDraft(f, { ask: async () => noTime, styleGuide: 'G' }); assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(HU.missingFacts(noTime, f).map(x => x.label), ['the estimated arrival']);
  });
  await t('aiDraft: with no confirmed day or time the AI must name neither', async () => {
    const f = { repName: 'R', first: '', when: '', eta: '', opp: '' };
    const r = await HU.aiDraft(f, { ask: async () => ({ subject: 'Soon', body: 'Hi there, I plan to stop by on Monday around 9 AM.' }), styleGuide: 'G' });
    assert.strictEqual(r.ok, false);
    assert.ok(/name no day or date/.test(HU.promptFor(f, 'G', '')) && /name no time/.test(HU.promptFor(f, 'G', '')));
  });
  console.log(`\nEmail learning P3 (guards, styles, heads-up): ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();

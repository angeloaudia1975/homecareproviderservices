/* Phase 2C — the AI End-of-Day Recap (rep-command-api `brief` with kind "eod", stored in rep_daily_briefs).

   Approved rules under test:
     · the numbers are counted by code; the AI writes only the narrative
     · a narrative whose numbers don't match the counts is retried once, then rejected (nothing fake stored)
     · no AI on page load: `today` and `check` only read; a stored recap is shown as stored
     · each person writes their own recap; management and Relations READ a rep's stored recap, never write one
     · My Sales Workspace: Angelo's own work only; one recap per person per day (shared with the Admin view)
     · one (re)generation per 10 minutes; stale when the day's facts change; behind the eod_recap switch */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');
const BAI = load('_brief_ai.js', createWorld(standardSeed()));   // through the harness, so mutants reach it

const pad = n => String(n).padStart(2, '0');
const dayStr = off => { const d = new Date(); d.setDate(d.getDate() + (off || 0)); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const TODAY = dayStr(0), TOMORROW = dayStr(1), YDAY = dayStr(-1);
const TZ = new Date().getTimezoneOffset();
const WS = { 'x-hcps-workspace': 'mine' };
const now = () => new Date(Date.now() - 60e3).toISOString();

// The exact counts the seed below produces for Greg today.
const GREG = { visits_completed: 1, visits_started: 2, people_met: 3, commitments: 3, rep_commitments: 2, dealer_commitments: 1, followup_tasks_created: 2,
  tasks_completed: 2, opportunities_created: 2, pipeline_added: 1300, pipeline_value: 3000, emails_sent: 1, emails_drafted: 0,
  unresolved_followups: 1, open_visit_tasks: 1, overdue_tasks: 1, tomorrow_stops: 2, tasks_due_tomorrow: 1 };
const goodNarrative = { narrative: 'You completed 1 of 2 visits today and met 3 people. The Glasgow visit produced 3 commitments and 2 follow-up tasks, and you completed 2 tasks. You added 2 deals, about $1,300 in weighted pipeline, and sent 1 follow-up email. 1 visit follow-up is still open.',
  tomorrow: 'Start with the overdue PO call, then the 2 stops on tomorrow\'s route.' };

function seed(opts) {
  opts = opts || {};
  const S = standardSeed({
    rep_routes: [
      { id: 'r-g', owner_email: 'angelo@hcps.us', assigned_to_email: 'greg@hcps.us', name: 'Greg today', scheduled_date: TODAY, stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center' }] },
      { id: 'r-g2', owner_email: 'greg@hcps.us', name: 'Greg tomorrow', scheduled_date: TOMORROW, stops: [{ dealer_id: 'd-greg', name: 'Glasgow Prescription Center' }, { dealer_id: 'd-dir-greg', name: 'Directory Only Dealer' }] } ],
    dealer_visit_reports: [
      { id: 'v1', route_id: 'r-g', dealer_id: 'd-greg', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: now(), ended_at: now(), completed_at: now(), approved_at: now(), status: 'completed',
        followup_status: 'pending', followup_due: TOMORROW, followup_email: { saved_at: now(), sent_at: now() },
        summary: { meeting_summary: 'Met Rita and Bob about lift chairs.', rep_commitments: [{ text: 'send pricing' }, { text: 'bring samples' }], dealer_commitments: [{ text: 'send the PO' }] } },
      { id: 'v2', route_id: null, dealer_id: 'd-greg-branch', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: now(), status: 'checked_in', completed_at: null },
      { id: 'v-ang', route_id: null, dealer_id: 'd-ang', rep_email: 'angelo@hcps.us', rep_name: 'Angelo Audia', checkin_at: now(), completed_at: now(), approved_at: now(), status: 'completed', summary: { meeting_summary: 'Angelo at RMS.' } } ],
    dealer_visit_participants: [
      { visit_report_id: 'v1', name_snapshot: 'Rita Owner' }, { visit_report_id: 'v1', name_snapshot: 'Bob Buyer' }, { visit_report_id: 'v2', name_snapshot: 'Sam Smith' }, { visit_report_id: 'v-ang', name_snapshot: 'Ann RMS' } ],
    dealer_tasks: [
      { id: 't-o1', dealer_id: 'd-greg', title: 'Send pricing', status: 'done', done_at: now(), origin_type: 'visit_report', origin_id: 'v1', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us', created_at: now() },
      { id: 't-o2', dealer_id: 'd-greg', title: 'Bring samples', status: 'open', due_date: TOMORROW, origin_type: 'visit_report', origin_id: 'v1', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us', created_at: now() },
      { id: 't-m', dealer_id: 'd-greg', title: 'Manual done task', status: 'done', done_at: now(), assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' },
      { id: 't-old', dealer_id: 'd-greg', title: 'Call Glasgow about the PO', status: 'open', due_date: YDAY, priority: 'high', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' },
      { id: 't-a', dealer_id: 'd-ang', title: 'Angelo task', status: 'done', done_at: now(), assigned_rep: 'Angelo Audia', assigned_email: 'angelo@hcps.us' } ],
    opportunities: [
      { id: 'o-v', dealer_id: 'd-greg', title: '2 x PR519', stage: 'identified', status: 'open', value: 1000, origin_type: 'visit_report', origin_id: 'v1', owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us', created_at: now(), updated_at: now() },
      { id: 'o-m', dealer_id: 'd-greg-branch', title: 'Scooter fleet', stage: 'quoted', status: 'open', value: 2000, owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us', created_at: now(), updated_at: now() },
      { id: 'o-old', dealer_id: 'd-greg', title: 'Old deal', stage: 'quoted', status: 'open', value: 9999, owner_rep: 'Greg Campbell', owner_email: 'greg@hcps.us', created_at: dayStr(-20), updated_at: dayStr(-20) } ],
    service_requests: [], rep_daily_briefs: opts.briefs || [], manufacturers: [], dealer_engagement: [],
    app_settings: [{ key: 'platform', value: { mode: 'development' } }].concat(opts.flags === undefined ? [{ key: 'phase2_flags', value: { morning_brief: true, eod_recap: true } }] : (opts.flags ? [opts.flags] : [])),
  });
  S.unique = { rep_daily_briefs: [['rep_email', 'brief_date', 'kind']] };
  if (opts.missing) S.missingTables = ['rep_daily_briefs'];
  S.ai = opts.ai || (() => goodNarrative);
  return S;
}
const W = opts => createWorld(seed(opts));
const CC = (w, body, tok, ws, env) => call(load('rep-command-api.js', w, Object.assign({ ANTHROPIC_API_KEY: 'k' }, env || {})), Object.assign({ date: TODAY, tz: TZ, hour: 18 }, body), { token: tok || 'greg', headers: ws ? WS : {} });
const RECAP = (w, mode, tok, ws, extra, env) => CC(w, Object.assign({ action: 'brief', kind: 'eod', mode }, extra || {}), tok, ws, env);
const TODAYCALL = (w, tok, ws, extra) => CC(w, Object.assign({ action: 'today' }, extra || {}), tok, ws);
const aiCalls = w => w.outbound.filter(o => o.kind === 'ai').length;
const rows = (w, email, kind) => (w.db.rep_daily_briefs || []).filter(r => (!email || r.rep_email === email) && (!kind || r.kind === kind));
const back = (w, email, ms) => { for (const r of rows(w, email, 'eod')) r.attempted_at = new Date(Date.parse(r.attempted_at) - ms).toISOString(); };

(async () => {
  await t('Switch off (missing / not exactly true): no recap on today, the recap action refuses; the Morning Brief is unaffected', async () => {
    for (const flags of [{ key: 'phase2_flags', value: { morning_brief: true } }, { key: 'phase2_flags', value: { morning_brief: true, eod_recap: 'true' } }]) {
      const w = W({ flags });
      const d = await TODAYCALL(w);
      assert.ok(!('eod_recap' in d.body)); assert.ok(d.body.morning_brief && d.body.morning_brief.enabled);
      const r = await RECAP(w, 'auto'); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'flag_off');
      assert.strictEqual(aiCalls(w), 0);
    }
  });

  await t('No AI on load: today and check only read — the counted facts come back with no AI call and nothing written', async () => {
    const w = W();
    const d = await TODAYCALL(w);
    assert.strictEqual(d.body.eod_recap.status, 'none'); assert.strictEqual(d.body.eod_recap.own, true); assert.ok(!('_recap' in d.body), 'internal recap detail leaked into today');
    const c = await RECAP(w, 'check');
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    assert.deepStrictEqual(c.body.facts, GREG);
    assert.deepStrictEqual(c.body.people.slice().sort(), ['Bob Buyer', 'Rita Owner', 'Sam Smith']);
    assert.ok(c.body.rule_text && /completed 1 of 2 visits/.test(c.body.rule_text), c.body.rule_text);
    const kinds = c.body.tomorrow.map(x => x.kind);
    assert.deepStrictEqual(kinds, ['route', 'overdue', 'followup', 'task'], JSON.stringify(c.body.tomorrow));
    assert.ok(/Greg tomorrow — 2 stops, first Glasgow/.test(c.body.tomorrow[0].text));
    assert.strictEqual(c.body.unresolved.length, 1);
    assert.strictEqual(aiCalls(w), 0); assert.strictEqual(rows(w).length, 0);
  });

  await t('Write my recap: the AI gets the counted facts, writes only the narrative; the stored recap carries the counted facts', async () => {
    let prompt = '';
    const w = W({ ai: b => { prompt = b.messages[0].content; return goodNarrative; } });
    const r = await RECAP(w, 'auto');
    assert.strictEqual(r.body.generated, true); assert.strictEqual(aiCalls(w), 1);
    assert.ok(/visits completed: 1 \(of 2 started\)/.test(prompt) && /people met: 3/.test(prompt) && /estimated pipeline added: \$1,300 weighted \(\$3,000 face value\)/.test(prompt), prompt.slice(0, 900));
    assert.ok(/STRICT NUMBER RULE/.test(prompt));
    const B = r.body.brief; assert.strictEqual(B.narrative, goodNarrative.narrative); assert.strictEqual(B.tomorrow_text, goodNarrative.tomorrow);
    assert.deepStrictEqual(B.facts, GREG); assert.strictEqual(B.kind, 'eod');
    const row = rows(w, 'greg@hcps.us', 'eod')[0];
    assert.strictEqual(row.status, 'ready'); assert.ok(row.signals_key && row.inputs && row.inputs.facts); assert.strictEqual(row.generated_by, 'greg@hcps.us');
    // Stored → reused: no AI on the next load or the next auto.
    await TODAYCALL(w); await RECAP(w, 'check'); const again = await RECAP(w, 'auto');
    assert.strictEqual(aiCalls(w), 1); assert.strictEqual(again.body.brief.narrative, B.narrative);
    const d = await TODAYCALL(w); assert.strictEqual(d.body.eod_recap.brief.narrative, B.narrative);
    back(w, 'greg@hcps.us', 3 * 3600e3); await RECAP(w, 'auto'); assert.strictEqual(aiCalls(w), 1, 'auto rewrote a stored recap');
  });

  await t('Numbers that don\'t match the counts: retried once with the exact figures, then rejected — nothing fake stored', async () => {
    let n = 0; const prompts = [];
    const w = W({ ai: b => { n++; prompts.push(b.messages[0].content); return n === 1 ? { narrative: 'You completed 2 visits and met 3 people.', tomorrow: '' } : goodNarrative; } });
    const r = await RECAP(w, 'auto');
    assert.strictEqual(n, 2); assert.strictEqual(r.body.generated, true); assert.strictEqual(r.body.attempts, 2);
    assert.ok(/do not match the counted facts \(2 visits/.test(prompts[1]) && /1 visits completed/.test(prompts[1]), prompts[1].slice(-600));
    let m = 0;
    const w2 = W({ ai: () => { m++; return { narrative: m === 1 ? 'You added deals worth $5,000.' : 'Your win rate rose 40%.', tomorrow: '' }; } });
    const f = await RECAP(w2, 'auto');
    assert.strictEqual(m, 2); assert.strictEqual(f.body.ai_failed, true); assert.strictEqual(f.body.ai_error, 'numbers_mismatch');
    assert.strictEqual(f.body.brief, null); assert.ok(f.body.rule_text); assert.deepStrictEqual(f.body.facts, GREG);
    assert.strictEqual(rows(w2, 'greg@hcps.us', 'eod')[0].status, 'failed');
    const again = await RECAP(w2, 'auto');
    assert.strictEqual(m, 2, 'retried inside 10 minutes'); assert.strictEqual(again.body.too_soon, true);
  });

  await t('Stale: when the day moves on (another task done), the stored recap is flagged; Refresh waits out the 10 minutes', async () => {
    // The fake AI quotes whatever "tasks completed" the FACTS block says — so the rewrite must carry the new count.
    const narrFor = p => { const k = +((/tasks completed: (\d+)/.exec(p) || [])[1]); return { narrative: 'You completed 1 of 2 visits and ' + k + ' tasks today.', tomorrow: '' }; };
    let stuck = false;
    const w = W({ ai: b => stuck ? { narrative: 'You completed 1 of 2 visits and 2 tasks today.', tomorrow: '' } : narrFor(b.messages[0].content) });
    const first = await RECAP(w, 'auto'); assert.ok(/ 2 tasks/.test(first.body.brief.narrative));
    const t2 = w.db.dealer_tasks.find(x => x.id === 't-o2'); t2.status = 'done'; t2.done_at = now();
    const c = await RECAP(w, 'check'); assert.strictEqual(c.body.stale, true); assert.strictEqual(c.body.facts.tasks_completed, 3);
    assert.ok(/ 2 tasks/.test(c.body.brief.narrative), 'the stored recap is still shown while stale');
    const r1 = await RECAP(w, 'refresh'); assert.strictEqual(r1.body.too_soon, true); assert.strictEqual(aiCalls(w), 1);
    back(w, 'greg@hcps.us', 9 * 60e3); assert.strictEqual((await RECAP(w, 'refresh')).body.too_soon, true);
    back(w, 'greg@hcps.us', 2 * 60e3);
    const r2 = await RECAP(w, 'refresh');
    assert.strictEqual(r2.body.generated, true, JSON.stringify(r2.body).slice(0, 300)); assert.strictEqual(aiCalls(w), 2);
    assert.ok(/ 3 tasks/.test(r2.body.brief.narrative)); assert.strictEqual(r2.body.brief.facts.tasks_completed, 3); assert.ok(!r2.body.stale);
    // A rewrite that keeps quoting the OLD count is rejected twice; the old recap stays stored (marked stale), nothing fake replaces it.
    const t3 = w.db.dealer_tasks.find(x => x.id === 't-old'); t3.status = 'done'; t3.done_at = now();
    back(w, 'greg@hcps.us', 11 * 60e3); stuck = true;
    const r3 = await RECAP(w, 'refresh');
    assert.strictEqual(aiCalls(w), 4); assert.strictEqual(r3.body.ai_failed, true); assert.strictEqual(r3.body.ai_error, 'numbers_mismatch');
    assert.ok(r3.body.brief && / 3 tasks/.test(r3.body.brief.narrative), 'the last good recap is kept'); assert.strictEqual(r3.body.facts.tasks_completed, 4);
    const row = rows(w, 'greg@hcps.us', 'eod')[0]; assert.strictEqual(row.status, 'ready'); assert.ok(/ 3 tasks/.test(row.content.narrative));
  });

  await t('Management and Relations READ a rep\'s stored recap; they cannot write one in his name (also not as a dry run)', async () => {
    const w = W();
    await RECAP(w, 'auto'); const before = JSON.stringify(rows(w, 'greg@hcps.us', 'eod')[0]);
    for (const tok of ['pres', 'lori']) {
      const c = await RECAP(w, 'check', tok, false, { rep: 'greg@hcps.us' });
      assert.strictEqual(c.status, 200); assert.strictEqual(c.body.person, 'greg@hcps.us'); assert.strictEqual(c.body.can_generate, false);
      assert.strictEqual(c.body.brief.narrative, goodNarrative.narrative); assert.deepStrictEqual(c.body.facts, GREG);
      for (const mode of ['auto', 'refresh']) {
        const x = await RECAP(w, mode, tok, false, { rep: 'greg@hcps.us' }); assert.strictEqual(x.status, 403); assert.strictEqual(x.body.code, 'not_yours');
        const dry = await RECAP(w, mode, tok, false, { rep: 'greg@hcps.us', dry_run: true }); assert.strictEqual(dry.status, 403);
      }
      const d = await TODAYCALL(w, tok, false, { rep: 'greg@hcps.us' });
      assert.strictEqual(d.body.eod_recap.can_generate, false); assert.strictEqual(d.body.eod_recap.brief.narrative, goodNarrative.narrative);
    }
    assert.strictEqual(aiCalls(w), 1); assert.strictEqual(JSON.stringify(rows(w, 'greg@hcps.us', 'eod')[0]), before);
    assert.strictEqual(rows(w, null, 'eod').length, 1, 'a recap was written for someone');
  });

  await t('A rep naming Angelo gets his own recap; a dry run of his own writes nothing', async () => {
    const w = W();
    const c = await RECAP(w, 'check', 'greg', false, { rep: 'angelo@hcps.us' });
    assert.strictEqual(c.body.person, 'greg@hcps.us'); assert.deepStrictEqual(c.body.facts, GREG);
    const d = await RECAP(w, 'refresh', 'greg', false, { dry_run: true });
    assert.strictEqual(d.body.dry_run, true); assert.strictEqual(d.body.kind, 'eod'); assert.strictEqual(aiCalls(w), 0); assert.strictEqual(rows(w).length, 0);
  });

  await t('Angelo — My Sales Workspace and Admin view: his own day only (never Greg\'s visits or deals); one recap per day', async () => {
    let prompt = '';
    const w = W({ ai: b => { prompt = b.messages[0].content; return { narrative: 'You completed 1 visit and met 1 person, and completed 1 task.', tomorrow: '' }; } });
    for (const ws of [true, false]) {
      const c = await RECAP(w, 'check', 'pres', ws);
      assert.strictEqual(c.body.person, 'angelo@hcps.us');
      assert.strictEqual(c.body.facts.visits_completed, 1); assert.strictEqual(c.body.facts.people_met, 1); assert.strictEqual(c.body.facts.tasks_completed, 1);
      assert.strictEqual(c.body.facts.opportunities_created, 0);
    }
    const r = await RECAP(w, 'auto', 'pres', true); assert.strictEqual(r.body.generated, true);
    assert.ok(!/Glasgow|Rita|Scooter/.test(prompt), 'Greg\'s day in Angelo\'s recap');
    const adm = await RECAP(w, 'auto', 'pres', false);
    assert.strictEqual(aiCalls(w), 1); assert.strictEqual(adm.body.brief.narrative, r.body.brief.narrative);
    assert.strictEqual(rows(w, 'angelo@hcps.us', 'eod').length, 1);
  });

  await t('The recap and the Morning Brief are separate rows; turning the brief off leaves the recap alone', async () => {
    const w = W({ flags: { key: 'phase2_flags', value: { morning_brief: false, eod_recap: true } } });
    const r = await RECAP(w, 'auto'); assert.strictEqual(r.body.generated, true);
    const b = await CC(w, { action: 'brief', mode: 'auto' }); assert.strictEqual(b.status, 403);
    assert.strictEqual(rows(w, 'greg@hcps.us', 'eod').length, 1); assert.strictEqual(rows(w, 'greg@hcps.us', 'morning').length, 0);
  });

  await t('Before the table exists: today still loads; the recap says what to run', async () => {
    const w = W({ missing: true });
    const d = await TODAYCALL(w); assert.strictEqual(d.status, 200); assert.strictEqual(d.body.eod_recap.storage_missing, true);
    const r = await RECAP(w, 'check'); assert.strictEqual(r.status, 503); assert.strictEqual(r.body.error, 'storage_missing');
  });

  await t('Counting: a person met twice is one person; a dismissed task is not "completed"; tasks from an older visit are not "created today"', async () => {
    const w = W();
    w.db.dealer_visit_participants.push({ visit_report_id: 'v2', name_snapshot: 'Rita Owner' });
    w.db.dealer_tasks.push({ id: 't-dis', dealer_id: 'd-greg', title: 'Dismissed today', status: 'dismissed', done_at: now(), assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us' });
    w.db.dealer_visit_reports.push({ id: 'v-old', route_id: null, dealer_id: 'd-greg', rep_email: 'greg@hcps.us', rep_name: 'Greg Campbell', checkin_at: dayStr(-5) + 'T15:00:00Z', completed_at: dayStr(-5) + 'T16:00:00Z', approved_at: dayStr(-5) + 'T16:00:00Z', status: 'completed', followup_status: 'pending', followup_due: YDAY, summary: { meeting_summary: 'Older visit.' } });
    w.db.dealer_tasks.push({ id: 't-vold', dealer_id: 'd-greg', title: 'From the older visit', status: 'open', due_date: dayStr(5), origin_type: 'visit_report', origin_id: 'v-old', assigned_rep: 'Greg Campbell', assigned_email: 'greg@hcps.us', created_at: dayStr(-5) });
    const c = await RECAP(w, 'check');
    const F = c.body.facts;
    assert.strictEqual(F.people_met, 3, 'Rita counted twice'); assert.strictEqual(F.tasks_completed, 2, 'a dismissed task counted as completed');
    assert.strictEqual(F.followup_tasks_created, 2, 'a task from an older visit counted as created today');
    assert.strictEqual(F.unresolved_followups, 2); assert.strictEqual(F.open_visit_tasks, 2);   // the older visit is still open work
    assert.strictEqual(aiCalls(w), 0);
  });

  /* ---- the number check, directly ---- */
  await t('checkNumbers: each number must be the count of what it sits next to; money, percentages, dates, times', () => {
    const f = { visits_completed: 2, visits_started: 3, people_met: 4, commitments: 3, rep_commitments: 2, dealer_commitments: 1, followup_tasks_created: 2, tasks_completed: 1, opportunities_created: 1,
      pipeline_added: 539, pipeline_value: 1798, emails_sent: 1, emails_drafted: 0, unresolved_followups: 2, open_visit_tasks: 2, overdue_tasks: 0, tomorrow_stops: 4, tasks_due_tomorrow: 1 };
    const cases = [['You completed 2 of 3 visits and met 4 people.', true], ['You completed 3 visits.', false], ['You started 3 visits and finished 2.', true],
      ['Two follow-up tasks were created and one task completed.', true], ['You created 1 follow-up task.', false], ['2 visit follow-ups remain open.', true],
      ['You sent 1 email and left 0 in draft.', true], ['You sent 2 emails.', false], ['You met 3 people.', false], ['Three follow-ups remain open.', false],
      ['You added 1 deal worth $1,798 ($539 weighted).', true], ['$5,000 added.', false], ['$1.8k in deals.', true], ['Up 25%.', false],
      ['1 overdue task remains.', false], ['You have 4 stops tomorrow.', true], ['You made 3 commitments, 2 of them yours.', true],
      ['On October 5 at 4:30 pm you met Rita.', true], ['One of the dealers asked for pricing.', true], ['You logged 7 calls.', false], ['Route 66 Medical asked for pricing.', true],
      // the verb carries across "and": "completed … and 2 tasks" is a completed count (1 here), not the 2 follow-up tasks created
      ['You completed 2 of 3 visits and 2 tasks.', false], ['You completed 2 visits and 1 task.', true], ['You completed 2 visits, 2 tasks.', false],
      ['You completed 2 visits and 2 follow-up tasks are open.', true], ['You completed 2 visits. Then 2 follow-up tasks.', true]];
    for (const [s, ok] of cases) assert.strictEqual(BAI.checkNumbers(s, f, { nameNums: [66] }).ok, ok, s);
  });

  await t('recapKey and ruleRecap: same facts → same key, any count changed → new key; the plain recap uses the counts', () => {
    const day = { header: { date: TODAY, rep: { name: 'G' }, followups_pending: 1, overdue: 0 }, end_of_day: { followup_emails_sent: 1, followup_emails_drafted: 0 }, tomorrow: { stops: 0 },
      _recap: { visits: [{ status: 'done', attendees: ['A'], rep_commitments: ['x'], dealer_commitments: [] }], tasks_created: [{}], tasks_completed: [{}], opportunities_created: [{ value: 100, stage: 'quoted' }], open_visit_tasks: 0 } };
    const i = BAI.recapInputs(day, {});
    assert.strictEqual(i.facts.pipeline_added, 60); assert.strictEqual(i.facts.people_met, 1);
    const k0 = BAI.recapKey(i);
    const d2 = JSON.parse(JSON.stringify(day)); d2._recap.tasks_completed.push({}); assert.notStrictEqual(BAI.recapKey(BAI.recapInputs(d2, {})), k0);
    assert.strictEqual(BAI.recapKey(BAI.recapInputs(JSON.parse(JSON.stringify(day)), {})), k0);
    const t = BAI.ruleRecap(i);
    assert.ok(/You completed 1 of 1 visit today and met 1 person\./.test(t) && /\$60 in weighted pipeline/.test(t), t);
    assert.ok(BAI.checkNumbers(t, i.facts, { nameNums: [] }).ok, 'the plain recap fails its own check: ' + t);
  });

  done('Phase 2C end-of-day recap');
})();

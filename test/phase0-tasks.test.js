/* Phase 0I / 0J: tasks and opportunities. Priority order, ownership by email (beside the name),
   who completed a task, honest "tasks completed" counts — and everything keeps working on a
   database that has not run supabase/phase0_task_owner_email.sql yet (seed.columns). */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done } = require('./phase0-mock');

const TASK_COLS_OLD = ['id', 'dealer_id', 'title', 'detail', 'due_date', 'status', 'priority', 'source', 'reason', 'assigned_rep', 'created_by', 'created_at', 'done_at', 'env', 'zoho_synced_at'];
const OPP_COLS_OLD = ['id', 'dealer_id', 'title', 'line', 'stage', 'value', 'probability', 'expected_close', 'owner_rep', 'source', 'notes', 'status', 'created_by', 'created_at', 'updated_at', 'zoho_id'];
const T = (id, o) => Object.assign({ id, dealer_id: 'd-greg', title: id, status: 'open', priority: 'normal', assigned_rep: 'Greg Campbell', created_at: '2026-09-01T00:00:00Z' }, o || {});
function seed(extra, old) {
  const S = standardSeed(extra || {});
  if (old) S.columns = { dealer_tasks: TASK_COLS_OLD, opportunities: OPP_COLS_OLD };
  return S;
}
const ids = r => (r.body.tasks || []).map(x => x.id);

(async () => {
  await t('0I tasks list high → normal → low, then nearest due date, then newest', async () => {
    const w = createWorld(seed({ dealer_tasks: [
      T('low', { priority: 'low' }), T('normal-old', { created_at: '2026-08-01T00:00:00Z' }), T('normal-new', { created_at: '2026-09-15T00:00:00Z' }),
      T('high-nodue', { priority: 'high' }), T('high-due', { priority: 'high', due_date: '2026-10-10' }), T('normal-due', { due_date: '2026-10-03' }) ] }));
    const r = await call(load('crm-api.js', w), { action: 'my_tasks' }, { token: 'greg' });
    assert.deepStrictEqual(ids(r), ['high-due', 'high-nodue', 'normal-due', 'normal-new', 'normal-old', 'low']);
  });
  await t('0I a rep\'s list: tasks assigned to their email count even if the name is stale; nobody else\'s', async () => {
    const w = createWorld(seed({ dealer_tasks: [
      T('by-name'), T('by-email', { assigned_rep: 'Gregory C.', assigned_email: 'greg@hcps.us' }), T('angelo', { assigned_rep: 'Angelo Audia', assigned_email: 'angelo@hcps.us' }),
      T('name-but-other-email', { assigned_rep: 'Greg Campbell', assigned_email: 'someone@else.test' }) ] }));
    const r = await call(load('crm-api.js', w), { action: 'my_tasks' }, { token: 'greg' });
    assert.deepStrictEqual(ids(r).sort(), ['by-email', 'by-name', 'name-but-other-email'].sort());
  });
  await t('0I who sees which tasks — and the badge always matches the list', async () => {
    const tasks = [T('g1'), T('g2', { assigned_rep: null, assigned_email: 'greg@hcps.us' }), T('a1', { assigned_rep: 'Angelo Audia' }),
      T('none1', { assigned_rep: null }), T('house', { assigned_rep: 'House (unassigned)' })];
    const S = seed({ dealer_tasks: tasks });
    S.tokens.blank = 'blank@hcps.us'; S.tokens.blank2 = 'blank2@hcps.us';
    S.tables.staff_users.push({ email: 'blank@hcps.us', name: 'No Book', role: 'rep', rep_name: '', active: true }, { email: 'blank2@hcps.us', name: 'Spaces', role: 'rep', rep_name: '   ', active: true });
    const w = createWorld(S);
    const expect = { pres: 5, lori: 5, greg: 2, blank: 0, blank2: 0 };
    for (const [tok, n] of Object.entries(expect)) {
      const list = await call(load('crm-api.js', w), { action: 'my_tasks' }, { token: tok });
      assert.strictEqual(list.body.tasks.length, n, tok + ' list ' + list.body.tasks.length);
      const badge = await call(load('crm-api.js', w), { action: 'task_count' }, { token: tok });
      if (tok !== 'pres' && tok !== 'lori') assert.strictEqual(badge.body.count, n, tok + ' badge ' + badge.body.count);
    }
    const g = await call(load('crm-api.js', w), { action: 'my_tasks' }, { token: 'greg' });
    assert.ok(!g.body.tasks.some(x => !x.assigned_rep && !x.assigned_email), 'unowned tasks are not a rep\'s');
    const run = await call(load('crm-api.js', w), { action: 'run_followups' }, { token: 'lori' });
    assert.strictEqual(run.status, 403, 'engine controls stay president-only');
  });
  await t('0I a rep\'s tasks are found past the first 1000 rows', async () => {
    const many = []; for (let i = 0; i < 1100; i++) many.push(T('x' + String(i).padStart(4, '0'), { assigned_rep: 'Angelo Audia' }));
    many.push(T('zz-greg'));
    const w = createWorld(seed({ dealer_tasks: many }));
    const r = await call(load('crm-api.js', w), { action: 'my_tasks' }, { token: 'greg' });
    assert.deepStrictEqual(ids(r), ['zz-greg']);
    const all = await call(load('crm-api.js', w), { action: 'my_tasks' }, { token: 'lori' });
    assert.strictEqual(all.body.tasks.length, 1101, 'relations list cut at ' + all.body.tasks.length);
  });
  await t('0I before the migration the list still works by name', async () => {
    const w = createWorld(seed({ dealer_tasks: [T('mine'), T('theirs', { assigned_rep: 'Angelo Audia' })] }, true));
    const r = await call(load('crm-api.js', w), { action: 'my_tasks' }, { token: 'greg' });
    assert.deepStrictEqual(ids(r), ['mine']);
  });
  await t('0I completing records who did it; reopening clears it', async () => {
    const w = createWorld(seed({ dealer_tasks: [T('t1')] }));
    await call(load('crm-api.js', w), { action: 'complete_task', id: 't1' }, { token: 'greg' });
    let x = w.db.dealer_tasks[0]; assert.strictEqual(x.status, 'done'); assert.strictEqual(x.completed_by, 'greg@hcps.us');
    await call(load('crm-api.js', w), { action: 'reopen_task', id: 't1' }, { token: 'greg' });
    x = w.db.dealer_tasks[0]; assert.strictEqual(x.status, 'open'); assert.strictEqual(x.completed_by, null);
  });
  await t('0I completing still works before the migration', async () => {
    const w = createWorld(seed({ dealer_tasks: [T('t1')] }, true));
    const r = await call(load('crm-api.js', w), { action: 'complete_task', id: 't1' }, { token: 'greg' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(w.db.dealer_tasks[0].status, 'done');
  });
  await t('0I the task\'s email assignee may close it even when the name differs', async () => {
    const w = createWorld(seed({ dealer_tasks: [T('t1', { dealer_id: 'd-ang', assigned_rep: 'G. Campbell', assigned_email: 'greg@hcps.us' })] }));
    const r = await call(load('crm-api.js', w), { action: 'complete_task', id: 't1' }, { token: 'greg' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });
  await t('0I the engine\'s dismissals are marked "system" (and still work before the migration)', async () => {
    for (const old of [false, true]) {
      const w = createWorld(seed({ dealer_tasks: [T('auto1', { source: 'auto', reason: 'overdue:golden' })], app_settings: [{ key: 'platform', value: { mode: 'development' } }] }, old));
      const E = load('_engine.js', w);
      const out = await E.runTasks({ dealers: new Map() });
      assert.strictEqual(out.dismissed, 1, 'old=' + old);
      assert.strictEqual(w.db.dealer_tasks[0].status, 'dismissed');
      assert.strictEqual(w.db.dealer_tasks[0].completed_by, old ? undefined : 'system');
    }
  });
  await t('0I "tasks completed" counts real completions by the person who did them', async () => {
    const now = new Date().toISOString();
    const w = createWorld(seed({ dealer_tasks: [
      T('done-by-greg', { status: 'done', done_at: now, completed_by: 'greg@hcps.us', assigned_rep: 'Angelo Audia' }),
      T('done-by-greg-2', { status: 'done', done_at: now, completed_by: 'greg@hcps.us', assigned_rep: 'Lori Hunt' }),
      T('dismissed-by-engine', { status: 'dismissed', done_at: now, completed_by: 'system' }),
      T('done-by-angelo', { status: 'done', done_at: now, completed_by: 'angelo@hcps.us', assigned_rep: 'Greg Campbell' }),   // assigned to Greg, done by Angelo
      T('old-row-done', { status: 'done', done_at: now }),
      T('dismissed-old-row', { status: 'dismissed', done_at: now }) ] }));
    const r = await call(load('rep-usage-api.js', w), { action: 'summary', days: 30 }, { token: 'pres' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const reps = r.body.reps || r.body.rows || r.body.people || [];
    const g = reps.find(x => x.email === 'greg@hcps.us');
    assert.ok(g, 'no row for Greg: ' + JSON.stringify(r.body).slice(0, 300));
    assert.strictEqual(g.tasks_completed, 3, 'greg completed ' + g.tasks_completed);   // done-by-greg, done-by-greg-2, old-row-done
  });
  await t('0J a rep\'s new deal carries their email; the board shows deals owned by email', async () => {
    const w = createWorld(seed({ opportunities: [{ id: 'o-email', dealer_id: 'd-ang', title: 'x', stage: 'identified', status: 'open', owner_rep: 'G. C.', owner_email: 'greg@hcps.us', value: 1 }] }));
    const add = await call(load('pipeline-api.js', w), { action: 'add', dealer_id: 'd-greg', title: 'New deal' }, { token: 'greg' });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    assert.strictEqual(w.db.opportunities.find(o => o.title === 'New deal').owner_email, 'greg@hcps.us');
    const b = await call(load('pipeline-api.js', w), { action: 'board' }, { token: 'greg' });
    assert.ok((b.body.opportunities || []).some(o => o.id === 'o-email'), 'email-owned deal missing from the board');
    const u = await call(load('pipeline-api.js', w), { action: 'update', id: 'o-email', stage: 'contacted' }, { token: 'greg' });
    assert.strictEqual(u.status, 200, 'owner by email could not update: ' + JSON.stringify(u.body));
  });
  await t('0J adding a deal still works before the migration', async () => {
    const w = createWorld(seed({}, true));
    const add = await call(load('pipeline-api.js', w), { action: 'add', dealer_id: 'd-greg', title: 'New deal' }, { token: 'greg' });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    assert.strictEqual(w.db.opportunities.find(o => o.title === 'New deal').owner_rep, 'Greg Campbell');
  });
  await t('0J a rep still cannot touch someone else\'s deal', async () => {
    const w = createWorld(seed({ opportunities: [{ id: 'o-ang', dealer_id: 'd-ang', title: 'x', stage: 'identified', status: 'open', owner_rep: 'Angelo Audia', owner_email: 'angelo@hcps.us', value: 1 }] }));
    const u = await call(load('pipeline-api.js', w), { action: 'update', id: 'o-ang', stage: 'won' }, { token: 'greg' });
    assert.strictEqual(u.status, 403);
  });

  done('0I/0J tasks + opportunities');
})();

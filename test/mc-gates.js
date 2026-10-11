/* Test helper (Manufacturer Center Phase 6): go through the two approval gates exactly as the president does
   in Manufacturer Center — dry run, approve what it showed, then write with that approval. Used by every test
   that writes staged records or switches authority on, so those tests keep proving what they always proved,
   now behind the gates. */
async function approvedStage(call, C, body, reason){
  const dry = await call(C, Object.assign({}, body, { dry_run: true }));
  if (dry.status !== 200) return dry;                       // the dry run's own refusal is the answer
  const ap = await call(C, { action: 'mc_approve_gate', manufacturer: body.manufacturer, gate: 'stage',
    plan_hash: dry.body.plan_hash, plan_kind: dry.body.plan_kind || 'records', reason: reason || 'test: approve the dry run' });
  if (ap.status !== 200) return ap;
  return call(C, Object.assign({}, body, { approval_decision_id: ap.body.approval.id }));
}
/* Gate 2 needs a passing pre-activation run newer than every record change. Tests that are not about
   verification seed one (the verification suite itself is proven in mcverify.test.js and mcflow.test.js). */
async function approvedActivate(call, C, W, body){
  W.db.mfr_verification_runs = W.db.mfr_verification_runs || [];
  const id = 900000 + W.db.mfr_verification_runs.length + 1;
  W.db.mfr_verification_runs.push({ id, manufacturer: body.manufacturer, phase: 'pre', result: 'pass', checks: [], fingerprint: 'seeded-for-test', run_at: new Date(Date.now() + 1000).toISOString() });
  const ap = await call(C, { action: 'mc_approve_gate', manufacturer: body.manufacturer, gate: 'activate', run_id: id, reason: 'test: approve activation' });
  if (ap.status !== 200) return ap;
  return call(C, Object.assign({}, body, { approval_decision_id: ap.body.approval.id }));
}
module.exports = { approvedStage, approvedActivate, SERIAL: ['mfr_decisions', 'mfr_verification_runs', 'mfr_sources'] };

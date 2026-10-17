/* HCPS Academy — mail worker for sign-in codes (A2B security review S1). A Netlify BACKGROUND function (the
   "-background" name): the caller gets 202 at once and this runs afterwards, so the sign-in answer never waits for the
   email provider. It accepts only a job sealed by _academy_session.sealJob with ACADEMY_SESSION_SECRET (AES-256-GCM,
   at most 2 minutes old); anything else is dropped without a word. Decoys (unknown addresses) are dropped too.
   A real job is sent only while its code is still usable (not used, burned or expired), so a replayed job can never
   send a dead code. If the email cannot be sent, the code is burned and stops counting toward the limits
   (academy_access_op_code_undelivered), so the person can simply ask again — it never strands them.
   It never throws (Netlify retries a failed background run, which could otherwise send the same code twice). */
const A = require('./_academy.js');
const MAIL = require('./_academy_mail.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run(event) {
  if (!event || event.httpMethod !== 'POST') return 'method';
  const job = A.SESSION.openJob(String(event.body || ''), 120);
  if (!job) return 'rejected';
  if (job.k !== 'code') return 'decoy';
  if (!UUID.test(String(job.id)) || !/^\d{6}$/.test(String(job.code)) || !/^[0-9a-f]{64}$/.test(String(job.h))) return 'rejected';
  const rows = await A.sbGet(`academy_login_codes?id=eq.${encodeURIComponent(job.id)}&code_hash=eq.${job.h}&select=email,used_at,burned_at,expires_at,undelivered`);
  const c = rows && rows[0];
  if (!c || c.used_at || c.burned_at || c.undelivered || !(Date.parse(c.expires_at) > Date.now()) || c.email !== job.to) return 'stale';
  const sent = await MAIL.send(job.to, MAIL.codeMessage(job.code));
  if (sent.sent) return 'sent';
  await A.accessOp('access_op_code_undelivered', { p_code_id: job.id, p_code_hash: job.h });
  console.warn('[academy] sign-in code not delivered:', sent.reason);   // never the code, never the address
  return 'undelivered';
}

exports.handler = async event => {
  let outcome;
  try { outcome = await run(event); } catch (e) { outcome = 'error'; console.warn('[academy] mail worker error'); }
  return { statusCode: 202, headers: { 'cache-control': 'no-store' }, body: '' };
};
exports._run = run;

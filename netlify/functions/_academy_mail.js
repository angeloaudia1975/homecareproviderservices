/* HCPS Academy — learner emails (A2B). Two messages only: the 6-digit sign-in code and the invitation.
   Sent through the existing Resend setup (RESEND_API_KEY). Nothing is sent unless ACADEMY_MAIL_FROM is set: the
   Academy's sender address and this wording are Angelo's approval point (Learner Launch plan, decision H), so until he
   sets it no Academy email can leave, whatever the switches say. Every message is plain and carries no link that
   signs anyone in (the code is typed; the invitation only points to the sign-in page). */
const SIGN_IN_URL = 'https://www.homecareproviderservices.org/academy/';

function configured() { return !!(process.env.RESEND_API_KEY && process.env.ACADEMY_MAIL_FROM); }
const escape = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function codeMessage(code) {
  const text = `Your HCPS Academy sign-in code is ${code}\n\nIt works once, for 10 minutes. If you did not ask for it, ignore this email: nobody can sign in without the code.\n\nHCPS Training & Certification Academy\n${SIGN_IN_URL}`;
  const html = `<p>Your HCPS Academy sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${escape(code)}</p>`
    + `<p>It works once, for 10 minutes. If you did not ask for it, ignore this email: nobody can sign in without the code.</p>`
    + `<p>HCPS Training &amp; Certification Academy</p>`;
  return { subject: `${code} is your HCPS Academy sign-in code`, text, html };
}
function inviteMessage({ dealerName, inviterName }) {
  const who = inviterName ? `${inviterName} has` : 'You have been';
  const text = `${who} invited you to the HCPS Training & Certification Academy for ${dealerName}.\n\nTo start, open ${SIGN_IN_URL} and sign in with this email address. We will email you a 6-digit code; there is no password.\n\nThe invitation is valid for 14 days.`;
  const html = `<p>${escape(who)} invited you to the HCPS Training &amp; Certification Academy for <b>${escape(dealerName)}</b>.</p>`
    + `<p>To start, open <a href="${SIGN_IN_URL}">${SIGN_IN_URL}</a> and sign in with this email address. We will email you a 6-digit code; there is no password.</p>`
    + `<p>The invitation is valid for 14 days.</p>`;
  return { subject: 'Your HCPS Academy invitation', text, html };
}

/* Returns {sent:true} | {sent:false, reason}. Never throws, never logs the code. */
async function send(to, msg, fetchImpl) {
  if (!configured()) return { sent: false, reason: 'not_configured' };
  try {
    const r = await (fetchImpl || fetch)('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.ACADEMY_MAIL_FROM, to: [to], subject: msg.subject, text: msg.text, html: msg.html }) });
    return r.ok ? { sent: true } : { sent: false, reason: 'provider_' + r.status };
  } catch (e) { return { sent: false, reason: 'unreachable' }; }
}

/* Hands a sealed job to the mail worker (academy-mail-background, a Netlify background function: it answers 202 at
   once and sends afterwards). Used for EVERY sign-in code request, known address or not, so the visitor's wait does
   not depend on the email provider. Returns true when the worker accepted the job. Never throws. */
const WORKER_PATH = '/.netlify/functions/academy-mail-background';
function workerUrl() { return String(process.env.URL || 'https://www.homecareproviderservices.org').replace(/\/+$/, '') + WORKER_PATH; }
async function dispatch(sealed, fetchImpl) {
  if (!sealed) return false;
  try {
    const r = await (fetchImpl || fetch)(workerUrl(), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: sealed });
    return r.status === 202 || r.ok;
  } catch (e) { return false; }
}

module.exports = { configured, codeMessage, inviteMessage, send, dispatch, workerUrl, WORKER_PATH, SIGN_IN_URL };

// Smart Email Learning — daily job.
// 1. Retention (owner decision 4, 2026-10-30): clear the email text of every draft older than 12 months
//    (hcps_email_draft_purge_expired). Runs whatever the switches say: text already kept must still be removed on time.
// 2. Learning (Phase 2): only while phase2_flags.email_learning_suggest is exactly true, look for repeated edits and record
//    them as SUGGESTIONS for the owner (_email_learn_run.js). A suggestion changes no email; only the owner approves a rule,
//    and approved rules are applied to drafts only in Phase 3. Pure code — no AI, nothing leaves HCPS.
// Before a migration is installed its step does nothing. It never sends, changes or reads out an email.
const { flagOn } = require("./_flags.js");
const RUN = require("./_email_learn_run.js");

exports.handler = async () => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return { statusCode: 200, body: JSON.stringify({ skipped: "not configured" }) };
  const H = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const out = {};
  let failed = false;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/hcps_email_draft_purge_expired`, { method: "POST", headers: H, body: "{}" });
    const t = await r.text();
    if (r.status === 404 && /PGRST202|Could not find the function/i.test(t)) out.purge = "not installed";
    else if (!r.ok) { console.error("email-learning-purge-cron purge", r.status, t.slice(0, 200)); out.purge = "failed"; failed = true; }
    else out.cleared = Number(t) || 0;
  } catch (e) { console.error("email-learning-purge-cron purge", String(e && e.message || e).slice(0, 200)); out.purge = "failed"; failed = true; }

  const sbGet = async path => { const r = await fetch(`${url}/rest/v1/${path}`, { headers: H });
    if (!r.ok) { const e = new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; } return r.json(); };
  try {
    if (!(await flagOn(sbGet, RUN.SWITCH_SUGGEST))) out.learning = "switch off";
    else {
      const rpc = async (fn, p) => { const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify({ p }) });
        const t = await r.text(); if (!r.ok) throw new Error(`rpc ${fn} ${r.status}`); return t ? JSON.parse(t) : null; };
      try { await sbGet("email_learning_rules?select=id&limit=1"); }
      catch (e) { if (e.status === 404 || /PGRST205|42P01/.test(String(e.message))) { out.learning = "not installed"; return { statusCode: 200, body: JSON.stringify(out) }; } throw e; }
      out.learning = (await RUN.runAnalysis(sbGet, rpc, { apply: true })).summary;
    }
  } catch (e) { console.error("email-learning-purge-cron learning", String(e && e.message || e).slice(0, 200)); out.learning = "failed"; failed = true; }
  return { statusCode: failed ? 500 : 200, body: JSON.stringify(Object.assign({ ok: !failed }, out)) };
};

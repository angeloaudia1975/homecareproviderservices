// Smart Email Learning — retention (owner decision 4, 2026-10-30): once a day, clear the email text of every draft older
// than 12 months (hcps_email_draft_purge_expired). Runs whatever the capture switch says: text already kept must still be
// removed on time. Before the migration is installed it does nothing. It never sends, changes or reads an email.
exports.handler = async () => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return { statusCode: 200, body: JSON.stringify({ skipped: "not configured" }) };
  try {
    const r = await fetch(`${url}/rest/v1/rpc/hcps_email_draft_purge_expired`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" });
    const t = await r.text();
    if (r.status === 404 && /PGRST202|Could not find the function/i.test(t)) return { statusCode: 200, body: JSON.stringify({ skipped: "not installed" }) };
    if (!r.ok) { console.error("email-learning-purge-cron", r.status, t.slice(0, 200)); return { statusCode: 500, body: JSON.stringify({ error: "purge_failed" }) }; }
    return { statusCode: 200, body: JSON.stringify({ ok: true, cleared: Number(t) || 0 }) };
  } catch (e) { console.error("email-learning-purge-cron", String(e && e.message || e).slice(0, 200)); return { statusCode: 500, body: JSON.stringify({ error: "purge_failed" }) }; }
};

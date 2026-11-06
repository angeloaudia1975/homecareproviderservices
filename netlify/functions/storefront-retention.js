// C3-07 Stage 7 (D4) — daily: storefront inquiry contacts are deleted once they are 24 months old (storefront_purge()).
// Scheduled in netlify.toml; does nothing before the Stage 7 SQL is installed.
const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_ROLE) return { statusCode: 500, body: 'not configured' };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/storefront_purge`, { method: 'POST', headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, 'content-type': 'application/json' }, body: '{}' });
  const t = await r.text();
  if (!r.ok) { if (/PGRST202|42883/.test(t)) return { statusCode: 200, body: 'not installed' }; console.error('storefront purge failed', r.status); return { statusCode: 502, body: 'failed' }; }
  console.log('storefront inquiries deleted:', t);
  return { statusCode: 200, body: 'ok ' + t };
};

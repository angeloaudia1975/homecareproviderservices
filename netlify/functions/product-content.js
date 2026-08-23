/**
 * Partner 360 · product-content write/read API  (Connect 360 / main-site deploy)
 *
 * AUTH: Connect 360 staff sign-in. The review screen sends the staff JWT as
 * `Authorization: Bearer <token>`; whoami() verifies it against Supabase Auth and the
 * staff_users table, and admin roles (president/admin/owner) may read drafts and write.
 * A legacy `x-admin-token` matching CONTENT_ADMIN_TOKEN still works for the importer/CLI.
 *
 * - Public GET (no auth): approved content only — same gate as RLS (dealers/portal).
 * - Admin GET:  ALL rows (drafts + approved) for the review queue.
 * - Admin POST: approve / reject / approve_all / upsert / ingest_source / merge — via the
 *   SUPABASE_SERVICE_ROLE key (bypasses RLS). Service key is a SERVER-ONLY secret.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE (both already set on this deploy);
 *      CONTENT_ADMIN_TOKEN optional (legacy importer fallback only).
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ADMIN_TOKEN  = process.env.CONTENT_ADMIN_TOKEN;
const { computeMerge } = require('./_content-merge.js');

const ADMIN_ROLES = { president: 1, admin: 1, owner: 1 };
const enc = encodeURIComponent;

// Connect 360 staff auth: verify the Bearer JWT against Supabase Auth, resolve the role
// from staff_users. Returns { role } for an active staff user, else null. Mirrors the
// whoami() used by the other Connect 360 admin functions (featured-api, images-api, …).
async function whoami(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const tok = auth.replace(/^Bearer\s+/i, '').trim();
  if (tok) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: 'Bearer ' + tok } });
      if (r.ok) {
        const u = await r.json();
        const email = u && u.email && String(u.email).toLowerCase();
        if (email) {
          const sr = await fetch(`${SUPABASE_URL}/rest/v1/staff_users?email=eq.${enc(email)}&select=*`, { headers: svcHeaders() });
          const s = sr.ok ? await sr.json() : [];
          const su = s && s[0];
          if (su && su.active !== false) return { role: su.role || 'rep', email: email };
        }
      }
    } catch (e) { /* fall through */ }
    return null;
  }
  // Legacy fallback: importer/CLI passcode.
  if (ADMIN_TOKEN && (event.headers['x-admin-token'] || event.headers['X-Admin-Token']) === ADMIN_TOKEN) return { role: 'president', email: 'importer' };
  return null;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
  'Content-Type': 'application/json'
};
const reply = (code, body) => ({ statusCode: code, headers: CORS, body: JSON.stringify(body) });

function svcHeaders(extra) {
  return Object.assign({
    apikey: SERVICE_ROLE,
    authorization: 'Bearer ' + SERVICE_ROLE,
    'Content-Type': 'application/json'
  }, extra || {});
}
const rest = (path) => `${SUPABASE_URL}/rest/v1/${path}`;

// Map a product_content_sources row → the shape computeMerge expects for one source.
function mapSourceRow(r) {
  return {
    name: r.name, tagline: r.tagline, description: r.description,
    features: r.features || [], clinical_applications: r.clinical_applications || [],
    options: r.options || {}, billing_codes: r.billing_codes || [],
    images: r.images || [], sizing_rows: r.sizing_rows || [], sizing_note: r.sizing_note || '',
    source_url: r.source_url || ''
  };
}
// Fall back to the resolved product_content row as "Current HCPS Data" when no hcps source row exists.
function hcpsFromContent(c) {
  if (!c) return null;
  var imgs = (c.images_gallery && c.images_gallery.length)
    ? c.images_gallery
    : (c.image ? [{ url: c.image, caption: 'Current catalog photo', source: 'hcps' }] : []);
  return {
    name: c.name, tagline: c.tagline, description: c.description,
    features: c.features || [], clinical_applications: c.clinical_applications || [],
    options: c.options || {}, billing_codes: c.billing_codes || [],
    images: imgs, sizing_rows: c.sizing_table || [], sizing_note: c.sizing_note || ''
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!SUPABASE_URL || !SERVICE_ROLE) return reply(500, { ok: false, error: 'Supabase env not configured' });

  const me = await whoami(event);
  const isAdmin = !!(me && ADMIN_ROLES[String(me.role || '').toLowerCase()]);
  const who = (me && me.email) || 'HCPS admin';
  const qs = event.queryStringParameters || {};
  const mfr = qs.manufacturer || '';

  try {
    // ---------- READ ----------
    if (event.httpMethod === 'GET') {
      if (!mfr) return reply(400, { ok: false, error: 'manufacturer required' });
      const filter = isAdmin ? '' : '&status=eq.approved';   // admins see drafts; public sees approved only
      const r = await fetch(rest(`product_content?manufacturer=eq.${enc(mfr)}${filter}&select=*&order=page_key`), { headers: svcHeaders() });
      const rows = await r.json();
      return reply(200, { ok: true, admin: isAdmin, rows });
    }

    // ---------- WRITE (admin only) ----------
    if (event.httpMethod === 'POST') {
      if (!isAdmin) return reply(401, { ok: false, error: me ? 'admin role required' : 'sign in to Connect 360 to continue' });
      let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (e) {}
      const action = body.action;
      const reviewer = body.reviewed_by || who;

      if (action === 'approve' || action === 'reject') {
        const m = body.manufacturer || mfr;
        if (!m) return reply(400, { ok: false, error: 'manufacturer required' });
        if (!body.page_key) return reply(400, { ok: false, error: 'page_key required' });
        const patch = Object.assign({}, body.patch || {}, {
          status: action === 'approve' ? 'approved' : 'rejected',
          reviewed_by: reviewer, updated_at: new Date().toISOString()
        });
        const r = await fetch(rest(`product_content?manufacturer=eq.${enc(m)}&page_key=eq.${enc(body.page_key)}`),
          { method: 'PATCH', headers: svcHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(patch) });
        const out = await r.json();
        return reply(r.ok ? 200 : 500, { ok: r.ok, rows: out });
      }

      if (action === 'approve_all') {
        const m = body.manufacturer || mfr;
        const r = await fetch(rest(`product_content?manufacturer=eq.${enc(m)}&status=eq.pending_review`),
          { method: 'PATCH', headers: svcHeaders({ Prefer: 'return=representation' }),
            body: JSON.stringify({ status: 'approved', reviewed_by: reviewer, updated_at: new Date().toISOString() }) });
        const out = await r.json();
        return reply(r.ok ? 200 : 500, { ok: r.ok, approved: Array.isArray(out) ? out.length : 0 });
      }

      if (action === 'upsert') {
        const rows = Array.isArray(body.rows) ? body.rows : [body.row];
        rows.forEach(x => { if (x && !x.status) x.status = 'pending_review'; if (x) x.updated_at = new Date().toISOString(); });
        const r = await fetch(rest('product_content?on_conflict=manufacturer,page_key'),
          { method: 'POST', headers: svcHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows) });
        return reply(r.ok ? 200 : 500, { ok: r.ok, upserted: rows.length });
      }

      // ---- Capture one source (hcps / website / pdf) for a product page ----
      if (action === 'ingest_source') {
        const m = body.manufacturer || mfr;
        if (!m || !body.page_key || !body.source) return reply(400, { ok: false, error: 'manufacturer, page_key, source required' });
        if (['hcps', 'website', 'pdf'].indexOf(body.source) < 0) return reply(400, { ok: false, error: 'source must be hcps|website|pdf' });
        const d = body.data || {};
        const row = {
          manufacturer: m, page_key: body.page_key, source: body.source,
          source_label: body.source_label || null, source_url: body.source_url || d.source_url || null,
          name: d.name || null, tagline: d.tagline || null, description: d.description || null,
          features: d.features || [], clinical_applications: d.clinical_applications || [],
          options: d.options || {}, billing_codes: d.billing_codes || [],
          images: d.images || [], sizing_rows: d.sizing_rows || [], sizing_note: d.sizing_note || null,
          raw: d.raw || null, captured_at: new Date().toISOString()
        };
        const r = await fetch(rest('product_content_sources?on_conflict=manufacturer,page_key,source'),
          { method: 'POST', headers: svcHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(row) });
        if (!r.ok) { const t = await r.text(); return reply(500, { ok: false, error: t }); }
        return reply(200, { ok: true, ingested: { manufacturer: m, page_key: body.page_key, source: body.source } });
      }

      // ---- Upload a pasted/dropped image → public Storage → return its URL ----
      if (action === 'upload_image') {
        const m = body.manufacturer || mfr;
        if (!m || !body.page_key || !body.content_base64) return reply(400, { ok: false, error: 'manufacturer, page_key, content_base64 required' });
        const ct = body.content_type || 'image/png';
        const ext = (ct.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
        const safe = String(body.filename || 'image').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]*$/, '').slice(0, 40) || 'image';
        const path = `${m}/${body.page_key}/${Date.now()}-${safe}.${ext}`;
        let buf; try { buf = Buffer.from(body.content_base64, 'base64'); } catch (e) { return reply(400, { ok: false, error: 'bad base64' }); }
        if (!buf.length) return reply(400, { ok: false, error: 'empty image' });
        if (buf.length > 6 * 1024 * 1024) return reply(413, { ok: false, error: 'image too large (max ~6MB)' });
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/product-content/${path}`, {
          method: 'POST',
          headers: { apikey: SERVICE_ROLE, authorization: 'Bearer ' + SERVICE_ROLE, 'content-type': ct, 'x-upsert': 'true' },
          body: buf
        });
        if (!up.ok) { const t = await up.text(); return reply(502, { ok: false, error: 'storage upload failed: ' + t }); }
        return reply(200, { ok: true, url: `${SUPABASE_URL}/storage/v1/object/public/product-content/${path}`, path: path });
      }

      // ---- Reconcile the three captured sources into a flagged merge ----
      if (action === 'merge') {
        const m = body.manufacturer || mfr;
        if (!m || !body.page_key) return reply(400, { ok: false, error: 'manufacturer, page_key required' });
        const sr = await fetch(rest(`product_content_sources?manufacturer=eq.${enc(m)}&page_key=eq.${enc(body.page_key)}&select=*`), { headers: svcHeaders() });
        const srcRows = await sr.json();
        const byKey = {};
        (Array.isArray(srcRows) ? srcRows : []).forEach(function (r) { byKey[r.source] = mapSourceRow(r); });
        const pr = await fetch(rest(`product_content?manufacturer=eq.${enc(m)}&page_key=eq.${enc(body.page_key)}&select=*`), { headers: svcHeaders() });
        const prRows = await pr.json();
        const cur = (Array.isArray(prRows) && prRows[0]) || null;
        if (!byKey.hcps && cur) byKey.hcps = hcpsFromContent(cur);
        const merged = computeMerge({ hcps: byKey.hcps || null, website: byKey.website || null, pdf: byKey.pdf || null });
        return reply(200, { ok: true, manufacturer: m, page_key: body.page_key, merge: merged, current: cur });
      }

      return reply(400, { ok: false, error: 'unknown action' });
    }

    return reply(405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    return reply(500, { ok: false, error: String(e && e.message || e) });
  }
};

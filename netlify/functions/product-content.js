/**
 * Partner 360 · product-content write/read API  (Connect 360 / main-site deploy)
 *
 * AUTH: Connect 360 staff sign-in. The review screen sends the staff JWT as
 * `Authorization: Bearer <token>`; whoami() verifies it against Supabase Auth and the
 * staff_users table, and admin roles (president/admin/owner) may read drafts and write.
 * A legacy `x-admin-token` matching CONTENT_ADMIN_TOKEN still works for the importer/CLI.
 *
 * - Public GET (no auth): catalog-visible content only — matches RLS:
 *     status IN ('published','active','discontinued') AND disabled = false.
 * - Admin GET:  ALL rows (drafts + every status) for the review/catalog workspace.
 * - Admin POST: review + upload + catalog-management actions, via the
 *   SUPABASE_SERVICE_ROLE key (bypasses RLS). Service key is a SERVER-ONLY secret.
 *
 * Review/media actions : approve · reject · approve_all · upsert · ingest_source ·
 *                        upload_image · upload_file · rehost · merge
 * Catalog actions      : set_status · set_meta · set_content · set_sku · save_skus ·
 *                        move_skus · split · merge_products · create_product · delete_product ·
 *                        save_sizing · structure_review · bulk · history · undo
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE (both already set on this deploy);
 *      CONTENT_ADMIN_TOKEN optional (legacy importer fallback only).
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ADMIN_TOKEN  = process.env.CONTENT_ADMIN_TOKEN;
const AI_KEY   = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.HCPS_AI_MODEL || 'claude-sonnet-5';
const { computeMerge } = require('./_content-merge.js');
// Central AI voice/style guide (RULE 12) — used for the prose fields the workspace generates.
let loadStyleGuide = null, findBanned = null;
try { ({ loadStyleGuide, findBanned } = require('./_ai_style.js')); } catch (e) { /* optional */ }

const ADMIN_ROLES = { president: 1, admin: 1, owner: 1 };
const enc = encodeURIComponent;

// Public visibility gate — MUST match the RLS policy in product_content_catalog_workspace.sql.
const PUBLIC_STATUSES = ['published', 'active', 'discontinued'];
// Ordering site — source of the full manufacturer roster (so lines with no enrichment yet
// still appear in the workspace selector as "Not started").
const ORDERING_BASE = process.env.ORDERING_BASE || 'https://hcpsonlineordering.netlify.app';
const ALL_STATUSES = ['pending_review', 'approved', 'rejected', 'published', 'active', 'discontinued', 'hidden'];

// ---- Canonical HCPS catalog taxonomy (SEED / DRAFT) ----------------------------------------
// The controlled vocabulary the AI Catalog Review recommends against, so similar products from
// DIFFERENT manufacturers land under the SAME Category → Subcategory (dealers shop by need, not by
// brand). This is a starter — every approval also feeds real, already-used categories back into the
// vocabulary (see classify_product), so it converges as more manufacturers are completed. Edit freely.
const TAXONOMY = {
  // Ovation + every orthopedic/bracing line — the merchandising model recommended for HCPS:
  // dealers shop by NEED, not by each manufacturer's internal body-region structure.
  'Orthopedic Bracing & Supports': ['Walking Boots', 'Night Splints', 'Ankle Braces & Stabilizers', 'Ankle Stirrups', 'Post-Op Shoes', 'Foot & Ankle Accessories', 'OA Knee Braces', 'Post-Op Knee Braces', 'Knee Braces & Supports', 'Back & Lumbar Braces', 'TLSO Braces', 'Cervical Collars', 'Wrist Braces', 'Thumb Spicas', 'Hand & Finger Splints', 'Shoulder Supports', 'Elbow Supports', 'Arm Slings', 'Clavicle Supports'],
  'Med-Surg & Clinical Supplies': ['Exam Gloves', 'Masks & PPE', 'Compression & Elastic Wraps', 'Gauze & Dressings', 'Medical Tape', 'Surgical Supplies', 'Casting & Splinting', 'Wound Care'],
  // Broader DME buckets for HCPS's other manufacturers, so the whole portfolio stays shoppable by need.
  'Mobility': ['Wheelchairs', 'Transport Chairs', 'Walkers & Rollators', 'Canes & Crutches', 'Scooters', 'Ramps'],
  'Bath Safety': ['Grab Bars', 'Shower Chairs & Benches', 'Commodes', 'Raised Toilet Seats', 'Transfer Benches'],
  'Lift Chairs & Seating': ['Lift Chairs', 'Cushions & Positioning'],
  'Beds & Patient Room': ['Hospital Beds', 'Mattresses & Overlays', 'Bed Rails', 'Patient Lifts'],
  'Respiratory': ['Oxygen', 'Nebulizers', 'CPAP & BiPAP', 'Suction', 'Respiratory Accessories'],
  'Daily Living Aids': ['Dressing Aids', 'Reachers & Grabbers', 'Eating & Drinking Aids', 'Incontinence'],
  'Diabetic': ['Diabetic Footwear', 'Diabetic Supplies']
};
// Product-record fields the workspace may edit directly (whitelist — nothing else is writable).
const SAVE_FIELDS = [
  'name', 'tagline', 'description', 'family', 'category', 'subcategory', 'msrp_rule',
  'warranty', 'disabled', 'confidence', 'sku_count', 'features', 'clinical_applications',
  'options', 'billing_codes', 'specs', 'documents', 'videos', 'images_gallery', 'image',
  'sizing_note', 'field_provenance', 'manufacturer',
  // Identity provenance (keep the manufacturer's own structure separate from HCPS merchandising):
  // source_category = the manufacturer's own category path (e.g. "Lower Extremity > Foot & Ankle"),
  // source_url = the manufacturer's canonical product page, aliases = alternate/retail names for search.
  'source_category', 'source_url', 'aliases'
];

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

// ---- SKU normalization: legacy string SKUs → canonical objects -------------
function normSku(s) {
  if (s == null) return null;
  if (typeof s === 'string' || typeof s === 'number') {
    return { sku: String(s), name: '', size: '', hcpcs: '', group: '',
             status: 'active', disabled: false, image: '', images: [], source: '' };
  }
  return Object.assign(
    { sku: '', name: '', size: '', hcpcs: '', group: '', status: 'active',
      disabled: false, image: '', images: [], source: '' },
    s,
    { sku: String(s.sku != null ? s.sku : (s.id != null ? s.id : '')) }
  );
}
function normSkus(arr) { return (Array.isArray(arr) ? arr : []).map(normSku).filter(Boolean); }
function skuKey(s) { return String((s && (s.sku != null ? s.sku : s.id)) || ''); }

// Base model token for structure-review grouping: drop sizes / sides / digits.
const SIZE_WORDS = /\b(x{0,3}s|s|m|l|x{0,3}l|xxl|xl|small|medium|large|universal|left|right|regular|tall|short|std|standard|adult|pediatric|youth|\d+(\.\d+)?("|in|inch|inches|cm|mm)?)\b/gi;
function baseToken(str) {
  return String(str || '')
    .toLowerCase()
    .replace(SIZE_WORDS, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, 3).join(' ');
}

function arr(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
// Flatten a value that may be a row, an array of rows, or an array of representation arrays.
function flatRows(x) {
  const out = [];
  arr(x).forEach(el => { if (Array.isArray(el)) el.forEach(r => out.push(r)); else out.push(el); });
  return out.filter(r => r && r.page_key);
}

// ---- Small REST helpers ----------------------------------------------------
async function getRow(m, pageKey) {
  const r = await fetch(rest(`product_content?manufacturer=eq.${enc(m)}&page_key=eq.${enc(pageKey)}&select=*`),
    { headers: svcHeaders() });
  const j = await r.json();
  return Array.isArray(j) ? (j[0] || null) : null;
}
async function patchRow(m, pageKey, patch) {
  const body = Object.assign({}, patch, { updated_at: new Date().toISOString() });
  const r = await fetch(rest(`product_content?manufacturer=eq.${enc(m)}&page_key=eq.${enc(pageKey)}`),
    { method: 'PATCH', headers: svcHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(body) });
  const rows = await r.json();
  return { ok: r.ok, rows };
}
async function insertRow(row) {
  const r = await fetch(rest('product_content?on_conflict=manufacturer,page_key'),
    { method: 'POST', headers: svcHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify([Object.assign({}, row, { updated_at: new Date().toISOString() })]) });
  const rows = await r.json();
  return { ok: r.ok, rows };
}
async function logHistory(h) {
  try {
    await fetch(rest('product_content_history'),
      { method: 'POST', headers: svcHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify([{
          manufacturer: h.manufacturer, page_key: h.page_key || null, action: h.action,
          actor: h.actor || 'HCPS admin', summary: h.summary || null,
          before: flatRows(h.before), after: flatRows(h.after), at: new Date().toISOString()
        }]) });
  } catch (e) { /* history is best-effort; never block the write */ }
}

// ---- AI content generation (per-field "✨ AI" buttons in the workspace) -----
async function sbGet(path) {
  try { const r = await fetch(rest(path), { headers: svcHeaders() }); return r.ok ? r.json() : []; }
  catch (e) { return []; }
}
async function callAI(prompt, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: maxTokens || 700, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); return { err: `AI ${r.status}`, detail: t.slice(0, 300) }; }
  const j = await r.json();
  // newer models may emit a reasoning block before the text — take the last text block
  const blocks = Array.isArray(j.content) ? j.content : [];
  const txt = blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim();
  return { text: txt };
}
// Tolerant JSON reader for AI output: strips ``` fences, finds the first array/object, bracket-
// matches to its close (string-aware), drops trailing commas, and falls back to an outer slice.
// Handles the common cases that broke strict JSON.parse — code fences, a prose preamble, or a
// trailing comma — so the reviews don't fail with "could not read the AI response".
function parseJsonLoose(text) {
  if (text == null) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const ai = t.indexOf('['), oi = t.indexOf('{');
  let start = -1, open = '[', close = ']';
  if (ai < 0 && oi < 0) return null;
  if (oi < 0 || (ai >= 0 && ai < oi)) { start = ai; open = '['; close = ']'; }
  else { start = oi; open = '{'; close = '}'; }
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  const clean = s => s.replace(/,\s*([}\]])/g, '$1');
  if (end >= 0) { try { return JSON.parse(clean(t.slice(start, end + 1))); } catch (e) {} }
  try { const b = t.lastIndexOf(close); if (b > start) return JSON.parse(clean(t.slice(start, b + 1))); } catch (e) {}
  return null;
}
// Ask the model for JSON and read it robustly; one retry with a strict "JSON only" nudge if the
// first reply won't parse. Returns {data} | {err,detail} | {parse_err,raw}.
async function aiJson(prompt, maxTokens) {
  let out = await callAI(prompt, maxTokens);
  if (out.err) return { err: out.err, detail: out.detail };
  let d = parseJsonLoose(out.text);
  if (d != null) return { data: d };
  const out2 = await callAI(prompt + '\n\nReturn ONLY the JSON value — no explanation and no markdown code fences.', maxTokens);
  if (out2.err) return { err: out2.err, detail: out2.detail };
  d = parseJsonLoose(out2.text);
  if (d != null) return { data: d };
  return { parse_err: true, raw: (out2.text || out.text || '').slice(0, 400) };
}
function aiContext(ctx) {
  ctx = ctx || {};
  const skus = (ctx.skus || []).map(s => (s.sku || '') + (s.size ? ' (' + s.size + ')' : '')).filter(Boolean).slice(0, 24).join(', ');
  const lines = [
    `Product name: ${ctx.name || '(unknown)'}`,
    ctx.manufacturer ? `Manufacturer: ${ctx.manufacturer}` : '',
    ctx.category ? `Current category: ${ctx.category}` : '',
    ctx.subcategory ? `Current subcategory: ${ctx.subcategory}` : '',
    ctx.family ? `Product family: ${ctx.family}` : '',
    (ctx.features && ctx.features.length) ? `Known features: ${ctx.features.slice(0, 10).join(' | ')}` : '',
    (ctx.clinical_applications && ctx.clinical_applications.length) ? `Clinical applications: ${ctx.clinical_applications.join(', ')}` : '',
    (ctx.billing_codes && ctx.billing_codes.length) ? `HCPCS/billing codes: ${ctx.billing_codes.join(', ')}` : '',
    ctx.description ? `Existing description: ${ctx.description}` : '',
    skus ? `SKUs: ${skus}` : '',
    (ctx.sizing_rows && ctx.sizing_rows.length) ? `Sizing table: ${JSON.stringify(ctx.sizing_rows).slice(0, 1500)}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}
const AI_GUARDRAILS = 'This is medical/orthopedic product content for a professional DME dealer catalog. ' +
  'Be factual and specific; do NOT invent measurements, specifications, materials, or clinical claims that are not supported by the context. ' +
  'No hype or filler.';
function aiPrompt(field, ctx, styleGuide) {
  const c = aiContext(ctx);
  const voice = styleGuide ? ('\n\nHouse voice to follow:\n' + styleGuide + '\n') : '';
  switch (field) {
    case 'description':
      return `${AI_GUARDRAILS}${voice}\nWrite a clear, benefit-oriented product description of 2–3 sentences based on the details below. Return ONLY the description text, no headings.\n\n${c}`;
    case 'tagline':
      return `${AI_GUARDRAILS}${voice}\nWrite one short marketing tagline (max 8 words) for this product. Return ONLY the tagline text.\n\n${c}`;
    case 'features':
      return `${AI_GUARDRAILS}\nList 4–6 key product features as short phrases, ONE PER LINE, with no bullets, numbers, or leading symbols. Base them only on the details below; do not invent specs. Return ONLY the lines.\n\n${c}`;
    case 'warranty':
      return `${AI_GUARDRAILS}\nWrite a brief 1–2 sentence standard manufacturer warranty statement for this product. If specifics are unknown, keep it generic and professional. Return ONLY the warranty text.\n\n${c}`;
    case 'clinical_applications':
      return `${AI_GUARDRAILS}\nList 4–8 clinical applications for this product — the conditions, injuries, or procedures it is indicated for or used to treat (e.g. "ACL, PCL, MCL, and LCL knee-related repairs", "Post-op immobilization"). ONE PER LINE, no bullets, numbers, or leading symbols. Base them only on the product details below; do not invent indications. Return ONLY the lines.\n\n${c}`;
    case 'specs':
      return `${AI_GUARDRAILS}\nList 4–10 technical specifications for this product as label/value pairs — the concrete attributes a dealer compares, such as Material, Available sizes, Sizing range, Weight capacity, Closure type, Sided (left/right/universal), Color, Latex-free, Country of origin. Use ONLY facts supported by the details below (including the sizing table and SKUs); do NOT invent measurements, materials, or claims. Omit any spec you cannot support.\nReturn ONLY a JSON array (no prose, no code fences), exactly: [{"label":"Material","value":"…"},{"label":"Available sizes","value":"…"}]\n\n${c}`;
    case 'category':
      return `${AI_GUARDRAILS}\nChoose the single best CATEGORY for this product. Prefer one of the existing categories if a good fit; otherwise propose a concise new category (1–3 words). Existing categories: ${(ctx.existing_categories || []).join(', ') || '(none yet)'}\nReturn ONLY the category name — nothing else.\n\n${c}`;
    case 'subcategory':
      return `${AI_GUARDRAILS}\nSuggest a concise SUBCATEGORY (2–4 words) for this product within its category "${ctx.category || ''}". Return ONLY the subcategory name — nothing else.\n\n${c}`;
    default:
      return `${AI_GUARDRAILS}\nWrite a concise value for the "${field}" field of this product. Return only the text.\n\n${c}`;
  }
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
      // ---- Manufacturer roster + per-line enrichment progress (admin only).
      //      Powers the workspace's manufacturer selector and progress dashboard, so staff can
      //      move between lines without leaving the tool and see where each one stands. Merges
      //      the FULL roster (ordering site) with product_content counts, so a line that hasn't
      //      been started yet still shows up as "Not started". ----
      if (qs.list === 'manufacturers') {
        if (!isAdmin) return reply(401, { ok: false, error: 'admin role required' });
        let roster = [];
        try {
          const rr = await fetch(`${ORDERING_BASE}/data/manufacturers.json`, { headers: { 'cache-control': 'no-cache' } });
          if (rr.ok) roster = await rr.json();
        } catch (e) {}
        const rows = await sbGet('product_content?select=manufacturer,status,disabled,image,category,description&limit=20000');
        const by = {};
        const bucket = (slug) => (by[slug] = by[slug] || { slug, name: slug, products: 0, live: 0, review: 0, noimg: 0, nocat: 0, nodesc: 0 });
        (Array.isArray(roster) ? roster : []).forEach(m => { if (m && m.slug) { const g = bucket(String(m.slug)); g.name = m.name || m.slug; } });
        (rows || []).forEach(r => {
          const m = r && r.manufacturer; if (!m) return;
          const g = bucket(String(m));
          g.products++;
          if (PUBLIC_STATUSES.indexOf(r.status) >= 0) g.live++; else g.review++;
          if (!r.image) g.noimg++;
          if (!r.category) g.nocat++;
          if (!r.description) g.nodesc++;
        });
        const list = Object.keys(by).map(k => {
          const g = by[k];
          g.state = g.products === 0 ? 'not_started'
            : (g.live === g.products ? 'published' : (g.live > 0 ? 'in_progress' : 'in_review'));
          g.pct = g.products ? Math.round(g.live / g.products * 100) : 0;
          return g;
        }).sort((a, b) => {
          const rank = { in_progress: 0, in_review: 1, published: 2, not_started: 3 };
          const d = (rank[a.state] == null ? 9 : rank[a.state]) - (rank[b.state] == null ? 9 : rank[b.state]);
          return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
        });
        return reply(200, { ok: true, manufacturers: list });
      }
      if (!mfr) return reply(400, { ok: false, error: 'manufacturer required' });
      // Admins see every row; the public sees catalog-visible rows only (matches RLS).
      const filter = isAdmin ? '' : `&status=in.(${PUBLIC_STATUSES.join(',')})&disabled=eq.false`;
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
      const m = body.manufacturer || mfr;

      // ================= REVIEW ACTIONS =================
      if (action === 'approve' || action === 'reject') {
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

      // ---- Upload a document file (PDF, etc.) → public Storage → return its URL ----
      if (action === 'upload_file') {
        if (!m || !body.page_key || !body.content_base64) return reply(400, { ok: false, error: 'manufacturer, page_key, content_base64 required' });
        const rawName = String(body.filename || 'document');
        const extM = rawName.match(/\.([A-Za-z0-9]{1,8})$/);
        const ext = (extM ? extM[1] : 'pdf').toLowerCase();
        const base = rawName.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'document';
        const path = `${m}/${body.page_key}/docs/${Date.now()}-${base}.${ext}`;
        let buf; try { buf = Buffer.from(body.content_base64, 'base64'); } catch (e) { return reply(400, { ok: false, error: 'bad base64' }); }
        if (!buf.length) return reply(400, { ok: false, error: 'empty file' });
        if (buf.length > 6 * 1024 * 1024) return reply(413, { ok: false, error: 'file too large (max ~6MB)' });
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/product-content/${path}`, {
          method: 'POST',
          headers: { apikey: SERVICE_ROLE, authorization: 'Bearer ' + SERVICE_ROLE, 'content-type': body.content_type || 'application/octet-stream', 'x-upsert': 'true' },
          body: buf
        });
        if (!up.ok) { const t = await up.text(); return reply(502, { ok: false, error: 'storage upload failed: ' + t }); }
        return reply(200, { ok: true, url: `${SUPABASE_URL}/storage/v1/object/public/product-content/${path}`, path: path });
      }

      // ---- Rehost an external file (PDF/video/image) into our own public Storage ----
      if (action === 'rehost') {
        const src = body.source_url;
        if (!m || !body.page_key || !src) return reply(400, { ok: false, error: 'manufacturer, page_key, source_url required' });
        if (!/^https?:\/\//i.test(src)) return reply(400, { ok: false, error: 'a valid http(s) source_url is required' });
        if (src.indexOf('/storage/v1/object/public/product-content/') >= 0) return reply(200, { ok: true, url: src, skipped: true });
        let r; try {
          r = await fetch(src, { redirect: 'follow', headers: { 'user-agent': 'HCPS-Partner360-Rehost/1.0' } });
        } catch (e) { return reply(502, { ok: false, error: 'download failed: ' + String((e && e.message) || e) }); }
        if (!r.ok) return reply(502, { ok: false, error: 'download failed: HTTP ' + r.status });
        const ct = r.headers.get('content-type') || 'application/octet-stream';
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) return reply(502, { ok: false, error: 'empty download' });
        if (buf.length > 50 * 1024 * 1024) return reply(413, { ok: false, error: 'file too large to rehost (>50MB) — keep the link or upload manually' });
        const nm = (src.split('?')[0].split('#')[0].split('/').pop() || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || 'file';
        const path = `${m}/${body.page_key}/rehost/${Date.now()}-${nm}`;
        const up = await fetch(`${SUPABASE_URL}/storage/v1/object/product-content/${path}`, {
          method: 'POST', headers: { apikey: SERVICE_ROLE, authorization: 'Bearer ' + SERVICE_ROLE, 'content-type': ct, 'x-upsert': 'true' }, body: buf
        });
        if (!up.ok) { const t = await up.text(); return reply(502, { ok: false, error: 'store failed: ' + t }); }
        return reply(200, { ok: true, url: `${SUPABASE_URL}/storage/v1/object/public/product-content/${path}`, bytes: buf.length });
      }

      // ---- Reconcile the three captured sources into a flagged merge ----
      if (action === 'merge') {
        if (!m || !body.page_key) return reply(400, { ok: false, error: 'manufacturer, page_key required' });
        const sr = await fetch(rest(`product_content_sources?manufacturer=eq.${enc(m)}&page_key=eq.${enc(body.page_key)}&select=*`), { headers: svcHeaders() });
        const srcRows = await sr.json();
        const byKey = {};
        (Array.isArray(srcRows) ? srcRows : []).forEach(function (r) { byKey[r.source] = mapSourceRow(r); });
        const cur = await getRow(m, body.page_key);
        if (!byKey.hcps && cur) byKey.hcps = hcpsFromContent(cur);
        const merged = computeMerge({ hcps: byKey.hcps || null, website: byKey.website || null, pdf: byKey.pdf || null });
        return reply(200, { ok: true, manufacturer: m, page_key: body.page_key, merge: merged, current: cur });
      }

      // ================= CATALOG-MANAGEMENT ACTIONS =================

      // ---- Product lifecycle status ----
      if (action === 'set_status') {
        if (!m || !body.page_key || !body.status) return reply(400, { ok: false, error: 'manufacturer, page_key, status required' });
        if (ALL_STATUSES.indexOf(body.status) < 0) return reply(400, { ok: false, error: 'bad status' });
        const before = await getRow(m, body.page_key);
        const patch = { status: body.status, reviewed_by: reviewer };
        if (body.status === 'published') patch.published_at = new Date().toISOString();
        const res = await patchRow(m, body.page_key, patch);
        await logHistory({ manufacturer: m, page_key: body.page_key, action: 'set_status', actor: reviewer,
          summary: `Status → ${body.status}`, before: before, after: res.rows });
        return reply(res.ok ? 200 : 500, { ok: res.ok, rows: res.rows });
      }

      // ---- Edit the product record OR any content field (whitelisted writer) ----
      if (action === 'set_meta' || action === 'set_content' || action === 'save_fields') {
        if (!m || !body.page_key) return reply(400, { ok: false, error: 'manufacturer, page_key required' });
        const p = body.patch || {};
        const patch = {};
        Object.keys(p).forEach(k => { if (SAVE_FIELDS.indexOf(k) >= 0) patch[k] = p[k]; });
        if (!Object.keys(patch).length) return reply(400, { ok: false, error: 'no editable fields in patch' });
        patch.reviewed_by = reviewer;
        const before = await getRow(m, body.page_key);
        const res = await patchRow(m, body.page_key, patch);
        await logHistory({ manufacturer: m, page_key: body.page_key, action: action === 'set_meta' ? 'set_meta' : 'save_content',
          actor: reviewer, summary: `Edited ${Object.keys(patch).filter(k => k !== 'reviewed_by').join(', ')}`,
          before: before, after: res.rows });
        return reply(res.ok ? 200 : 500, { ok: res.ok, rows: res.rows });
      }

      // ---- Edit one SKU in place ----
      if (action === 'set_sku') {
        if (!m || !body.page_key || body.sku == null) return reply(400, { ok: false, error: 'manufacturer, page_key, sku required' });
        const row = await getRow(m, body.page_key);
        if (!row) return reply(404, { ok: false, error: 'product not found' });
        const id = String(body.sku);
        let skus = normSkus(row.skus);
        let found = false;
        skus = skus.map(s => { if (skuKey(s) === id) { found = true; return Object.assign(s, body.patch || {}, { sku: id }); } return s; });
        if (!found && body.create) { skus.push(normSku(Object.assign({ sku: id }, body.patch || {}))); found = true; }
        if (!found) return reply(404, { ok: false, error: 'sku not found on this product' });
        const res = await patchRow(m, body.page_key, { skus, sku_count: skus.length });
        await logHistory({ manufacturer: m, page_key: body.page_key, action: 'set_sku', actor: reviewer,
          summary: `Edited SKU ${id}`, before: row, after: res.rows });
        return reply(res.ok ? 200 : 500, { ok: res.ok, rows: res.rows });
      }

      // ---- Replace a product's whole SKU list in one write ----
      if (action === 'save_skus') {
        if (!m || !body.page_key || !Array.isArray(body.skus)) return reply(400, { ok: false, error: 'manufacturer, page_key, skus[] required' });
        const before = await getRow(m, body.page_key);
        const skus = normSkus(body.skus);
        const res = await patchRow(m, body.page_key, { skus, sku_count: skus.length });
        await logHistory({ manufacturer: m, page_key: body.page_key, action: 'save_skus', actor: reviewer,
          summary: `Saved ${skus.length} SKU row(s)`, before: before, after: res.rows });
        return reply(res.ok ? 200 : 500, { ok: res.ok, rows: res.rows });
      }

      // ---- Remove SKU(s) from THIS product's grouping (content overlay only; catalog item untouched) ----
      if (action === 'remove_skus') {
        if (!m || !body.page_key || !Array.isArray(body.skus)) return reply(400, { ok: false, error: 'manufacturer, page_key, skus[] required' });
        const row = await getRow(m, body.page_key);
        if (!row) return reply(404, { ok: false, error: 'product not found' });
        const ids = body.skus.map(String);
        let skus = normSkus(row.skus);
        const removed = skus.filter(s => ids.indexOf(skuKey(s)) >= 0);
        if (!removed.length) return reply(400, { ok: false, error: 'none of those SKUs are on this product' });
        skus = skus.filter(s => ids.indexOf(skuKey(s)) < 0);
        const res = await patchRow(m, body.page_key, { skus, sku_count: skus.length });
        await logHistory({ manufacturer: m, page_key: body.page_key, action: 'remove_skus', actor: reviewer,
          summary: `Removed ${removed.length} SKU(s) from "${row.name || body.page_key}": ${removed.map(skuKey).join(', ').slice(0, 120)}`,
          before: row, after: res.rows });
        return reply(res.ok ? 200 : 500, { ok: res.ok, removed: removed.length, rows: res.rows });
      }

      // ---- Rename a SKU number in the content overlay (catalog side handled by catalog-api rename_code) ----
      if (action === 'rename_sku') {
        if (!m || !body.page_key || !body.old_sku || !body.new_sku) return reply(400, { ok: false, error: 'manufacturer, page_key, old_sku, new_sku required' });
        const oldId = String(body.old_sku), newId = String(body.new_sku);
        if (oldId === newId) return reply(400, { ok: false, error: 'new_sku matches old_sku' });
        const row = await getRow(m, body.page_key);
        if (!row) return reply(404, { ok: false, error: 'product not found' });
        let skus = normSkus(row.skus);
        if (skus.some(s => skuKey(s) === newId)) return reply(409, { ok: false, error: 'that SKU already exists on this product' });
        let found = false;
        skus = skus.map(s => { if (skuKey(s) === oldId) { found = true; return Object.assign(s, { sku: newId }); } return s; });
        if (!found) return reply(404, { ok: false, error: 'SKU not found on this product' });
        const res = await patchRow(m, body.page_key, { skus });
        await logHistory({ manufacturer: m, page_key: body.page_key, action: 'rename_sku', actor: reviewer,
          summary: `Renamed SKU ${oldId} → ${newId}`, before: row, after: res.rows });
        return reply(res.ok ? 200 : 500, { ok: res.ok, rows: res.rows });
      }

      // ---- Move SKUs from one product to another ----
      if (action === 'move_skus') {
        const from = body.from_page_key, to = body.to_page_key;
        if (!m || !from || !to || !Array.isArray(body.skus)) return reply(400, { ok: false, error: 'manufacturer, from_page_key, to_page_key, skus[] required' });
        const src = await getRow(m, from), dst = await getRow(m, to);
        if (!src || !dst) return reply(404, { ok: false, error: 'source or target product not found' });
        const ids = body.skus.map(String);
        let srcSkus = normSkus(src.skus), dstSkus = normSkus(dst.skus);
        const moving = srcSkus.filter(s => ids.indexOf(skuKey(s)) >= 0);
        if (!moving.length) return reply(400, { ok: false, error: 'none of those SKUs are on the source product' });
        srcSkus = srcSkus.filter(s => ids.indexOf(skuKey(s)) < 0);
        const dstIds = new Set(dstSkus.map(skuKey));
        moving.forEach(s => { if (!dstIds.has(skuKey(s))) dstSkus.push(s); });
        const r1 = await patchRow(m, from, { skus: srcSkus, sku_count: srcSkus.length });
        const r2 = await patchRow(m, to,   { skus: dstSkus, sku_count: dstSkus.length });
        await logHistory({ manufacturer: m, page_key: null, action: 'move_skus', actor: reviewer,
          summary: `Moved ${moving.length} SKU(s) from "${src.name || from}" to "${dst.name || to}"`,
          before: [src, dst], after: [].concat(r1.rows, r2.rows) });
        return reply(r1.ok && r2.ok ? 200 : 500, { ok: r1.ok && r2.ok, moved: moving.length });
      }

      // ---- Split: pull selected SKUs out of a product into a NEW product ----
      if (action === 'split') {
        const from = body.from_page_key, np = body.new || {};
        if (!m || !from || !np.page_key || !Array.isArray(body.skus)) return reply(400, { ok: false, error: 'manufacturer, from_page_key, new.page_key, skus[] required' });
        const src = await getRow(m, from);
        if (!src) return reply(404, { ok: false, error: 'source product not found' });
        const ids = body.skus.map(String);
        let srcSkus = normSkus(src.skus);
        const moving = srcSkus.filter(s => ids.indexOf(skuKey(s)) >= 0);
        if (!moving.length) return reply(400, { ok: false, error: 'none of those SKUs are on the source product' });
        srcSkus = srcSkus.filter(s => ids.indexOf(skuKey(s)) < 0);
        const newRow = {
          manufacturer: m, page_key: np.page_key,
          name: np.name || src.name, tagline: np.tagline != null ? np.tagline : src.tagline,
          description: np.description != null ? np.description : '',
          category: np.category || src.category, subcategory: np.subcategory || src.subcategory,
          family: np.family || src.family, features: np.features || [],
          skus: moving, sku_count: moving.length,
          image: (moving[0] && moving[0].image) ? moving[0].image : null,
          msrp_rule: src.msrp_rule, status: 'pending_review'
        };
        const ins = await insertRow(newRow);
        const r1 = await patchRow(m, from, { skus: srcSkus, sku_count: srcSkus.length });
        await logHistory({ manufacturer: m, page_key: np.page_key, action: 'split', actor: reviewer,
          summary: `Split ${moving.length} SKU(s) out of "${src.name || from}" into "${newRow.name}"`,
          before: [src], after: [].concat(ins.rows, r1.rows) });
        return reply(ins.ok && r1.ok ? 200 : 500, { ok: ins.ok && r1.ok, created: np.page_key, moved: moving.length, rows: ins.rows });
      }

      // ---- Merge products: fold sources' SKUs into a target, hide the emptied sources ----
      if (action === 'merge_products') {
        const into = body.into_page_key, froms = body.from_page_keys || [];
        if (!m || !into || !froms.length) return reply(400, { ok: false, error: 'manufacturer, into_page_key, from_page_keys[] required' });
        const dst = await getRow(m, into);
        if (!dst) return reply(404, { ok: false, error: 'target product not found' });
        let dstSkus = normSkus(dst.skus);
        const dstIds = new Set(dstSkus.map(skuKey));
        const befores = [dst]; const afters = [];
        for (const fk of froms) {
          if (fk === into) continue;
          const src = await getRow(m, fk); if (!src) continue;
          befores.push(src);
          normSkus(src.skus).forEach(s => { if (!dstIds.has(skuKey(s))) { dstSkus.push(s); dstIds.add(skuKey(s)); } });
          const rr = await patchRow(m, fk, { skus: [], sku_count: 0, status: 'hidden', disabled: true });
          afters.push(rr.rows);
        }
        const r = await patchRow(m, into, { skus: dstSkus, sku_count: dstSkus.length });
        afters.push(r.rows);
        await logHistory({ manufacturer: m, page_key: into, action: 'merge_products', actor: reviewer,
          summary: `Merged ${froms.length} product(s) into "${dst.name || into}"`,
          before: befores, after: [].concat.apply([], afters) });
        return reply(r.ok ? 200 : 500, { ok: r.ok, into: into, sku_count: dstSkus.length });
      }

      // ---- Delete a product record entirely (removing duplicates / erroneous stubs). This removes
      //      ONLY the review/content record and its SKU grouping; the orderable catalog items
      //      (products / custom_products) are NOT touched. Snapshotted to history so Undo fully
      //      restores it, and refused for published products (unpublish first). ----
      if (action === 'delete_product') {
        if (!m || !body.page_key) return reply(400, { ok: false, error: 'manufacturer, page_key required' });
        const row = await getRow(m, body.page_key);
        if (!row) return reply(404, { ok: false, error: 'product not found' });
        if (row.status === 'published') return reply(400, { ok: false, error: 'published',
          message: 'This product is published live. Unpublish it first (set its status away from Published), then delete.' });
        const del = await fetch(rest(`product_content?manufacturer=eq.${enc(m)}&page_key=eq.${enc(body.page_key)}`),
          { method: 'DELETE', headers: svcHeaders({ Prefer: 'return=minimal' }) });
        const okDel = del.ok;
        if (okDel) await logHistory({ manufacturer: m, page_key: body.page_key, action: 'delete_product', actor: reviewer,
          summary: `Deleted product "${row.name || body.page_key}"${(row.sku_count || 0) ? ` (had ${row.sku_count} SKU row(s))` : ''}`,
          before: row, after: [] });
        return reply(okDel ? 200 : 500, { ok: okDel, deleted: body.page_key });
      }

      // ---- Create a brand-new product (optionally pulling SKUs off an existing source page) ----
      // ---- Duplicate detection BEFORE a product is created (Phase 3).
      //      Compares an incoming product against every existing record for this manufacturer on
      //      SKU (strongest) > manufacturer product URL > model/name. Returns 'exact' matches
      //      (enrich the existing record instead of creating a second one) and 'possible' matches
      //      (staff decides: merge / keep separate / move SKU / replace / ignore). Read-only. ----
      if (action === 'find_duplicates') {
        if (!m) return reply(400, { ok: false, error: 'manufacturer required' });
        const inName = String(body.name || '').trim();
        const inCodes = (Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean);
        const inUrl = String(body.source_url || '').trim();
        const inModel = String(body.model || '').trim();
        const skipKey = body.page_key ? String(body.page_key) : null;
        const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
        const normUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[\/?#].*$/, '').replace(/\/+$/, '');
        const rows = await sbGet(`product_content?manufacturer=eq.${enc(m)}&select=page_key,name,skus,source_url,family,category,status,aliases&limit=5000`);
        const nName = norm(inName), nUrl = normUrl(inUrl), nModel = norm(inModel);
        const codeSet = new Set(inCodes.map(c => c.toLowerCase()));
        const out = [];
        (rows || []).forEach(r => {
          if (skipKey && r.page_key === skipKey) return;
          const reasons = []; let level = null;
          const rSkus = normSkus(r.skus).map(s => String(s.sku || '').trim()).filter(Boolean);
          const hit = rSkus.filter(c => codeSet.has(c.toLowerCase()));
          if (hit.length) { level = 'exact'; reasons.push(`shares SKU ${hit.slice(0, 4).join(', ')}${hit.length > 4 ? '…' : ''}`); }
          if (nUrl && normUrl(r.source_url) === nUrl) { level = 'exact'; reasons.push('same manufacturer product URL'); }
          const rName = norm(r.name);
          if (nName && rName === nName) { level = 'exact'; reasons.push('identical product name'); }
          else if (nName && rName && (rName.indexOf(nName) === 0 || nName.indexOf(rName) === 0)) { level = level || 'possible'; reasons.push('very similar name'); }
          if (!level && nModel && rName && rName.indexOf(nModel) >= 0) { level = 'possible'; reasons.push(`name contains model "${inModel}"`); }
          if (!level && nName) {
            const a = new Set(nName.split(' ').filter(w => w.length > 2));
            const b = new Set(String(rName).split(' ').filter(w => w.length > 2));
            if (a.size && b.size) {
              let inter = 0; a.forEach(w => { if (b.has(w)) inter++; });
              const jac = inter / (a.size + b.size - inter);
              if (jac >= 0.6) { level = 'possible'; reasons.push('overlapping product name'); }
            }
          }
          if (!level && nName && Array.isArray(r.aliases) && r.aliases.some(al => norm(al) === nName)) { level = 'possible'; reasons.push('matches a saved search alias'); }
          if (level) out.push({ page_key: r.page_key, name: r.name || r.page_key, status: r.status || '', category: r.category || '', family: r.family || '', sku_count: rSkus.length, skus: rSkus.slice(0, 12), level, reasons });
        });
        const rank = { exact: 0, possible: 1 };
        out.sort((a, b) => (rank[a.level] - rank[b.level]) || String(a.name).localeCompare(String(b.name)));
        return reply(200, { ok: true, matches: out, exact: out.filter(x => x.level === 'exact').length, possible: out.filter(x => x.level === 'possible').length });
      }

      if (action === 'create_product') {
        const np = body.product || {};
        if (!m || !np.page_key) return reply(400, { ok: false, error: 'manufacturer, product.page_key required' });
        let skus = normSkus(np.skus || []);
        const befores = [];
        if (body.from_page_key && Array.isArray(body.skus)) {
          const src = await getRow(m, body.from_page_key);
          if (src) {
            befores.push(src);
            const ids = body.skus.map(String);
            let ss = normSkus(src.skus);
            const moving = ss.filter(s => ids.indexOf(skuKey(s)) >= 0);
            ss = ss.filter(s => ids.indexOf(skuKey(s)) < 0);
            skus = skus.concat(moving);
            await patchRow(m, body.from_page_key, { skus: ss, sku_count: ss.length });
          }
        }
        const newRow = {
          manufacturer: m, page_key: np.page_key, name: np.name || np.page_key,
          tagline: np.tagline || null, description: np.description || null,
          category: np.category || null, subcategory: np.subcategory || null, family: np.family || null,
          features: np.features || [], skus, sku_count: skus.length,
          image: np.image || (skus[0] && skus[0].image) || null,
          msrp_rule: np.msrp_rule || null, status: 'pending_review'
        };
        const ins = await insertRow(newRow);
        await logHistory({ manufacturer: m, page_key: np.page_key, action: 'create_product', actor: reviewer,
          summary: `Created "${newRow.name}" (${skus.length} SKUs)`, before: befores, after: ins.rows });
        return reply(ins.ok ? 200 : 500, { ok: ins.ok, created: np.page_key, rows: ins.rows });
      }

      // ---- Save a sizing / spec table pasted in the workspace (column order preserved) ----
      if (action === 'save_sizing') {
        if (!m || !body.page_key) return reply(400, { ok: false, error: 'manufacturer, page_key required' });
        let st = body.sizing_table;
        if (Array.isArray(st)) {
          const cols = (body.columns && body.columns.length) ? body.columns : (st[0] ? Object.keys(st[0]) : []);
          st = { columns: cols, rows: st };
        } else if (st && !Array.isArray(st.rows)) {
          st = { columns: st.columns || [], rows: [] };
        }
        const before = await getRow(m, body.page_key);
        const patch = { sizing_table: st };
        if (body.sizing_note != null) patch.sizing_note = body.sizing_note;
        const res = await patchRow(m, body.page_key, patch);
        await logHistory({ manufacturer: m, page_key: body.page_key, action: 'save_sizing', actor: reviewer,
          summary: `Saved sizing table (${(st.rows || []).length} rows)`, before: before, after: res.rows });
        return reply(res.ok ? 200 : 500, { ok: res.ok, rows: res.rows });
      }

      // ---- Structure review: flag products that look like several products bundled under one ----
      if (action === 'structure_review') {
        if (!m) return reply(400, { ok: false, error: 'manufacturer required' });
        const r = await fetch(rest(`product_content?manufacturer=eq.${enc(m)}&select=page_key,name,category,sku_count,skus,is_parent,parent_key,status`),
          { headers: svcHeaders() });
        const rows = await r.json();
        const flags = [];
        (Array.isArray(rows) ? rows : []).forEach(row => {
          if (row.is_parent) return;
          const skus = normSkus(row.skus);
          if (skus.length < 2) return;
          const hcpcs  = new Set(skus.map(s => (s.hcpcs || '').trim()).filter(Boolean));
          const bases  = new Set(skus.map(s => baseToken(s.name || s.sku)).filter(Boolean));
          const groups = new Set(skus.map(s => (s.group || '').trim()).filter(Boolean));
          const reasons = [];
          if (hcpcs.size > 1)  reasons.push(`${hcpcs.size} different HCPCS codes across its SKUs`);
          if (bases.size > 1)  reasons.push(`${bases.size} distinct product names in the SKU list`);
          if (groups.size > 1) reasons.push(`${groups.size} catalog groups`);
          const strong = reasons.length > 0;
          if (!strong && skus.length >= 8) reasons.push(`${skus.length} SKUs under one product — confirm these are size/quantity variants, not several products`);
          if (reasons.length) flags.push({ page_key: row.page_key, name: row.name, sku_count: skus.length, strong, reasons });
        });
        return reply(200, { ok: true, flags });
      }

      // ---- Bulk edit (multi-select) ----
      if (action === 'bulk') {
        const keys = body.page_keys || [];
        const p = body.patch || {};
        if (!m || !keys.length) return reply(400, { ok: false, error: 'manufacturer, page_keys[] required' });
        const allow = SAVE_FIELDS.concat(['status', 'published_at']);
        const clean = {};
        Object.keys(p).forEach(k => { if (allow.indexOf(k) >= 0) clean[k] = p[k]; });
        if (clean.status && ALL_STATUSES.indexOf(clean.status) < 0) return reply(400, { ok: false, error: 'bad status' });
        if (clean.status === 'published' && !clean.published_at) clean.published_at = new Date().toISOString();
        if (!Object.keys(clean).length) return reply(400, { ok: false, error: 'no editable fields in patch' });
        clean.reviewed_by = reviewer; clean.updated_at = new Date().toISOString();
        const befores = [];
        for (const k of keys) { const b = await getRow(m, k); if (b) befores.push(b); }
        const inlist = keys.map(enc).join(',');
        const r = await fetch(rest(`product_content?manufacturer=eq.${enc(m)}&page_key=in.(${inlist})`),
          { method: 'PATCH', headers: svcHeaders({ Prefer: 'return=representation' }), body: JSON.stringify(clean) });
        const out = await r.json();
        await logHistory({ manufacturer: m, page_key: null, action: 'bulk', actor: reviewer,
          summary: `Bulk edit of ${keys.length} product(s): ${Object.keys(clean).filter(k => ['reviewed_by', 'updated_at'].indexOf(k) < 0).join(', ')}`,
          before: befores, after: out });
        return reply(r.ok ? 200 : 500, { ok: r.ok, updated: Array.isArray(out) ? out.length : 0 });
      }

      // ---- Change history (list) ----
      if (action === 'history') {
        if (!m) return reply(400, { ok: false, error: 'manufacturer required' });
        const lim = Math.min(200, Number(body.limit) || 50);
        const r = await fetch(rest(`product_content_history?manufacturer=eq.${enc(m)}&order=at.desc&limit=${lim}&select=id,page_key,action,actor,summary,undone,at`),
          { headers: svcHeaders() });
        const history = await r.json();
        return reply(200, { ok: true, history });
      }

      // ---- Undo one history entry (restore before-snapshots; hide anything it created) ----
      if (action === 'undo') {
        if (!m || body.id == null) return reply(400, { ok: false, error: 'manufacturer, id required' });
        const hr = await fetch(rest(`product_content_history?id=eq.${enc(body.id)}&select=*`), { headers: svcHeaders() });
        const hrows = await hr.json();
        const h = Array.isArray(hrows) ? hrows[0] : null;
        if (!h) return reply(404, { ok: false, error: 'history entry not found' });
        if (h.undone) return reply(400, { ok: false, error: 'that change was already undone' });
        const before = flatRows(h.before);
        const after  = flatRows(h.after);
        const beforeKeys = new Set(before.map(s => s.page_key));
        for (const snap of before) {
          const restore = Object.assign({}, snap); delete restore.id;
          restore.updated_at = new Date().toISOString();
          await fetch(rest('product_content?on_conflict=manufacturer,page_key'),
            { method: 'POST', headers: svcHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([restore]) });
        }
        for (const row of after) {
          if (!beforeKeys.has(row.page_key)) await patchRow(m, row.page_key, { status: 'hidden', disabled: true });
        }
        await fetch(rest(`product_content_history?id=eq.${enc(body.id)}`),
          { method: 'PATCH', headers: svcHeaders(), body: JSON.stringify({ undone: true }) });
        return reply(200, { ok: true, restored: before.length });
      }

      // ---- AI: generate content for one field (description / tagline / features / warranty / category / subcategory) ----
      if (action === 'generate_content') {
        if (!AI_KEY) return reply(200, { ok: false, error: 'ai_unavailable', message: "AI drafting isn't enabled — set ANTHROPIC_API_KEY in Netlify." });
        const field = body.field; const ctx = body.context || {};
        const ALLOWED = ['description', 'tagline', 'features', 'warranty', 'category', 'subcategory', 'clinical_applications', 'specs'];
        if (ALLOWED.indexOf(field) < 0) return reply(400, { ok: false, error: 'bad field' });
        const prose = ['description', 'tagline', 'features', 'warranty'].indexOf(field) >= 0;
        let guide = '';
        if (prose && loadStyleGuide) { try { guide = await loadStyleGuide(sbGet); } catch (e) {} }
        const maxTok = (field === 'features' || field === 'specs') ? 600 : (field === 'clinical_applications' ? 300 : (field === 'description' ? 400 : 120));
        let out = await callAI(aiPrompt(field, ctx, guide), maxTok);
        if (out.err) return reply(200, { ok: false, error: 'ai_error', message: out.err, detail: out.detail, model: AI_MODEL });
        let text = (out.text || '').trim();
        if (prose && findBanned && text && findBanned(text).length) {
          const retry = await callAI(aiPrompt(field, ctx, guide) + '\n\nAvoid these phrases: ' + findBanned(text).join(', '), maxTok);
          if (!retry.err && retry.text) text = retry.text.trim();
        }
        if (field === 'category' || field === 'subcategory' || field === 'tagline') {
          text = (text.split('\n')[0] || '').replace(/^["'\s]+|["'\s.]+$/g, '').trim();
        }
        const resp = { ok: true, field, text };
        if (field === 'features' || field === 'clinical_applications') resp.list = text.split('\n').map(x => x.replace(/^[-•*\d.\s]+/, '').trim()).filter(Boolean);
        if (field === 'specs') {
          let arr = parseJsonLoose(text);
          if (!Array.isArray(arr)) arr = [];
          resp.specs = arr.map(s => ({ label: String((s && (s.label || s.name)) || '').trim(), value: String((s && (s.value || s.val)) || '').trim() }))
            .filter(s => s.label || s.value);
        }
        return reply(200, resp);
      }

      // ---- AI Catalog Review: recommend Family / Category / Subcategory (against the canonical
      //      taxonomy + everything already approved across ALL manufacturers), plus a naming check
      //      and a split hint. Read-only — it never writes; the workspace applies accepted values. ----
      if (action === 'classify_product') {
        if (!AI_KEY) return reply(200, { ok: false, error: 'ai_unavailable', message: "AI review isn't enabled — set ANTHROPIC_API_KEY in Netlify." });
        if (!m || !body.page_key) return reply(400, { ok: false, error: 'manufacturer, page_key required' });
        const row = await getRow(m, body.page_key);
        if (!row) return reply(404, { ok: false, error: 'product not found' });
        // Controlled vocabulary = seed taxonomy ∪ categories already approved anywhere in the catalog.
        const used = await sbGet(`product_content?select=category,subcategory&status=in.(approved,published,active)&category=not.is.null`);
        const subs = {};
        Object.keys(TAXONOMY).forEach(c => { subs[c] = new Set(TAXONOMY[c] || []); });
        (used || []).forEach(r => { if (r.category) { (subs[r.category] = subs[r.category] || new Set()); if (r.subcategory) subs[r.category].add(r.subcategory); } });
        const vocab = Object.keys(subs).sort().map(c => `- ${c}: ${[...subs[c]].sort().join(', ') || '(none yet)'}`).join('\n');
        const ctx = {
          name: row.name, manufacturer: m, category: row.category, subcategory: row.subcategory, family: row.family,
          features: row.features, clinical_applications: row.clinical_applications, billing_codes: row.billing_codes,
          description: row.description, skus: normSkus(row.skus)
        };
        const prompt = `${AI_GUARDRAILS}\n\nYou are organizing a DME dealer catalog (HCPS Partner 360) so dealers can shop by NEED across manufacturers. Classify the product below.\n\nControlled taxonomy — STRONGLY prefer reusing an existing Category and Subcategory so the same kind of product from different manufacturers lines up together. Propose a NEW category/subcategory only if nothing fits, and keep it concise:\n${vocab}\n\nProduct:\n${aiContext(ctx)}\n\nPRODUCT-IDENTITY CHECK (for the "split" field): a SKU is a variant, not automatically its own product. KEEP SKUs together as ONE product when they differ ONLY by size, left/right, color, pack quantity, or circumference range. RECOMMEND A SPLIT only when the SKUs clearly span more than one distinct MODEL — a major configuration change (e.g. Tall vs Short, Pneumatic vs Non-Pneumatic), different official product names, distinct model numbers or HCPCS codes, or a different clinical purpose/construction. NEVER recommend a split just because there are many SKUs or the names look similar. When you do recommend a split, say how many separate products the SKUs appear to represent.\n\nReturn ONLY a JSON object (no prose, no code fences) with exactly these keys:\n{"family":"the product line/brand-model family this belongs to (e.g. 'Gen 2 Walking Boot'), or '' if not applicable","category":"best Category","subcategory":"best Subcategory within that Category","is_new_category":true or false,"is_new_subcategory":true or false,"rationale":"one short sentence why","naming":{"ok":true or false,"suggested_name":"a cleaner product name, or the same name if already good","issues":["short naming issues if any"]},"split":{"recommended":true or false,"reason":"if the SKUs represent more than one distinct model, name the models and how many products; else ''"},"confidence":0}`;
        const rj = await aiJson(prompt, 1000);
        if (rj.err) return reply(200, { ok: false, error: 'ai_error', message: rj.err, detail: rj.detail, model: AI_MODEL });
        if (rj.parse_err) return reply(200, { ok: false, error: 'ai_parse', message: 'Could not read the AI response — try again.', raw: rj.raw });
        const parsed = rj.data;
        return reply(200, { ok: true, recommendation: parsed, current: { family: row.family || '', category: row.category || '', subcategory: row.subcategory || '' } });
      }

      // ---- AI-draft each SKU's Name / Size / HCPCS from the product + sizing table + billing codes.
      //      Read-only: returns per-SKU suggestions keyed by code; the workspace fills blanks & the
      //      user saves. HCPCS here is the reimbursement/billing code for that variant (NOT a part
      //      number) — the same product code usually repeats across sizes. Never invents codes. ----
      if (action === 'ai_fill_skus') {
        if (!AI_KEY) return reply(200, { ok: false, error: 'ai_unavailable', message: "AI drafting isn't enabled — set ANTHROPIC_API_KEY in Netlify." });
        if (!m || !body.page_key) return reply(400, { ok: false, error: 'manufacturer, page_key required' });
        const row = await getRow(m, body.page_key);
        if (!row) return reply(404, { ok: false, error: 'product not found' });
        const skus = normSkus(row.skus);
        if (!skus.length) return reply(200, { ok: true, rows: [] });
        const codes = Array.isArray(row.billing_codes) ? row.billing_codes.filter(Boolean) : [];
        const defaultCode = codes[0] || '';
        const productName = String(row.name || '').trim();
        const allow = new Set(codes.map(c => String(c).toUpperCase().trim()));

        // sizing_table is stored as { columns:[...], rows:[{col:val,...}] } (older rows may be a bare array).
        const stRows = row.sizing_table && Array.isArray(row.sizing_table.rows) ? row.sizing_table.rows
          : (Array.isArray(row.sizing_table) ? row.sizing_table : []);
        const stCols = row.sizing_table && Array.isArray(row.sizing_table.columns) && row.sizing_table.columns.length
          ? row.sizing_table.columns : (stRows[0] ? Object.keys(stRows[0]) : []);
        // The column holding the size label: header contains "siz" (Size / Sizing), else the first column.
        const sizeCol = stCols.find(c => /siz/i.test(c)) || stCols[0] || null;

        // Deterministic match: find each SKU code ANYWHERE in the table (part numbers may live in several
        // columns, e.g. "Part Number Right Hand" / "Part Number Left Hand"). Derive size + side from the row.
        const det = {};
        const want = new Set(skus.map(s => String(s.sku).trim()));
        stRows.forEach(r => {
          Object.keys(r || {}).forEach(col => {
            const v = String(r[col] == null ? '' : r[col]).trim();
            if (v && want.has(v)) {
              const size = (sizeCol && r[sizeCol] != null) ? String(r[sizeCol]).trim() : '';
              let side = '';
              if (/left/i.test(col)) side = 'Left'; else if (/right/i.test(col)) side = 'Right';
              det[v] = { size, side };
            }
          });
        });

        const buildName = (size, side) => productName
          ? (productName + (size ? ' – ' + size : '') + (side ? ' (' + side + ')' : ''))
          : '';

        // Only fall back to the AI for SKUs the table could not resolve a size for.
        const unresolved = skus.filter(s => !(det[String(s.sku).trim()] && det[String(s.sku).trim()].size));
        let aiMap = {};
        if (unresolved.length && AI_KEY) {
          const sizingJson = stRows.length ? JSON.stringify(stRows).slice(0, 4000) : '(none provided)';
          const skuList = unresolved.map(s => ({ sku: String(s.sku), currentName: s.name || '', currentSize: s.size || '' }));
          const prompt = `${AI_GUARDRAILS}\n\nYou are completing per-SKU (per-variant) rows for ONE product in a DME dealer catalog. Each SKU number is a manufacturer PART NUMBER for a size/side variant of the same product.\n\nProduct name: ${productName || '(unknown)'}\nProduct-level HCPCS / billing code(s): ${codes.length ? codes.join(', ') : '(none on file)'}\n\nSizing / spec table rows (JSON). A SKU/part number may appear in ANY column — some tables list it under one "Part Number" column, others split it across columns like "Part Number Right Hand" and "Part Number Left Hand". Match the SKU by finding its exact value in a cell, then read that same row's SIZE label (the size/sizing column):\n${sizingJson}\n\nSKUs still needing a size:\n${JSON.stringify(skuList)}\n\nFor EACH sku return:\n- "size": the size label from the matched row (e.g. "X-Small","Medium"). If the SKU value is not present anywhere in the table, infer from currentName; else "".\n- "side": "Left" if it was found under a left-hand column, "Right" if a right-hand column, else "".\nDo NOT leave size blank when the SKU value appears in the table.\n\nReturn ONLY a JSON array (no prose, no code fences), one object per sku, filled in, e.g.: [{"sku":"51072","size":"X-Small","side":"Right"},{"sku":"50072","size":"X-Small","side":"Left"}]`;
          const rj = await aiJson(prompt, 1500);
          if (!rj.err && !rj.parse_err) {
            let rr = rj.data;
            if (rr && !Array.isArray(rr) && Array.isArray(rr.rows)) rr = rr.rows;
            if (Array.isArray(rr)) rr.forEach(x => { if (x && x.sku != null) aiMap[String(x.sku).trim()] = x; });
          }
        }

        const clean = skus.map(s => {
          const code = String(s.sku).trim();
          const d = det[code] || {};
          const a = aiMap[code] || {};
          const size = d.size || String(a.size || '').trim();
          const side = d.side || String(a.side || '').trim();
          let hc = String(s.hcpcs || '').trim() || defaultCode;
          if (hc && allow.size && !allow.has(hc.toUpperCase())) hc = defaultCode;
          return { sku: code, name: buildName(size, side), size: size, hcpcs: hc };
        });
        return reply(200, { ok: true, rows: clean, matched: Object.keys(det).length });
      }

      // ---- Return the canonical taxonomy (seed ∪ approved), for the workspace's Catalog Review UI. ----
      if (action === 'taxonomy') {
        const used = await sbGet(`product_content?select=category,subcategory&status=in.(approved,published,active)&category=not.is.null`);
        const subs = {};
        Object.keys(TAXONOMY).forEach(c => { subs[c] = new Set(TAXONOMY[c] || []); });
        (used || []).forEach(r => { if (r.category) { (subs[r.category] = subs[r.category] || new Set()); if (r.subcategory) subs[r.category].add(r.subcategory); } });
        const taxonomy = {}; Object.keys(subs).sort().forEach(c => { taxonomy[c] = [...subs[c]].sort(); });
        return reply(200, { ok: true, taxonomy });
      }

      // ---- Catalog-wide harmonization: look across ALL manufacturers and propose how to line up
      //      inconsistent category names to the canonical taxonomy, so dealers can compare the same
      //      kind of product regardless of brand. Read-only — returns proposals for review. ----
      if (action === 'harmonize_catalog') {
        if (!AI_KEY) return reply(200, { ok: false, error: 'ai_unavailable', message: "AI review isn't enabled — set ANTHROPIC_API_KEY in Netlify." });
        const rows = await sbGet(`product_content?select=manufacturer,category,subcategory,name&status=neq.rejected&limit=3000`);
        const byCat = {};
        (rows || []).forEach(r => { const c = r.category || '(uncategorized)'; const g = byCat[c] || (byCat[c] = { cat: c, count: 0, mfrs: new Set(), subs: new Set(), samples: [] }); g.count++; if (r.manufacturer) g.mfrs.add(r.manufacturer); if (r.subcategory) g.subs.add(r.subcategory); if (g.samples.length < 4 && r.name) g.samples.push(r.name); });
        const observed = Object.values(byCat).map(g => ({ category: g.cat, count: g.count, manufacturers: [...g.mfrs], subcategories: [...g.subs].slice(0, 8), samples: g.samples }));
        if (!observed.length) return reply(200, { ok: true, proposals: [] });
        const vocab = Object.keys(TAXONOMY).sort().map(c => `- ${c}: ${(TAXONOMY[c] || []).join(', ')}`).join('\n');
        const prompt = `${AI_GUARDRAILS}\n\nYou are harmonizing a DME dealer catalog (HCPS Partner 360) so that similar products from DIFFERENT manufacturers sit under the SAME Category, letting dealers compare options by need (e.g. "Walking Boots", "Wheelchairs", "Bath Safety") without knowing the brand.\n\nCanonical taxonomy to map toward:\n${vocab}\n\nCategories currently in use (across all manufacturers):\n${observed.map(o => `• "${o.category}" — ${o.count} product(s); manufacturers: ${o.manufacturers.join(', ') || '?'}; subcategories: ${o.subcategories.join(', ') || '—'}; examples: ${o.samples.join('; ') || '—'}`).join('\n')}\n\nFor each currently-used category decide KEEP (already a good canonical category), RENAME (to a canonical category), or MERGE (into another category). Only recommend a change when it clearly improves cross-manufacturer consistency.\nReturn ONLY a JSON array (no prose, no code fences), each element exactly:\n{"from":"the current category name exactly as shown","action":"keep|rename|merge","to":"the canonical category it should become (same as from when keep)","subcategory":"a suggested subcategory or ''","reason":"one short sentence"}`;
        const rj = await aiJson(prompt, 3000);
        if (rj.err) return reply(200, { ok: false, error: 'ai_error', message: rj.err, detail: rj.detail });
        if (rj.parse_err) return reply(200, { ok: false, error: 'ai_parse', message: 'Could not read the AI response — try again.', raw: rj.raw });
        let proposals = rj.data;
        const cmap = {}; observed.forEach(o => { cmap[o.category] = o; });
        proposals = (Array.isArray(proposals) ? proposals : []).map(p => Object.assign({}, p, { count: (cmap[p.from] && cmap[p.from].count) || 0, manufacturers: (cmap[p.from] && cmap[p.from].manufacturers) || [] }));
        return reply(200, { ok: true, proposals, observed_count: observed.length });
      }

      // ---- Apply a harmonization: move every product currently under category `from` to `to`
      //      (across ALL manufacturers), optionally setting a subcategory. Undoable from History.
      //      Returns the affected SKU codes per manufacturer so the caller can sync the live shop. ----
      if (action === 'recategorize') {
        const from = String(body.from || '').trim(), to = String(body.to || '').trim();
        if (!from || !to) return reply(400, { ok: false, error: 'from, to required' });
        const sub = body.subcategory != null && String(body.subcategory).trim() ? String(body.subcategory).trim() : null;
        const rows = await sbGet(`product_content?select=*&category=eq.${enc(from)}&limit=3000`);
        if (!rows || !rows.length) return reply(200, { ok: true, updated: 0, affected: [] });
        const before = rows.map(r => Object.assign({}, r));
        for (const r of rows) { const patch = { category: to, reviewed_by: reviewer }; if (sub) patch.subcategory = sub; await patchRow(r.manufacturer, r.page_key, patch); }
        await logHistory({ manufacturer: rows[0].manufacturer, page_key: null, action: 'recategorize', actor: reviewer,
          summary: `Re-categorized ${rows.length} product(s): "${from}" → "${to}"${sub ? ` (subcategory "${sub}")` : ''}`, before: before, after: [] });
        const affected = {};
        rows.forEach(r => { const codes = normSkus(r.skus).map(s => skuKey(s)).filter(Boolean); (affected[r.manufacturer] = affected[r.manufacturer] || []).push(...codes); });
        return reply(200, { ok: true, updated: rows.length, to, affected: Object.keys(affected).map(m => ({ manufacturer: m, codes: affected[m] })) });
      }

      // ---- Cross-sell: recommend accessories/related from the SAME manufacturer and the closest
      //      ALTERNATIVES from OTHER manufacturers (so dealers can compare by need). Read-only. The
      //      AI chooses from real candidate lists by index, so it can't invent products. ----
      if (action === 'related_products') {
        if (!AI_KEY) return reply(200, { ok: false, error: 'ai_unavailable', message: "AI review isn't enabled — set ANTHROPIC_API_KEY in Netlify." });
        if (!m || !body.page_key) return reply(400, { ok: false, error: 'manufacturer, page_key required' });
        const row = await getRow(m, body.page_key);
        if (!row) return reply(404, { ok: false, error: 'product not found' });
        const primOf = r => { const s = normSkus(r.skus)[0]; return s ? skuKey(s) : ''; };
        const myCode = primOf(row);
        const sameRows = await sbGet(`product_content?select=page_key,manufacturer,name,category,skus,image&manufacturer=eq.${enc(m)}&status=neq.rejected&limit=250`);
        const same = (sameRows || []).filter(r => r.page_key !== body.page_key).map(r => ({ manufacturer: m, code: primOf(r), name: r.name, category: r.category || '', image: r.image || '' })).filter(x => x.code && x.code !== myCode).slice(0, 60);
        let cross = [];
        if (row.category) {
          const cr = await sbGet(`product_content?select=page_key,manufacturer,name,category,skus,image&manufacturer=neq.${enc(m)}&category=eq.${enc(row.category)}&status=neq.rejected&limit=120`);
          cross = (cr || []).map(r => ({ manufacturer: r.manufacturer, code: primOf(r), name: r.name, category: r.category || '', image: r.image || '' })).filter(x => x.code).slice(0, 40);
        }
        const sameList = same.map((c, i) => `A${i}: ${c.name}`).join('\n');
        const crossList = cross.map((c, i) => `X${i}: ${c.name} [${c.manufacturer}]`).join('\n');
        const prompt = `${AI_GUARDRAILS}\n\nProduct: ${row.name} (category: ${row.category || '?'}).${row.description ? ' Description: ' + String(row.description).slice(0, 300) : ''}\n\nFrom the SAME manufacturer, pick up to 6 items that are genuine ACCESSORIES or naturally cross-sell with this product (replacement parts, liners, companion items). Choose by index:\n${sameList || '(none available)'}\n\nFrom OTHER manufacturers, pick up to 6 items that are the closest ALTERNATIVES — the same kind of product a dealer would compare. Choose by index:\n${crossList || '(none available)'}\n\nReturn ONLY JSON (no prose): {"accessories":[{"i":0,"reason":"short why"}],"alternatives":[{"i":0,"reason":"short why"}]}. Use only indexes that exist above; return empty arrays if nothing genuinely fits.`;
        const rj = await aiJson(prompt, 1400);
        if (rj.err) return reply(200, { ok: false, error: 'ai_error', message: rj.err, detail: rj.detail });
        if (rj.parse_err) return reply(200, { ok: false, error: 'ai_parse', message: 'Could not read the AI response — try again.', raw: rj.raw });
        const parsed = rj.data;
        const pick = (arr, src) => (Array.isArray(arr) ? arr : []).map(o => { const c = src[o && o.i]; return c ? Object.assign({}, c, { reason: (o && o.reason) || '' }) : null; }).filter(Boolean);
        return reply(200, { ok: true, for_code: myCode, accessories: pick(parsed.accessories, same), alternatives: pick(parsed.alternatives, cross) });
      }

      // ---- Save the curated related set for a product (authoritative: replaces the prior set). ----
      if (action === 'save_related') {
        const code = String(body.code || '').trim(); if (!m || !code) return reply(400, { ok: false, error: 'manufacturer, code required' });
        const items = Array.isArray(body.items) ? body.items : [];
        await fetch(rest(`product_related?manufacturer=eq.${enc(m)}&code=eq.${enc(code)}`), { method: 'DELETE', headers: svcHeaders({ Prefer: 'return=minimal' }) }).catch(() => {});
        const rows = items.map((it, i) => ({ manufacturer: m, code, related_manufacturer: String(it.related_manufacturer || m), related_code: String(it.related_code || ''), related_name: it.related_name || null, related_image: it.related_image || null, related_category: it.related_category || null, kind: (it.kind === 'alternative' ? 'alternative' : 'accessory'), sort: i, created_by: reviewer })).filter(r => r.related_code);
        let ok = true;
        if (rows.length) { const rr = await fetch(rest('product_related'), { method: 'POST', headers: svcHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(rows) }); ok = rr.ok; }
        return reply(ok ? 200 : 500, { ok, saved: rows.length });
      }

      // ---- List the curated related set for a product (for the workspace). ----
      if (action === 'list_related') {
        const code = String(body.code || '').trim(); if (!m || !code) return reply(400, { ok: false, error: 'manufacturer, code required' });
        const rows = await sbGet(`product_related?manufacturer=eq.${enc(m)}&code=eq.${enc(code)}&order=sort&select=related_manufacturer,related_code,related_name,related_image,related_category,kind`);
        return reply(200, { ok: true, related: rows || [] });
      }

      // ---- Naming consistency sweep: review one manufacturer's product names for consistent
      //      Title Case, brand/family prefix and ® usage, no size/color/variant in the title (those
      //      belong in the SKU), and no redundant words. Read-only — returns rename proposals. ----
      if (action === 'naming_review') {
        if (!AI_KEY) return reply(200, { ok: false, error: 'ai_unavailable', message: "AI review isn't enabled — set ANTHROPIC_API_KEY in Netlify." });
        if (!m) return reply(400, { ok: false, error: 'manufacturer required' });
        const rows = await sbGet(`product_content?select=page_key,name,family,category&manufacturer=eq.${enc(m)}&status=neq.rejected&limit=400`);
        const list = (rows || []).filter(r => r.name).slice(0, 120);
        if (!list.length) return reply(200, { ok: true, proposals: [], reviewed: 0 });
        const lines = list.map((r, i) => `${i}: "${r.name}"${r.family ? ` [family: ${r.family}]` : ''}${r.category ? ` [cat: ${r.category}]` : ''}`).join('\n');
        const prompt = `${AI_GUARDRAILS}\n\nReview these product names from ONE manufacturer for a professional DME catalog and flag inconsistencies. Good names: Title Case; a consistent brand/family prefix across a line; the ® used consistently (all or none) within a family; NO size, color, or variant in the title (those belong in the SKU); no redundant or duplicated words; concise.\n\nNames:\n${lines}\n\nReturn ONLY a JSON array (no prose, no code fences) of the names that SHOULD change: [{"i":0,"suggested":"the corrected name","issues":["short issue"]}]. Omit any name that is already fine.`;
        const rj = await aiJson(prompt, 2600);
        if (rj.err) return reply(200, { ok: false, error: 'ai_error', message: rj.err, detail: rj.detail });
        if (rj.parse_err) return reply(200, { ok: false, error: 'ai_parse', message: 'Could not read the AI response — try again.', raw: rj.raw });
        const arr = rj.data;
        const proposals = (Array.isArray(arr) ? arr : []).map(o => { const r = list[o && o.i]; if (!r || !o.suggested || String(o.suggested) === r.name) return null; return { page_key: r.page_key, current: r.name, suggested: String(o.suggested), issues: Array.isArray(o.issues) ? o.issues : [] }; }).filter(Boolean);
        return reply(200, { ok: true, proposals, reviewed: list.length });
      }

      return reply(400, { ok: false, error: 'unknown action' });
    }

    return reply(405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    return reply(500, { ok: false, error: String(e && e.message || e) });
  }
};

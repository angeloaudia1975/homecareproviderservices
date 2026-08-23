/**
 * Partner 360 · manufacturer-website scraper (admin-gated)
 *
 * POST { url }  (header x-admin-token)  →  { ok, data:{ name, tagline, description,
 *   features[], images[], sizing_rows[], sizing_note, options{}, billing_codes[], source_url, raw } }
 *
 * Server-side fetch + static-HTML parse. It reads, in order of reliability:
 *   1. JSON-LD  <script type="application/ld+json"> Product schema  (name/description/images/specs)
 *   2. OpenGraph / <meta> tags   (og:image, og:title, og:description, meta description)
 *   3. <img> / <source> tags     (gallery images; icons/logos/sprites filtered out)
 *   4. <table>                    (sizing / spec tables — header row → row objects)
 *   5. a "Features" heading followed by a <ul>
 *
 * It cannot run the page's JavaScript, so JS-only galleries may be partial — the review
 * screen lets a human add or correct anything the parse misses. The result is a *capture*,
 * not published content: it flows into product_content_sources and through the merge/review gate.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ADMIN_TOKEN = process.env.CONTENT_ADMIN_TOKEN;
const ADMIN_ROLES = { president: 1, admin: 1, owner: 1 };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
  'Content-Type': 'application/json'
};
const reply = (code, body) => ({ statusCode: code, headers: CORS, body: JSON.stringify(body) });

// Connect 360 staff auth — same pattern as product-content.js / the other admin functions.
async function isAdminReq(event) {
  const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
  const tok = auth.replace(/^Bearer\s+/i, '').trim();
  if (tok && SUPABASE_URL && SERVICE_ROLE) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_ROLE, Authorization: 'Bearer ' + tok } });
      if (r.ok) {
        const u = await r.json(); const email = u && u.email && String(u.email).toLowerCase();
        if (email) {
          const sr = await fetch(`${SUPABASE_URL}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=role,active`,
            { headers: { apikey: SERVICE_ROLE, Authorization: 'Bearer ' + SERVICE_ROLE } });
          const s = sr.ok ? await sr.json() : []; const su = s && s[0];
          if (su && su.active !== false && ADMIN_ROLES[String(su.role || '').toLowerCase()]) return true;
        }
      }
    } catch (e) { /* fall through */ }
  }
  return !!(ADMIN_TOKEN && (event.headers['x-admin-token'] || event.headers['X-Admin-Token']) === ADMIN_TOKEN);
}

// ---- tiny HTML helpers (no DOM dependency) ------------------------------
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, function (_, n) { try { return String.fromCharCode(+n); } catch (e) { return ''; } });
}
function stripTags(s) { return decodeEntities(String(s == null ? '' : s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function absolutize(u, base) { try { return new URL(u, base).href; } catch (e) { return u; } }

function jsonLdBlocks(html) {
  var out = [], re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, m;
  while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1].trim())); } catch (e) { /* ignore malformed */ } }
  return out;
}
function flattenLd(blocks) {
  var flat = [];
  blocks.forEach(function (b) {
    if (Array.isArray(b)) flat = flat.concat(b);
    else if (b && b['@graph']) flat = flat.concat(b['@graph']);
    else if (b) flat.push(b);
  });
  return flat;
}
function isProduct(node) {
  var t = node && node['@type']; if (!t) return false;
  return [].concat(t).some(function (x) { return String(x).toLowerCase() === 'product'; });
}
function metaTag(html, prop) {
  var re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>', 'i');
  var m = html.match(re); if (!m) return '';
  var c = m[0].match(/content=["']([^"']*)["']/i); return c ? decodeEntities(c[1]).trim() : '';
}
function firstTag(html, tag) { var m = html.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i')); return m ? stripTags(m[1]) : ''; }

// ---- images -------------------------------------------------------------
var IMG_SKIP = /(sprite|logo|icon|favicon|placeholder|pixel|spacer|blank|loading|avatar|badge|flag-|social|facebook|twitter|instagram|youtube|linkedin|cart|search)/i;
function collectImages(html, base) {
  var urls = [], push = function (u) {
    if (!u) return; u = u.trim(); if (!u || u.indexOf('data:') === 0) return;
    if (/\.svg(\?|$)/i.test(u) || IMG_SKIP.test(u)) return;
    var abs = absolutize(u, base); if (urls.indexOf(abs) < 0) urls.push(abs);
  };
  var re = /<img\b[^>]*>/gi, m;
  while ((m = re.exec(html))) {
    var tag = m[0];
    var src = tag.match(/\bsrc=["']([^"']+)["']/i);
    var lazy = tag.match(/\bdata-(?:src|lazy-src|original)=["']([^"']+)["']/i);
    var sset = tag.match(/\b(?:data-)?srcset=["']([^"']+)["']/i);
    if (lazy) push(lazy[1]);
    if (src && !/^data:/i.test(src[1])) push(src[1]);
    if (sset) push(sset[1].split(',')[0].trim().split(/\s+/)[0]);
  }
  var sre = /<source\b[^>]*\bsrcset=["']([^"']+)["'][^>]*>/gi;
  while ((m = sre.exec(html))) push(m[1].split(',')[0].trim().split(/\s+/)[0]);
  return urls.slice(0, 30).map(function (u) { return { url: u }; });
}

// ---- tables (sizing / spec) --------------------------------------------
var SIZE_HINT = /\b(sku|size|height|weight|width|length|model|fit|color|colour|part\s*#|part\s*no|item\s*#|catalog|dimension)\b/i;
function parseTables(html) {
  var tables = [], tre = /<table\b[\s\S]*?<\/table>/gi, tm;
  while ((tm = tre.exec(html))) {
    var t = tm[0], rows = [], rre = /<tr\b[\s\S]*?<\/tr>/gi, rm;
    while ((rm = rre.exec(t))) {
      var cells = [], cre = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi, cm;
      while ((cm = cre.exec(rm[0]))) cells.push(stripTags(cm[2]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length >= 2) tables.push(rows);
  }
  // Pick the table that most looks like a sizing/spec chart.
  var best = null, bestScore = 0;
  tables.forEach(function (rows) {
    var header = rows[0].join(' | ');
    var score = (SIZE_HINT.test(header) ? 3 : 0) + Math.min(rows.length, 8);
    if (score > bestScore) { bestScore = score; best = rows; }
  });
  if (!best || !SIZE_HINT.test(best[0].join(' '))) return { rows: [], columns: [] };
  var header = best[0].map(function (h) { return h.trim() || 'col'; });
  var out = best.slice(1).map(function (r) {
    var o = {}; header.forEach(function (h, i) { o[h] = r[i] != null ? r[i] : ''; }); return o;
  }).filter(function (o) { return Object.keys(o).some(function (k) { return o[k]; }); });
  return { rows: out, columns: header };
}

// ---- features -----------------------------------------------------------
function parseFeatures(html) {
  var idx = html.search(/features?\b/i);
  if (idx < 0) return [];
  var slice = html.slice(idx, idx + 4000);
  var ul = slice.match(/<ul\b[\s\S]*?<\/ul>/i);
  if (!ul) return [];
  var items = [], lre = /<li\b[^>]*>([\s\S]*?)<\/li>/gi, lm;
  while ((lm = lre.exec(ul[0]))) { var t = stripTags(lm[1]); if (t && t.length < 220) items.push(t); }
  return items.slice(0, 12);
}

// ---- assemble -----------------------------------------------------------
function parse(html, base) {
  var ld = flattenLd(jsonLdBlocks(html)).find(isProduct) || null;

  var name = (ld && stripTags(ld.name)) || metaTag(html, 'og:title') || firstTag(html, 'h1') || firstTag(html, 'title');
  var description = (ld && stripTags(ld.description)) || metaTag(html, 'og:description') || metaTag(html, 'description');

  // images: JSON-LD first (most authoritative), then page gallery
  var images = [];
  if (ld && ld.image) {
    [].concat(ld.image).forEach(function (im) {
      var u = (typeof im === 'string') ? im : (im && (im.url || im.contentUrl));
      if (u) images.push({ url: absolutize(u, base) });
    });
  }
  collectImages(html, base).forEach(function (g) { if (!images.some(function (x) { return x.url === g.url; })) images.push(g); });
  images = images.slice(0, 24);

  // options / billing from JSON-LD additionalProperty, when present
  var options = {}, billing = [];
  if (ld && ld.additionalProperty) {
    [].concat(ld.additionalProperty).forEach(function (p) {
      var n = p && stripTags(p.name || ''), v = p && stripTags(String(p.value == null ? '' : p.value));
      if (!n || !v) return;
      if (/hcpcs|l-?code|billing|code/i.test(n)) billing.push(v);
      else options[n] = v.split(/[,/]/).map(function (s) { return s.trim(); }).filter(Boolean);
    });
  }
  if (ld && ld.sku && !billing.length && /^[A-Z]\d{3,5}$/.test(String(ld.sku))) { /* sku is a catalog #, not HCPCS — skip */ }

  var table = parseTables(html);
  var features = parseFeatures(html);

  return {
    name: name || '', tagline: '', description: description || '',
    features: features, clinical_applications: [],
    options: options, billing_codes: billing,
    images: images,
    sizing_rows: table.rows, sizing_note: '',
    source_url: base,
    raw: { sizing_columns: table.columns, had_jsonld_product: !!ld, image_count: images.length }
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'method not allowed' });
  if (!(await isAdminReq(event))) return reply(401, { ok: false, error: 'sign in to Connect 360 to continue' });

  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const url = (body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return reply(400, { ok: false, error: 'a valid http(s) url is required' });

  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 12000);
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; HCPS-Partner360-ContentBot/1.0)', 'accept': 'text/html,*/*' }
    });
    clearTimeout(timer);
    if (!r.ok) return reply(502, { ok: false, error: 'fetch failed: HTTP ' + r.status });
    const ct = r.headers.get('content-type') || '';
    if (ct && ct.indexOf('html') < 0) return reply(415, { ok: false, error: 'not an HTML page (' + ct + ')' });
    let html = await r.text();
    if (html.length > 3000000) html = html.slice(0, 3000000);   // cap very large pages
    const data = parse(html, r.url || url);
    return reply(200, { ok: true, data: data });
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.name === 'AbortError') ? 'timed out fetching the page' : String((e && e.message) || e);
    return reply(500, { ok: false, error: msg });
  }
};

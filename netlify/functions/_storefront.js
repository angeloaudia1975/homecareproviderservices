/* C3-07 Stage 7 — dealer-branded public storefronts: the pure rules (no I/O), shared by dealer-storefront-api (the dealer
   manages it) and storefront-public (what the public sees).
   D3 PRICES: a product shows the manufacturer's VERIFIED MSRP (the commercial record's MSRP when it isn't HCPS-derived, else a
   saved catalog edit's, else an added product's — the same order as brochures) or "Call for Price". A dealer's own retail is
   never public until a manufacturer's advertising (MAP) policy is on record as allowing it (none is yet). Wholesale, tiers,
   contract prices, MAP and account numbers are never part of a public answer: publicProduct() whitelists the fields.
   D4: nothing about a visitor is kept — inquiries hold only what the person typed. */
'use strict';
const RESERVED = new Set(['admin', 'api', 'store', 'stores', 'hcps', 'homecare', 'login', 'signin', 'account', 'dealer', 'dealers', 'test', 'www', 'golden', 'preview', 'assets', 'data']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PHONE_RE = /^[0-9+().\-\s xextEXT]{7,40}$/;

function slugify(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, ''); }
function slugProblem(s) {
  if (!SLUG.test(String(s || ''))) return 'Use 3–50 lower-case letters, numbers and dashes (not starting or ending with a dash).';
  if (RESERVED.has(s) || /--/.test(s)) return 'That address is not available — please choose another.';
  return null;
}
const clean = (v, max) => { const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(); return s ? s.slice(0, max) : null; };

/* the dealer's settings: only these fields, each checked; returns {patch} or {error} */
function validateSettings(b, authorizedLines) {
  const p = {};
  if ('enabled' in b) p.enabled = b.enabled === true;
  if ('headline' in b) p.headline = clean(b.headline, 120);
  if ('about' in b) p.about = clean(b.about, 1500);
  if ('hours' in b) p.hours = clean(b.hours, 300);
  if ('show_address' in b) p.show_address = b.show_address !== false;
  if ('phone' in b) { const v = clean(b.phone, 40); if (v && !PHONE_RE.test(v)) return { error: 'Please enter a valid phone number.' }; p.phone = v; }
  if ('email' in b) { const v = clean(b.email, 200); if (v && !EMAIL_RE.test(v)) return { error: 'Please enter one valid email address.' }; p.email = v ? v.toLowerCase() : null; }
  if ('price_mode' in b) { if (!['msrp', 'call'].includes(b.price_mode)) return { error: 'Choose how prices show.' }; p.price_mode = b.price_mode; }
  if ('lines' in b) {
    if (b.lines == null) p.lines = null;
    else { if (!Array.isArray(b.lines) || b.lines.length > 40) return { error: 'Choose the lines to show.' };
      const ok = new Set(authorizedLines); const L = [...new Set(b.lines.map(String))]; if (L.some((x) => !ok.has(x))) return { error: 'You can show only lines your account is authorized for.' }; p.lines = L; }
  }
  if ('hidden_categories' in b) { if (!Array.isArray(b.hidden_categories) || b.hidden_categories.length > 200) return { error: 'Bad category list.' }; p.hidden_categories = [...new Set(b.hidden_categories.map((x) => clean(x, 120)).filter(Boolean))]; }
  if ('slug' in b) { const s = String(b.slug || '').toLowerCase(); const e = slugProblem(s); if (e) return { error: e }; p.slug = s; }
  return { patch: p };
}

/* the commercial facts for one line → { verified MSRP by code, hidden codes (exact and upper-case), only (null, or the codes
   an enriched-only line may show) }. Hidden: a record that isn't active; a saved edit switched off / hidden / retired /
   discontinued; an enrichment page discontinued, hidden or switched off (its SKUs); a SKU switched off, hidden or
   discontinued on its page. A public storefront never shows a discontinued product (the dealer shop keeps them for
   reference — visible ≠ sellable). Enriched-only lines show only SKUs on a published/active page. */
function lineFacts({ records, overrides, custom, pages, enrichedOnly }) {
  const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
  const U = (c) => String(c == null ? '' : c).trim().toUpperCase();
  const msrp = new Map(), hidden = new Set(), hiddenU = new Set(), rec = new Map();
  for (const r of records || []) { rec.set(String(r.code), r); if (r.status && r.status !== 'active') hidden.add(String(r.code)); }
  const unit = new Map();   // the master record's unit and MSRP basis, where it states them
  for (const r of records || []) if (r.uom || r.case_qty || r.msrp_basis) unit.set(String(r.code), { uom: r.uom, case_qty: r.case_qty, msrp_basis: r.msrp_basis });
  for (const o of overrides || []) { const p = o.patch || {}; if (p.active === false || p.hidden === true || p.retired === true || p.discontinued === true) hidden.add(String(o.code)); }
  // pages are read the way the dealer shop reads them: only VISIBLE pages (published / active / discontinued, not switched
  // off) count — a hidden or draft page is ignored and its SKUs keep their catalog cards. From a visible page: discontinued →
  // its SKUs hidden here; a SKU switched off, hidden or discontinued on it → hidden.
  const only = enrichedOnly ? new Set() : null;
  for (const pg of pages || []) {
    const st = String(pg.status || '');
    if (pg.disabled === true || !['published', 'active', 'discontinued'].includes(st)) continue;
    for (const sx of Array.isArray(pg.skus) ? pg.skus : []) {
      const c = U(sx && (sx.sku || sx.code)); if (!c) continue;
      const sst = String((sx && sx.status) || '');
      if (st === 'discontinued' || sx.disabled === true || sst === 'hidden' || sst === 'discontinued') hiddenU.add(c);
      else if (only) only.add(c);
    }
  }
  const codes = new Set([...rec.keys(), ...(overrides || []).map((o) => String(o.code)), ...(custom || []).map((c) => String(c.code))]);
  for (const code of codes) {
    const r = rec.get(code);
    if (r) { if (r.msrp_auto !== true && num(r.msrp)) msrp.set(code, num(r.msrp)); continue; }   // the record answers when it has the SKU
    const o = (overrides || []).find((x) => String(x.code) === code); const om = o && o.patch && o.patch.msrp_auto !== true && num(o.patch.msrp);
    if (om) { msrp.set(code, om); continue; }
    const c = (custom || []).find((x) => String(x.code) === code); if (c && c.msrp_auto !== true && num(c.msrp)) msrp.set(code, num(c.msrp));
  }
  const isHidden = (code) => hidden.has(String(code)) || hiddenU.has(U(code)) || (only ? !only.has(U(code)) : false);
  return { msrp, hidden, hiddenU, only, isHidden, unit };
}

/* the unit an MSRP is quoted for (Phase 4 basis): the master record's msrp_basis, else the catalog's msrp_each, else the order
   unit. "each" on a pack → "each"; per order unit on a pack → "per <unit> (n each)"; a single item → nothing. Unit and pack size
   come from the master record when it states them. */
function unitOf(p, r) {
  r = r || {};
  const u = clean(r.uom || p.uom, 40); const q = Number(r.case_qty || p.case_qty);
  const pack = q > 1 || (u && !/^(each|ea|1)$/i.test(u));
  if (!pack) return null;
  const basis = r.msrp_basis === 'each' || r.msrp_basis === 'order_unit' ? r.msrp_basis : (p.msrp_each === true ? 'each' : 'order_unit');
  if (basis === 'each') return 'each';
  if (u && !/^(each|ea|1)$/i.test(u)) return 'per ' + u + (q > 1 && !/\d/.test(u) ? ` (${q} each)` : '');
  return `per pack of ${q}`;
}
const IMG = /^\/assets\/[A-Za-z0-9._\/%+-]{1,300}$/;   // our own product photos only — never a third-party host (D4: it would see visitors)
/* ONE public product — a whitelist; nothing else from the catalog file ever leaves */
function publicProduct(p, line, facts, priceMode) {
  const attrs = {};
  if (p.attributes && typeof p.attributes === 'object') for (const [k, v] of Object.entries(p.attributes).slice(0, 20)) { const kk = clean(k, 60), vv = clean(v, 160); if (kk && vv) attrs[kk] = vv; }
  const price = priceMode === 'msrp' ? (facts.msrp.get(String(p.code)) || null) : null;
  return { manufacturer: line, code: String(p.code).slice(0, 80), name: clean(p.name, 200) || String(p.code), category: clean(p.category, 120) || 'Other',
    subcategory: clean(p.subcategory, 120), brand: clean(p.brand, 80), description: clean(p.description, 1200), uom: clean(p.uom, 40),
    image: IMG.test(String(p.image || '')) ? String(p.image) : null, attributes: attrs, price, price_label: price ? 'MSRP' : 'Call for Price',
    price_unit: price ? unitOf(p, facts.unit && facts.unit.get(String(p.code))) : null };
}

/* an inquiry from the public: what the person typed, checked; {row} or {error}. hp = honeypot field (must stay empty) */
function validateInquiry(b) {
  if (String(b.hp || '')) return { spam: true };
  const name = clean(b.name, 120), email = clean(b.email, 200), phone = clean(b.phone, 40), message = clean(b.message, 2000);
  if (!name) return { error: 'Please enter your name.' };
  if (!email && !phone) return { error: 'Please enter an email address or a phone number so the dealer can reach you.' };
  if (email && !EMAIL_RE.test(email)) return { error: 'Please enter a valid email address.' };
  if (phone && !PHONE_RE.test(phone)) return { error: 'Please enter a valid phone number.' };
  if (b.consent !== true) return { error: 'Please agree to the dealer contacting you about your request.' };
  const pr = b.product && typeof b.product === 'object' ? b.product : null;
  const mfr = pr && /^[a-z0-9-]{2,60}$/.test(String(pr.manufacturer || '')) ? String(pr.manufacturer) : null;
  // product_name is never the visitor's text: the server fills it from the catalog for a product this storefront shows
  return { row: { name: name.replace(/[\r\n\t]+/g, ' '), email: email ? email.toLowerCase() : null, phone, message, manufacturer: mfr, product_code: mfr ? clean(pr.code, 80) : null, product_name: null } };
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inquiryEmail(row, sf, dealerName, link) {
  const lines = [['Name', row.name], ['Email', row.email], ['Phone', row.phone], ['Product', row.product_name ? `${row.product_name}${row.product_code ? ' (#' + row.product_code + ')' : ''}` : null], ['Message', row.message]].filter((x) => x[1]);
  const subj = `New request from your storefront${row.product_name ? ' — ' + String(row.product_name).slice(0, 60) : ''}`.replace(/[\r\n\t]+/g, ' ');
  return { subject: subj,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0b0d0f"><p>Someone sent a request from <b>${esc(dealerName)}</b>'s storefront (${esc(link)}).</p>
<table style="border-collapse:collapse">${lines.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${k}</td><td style="padding:4px 0;white-space:pre-wrap">${esc(v)}</td></tr>`).join('')}</table>
<p style="color:#777;font-size:12px">Reply to this email to answer them. You can mark the request handled or delete it in the 360 Dealer Portal → My Storefront. Requests are kept for 24 months.</p></div>` };
}
/* a logo the public page may show: an image we host (our storage / the ordering site's /assets) or an inline image — never a
   third-party address (it would see every visitor's network address, D4) */
function logoOk(u, supabaseUrl) {
  const v = String(u || '');
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]{1,700000}$/.test(v)) return true;
  if (/^\/assets\/[A-Za-z0-9._\/%+-]{1,300}$/.test(v)) return true;
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  return !!base && v.startsWith(base + '/storage/v1/object/public/') && /^[^\s"'<>`]{1,1900}$/.test(v) && !/\.\./.test(v);
}
module.exports = { logoOk, unitOf, slugify, slugProblem, validateSettings, lineFacts, publicProduct, validateInquiry, inquiryEmail, RESERVED, EMAIL_RE };

/* SOCIAL MEDIA AD BUILDER — the pure rules (owner directive 2026-11-06 20:55 CT, §8). No I/O.
   Shared by dealer-ads-api (save / list / publish checks) and its tests; the 360 Dealer Portal's editor mirrors the limits.

   What an ad may contain:
   - products: only the location's AUTHORIZED, currently listed products — the public storefront's own product set
     (_storefront_catalog.build: active Dealer Manager lines, discontinued / hidden / switched-off never), with their official
     photo, name and description. The price on an ad is NEVER typed: it is the storefront's advertised price for that product
     (MAP / advertising rules applied by _retail_price) or "Call for Price", resolved again every time the ad is opened.
   - the dealer's own words (headline, message, call to action, caption): checked by claimProblem() — no price figures,
     discounts, promotions, guarantees, medical or coverage claims. HCPS never invents them, and the dealer's own text may not
     carry them either (a promotion needs the manufacturer's approved program, which this tool does not run).
   - the dealer's name, address, phone, website / storefront link and logo, taken from the account (never typed here).
   Captions and hashtags are suggested deterministically from the product names, categories, line names and the dealer's
   own city — no AI, so nothing is invented. */
'use strict';

const FORMATS = {
  square: { w: 1080, h: 1080, label: 'Square 1:1 — Facebook / Instagram feed' },
  portrait: { w: 1080, h: 1350, label: 'Portrait 4:5 — Instagram / Facebook feed' },
  story: { w: 1080, h: 1920, label: 'Story 9:16 — Instagram / Facebook Stories' },
  landscape: { w: 1200, h: 628, label: 'Landscape 1.91:1 — Facebook / LinkedIn link post' },
};
/* kind: 'single' = exactly one product · 'multi' = 2–4 products · 'general' = no product */
const TEMPLATES = {
  spotlight: { kind: 'single', label: 'Product spotlight' },
  classic: { kind: 'single', label: 'Clean card' },
  split: { kind: 'single', label: 'Photo + story' },
  grid: { kind: 'multi', label: 'Product grid (2–4)' },
  lineup: { kind: 'multi', label: 'Line-up (2–3)', max: 3 },
  brand: { kind: 'general', label: 'Store message (no product)' },
};
const FONTS = ['Inter', 'Archivo', 'Georgia', 'Trebuchet', 'Verdana'];
const CTAS = ['Visit us today', 'Call for details', 'Shop now', 'Learn more', 'Stop by our showroom', 'Ask about this product', 'See it in store', 'Contact us'];
const HEX = /^#[0-9a-f]{6}$/i;
const LIMITS = { title: 80, headline: 90, body: 260, cta: 40, caption: 2200, hashtags: 15, hashtag: 40 };

/* review #115: NFKC (full-width "＄", ligatures) and no invisible format characters (zero-width spaces etc.) — so a hidden
   character can't split a word past the check */
const norm = (v) => String(v == null ? '' : v).normalize('NFKC').replace(/[\p{Cf}\u00ad]/gu, '');
const clean = (v, max) => norm(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+\n/g, '\n').trim().slice(0, max);

/* the words an ad may not carry. Each entry: [pattern, plain reason]. Price figures are never typed — the product's own
   advertised price is placed by the template. */
const CLAIMS = [
  [/[$€£¢]\s*\d[\d,.]*|\d[\d,.]*\s*(?:dollars?|usd|bucks)\b|\b\d{1,6}\.\d{2}\b|\b(?:was|now|only|just|from|starting at|under|less than)\s+\d[\d,.]*|\b\d{2,6}\s+(?:each|ea)\b/i, 'a price or dollar amount (prices are placed automatically from the catalog)'],
  [/\d+(?:\.\d+)?\s*%|\bpercent\b/i, 'a percentage'],
  [/\b(?:discount(?:s|ed)?|sale|sales event|clearance|markdowns?|mark-downs?|save|savings|rebates?|coupons?|promo|promos|promotion(?:s|al)?|promo code|deal|deals|bogo|buy one get|half[- ]off|half[- ]price|bucks off|dollars off|two for one|2 for 1|\d+ for \d+|reduced|markdown|low prices?|cheap\w*|bargains?|specials?|giveaways?|giving away|win a|contest)\b/i, 'a discount or promotion'],
  [/\bfree\b|\bcomplimentary\b|\bno charge\b|\bat no cost\b|\bon us\b/i, '"free" (an offer)'],
  [/\b(?:lowest|cheapest|best)\s+price\w*|\bprice match\w*|\bbeat any\b/i, 'a price comparison'],
  [/\blimited[- ]time\b|\bwhile supplies last\b|\btoday only\b|\bends (?:soon|today|tomorrow)\b/i, 'a time-limited offer'],
  [/\bguarantee\w*|\bwarrant(?:y|ies|ied)\b/i, 'a guarantee or warranty claim'],
  [/\b(?:cures?|cured|heals?|healing|treats?|treatment|treating|prevents?|preventing|diagnos(?:e|es|is|tic)|therapeutic|clinically|doctor[- ]recommended|fda[- ](?:approved|cleared))\b/i, 'a medical claim'],
  [/\b(?:medicare|medicaid|insurance|covered by|reimburs\w*|no cost to you|zero cost)\b/i, 'an insurance or coverage claim'],
  [/\bfinanc(?:e|ing)\b|\bno interest\b|\bper month\b|\b\/mo\b|\bmonthly payment/i, 'a financing offer'],
  [/#\s?1\b|\bno\.\s?1\b|\b(?:number one|best[- ]selling|best[- ]seller|top[- ]rated|award[- ]winning)\b/i, 'a ranking or award claim'],
];
/* allow: phrases on record that may appear verbatim (official product names, categories, line and dealer names) — e.g. a
   product officially named "Heat Therapy Pad" or a store called "Free State Medical" is a name, not a claim */
function claimProblem(text, allow) {
  let s = norm(text);
  for (const a of allow || []) { const t = String(a || '').trim(); if (t.length >= 3) s = s.split(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' '); }
  for (const [re, why] of CLAIMS) { const m = s.match(re); if (m) return { phrase: m[0].trim(), reason: why }; }
  return null;
}

/* a hashtag is one joined word ("#freeshipping"), so it is checked as a whole for these pieces (names on record allowed) */
const TAG_BAD = /free|sale|discount|deals?(?!er)|\d+off|halfoff|halfprice|price|promo|coupon|rebate|clearance|cheap|bogo|save|saving|bargain|giveaway|medicare|insurance|financ|cure|guarantee|warrant/;
const tagify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^A-Za-z0-9]+/g, ' ').trim()
  .split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, LIMITS.hashtag);

/* validate the dealer's saved ad. products: the authorized list for the location (Map key "manufacturer|CODE"). Returns
   { ad } (the cleaned document) or { error, field }. */
function validate(input, products, opts) {
  const b = input && typeof input === 'object' ? input : {};
  const template = String(b.template || ''); const T = TEMPLATES[template];
  if (!T) return { error: 'Choose a template.', field: 'template' };
  const format = String(b.format || ''); if (!FORMATS[format]) return { error: 'Choose a size.', field: 'format' };
  const font = FONTS.includes(b.font) ? b.font : FONTS[0];
  const colors = {}; for (const k of ['bg', 'accent', 'text']) { const v = b.colors && b.colors[k]; if (v != null && !HEX.test(String(v))) return { error: 'Colors must be #RRGGBB.', field: 'colors' }; colors[k] = v ? String(v).toLowerCase() : null; }
  const show = {}; for (const k of ['logo', 'name', 'address', 'phone', 'website', 'price']) show[k] = !(b.show && b.show[k] === false);
  const out = { template, format, font, colors, show, title: clean(b.title, LIMITS.title) || null,
    headline: clean(b.headline, LIMITS.headline), body: clean(b.body, LIMITS.body), cta: clean(b.cta, LIMITS.cta), caption: clean(b.caption, LIMITS.caption), hashtags: [], products: [] };
  if (!out.headline && T.kind === 'general') return { error: 'Add a headline.', field: 'headline' };
  const allow = [].concat(opts && opts.allow || []);
  for (const p of Array.isArray(b.products) ? b.products : []) { const r = products && products.get(`${String((p && p.manufacturer) || '')}|${String((p && p.code) || '').toUpperCase()}`); if (r) allow.push(r.name, r.category, r.brand); }
  for (const f of ['headline', 'body', 'cta', 'caption']) { const c = claimProblem(out[f], allow); if (c) return { error: `The ${f === 'cta' ? 'call to action' : f} contains ${c.reason} ("${c.phrase}") — ads may not carry prices, discounts, promotions or claims.`, field: f, phrase: c.phrase }; }
  const allowTags = new Set(allow.map((x) => tagify(x).toLowerCase()).filter(Boolean));
  const tags = Array.isArray(b.hashtags) ? b.hashtags : String(b.hashtags || '').split(/[\s,]+/);
  for (const t of tags) { const v = tagify(String(t || '').replace(/^#/, '')); if (!v) continue; if (!allowTags.has(v.toLowerCase()) && (TAG_BAD.test(v.toLowerCase()) || claimProblem(v.replace(/([a-z])([A-Z])/g, '$1 $2')))) return { error: `The hashtag #${v} is a promotion or claim.`, field: 'hashtags' };
    if (!out.hashtags.includes(v)) out.hashtags.push(v); if (out.hashtags.length >= LIMITS.hashtags) break; }
  const ps = Array.isArray(b.products) ? b.products : [];
  const seen = new Set();
  for (const p of ps) {
    const key = `${String((p && p.manufacturer) || '')}|${String((p && p.code) || '').toUpperCase()}`;
    if (seen.has(key)) continue; seen.add(key);
    if (!products || !products.has(key)) return { error: 'One of the products is not one of your authorized, currently listed products.', field: 'products', product: key };
    out.products.push({ manufacturer: String(p.manufacturer), code: String(p.code), show_price: p.show_price !== false });
  }
  const n = out.products.length, max = T.max || 4;
  if (T.kind === 'single' && n !== 1) return { error: 'This template shows exactly one product.', field: 'products' };
  if (T.kind === 'multi' && (n < 2 || n > max)) return { error: `This template shows 2–${max} products.`, field: 'products' };
  if (T.kind === 'general' && n) return { error: 'The store-message template shows no product.', field: 'products' };
  return { ad: out };
}

/* what the editor and the export render for each product: the storefront's own public fields, never cost or MAP */
function renderProduct(p, showPrice) {
  const price = showPrice && p.price != null ? p.price : null;
  return { manufacturer: p.manufacturer, code: p.code, name: p.name, category: p.category || null, brand: p.brand || null, description: p.description || null,
    image: p.image || null, price, price_label: showPrice ? (price != null ? (p.price_label || null) : 'Call for Price') : null, price_unit: price != null ? (p.price_unit || null) : null };
}

/* suggested caption + hashtags: only facts on record (product names, categories, line names, the dealer's name / city /
   phone / link) — never a claim, discount or promotion. Three variants. */
function suggest({ products, dealer, cta }) {
  const ps = (products || []).slice(0, 4); const d = dealer || {};
  const names = ps.map((p) => p.name).filter(Boolean);
  const where = [d.city, d.state].filter(Boolean).join(', ');
  const call = cta && !claimProblem(cta) ? cta : 'Visit us today';
  const contact = [d.phone ? `Call ${d.phone}` : null, d.link ? d.link : null].filter(Boolean).join(' · ');
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0] || '';
  const store = d.name || 'our store';
  const captions = names.length ? [
    `Now at ${store}${where ? ' in ' + where : ''}: ${list}. ${call}${contact ? ' — ' + contact : ''}.`,
    `Looking for ${names.length > 1 ? 'the right fit' : names[0]}? See ${names.length > 1 ? list : 'it'} in person at ${store}. ${contact || call}.`,
    `${list}${names.length > 1 ? ' are' : ' is'} available through ${store}. Our team is happy to help you choose. ${call}.`,
  ] : [
    `${store}${where ? ' — serving ' + where : ''}. ${call}${contact ? ' — ' + contact : ''}.`,
    `Questions about home medical equipment? The team at ${store} is here to help. ${contact || call}.`,
    `Stop by ${store}${where ? ' in ' + where : ''} and see what we carry. ${call}.`,
  ];
  const tags = [];
  const push = (s) => { const v = tagify(s); if (v && v.length > 2 && !tags.includes(v)) tags.push(v); };   // names on record only
  for (const p of ps) { push(p.category); push(p.brand); }
  push('HomeMedicalEquipment'); push(d.city); push(d.name);
  const allow = [d.name, d.city].concat(...ps.map((p) => [p.name, p.category, p.brand]));
  return { captions: captions.map((c) => c.replace(/\s+/g, ' ').replace(/\.\./g, '.').trim().slice(0, LIMITS.caption)).filter((c) => !claimProblem(c, allow)), hashtags: tags.slice(0, 8) };
}

module.exports = { norm, TAG_BAD, FORMATS, TEMPLATES, FONTS, CTAS, LIMITS, validate, claimProblem, renderProduct, suggest, tagify };

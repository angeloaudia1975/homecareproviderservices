/**
 * Partner 360 · 3-source content reconciliation (pure, testable)
 *
 * Given three captured sources for one product page — Current HCPS Data, the
 * Manufacturer Website, and the Manufacturer PDF/catalog — produce the merge the
 * enrichment review screen renders: per-field values with provenance + a flag
 * (match / new / conflict / missing) and a suggested "best" source, a de-duplicated
 * image gallery, a reconciled sizing/spec table, and roll-up flag counts.
 *
 * No I/O here. product-content.js loads the three source rows and calls computeMerge.
 */

var SOURCES = ['hcps', 'website', 'pdf'];
var SOURCE_LABEL = { hcps: 'Current HCPS Data', website: 'Manufacturer Website', pdf: 'Manufacturer PDF' };

// Which fields we reconcile, in display order. type drives comparison + emptiness.
var FIELDS = [
  { key: 'name',                  label: 'Product Name',          type: 'text' },
  { key: 'tagline',               label: 'Tagline',               type: 'text' },
  { key: 'description',           label: 'Description',           type: 'text' },
  { key: 'features',              label: 'Features',              type: 'list' },
  { key: 'clinical_applications', label: 'Clinical Applications', type: 'list' },
  { key: 'options',               label: 'Options & Variants',    type: 'map'  },
  { key: 'billing_codes',         label: 'Billing / HCPCS Codes', type: 'list' }
];

// For a conflict/new pick, which source we lean toward per field (before richness tie-break).
var PREFER = {
  description: ['website', 'pdf', 'hcps'],
  tagline:     ['website', 'pdf', 'hcps'],
  name:        ['hcps', 'website', 'pdf'],
  features:    ['pdf', 'website', 'hcps'],
  clinical_applications: ['pdf', 'website', 'hcps'],
  options:     ['pdf', 'website', 'hcps'],
  billing_codes: ['pdf', 'website', 'hcps']
};

function normText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }
function isEmpty(v, type) {
  if (v == null) return true;
  if (type === 'list') return !(Array.isArray(v) && v.length);
  if (type === 'map')  return !(v && typeof v === 'object' && Object.keys(v).length);
  return String(v).trim() === '';
}
function listNorm(a) { return (Array.isArray(a) ? a : []).map(normText).filter(Boolean).sort(); }
function setEq(a, b) { var x = listNorm(a), y = listNorm(b); return x.length === y.length && x.every(function (v, i) { return v === y[i]; }); }
function mapNorm(m) {
  var out = {}; if (!m || typeof m !== 'object') return out;
  Object.keys(m).sort().forEach(function (k) { out[normText(k)] = listNorm([].concat(m[k])); });
  return out;
}
function eqVal(a, b, type) {
  if (type === 'list') return setEq(a, b);
  if (type === 'map')  return JSON.stringify(mapNorm(a)) === JSON.stringify(mapNorm(b));
  return normText(a) === normText(b);
}
// "Richness" — how much a value carries, for tie-breaking the best-version pick.
function richness(v, type) {
  if (isEmpty(v, type)) return -1;
  if (type === 'list') return v.length;
  if (type === 'map')  return Object.keys(v).reduce(function (n, k) { return n + [].concat(v[k]).length; }, 0);
  return String(v).trim().length;
}

function flagField(field, srcVals) {
  var type = field.type;
  var values = {};
  SOURCES.forEach(function (s) { values[s] = isEmpty(srcVals[s], type) ? null : srcVals[s]; });
  var present = SOURCES.filter(function (s) { return values[s] != null; });

  var flag, suggested = null;
  if (!present.length) {
    flag = 'missing';
  } else {
    var hcpsEmpty = values.hcps == null;
    var others = present.filter(function (s) { return s !== 'hcps'; });
    if (hcpsEmpty && others.length) {
      flag = 'new';
    } else if (!hcpsEmpty && others.some(function (s) { return !eqVal(values.hcps, values[s], type); })) {
      flag = 'conflict';
    } else {
      flag = 'match';
    }
    // Suggested best version.
    if (flag === 'match' && values.hcps != null) {
      suggested = 'hcps';                                   // keep current if everyone agrees
    } else {
      var order = (PREFER[field.key] || ['hcps', 'website', 'pdf']).filter(function (s) { return present.indexOf(s) >= 0; });
      // richest wins; ties fall back to the PREFER order above
      suggested = order.slice().sort(function (a, b) { return richness(values[b], type) - richness(values[a], type); })[0] || present[0];
    }
  }
  return { key: field.key, label: field.label, type: type, values: values, present: present, flag: flag, suggested: suggested };
}

// ---- Images -------------------------------------------------------------
// Normalize a URL to a comparison key: basename, lowercased, query stripped,
// leading ordinal ("01-") and a few size/color suffixes removed. Combined with an
// optional perceptual hash (set by the scraper) this catches the same photo under
// different names/paths across sources.
function imgKey(img) {
  // A perceptual hash (set by the scraper when it downloads the image) is the only reliable way
  // to catch the SAME photo under different names across sources — e.g. an existing HCPS photo that
  // is really the manufacturer's angle shot. When present it wins. Without it we only collapse
  // genuine resize variants of one file (thumbnail vs full), never different views/colors, so
  // distinct angle/front/side/black/white images all stay separate and read as "new".
  if (img && img.hash) return 'h:' + String(img.hash).toLowerCase();
  var u = String((img && img.url) || '').split('?')[0].split('#')[0];
  var base = u.substring(u.lastIndexOf('/') + 1).toLowerCase();
  base = base.replace(/\.[a-z0-9]+$/, '');            // drop extension
  base = base.replace(/^\d{1,2}[-_]/, '');            // drop leading ordinal "01-"
  base = base.replace(/[-_]scaled$/, '');             // WordPress -scaled variant
  base = base.replace(/[-_]\d{2,4}x\d{2,4}$/, '');    // WordPress resize suffix -1024x1024
  base = base.replace(/[^a-z0-9]+/g, '');
  return 'b:' + base;
}
function dedupeImages(sources) {
  // Canonical preference order: manufacturer website, then PDF, then the existing HCPS photo,
  // so a duplicate lands on the older HCPS copy (we prefer the manufacturer's own image).
  var order = ['website', 'pdf', 'hcps'];
  var seen = {}, out = [];
  order.forEach(function (src) {
    var imgs = (sources[src] && sources[src].images) || [];
    imgs.forEach(function (img, i) {
      if (!img || !img.url) return;
      var key = imgKey(img);
      var dup = Object.prototype.hasOwnProperty.call(seen, key);
      if (!dup) seen[key] = true;
      out.push({
        id: src + ':' + i,
        source: src,
        url: img.url,
        caption: img.caption || '',
        w: img.w || null, h: img.h || null,
        duplicate: dup,
        flag: dup ? 'dup' : (src === 'hcps' ? 'existing' : 'new'),
        primary: false
      });
    });
  });
  var firstPrimary = out.filter(function (g) { return !g.duplicate; })
    .sort(function (a, b) { return (a.source === 'website' ? 0 : 1) - (b.source === 'website' ? 0 : 1); })[0];
  if (firstPrimary) firstPrimary.primary = true;
  return out;
}

// ---- Sizing / spec table ------------------------------------------------
var SIZE_COL_ORDER = ['sku', 'product', 'name', 'color', 'size', 'fit', 'height', 'weight', 'width', 'length'];
function orderColumns(keys) {
  var lower = {}; keys.forEach(function (k) { lower[k] = k; });
  var ordered = [];
  SIZE_COL_ORDER.forEach(function (c) { keys.forEach(function (k) { if (k.toLowerCase() === c && ordered.indexOf(k) < 0) ordered.push(k); }); });
  keys.forEach(function (k) { if (ordered.indexOf(k) < 0) ordered.push(k); });
  return ordered;
}
function mergeSizing(sources) {
  // Choose the source with the most sizing rows (website usually), dedupe rows by SKU.
  var best = null;
  ['website', 'pdf', 'hcps'].forEach(function (src) {
    var rows = (sources[src] && sources[src].sizing_rows) || [];
    if (rows.length && (!best || rows.length > best.rows.length)) best = { src: src, rows: rows };
  });
  var hcpsHad = !!((sources.hcps && sources.hcps.sizing_rows || []).length);
  if (!best) return { rows: [], columns: [], note: '', source: null, isNew: false };
  var seen = {}, rows = [], keys = {};
  best.rows.forEach(function (r) {
    if (!r || typeof r !== 'object') return;
    var sku = normText(r.sku || r.SKU || '');
    var k = sku || JSON.stringify(r);
    if (seen[k]) return; seen[k] = true;
    Object.keys(r).forEach(function (c) { keys[c] = true; });
    rows.push(r);
  });
  var note = '';
  ['website', 'pdf', 'hcps'].forEach(function (s) { if (!note && sources[s] && sources[s].sizing_note) note = sources[s].sizing_note; });
  // Preserve the source's own column order (Object.keys keeps insertion order) so a captured
  // chart renders exactly as it appeared — e.g. Part Number · Description · Size · Product Sizing Details.
  return { rows: rows, columns: Object.keys(keys), note: note, source: best.src, isNew: !hcpsHad && best.src !== 'hcps' };
}

// ---- Top level ----------------------------------------------------------
function computeMerge(sources) {
  sources = sources || {};
  SOURCES.forEach(function (s) { if (!sources[s]) sources[s] = null; });

  var fields = FIELDS.map(function (f) {
    var vals = {};
    SOURCES.forEach(function (s) { vals[s] = sources[s] ? sources[s][f.key] : null; });
    return flagField(f, vals);
  });
  var images = dedupeImages(sources);
  var sizing = mergeSizing(sources);

  var newFields = fields.filter(function (f) { return f.flag === 'new'; }).length;
  var newImages = images.filter(function (g) { return g.flag === 'new'; }).length;
  var flags = {
    new:       newFields + newImages + (sizing.isNew ? 1 : 0),
    conflict:  fields.filter(function (f) { return f.flag === 'conflict'; }).length,
    missing:   fields.filter(function (f) { return f.flag === 'missing'; }).length,
    duplicate: images.filter(function (g) { return g.duplicate; }).length
  };

  return {
    sources: SOURCES.reduce(function (o, s) {
      o[s] = { present: !!sources[s], label: SOURCE_LABEL[s], url: (sources[s] && (sources[s].source_url || sources[s].url)) || '' };
      return o;
    }, {}),
    fields: fields,
    images: images,
    sizing: sizing,
    flags: flags
  };
}

module.exports = { computeMerge: computeMerge, flagField: flagField, dedupeImages: dedupeImages, mergeSizing: mergeSizing, imgKey: imgKey, FIELDS: FIELDS, SOURCES: SOURCES, SOURCE_LABEL: SOURCE_LABEL };

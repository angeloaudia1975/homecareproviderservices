/* C3-07 Stage 5 — completes a manufacturer's ORIGINAL application PDF with the dealer's answers (see _app_forms.js).
   build(key, answers, {preview}) → { bytes, sha256, placed:[keys], unplaced:[keys] }
   preview draws "Sign here" / "Date" boxes where the signer will sign (the dealer's review copy); the copy sent for
   signing has none — Documenso places the real fields. The source file must match its pinned SHA-256 or nothing is built. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');
const F = require('./_app_forms.js');

const DOCS = [path.join(__dirname, '..', '..', 'src', 'assets', 'docs'), path.join(process.cwd(), 'src', 'assets', 'docs'), path.join(__dirname, 'src', 'assets', 'docs')];
function source(file) {
  for (const d of DOCS) { const p = path.join(d, file); if (fs.existsSync(p)) return fs.readFileSync(p); }
  const e = new Error('application form file missing: ' + file); e.code = 'form_missing'; throw e;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/* the standard PDF fonts are WinAnsi: anything outside it is replaced, never an exception mid-build */
const clean = (s) => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?').replace(/\s+/g, ' ').trim();

function valueOf(key, a, d) { if (typeof key !== 'string') return ''; if (key.startsWith('=')) return key.slice(1); return clean(a[key] != null && a[key] !== '' ? a[key] : d[key]); }
function fitText(page, font, text, x, yBase, width, size) {
  let s = size || 9; while (s > 5.5 && font.widthOfTextAtSize(text, s) > width) s -= 0.5;
  let t = text; while (t && font.widthOfTextAtSize(t, s) > width) t = t.slice(0, -1);
  if (t) page.drawText(t, { x, y: yBase, size: s, font, color: rgb(0.05, 0.1, 0.35) });
  return t.length === text.length;
}

async function build(key, answers, opts) {
  opts = opts || {};
  const form = F.FORMS[key]; if (!form) { const e = new Error('unknown form'); e.code = 'unknown_form'; throw e; }
  const src = source(form.file);
  if (sha(src) !== form.sha256) { const e = new Error('the application form file changed — its layout must be reviewed before it can be signed'); e.code = 'form_changed'; throw e; }
  const a = Object.assign({}, answers || {}); const d = F.derived(a);
  const doc = await PDFDocument.load(src, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const placed = new Set();
  const H = (p) => pages[p - 1].getHeight();
  const use = (k) => { if (typeof k === 'string' && !k.startsWith('=')) { placed.add(k); for (const base of baseKeys(k)) placed.add(base); } };

  if (form.mode === 'fill') {
    const af = doc.getForm();
    for (const f of af.getFields()) {
      const n = f.getName(), t = f.constructor.name;
      if (t === 'PDFSignature' || (form.drop || []).includes(n)) { try { af.removeField(f); } catch (e) { /* a widget-less field */ } continue; }
      const k = form.fill[n];
      if (t === 'PDFTextField' && k) {
        const v = valueOf(k, a, d); if (!v) continue;
        /* 9 pt when it fits the box, else the PDF's own auto-size (never a clipped value) */
        let size = 0; try { const r = f.acroField.getWidgets()[0].getRectangle(); if (font.widthOfTextAtSize(v, 9) <= r.width - 4 && r.height >= 10) size = 9; } catch (e) {}
        try { f.setFontSize(size); } catch (e) {} f.setText(v); use(k);
      }
    }
    for (const [ak, map] of Object.entries(form.check || {})) {
      const name = map[a[ak]]; if (!name) continue;
      try { af.getCheckBox(name).check(); placed.add(ak); } catch (e) { /* not a checkbox in this revision */ }
    }
    af.updateFieldAppearances(font); af.flatten();
  } else if (form.mode === 'overlay') {
    const lay = F.LAYOUT[form.layout];
    for (const it of lay.text) {
      const v = valueOf(it.key, a, d); if (!v) continue;
      fitText(pages[it.page - 1], font, v, it.x, H(it.page) - it.baseline + 1.5, it.w, 9); use(it.key);
    }
    for (const [ak, map] of Object.entries(form.marks || {})) {
      const m = map[a[ak]]; if (!m) continue;
      pages[m[0] - 1].drawText('X', { x: m[1], y: H(m[0]) - m[2] - 8, size: 10, font: bold, color: rgb(0.05, 0.1, 0.35) }); placed.add(ak);
    }
  }
  for (const [k, p, x, top, w] of form.stamp || []) { const v = valueOf(k, a, d); if (v) { fitText(pages[p - 1], font, v, x, H(p) - top, w, 9.5); use(k); } }

  /* every answer the form had no place for → the details page (addendum forms: all of them) */
  const unplaced = [];
  for (const [sec, list] of F.SECTIONS) for (const [k] of list) { const v = clean(a[k]); if (v && !placed.has(k) && !k.startsWith('req.notes')) unplaced.push([sec, k, k === 'biz.entity' ? (F.ENTITIES[a[k]] || v) : v]); }
  if (unplaced.length) addDetails(doc, font, bold, form, unplaced, a);

  if (opts.preview) markBoxes(doc, font, form);
  doc.setTitle(`${form.name} application — ${clean(a['biz.legal_name']) || 'draft'}`); doc.setProducer('HCPS 360 Dealer Portal'); doc.setCreator('HCPS 360 Dealer Portal');
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  return { bytes, sha256: sha(bytes), pages: doc.getPageCount(), placed: [...placed], unplaced: unplaced.map((u) => u[1]) };
}
function baseKeys(k) {   // a derived value counts as its parts having been placed
  const m = { 'biz.csz': ['biz.city', 'biz.state', 'biz.zip'], 'ship.csz': ['ship.city', 'ship.state', 'ship.zip'], 'biz.full_address': ['biz.address', 'biz.city', 'biz.state', 'biz.zip'],
    'biz.billing_line': ['biz.address', 'biz.city', 'biz.state', 'biz.zip'], 'bank.full_address': ['bank.address', 'bank.city', 'bank.state', 'bank.zip'], 'bank.sz': ['bank.state', 'bank.zip'],
    'biz.entity_label': ['biz.entity'], 'signer.name_title': ['signer.name', 'signer.title'] };
  for (const n of [1, 2, 3]) { m[`ref${n}.full_address`] = [`ref${n}.address`, `ref${n}.city`, `ref${n}.state`, `ref${n}.zip`]; m[`ref${n}.sz`] = [`ref${n}.state`, `ref${n}.zip`]; }
  return m[k] || [];
}
function addDetails(doc, font, bold, form, rows, a) {
  let page = doc.addPage([612, 792]); let y = 740;
  const head = () => {
    page.drawText(clean(`${form.name} — application details`), { x: 48, y, size: 15, font: bold, color: rgb(0.03, 0.17, 0.35) }); y -= 18;
    page.drawText(clean(`Supplied by ${a['biz.legal_name'] || 'the applicant'} through the HCPS 360 Dealer Portal, for the application on the preceding pages.`), { x: 48, y, size: 9, font, color: rgb(0.35, 0.38, 0.42) }); y -= 22;
  };
  head();
  let sec = '';
  for (const [s, k, v] of rows) {
    if (y < 70) { page = doc.addPage([612, 792]); y = 740; head(); sec = ''; }
    if (s !== sec) { sec = s; y -= 4; page.drawText(clean(s.toUpperCase()), { x: 48, y, size: 8.5, font: bold, color: rgb(0.93, 0.39, 0.15) }); y -= 13; }
    const label = (F.FIELDS.get(k) || {}).label || k;
    page.drawText(clean(label), { x: 56, y, size: 9.5, font, color: rgb(0.35, 0.38, 0.42) });
    fitText(page, bold, v, 230, y, 334, 9.5); y -= 14;
  }
  if (form.notice) { y -= 10; page.drawText(clean(form.notice), { x: 48, y, size: 9, font: bold, color: rgb(0.6, 0.1, 0.1) }); }
}
function markBoxes(doc, font, form) {
  const pages = doc.getPages();
  const draw = (b, label, col) => {
    const p = pages[b.page - 1]; const W = p.getWidth(), H = p.getHeight();
    const x = b.positionX / 100 * W, w = b.width / 100 * W, h = b.height / 100 * H, y = H - b.positionY / 100 * H - h;
    p.drawRectangle({ x, y, width: w, height: h, borderColor: col, borderWidth: 1, color: col, opacity: 0.08, borderOpacity: 0.9 });
    p.drawText(label, { x: x + 2, y: y + Math.max(2, h / 2 - 3), size: 7, font, color: col });
  };
  for (const b of form.sign || []) draw(b, 'Sign here', rgb(0.93, 0.39, 0.15));
  for (const b of [...(form.date || []), ...(form.dateTop || [])]) draw(b, 'Date', rgb(0.09, 0.5, 0.76));
  for (const b of form.signerText || []) draw(b, b.label, rgb(0.45, 0.2, 0.6));
}

/* C3-07 Stage 5 follow-up: the manufacturer's own guarantee page (e.g. Dalton page 4), exactly as published — blank, to
   print and sign by hand. Nothing is filled in: a personal guarantee is the guarantor's own signature, never e-signed here. */
async function guaranteePage(key) {
  const form = F.FORMS[key]; if (!form || !form.guarantee) { const e = new Error('no guarantee page'); e.code = 'unknown_form'; throw e; }
  const src = source(form.file); if (sha(src) !== form.sha256) { const e = new Error('form changed'); e.code = 'form_changed'; throw e; }
  const orig = await PDFDocument.load(src, { ignoreEncryption: true }); const out = await PDFDocument.create();
  const [pg] = await out.copyPages(orig, [form.guarantee.page - 1]); out.addPage(pg);
  return Buffer.from(await out.save());
}
module.exports = { build, clean, sha, guaranteePage };

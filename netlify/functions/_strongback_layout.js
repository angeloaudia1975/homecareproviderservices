// MI-1c — layout extraction for Strongback's monthly dealer-intelligence PDF.
// Turns the stored PDF bytes into pages → lines → words WITH their positions (page, x, y, font size), so the parser
// (_strongback_report.js) can rejoin wrapped names and read table columns by position, and every stored value can
// point back to where it was printed (SOURCE-POSITION identity).
//
// Server-side on purpose: the server parses the exact bytes whose SHA-256 is registered in mfr_sources (MI-1b), so a
// parse result can never come from a different file than the one on record.
//
// Glyphs. Strongback's PDF is printed by Chromium (Skia), which embeds Inter as Type 3 fonts. Inter's contextual
// variants (punctuation next to digits or capitals) have no standard character, so Skia's ToUnicode maps them to
// private-use code points. Exactly six occur in the September 2026 report and were confirmed against a second,
// independent extractor (Poppler pdftotext 24.02) at every occurrence:
//   U+E081 "("  U+E082 ")"  U+E088 "-"  U+E092 ":"  U+E09D "+"  U+E09F "x" (as in "16x16")
// Any OTHER private-use character fails the extraction loudly (unknown_glyph) — a character is never guessed.
const PUA = { 0xE081: "(", 0xE082: ")", 0xE088: "-", 0xE092: ":", 0xE09D: "+", 0xE09F: "x" };

function mapGlyphs(s, where) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0xE000 && c <= 0xF8FF) {
      if (!(c in PUA)) { const e = new Error(`unknown_glyph: U+${c.toString(16).toUpperCase()} at ${where} — the report uses a character this parser has not been shown; nothing was read`); e.code = "unknown_glyph"; throw e; }
      out += PUA[c];
    } else out += ch;
  }
  return out;
}

let _pdfjs = null;
function pdfjs() {
  if (!_pdfjs) {
    // pdf.js warns that canvas is missing; rendering is never used (text only), so the warning is silenced.
    const warn = console.warn, log = console.log;
    console.warn = () => {}; console.log = () => {};
    try { _pdfjs = require("pdfjs-dist/legacy/build/pdf.js"); } finally { console.warn = warn; console.log = log; }
    _pdfjs.GlobalWorkerOptions && (_pdfjs.GlobalWorkerOptions.workerSrc = undefined);
  }
  return _pdfjs;
}

// Items → words: a word ends at a space item or a horizontal gap; a wide space item is also a column gap.
// Words → lines: same baseline (±1.5 pt). Lines are ordered top to bottom (PDF y grows upward).
function wordsOf(items, pageNo) {
  // Rows first (items whose baselines are within 1.5 pt), then left to right inside each row — items a fraction of a
  // point apart must never be ordered by y, or a word at the left edge is glued onto one further right.
  const rows = [];
  for (const it of items.slice().sort((a, b) => b.y - a.y)) {
    const R = rows.find(r => Math.abs(r.y - it.y) <= 1.5);
    if (R) R.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  const words = [];
  for (const R of rows) {
    let w = null;
    const flush = () => { if (w && w.text.trim() !== "") words.push(w); w = null; };
    for (const it of R.items.sort((a, b) => a.x - b.x)) {
      if (it.str === "") continue;
      if (/^\s+$/.test(it.str)) { flush(); continue; }
      if (w && (it.x - w.x2 > 1.5 || it.x < w.x)) flush();
      if (!w) w = { text: "", x: it.x, x2: it.x, y: it.y, size: it.size, page: pageNo };
      w.text += mapGlyphs(it.str, `page ${pageNo}`); w.x2 = it.x + it.w; w.size = Math.max(w.size, it.size);
    }
    flush();
  }
  return words;
}

function linesOf(words) {
  const lines = [];
  for (const w of words.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x))) {
    let L = lines.find(l => Math.abs(l.y - w.y) <= 1.5);
    if (!L) { L = { y: w.y, words: [] }; lines.push(L); }
    L.words.push(w);
  }
  lines.sort((a, b) => b.y - a.y);
  for (const L of lines) {
    L.words.sort((a, b) => a.x - b.x);
    L.x = L.words[0].x;
    L.size = Math.max(...L.words.map(w => w.size));
    L.text = L.words.map(w => w.text).join(" ");
  }
  return lines;
}

const r1 = n => Math.round(n * 10) / 10;

// bytes (Buffer/Uint8Array) → { meta, pages:[{page, width, height, lines:[{y, x, size, text, words:[{text,x,x2,y,size}]}]}] }
async function extractLayout(bytes) {
  const lib = pdfjs();
  const warn = console.warn, log = console.log; console.warn = () => {}; console.log = () => {};
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false,
      useSystemFonts: false, verbosity: 0, stopAtErrors: true }).promise;
  } catch (e) { console.warn = warn; console.log = log; const x = new Error("unreadable_pdf: " + e.message); x.code = "unreadable_pdf"; throw x; }
  try {
    const info = (await doc.getMetadata()).info || {};
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n); const vp = p.getViewport({ scale: 1 });
      const tc = await p.getTextContent({ disableNormalization: true });
      const items = tc.items.filter(i => typeof i.str === "string").map(i => ({
        str: i.str, x: r1(i.transform[4]), y: r1(i.transform[5]), w: r1(i.width), size: r1(Math.abs(i.transform[3])) }));
      const lines = linesOf(wordsOf(items, n)).map(L => ({ y: L.y, x: L.x, size: L.size, text: L.text,
        words: L.words.map(w => ({ text: w.text, x: w.x, x2: r1(w.x2), y: w.y, size: w.size })) }));
      pages.push({ page: n, width: r1(vp.width), height: r1(vp.height), lines });
    }
    return { meta: { pages: doc.numPages, title: info.Title || null, creator: info.Creator || null,
      producer: info.Producer || null, created: info.CreationDate || null }, pages };
  } finally { console.warn = warn; console.log = log; try { await doc.destroy(); } catch (x) {} }
}

module.exports = { extractLayout, mapGlyphs, PUA, _internal: { wordsOf, linesOf } };

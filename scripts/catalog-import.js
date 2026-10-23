#!/usr/bin/env node
/* Catalog import — offline runner (read-only). One manufacturer source file → normalized line, validation,
   comparison with HCPS's existing rows, review report and the Manufacturer Center import rows.

   node scripts/catalog-import.js --mfr <slug> --file <source> [--transcription t.json] [--ocr ocr.txt]
        [--shop <ordering repo>] [--catalog-slug <file slug, e.g. gce>] [--snapshot snap.json] --out <dir>

   Writes ONLY into --out: line.json, report.json, review.csv, price_import_rows.json. Never writes to a database,
   a repo or a live site. The outputs carry wholesale prices: keep them out of git (both repos are public). */
const fs = require("fs");
const path = require("path");
const CI = require("../netlify/functions/_catalog_import.js");
const { ADAPTERS } = require("../netlify/functions/_import_adapters.js");

function args(argv) { const a = {}; for (let i = 2; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; return a; }
const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

/* OCR cross-check for a transcription: every part number and every price must appear in the OCR text. */
function ocrValues(transcription) {
  const out = [];
  for (const t of transcription.rows) {
    out.push({ code: t.code, value: t.code });
    for (const v of [].concat(t.price != null ? [t.price] : [], t.widths ? Object.values(t.widths).filter(v => v !== "X") : [],
      (t.options || []).map(o => o.price_add).filter(v => v !== "X"))) out.push({ code: t.code, value: v });
  }
  return out;
}
function ocrCheck(transcription, ocrText) {
  const norm = s => String(s).replace(/[\s,$+]/g, "").toUpperCase();
  const hay = norm(ocrText);
  const missing = [];
  for (const t of transcription.rows) {
    const vals = [t.code].concat(t.price != null ? [t.price] : []).concat(t.widths ? Object.values(t.widths).filter(v => v !== "X") : [])
      .concat((t.options || []).map(o => o.price_add).filter(v => v !== "X"));
    for (const v of vals) if (!hay.includes(norm(v))) missing.push({ code: t.code, value: v });
  }
  return missing;
}

async function main() {
  const a = args(process.argv);
  const A = ADAPTERS[a.mfr];
  if (!A || !a.file || !a.out) { console.error("usage: --mfr <" + Object.keys(ADAPTERS).join("|") + "> --file <source> --out <dir>"); process.exit(2); }
  const buf = fs.readFileSync(a.file);
  const fileName = path.basename(a.file).replace(/^[0-9a-f]{8}-/, "");
  let line, ocrMissing = null, ocrTotal = 0, transcriptionMeta = null;
  if (A.kind === "transcription") {
    if (!a.transcription) throw new Error(a.mfr + " is an image-only source: pass --transcription (and --ocr to cross-check)");
    const t = JSON.parse(fs.readFileSync(a.transcription, "utf8"));
    transcriptionMeta = t;
    line = A.fn(t, buf, fileName);
    if (a.ocr) { ocrMissing = ocrCheck(t, a.ocr.split(",").map(f => fs.readFileSync(f, "utf8")).join("\n")); ocrTotal = ocrValues(t).length; }
  } else line = await A.fn(buf, fileName);
  const pre = line.exceptions_pre || []; delete line.exceptions_pre;
  const V = CI.validateLine(line);
  V.exceptions = pre.concat(V.exceptions);
  if (ocrMissing) {
    const total = ocrTotal;
    V.exceptions.push(CI.flag("info", "ocr_cross_check", `${total - ocrMissing.length} of ${total} transcribed values found verbatim in an independent OCR reading`));
    // A value OCR could not read stays a warning unless a recorded second reading of the page images covered it.
    const second = transcriptionMeta && transcriptionMeta.second_reading;
    V.exceptions.push(...ocrMissing.map(m => CI.flag(second ? "info" : "warn", "ocr_unconfirmed", `transcribed value ${m.value} (${m.code}) not found in the OCR text` +
      (second ? ` — confirmed by a second reading (${second.method}, ${second.date})` : " — confirm against the page image"))));
  }
  if (line.checks && line.checks.section_mismatches && line.checks.section_mismatches.length)
    V.exceptions.push(...line.checks.section_mismatches.map(s => CI.flag("blocker", "section_count_mismatch", `section "${s.section}" states ${s.stated} items, ${s.read} read`)));
  let existing = { catalog: [], master: [] };
  if (a.shop) {
    const f = path.join(a.shop, "public", "data", (a["catalog-slug"] || a.mfr) + ".json");
    existing.catalog = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
  }
  if (a.snapshot) existing.master = (JSON.parse(fs.readFileSync(a.snapshot, "utf8")).skus || []).filter(s => s.manufacturer === a.mfr || s.manufacturer === a["catalog-slug"]);
  const C = CI.compareLine(V, existing);
  const R = CI.report(V, C);
  R.checks = line.checks || null;
  fs.mkdirSync(a.out, { recursive: true });
  fs.writeFileSync(path.join(a.out, "line.json"), JSON.stringify(V, null, 2));
  fs.writeFileSync(path.join(a.out, "report.json"), JSON.stringify(Object.assign({}, R, { comparison: C }), null, 2));
  fs.writeFileSync(path.join(a.out, "price_import_rows.json"), JSON.stringify(CI.priceImportRows(V), null, 2));
  const cmp = new Map(C.rows.map(r => [CI.normCode(r.code), r]));
  const head = ["code", "name", "section", "dealer_price", "tiers", "msrp", "msrp_source", "map", "map_source", "uom", "case_qty", "options", "match", "changes", "flags", "locator"];
  const lines = [head.join(",")].concat(V.rows.map(r => {
    const c = cmp.get(CI.normCode(r.code)) || {};
    return [r.code, r.name, r.section || r.category_hint || "", r.dealer_price, (r.tiers || []).map(t => `${t.min_qty}+:${t.price}${t.pool ? "(" + t.pool + ")" : ""}`).join(" "),
      r.msrp, r.msrp_source, r.map, r.map_source, r.uom, r.case_qty, (r.options || []).map(o => `${o.label} +${o.price_add}`).join("; "),
      r.duplicate_of ? "duplicate" : c.status || "", (c.changes || []).map(x => x.field + (x.from != null ? `:${x.from}->${x.to}` : "")).join("; "),
      (r.flags || []).map(f => f.code).join("; "), r.locator].map(csvCell).join(",");
  }));
  fs.writeFileSync(path.join(a.out, "review.csv"), lines.join("\n"));
  const s = R.counts;
  console.log(`${a.mfr}: ${V.rows.length} rows (${s.distinct} distinct) · priced ${s.priced} · new ${s.new} · changed ${s.changed} · unchanged ${s.unchanged} · catalog-not-in-source ${s.catalog_not_in_source} · blockers ${s.blockers} · warnings ${s.warnings}`);
}
main().catch(e => { console.error("import failed: " + (e.stack || e.message)); process.exit(1); });

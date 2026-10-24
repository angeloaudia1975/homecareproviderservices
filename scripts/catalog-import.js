#!/usr/bin/env node
/* Catalog import — offline runner (read-only). One manufacturer source file → normalized line, validation,
   comparison with HCPS's existing rows, review report and the Manufacturer Center import rows.

   node scripts/catalog-import.js --mfr <slug> --file <source> [--received-evidence e.json | --received YYYY-MM-DD] [--transcription t.json] [--ocr ocr.txt]
        [--shop <ordering repo>] [--catalog-slug <file slug>] [--snapshot snap.json] [--decisions d.json] [--holds h.json]
        [--today YYYY-MM-DD] --out <dir>
   node scripts/catalog-import.js --batch batch.json [same shared options] --out <dir>
        batch.json = [{ name?, mfr, file, received? (evidence object or bare date), received_evidence? (file), transcription?, ocr?, catalog_slug? }, …]

   Per line (in --out, or --out/<name> in a batch): line.json, report.json, review.csv, before_after.json,
   before_after.csv, exceptions.json, package.json — and price_import_rows.json + handoff.json ONLY when the line is
   stageable (any blocking exception = no import rows at all). A batch also writes the run's one exceptions queue
   (exceptions.json + exceptions.csv) and run.json; one manufacturer failing or blocked never stops the others.
   Outputs are deterministic (no clock): the same inputs give byte-identical files. Never writes to a database, a
   repo or a live site. The outputs carry wholesale prices: keep them out of git (both repos are public). */
const fs = require("fs");
const path = require("path");
const CI = require("../netlify/functions/_catalog_import.js");
const { ADAPTERS, adapterFor } = require("../netlify/functions/_import_adapters.js");

/* The received date and its basis: --received-evidence e.json (or a batch "received" object / "received_evidence" file)
   = { date, basis: mailbox_attachment_match | hcps_intake_verified, attachment_sha256, attachment_name, message_id,
   verified_by, note }. A bare --received date is recorded without a basis and keeps the line from staging. */
function receiptOf(job) {
  if (job.received_evidence) return readJson(job.received_evidence);
  return job.received || null;
}
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

const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));
const EX_HEAD = ["id", "manufacturer", "sku", "kind", "status", "blocking", "evidence", "source_ref", "required_decision"];
const exCsv = list => [EX_HEAD.join(",")].concat(list.map(x => EX_HEAD.map(k => csvCell(x[k])).join(","))).join("\n") + "\n";
const write = (dir, name, data) => fs.writeFileSync(path.join(dir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");

/* One line → its review package in dir. Returns { name, manufacturer, stageable, counts, exceptions }. */
async function runOne(job, shared) {
  const slug = CI.canonicalSlug(job.mfr);
  const dir = job.out; fs.mkdirSync(dir, { recursive: true });
  for (const f of ["price_import_rows.json", "handoff.json"]) { const p = path.join(dir, f); if (fs.existsSync(p)) fs.unlinkSync(p); }   // never leave stale rows behind
  const buf = fs.readFileSync(job.file);
  const fileName = path.basename(job.file).replace(/^[0-9a-f]{8}-/, "");
  const refusal = CI.lineRefusal(slug, shared.frozen);
  let line;
  if (refusal) {
    // A frozen or retired line is refused before any adapter runs: nothing is parsed into rows.
    line = { manufacturer: slug, source: { file: fileName, sha256: CI.sha256(buf), title: null, effective_date: null, effective_date_status: "not_stated", received_date: null }, terms: [], rows: [] };
    CI.applyReceipt(line, receiptOf(job));
  } else {
    const A = adapterFor(slug);
    if (!A) throw new Error("no adapter for " + job.mfr);
    let ocrMissing = null, ocrTotal = 0, transcriptionMeta = null;
    if (A.kind === "transcription") {
      if (!job.transcription) throw new Error(slug + " is an image-only source: pass --transcription (and --ocr to cross-check)");
      const t = readJson(job.transcription); transcriptionMeta = t;
      line = A.fn(t, buf, fileName);
      if (job.ocr) { ocrMissing = ocrCheck(t, String(job.ocr).split(",").map(f => fs.readFileSync(f, "utf8")).join("\n")); ocrTotal = ocrValues(t).length; }
    } else line = await A.fn(buf, fileName);
    CI.applyReceipt(line, receiptOf(job));
    const pre = line.exceptions_pre || []; delete line.exceptions_pre;
    const checks = line.checks || null;
    const V = CI.validateLine(line);
    V.exceptions = pre.concat(V.exceptions);
    if (ocrMissing) {
      V.exceptions.push(CI.flag("info", "ocr_cross_check", `${ocrTotal - ocrMissing.length} of ${ocrTotal} transcribed values found verbatim in an independent OCR reading`));
      const second = transcriptionMeta && transcriptionMeta.second_reading;
      V.exceptions.push(...ocrMissing.map(m => CI.flag(second ? "info" : "warn", "ocr_unconfirmed", `transcribed value ${m.value} (${m.code}) not found in the OCR text` +
        (second ? ` — confirmed by a second reading (${second.method}, ${second.date})` : " — confirm against the page image"))));
    }
    if (checks && checks.section_mismatches && checks.section_mismatches.length)
      V.exceptions.push(...checks.section_mismatches.map(x => CI.flag("blocker", "section_count_mismatch", `section "${x.section}" states ${x.stated} items, ${x.read} read`)));
    line = V; line.checks = checks;
  }
  const existing = { catalog: [], master: [] };
  if (shared.shop) {
    const f = path.join(shared.shop, "public", "data", (job.catalog_slug || CI.catalogFileSlug(slug)) + ".json");
    existing.catalog = fs.existsSync(f) ? readJson(f) : [];
  }
  if (shared.snapshot) { const al = CI.slugAliases(slug); existing.master = (readJson(shared.snapshot).skus || []).filter(x => al.includes(x.manufacturer)); }
  const C = CI.compareLine(line, existing);
  const R = CI.report(line, C);
  R.checks = line.checks || null;
  const P = CI.buildPackage(line, C, { catalog: existing.catalog, master: existing.master, frozen: shared.frozen, decisions: shared.decisions,
    holds: shared.holds, today: shared.today, confirmations: (shared.confirmations || {})[slug] });
  R.stage_ready = P.stageable; R.package = { stageable: P.stageable, counts: P.counts, before_after_sha256: P.before_after_sha256 };
  write(dir, "line.json", line);
  write(dir, "report.json", Object.assign({}, R, { comparison: C }));
  write(dir, "before_after.json", CI.beforeAfterJson(P.before_after));
  write(dir, "before_after.csv", CI.beforeAfterCsv(P.before_after));
  write(dir, "exceptions.json", P.exceptions);
  write(dir, "package.json", Object.assign({}, P, { before_after: undefined, handoff: undefined, handoff_file: P.stageable ? "handoff.json" : null }));
  if (P.stageable) { write(dir, "price_import_rows.json", P.handoff.mc_import_source_rows.rows); write(dir, "handoff.json", P.handoff); }
  const cmp = new Map(C.rows.map(r => [CI.normCode(r.code), r]));
  const head = ["code", "name", "section", "dealer_price", "tiers", "msrp", "msrp_source", "map", "map_source", "uom", "case_qty", "options", "match", "changes", "flags", "locator"];
  write(dir, "review.csv", [head.join(",")].concat(line.rows.map(r => {
    const c = cmp.get(CI.normCode(r.code)) || {};
    return [r.code, r.name, r.section || r.category_hint || "", r.dealer_price, (r.tiers || []).map(t => `${t.min_qty}+:${t.price}${t.pool ? "(" + t.pool + ")" : ""}`).join(" "),
      r.msrp, r.msrp_source, r.map, r.map_source, r.uom, r.case_qty, (r.options || []).map(o => `${o.label} +${o.price_add}`).join("; "),
      r.duplicate_of ? "duplicate" : c.status || "", (c.changes || []).map(x => x.field + (x.from != null ? `:${x.from}->${x.to}` : "")).join("; "),
      (r.flags || []).map(f => f.code).join("; "), r.locator].map(csvCell).join(",");
  })).join("\n") + "\n");
  const s = R.counts;
  return { name: job.name || slug, manufacturer: slug, file: fileName, rows: line.rows.length, distinct: s.distinct, new: s.new, changed: P.before_after.summary.changed,
    unchanged: P.before_after.summary.unchanged, not_on_source_preserved: P.before_after.summary.not_on_source_preserved,
    blocking: P.counts.blocking, exceptions: P.counts.total, stageable: P.stageable, exceptions_list: P.exceptions };
}

async function main() {
  const a = args(process.argv);
  if (!a.out || (!a.batch && (!a.mfr || !a.file))) { console.error("usage: --mfr <" + Object.keys(ADAPTERS).join("|") + "> --file <source> --out <dir>  |  --batch batch.json --out <dir>"); process.exit(2); }
  const shared = { shop: a.shop, snapshot: a.snapshot, today: a.today || null, decisions: a.decisions ? readJson(a.decisions) : {}, holds: a.holds ? readJson(a.holds) : [],
    confirmations: a.confirmations ? readJson(a.confirmations) : {}, frozen: [] };
  if (a.snapshot) shared.frozen = (readJson(a.snapshot).meta || []).filter(m => m.frozen === true).map(m => m.slug);
  if (!a.batch) {
    const r = await runOne({ mfr: a.mfr, file: a.file, received: a.received, received_evidence: a["received-evidence"], transcription: a.transcription, ocr: a.ocr, catalog_slug: a["catalog-slug"], out: a.out }, shared);
    console.log(`${r.name}: ${r.rows} rows · new ${r.new} · changed ${r.changed} · unchanged ${r.unchanged} · preserved-not-on-source ${r.not_on_source_preserved} · blocking ${r.blocking} · exceptions ${r.exceptions} · stageable ${r.stageable ? "yes" : "no"}`);
    return;
  }
  const jobs = readJson(a.batch), results = [], queue = [];
  fs.mkdirSync(a.out, { recursive: true });
  for (const j of jobs) {
    const name = j.name || CI.canonicalSlug(j.mfr);
    try {
      const r = await runOne(Object.assign({}, j, { name, out: path.join(a.out, name) }), shared);
      queue.push(...r.exceptions_list); delete r.exceptions_list; results.push(r);
    } catch (e) {
      // One line failing never stops the others: it becomes a blocking exception of its own.
      const x = { id: "import_failed:" + CI.canonicalSlug(j.mfr) + ":-:" + CI.sha256(String(e.message)).slice(0, 8), manufacturer: CI.canonicalSlug(j.mfr), sku: null, kind: "import_failed",
        evidence: String(e.message).slice(0, 300), source_ref: path.basename(String(j.file || "")), required_decision: "Fix the source or the adapter and re-run.", status: "open", blocking: true };
      queue.push(x); results.push({ name, manufacturer: x.manufacturer, error: x.evidence, stageable: false, blocking: 1, exceptions: 1 });
    }
  }
  write(a.out, "exceptions.json", queue);
  write(a.out, "exceptions.csv", exCsv(queue));
  write(a.out, "run.json", { lines: results });
  for (const r of results) console.log(r.error ? `${r.name}: FAILED — ${r.error}` :
    `${r.name}: ${r.rows} rows · new ${r.new} · changed ${r.changed} · unchanged ${r.unchanged} · preserved ${r.not_on_source_preserved} · blocking ${r.blocking} · exceptions ${r.exceptions} · stageable ${r.stageable ? "yes" : "no"}`);
}
if (require.main === module) main().catch(e => { console.error("import failed: " + (e.stack || e.message)); process.exit(1); });
module.exports = { runOne };

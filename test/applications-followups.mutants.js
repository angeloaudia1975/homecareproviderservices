/* Mutation check for the C3-07 Stage 5 follow-ups (paper-signed upload, guarantee page, usage, retention / purge):
   test/applications.test.js must fail on every mutant. */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (n) => path.join(__dirname, '..', 'netlify', 'functions', n);
const S = F('_app_store.js'), A = F('applications-admin-api.js'), D = F('dealer-applications-api.js');
const M = [
  { f: S, from: "if (bytes.slice(0, 5).toString('latin1') !== '%PDF-') return { error: 'That file is not a PDF.' };", to: '', why: 'non-PDF stored' },
  { f: S, from: "'x-upsert': 'false'", to: "'x-upsert': 'true'", why: 'stored document overwritten' },
  { f: A, from: "|| String(app.retention_until) > S.chicagoToday())", to: ')', why: 'purged before the retention date' },
  { f: A, from: "if (b.confirm !== 'DELETE') return json(400, { ok: false, error: 'Type DELETE to confirm.' });", to: '', why: 'purge without confirmation' },
  { f: A, from: "if (files.length) await S.removeFiles(files);", to: '', why: 'files left after purge' },
  { f: A, from: "if (me.role !== 'president')", to: "if (!me.role)", why: 'not President only' },
  { f: A, from: "      return json(200, { ok: true, today, due: (rows || []).filter((r) => r.answers_enc || r.signed_path)", to: "      return json(200, { ok: true, today, due: (rows || [])", why: 'purged records listed again' },
  { f: D, from: "if (kind === 'signed' && missing(answersOf(app)).length)", to: 'if (false)', why: 'incomplete questionnaire accepted on paper' },
  { f: D, from: "if (kind === 'signed' && !OPEN.has(app.status))", to: 'if (false)', why: 'paper copy replaces a signed one' },
  { f: D, from: "if (!(form && form.guarantee)) return json(400, { ok: false, error: 'This application has no guarantee page.' });", to: "if (!form) return json(400, {});", why: 'guarantee page for a form without one' },
  { f: D, from: "if ((prior || []).length >= 5)", to: 'if (false)', why: 'unlimited guarantee uploads' },
  { f: A, from: "row = await S.update(row, { signed_path: null, certificate_path: null, audit_path: null }, by);", to: '', why: 'file marker left after purge' },
];
const run = () => spawnSync(process.execPath, [path.join(__dirname, 'applications.test.js')], { encoding: 'utf8' });
if (run().status !== 0) { console.log('CONTROL FAILED'); process.exit(1); }
let k = 0; const s = [];
for (const m of M) { const o = fs.readFileSync(m.f, 'utf8'); if (!o.includes(m.from)) { s.push(m.why + ' (missing)'); continue; }
  fs.writeFileSync(m.f, o.replace(m.from, m.to)); try { if (run().status !== 0) k++; else s.push(m.why); } finally { fs.writeFileSync(m.f, o); } }
console.log(`application follow-up mutants: ${k}/${M.length} killed${s.length ? ' — survivors: ' + s.join('; ') : ''}`); process.exit(s.length ? 1 : 0);

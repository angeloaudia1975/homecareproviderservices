/* Phase D — PROFILE TRIAL (read-only). Before a draft report profile is switched to automatic registration, run it
   over the real mailbox history and show exactly what it WOULD do with every file — without doing any of it.

   It uses the capture's own code (_report_capture.js inspect / decide / periodOf) with the manufacturer's profiles treated
   as active, so the trial and the live capture can never disagree about a file. Every Graph call is a GET (the shared
   client); nothing is stored, registered, recorded, marked read, moved or sent. Files are read in memory only.

   o: { slug, profiles:[that manufacturer's active + draft profiles], mailbox, from:'YYYY-MM-DD', to:'YYYY-MM-DD',
        cursor?:number, budget_ms?, known:{sha256 → {id, kind}} (already registered), seen?:[sha…] (from earlier pages) }
   → { done, cursor, files:[…], messages_total, by_month, summary } */
const crypto = require("crypto");
const RC = require("./_report_capture.js")._internal;
const INV = require("./_report_inventory.js").shared;

const domainsOf = profiles => [...new Set(profiles.flatMap(p => ((p.rules || {}).senders || {}).domains || []).map(d => String(d).toLowerCase()))];
const ym = s => String(s || "").slice(0, 7);

async function trial(o, deps) {
  const now = deps.now || Date.now;
  const budget = Math.min(Math.max(+o.budget_ms || 20000, 3000), 22000);
  const deadline = now() + budget, soft = deadline - Math.min(5000, Math.floor(budget / 3));
  const g = INV.graphClient(deps, deadline);
  const mb = encodeURIComponent(String(o.mailbox || "").toLowerCase());
  // The trial treats the manufacturer's profiles as ACTIVE + auto-registering — exactly the state activation would create.
  const profiles = (o.profiles || []).filter(p => p.manufacturer === o.slug && p.status !== "retired").map(p => Object.assign({}, p, { status: "active", auto_register: true }));
  if (!profiles.length) return { done: true, error: "no_profiles", files: [] };
  const domains = domainsOf(profiles);
  const from = o.from, to = o.to;

  // 1. The manufacturer's mail: one Outlook search per sender domain, then the window, oldest first.
  const byId = new Map();
  for (const d of domains) {
    let path = `/users/${mb}/messages?$search=${encodeURIComponent('"from:' + d + '"')}&$select=id,internetMessageId,subject,from,receivedDateTime,hasAttachments,isDraft&$top=100`;
    while (path) {
      const j = await g.get(path);
      for (const m of j.value || []) {
        const addr = String(((m.from || {}).emailAddress || {}).address || "").toLowerCase();
        if (m.isDraft || !addr.endsWith("@" + d)) continue;
        const day = String(m.receivedDateTime || "").slice(0, 10);
        if (day < from || day >= to) continue;
        byId.set(m.internetMessageId || m.id, m);
      }
      path = j["@odata.nextLink"] || null;
    }
  }
  const msgs = [...byId.values()].sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)));
  const files = [], seen = new Set(o.seen || []);
  let i = Math.max(0, parseInt(o.cursor, 10) || 0), stopped = false;
  const bodyProfiles = profiles.filter(p => p.rules && p.rules.body_only);
  const verdictFor = (att, msg) => {
    const d = RC.decide(att, msg, att.format === "eml" ? bodyProfiles : profiles, { slug: o.slug });
    const known = o.known && o.known[att.sha256];
    let outcome = d.outcome === "register" ? "would_register" : d.outcome;
    if (outcome === "would_register" && known) outcome = known.kind === d.profile.kind ? "would_link" : "exception";
    if (outcome === "would_register" && seen.has(att.sha256)) outcome = "copy_of_earlier_file";
    if (outcome === "would_register") seen.add(att.sha256);
    return { outcome, attention: d.attention || (known && known.kind !== (d.profile || {}).kind ? "duplicate_conflict" : null), detail: d.detail || null,
      profile: d.profile ? d.profile.code : null, kind: d.profile ? d.profile.kind : null,
      period: d.period ? { start: d.period.start, end: d.period.end, basis: d.period.basis, cumulative: !!d.period.cumulative, combined: !!d.period.combined } : null,
      known_record: known ? known.id : null };
  };
  for (; i < msgs.length; i++) {
    if (now() > soft) { stopped = true; break; }
    const m = msgs[i];
    const msg = { received_at: m.receivedDateTime, from_address: String(((m.from || {}).emailAddress || {}).address || "").toLowerCase(), subject: m.subject || "" };
    const base = { received_at: m.receivedDateTime, from: msg.from_address, subject: msg.subject };
    try {
      let reportFiles = 0;
      if (m.hasAttachments) {
        const j = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`);
        for (const a of j.value || []) {
          if (/^image\//i.test(a.contentType || "") || a.isInline) continue;
          const type = String(a["@odata.type"] || "");
          if (!/fileAttachment/i.test(type)) { files.push(Object.assign({}, base, { file: a.name || "", outcome: "classified", detail: "attached email / cloud link — not read in a trial" })); continue; }
          if ((a.size || 0) > RC.MAX_BYTES) { files.push(Object.assign({}, base, { file: a.name, bytes: a.size, outcome: "exception", attention: "too_large" })); continue; }
          const buf = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}/$value`, { raw: true });
          const att = await RC.inspect(buf, a.name || "", deps);
          if (INV.classifyName(a.name || "") || /\.(pdf|csv|xlsx?)$/i.test(a.name || "")) reportFiles++;
          files.push(Object.assign({}, base, { file: a.name, bytes: buf.length, sha256: att.sha256, format: att.format, suggested: att.suggested || null,
            sheets: (att.sheets || []).map(s => s.name).slice(0, 6), date_range: att.date_range || null }, verdictFor(att, msg)));
        }
      }
      // A body-only report (Climbing Steps): the email itself, only when no report file came with it.
      if (!reportFiles && bodyProfiles.length && /commi?ss?ion/i.test(msg.subject)) {
        const body = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.id)}?$select=body`, { prefer: ['outlook.body-content-type="text"'] });
        const t = String((body.body && body.body.content) || "");
        const amounts = (t.match(/\$\s?\d[\d,]*(\.\d\d)?/g) || []).length, comm = (t.match(/commi?ss?ion/gi) || []).length;
        if (amounts >= 1) {
          const src = await g.get(`/users/${mb}/messages/${encodeURIComponent(m.id)}/$value`, { raw: true });
          const att = { name: (msg.subject || "report").slice(0, 120) + ".eml", format: "eml", sha256: crypto.createHash("sha256").update(src).digest("hex"), bytes: src.length, suggested: "commission_statement" };
          files.push(Object.assign({}, base, { file: "(email body)", bytes: src.length, sha256: att.sha256, format: "eml", body: { amounts, commission_terms: comm } }, verdictFor(att, msg)));
        } else files.push(Object.assign({}, base, { file: "(email body)", outcome: "classified", detail: "the email body holds no amounts" }));
      }
    } catch (e) {
      if (e.code === "budget") { stopped = true; break; }
      files.push(Object.assign({}, base, { outcome: "exception", attention: "read_failed", detail: String(e.message || e).slice(0, 200) }));
    }
  }
  return { done: !stopped && i >= msgs.length, cursor: i, messages_total: msgs.length, files, seen: [...seen], graph_calls: g.calls() };
}

// Summary across all pages: what activation would register, month by month, and what it would leave for a person.
function summarize(files, expected) {
  const reg = files.filter(f => f.outcome === "would_register");
  const by_month = {};
  for (const f of reg) for (let m = ym(f.period.start); m <= ym(f.period.end); m = next(m)) (by_month[m] = by_month[m] || []).push(f.file);
  const counts = {}; for (const f of files) counts[f.outcome] = (counts[f.outcome] || 0) + 1;
  const attention = {}; for (const f of files.filter(x => x.outcome === "exception")) attention[f.attention || "other"] = (attention[f.attention || "other"] || 0) + 1;
  return { counts, attention, by_month, cumulative: reg.filter(f => f.period.cumulative).length, combined: reg.filter(f => f.period.combined).length,
    periods_from_received_date: reg.filter(f => f.period.basis === "received_date_rule").length, expected: expected || null };
}
function next(m) { let [y, mo] = m.split("-").map(Number); mo++; if (mo > 12) { mo = 1; y++; } return `${y}-${String(mo).padStart(2, "0")}`; }

module.exports = { trial, summarize, domainsOf };

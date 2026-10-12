/* Phase D — the Manufacturer Intelligence dashboard (read-only). Pure: no database, no network.

   One page answers, per manufacturer and month: did the report arrive, is it registered, is its data in HCPS, and what
   is waiting for a person. The MONTHLY RECONCILIATION covers the previous month and is ready on the 15th (Chicago);
   a report that arrives after the 15th is shown as LATE and keeps processing — it is never turned away.

   A report is MISSING only when its profile expects it (rules.expected.cadence = "monthly") and its due date has passed;
   on-request and irregular reports are never "missing". Draft profiles are shown as not yet automatic.

   in: { today:'YYYY-MM-DD' (Chicago), months:n, profiles, sources (mfr_sources report rows), items (capture items),
         coverage:{slug:{YYYY-MM:{status,…}}}, manufacturers:[{slug,name}], shipto:{held, needs_review} }
   out: { reconciliation, grid, pending, months } */
const KINDS = ["commission_statement", "sales_export", "dealer_report"];
const pad = n => String(n).padStart(2, "0");
const addM = (ym, k) => { let [y, m] = ym.split("-").map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${pad(m)}`; };
const ym = d => String(d || "").slice(0, 7);
const covers = (s, e, m) => !!s && ym(s) <= m && ym(e || s) >= m;

// When a monthly report for month M is due: the profile's last expected arrival day in the month after M (default 15th).
// Every profile reports the PREVIOUS month — Ohio's "Commissions through August" arrives Sep 21–29 (profile trial,
// 2026-10-12), Strongback's SR032 for September on Oct 2–7, Bemis's 705-2026-08 on Sep 17.
function dueDate(profile, m) {
  const ex = (profile.rules || {}).expected || {};
  const days = Array.isArray(ex.days) ? ex.days : null;
  const last = days ? Math.max(...days) : 15;
  return `${addM(m, 1)}-${pad(Math.min(last, 28))}`;
}

function build(input) {
  const today = input.today, nowM = ym(today);
  const N = Math.min(Math.max(+input.months || 6, 2), 13);
  const months = Array.from({ length: N }, (_, i) => addM(nowM, i - N + 1));
  // The reconciliation month: the previous month; it becomes READY on the 15th of the current month.
  const recM = addM(nowM, -1), readyOn = `${nowM}-15`, ready = today >= readyOn;
  const profiles = (input.profiles || []).filter(p => p.status !== "retired");
  const sources = (input.sources || []).filter(s => KINDS.includes(s.kind) && !["rejected", "superseded"].includes(s.status));
  const items = input.items || [];
  const nameOf = s => ((input.manufacturers || []).find(m => m.slug === s) || {}).name || s;
  const slugs = [...new Set(profiles.map(p => p.manufacturer).concat(sources.map(s => s.manufacturer)))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  function cell(slug, kind, m) {
    const profs = profiles.filter(p => p.manufacturer === slug && p.kind === kind);
    const recs = sources.filter(s => s.manufacturer === slug && s.kind === kind && covers(s.report_period_start, s.report_period_end, m));
    const captured = items.filter(i => i.manufacturer === slug && i.kind === kind && i.state === "classified" && covers(i.period_start, i.period_end, m));
    const cov = kind === "commission_statement" ? (((input.coverage || {})[slug] || {})[m] || null) : null;
    const monthly = profs.find(p => ((p.rules || {}).expected || {}).cadence === "monthly");
    const due = monthly ? dueDate(monthly, m) : null;
    let status;
    if (recs.length) status = "registered";
    else if (captured.length) status = "captured_draft";
    else if (cov && ["received", "provisional", "partial"].includes(cov.status)) status = "in_hcps_only";
    else if (!monthly) status = "not_expected";
    else if (today > due) status = "missing";
    else status = "not_due";
    const late = recs.filter(s => due && s.received_date && s.received_date > due).map(s => s.id);
    return { status, due, records: recs.map(s => ({ id: s.id, status: s.status, received_date: s.received_date, imported: !!s.import_batch_id, title: s.title })),
      captured: captured.length, coverage: cov ? cov.status : null, late, draft: monthly ? monthly.status !== "active" : null };
  }

  const grid = slugs.map(slug => ({ slug, name: nameOf(slug),
    profiles: profiles.filter(p => p.manufacturer === slug).map(p => ({ code: p.code, kind: p.kind, status: p.status, cadence: ((p.rules || {}).expected || {}).cadence || null })),
    kinds: KINDS.filter(k => profiles.some(p => p.manufacturer === slug && p.kind === k) || sources.some(s => s.manufacturer === slug && s.kind === k))
      .map(k => ({ kind: k, months: months.map(m => Object.assign({ month: m }, cell(slug, k, m))) })) }));

  // The reconciliation: every manufacturer whose profile expects a monthly commission statement, plus anyone who sent one.
  const rec = [];
  for (const g of grid) {
    const k = g.kinds.find(x => x.kind === "commission_statement"); if (!k) continue;
    const c = cell(g.slug, "commission_statement", recM);
    if (c.status === "not_expected" && !c.records.length) continue;
    rec.push({ slug: g.slug, name: g.name, status: c.status, due: c.due, records: c.records, late: c.late.length > 0, coverage: c.coverage, draft_profile: c.draft });
  }
  const rc = { month: recM, ready, ready_on: readyOn, rows: rec,
    counts: rec.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}),
    late: rec.filter(r => r.late).length };

  const openItems = items.filter(i => i.attention && !i.resolved_at);
  const pending = {
    capture_exceptions: openItems.length,
    capture_by_reason: openItems.reduce((a, i) => (a[i.attention] = (a[i.attention] || 0) + 1, a), {}),
    reports_awaiting_acceptance: sources.filter(s => s.status === "received").length,
    reports_awaiting_import: sources.filter(s => s.kind !== "dealer_report" && s.status !== "rejected" && !s.import_batch_id).length,
    shipto_reports_held: (input.shipto || {}).held || 0,
    shipto_orders_needing_review: (input.shipto || {}).needs_review || 0,
    draft_profiles: profiles.filter(p => p.status === "draft").length,
    captured_by_draft_profiles: items.filter(i => i.state === "classified" && i.kind && profiles.some(p => String(p.id) === String(i.profile_id) && p.status === "draft")).length,
  };
  return { today, months, reconciliation: rc, grid, pending };
}

module.exports = { build, dueDate, addM };

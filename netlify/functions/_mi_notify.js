// MI — native HCPS notifications for Manufacturer Intelligence (Angelo, 2026-10-13 11:54 CT; CLAUDE.md §18 OPERATIONAL
// ACTIVATION). Run by mi-ops-cron (hourly :50, after capture :20 and the automatic import :40).
//
//   activity   ONE email per hour, only when something happened since the last one: reports that arrived and were
//              registered, records applied automatically, processing that failed, and exceptions that need Angelo — each
//              line with a direct link to the source report and the screen where the affected records live.
//   digest     ONE daily operational digest (first run at or after 07:00 Chicago): what still needs him, open capture
//              exceptions, the last 24 hours, and the reconciliation so far — sent even when all is clear.
//   monthly    the monthly reconciliation on the 15th (first run at or after 07:00 Chicago on the 15th): every
//              manufacturer whose profile expects a statement for the previous month — received / late / missing / imported.
//
// No duplicates: a watermark (app_settings "mi_notify_state": last log id, last register id, the capture exceptions
// already reported, the digest day, the reconciliation month) moves ONLY after Graph accepted the email, so a failed send
// is retried next hour with the same content and a sent one is never repeated. The first run reports the last 24 hours.
const BASE = "https://www.homecareproviderservices.org";
const L = {
  history: BASE + "/admin/report-history.html", attention: BASE + "/admin/report-history.html#attention",
  commission: BASE + "/admin/import-commissions.html", recon: BASE + "/admin/commission-recon.html",
  shipto: BASE + "/admin/shipto-review.html", intel: BASE + "/admin/dealer-intel.html", dashboard: BASE + "/admin/mi-dashboard.html",
};
const KIND = { sales_export: "order / sales export", commission_statement: "commission statement", dealer_report: "dealer report" };
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = n => n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chicago = d => { const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value; return { day: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24, dom: Number(g("day")), month: `${g("year")}-${g("month")}` }; };

// What a log row means for Angelo. lane: commission | intel | (none) = order export.
const DONE = new Set(["imported", "linked_manual_import", "intel_published"]), RECORDED = new Set(["already_in_hcps", "statement_evidence"]);
function classify(l) {
  const d = l.detail || {}, code = d.code || l.outcome, lane = d.lane || "sales";
  if (l.outcome === "imported" || DONE.has(code)) return { group: "applied", lane, code };
  if (RECORDED.has(code)) return { group: "applied", lane, code };
  if (l.outcome === "needs_approval" || l.outcome === "held") return { group: "action", lane, code };
  return { group: "failed", lane, code };
}
function where(lane) { return lane === "commission" ? ["Commission Report Import", L.commission] : lane === "intel" ? ["Dealer Intelligence Import", L.intel] : ["Ship-To Review → Import check", L.shipto]; }
function logLine(l, src) {
  const d = l.detail || {}, c = classify(l), [wn, wl] = where(c.lane);
  const name = src ? `${src.manufacturer_name || src.manufacturer} — ${KIND[src.kind] || src.kind} ${String(src.report_period_start || "").slice(0, 7)}` : `record #${l.source_id}`;
  let text = d.message || "";
  if (!text && c.lane === "sales") {
    if (l.outcome === "imported") text = `Imported automatically${d.totals ? `: ${d.totals.lines || ""} line(s), ${money(d.totals.amount)}` : ""}.`;
    else if (l.outcome === "needs_approval") text = "Needs your approval: " + ((d.approvals || []).map(a => a.text).join(" ") || "an exception the checks found.");
    else if (l.outcome === "held") text = "Held: " + ((d.blockers || []).map(b => b.text || b.code).join(" ") || "a check did not pass.");
    else text = String(l.outcome).replace(/_/g, " ") + (d.message ? ": " + d.message : ".");
  }
  return { group: c.group, html: `<li><b>${esc(name)}</b>${src && src.file_name ? ` <span style="color:#667">(${esc(src.file_name)})</span>` : ""}<br>${esc(text)}
    <br><a href="${L.history}">Source report</a> · <a href="${wl}">${esc(wn)}</a>${c.lane === "commission" && src && src.manufacturer === "strongback-mobility" ? ` · <a href="${L.recon}">Commission Reconciliation</a>` : ""}</li>`, text: `${name}: ${text}` };
}
const section = (title, items, tone) => items.length ? `<h3 style="margin:16px 0 6px;font:600 15px system-ui;color:${tone}">${esc(title)} (${items.length})</h3><ul style="margin:0;padding-left:18px;font:14px/1.5 system-ui">${items.join("")}</ul>` : "";
const wrap = (title, inner) => `<div style="font:14px/1.5 system-ui,-apple-system,Segoe UI,Arial;color:#0b1f33;max-width:720px">
  <h2 style="margin:0 0 4px;font-size:18px">${esc(title)}</h2>${inner}
  <p style="margin-top:18px;font-size:12px;color:#667">HCPS Connect 360 · Manufacturer Intelligence · <a href="${L.dashboard}">Dashboard</a> · <a href="${L.history}">Report History</a></p></div>`;

function make(deps) {
  const { sbGet, sbGetAll, saveState, sendMail, dashboard } = deps;
  const now = deps.now || (() => new Date());
  const to = deps.to || "angelo@homecareproviderservices.us";

  async function loadState() { const r = await sbGet("app_settings?key=eq.mi_notify_state&select=value"); return (r && r[0] && r[0].value) || null; }

  async function run() {
    const t = now(), local = chicago(t);
    const prev = await loadState();
    const first = !prev;
    const state = Object.assign({ last_log_id: 0, last_source_id: 0, cap_keys: [], digest_day: null, recon_month: null }, prev || {});
    const since24 = new Date(t.getTime() - 24 * 3600e3).toISOString();
    const [logs, srcs, items, mfrs] = await Promise.all([
      sbGetAll(`mfr_auto_import_log?select=id,source_id,outcome,plan_hash,batch_id,detail,actor,created_at`, "id"),
      sbGetAll(`mfr_sources?kind=in.(sales_export,commission_statement,dealer_report)&select=id,manufacturer,kind,title,file_name,status,received_date,report_period_start,report_period_end,import_batch_id,publication_status,created_at`, "id"),
      sbGetAll(`mfr_report_items?attention=not.is.null&resolved_at=is.null&select=id,manufacturer,kind,state,attention,attention_detail,file_name,created_at`, "id"),
      sbGet("manufacturers?select=slug,name")]);
    const mname = new Map(mfrs.map(m => [m.slug, m.name]));
    const srcById = new Map(srcs.map(s => [Number(s.id), Object.assign({ manufacturer_name: mname.get(s.manufacturer) }, s)]));
    const sent = [];

    // ---- activity -------------------------------------------------------------------------------------------------
    const newLogs = logs.filter(l => first ? l.created_at >= since24 : Number(l.id) > Number(state.last_log_id));
    const newSrcs = srcs.filter(s => first ? s.created_at >= since24 : Number(s.id) > Number(state.last_source_id));
    const capKey = i => `${i.id}:${i.attention}`;
    const newCaps = items.filter(i => !state.cap_keys.includes(capKey(i)));
    const reg = newSrcs.map(s => `<li><b>${esc(mname.get(s.manufacturer) || s.manufacturer)} — ${esc(KIND[s.kind] || s.kind)} ${esc(String(s.report_period_start || "").slice(0, 7))}</b> <span style="color:#667">(${esc(s.file_name)})</span><br>Received ${esc(s.received_date)} · registered as record #${s.id}. <a href="${L.history}">Source report</a></li>`);
    const lines = newLogs.map(l => logLine(l, srcById.get(Number(l.source_id))));
    const caps = newCaps.map(i => `<li><b>${esc(mname.get(i.manufacturer) || i.manufacturer || "Unidentified sender")}</b>${i.file_name ? ` <span style="color:#667">(${esc(i.file_name)})</span>` : ""}<br>${esc(String(i.attention).replace(/_/g, " "))}${i.attention_detail ? ": " + esc(String(i.attention_detail).slice(0, 240)) : ""}. <a href="${L.attention}">Needs attention</a></li>`);
    const applied = lines.filter(x => x.group === "applied").map(x => x.html), action = lines.filter(x => x.group === "action").map(x => x.html), failed = lines.filter(x => x.group === "failed").map(x => x.html);
    const actTotal = reg.length + applied.length + action.length + failed.length + caps.length;
    if (actTotal) {
      const parts = [applied.length && `${applied.length} applied`, (action.length + caps.length) && `${action.length + caps.length} need you`, failed.length && `${failed.length} failed`, reg.length && `${reg.length} arrived`].filter(Boolean);
      const html = wrap("Manufacturer report activity", (first ? `<p style="color:#667">First notification — covering the last 24 hours.</p>` : "")
        + section("Needs your action", action.concat(caps), "#b45309") + section("Failed — nothing was written", failed, "#b42323")
        + section("Applied automatically", applied, "#1f7a44") + section("Arrived and registered", reg, "#0f5c8f"));
      if (await sendMail({ to, subject: `MI: ${parts.join(" · ")}`, html })) {
        sent.push("activity");
        state.last_log_id = Math.max(Number(state.last_log_id) || 0, ...logs.map(l => Number(l.id)), 0);
        state.last_source_id = Math.max(Number(state.last_source_id) || 0, ...srcs.map(s => Number(s.id)), 0);
        state.cap_keys = items.map(capKey).slice(-500);
      } else return { ok: false, error: "send_failed", kind: "activity" };
    } else if (first) {
      state.last_log_id = Math.max(0, ...logs.map(l => Number(l.id))); state.last_source_id = Math.max(0, ...srcs.map(s => Number(s.id))); state.cap_keys = items.map(capKey).slice(-500);
    }

    // ---- daily digest + monthly reconciliation -------------------------------------------------------------------
    const dueDigest = local.hour >= 7 && state.digest_day !== local.day;
    const dueRecon = local.hour >= 7 && local.dom >= 15 && state.recon_month !== local.month;
    if (dueDigest || dueRecon) {
      const dash = await dashboard();
      const rc = dash.reconciliation || {};
      // Open work: the newest log row per record that is not finished, for a record still not imported / published.
      const lastBy = new Map(); for (const l of logs) lastBy.set(Number(l.source_id) + "|" + ((l.detail || {}).lane || "sales"), l);
      const open = [...lastBy.values()].filter(l => { const s = srcById.get(Number(l.source_id)); const c = classify(l);
        return c.group !== "applied" && s && !s.import_batch_id && s.status !== "rejected" && !(s.kind === "dealer_report" && s.publication_status === "published"); })
        .map(l => logLine(l, srcById.get(Number(l.source_id))).html);
      const capOpen = items.map(i => `<li><b>${esc(mname.get(i.manufacturer) || i.manufacturer || "Unidentified sender")}</b>${i.file_name ? ` (${esc(i.file_name)})` : ""} — ${esc(String(i.attention).replace(/_/g, " "))}. <a href="${L.attention}">Needs attention</a></li>`);
      const day = logs.filter(l => l.created_at >= since24), dayReg = srcs.filter(s => s.created_at >= since24);
      const sm = rc.summary || {};
      const recLine = r => `<tr><td style="padding:3px 8px 3px 0">${esc(r.name || r.slug)}</td><td style="padding:3px 8px">${esc(({ registered: "Received", missing: "Missing", not_due: "Not due yet", before_capture: "Before capture", in_hcps_only: "In HCPS (by hand)", not_expected: "Not expected" })[r.status] || r.status)}${r.late ? " — late" + (r.days_late ? ` (${r.days_late} d)` : "") : ""}${r.status === "missing" && r.days_overdue ? ` — ${r.days_overdue} d overdue` : ""}</td><td style="padding:3px 8px">${r.imported ? "Imported" : r.status === "registered" ? "Not imported" : ""}</td><td style="padding:3px 0">${r.exceptions ? r.exceptions + " exception(s)" : ""}</td></tr>`;
      const recTable = (rc.rows || []).length ? `<table style="border-collapse:collapse;font:13px system-ui">${rc.rows.map(recLine).join("")}</table>` : "<p>No manufacturer expects a statement for this month.</p>";
      if (dueDigest) {
        const html = wrap(`Daily operational digest — ${local.day}`,
          `<p>${open.length + capOpen.length ? `<b>${open.length + capOpen.length} item(s) need you.</b>` : "<b>All clear</b> — nothing is waiting for you."} Last 24 hours: ${dayReg.length} report(s) registered, ${day.filter(l => classify(l).group === "applied").length} applied automatically, ${day.filter(l => classify(l).group === "failed").length} failed.</p>`
          + section("Waiting for you", open.concat(capOpen), "#b45309")
          + `<h3 style="margin:16px 0 6px;font:600 15px system-ui">Statements for ${esc(rc.month || "")} so far</h3><p>${sm.received || 0} received${sm.received_late ? ` (${sm.received_late} late)` : ""} · ${sm.overdue || 0} overdue · ${sm.not_due || 0} not due yet · ${sm.imported || 0} imported.</p>`);
        if (await sendMail({ to, subject: `MI daily digest ${local.day}: ${open.length + capOpen.length ? (open.length + capOpen.length) + " need you" : "all clear"}`, html })) { sent.push("digest"); state.digest_day = local.day; }
        else return Object.assign({ ok: false, error: "send_failed", kind: "digest" }, await persist());
      }
      if (dueRecon) {
        const html = wrap(`Monthly reconciliation — statements for ${rc.month || ""}`,
          `<p>${sm.received || 0} received${sm.received_late ? ` (${sm.received_late} late)` : ""} · ${sm.overdue || 0} missing / overdue · ${sm.not_due || 0} not due yet · ${sm.in_hcps_only || 0} in HCPS by hand · ${sm.imported || 0} imported · ${sm.open_exceptions || 0} open exception(s). Late reports keep processing when they arrive.</p>${recTable}`);
        if (await sendMail({ to, subject: `MI monthly reconciliation ${rc.month || ""}: ${sm.received || 0} received, ${sm.overdue || 0} missing`, html })) { sent.push("reconciliation"); state.recon_month = local.month; }
        else return Object.assign({ ok: false, error: "send_failed", kind: "reconciliation" }, await persist());
      }
    }
    return Object.assign({ ok: true, sent, counts: { activity: actTotal } }, await persist());
    async function persist() { if (sent.length || first) await saveState(state); return { state }; }
  }
  return { run, classify, chicago };
}

module.exports = { make, classify, chicago, L };

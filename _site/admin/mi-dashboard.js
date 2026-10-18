/* Manufacturer Intelligence dashboard (Phase D) — page script. Read-only: mfr-reports-api "dashboard" plus the Ship-To
   queue counts from shipto-review-api. No inline script (strict CSP safe). */
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let TOKEN = (window.HCPS && HCPS.token && HCPS.token()) || "";
  window.addEventListener("hcps-token", e => { try { TOKEN = e.detail; } catch (_) {} });
  const MON = m => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }); };
  const LONGMON = m => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }); };
  const DAY = d => d ? new Date(d + "T12:00:00Z").toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const KIND = { commission_statement: "Commission statement", sales_export: "Order / sales export", dealer_report: "Dealer report" };
  const COV = { received: "Statement received", provisional: "Provisional (sales report)", partial: "Received — incomplete", incomplete: "Not entered", estimated: "Sales report only — estimated", earned_contract: "Earned — contract rate (not a statement)" };
  const cov = c => c ? (COV[c] || c) : "—";
  const ST = { registered: "Received", missing: "Missing", captured_draft: "Captured (draft profile)", in_hcps_only: "In HCPS (manual)", not_due: "Not due yet", not_expected: "—", before_capture: "Before capture" };

  async function api(fn, p) {
    const r = await fetch("/.netlify/functions/" + fn, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: JSON.stringify(p) });
    let body = {}; try { body = await r.json(); } catch (e) {}
    return { status: r.status, body };
  }
  function gate(msg) {
    $("#body").innerHTML = `<div class="gate"><h2>Staff sign-in</h2><p class="hint">Sign in with your work email and password.</p><input id="lemail" type="email" placeholder="Email" autocomplete="username"><input id="lpass" type="password" placeholder="Password" autocomplete="current-password"><button class="go" id="lgo">Sign in</button><div class="er" id="lerr" style="color:#b42323;margin-top:8px">${esc(msg || "")}</div></div>`;
    $("#lgo").onclick = submit; $("#lpass").onkeydown = e => { if (e.key === "Enter") submit(); };
  }
  async function submit() {
    const email = ($("#lemail").value || "").trim(), password = $("#lpass").value || "";
    try { const r = await fetch("/.netlify/functions/staff-auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "login", email, password }) });
      const j = await r.json().catch(() => ({})); if (!j || !j.ok) { gate((j && j.message) || "Could not sign in."); return; }
      HCPS.setSession(j); TOKEN = j.token; boot();
    } catch (e) { gate("Could not reach the server. Try again."); }
  }

  const badge = (st, extra) => `<span class="s s-${esc(st)}">${esc(ST[st] || st)}${extra || ""}</span>`;
  function render(d, ship) {
    const P = d.pending, R = d.reconciliation;
    const k = (label, v, href) => `<div class="kpi"><div class="l">${esc(label)}</div><div class="v">${v}</div>${href ? `<a href="${href}">Open</a>` : ""}</div>`;
    let h = `<h2 class="sec">Waiting for a person</h2><div class="kpis">
      ${k("Report email needing attention", P.capture_exceptions, "/admin/report-history.html")}
      ${k("Reports awaiting acceptance", P.reports_awaiting_acceptance, "/admin/report-history.html")}
      ${k("Reports not yet imported", P.reports_awaiting_import, "/admin/report-history.html")}
      ${k("Ship-To: orders needing review", ship ? ship.needs_review : "…", "/admin/shipto-review.html")}
      ${k("Ship-To: reports held", ship ? ship.held : "…", "/admin/shipto-review.html")}
      ${k("Draft profiles (not automatic yet)", P.draft_profiles, "")}</div>`;
    h += `<h2 class="sec">Monthly reconciliation — ${esc(LONGMON(R.month))}</h2>`;
    h += `<div class="note">${R.ready ? `<b>Ready</b> since ${esc(DAY(R.ready_on))}.` : `<b>Draft</b> — becomes ready on ${esc(DAY(R.ready_on))}.`} Reports that arrive after their due date are marked late and keep processing.${R.late ? ` <b>${R.late} late.</b>` : ""}</div>`;
    const S = R.summary || {};
    if (R.summary) h += `<div class="kpis">${k("Received", S.received + (S.received_late ? ` <span class="hint">(${S.received_late} late)</span>` : ""), "")}${k("Not received — overdue", S.overdue, "")}${k("Not due yet", S.not_due, "")}${k("In HCPS by hand (no file)", S.in_hcps_only, "")}${k("Received, not imported", S.registered_not_imported, "/admin/report-history.html")}${k("Report email needing attention", S.open_exceptions, "/admin/report-history.html")}</div>`;
    const win = e => e ? `${esc(MON(e.month).split(" ")[0])} ${e.from === e.to ? e.from : e.from + "–" + e.to}` : "—";
    h += R.rows.length ? `<div class="scroll"><table class="cal"><thead><tr><th>Manufacturer</th><th>Statement</th><th>Expected</th><th>Due</th><th>Arrived</th><th>Record</th><th>Commission data in HCPS</th><th>Needs attention</th></tr></thead><tbody>${R.rows.map(r =>
      `<tr><td>${esc(r.name)}${r.draft_profile ? ` <span class="hint">(draft profile)</span>` : ""}</td><td>${badge(r.status, r.late ? " · late" : "")}</td><td>${win(r.expected)}</td><td>${esc(DAY(r.due))}</td>
        <td>${r.arrived ? esc(DAY(r.arrived)) + (r.days_late ? ` <span class="s s-missing">${r.days_late} day${r.days_late === 1 ? "" : "s"} late</span>` : "") : (r.days_overdue ? `<span class="s s-missing">not received · ${r.days_overdue} day${r.days_overdue === 1 ? "" : "s"} late</span>` : "—")}</td>
        <td>${r.records.map(x => `#${x.id} ${esc(x.status)}${x.imported ? " · imported" : " · not imported"}`).join("<br>") || "—"}</td><td>${esc(cov(r.coverage))}</td><td>${r.exceptions ? `<a href="/admin/report-history.html">${r.exceptions} open</a>` : "—"}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">No manufacturer has a monthly statement profile yet.</div>`;
    h += `<h2 class="sec">Report arrivals by month</h2><div class="scroll"><table class="cal"><thead><tr><th>Manufacturer / report</th>${d.months.map(m => `<th>${esc(MON(m))}</th>`).join("")}</tr></thead><tbody>`;
    for (const g of d.grid) for (const kd of g.kinds) {
      h += `<tr><td><b>${esc(g.name)}</b><br><span class="hint">${esc(KIND[kd.kind] || kd.kind)}</span></td>${kd.months.map(c =>
        `<td>${badge(c.status, c.late.length ? " · late" : "")}${c.records.length ? `<div class="hint">${c.records.map(x => "#" + x.id + (x.imported ? " imported" : "")).join(", ")}</div>` : ""}${c.coverage && c.status !== "in_hcps_only" ? `<div class="hint">HCPS: ${esc(cov(c.coverage))}</div>` : ""}</td>`).join("")}</tr>`;
    }
    h += `</tbody></table></div><p class="hint">Missing = a profile expects this report monthly and its due date has passed. On-request and irregular reports are never missing. "Before capture" = due before automatic email capture began${d.capture_start ? " (" + esc(DAY(d.capture_start)) + ")" : ""} — the email may be in Outlook; it was never looked for automatically. "In HCPS (manual)" = commission data imported by hand without a registered file.</p>`;
    if (Q && Q.quarantined && Q.quarantined.length) {
      h += `<h2 class="sec">For your review — quarantined ${esc(LONGMON(Q.period))} Strongback rows</h2>
        <div class="note">Read only. ${Q.totals.rows} row(s) were moved out of sales on Oct 11 because they hold no amount and no commission (${Q.totals.with_amount} with an amount, ${Q.totals.with_commission} with a commission). Nothing here changes them.</div>
        <div class="scroll"><table class="cal"><thead><tr><th>#</th><th>Original source</th><th>Customer / dealer</th><th>Amount</th><th>Commission</th><th>Same order in a registered export</th></tr></thead><tbody>${Q.quarantined.map(r =>
          `<tr><td>${r.quarantine_id}</td><td>${esc(r.source)} · ${esc(r.source_file || "")}<div class="hint">${esc(r.reason)}</div></td><td>${esc(r.original.customer_name || "—")}<div class="hint">${esc(r.original.dealer || "")}</div></td>
           <td>${r.original.amount == null ? "blank" : esc(r.original.amount)}</td><td>${r.original.commission == null ? "blank" : esc(r.original.commission)}</td>
           <td>${r.matches.map(m => `#${m.source_id} order ${esc(m.order_number)} · $${esc(m.amount)} (${esc(m.basis)})`).join("<br>") || "—"}</td></tr>`).join("")}</tbody></table></div>
        <div class="note"><b>Also on file for ${esc(LONGMON(Q.period))}:</b> ${Q.registered_reports.map(x => `#${x.id} ${esc(x.title)} (${esc(x.status)}${x.imported ? ", imported" : ", not imported"})`).join(" · ") || "no registered reports"} · rows in sales for the month: ${Q.in_monthly_sales.rows}</div>
        <div class="note"><b>Your choices</b> (nothing happens until you decide):<ol>${Q.choices.map(c => `<li>${esc(c.text)}</li>`).join("")}</ol></div>`;
      if (Q.disposition) h += `<div class="note"><b>Decided:</b> kept quarantined permanently on ${esc(DAY(String(Q.disposition.created_at).slice(0, 10)))} by ${esc(Q.disposition.actor)}${Q.disposition.release_source_id ? ` · record #${esc(Q.disposition.release_source_id)} released to be considered on its own (import still needs your approval)` : ""}. Reason: ${esc(Q.disposition.reason)}</div>`;
      else if (Q.disposition_installed) h += `<div class="panel" id="qdisp"><b>Record your decision — keep these rows quarantined permanently</b>
        ${(Q.release_candidates || []).length ? `<label class="chk"><input type="checkbox" id="qrel" checked> Release ${Q.release_candidates.map(r => `record #${esc(r.id)} (${esc(r.file_name)})`).join(", ")} to be considered for import on its own</label>` : ""}
        <label for="qreason">Reason (required)</label><textarea id="qreason" rows="2"></textarea>
        <div class="btnrow"><button class="go sec" id="qprev">Show what this records</button>${QD.preview ? ` <button class="go" id="qgo">Confirm — keep quarantined permanently</button>` : ""}</div>
        ${QD.msg ? `<div class="${QD.ok ? "okm" : "err"}">${esc(QD.msg)}</div>` : ""}<div class="hint">President only. Permanent: these rows can never be restored, changed or deleted afterwards. Nothing is imported.</div></div>`;
      else h += `<div class="note">Recording a decision becomes available once the Phase E tables are installed.</div>`;
    }
    $("#body").innerHTML = h;
    const pv = $("#qprev"), go = $("#qgo");
    const payload = dry => ({ action: "quarantine_dispose", manufacturer: Q.manufacturer, period: Q.period, quarantine_fp: Q.quarantine_fp, dry_run: dry,
      release_source_id: $("#qrel") && $("#qrel").checked && (Q.release_candidates || [])[0] ? Q.release_candidates[0].id : "", reason: ($("#qreason").value || "").trim() });
    if (pv) pv.onclick = async () => { QD.reason = $("#qreason").value; const r = await api("shipto-review-api", payload(true));
      QD.preview = r.status === 200; QD.ok = r.status === 200; QD.msg = r.status === 200 ? r.body.effect : ((r.body && (r.body.message || r.body.error)) || "HTTP " + r.status); render(LAST.d, LAST.ship); if ($("#qreason")) $("#qreason").value = QD.reason || ""; };
    if (go) go.onclick = async () => { const r = await api("shipto-review-api", payload(false));
      QD.ok = r.status === 200; QD.preview = false; QD.msg = r.status === 200 ? "Recorded." : ((r.body && (r.body.message || r.body.error)) || "HTTP " + r.status);
      if (r.status === 200) { const qr = await api("shipto-review-api", { action: "quarantine_review", manufacturer: Q.manufacturer, period: Q.period }); if (qr.status === 200) Q = qr.body; }
      render(LAST.d, LAST.ship); };
  }
  let Q = null; const QD = {}; const LAST = {};
  async function boot() {
    if (!TOKEN) { gate(); return; }
    const [d, q, qr] = await Promise.all([api("mfr-reports-api", { action: "dashboard" }), api("shipto-review-api", { action: "queue" }),
      api("shipto-review-api", { action: "quarantine_review", manufacturer: "strongback-mobility", period: "2026-09" })]);
    Q = qr.status === 200 ? qr.body : null;
    if (d.status === 401) { gate(); return; }
    if (d.status !== 200) { $("#body").innerHTML = `<div class="err">${esc((d.body && (d.body.message || d.body.error)) || "HTTP " + d.status)}</div>`; return; }
    const ship = q.status === 200 ? { held: q.body.held || 0, needs_review: (q.body.reports || []).reduce((s, r) => s + ((r.counts && r.counts.needs_review) || 0), 0) } : null;
    LAST.d = d.body; LAST.ship = ship; render(d.body, ship);
  }
  boot();
})();

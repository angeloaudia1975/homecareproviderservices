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
  const ST = { registered: "Received", missing: "Missing", captured_draft: "Captured (draft profile)", in_hcps_only: "In HCPS (manual)", not_due: "Not due yet", not_expected: "—" };

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
    h += R.rows.length ? `<div class="scroll"><table class="cal"><thead><tr><th>Manufacturer</th><th>Statement</th><th>Due</th><th>Record</th><th>Commission data in HCPS</th></tr></thead><tbody>${R.rows.map(r =>
      `<tr><td>${esc(r.name)}${r.draft_profile ? ` <span class="hint">(draft profile)</span>` : ""}</td><td>${badge(r.status, r.late ? " · late" : "")}</td><td>${esc(DAY(r.due))}</td>
        <td>${r.records.map(x => `#${x.id} ${esc(x.status)}${x.imported ? " · imported" : " · not imported"}`).join("<br>") || "—"}</td><td>${esc(r.coverage || "—")}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">No manufacturer has a monthly statement profile yet.</div>`;
    h += `<h2 class="sec">Report arrivals by month</h2><div class="scroll"><table class="cal"><thead><tr><th>Manufacturer / report</th>${d.months.map(m => `<th>${esc(MON(m))}</th>`).join("")}</tr></thead><tbody>`;
    for (const g of d.grid) for (const kd of g.kinds) {
      h += `<tr><td><b>${esc(g.name)}</b><br><span class="hint">${esc(KIND[kd.kind] || kd.kind)}</span></td>${kd.months.map(c =>
        `<td>${badge(c.status, c.late.length ? " · late" : "")}${c.records.length ? `<div class="hint">${c.records.map(x => "#" + x.id + (x.imported ? " imported" : "")).join(", ")}</div>` : ""}${c.coverage && c.status !== "in_hcps_only" ? `<div class="hint">HCPS: ${esc(c.coverage)}</div>` : ""}</td>`).join("")}</tr>`;
    }
    h += `</tbody></table></div><p class="hint">Missing = a profile expects this report monthly and its due date has passed. On-request and irregular reports are never missing. "In HCPS (manual)" = commission data imported by hand without a registered file.</p>`;
    $("#body").innerHTML = h;
  }
  async function boot() {
    if (!TOKEN) { gate(); return; }
    const [d, q] = await Promise.all([api("mfr-reports-api", { action: "dashboard" }), api("shipto-review-api", { action: "queue" })]);
    if (d.status === 401) { gate(); return; }
    if (d.status !== 200) { $("#body").innerHTML = `<div class="err">${esc((d.body && (d.body.message || d.body.error)) || "HTTP " + d.status)}</div>`; return; }
    const ship = q.status === 200 ? { held: q.body.held || 0, needs_review: (q.body.reports || []).reduce((s, r) => s + ((r.counts && r.counts.needs_review) || 0), 0) } : null;
    render(d.body, ship);
  }
  boot();
})();

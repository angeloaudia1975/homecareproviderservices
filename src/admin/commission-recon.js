/* Commission Reconciliation (Angelo, 2026-10-12 22:00 CT; CLAUDE.md §18) — page script. Reads mfr-reports-api
   "commission_recon" (read-only). The only writes are the President's payment evidence and review decisions
   ("commission_event"), which never create a sale or touch monthly_sales. No inline script (strict CSP safe). */
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let TOKEN = (window.HCPS && HCPS.token && HCPS.token()) || "";
  window.addEventListener("hcps-token", e => { try { TOKEN = e.detail; } catch (_) {} });
  const $$ = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MON = m => { if (!/^\d{4}-\d{2}$/.test(m || "")) return m || "—"; const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }); };
  const DAY = d => d ? new Date(d + "T12:00:00Z").toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
  const LABEL = {
    status_not_verified: ["Status not verified — not eligible yet", "l-warn"], status_not_in_record: ["Status not in HCPS record", "l-mute"],
    payment_unverified: ["Reported due — payment not confirmed", "l-warn"], potentially_overdue_unreported: ["Potentially overdue — not on a statement", "l-bad"],
    potentially_overdue_unpaid: ["Potentially overdue — no payment evidence", "l-bad"] };
  const STAGE = { earned: ["Earned", "l-info"], reported_due: ["Reported due", "l-warn"], paid: ["Paid", "l-ok"], not_eligible: ["Not eligible", "l-mute"] };
  const GROUPS = [["order", "Orders"], ["dealer", "Dealers"], ["month", "Sale month"], ["reporting_month", "Reporting month"], ["manufacturer", "Manufacturer"]];
  const FILTERS = [["all", "All orders"], ["unverified", "Payment not confirmed"], ["overdue", "Potentially overdue"], ["not_reported", "Earned, not reported yet"], ["not_eligible", "Not eligible / status"], ["flagged", "Differences flagged"]];
  let R = null, VIEW = "order", FILTER = "all", OPEN = null, MSG = null, PRES = false;

  async function api(p) {
    const r = await fetch("/.netlify/functions/mfr-reports-api", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: JSON.stringify(p) });
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

  const keep = o => FILTER === "all" ? true : FILTER === "unverified" ? o.labels.includes("payment_unverified")
    : FILTER === "overdue" ? o.labels.some(l => l.startsWith("potentially_overdue")) : FILTER === "not_reported" ? (o.earned > 0 && !o.statement_refs.length)
    : FILTER === "not_eligible" ? (o.eligibility === "pending_status" || o.eligibility === "reversed" || o.eligibility === "eligible_unverified_status") : (o.flags.length > 0);
  const k = (l, v, sub) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v">${v}</div>${sub ? `<div class="hint">${sub}</div>` : ""}</div>`;

  function render() {
    const S = R.summary; let h = "";
    h += `<div class="note"><b>${esc(R.contract.label)}</b> · ${esc(R.contract.basis)}. Statements: ${esc(R.contract.statement)}. ${esc(S.note)}</div>`;
    h += `<div class="kpis">${k("Eligible sales", $$(S.eligible_sales), `${S.eligible_orders} order(s)`)}${k(R.contract.label, $$(S.earned))}${k("Reported due (" + R.contract.statement + ")", $$(S.reported_due), "not a payment")}
      ${k("Paid (with evidence)", $$(S.paid), R.evidence_store === "installed" ? "" : "evidence store not installed")}${k("Outstanding (earned − paid)", $$(S.outstanding))}
      ${k("Earned, not on a statement yet", $$(S.earned_not_reported))}${k("Statement lines to review", S.review_lines, S.review_lines ? $$(S.review_due) + " reported due" : "")}
      ${k("Payment not confirmed", S.payment_unverified, "order(s)")}${k("Potentially overdue", S.potentially_overdue, "order(s)")}</div>`;
    if (R.problems.length) h += `<div class="note" style="border-color:#f3b4b4;background:#fdf6f6"><b>Could not be read reliably:</b><ul>${R.problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>`;
    if (MSG) h += `<div class="${MSG.ok ? "okm" : "err"}">${esc(MSG.text)}</div>`;
    h += `<div class="tabs" role="tablist">${GROUPS.map(([g, l]) => `<button role="tab" data-g="${g}" aria-selected="${VIEW === g}">${esc(l)}</button>`).join("")}</div>`;
    if (VIEW === "order") {
      h += `<div class="flt">${FILTERS.map(([f, l]) => `<button data-f="${f}" aria-pressed="${FILTER === f}">${esc(l)}</button>`).join("")}</div>`;
      const rows = R.orders.filter(keep);
      h += rows.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Order</th><th>Sale date</th><th>Dealer</th><th class="num">Eligible sale</th><th class="num">Earned (${Math.round(R.contract.rate * 100)}%)</th><th>Statement</th><th class="num">Reported due</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Status</th></tr></thead><tbody>${rows.map(o => {
        const st = STAGE[o.stage] || ["—", "l-mute"];
        const labs = [`<span class="lab ${st[1]}">${esc(st[0])}</span>`].concat(o.labels.map(l => `<span class="lab ${(LABEL[l] || ["", "l-mute"])[1]}">${esc((LABEL[l] || [l])[0])}</span>`))
          .concat(o.flags.length ? [`<span class="lab l-warn">${o.flags.length} difference${o.flags.length === 1 ? "" : "s"}</span>`] : []).join("");
        const refs = o.statement_refs.filter(r => !r.repeated).map(r => `#${r.source_id} · ${esc(MON(r.period))}`).join("<br>") || "—";
        const row = `<tr class="row" data-o="${esc(o.order_key)}"><td><b>${esc(o.order)}</b></td><td>${esc(DAY(o.date))}</td><td>${esc(o.dealer || o.company || "—")}</td><td class="num">${$$(o.eligible_amount)}</td><td class="num">${$$(o.earned)}</td><td>${refs}</td><td class="num">${o.reported_due ? $$(o.reported_due) : "—"}</td><td class="num">${o.paid ? $$(o.paid) : "—"}</td><td class="num">${$$(o.outstanding)}</td><td>${labs}</td></tr>`;
        if (OPEN !== o.order_key) return row;
        const src = o.sources.map(s => s.kind === "export" ? `Order export #${s.source_id} (${esc(s.file_name)}), file line(s) ${s.lines.join(", ")}` : `HCPS sales (${s.rows.length} line${s.rows.length === 1 ? "" : "s"})`).join(" · ");
        const det = `<tr class="det"><td colspan="10"><div><b>Eligibility:</b> ${esc(o.eligibility_text)}${o.dealer_paid ? ` · dealer invoice fully paid to the manufacturer: ${esc(o.dealer_paid)} (information only — not a commission payment)` : ""}</div>
          <div><b>Sale on file:</b> ${$$(o.amount)} in ${o.lines} line(s) — ${src}</div>
          ${o.flags.length ? `<div><b>Differences:</b><ul>${o.flags.map(f => `<li>${esc(f.text)}</li>`).join("")}</ul></div>` : ""}
          ${o.statement_refs.length ? `<div><b>Statement lines:</b> ${o.statement_refs.map(r => `#${r.source_id} line ${r.line}: ${esc(r.company)}, subtotal ${$$(r.subtotal)}, due ${$$(r.due)}${r.repeated ? " (listed again — not counted)" : ""}`).join(" · ")}</div>` : `<div><b>Statement:</b> not on any ${esc(R.contract.statement)} yet.</div>`}
          <div><b>Payments:</b> ${o.payments.length ? o.payments.map(p => `${$$(p.amount)} — ${esc(p.evidence || "")}`).join(" · ") : "no payment evidence recorded"}</div>
          ${o.age_days != null ? `<div class="hint">Sale ${o.age_days} day(s) ago.</div>` : ""}</td></tr>`;
        return row + det;
      }).join("")}</tbody></table></div>` : `<div class="empty">No orders match this filter.</div>`;
    } else {
      const G = R.groups[VIEW] || [];
      h += `<div class="scroll"><table class="tbl"><thead><tr><th>${esc((GROUPS.find(g => g[0] === VIEW) || [])[1])}</th><th class="num">Orders</th><th class="num">Eligible sales</th><th class="num">Earned</th><th class="num">Reported due</th><th class="num">Paid</th><th class="num">Outstanding</th><th class="num">Flagged</th></tr></thead><tbody>${G.map(g =>
        `<tr><td><b>${esc(VIEW.endsWith("month") && /^\d{4}-\d{2}$/.test(g.key) ? MON(g.key) : g.key)}</b></td><td class="num">${g.orders}</td><td class="num">${$$(g.eligible_sales)}</td><td class="num">${$$(g.earned)}</td><td class="num">${$$(g.reported_due)}</td><td class="num">${$$(g.paid)}</td><td class="num">${$$(g.outstanding)}</td><td class="num">${g.flagged || "—"}</td></tr>`).join("")}</tbody></table></div>
        <p class="hint">Each row's columns are separate views of the same commission; a row's total is never earned + reported due.</p>`;
    }
    // Statement lines with no matching sale → review (never a sale).
    h += `<h2 class="sec">Statement lines with no matching sale — review</h2>`;
    h += R.review.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Statement</th><th>Order</th><th>Company on statement</th><th class="num">Subtotal</th><th class="num">Reported due</th><th>Decision</th></tr></thead><tbody>${R.review.map((x, i) =>
      `<tr><td>#${x.source_id} · ${esc(MON(x.period))}</td><td><b>${esc(x.order)}</b></td><td>${esc(x.company)}</td><td class="num">${$$(x.subtotal)}</td><td class="num">${$$(x.due)}</td>
       <td>${x.decision ? `${esc(x.decision)} — ${esc(x.decision_reason || "")}` : `<span class="lab l-bad">Needs review</span>`}${PRES && R.evidence_store === "installed" ? ` <button class="go sec" data-rv="${i}">Decide</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">Every statement line matches a sale on file.</div>`;
    if (OPEN && OPEN.startsWith("rv:")) { const x = R.review[Number(OPEN.slice(3))];
      if (x) h += `<div class="frm" id="rvf"><b>Statement #${x.source_id}, order ${esc(x.order)}</b>
        <div class="f"><div><label for="rvd">Decision</label><select id="rvd"><option value="investigate">Investigate (ask ${esc(R.contract.statement === "SR032" ? "Strongback" : "the manufacturer")})</option><option value="matched_to">It is this sale on file:</option><option value="not_ours">Not ours</option><option value="duplicate">Duplicate line</option></select></div>
        <div><label for="rvo">Order on file (for "It is this sale")</label><input id="rvo" placeholder="order number"></div><div class="wide"><label for="rvr">Reason (required)</label><textarea id="rvr" rows="2"></textarea></div></div>
        <div class="btnrow"><button class="go" id="rvgo">Record decision</button><button class="go sec" id="rvx">Cancel</button></div><div class="hint">A decision never creates a sale. Recorded with your name; a later decision supersedes it.</div></div>`; }
    // Statements and payment evidence.
    h += `<h2 class="sec">Statements on file</h2>`;
    h += R.statements.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Statement</th><th>Period</th><th>Received</th><th class="num">Lines</th><th class="num">Matched</th><th class="num">To review</th><th class="num">Reported due</th><th class="num">Paid (evidence)</th><th>Payment</th></tr></thead><tbody>${R.statements.map((s, i) =>
      `<tr><td>#${s.source_id} · ${esc(s.file_name)}${s.ok ? "" : ` <span class="lab l-bad">not readable</span>`}</td><td>${esc(MON(s.period))}</td><td>${esc(DAY(s.received_date))}</td><td class="num">${s.lines}</td><td class="num">${s.matched}</td><td class="num">${s.unmatched}</td><td class="num">${s.total_due != null ? $$(s.total_due) : "—"}</td><td class="num">${s.paid ? $$(s.paid) : "—"}</td>
       <td>${{ no_evidence: '<span class="lab l-warn">No payment evidence</span>', paid_in_full: '<span class="lab l-ok">Paid in full</span>', partial: '<span class="lab l-warn">Partial — not allocated</span>', overpaid: '<span class="lab l-bad">More than listed</span>' }[s.payment_state] || ""}
       ${PRES && R.evidence_store === "installed" && s.ok ? ` <button class="go sec" data-pay="${i}">Record payment</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">No commission statement is registered yet.</div>`;
    if (OPEN && OPEN.startsWith("pay:")) { const s = R.statements[Number(OPEN.slice(4))];
      if (s) h += `<div class="frm" id="payf"><b>Payment evidence for statement #${s.source_id} (${esc(MON(s.period))}, ${$$(s.total_due)} reported due)</b>
        <div class="f"><div><label for="pa">Amount paid</label><input id="pa" inputmode="decimal" placeholder="0.00"></div><div><label for="pd">Paid on</label><input id="pd" type="date"></div>
        <div class="wide"><label for="pe">Evidence (remittance, deposit or cheque reference)</label><input id="pe"></div><div class="wide"><label for="pr">Reason / note (required)</label><textarea id="pr" rows="2"></textarea></div></div>
        <div class="btnrow"><button class="go" id="pgo">Record payment</button><button class="go sec" id="px">Cancel</button></div>
        <div class="hint">Only money actually received, with evidence. A full payment pays every line of this statement; a partial one stays unallocated until you record it by order.</div></div>`; }
    if (R.unallocated.length) h += `<div class="note"><b>Payments not allocated to orders:</b><ul>${R.unallocated.map(u => `<li>${esc(u.text)}</li>`).join("")}</ul></div>`;
    if (R.evidence_store !== "installed") h += `<div class="note">Recording payment evidence and review decisions becomes available once <code>supabase/mi_f_commission_events.sql</code> is installed. Until then every statement shows "No payment evidence".</div>`;
    // Posting preview (nothing is posted here).
    const P = R.posting_preview;
    h += `<h2 class="sec">Posting preview — nothing is posted from this page</h2>`;
    h += (P.exports.length ? P.exports.map(x => `<div class="card2"><div class="ttl">Order export #${x.source_id} · ${esc(x.file_name)} · ${esc(MON(x.period))}</div>
      <div class="grid"><div><b>New orders</b>${x.orders}</div><div><b>Lines</b>${x.lines}</div><div><b>Sales</b>${$$(x.amount)}</div><div><b>${esc(R.contract.label)}</b>${$$(x.earned)}</div><div><b>Already in HCPS</b>${x.already_in_hcps}</div></div>
      ${x.not_eligible.length ? `<div class="hint">Not eligible yet: ${x.not_eligible.map(n => `${esc(n.order)} (${esc(n.why)})`).join("; ")}</div>` : ""}
      <div class="hint">Posting would add these orders to the sales-report lane with commission at the contract rate (= earned). It needs your separate approval in Ship-To Review → Import check.</div></div>`).join("")
      : `<div class="empty">No registered order export is waiting to be posted.</div>`)
      + `<div class="note">${esc(P.statements_note)}${P.commission_lane_warning ? `<br><b>${esc(P.commission_lane_warning)}</b>` : ""}</div>`;
    $("#body").innerHTML = h;
    document.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { VIEW = b.dataset.g; render(); });
    document.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { FILTER = b.dataset.f; render(); });
    document.querySelectorAll("tr.row").forEach(r => r.onclick = () => { OPEN = OPEN === r.dataset.o ? null : r.dataset.o; render(); });
    document.querySelectorAll("[data-rv]").forEach(b => b.onclick = () => { OPEN = "rv:" + b.dataset.rv; render(); });
    document.querySelectorAll("[data-pay]").forEach(b => b.onclick = () => { OPEN = "pay:" + b.dataset.pay; render(); });
    const cancel = () => { OPEN = null; render(); };
    if ($("#rvx")) $("#rvx").onclick = cancel; if ($("#px")) $("#px").onclick = cancel;
    if ($("#rvgo")) $("#rvgo").onclick = async () => { const x = R.review[Number(OPEN.slice(3))]; const d = $("#rvd").value;
      const decision = d === "matched_to" ? "matched_to:" + ($("#rvo").value || "").trim() : d;
      await save({ action: "commission_event", kind: "review", source_id: x.source_id, order_number: x.order, decision, reason: $("#rvr").value }); };
    if ($("#pgo")) $("#pgo").onclick = async () => { const s = R.statements[Number(OPEN.slice(4))];
      await save({ action: "commission_event", kind: "payment", source_id: s.source_id, amount: $("#pa").value, paid_on: $("#pd").value, evidence: $("#pe").value, reason: $("#pr").value }); };
  }
  async function save(p) {
    const r = await api(p);
    MSG = r.status === 200 ? { ok: true, text: "Recorded." } : { ok: false, text: (r.body && (r.body.message || r.body.error)) || "HTTP " + r.status };
    if (r.status === 200) { OPEN = null; await reload(); } else render();
  }
  async function reload() {
    const r = await api({ action: "commission_recon", manufacturer: "strongback-mobility" });
    if (r.status === 401) { gate(); return; }
    if (r.status !== 200) { $("#body").innerHTML = `<div class="err">${esc((r.body && (r.body.message || r.body.error)) || "HTTP " + r.status)}</div>`; return; }
    R = r.body; render();
  }
  async function boot() {
    if (!TOKEN) { gate(); return; }
    try { const pr = window.HCPS && HCPS.profile && HCPS.profile(); PRES = String((pr && pr.role) || "").toLowerCase() === "president"; } catch (_) { PRES = false; }
    await reload();
  }
  boot();
})();

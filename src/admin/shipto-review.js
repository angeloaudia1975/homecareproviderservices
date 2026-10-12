/* Ship-To Review (Phase C) — page script. Talks only to /.netlify/functions/shipto-review-api with the staff sign-in.
   Views: Reports (the queue) → one report's orders (needs review first) with the correction panel → Save & Continue.
   Mappings and the read-only Shadow check are their own tabs. No inline script (works under a strict CSP too). */
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtWhen = d => d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) + " CT" : "—";
  let TOKEN = (window.HCPS && HCPS.token && HCPS.token()) || "";
  window.addEventListener("hcps-token", e => { try { TOKEN = e.detail; } catch (_) {} });
  const S = { view: "queue", queue: null, src: null, rep: null, sel: null, form: null, msg: "", err: "", busy: false, maps: null, mapsMfr: "strongback-mobility", shadow: null, search: [] };
  const REASON = {
    zip_shared: "The ship-to ZIP belongs to more than one branch of this dealer.",
    new_location: "The ship-to address / ZIP matches no branch on file — a new location, or a branch HCPS doesn't have yet.",
    billing_address_only: "The report gives only a billing address — where it shipped is unknown.",
    no_ship_to: "The report gives no ship-to details for this order.",
    weak_evidence: "Only a city or a name points at a branch — not enough to assign it.",
    mixed_lines: "Lines of this one order show different customers or ship-to places.",
    no_dealer_match: "No HCPS dealer matches this company or account number.",
    correction_stale: "An earlier correction was made on a different reading of this order — check it again.",
    mapping_unverified: "A remembered decision exists for this ship-to, but the order's account number doesn't confirm it belongs to that location's dealer family — check it.",
    zip_assignment_unverified: "A saved ZIP → branch assignment fits, but the order's account number doesn't confirm the dealer family — check it.",
  };
  const BASIS = { zip: "Ship-to ZIP matches one branch", address: "Ship-to street matches one branch", single: "The dealer has one location",
    verified_mapping: "Verified mapping (a person decided this ship-to before)", zip_assignment: "Saved ZIP → branch assignment",
    corporate_confirmed: "Confirmed corporate / drop-ship", person: "Chosen by a person" };
  const ST = { needs_review: "Needs ship-to review", corrected: "Corrected", resolved: "Resolved", held: "Held — orders need review", ready: "Ready", empty: "No orders", unreadable: "Unreadable" };

  async function api(p) {
    const r = await fetch("/.netlify/functions/shipto-review-api", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: JSON.stringify(p) });
    let body = {}; try { body = await r.json(); } catch (e) {}
    return { status: r.status, body };
  }
  window.SHIPTO = { api };

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

  const tabs = () => `<div class="tabs" role="tablist">${[["queue", "Reports"], ["maps", "Verified mappings"], ["shadow", "Shadow check"]].map(([k, l]) =>
    `<button role="tab" data-tab="${k}" aria-selected="${S.view === k || (k === "queue" && S.view === "report")}">${l}</button>`).join("")}</div>`;

  function render() {
    let h = tabs();
    if (S.view === "queue") h += queueHtml();
    else if (S.view === "report") h += reportHtml();
    else if (S.view === "maps") h += mapsHtml();
    else if (S.view === "shadow") h += shadowHtml();
    $("#body").innerHTML = h;
    wire();
  }

  function queueHtml() {
    if (!S.queue) return `<div class="msg">Reading the registered order reports…</div>`;
    if (S.queue.error) return `<div class="err">${esc(S.queue.error)}</div>`;
    const reps = S.queue.reports || [];
    let h = `<div class="note">Each registered order export is read from its stored original and checked order by order. A report is <b>Ready</b> only when every order has a reliable branch; until then it is <b>Held</b> as a whole — nothing is imported from it, and nothing here imports at all.</div>`;
    if (!reps.length) return h + `<div class="empty">No registered order reports yet. They appear here once Report History holds an order / sales export.</div>`;
    for (const r of reps) {
      const c = r.counts || {};
      h += `<div class="card2"><div class="hd"><div class="ttl">${esc(r.title || r.file_name)}</div><span class="chip c-${esc(r.review_status)}">${esc(ST[r.review_status] || r.review_status)}</span></div>
        <div class="grid"><div><b>File</b>${esc(r.file_name)}</div><div><b>Received</b>${esc(r.received_date || "—")}</div><div><b>Period</b>${esc((r.period || []).join(" – "))}</div>
        ${r.review_status === "unreadable" ? `<div><b>Problem</b>${esc(r.message || r.error)}</div>` : `<div><b>Orders</b>${c.orders || 0} (${c.lines || 0} lines)</div>
        <div><b>Need review</b>${c.needs_review || 0}</div><div><b>Corrected</b>${c.corrected || 0}</div><div><b>Resolved</b>${c.resolved || 0}</div>
        <div><b>Amount</b>${money(r.totals && r.totals.amount)}</div>`}</div>
        ${r.review_status === "unreadable" ? "" : `<div class="btnrow"><button class="go" data-open="${r.source_id}">${c.needs_review ? "Review " + c.needs_review + " order" + (c.needs_review === 1 ? "" : "s") : "Open"}</button></div>`}</div>`;
    }
    return h;
  }

  function orderLine(o) {
    const rep = o.reported || {};
    const where = [rep.ship_name, rep.ship_address, rep.ship_city, rep.ship_state, rep.ship_zip].filter(Boolean).join(", ") || "no ship-to in the file";
    return `<div class="ord${S.sel === o.order_key ? " on" : ""}" data-ord="${esc(o.order_key)}" tabindex="0" role="button">
      <div class="row1"><span><b>Order ${esc(o.order_number || o.order_key)}</b> · ${esc(rep.company || "—")}</span><span class="chip c-${esc(o.status)}">${esc(ST[o.status])}</span></div>
      <div class="hint">${o.lines} line${o.lines === 1 ? "" : "s"} · ${money(o.amount)} · ships to: ${esc(where)}</div>
      ${o.status === "needs_review" ? `<div class="why">${esc(REASON[o.reason] || o.reason)}</div>` : `<div class="hint">→ <b>${esc(o.dealer || o.dealer_id)}</b> · ${esc(BASIS[o.basis] || o.basis || "")}</div>`}
    </div>`;
  }

  function reportHtml() {
    if (!S.rep) return `<div class="msg">Reading the report…</div>`;
    if (S.rep.error) return `<div class="err">${esc(S.rep.error)}</div><div class="btnrow"><button class="go sec" data-back="1">Back to reports</button></div>`;
    const R = S.rep.report, c = R.counts;
    let h = `<div class="card2"><div class="hd"><div class="ttl">${esc(R.title || R.file_name)}</div><span class="chip c-${esc(R.review_status)}">${esc(ST[R.review_status])}</span></div>
      <div class="grid"><div><b>Orders</b>${c.orders}</div><div><b>Need review</b>${c.needs_review}</div><div><b>Corrected</b>${c.corrected}</div><div><b>Resolved</b>${c.resolved}</div>
      <div><b>Amount needing review</b>${money(R.totals.amount_needing_review)}</div></div>
      <div class="btnrow"><button class="go sec" data-back="1">All reports</button><button class="go sec" data-export="1">Download corrected report (CSV)</button><button class="go sec" data-icheck="1">Import check (read-only)</button></div>
      ${S.check ? checkHtml(S.check) : ""}
      ${S.msg ? `<div class="okm">${esc(S.msg)}</div>` : ""}${S.err && !S.sel ? `<div class="err">${esc(S.err)}</div>` : ""}</div>`;
    const sel = S.rep.orders.find(o => o.order_key === S.sel);
    h += `<div class="split"><div>${S.rep.orders.map(orderLine).join("")}</div><div>${sel ? panelHtml(sel) : `<div class="panel"><div class="empty">${c.needs_review ? "Choose an order on the left." : "Every order has a branch. This report is ready."}</div></div>`}</div></div>`;
    return h;
  }

  // Phase D: the read-only import check — strict Ship-To + overlays → MI-1a dry run. Nothing is imported from here.
  const LANE = { sales_report: "Sales report", commission: "Commission", other: "Other" };
  function checkHtml(c) {
    if (c.loading) return `<div class="msg">Checking — nothing is written…</div>`;
    if (c.error) return `<div class="err">${esc(c.error)}</div>`;
    const v = c.verdict, o = (c.v2 && c.v2.orders) || {};
    const ai = c.auto_import || {};
    const autoWord = !ai.installed ? "Automatic import is not installed yet." : ai.switch_on ? "Automatic import is ON for enrolled manufacturers." : "Automatic import is OFF (switch mi_auto_import).";
    let h = `<div class="note"><b>Import check — read only.</b> ${esc(autoWord)} ${v.eligible ? "<b>Every check passes</b> — eligible for import." : v.approvable ? "<b>Needs your approval</b> — only approvable exceptions remain." : "<b>Not eligible</b> for import yet."}</div>`;
    if (c.v2 && !c.v2.refused) h += `<div class="grid"><div><b>New orders</b>${o.new || 0}</div><div><b>Already recorded, unchanged</b>${o.unchanged || 0}</div><div><b>Would change</b>${o.changed || 0}</div><div><b>Retire</b>${o.retire || 0}</div>
      <div><b>Cross-lane matches</b>${c.v2.cross_lane_matches || 0}</div><div><b>Sales</b>${money(c.plan.totals.amount)}</div><div><b>Commission</b>${money(c.plan.totals.commission)}${c.rate && c.rate.rate ? " @ " + Math.round(c.rate.rate * 1000) / 10 + "%" : ""}</div></div>`;
    if (v.blockers.length) h += `<div class="err"><b>Blocked by</b><ul>${v.blockers.map(b => `<li>${esc(b.text)}</li>`).join("")}</ul></div>`;
    if ((v.approvals || []).length) {
      h += `<div class="note"><b>Needs your approval</b> (financial exceptions — only the President approves, for this exact plan)<ul>${v.approvals.map(b => `<li>${esc(b.text)}</li>`).join("")}</ul></div>`;
      if (ai.open_approval) h += `<div class="note">An approval is already open for this file (#${esc(ai.open_approval.id)}, ${esc(ai.open_approval.actor)}).</div>`;
      const can = ai.installed && ai.switch_on && v.approvable;
      h += `<div class="panel"><label for="aprs">Reason for approving this import (required)</label><textarea id="aprs" rows="2"></textarea>
        <div class="btnrow"><button class="go" id="aprgo" ${can ? "" : "disabled"}>Approve &amp; import this plan</button></div>
        <div class="hint">${can ? `Imports exactly what is shown above (plan ${esc(String(c.plan_hash || "").slice(0, 12))}…) in one MI-1a transaction, links it to the registered file and logs it. If anything differs from this check, it is rolled back.` : esc(!ai.installed ? "Not available until the Phase E tables are installed." : !ai.switch_on ? "Not available while automatic import (mi_auto_import) is OFF." : "Not available: blockers remain.")}</div>
        ${S.aprMsg ? `<div class="${S.aprOk ? "okm" : "err"}">${esc(S.aprMsg)}</div>` : ""}</div>`;
    }
    if (v.cautions.length) h += `<div class="note"><b>Notes</b><ul>${v.cautions.map(b => `<li>${esc(b.text)}</li>`).join("")}</ul></div>`;
    if (c.plan.orders.length) h += `<div class="scroll"><table class="tbl"><thead><tr><th>Order</th><th>Date</th><th>HCPS branch</th><th>Basis</th><th>Sales</th><th>Commission</th><th>Already in HCPS</th></tr></thead><tbody>${c.plan.orders.map(r =>
      `<tr><td>${esc(r.order_number)}</td><td>${esc(r.date)}</td><td>${esc(r.dealer)}</td><td>${esc(BASIS[r.basis] || r.basis)}</td><td>${money(r.amount)}</td><td>${money(r.commission)}</td><td>${r.recorded.length ? r.recorded.map(x => esc(LANE[x.lane] + " " + String(x.period).slice(0, 7))).join(", ") : "—"}</td></tr>`).join("")}</tbody></table></div>`;
    if ((c.quarantined_in_period || []).length) h += `<div class="note"><b>${c.quarantined_in_period.length} quarantined row(s) on file for ${esc(c.months.join(", "))}</b> — that month's quarantined data is never converted into sales automatically.</div>`;
    if (c.quarantined.length) h += `<div class="note"><b>Quarantined rows with these order numbers</b> (kept out of sales; never converted automatically): ${c.quarantined.map(q => esc(q.invoice_no)).join(", ")}</div>`;
    return h;
  }

  function panelHtml(o) {
    const F = S.form || {};
    const rep = o.reported || {};
    const opts = [];
    const seen = new Set();
    for (const s of (o.suggestions || [])) if (!seen.has(s.dealer_id)) { seen.add(s.dealer_id); const cd = o.candidates.find(x => x.dealer_id === s.dealer_id) || {};
      opts.push({ id: s.dealer_id, name: s.name || cd.name, sub: [cd.address, cd.city, cd.state, cd.zip].filter(Boolean).join(", "), tag: { zip: "same ZIP", address: "same street", city: "same city", ship_name: "same name", hq: "headquarters" }[s.basis] || s.basis }); }
    for (const cd of (o.candidates || [])) if (!seen.has(cd.dealer_id)) { seen.add(cd.dealer_id); opts.push({ id: cd.dealer_id, name: cd.name, sub: [cd.address, cd.city, cd.state, cd.zip].filter(Boolean).join(", "), tag: cd.branch ? "branch" : "headquarters" }); }
    for (const sd of (S.search || [])) if (!seen.has(sd.dealer_id)) { seen.add(sd.dealer_id); opts.push({ id: sd.dealer_id, name: sd.name, sub: [sd.parent ? "branch of " + sd.parent : "", sd.address, sd.city, sd.state, sd.zip].filter(Boolean).join(", "), tag: "search", outside: true }); }
    const hq = (o.candidates || []).find(x => !x.branch);
    // Remember (automatic reuse) only with the order's account number on record for the chosen location's family.
    const chosen = F.scope === "corporate" && hq ? hq.dealer_id : F.dealer_id;
    const cRoot = chosen ? (((o.candidates || []).find(x => x.dealer_id === chosen) || (S.search || []).find(x => x.dealer_id === chosen) || {}).root || null) : null;
    const remWhy = !o.ship_key ? "This order has no ship-to id or street + ZIP in the file, so the choice applies to this order only."
      : !rep.account_ref ? "This order has no account number in the file, so the choice applies to this order only (nothing is remembered)."
      : !chosen ? "Choose a location. Remember is offered when the order's account number is on record for that location's dealer family."
      : !(o.remember_roots || []).includes(cRoot) ? `Account ${rep.account_ref} is not on record for this location's dealer family at this manufacturer, so the choice applies to this order only.`
      : "";
    const canRemember = !remWhy;
    return `<div class="panel" id="panel">
      <div class="ttl">Order ${esc(o.order_number || o.order_key)}</div>
      <div class="rep" style="margin-top:8px"><b>What the manufacturer's file says</b><br>
        ${esc(rep.company || "—")}${rep.account_ref ? " · account " + esc(rep.account_ref) : ""}<br>
        Ship to: ${esc([rep.ship_name, rep.ship_address, rep.ship_city, rep.ship_state, rep.ship_zip].filter(Boolean).join(", ") || "—")}<br>
        Bill to: ${esc([rep.bill_address, rep.bill_city, rep.bill_state, rep.bill_zip].filter(Boolean).join(", ") || "—")}<br>
        ${o.lines} line${o.lines === 1 ? "" : "s"} (file rows ${esc(o.file_lines.join(", "))}) · ${money(o.amount)} · ${esc(o.date || "")}</div>
      ${o.status === "needs_review" ? `<div class="why" style="margin-top:8px;color:#7a4a00">${esc(REASON[o.reason] || o.reason)}</div>` : `<div class="hint" style="margin-top:8px">Now: <b>${esc(o.dealer)}</b> — ${esc(BASIS[o.basis] || o.basis)}</div>`}
      <div style="margin-top:10px;font-weight:700;font-size:13px">Which HCPS location received it?</div>
      ${opts.map(x => `<label class="opt${F.dealer_id === x.id ? " sel" : ""}"><input type="radio" name="dl" value="${esc(x.id)}" ${F.dealer_id === x.id ? "checked" : ""} data-outside="${x.outside ? 1 : 0}">
        <span><b>${esc(x.name)}</b> <span class="chip c-empty">${esc(x.tag)}</span><br><span class="sub2">${esc(x.sub)}</span></span></label>`).join("") || `<div class="empty">No dealer matched — search below.</div>`}
      <input type="search" id="dsearch" placeholder="Search other HCPS dealers / branches (name, city, ZIP)" value="${esc(F.q || "")}" style="margin-top:6px">
      ${hq ? `<label class="opt${F.scope === "corporate" ? " sel" : ""}"><input type="checkbox" id="corp" ${F.scope === "corporate" ? "checked" : ""}><span>Confirmed corporate / drop-ship sale — book it to <b>${esc(hq.name)}</b> (headquarters)</span></label>` : ""}
      <div style="margin-top:10px;font-weight:700;font-size:13px">Missing or wrong ship-to details <span class="hint">(optional — kept beside the file's values)</span></div>
      <div class="f">
        <div class="wide"><label for="fs_name">Ship-to name</label><input id="fs_name" value="${esc(F.ship_name || "")}"></div>
        <div class="wide"><label for="fs_addr">Street</label><input id="fs_addr" value="${esc(F.ship_address || "")}"></div>
        <div><label for="fs_city">City</label><input id="fs_city" value="${esc(F.ship_city || "")}"></div>
        <div><label for="fs_state">State</label><input id="fs_state" value="${esc(F.ship_state || "")}"></div>
        <div><label for="fs_zip">ZIP</label><input id="fs_zip" inputmode="numeric" value="${esc(F.ship_zip || "")}"></div>
        <div class="wide"><label for="fs_reason">Reason (required)</label><input id="fs_reason" value="${esc(F.reason || "")}" placeholder="e.g. Princeton store — confirmed with the dealer"></div>
      </div>
      <label class="opt" style="margin-top:8px"><input type="checkbox" id="remember" ${canRemember ? (F.remember !== false ? "checked" : "") : "disabled"}>
        <span>${canRemember ? "Remember: future orders from this account to this ship-to go to this location automatically" : esc(remWhy)}</span></label>
      ${F.outside ? `<label class="opt"><input type="checkbox" id="confout" ${F.confirm_outside ? "checked" : ""}><span>The chosen location is outside the dealer family this account matched — I confirm it.</span></label>` : ""}
      ${F.conflict ? `<label class="opt"><input type="checkbox" id="replmap" ${F.replace ? "checked" : ""}><span>This ship-to is already mapped to another location — replace that mapping (the old one is kept, retired).</span></label>` : ""}
      <div class="btnrow"><button class="go" id="save" ${S.busy ? "disabled" : ""}>Save &amp; Continue</button><button class="go sec" id="skip">Next order</button></div>
      ${S.err ? `<div class="err" role="alert">${esc(S.err)}</div>` : ""}
      ${o.versions && o.versions.length ? `<div class="ver"><b>Earlier decisions</b>${o.versions.map(v => `<div>v${v.version} · ${esc(v.dealer || v.dealer_id)}${v.scope === "corporate" ? " (corporate)" : ""} · ${esc(v.actor.replace(/^staff:/, ""))} · ${esc(fmtWhen(v.created_at))} — ${esc(v.reason)}</div>`).join("")}</div>` : ""}
    </div>`;
  }

  function mapsHtml() {
    let h = `<div class="note">A verified mapping remembers one ship-to of one account: manufacturer + account number + the manufacturer's ship-to id (or street + ZIP as the report prints it). It is never "this account → one branch". Retiring one stops it matching future orders; past decisions stay.</div>
      <div class="btnrow" style="margin-bottom:10px"><input type="search" id="mapmfr" value="${esc(S.mapsMfr)}" style="flex:1 1 220px;padding:8px 9px;border:1px solid var(--line);border-radius:8px"><button class="go" id="mapload">Show</button></div>`;
    if (!S.maps) return h + `<div class="msg">Loading…</div>`;
    if (S.maps.error) return h + `<div class="err">${esc(S.maps.error)}</div>`;
    if (!S.maps.length) return h + `<div class="empty">No verified mappings for this manufacturer yet.</div>`;
    return h + `<div class="scroll"><table class="tbl"><thead><tr><th>Account</th><th>Ship-to</th><th>Location</th><th>Verified</th><th></th></tr></thead><tbody>${S.maps.map(m => `<tr>
      <td>${esc(m.account_ref || "—")}</td><td>${esc(m.ship_key.replace(/^addr:/, "").replace(/^id:/, "ship-to id "))}</td><td>${esc(m.dealer)}${m.scope === "corporate" ? " (corporate)" : ""}</td>
      <td>${esc((m.verified_by || "").replace(/^staff:/, ""))}<br><span class="hint">${esc(fmtWhen(m.verified_at))}</span></td>
      <td>${m.retired_at ? `<span class="chip c-empty">Retired</span><div class="hint">${esc(m.retire_reason)}</div>` : `<button class="go sec" data-retire="${m.id}">Retire</button>`}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function shadowHtml() {
    let h = `<div class="note">Read-only. Takes orders HCPS already booked (Sales Report Import and commission history, including hand-corrected reports) and runs them through the strict rules the automated import will use. <b>Same</b> = the rules agree with history; <b>Held</b> = the rules would ask a person (history often used the headquarters fallback); <b>Different</b> = the rules would pick another branch than history — each must be explained before automation.</div>
      <div class="btnrow" style="margin-bottom:10px"><select id="shmfr" style="padding:8px 9px;border:1px solid var(--line);border-radius:8px;min-height:44px"><option value="strongback-mobility">Strongback Mobility</option><option value="bemis">Bemis</option></select><button class="go" id="shrun">Run shadow check</button></div>`;
    if (!S.shadow) return h;
    if (S.shadow.error) return h + `<div class="err">${esc(S.shadow.error)}</div>`;
    const x = S.shadow.shadow;
    const LN = { sales_report: "Sales report lines", commission: "Commission lines", other: "Other sources" };
    h += `<div class="card2"><div class="grid"><div><b>History rows</b>${S.shadow.rows}</div><div><b>Orders</b>${x.orders}</div><div><b>Same</b>${x.same}</div><div><b>Held</b>${x.held}</div><div><b>Different</b>${x.different}</div><div><b>Lane disagreements</b>${x.lane_disagreements || 0}</div></div>
      <div class="hint" style="margin-top:6px">Lanes are kept apart: sales-report lines (source sales_report) and commission lines (source commission, or older rows with no source and no reference) are separate transactions and never added together. The branch HCPS booked is the baseline; nothing is changed.</div></div>`;
    if (x.by_lane) h += `<div class="scroll"><table class="tbl" style="margin-bottom:12px"><thead><tr><th>Lane</th><th>Lines</th><th>Orders</th><th>Same</th><th>Held</th><th>Different</th><th>Unmatched in history</th><th>Split in history</th></tr></thead><tbody>${
      Object.keys(LN).filter(k => x.by_lane[k] && x.by_lane[k].lines).map(k => { const L = x.by_lane[k]; return `<tr><td><b>${LN[k]}</b></td><td>${L.lines}</td><td>${L.orders}</td><td>${L.same}</td><td>${L.held}</td><td>${L.different}</td><td>${L.unmatched_history}</td><td>${L.mixed_history}</td></tr>`; }).join("")
      || `<tr><td colspan="8">No history for this manufacturer.</td></tr>`}</tbody></table></div>`;
    if ((x.lane_disagreement_list || []).length) h += `<div class="note">The same invoice is booked to different locations in different lanes: ${x.lane_disagreement_list.slice(0, 20).map(d => esc(String(d.txn).replace("|", " · ")) + " (" + Object.entries(d.booked).map(([k, v]) => esc(LN[k] || k) + ": " + esc(v.name || v.dealer_id)).join("; ") + ")").join(" · ")}</div>`;
    if (x.list.length) h += `<div class="scroll"><table class="tbl"><thead><tr><th>Outcome</th><th>Lane</th><th>Order</th><th>Company</th><th>Ship-to</th><th>History (baseline)</th><th>Rules</th></tr></thead><tbody>${x.list.map(r => `<tr>
      <td><span class="chip c-${r.outcome === "different" ? "held" : "empty"}">${esc(r.outcome)}</span></td><td>${esc(LN[r.lane] || r.lane || "")}</td><td>${esc(r.period || "")} · ${esc(r.invoice || r.key)}</td><td>${esc(r.company)}</td><td>${esc([r.ship_city, r.ship_zip].filter(Boolean).join(" ") || "—")}</td>
      <td>${esc(r.booked_name || "—")}</td><td>${esc(r.strict_name || r.basis || "")}</td></tr>`).join("")}</tbody></table></div>`;
    return h;
  }

  function readForm() {
    const v = id => { const el = $("#" + id); return el ? el.value : ""; };
    const f = S.form || {};
    const r = document.querySelector('input[name="dl"]:checked');
    if (r) { f.dealer_id = r.value; f.outside = r.getAttribute("data-outside") === "1"; }
    f.ship_name = v("fs_name"); f.ship_address = v("fs_addr"); f.ship_city = v("fs_city"); f.ship_state = v("fs_state"); f.ship_zip = v("fs_zip"); f.reason = v("fs_reason");
    const corp = $("#corp"); f.scope = corp && corp.checked ? "corporate" : "branch";
    const rem = $("#remember"); if (rem && !rem.disabled) f.remember = rem.checked;   // a disabled box keeps the person's last choice
    f.rememberNow = !!(rem && !rem.disabled && rem.checked);
    const co = $("#confout"); f.confirm_outside = !!(co && co.checked);
    const rp = $("#replmap"); f.replace = !!(rp && rp.checked);
    const q = $("#dsearch"); f.q = q ? q.value : "";
    S.form = f; return f;
  }

  function selectOrder(k) {
    S.sel = k; S.err = ""; S.search = [];
    const o = S.rep.orders.find(x => x.order_key === k);
    const v0 = o && o.versions && o.versions[0];
    S.form = { dealer_id: o && o.status !== "needs_review" ? o.dealer_id : null, scope: v0 && v0.scope === "corporate" ? "corporate" : "branch",
      ship_name: v0 ? v0.ship_name || "" : "", ship_address: v0 ? v0.ship_address || "" : "", ship_city: v0 ? v0.ship_city || "" : "", ship_state: v0 ? v0.ship_state || "" : "", ship_zip: v0 ? v0.ship_zip || "" : "" };
    render();
    const p = $("#panel"); if (p && window.innerWidth <= 900) p.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function save() {
    const f = readForm(); const o = S.rep.orders.find(x => x.order_key === S.sel); if (!o) return;
    S.err = ""; S.msg = "";
    if (f.scope === "corporate") { const hq = o.candidates.find(x => !x.branch); if (hq) f.dealer_id = hq.dealer_id; }
    if (!f.dealer_id) { S.err = "Choose the HCPS location first."; render(); return; }
    if (!f.reason || f.reason.trim().length < 3) { S.err = "Give a short reason."; render(); return; }
    S.busy = true; render();
    const r = await api({ action: "correct", source_id: S.src, order_key: o.order_key, dealer_id: f.dealer_id, scope: f.scope, ship_name: f.ship_name, ship_address: f.ship_address,
      ship_city: f.ship_city, ship_state: f.ship_state, ship_zip: f.ship_zip, reason: f.reason, expected_version: o.current_version || 0, remember: f.rememberNow,
      replace_mapping: f.replace, confirm_outside_family: f.confirm_outside });
    S.busy = false;
    if (r.status === 409 && r.body.error === "outside_family") { f.outside = true; S.err = r.body.message; render(); return; }
    if (r.status === 409 && r.body.error === "shipto_mapping_conflict") { f.conflict = true; S.err = "This ship-to is already mapped to another location. Tick “replace” to change it, or untick Remember."; render(); return; }
    if (r.status !== 200) { S.err = (r.body && (r.body.message || r.body.error)) || ("HTTP " + r.status); render(); return; }
    S.msg = `Saved (version ${r.body.saved.version}${r.body.saved.mapping && r.body.saved.mapping !== "none" ? ", mapping " + r.body.saved.mapping : ""}). ${r.body.report.counts.needs_review} order${r.body.report.counts.needs_review === 1 ? "" : "s"} still need review.`;
    await openReport(S.src, r.body.next_order_key);
  }

  async function openReport(id, sel) {
    if (S.src !== id) S.check = null;
    S.view = "report"; S.src = id; if (!sel) { S.rep = null; render(); }
    const r = await api({ action: "report", source_id: id });
    S.rep = r.status === 200 ? r.body : { error: (r.body && (r.body.message || r.body.error)) || ("HTTP " + r.status) };
    if (S.rep && !S.rep.error) { const first = sel || (S.rep.orders.find(o => o.status === "needs_review") || {}).order_key; if (first) { selectOrder(first); return; } else S.sel = null; }
    render();
  }

  function wire() {
    document.querySelectorAll("[data-tab]").forEach(b => b.onclick = async () => { const k = b.getAttribute("data-tab"); S.view = k; S.msg = S.err = "";
      render(); if (k === "queue") loadQueue(); if (k === "maps") loadMaps(); });
    document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { S.msg = ""; openReport(+b.getAttribute("data-open")); });
    document.querySelectorAll("[data-back]").forEach(b => b.onclick = () => { S.view = "queue"; loadQueue(); });
    document.querySelectorAll("[data-ord]").forEach(d => { const k = d.getAttribute("data-ord"); d.onclick = () => selectOrder(k); d.onkeydown = e => { if (e.key === "Enter") selectOrder(k); }; });
    document.querySelectorAll('input[name="dl"]').forEach(r => r.onchange = () => { readForm(); render(); });
    const corp = $("#corp"); if (corp) corp.onchange = () => { readForm(); render(); };
    const ds = $("#dsearch"); if (ds) { let tm; ds.oninput = () => { clearTimeout(tm); tm = setTimeout(async () => { readForm(); const q = ds.value.trim();
      if (q.length < 2) { S.search = []; render(); return; } const r = await api({ action: "dealer_search", q }); S.search = r.status === 200 ? r.body.dealers : []; render();
      const d2 = $("#dsearch"); if (d2) { d2.focus(); d2.setSelectionRange(d2.value.length, d2.value.length); } }, 300); }; }
    const sv = $("#save"); if (sv) sv.onclick = save;
    const sk = $("#skip"); if (sk) sk.onclick = () => { const list = S.rep.orders; const i = list.findIndex(o => o.order_key === S.sel); const n = list[(i + 1) % list.length]; if (n) selectOrder(n.order_key); };
    const ex = document.querySelector("[data-export]"); if (ex) ex.onclick = async () => { const r = await api({ action: "export", source_id: S.src });
      if (r.status !== 200) { S.err = r.body.message || r.body.error; render(); return; }
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([r.body.csv], { type: "text/csv" })); a.download = r.body.file_name; document.body.appendChild(a); a.click(); a.remove(); };
    const ic = document.querySelector("[data-icheck]"); if (ic) ic.onclick = async () => { S.check = { loading: true }; render();
      const r = await api({ action: "import_check", source_id: S.src });
      S.check = r.status === 200 ? r.body : { error: (r.body && (r.body.message || r.body.error)) || ("HTTP " + r.status) }; render(); };
    const ag = $("#aprgo"); if (ag) ag.onclick = async () => {
      const reason = ($("#aprs").value || "").trim(); if (reason.length < 10) { S.aprOk = false; S.aprMsg = "Give the reason (10+ characters)."; render(); return; }
      ag.disabled = true;
      const r = await api({ action: "approve_import", source_id: S.src, plan_hash: S.check.plan_hash, reason });
      S.aprOk = r.status === 200; S.aprMsg = r.status === 200 ? `Imported — batch ${r.body.batch_id}.` : ((r.body && (r.body.message || r.body.error || r.body.outcome)) || ("HTTP " + r.status));
      const again = await api({ action: "import_check", source_id: S.src }); if (again.status === 200) S.check = again.body; render(); };
    const ml = $("#mapload"); if (ml) ml.onclick = () => { S.mapsMfr = ($("#mapmfr").value || "").trim(); loadMaps(); };
    document.querySelectorAll("[data-retire]").forEach(b => b.onclick = async () => {
      const row = b.closest("td"); row.innerHTML = `<input id="rr${b.getAttribute("data-retire")}" placeholder="Reason" style="padding:8px;border:1px solid var(--line);border-radius:8px;min-height:40px"><button class="go sec" id="rg${b.getAttribute("data-retire")}">Retire</button>`;
      const id = b.getAttribute("data-retire"); $("#rg" + id).onclick = async () => { const rs = $("#rr" + id).value; const r = await api({ action: "retire_mapping", mapping_id: +id, reason: rs || "" });
        if (r.status !== 200) { row.insertAdjacentHTML("beforeend", `<div class="err">${esc(r.body.message || r.body.error)}</div>`); return; } loadMaps(); }; });
    const sr = $("#shrun"); if (sr) sr.onclick = async () => { S.shadow = null; render(); $("#body").insertAdjacentHTML("beforeend", `<div class="msg">Running…</div>`);
      const mfr = ($("#shmfr") || {}).value || "strongback-mobility"; const r = await api({ action: "shadow", manufacturer: mfr });
      S.shadow = r.status === 200 ? r.body : { error: (r.body && (r.body.message || r.body.error)) || ("HTTP " + r.status) }; render(); const s2 = $("#shmfr"); if (s2) s2.value = mfr; };
  }

  async function loadQueue() { S.queue = null; render(); const r = await api({ action: "queue" });
    if (r.status === 401) { gate(); return; }
    if (r.status === 403) { $("#body").innerHTML = `<div class="err">${esc(r.body.message || "Ship-To review is for President / Admin.")}</div>`; return; }
    S.queue = r.status === 200 ? r.body : { error: (r.body && (r.body.message || r.body.error)) || ("HTTP " + r.status) }; render(); }
  async function loadMaps() { S.maps = null; render(); const r = await api({ action: "mappings", manufacturer: S.mapsMfr });
    S.maps = r.status === 200 ? r.body.mappings : { error: (r.body && (r.body.message || r.body.error)) || ("HTTP " + r.status) }; render(); }

  async function boot() { if (!TOKEN) { gate(); return; } await loadQueue(); }
  boot();
})();

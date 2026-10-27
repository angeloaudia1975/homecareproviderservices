/* Catalog Exceptions (2026-10-26) — page script. catalog-api "catalog_exceptions" (President, read-only) plus the
   Batch 2 bulk corrections: correction_plan (preview), correction_apply (dry run = validate, then record) and
   correction_undo. Shows codes and counts only, never a price. No inline script (strict CSP safe). */
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let TOKEN = (window.HCPS && HCPS.token && HCPS.token()) || "";
  window.addEventListener("hcps-token", e => { try { TOKEN = e.detail; } catch (_) {} });
  let Q = null, SEL = null, CAT = "", BLOCKERS = false, FIND = "";
  let MODE = "queue", PLAN = null, PICK = new Set(), VALID = null, PF = { manufacturers: [], categories: [], codes: "" }, PMSG = "";
  const STATUS = { gold_standard: "Gold Standard", blocked: "Blocked", in_progress: "In progress", partial_measurement: "Partly measured", no_data: "No data" };
  const TOOL = { pricing: ["Manufacturer Center", l => "/admin/manufacturer-center.html#line=" + encodeURIComponent(l)],
    sku: ["Product Catalog", () => "/admin/catalog.html"], units: ["Manufacturer Center", l => "/admin/manufacturer-center.html#line=" + encodeURIComponent(l)],
    content: ["Product Content Enrichment", () => "/admin/product-content-review.html"], images: ["Product Images", () => "/admin/images.html"],
    freight: ["Manufacturer Center", l => "/admin/manufacturer-center.html#line=" + encodeURIComponent(l)],
    retired: ["Product Catalog", () => "/admin/catalog.html"], ready: ["Manufacturer Center", l => "/admin/manufacturer-center.html#line=" + encodeURIComponent(l)] };

  async function api(p) {
    const r = await fetch("/.netlify/functions/catalog-api", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: JSON.stringify(p) });
    let body = {}; try { body = await r.json(); } catch (e) {}
    return { status: r.status, body };
  }
  function gate(msg) {
    $("#body").innerHTML = `<div class="gate"><h2>Staff sign-in</h2><p class="hint">Sign in with your work email and password.</p><input id="lemail" type="email" placeholder="Email" autocomplete="username" style="width:100%;margin:0 0 8px"><input id="lpass" type="password" placeholder="Password" autocomplete="current-password" style="width:100%;margin:0 0 12px"><button class="go" id="lgo">Sign in</button><div class="err">${esc(msg || "")}</div></div>`;
    $("#lgo").onclick = submit; $("#lpass").onkeydown = e => { if (e.key === "Enter") submit(); };
  }
  async function submit() {
    const email = ($("#lemail").value || "").trim(), password = $("#lpass").value || "";
    try { const r = await fetch("/.netlify/functions/staff-auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "login", email, password }) });
      const j = await r.json().catch(() => ({})); if (!j || !j.ok) { gate((j && j.message) || "Could not sign in."); return; }
      HCPS.setSession(j); TOKEN = j.token; boot();
    } catch (e) { gate("Could not reach the server. Try again."); }
  }

  const visibleLines = () => (Q.lines || []).filter(l => (!FIND || (l.name + " " + l.slug).toLowerCase().includes(FIND))
    && (!CAT || l.counts[CAT] > 0) && (!BLOCKERS || l.blockers > 0));
  const catLabel = k => (Q.categories.find(c => c.key === k) || {}).label || k;

  function render() {
    const tiles = Q.categories.map(c => `<button class="tile${c.key === "ready" ? " ready" : ""}${CAT === c.key ? " on" : ""}" data-cat="${c.key}" aria-pressed="${CAT === c.key}"><div class="n">${Q.totals[c.key] || 0}</div><div class="l">${esc(c.label)}</div></button>`).join("");
    const lines = visibleLines();
    const cards = lines.map(l => {
      const cn = Q.categories.filter(c => l.counts[c.key] > 0).map(c => `<span class="cnt ${c.key === "ready" ? "ok" : "hot"}">${esc(c.label.split(/[ /]/)[0])} ${l.counts[c.key]}</span>`).join("");
      return `<button class="ln${SEL === l.slug ? " on" : ""}" data-line="${esc(l.slug)}"><div class="row1"><span class="ttl">${esc(l.name)}</span><span>
        ${l.frozen ? '<span class="chip c-frozen">Frozen · read-only</span> ' : ""}${l.gold_standard ? '<span class="chip c-gold">Gold Standard</span> ' : ""}
        ${l.blockers ? `<span class="chip c-blocker">${l.blockers} blocker${l.blockers > 1 ? "s" : ""}</span>` : ""}</span></div>
        <div class="hint">${esc(STATUS[l.status] || l.status)}${l.completion != null ? " · stage average " + l.completion + "%" : ""}</div>
        <div class="cnts">${cn || '<span class="cnt">No open exceptions</span>'}</div></button>`;
    }).join("") || `<div class="empty">No line matches this filter.</div>`;
    $("#body").innerHTML = `<div class="note">${Q.lines.length} manufacturer lines · generated ${esc(new Date(Q.generated).toLocaleString())}. Counts are part numbers or pages per check. Click a category to filter; click a line for its details.</div>
      <div class="tiles">${tiles}</div>
      <div class="bar"><input type="search" id="find" placeholder="Find a manufacturer" value="${esc(FIND)}" aria-label="Find a manufacturer">
        <label><input type="checkbox" id="blk" ${BLOCKERS ? "checked" : ""}> Blockers only</label>
        <button class="sec" id="clr">Clear filters</button><button class="sec" id="csv">Download CSV</button><button class="sec" id="rf">Refresh</button>
        <button class="sec pri" id="bulk">Bulk corrections →</button></div>
      <div class="split"><div>${cards}</div><div class="panel" id="panel">${panel()}</div></div>`;
    $("#bulk").onclick = () => { MODE = "bulk"; PF.manufacturers = SEL ? [SEL] : []; PF.categories = CAT ? [CAT] : []; renderBulk(); };
    document.querySelectorAll(".tile").forEach(b => b.onclick = () => { CAT = CAT === b.dataset.cat ? "" : b.dataset.cat; render(); });
    document.querySelectorAll(".ln").forEach(b => b.onclick = () => { SEL = b.dataset.line; render(); });
    $("#find").oninput = e => { FIND = e.target.value.trim().toLowerCase(); const p = e.target.selectionStart; render(); const f = $("#find"); f.focus(); try { f.setSelectionRange(p, p); } catch (_) {} };
    $("#blk").onchange = e => { BLOCKERS = e.target.checked; render(); };
    $("#clr").onclick = () => { CAT = ""; BLOCKERS = false; FIND = ""; render(); };
    $("#csv").onclick = csv; $("#rf").onclick = load;
  }
  function panel() {
    const l = (Q.lines || []).find(x => x.slug === SEL);
    if (!l) return `<div class="empty">Choose a manufacturer to see its exceptions.</div>`;
    const cats = Q.categories.filter(c => !CAT || c.key === CAT).map(c => {
      const items = l.items.filter(x => x.cat === c.key && (!BLOCKERS || x.severity === "blocker"));
      if (!items.length) return "";
      const tool = TOOL[c.key];
      return `<div class="cat"><h3>${esc(c.label)}</h3>${items.map(x => `<div class="ex"><span class="chip c-${esc(x.severity)}">${esc(x.severity)}</span> <b>${esc(x.check.replace(/_/g, " "))}</b>${x.count ? ` · ${x.count}` : ""}
        <div class="d">${esc(x.detail)}</div>${x.codes ? `<div class="codes">${x.codes.map(esc).join(", ")}${x.count > x.codes.length ? " …" : ""}</div>` : ""}
        ${x.reviews ? `<div class="hint">Review recorded for ${Object.keys(x.reviews).length} of ${x.count || x.codes.length} (still counted until a photo with rights is placed): ${Object.entries(x.reviews).map(([c, v]) => esc(c) + " — " + esc(String(v).replace(/_/g, " "))).join(", ")}</div>` : ""}</div>`).join("")}
        ${tool && !l.frozen ? `<div class="acts"><a href="${esc(tool[1](l.slug))}">Open ${esc(tool[0])}</a></div>` : ""}</div>`;
    }).join("");
    return `<div class="ttl">${esc(l.name)}</div><div class="hint">${esc(l.slug)} · ${esc(STATUS[l.status] || l.status)}</div>
      ${l.frozen ? `<div class="note" style="margin-top:8px">Gold Standard line — frozen. Any change goes through a recorded regression fix in Manufacturer Center; nothing is changed from this queue.</div>` : ""}
      ${cats || `<div class="empty" style="margin-top:8px">No exceptions${CAT ? " in " + esc(catLabel(CAT)) : ""}.</div>`}`;
  }
  /* ---------------- Bulk corrections (Batch 2) ---------------- */
  const KIND = { duplicate_classification: "Duplicate review", image_status: "Photo review status", handoff: "Owning tool", frozen_line: "Frozen line" };
  const BLOCK = { owner_decision: "Needs the owner's decision", frozen: "Frozen — regression fix only", owning_tool: "Fix in the owning tool", already_recorded: "Already recorded" };
  function renderBulk() {
    const mf = (Q.lines || []).map(l => `<label class="pick"><input type="checkbox" data-pm="${esc(l.slug)}" ${PF.manufacturers.includes(l.slug) ? "checked" : ""}> ${esc(l.name)}${l.frozen ? " (frozen)" : ""}</label>`).join("");
    const cf = Q.categories.filter(c => c.key !== "ready").map(c => `<label class="pick"><input type="checkbox" data-pc="${c.key}" ${PF.categories.includes(c.key) ? "checked" : ""}> ${esc(c.label)}</label>`).join("");
    let list = "";
    if (PLAN) {
      const c = PLAN.counts;
      list = `<div class="note">${c.total} proposal(s) · <b>${c.applicable} can be recorded here</b> (${c.affected_skus} part number(s)) · ${c.owner_decision} need your decision · ${c.handoff} belong to another tool · ${c.frozen} on frozen lines · ${c.already_recorded} already recorded.
        ${PLAN.outside_filter && PLAN.outside_filter.applicable ? `<br><b>${PLAN.outside_filter.applicable} more can be recorded outside this filter</b> (${Object.entries(PLAN.outside_filter.by_manufacturer).map(([m, n]) => esc(m) + " " + n).join(", ")}) — clear the filter to see them.` : ""}
        Recording a review changes nothing a dealer sees: no price, catalog row, page or photo is written, nothing is deleted.</div>
        <div class="bar"><button class="sec" id="selall">Select all applicable</button><button class="sec" id="selnone">Clear selection</button><span class="hint">${PICK.size} selected</span></div>
        ${PLAN.proposals.map(p => `<div class="prop${p.supported ? "" : " off"}">
          <div class="row1"><label class="pick big">${p.supported ? `<input type="checkbox" data-pp="${esc(p.id)}" ${PICK.has(p.id) ? "checked" : ""}>` : ""}
            <span class="ttl">${esc(p.manufacturer)} · ${esc((p.codes || []).slice(0, 6).join(", ") || p.id.split(":").pop())}${(p.codes || []).length > 6 ? " …" : ""}</span></label>
            <span><span class="chip c-info">${esc(KIND[p.kind] || p.kind)}</span> <span class="chip ${p.supported ? "c-ok" : "c-warn"}">${p.supported ? "Can record" : esc(BLOCK[p.blocked] || p.blocked)}</span></span></div>
          <div class="kv"><span>Category</span><b>${esc(catLabel(p.cat))}</b><span>Affected</span><b>${p.affected} part number(s)</b>
            <span>Original</span><b>${esc(p.original)}</b><span>Proposed</span><b>${esc(p.proposed)}</b></div>
          <div class="codes">${(p.evidence || []).map(esc).join("<br>")}</div>
          ${p.current ? `<div class="hint">Current review: ${esc(p.current.status)} by ${esc(p.current.by || "")} (decision #${p.current.decision_id})</div>` : ""}
          <div class="acts"><a href="${esc(p.href)}">Open ${esc(p.tool)}</a></div></div>`).join("") || `<div class="empty">Nothing to correct for this filter.</div>`}`;
    }
    const valid = VALID ? `<div class="note"><b>Validated — ${VALID.decisions.length} review decision(s) will be recorded:</b><div class="codes">${VALID.decisions.map(d => esc(d.manufacturer + " · " + d.code + " → " + (d.hcps_value.classification || d.hcps_value.status))).join("<br>")}</div></div>` : "";
    const recorded = PLAN && PLAN.recorded && PLAN.recorded.length ? `<div class="cat"><h3>Recorded corrections (latest first) — undo records a superseding “reopened” decision</h3>
      ${PLAN.recorded.slice(0, 40).map(r => `<div class="ex"><b>#${r.id}</b> ${esc(r.manufacturer)} · ${esc(r.code)} · ${esc(r.field.replace("catalog:", ""))} → ${esc(r.status)} <span class="hint">${esc(r.by || "")} · ${esc(r.at ? new Date(r.at).toLocaleString() : "")}</span>
        ${r.status !== "reopened" ? `<button class="sec small" data-undo="${r.id}">Undo</button>` : ""}</div>`).join("")}</div>` : "";
    $("#body").innerHTML = `<div class="bar"><button class="sec" id="back">← Back to the queue</button></div>
      <div class="note"><b>Bulk corrections.</b> Choose manufacturers, categories or part numbers, preview the plan, validate it, then record the selected reviews with a reason.
      Frozen Gold Standard lines, prices, units, content and photos are never changed here — those rows link to the tool that owns them.</div>
      <div class="cat"><h3>Manufacturers</h3><div class="picks">${mf}</div></div>
      <div class="cat"><h3>Categories</h3><div class="picks">${cf}</div></div>
      <div class="bar" style="margin-top:10px"><input id="pcodes" placeholder="Part numbers (optional, comma separated)" value="${esc(PF.codes)}" aria-label="Part numbers">
        <button class="sec pri" id="prev">Preview plan</button></div>
      ${PMSG ? `<div class="err">${esc(PMSG)}</div>` : ""}
      ${list}
      ${PLAN ? `<div class="bar sticky"><input id="preason" placeholder="Reason for these corrections (required)" aria-label="Reason">
        <button class="sec" id="pval" ${PICK.size ? "" : "disabled"}>Validate selection</button>
        <button class="sec pri" id="papply" ${VALID && PICK.size ? "" : "disabled"}>Record ${PICK.size} correction(s)</button></div>${valid}` : ""}
      ${recorded}`;
    $("#back").onclick = () => { MODE = "queue"; render(); };
    document.querySelectorAll("[data-pm]").forEach(b => b.onchange = () => { toggle(PF.manufacturers, b.dataset.pm, b.checked); });
    document.querySelectorAll("[data-pc]").forEach(b => b.onchange = () => { toggle(PF.categories, b.dataset.pc, b.checked); });
    $("#prev").onclick = () => { PF.codes = $("#pcodes").value; preview(); };
    document.querySelectorAll("[data-pp]").forEach(b => b.onchange = () => { b.checked ? PICK.add(b.dataset.pp) : PICK.delete(b.dataset.pp); VALID = null; keepReason(renderBulk); });
    if (PLAN) {
      $("#selall").onclick = () => { PLAN.proposals.filter(p => p.supported).forEach(p => PICK.add(p.id)); VALID = null; keepReason(renderBulk); };
      $("#selnone").onclick = () => { PICK.clear(); VALID = null; keepReason(renderBulk); };
      $("#pval").onclick = () => apply(true); $("#papply").onclick = () => apply(false);
      if (REASON) $("#preason").value = REASON;
      $("#preason").oninput = e => { REASON = e.target.value; };
    }
    document.querySelectorAll("[data-undo]").forEach(b => b.onclick = () => undo(b.dataset.undo));
  }
  let REASON = "";
  const keepReason = fn => { const r = $("#preason"); if (r) REASON = r.value; fn(); };
  const toggle = (arr, v, on) => { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); };
  const filterBody = () => ({ manufacturers: PF.manufacturers, categories: PF.categories, codes: PF.codes.split(/[,\s]+/).map(x => x.trim()).filter(Boolean) });
  async function preview() {
    PMSG = ""; $("#prev").disabled = true; $("#prev").textContent = "Building the plan…";
    const r = await api(Object.assign({ action: "correction_plan" }, filterBody()));
    if (r.status !== 200 || !r.body.ok) { PMSG = "The plan could not be built: " + (r.body.message || r.body.error || "HTTP " + r.status) + ". Nothing was changed."; PLAN = null; }
    else { PLAN = r.body; PICK = new Set([...PICK].filter(id => PLAN.proposals.some(p => p.id === id && p.supported))); VALID = null; }
    renderBulk();
  }
  async function apply(dry) {
    REASON = ($("#preason").value || "").trim();
    if (REASON.length < 5) { PMSG = "Give a reason (at least 5 characters)."; return renderBulk(); }
    const r = await api(Object.assign({ action: "correction_apply", plan_hash: PLAN.plan_hash, ids: [...PICK], reason: REASON, dry_run: dry }, filterBody()));
    if (r.status !== 200 || !r.body.ok) { PMSG = (r.body.message || r.body.error || "HTTP " + r.status); VALID = null; if (r.body.error === "plan_changed") PLAN = null; return renderBulk(); }
    if (dry) { VALID = r.body; PMSG = ""; return renderBulk(); }
    PMSG = ""; VALID = null; PICK.clear(); REASON = "";
    if (r.body.queue) Q = Object.assign({ categories: Q.categories }, r.body.queue);
    await preview();
    PMSG = "Recorded " + r.body.recorded.length + " correction(s). The queue was recalculated.";
    renderBulk();
  }
  async function undo(id) {
    const why = (($("#preason") && $("#preason").value) || "").trim();
    if (why.length < 5) { PMSG = "Type the reason for the undo in the reason box first (at least 5 characters)."; return renderBulk(); }
    const r = await api({ action: "correction_undo", decision_id: Number(id), reason: why });
    if (r.status !== 200 || !r.body.ok) { PMSG = (r.body.message || r.body.error || "HTTP " + r.status); return renderBulk(); }
    if (r.body.queue) Q = Object.assign({ categories: Q.categories }, r.body.queue);
    REASON = ""; await preview(); PMSG = "Reopened decision #" + id + " (a superseding decision was recorded)."; renderBulk();
  }
  function csv() {
    const rows = [["manufacturer", "category", "severity", "check", "count", "codes_or_pages", "detail"]];
    for (const l of visibleLines()) for (const x of l.items) if (!CAT || x.cat === CAT)
      rows.push([l.slug, catLabel(x.cat), x.severity, x.check, x.count || "", (x.codes || []).join(" "), x.detail]);
    const text = rows.map(r => r.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = "catalog-exceptions-" + new Date().toISOString().slice(0, 10) + ".csv"; document.body.appendChild(a); a.click(); a.remove();
  }
  async function load() {
    $("#body").innerHTML = `<div class="msg">Loading the queue — reading every manufacturer line (up to half a minute)…</div>`;
    const r = await api({ action: "catalog_exceptions" });
    if (r.status === 401) return gate();
    if (r.status === 403) { $("#body").innerHTML = `<div class="empty">Catalog Exceptions is limited to the President.</div>`; return; }
    if (r.status !== 200 || !r.body.ok) { $("#body").innerHTML = `<div class="err">The queue could not be read: ${esc(r.body.message || r.body.error || ("HTTP " + r.status))}. Nothing is shown rather than a partial list.</div>`; return; }
    if (!SEL) { try { const h = new URLSearchParams(String(location.hash || "").replace(/^#/, "")); if (h.get("line")) SEL = h.get("line"); } catch (_) {} }
    Q = r.body; if (SEL && !Q.lines.some(l => l.slug === SEL)) SEL = null;
    if (!SEL) { const first = Q.lines.find(l => l.blockers) || Q.lines[0]; SEL = first && first.slug; }
    MODE === "bulk" ? renderBulk() : render();
  }
  function boot() { if (!TOKEN) return gate(); load(); }
  boot();
})();

/* Catalog Exceptions (2026-10-26) — page script. Read-only: catalog-api "catalog_exceptions" (President). Shows
   codes and counts only, never a price. No inline script (strict CSP safe). */
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let TOKEN = (window.HCPS && HCPS.token && HCPS.token()) || "";
  window.addEventListener("hcps-token", e => { try { TOKEN = e.detail; } catch (_) {} });
  let Q = null, SEL = null, CAT = "", BLOCKERS = false, FIND = "";
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
        <button class="sec" id="clr">Clear filters</button><button class="sec" id="csv">Download CSV</button><button class="sec" id="rf">Refresh</button></div>
      <div class="split"><div>${cards}</div><div class="panel" id="panel">${panel()}</div></div>`;
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
        <div class="d">${esc(x.detail)}</div>${x.codes ? `<div class="codes">${x.codes.map(esc).join(", ")}${x.count > x.codes.length ? " …" : ""}</div>` : ""}</div>`).join("")}
        ${tool && !l.frozen ? `<div class="acts"><a href="${esc(tool[1](l.slug))}">Open ${esc(tool[0])}</a></div>` : ""}</div>`;
    }).join("");
    return `<div class="ttl">${esc(l.name)}</div><div class="hint">${esc(l.slug)} · ${esc(STATUS[l.status] || l.status)}</div>
      ${l.frozen ? `<div class="note" style="margin-top:8px">Gold Standard line — frozen. Any change goes through a recorded regression fix in Manufacturer Center; nothing is changed from this queue.</div>` : ""}
      ${cats || `<div class="empty" style="margin-top:8px">No exceptions${CAT ? " in " + esc(catLabel(CAT)) : ""}.</div>`}`;
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
    Q = r.body; if (!SEL) { const first = Q.lines.find(l => l.blockers) || Q.lines[0]; SEL = first && first.slug; }
    render();
  }
  function boot() { if (!TOKEN) return gate(); load(); }
  boot();
})();

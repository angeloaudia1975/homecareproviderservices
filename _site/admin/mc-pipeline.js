/* Manufacturer Center — pipeline status (Batch 3, 2026-10-26). Draws catalog-api "mc_pipeline" (read-only, President):
   one row per manufacturer along Import → Match → Enrich → Review → Approve → Publish → Verify, each step linking to
   the tool that does that work, plus publication readiness with the reasons it is blocked. Never a price. */
(function () {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MARK = { done: "✓", attention: "!", blocked: "✕", todo: "·" };
  const WORD = { done: "Done", attention: "Needs attention", blocked: "Blocked", todo: "Not started" };
  let DATA = null, ERR = null, LOADING = false, FILTER = "all";
  function html() {
    if (ERR) return `<div class="card err">Pipeline status could not be read: ${esc(ERR)}. Nothing is shown rather than a partial picture.</div>`;
    if (!DATA) return `<div class="card mut">Reading every line's pipeline status (catalog, master, pages, sources, decisions, verification)…</div>`;
    const lines = DATA.lines.filter(l => FILTER === "all" || (FILTER === "action" ? (l.exceptions || l.approvals_waiting) : FILTER === "blocked" ? l.steps.some(s => s.state === "blocked") : l.published));
    const rows = lines.map(l => {
      const pub = l.published ? `<span class="pill p-pass">Published${l.frozen ? " · frozen" : ""}</span>`
        : l.ready_to_publish ? `<span class="pill p-auth">Ready to publish</span>` : `<span class="pill p-fail">Publication blocked</span>`;
      return `<div class="pl-row" data-line="${esc(l.slug)}">
        <div class="pl-head"><div><b>${esc(l.name)}</b> <span class="mut pl-slug">${esc(l.slug)}</span></div>
          <div class="pl-meta">${pub} <span class="pill p-adv">${l.done}/${l.total} steps</span>
          ${l.exceptions ? `<a class="pill p-warn pl-a" href="/admin/catalog-exceptions.html#line=${encodeURIComponent(l.slug)}">${l.exceptions} exception(s)</a>` : `<span class="pill p-pass">0 exceptions</span>`}
          ${l.approvals_waiting ? `<span class="pill p-warn">${l.approvals_waiting} approval item(s)</span>` : ""}
          <span class="pill ${l.order_verified ? "p-pass" : "p-adv"}">${l.order_verified ? "Order-verified" : "Order verification not on record"}</span></div></div>
        <ol class="pl-steps">${l.steps.map((s, n) => `<li class="pl-step s-${s.state}"><a href="${esc(s.href)}" title="${esc(WORD[s.state] + " — " + s.summary + " · Open " + s.tool)}">
          <span class="pl-dot" aria-hidden="true">${MARK[s.state]}</span><span class="pl-lab">${n + 1} · ${esc(s.label)}</span><span class="pl-st">${esc(WORD[s.state])}</span>
          <span class="pl-sum">${esc(s.summary)}</span><span class="pl-tool">Open ${esc(s.tool)} →</span></a></li>`).join("")}</ol>
        ${!l.published && !l.ready_to_publish && l.publish_blocked_by.length ? `<div class="pl-why"><b>Publication blocked until resolved:</b> ${l.publish_blocked_by.map(esc).join(" · ")}</div>` : ""}
      </div>`;
    }).join("") || `<div class="mut" style="padding:8px">No line matches this filter.</div>`;
    const n = k => DATA.lines.filter(l => k === "action" ? (l.exceptions || l.approvals_waiting) : k === "blocked" ? l.steps.some(s => s.state === "blocked") : l.published).length;
    return `<div class="card pl-card"><div class="pl-top"><h2 style="margin:0">Pipeline status</h2>
      <div class="pl-filters" role="group" aria-label="Filter lines">${[["all", "All " + DATA.lines.length], ["action", "Needs action " + n("action")], ["blocked", "Blocked " + n("blocked")], ["published", "Published " + n("published")]]
        .map(([k, t]) => `<button class="btn ghost pl-f${FILTER === k ? " on" : ""}" data-f="${k}" aria-pressed="${FILTER === k}">${esc(t)}</button>`).join("")}
      <button class="btn ghost" id="pl-refresh">Refresh</button></div></div>
      <p class="mut" style="font-size:12px;margin:6px 0 10px">Import → Match → Enrich → Review → Approve → Publish → Verify. Each step opens the tool that does that work. A line can be published only when its commercial facts (accepted price list, every active SKU priced), photo rights and required approvals are resolved. Generated ${esc(new Date(DATA.generated).toLocaleString())}.</p>
      ${rows}</div>`;
  }
  function draw() {
    const host = document.getElementById("pipe"); if (!host) return;
    host.innerHTML = html();
    host.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { FILTER = b.dataset.f; draw(); });
    const r = host.querySelector("#pl-refresh"); if (r) r.onclick = () => load(true);
  }
  async function load(force) {
    if (LOADING || (DATA && !force)) return draw();
    LOADING = true; ERR = null; if (force) DATA = null; draw();
    try { DATA = await window.api({ action: "mc_pipeline" }); }
    catch (e) { if (String(e && e.message) !== "unauthorized") ERR = String((e && e.message) || e); }
    LOADING = false; draw();
  }
  window.MCPipeline = { draw, load };
})();

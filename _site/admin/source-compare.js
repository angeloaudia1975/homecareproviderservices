/* Manufacturer Center — compare a reviewed price list with today's prices (2026-10-27). Loads the importer's line.json
   from this computer (never uploaded anywhere but the signed-in catalog-api call), asks catalog-api "source_compare"
   (President, read-only) and shows part numbers, states and changed field NAMES — the server never returns a price,
   and nothing is stored. */
(function () {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LABEL = { unchanged: "Unchanged", changed: "Changed", added: "Added", removed: "Not on source", ambiguous: "Ambiguous", unverifiable: "Unverifiable" };
  const CLS = { unchanged: "p-pass", changed: "p-warn", added: "p-auth", removed: "p-adv", ambiguous: "p-fail", unverifiable: "p-fail" };
  let LINE = null, RES = null, ERR = "", BUSY = false, SHOW = "", LIST = [];
  function html() {
    const lines = (LIST || []).map(l => `<option value="${esc(l.slug)}">${esc(l.name || l.slug)}</option>`).join("");
    let out = "";
    if (RES) {
      const s = RES.summary, states = ["changed", "added", "removed", "ambiguous", "unverifiable", "unchanged"];
      const rows = RES.rows.filter(r => !SHOW || r.state === SHOW);
      out = `<div class="sc-sum">${states.map(k => `<button class="btn ghost sc-f${SHOW === k ? " on" : ""}" data-s="${k}"><span class="pill ${CLS[k]}">${esc(LABEL[k])}</span> ${s[k]}</button>`).join("")}</div>
        <p class="mut" style="font-size:12px;margin:6px 0">Source <b>${esc(RES.source.file || "")}</b> · SHA-256 ${esc(RES.source.sha256.slice(0, 12))}… · received ${esc(RES.source.received_date || "not recorded")} · effective ${esc(RES.source.effective_date || RES.source.effective_date_status || "not stated")} — compared with today's catalog version ${esc(RES.catalog.identity)}… (${esc(RES.catalog.authority)}). ${s.source_rows} source rows · ${s.catalog_products} catalog products. Prices are never shown here: only which field differs.</p>
        <div class="sc-list">${rows.map(r => `<div class="sc-row"><code>${esc(r.code)}</code> <span class="pill ${CLS[r.state]}">${esc(LABEL[r.state])}</span>
          ${r.fields ? `<span class="mut">${r.fields.map(esc).join(", ")}</span>` : ""}${r.note ? ` <span class="mut">${esc(r.note)}</span>` : ""}${r.locators && r.locators.length ? ` <span class="mut sc-loc">${r.locators.map(esc).join(" · ")}</span>` : ""}</div>`).join("") || '<div class="mut">None.</div>'}</div>`;
    }
    return `<div class="card"><h2 style="margin:0 0 6px">Compare a reviewed price list with today's prices</h2>
      <p class="mut" style="font-size:12px;margin:0 0 8px">Choose the line and the importer's <code>line.json</code> for the manufacturer's file. The comparison runs on the server against what dealers are charged today (the private commercial record for the deployed catalog version); it stores nothing and changes nothing. Ambiguous and unverifiable rows need a person.</p>
      <div class="bar"><select id="sc-line" aria-label="Line">${lines}</select><input type="file" id="sc-file" accept=".json,application/json" aria-label="line.json">
        <button class="btn" id="sc-go" ${LINE && !BUSY ? "" : "disabled"}>${BUSY ? "Comparing…" : "Compare"}</button></div>
      ${ERR ? `<div class="err" style="font-size:13px">${esc(ERR)}</div>` : ""}${out}</div>`;
  }
  function draw(list) {
    if (Array.isArray(list)) LIST = list;
    const host = document.getElementById("srccmp"); if (!host) return;
    const keep = host.querySelector("#sc-line") ? host.querySelector("#sc-line").value : null;
    host.innerHTML = html();
    if (keep) host.querySelector("#sc-line").value = keep;
    host.querySelector("#sc-file").onchange = async e => { ERR = ""; RES = null; LINE = null;
      try { const f = e.target.files[0]; LINE = JSON.parse(await f.text()); if (!LINE || !Array.isArray(LINE.rows)) throw new Error("not an importer line.json");
        const sel = host.querySelector("#sc-line"); const want = LINE.manufacturer === "ohio-medical" ? "gce" : LINE.manufacturer;
        if ([...sel.options].some(o => o.value === want)) sel.value = want; }
      catch (x) { ERR = "That file is not an importer line.json (" + (x.message || x) + ")."; LINE = null; }
      const v = host.querySelector("#sc-line").value; draw(); host.querySelector("#sc-line").value = v; };
    host.querySelector("#sc-go").onclick = go;
    host.querySelectorAll("[data-s]").forEach(b => b.onclick = () => { SHOW = SHOW === b.dataset.s ? "" : b.dataset.s; draw(); });
  }
  async function go() {
    const host = document.getElementById("srccmp"); const slug = host.querySelector("#sc-line").value;
    BUSY = true; ERR = ""; draw(); host.querySelector("#sc-line").value = slug;
    try { RES = await window.api({ action: "source_compare", manufacturer: slug, line: LINE }); SHOW = ""; }
    catch (x) { if (String(x && x.message) !== "unauthorized") ERR = String((x && x.message) || x); RES = null; }
    BUSY = false; draw(); host.querySelector("#sc-line").value = slug;
  }
  window.SourceCompare = { draw };
})();

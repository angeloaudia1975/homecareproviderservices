/* Email Learning (Smart Email Learning, Phase 1; CLAUDE.md §16) — owner page script. READ ONLY: reads email-learning-api
   (President only). Shows each captured draft and, once sent, what was actually sent, with a line comparison.
   No inline script (strict CSP safe); all text is escaped before it is placed. */
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let TOKEN = (window.HCPS && HCPS.token && HCPS.token()) || "";
  window.addEventListener("hcps-token", e => { try { TOKEN = e.detail; } catch (_) {} });
  const TYPE = { previsit_headsup: "Pre-visit heads-up", visit_followup: "Visit follow-up", follow_up: "Follow-up", dormant_account: "Dealer re-engagement",
    product_intro: "Product introduction", reorder_reminder: "Reorder reminder", cross_sell: "Cross-sell", portal_activation: "Portal activation", campaign: "Campaign" };
  const WHEN = t => t ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : "—";
  let ST = null, ROWS = [], NEXT = null, F = { type: "", only: "all" }, OPEN = null, ERR = "";

  async function api(p) {
    const r = await fetch("/.netlify/functions/email-learning-api", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: JSON.stringify(p) });
    let body = {}; try { body = await r.json(); } catch (e) {}
    return { status: r.status, body };
  }
  function gate(msg) {
    $("#body").innerHTML = `<div class="gate"><h2>Staff sign-in</h2><p class="hint">Sign in with your work email and password.</p><input id="lemail" type="email" placeholder="Email" autocomplete="username"><input id="lpass" type="password" placeholder="Password" autocomplete="current-password"><button class="go" id="lgo">Sign in</button><div style="color:#b42323;margin-top:8px">${esc(msg || "")}</div></div>`;
    $("#lgo").onclick = submit; $("#lpass").onkeydown = e => { if (e.key === "Enter") submit(); };
  }
  async function submit() {
    const email = ($("#lemail").value || "").trim(), password = $("#lpass").value || "";
    try { const r = await fetch("/.netlify/functions/staff-auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "login", email, password }) });
      const j = await r.json().catch(() => ({})); if (!j || !j.ok) { gate((j && j.message) || "Could not sign in."); return; }
      HCPS.setSession(j); TOKEN = j.token; boot();
    } catch (e) { gate("Could not reach the server. Try again."); }
  }

  function kpis() {
    const t = (ST && ST.totals) || { drafts: 0, sent: 0, edited: 0 };
    const pct = t.sent ? Math.round(100 * t.edited / t.sent) + "%" : "—";
    return `<div class="el-kpis">
      <div class="el-kpi"><div class="l">Capture</div><div class="v" style="font-size:16px">${ST.capture_on ? "On" : "Off"}</div><div class="hint">${ST.capture_on ? "Your drafts and sends are kept." : "Nothing is being kept."}</div></div>
      <div class="el-kpi"><div class="l">Drafts kept</div><div class="v" id="k-drafts">${t.drafts}</div></div>
      <div class="el-kpi"><div class="l">Sent</div><div class="v" id="k-sent">${t.sent}</div></div>
      <div class="el-kpi"><div class="l">Edited before sending</div><div class="v" id="k-edited">${t.edited}</div><div class="hint">${pct} of sent</div></div>
    </div>`;
  }
  function rowHtml(r) {
    const tag = r.purged ? `<span class="el-tag t-purged">Text removed after 12 months</span>`
      : !r.sent_at ? `<span class="el-tag t-draft">Not sent</span>` : r.edited ? `<span class="el-tag t-edited">You edited it</span>` : `<span class="el-tag t-same">Sent as drafted</span>`;
    return `<button type="button" class="el-row" data-id="${esc(r.id)}"><div class="r1"><span class="subj">${esc(r.subject || "(text removed)")}</span>${tag}</div>
      <div class="hint">${esc(TYPE[r.email_type] || r.email_type)} · ${esc(r.dealer || "no dealer")} · drafted ${esc(WHEN(r.created_at))}${r.sent_at ? " · sent " + esc(WHEN(r.sent_at)) : ""}</div></button>`;
  }
  function detailHtml(d) {
    const x = d.draft;
    const head = `<div class="el-flt"><button class="go sec" id="el-back" type="button">← All emails</button>
      <span class="hint">${esc(TYPE[x.email_type] || x.email_type)} · ${esc(x.dealer || "no dealer")} · drafted ${esc(WHEN(x.created_at))}${x.sent_at ? " · sent " + esc(WHEN(x.sent_at)) + " to " + esc(x.recipient_count) + (x.recipient_count === 1 ? " person" : " people") : " · not sent"}</span></div>`;
    if (x.content_purged_at) return head + `<div class="empty">The text of this email was removed after 12 months.</div>`;
    const box = (h, s, b) => `<div class="el-box"><h3>${esc(h)}</h3><pre><b>${esc(s || "")}</b>\n\n${esc(b || "")}</pre></div>`;
    const cols = `<div class="el-cols">${box("HCPS draft", x.original_subject, x.original_body)}${x.sent_at ? box("What you sent", x.sent_subject, x.sent_body) : `<div class="el-box"><h3>What you sent</h3><div class="hint">Not sent from HCPS (yet).</div></div>`}</div>`;
    const diff = d.diff ? `<h2 style="font-size:15px;margin:16px 0 0;color:var(--navy)">Line by line</h2>
      ${d.diff.subject_changed ? `<div class="hint">The subject line was changed too.</div>` : ""}
      <div class="el-diff">${d.diff.body.map(l => `<div class="${l.op === "add" ? "add" : l.op === "del" ? "del" : "same"}">${esc(l.text)}</div>`).join("")}</div>` : "";
    return head + cols + diff;
  }
  function render() {
    if (OPEN) { $("#body").innerHTML = detailHtml(OPEN); $("#el-back").onclick = () => { OPEN = null; render(); }; return; }
    if (ST && !ST.installed) { $("#body").innerHTML = `<div class="note"><b>Not installed yet.</b> The Email Learning table is added by <code>supabase/email_learning_p1_capture.sql</code>; until it is run, nothing is kept.</div>`; return; }
    const opts = ['<option value="">All email types</option>'].concat((ST.types || []).map(t => `<option value="${esc(t)}"${F.type === t ? " selected" : ""}>${esc(TYPE[t] || t)}</option>`)).join("");
    $("#body").innerHTML = `<div class="note">Phase 1 keeps each HCPS draft and, after Outlook accepts it, the version you sent — your own emails only, and only while capture is on.
        Nothing is learned yet and no future email changes. In Phase 2 this page will show suggested writing rules for you to approve.</div>
      ${kpis()}
      <div class="el-flt"><label class="hint" for="el-type" style="margin:0">Type</label><select id="el-type">${opts}</select>
        <label class="hint" for="el-only" style="margin:0">Show</label><select id="el-only">
          <option value="all"${F.only === "all" ? " selected" : ""}>All drafts</option><option value="sent"${F.only === "sent" ? " selected" : ""}>Sent</option>
          <option value="edited"${F.only === "edited" ? " selected" : ""}>Edited before sending</option></select></div>
      ${ERR ? `<div style="color:#b42323;font-size:13px;margin:6px 0">${esc(ERR)}</div>` : ""}
      <div id="el-list">${ROWS.length ? ROWS.map(rowHtml).join("") : `<div class="empty">No emails ${F.type || F.only !== "all" ? "match" : "kept yet"}.</div>`}</div>
      ${NEXT ? `<button class="go sec" id="el-more" type="button">Show older</button>` : ""}`;
    $("#el-type").onchange = e => { F.type = e.target.value; load(false); };
    $("#el-only").onchange = e => { F.only = e.target.value; load(false); };
    document.querySelectorAll(".el-row").forEach(b => { b.onclick = () => open(b.getAttribute("data-id")); });
    const more = $("#el-more"); if (more) more.onclick = () => load(true);
  }
  async function open(id) {
    const r = await api({ action: "get", id });
    if (r.status === 200 && r.body.ok) { OPEN = r.body; render(); window.scrollTo(0, 0); } else { ERR = (r.body && (r.body.message || r.body.error)) || "Couldn't open that email."; render(); }
  }
  async function load(more) {
    ERR = "";
    const r = await api({ action: "list", type: F.type || undefined, only: F.only, before: more ? NEXT : undefined });
    if (r.status === 401) { gate(); return; }
    if (r.status !== 200) { ERR = (r.body && (r.body.message || r.body.error)) || "Couldn't load the list."; render(); return; }
    ROWS = more ? ROWS.concat(r.body.rows) : r.body.rows; NEXT = r.body.next_before; render();
  }
  async function boot() {
    if (!TOKEN) { gate(); return; }
    const s = await api({ action: "status" });
    if (s.status === 401) { gate(); return; }
    if (s.status === 403) { $("#body").innerHTML = `<div class="empty">Email Learning is the owner's page.</div>`; return; }
    if (s.status !== 200) { $("#body").innerHTML = `<div class="empty">Couldn't load Email Learning (${esc((s.body && s.body.error) || s.status)}).</div>`; return; }
    ST = s.body; if (!ST.installed) { render(); return; }
    await load(false);
  }
  boot();
})();

/* Email Learning (Smart Email Learning; CLAUDE.md §16) — owner page script (President only, email-learning-api).
   Emails tab (Phase 1): each captured draft and, once sent, what was actually sent, with a line comparison.
   Learned rules tab (Phase 2): repeated edits suggested as writing rules — approve (optionally reworded), reject, retire.
   Versions tab (Phase 2): every change of the approved set; restore an earlier version or reset.
   Every decision needs a short reason and is refused if the page is out of date. Approved rules change no email yet (Phase 3).
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
  let REDACT_READY = false, TAB = "emails", RULES = null, VERSIONS = null, VER = 0, MSG = "", FORM = null, BUSY = false;
  const KIND = { remove_phrase: "You delete", replace_phrase: "You rewrite", add_phrase: "You add", greeting: "Greeting", shorter: "Length", longer: "Length", subject: "Subject line" };
  const ACT = { approve: "Approved a rule", retire: "Retired a rule", edit: "Reworded a rule", rollback: "Restored an earlier version", reset: "Reset — no rules", redact: "Redacted a rule" };

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
  function tabs() {
    const L = (ST && ST.learning) || {};
    const t = (k, label) => `<button type="button" class="el-tab${TAB === k ? " on" : ""}" data-tab="${k}" aria-pressed="${TAB === k}">${label}</button>`;
    return `<div class="el-tabs" role="group" aria-label="Email Learning sections">${t("emails", "Emails")}${t("rules", "Learned rules" + (L.suggested ? ` <span class="el-badge">${esc(L.suggested)}</span>` : ""))}${t("versions", "Versions")}</div>`;
  }
  function wireTabs() { document.querySelectorAll(".el-tab").forEach(b => { b.onclick = () => { TAB = b.getAttribute("data-tab"); MSG = ""; FORM = null; showTab(); }; }); }
  async function showTab() {
    if (TAB === "emails") { render(); return; }
    if (TAB === "rules") await loadRules(); else await loadVersions();
  }
  function render() {
    if (TAB !== "emails") { return TAB === "rules" ? renderRules() : renderVersions(); }
    if (OPEN) { $("#body").innerHTML = tabs() + detailHtml(OPEN); wireTabs(); $("#el-back").onclick = () => { OPEN = null; render(); }; return; }
    if (ST && !ST.installed) { $("#body").innerHTML = `<div class="note"><b>Not installed yet.</b> The Email Learning table is added by <code>supabase/email_learning_p1_capture.sql</code>; until it is run, nothing is kept.</div>`; return; }
    const opts = ['<option value="">All email types</option>'].concat((ST.types || []).map(t => `<option value="${esc(t)}"${F.type === t ? " selected" : ""}>${esc(TYPE[t] || t)}</option>`)).join("");
    $("#body").innerHTML = tabs() + `<div class="note">HCPS keeps each draft it writes for you and, after Outlook accepts it, the version you sent — your own emails only, and only while capture is on.
        Repeated edits show up under <b>Learned rules</b> for you to approve. No email changes because of this page yet.</div>
      ${kpis()}
      <div class="el-flt"><label class="hint" for="el-type" style="margin:0">Type</label><select id="el-type">${opts}</select>
        <label class="hint" for="el-only" style="margin:0">Show</label><select id="el-only">
          <option value="all"${F.only === "all" ? " selected" : ""}>All drafts</option><option value="sent"${F.only === "sent" ? " selected" : ""}>Sent</option>
          <option value="edited"${F.only === "edited" ? " selected" : ""}>Edited before sending</option></select></div>
      ${ERR ? `<div style="color:#b42323;font-size:13px;margin:6px 0">${esc(ERR)}</div>` : ""}
      <div id="el-list">${ROWS.length ? ROWS.map(rowHtml).join("") : `<div class="empty">No emails ${F.type || F.only !== "all" ? "match" : "kept yet"}.</div>`}</div>
      ${NEXT ? `<button class="go sec" id="el-more" type="button">Show older</button>` : ""}`;
    wireTabs();
    $("#el-type").onchange = e => { F.type = e.target.value; load(false); };
    $("#el-only").onchange = e => { F.only = e.target.value; load(false); };
    document.querySelectorAll(".el-row").forEach(b => { b.onclick = () => open(b.getAttribute("data-id")); });
    const more = $("#el-more"); if (more) more.onclick = () => load(true);
  }

  // ---- Learned rules (Phase 2) ----------------------------------------------------------------------------------
  const notInstalledP2 = `<div class="note"><b>Learning isn't installed yet.</b> It is added by <code>supabase/email_learning_p2_rules.sql</code>.</div>`;
  async function loadRules() {
    const r = await api({ action: "rules" });
    if (r.status === 401) { gate(); return; }
    if (r.status === 503) { RULES = "not_installed"; } else if (r.status !== 200) { RULES = null; MSG = (r.body && (r.body.message || r.body.error)) || "Couldn't load the rules."; }
    else { RULES = r.body.rules; VER = r.body.version; REDACT_READY = r.body.redact_ready === true; }
    renderRules();
  }
  function ruleCard(x) {
    const ev = `Seen in ${esc(x.sends)} sent email${x.sends === 1 ? "" : "s"} to ${esc(x.dealers)} dealer${x.dealers === 1 ? "" : "s"}`;
    const ex = (x.examples || []).length ? `<div class="el-ex">${x.examples.map(e => `<div>${esc(e)}</div>`).join("")}</div>` : "";
    const scope = x.email_type === "all" ? "Every email type" : (TYPE[x.email_type] || x.email_type);
    const open = FORM && FORM.id === x.id;
    let actions = "";
    // Phase 3 Redact (President only, checked again on the server and in the database): removes the evidence for good.
    const red = REDACT_READY && !x.redacted_at ? ` <button class="go sec" data-act="redact" data-id="${esc(x.id)}" type="button" style="color:#b42323">Redact…</button>` : "";
    if (x.redacted_at) actions = "";
    else if (x.status === "suggested") actions = `<button class="go" data-act="approve" data-id="${esc(x.id)}" type="button">Approve…</button> <button class="go sec" data-act="reject" data-id="${esc(x.id)}" type="button">Reject…</button>`;
    else if (x.status === "approved") actions = `<button class="go sec" data-act="edit" data-id="${esc(x.id)}" type="button">Reword…</button> <button class="go sec" data-act="retire" data-id="${esc(x.id)}" type="button">Retire…</button>`;
    else actions = `<button class="go sec" data-act="approve" data-id="${esc(x.id)}" type="button">Approve…</button>`;
    if (!x.redacted_at) actions += red;
    const form = open ? `<div class="el-form" id="el-form">
        ${FORM.act === "approve" || FORM.act === "edit" ? `<label class="hint" for="el-instr">Wording (what HCPS will be told)</label><textarea id="el-instr" rows="2" maxlength="300">${esc(FORM.act === "edit" ? x.instruction : (x.status === "suggested" ? x.suggested_instruction : x.instruction))}</textarea>` : ""}
        ${FORM.act === "redact" ? `<div class="hint" style="color:#b42323;margin:0 0 6px">Redact removes this rule's masked phrase, examples and wording for good — here, in its history and in every saved version. ${x.status === "approved" ? "It stops being used at once (a new version is saved). " : ""}It can't be undone, and the same edit is never suggested again.</div>` : ""}
        <label class="hint" for="el-reason">Reason (required)</label><input id="el-reason" type="text" maxlength="500" placeholder="${FORM.act === "reject" ? "e.g. Only for that one dealer" : FORM.act === "redact" ? "e.g. Holds a customer's name" : "e.g. This is how I write"}">
        <div class="el-flt" style="margin:8px 0 0"><button class="go" id="el-save" type="button"${BUSY ? " disabled" : ""}>${{ approve: "Approve rule", reject: "Reject", retire: "Retire rule", edit: "Save wording", redact: "Redact for good" }[FORM.act]}</button>
        <button class="go sec" id="el-cancel" type="button">Cancel</button></div></div>` : "";
    return `<div class="el-rule s-${esc(x.status)}" data-rule="${esc(x.id)}"><div class="r1"><span class="subj">${esc(x.instruction)}</span>
        <span class="el-tag t-${x.status === "approved" ? "same" : x.status === "suggested" ? "edited" : "draft"}">${esc(x.redacted_at ? "Redacted" : { suggested: "Suggested", approved: "Approved", rejected: "Rejected", retired: "Retired" }[x.status])}</span></div>
      <div class="hint">${esc(KIND[x.kind] || x.kind)} · ${esc(scope)} · ${ev}${x.decided_by ? " · " + esc(x.status) + " " + esc(WHEN(x.decided_at)) + (x.decision_reason ? " — “" + esc(x.decision_reason) + "”" : "") : ""}</div>
      ${ex}
      <div class="el-flt" style="margin:8px 0 0">${actions}</div>${form}</div>`;
  }
  function renderRules() {
    const L = (ST && ST.learning) || {};
    let inner;
    if (RULES === "not_installed") inner = notInstalledP2;
    else if (!RULES) inner = `<div class="msg">Loading…</div>`;
    else {
      const g = s => RULES.filter(x => x.status === s);
      const sect = (h, list, empty) => `<h2 class="el-h">${esc(h)} <span class="hint">(${list.length})</span></h2>${list.length ? list.map(ruleCard).join("") : `<div class="empty">${esc(empty)}</div>`}`;
      inner = `<div class="note">When you make the same edit in ${esc((ST.thresholds || {}).sends || 3)}+ sent emails to ${esc((ST.thresholds || {}).dealers || 2)}+ different dealers, it shows up here as a suggestion.
          Nothing is used until you approve it. Approved rules shape your own AI drafts only while <b>Apply learned rules</b> is switched on (${ST && ST.phase3 && ST.phase3.apply ? "on" : "off"}); the AI Communication Style Guide always comes first.
          Phrases are masked: names, dealers, dates, numbers and addresses never appear. The comparison runs inside HCPS — no AI service sees your emails.</div>
        <div class="el-flt"><button class="go" id="el-analyze" type="button"${BUSY ? " disabled" : ""}>Look for patterns now</button>
          <span class="hint">Automatic daily check: ${L.suggest_on ? "on" : "off"} · approved set: version ${esc(VER)}</span></div>
        ${MSG ? `<div class="el-msg" role="status">${esc(MSG)}</div>` : ""}
        ${sect("Suggested for you", g("suggested"), "No suggestions yet. They appear once the same edit repeats across dealers.")}
        ${sect("Approved", g("approved"), "No approved rules.")}
        ${g("rejected").length + g("retired").length ? sect("Rejected and retired", g("rejected").concat(g("retired")), "") : ""}`;
    }
    $("#body").innerHTML = tabs() + inner; wireTabs();
    const an = $("#el-analyze"); if (an) an.onclick = analyze;
    document.querySelectorAll("[data-act]").forEach(b => { b.onclick = () => { const id = b.getAttribute("data-id"), rr = Array.isArray(RULES) ? RULES.find(x => x.id === id) : null;
      FORM = { id, act: b.getAttribute("data-act"), status: rr ? rr.status : "" }; MSG = ""; renderRules(); const f = $("#el-reason"); if (f) f.focus(); }; });
    const c = $("#el-cancel"); if (c) c.onclick = () => { FORM = null; renderRules(); };
    const sv = $("#el-save"); if (sv) sv.onclick = saveDecision;
  }
  async function analyze() {
    BUSY = true; MSG = "Looking for patterns…"; renderRules();
    const r = await api({ action: "analyze" }); BUSY = false;
    if (r.status === 200) { const s = r.body.summary; MSG = `Checked ${s.scanned} edited email${s.scanned === 1 ? "" : "s"}: ${s.inserted} new suggestion${s.inserted === 1 ? "" : "s"}, ${s.updated} updated.`; await refreshStatus(); await loadRules(); }
    else { MSG = (r.body && (r.body.message || r.body.error)) || "Couldn't look for patterns."; renderRules(); }
  }
  async function saveDecision() {
    const reason = ($("#el-reason").value || "").trim(), instr = $("#el-instr") ? $("#el-instr").value : undefined;
    if (reason.length < 3) { MSG = "Give a short reason first."; renderRules(); return; }
    BUSY = true; renderRules();
    const r = FORM.act === "redact"
      ? await api({ action: "redact", rule_id: FORM.id, reason, expected_version: VER, expected_status: FORM.status })
      : await api({ action: "decide", rule_id: FORM.id, decision: FORM.act, reason, instruction: instr, expected_version: VER, expected_status: FORM.status });
    BUSY = false;
    if (r.status === 200) { MSG = { approve: "Approved", reject: "Rejected", retire: "Retired", edit: "Wording saved", redact: "Redacted" }[FORM.act] + (r.body.version !== VER ? ` — approved set is now version ${r.body.version}.` : "."); FORM = null; await refreshStatus(); await loadRules(); }
    else { MSG = (r.body && (r.body.message || ({ not_allowed: "That change isn't possible for this rule any more — reload.", president_only: "Only the President can decide.", redacted: "This rule has been redacted — it can't be changed.", bad_instruction: "Check the wording (3–300 characters, no email address, link or number — a percentage is fine)." })[r.body.status] || r.body.error)) || "Couldn't save."; renderRules(); }
  }
  async function refreshStatus() { const s = await api({ action: "status" }); if (s.status === 200) ST = s.body; }

  // ---- Versions (Phase 2) ---------------------------------------------------------------------------------------
  async function loadVersions() {
    const r = await api({ action: "versions" });
    if (r.status === 401) { gate(); return; }
    if (r.status === 503) VERSIONS = "not_installed"; else if (r.status !== 200) { VERSIONS = null; MSG = (r.body && (r.body.message || r.body.error)) || "Couldn't load the versions."; }
    else { VERSIONS = r.body.versions; VER = r.body.version; }
    renderVersions();
  }
  function renderVersions() {
    let inner;
    if (VERSIONS === "not_installed") inner = notInstalledP2;
    else if (!VERSIONS) inner = `<div class="msg">Loading…</div>`;
    else {
      const row = v => {
        const open = FORM && FORM.ver === v.version;
        const cur = v.version === VER;
        return `<div class="el-rule"><div class="r1"><span class="subj">Version ${esc(v.version)}${cur ? " · current" : ""}</span><span class="hint">${esc(WHEN(v.created_at))}</span></div>
          <div class="hint">${esc(ACT[v.action] || v.action)}${v.from_version != null && (v.action === "rollback") ? " " + esc(v.from_version) : ""} · ${esc((v.rules || []).length)} approved rule${(v.rules || []).length === 1 ? "" : "s"} · “${esc(v.reason)}”</div>
          ${(v.rules || []).length ? `<div class="el-ex">${v.rules.map(x => `<div>${x.redacted ? "<i>Redacted rule</i>" : esc(x.instruction)}</div>`).join("")}</div>` : ""}
          ${cur ? "" : `<div class="el-flt" style="margin:8px 0 0"><button class="go sec" data-ver="${esc(v.version)}" type="button">Restore this version…</button></div>`}
          ${open ? restoreForm() : ""}</div>`;
      };
      inner = `<div class="note">Each time the set of approved rules changes, HCPS saves a numbered version. Restoring an earlier version (or resetting to none) creates a new version — nothing is erased.</div>
        ${MSG ? `<div class="el-msg" role="status">${esc(MSG)}</div>` : ""}
        <div class="el-flt"><span class="hint">Current: version ${esc(VER)}</span>${VER ? ` <button class="go sec" data-ver="0" type="button">Reset — no rules…</button>` : ""}</div>
        ${FORM && FORM.ver === 0 ? restoreForm() : ""}
        ${VERSIONS.length ? VERSIONS.map(row).join("") : `<div class="empty">No versions yet — the first one is saved when you approve a rule.</div>`}`;
    }
    $("#body").innerHTML = tabs() + inner; wireTabs();
    document.querySelectorAll("[data-ver]").forEach(b => { b.onclick = () => { FORM = { ver: +b.getAttribute("data-ver") }; MSG = ""; renderVersions(); const f = $("#el-reason"); if (f) f.focus(); }; });
    const c = $("#el-cancel"); if (c) c.onclick = () => { FORM = null; renderVersions(); };
    const sv = $("#el-save"); if (sv) sv.onclick = saveRestore;
  }
  function restoreForm() {
    return `<div class="el-form" id="el-form"><label class="hint" for="el-reason">Reason (required)</label><input id="el-reason" type="text" maxlength="500" placeholder="e.g. The new wording didn't work">
      <div class="el-flt" style="margin:8px 0 0"><button class="go" id="el-save" type="button"${BUSY ? " disabled" : ""}>${FORM.ver === 0 ? "Reset to no rules" : "Restore version " + esc(FORM.ver)}</button><button class="go sec" id="el-cancel" type="button">Cancel</button></div></div>`;
  }
  async function saveRestore() {
    const reason = ($("#el-reason").value || "").trim();
    if (reason.length < 3) { MSG = "Give a short reason first."; renderVersions(); return; }
    BUSY = true; renderVersions();
    const r = await api({ action: "rollback", to_version: FORM.ver, reason, expected_version: VER });
    BUSY = false;
    if (r.status === 200) { MSG = FORM.ver === 0 ? `Reset — version ${r.body.version} has no approved rules.` : `Restored — version ${r.body.version} matches version ${FORM.ver}.`; FORM = null; await refreshStatus(); await loadVersions(); }
    else { MSG = (r.body && (r.body.message || (r.body.status === "version_conflict" ? "Something changed since you opened this page — reload and try again." : r.body.error))) || "Couldn't restore."; renderVersions(); }
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

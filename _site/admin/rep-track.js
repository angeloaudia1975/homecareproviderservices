/* HCPS Connect 360 — rep usage tracker (Phase 3).
 * Loaded on every admin page by admin-chrome.js. Silent + best-effort: if the user isn't signed in,
 * or the capture tables/endpoint aren't there yet, it simply does nothing. It records:
 *   - a sign-in SESSION (start + a heartbeat that counts active time ONLY while the tab is visible,
 *     so "left the portal open" doesn't inflate usage), and
 *   - a page/tool VIEW (and, on a dealer record, which dealer account was opened).
 * Identity is derived server-side from the JWT — this script never sends who the user is. */
(function () {
  "use strict";
  if (!(window.HCPS && HCPS.token && HCPS.token())) return;   // signed-in staff only

  var API = "/.netlify/functions/activity-api";
  var STEP = 60;   // heartbeat interval (seconds)

  function post(body) {
    try {
      return fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + HCPS.token() },
        body: JSON.stringify(body)
      }).then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
    } catch (e) { return Promise.resolve({}); }
  }

  // ---- session (per browser tab) ----
  var SID = null, active = 0;
  try { SID = sessionStorage.getItem("hcps_sess_id"); active = parseInt(sessionStorage.getItem("hcps_sess_secs") || "0", 10) || 0; } catch (e) {}
  function saveSecs() { try { sessionStorage.setItem("hcps_sess_secs", String(active)); } catch (e) {} }

  if (!SID) {
    post({ action: "session_start", user_agent: navigator.userAgent }).then(function (j) {
      if (j && j.ok && j.id) { SID = j.id; try { sessionStorage.setItem("hcps_sess_id", SID); } catch (e) {} }
    });
  }

  // ---- page / tool view (once per load) ----
  var tool = "index", dealer = null;
  try { tool = location.pathname.replace(/^.*\/admin\//, "").replace(/\.html$/, "") || "index"; } catch (e) {}
  try { dealer = new URLSearchParams(location.search).get("id"); } catch (e) {}
  post({ action: "track", kind: dealer ? "dealer" : "view", tool: tool, dealer_id: dealer || null, meta: { path: location.pathname } });

  // ---- heartbeat: count active time only when the tab is actually in the foreground ----
  setInterval(function () {
    if (document.hidden) return;          // don't count idle/background tabs
    active += STEP; saveSecs();
    if (SID) post({ action: "session_ping", id: SID, active_seconds: active });
  }, STEP * 1000);
})();

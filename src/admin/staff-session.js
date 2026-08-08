/* HCPS staff session — shared across every /admin page.
 *
 * Fixes the recurring "signed out again" problem. Two root causes, two fixes:
 *   1) The old code kept the login token in sessionStorage, which is PER-TAB and is
 *      wiped when the tab closes — so opening a second admin page or reopening the
 *      browser forced a fresh sign-in. This stores the session in localStorage, so it
 *      persists across tabs and restarts.
 *   2) A Supabase access token only lives ~1 hour and the old code never renewed it, so
 *      after an hour of work every call 401'd and kicked you out. Login now also returns a
 *      refresh token; this helper silently trades it for a new access token before the old
 *      one expires (a background timer + a proactive check on load), and as a safety net it
 *      transparently refreshes-and-retries any admin API call that comes back 401.
 *
 * Exposes window.HCPS. Load this BEFORE each page's inline script:
 *     <script src="/admin/staff-session.js"></script>
 */
(function () {
  "use strict";

  var TKEY = "hcps_staff_token",    // access token (JWT)
      PKEY = "hcps_staff_profile",  // staff profile JSON
      RKEY = "hcps_staff_refresh",  // rotating refresh token
      XKEY = "hcps_staff_expires";  // access-token expiry (ms epoch)
  var SKEW = 120000;                // renew 2 min before the token actually expires
  var origFetch = window.fetch.bind(window);
  var refreshing = null;            // in-flight refresh promise (dedupe concurrent callers)

  function lget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lset(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  // One-time migration from the old per-tab storage: adopt any token an older tab left in
  // sessionStorage (access token only — no refresh token existed then, so it'll get replaced
  // by a renewable session at the next sign-in), then clear the per-tab copies so they can't
  // shadow the shared one.
  (function migrate() {
    try {
      if (!lget(TKEY) && sessionStorage.getItem(TKEY)) {
        lset(TKEY, sessionStorage.getItem(TKEY));
        if (sessionStorage.getItem(PKEY)) lset(PKEY, sessionStorage.getItem(PKEY));
      }
      sessionStorage.removeItem(TKEY);
      sessionStorage.removeItem(PKEY);
    } catch (e) {}
  })();

  function token() { return lget(TKEY) || null; }
  function profile() { try { return JSON.parse(lget(PKEY) || "null"); } catch (e) { return null; } }
  function refreshTok() { return lget(RKEY) || null; }
  function expiresAt() { var n = parseInt(lget(XKEY) || "0", 10); return isNaN(n) ? 0 : n; }

  // Persist a session returned by staff-auth (login or refresh).
  function setSession(s) {
    if (!s) return;
    if (s.token != null) lset(TKEY, s.token);
    if (s.profile != null) lset(PKEY, JSON.stringify(s.profile));
    if (s.refresh != null) lset(RKEY, s.refresh);
    var exp = s.expires_in ? (Date.now() + Number(s.expires_in) * 1000) : 0;
    if (exp) lset(XKEY, String(exp));
    emit(token());
  }

  function signOut() {
    lset(TKEY, null); lset(PKEY, null); lset(RKEY, null); lset(XKEY, null);
    try { sessionStorage.removeItem(TKEY); sessionStorage.removeItem(PKEY); } catch (e) {}
    emit(null);
  }

  // Notify the page (and this tab) that the token changed, so its local copy stays fresh.
  function emit(t) { try { window.dispatchEvent(new CustomEvent("hcps-token", { detail: t })); } catch (e) {} }

  function needsRefresh() {
    if (!refreshTok()) return false;   // nothing to renew with
    var x = expiresAt();
    if (!x) return false;              // unknown expiry (migrated session) — rely on the 401 path
    return Date.now() > (x - SKEW);
  }

  // Trade the stored refresh token for a fresh access token. Deduped so concurrent callers
  // share one round-trip. On a hard failure (refresh token rejected) the session is cleared;
  // on a transient network error we keep the current token and let the next tick try again.
  function refresh() {
    if (refreshing) return refreshing;
    var rt = refreshTok();
    if (!rt) return Promise.resolve(null);
    refreshing = origFetch("/.netlify/functions/staff-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh", refresh_token: rt })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok && j.token) { setSession(j); return token(); }
        signOut(); return null;
      })
      .catch(function () { return token(); })
      .then(function (t) { refreshing = null; return t; });
    return refreshing;
  }

  // Resolve to a usable token, renewing first if we're inside the skew window.
  function ensureFresh() {
    if (needsRefresh()) return refresh();
    return Promise.resolve(token());
  }

  // Cross-tab sync: when another tab writes a new token, tell this page.
  window.addEventListener("storage", function (e) { if (e.key === TKEY) emit(token()); });

  // Silent background renewal so a page left open past the hour is never kicked out.
  setInterval(function () { if (needsRefresh()) refresh(); }, 60000);
  // And renew proactively on load if we're already near/after expiry.
  if (needsRefresh()) refresh();

  // ---- Transparent auth for admin API calls ----------------------------------------
  // Wrap fetch so every request to our Netlify functions that already carries a Bearer
  // gets the freshest token injected (covers pages whose local token copy went stale), and
  // any 401 triggers one refresh + retry before the caller ever sees it. Our own login/
  // refresh calls use origFetch, so they're never intercepted (no recursion).
  function isApi(url) {
    try { var u = new URL(url, location.origin); return u.origin === location.origin && u.pathname.indexOf("/.netlify/functions/") === 0; }
    catch (e) { return false; }
  }
  window.fetch = function (input, init) {
    if (typeof input !== "string" || !isApi(input)) return origFetch(input, init);
    var opts = Object.assign({}, init || {});
    var hdrs = new Headers(opts.headers || {});
    var hadAuth = hdrs.has("authorization");   // Headers matching is case-insensitive
    if (hadAuth && token()) hdrs.set("authorization", "Bearer " + token());
    opts.headers = hdrs;
    return origFetch(input, opts).then(function (res) {
      if (res.status !== 401 || !hadAuth || !refreshTok()) return res;
      return refresh().then(function (t) {
        if (!t) return res;                    // couldn't renew — surface the original 401
        var h2 = new Headers(opts.headers); h2.set("authorization", "Bearer " + t);
        return origFetch(input, Object.assign({}, opts, { headers: h2 }));
      });
    });
  };

  window.HCPS = {
    token: token,
    profile: profile,
    setSession: setSession,
    signOut: signOut,
    refresh: refresh,
    ensureFresh: ensureFresh,
    needsRefresh: needsRefresh
  };
})();

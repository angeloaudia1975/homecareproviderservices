/* HCPS Scheduled Routes — service worker.
 *
 * ─── WHAT WENT WRONG, AND WHY IT WAS SO HARD TO SEE ──────────────────────────
 * A service worker registered from scheduled-routes.html gets scope /admin/ — it controls
 * EVERY admin page, not just the one that registered it. The old fetch handler matched
 * `req.mode === "navigate"`, which is every navigation in that scope, and answered
 * cache-first: `return cached || net`. So after visiting any admin page once, every later
 * visit was served the stored copy and the network response only refreshed the cache for
 * NEXT time. The catalog, the enrichment workspace, the dashboard — all of them served one
 * deploy behind, permanently, on every machine that had ever opened them.
 *
 * That is why pushed work kept "not appearing": it had deployed, and the browser was
 * handing back yesterday's file. A whole day was spent looking for the missing change in
 * git and in Netlify, where it was never missing.
 *
 * ─── THE RULE NOW ────────────────────────────────────────────────────────────
 *   · Only the field page itself is treated as an offline app shell. Every other admin
 *     page is left entirely alone — no respondWith, straight to the network, always current.
 *   · Even the shell is NETWORK-FIRST: the network answer wins whenever there is one, and
 *     the cache is the fallback for genuinely being offline in a van with no signal, which
 *     is the only thing this worker was ever meant to solve.
 *   · CACHE is bumped, so every browser drops the stale copies the moment this activates.
 */
const CACHE = "hcps-sr-v2";
const FIELD_PAGE = "/admin/scheduled-routes.html";
const SHELL = [
  FIELD_PAGE,
  "/admin/staff-session.js",
  "/admin/dealer-handout.js",
  "/admin/scheduled-routes.webmanifest",
  "/assets/hcps-logo.png"
];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL).catch(()=>{})).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e=>{
  const req = e.request;
  if(req.method!=="GET") return;                       // never touch writes
  const url = new URL(req.url);
  if(url.origin!==self.location.origin) return;        // third-party (map tiles, etc.) — pass through
  if(url.pathname.startsWith("/.netlify/")) return;    // API always goes to the network

  /* THE ONE PAGE THIS WORKER EXISTS FOR, plus its own files. A navigation to any other
     admin page is not answered here at all, so it can never be served from cache. */
  const isFieldNav = req.mode==="navigate" && url.pathname===FIELD_PAGE;
  if(!(isFieldNav || SHELL.includes(url.pathname))) return;

  /* Network first. Offline — and only offline — falls back to what was stored. */
  e.respondWith(
    fetch(req).then(res=>{
      if(res && res.ok){ const copy=res.clone(); caches.open(CACHE).then(c=>c.put(req,copy)); }
      return res;
    }).catch(()=>caches.match(req).then(cached=>cached || caches.match(FIELD_PAGE)))
  );
});

/* HCPS Scheduled Routes — service worker. Caches ONLY the app shell (static files) so the mobile
 * field page opens with no signal. It never caches API calls (/.netlify/functions/*) or any non-GET
 * request — the page itself handles offline route data and the write queue in localStorage. Bump
 * CACHE to invalidate the shell after a deploy. */
const CACHE = "hcps-sr-v1";
const SHELL = [
  "/admin/scheduled-routes.html",
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
  if(url.origin!==self.location.origin) return;        // third-party (maps tiles, etc.) — pass through
  if(url.pathname.startsWith("/.netlify/")) return;    // API always goes to the network
  // App shell + navigations: serve cache first, refresh in the background, fall back to the page offline.
  if(req.mode==="navigate" || SHELL.includes(url.pathname)){
    e.respondWith(
      caches.match(req).then(cached=>{
        const net = fetch(req).then(res=>{ if(res&&res.ok){ const copy=res.clone(); caches.open(CACHE).then(c=>c.put(req,copy)); } return res; }).catch(()=>cached||caches.match("/admin/scheduled-routes.html"));
        return cached || net;
      })
    );
  }
});

/* HCPS Admin — shared masthead. Renders the same navy→blue header, orange logo mark,
 * signed-in name + Lock, and tool nav on every backend page, so the admin feels like one
 * app. Pages include this after staff-session.js and drop <header id="ac-head"></header>
 * where the header should appear. Reads the profile from HCPS; wires Lock to the page's
 * own lock() if present, else HCPS.signOut(). Re-renders when the session token changes
 * (so the name fills in right after sign-in). */
(function () {
  "use strict";
  var NAV = [
    { href: "/admin/",                       label: "Dashboard" },
    { href: "/admin/analytics.html",         label: "Analytics" },
    { href: "/admin/dealers.html",           label: "Dealer Manager" },
    { href: "/admin/map.html",               label: "Map" },
    { href: "/admin/import-commissions.html",label: "Import" },
    { href: "/admin/catalog.html",           label: "Catalog" },
    { href: "/admin/images.html",            label: "Images" },
    { href: "/admin/featured.html",          label: "Featured" },
    { href: "/admin/home-editor.html",       label: "Portal Home" },
    { href: "/admin/website.html",           label: "Website" }
  ];
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }
  function render(){
    var host = document.getElementById("ac-head"); if(!host) return;
    var me = (window.HCPS && HCPS.profile && HCPS.profile()) || null;
    var path = location.pathname; if(/\/admin\/index\.html$/.test(path)) path = "/admin/";
    var who = me ? ('Hi, <b>'+esc(me.name||me.email||"")+'</b>'+(me.role?' · '+esc(me.role):'')) : '';
    var nav = NAV.map(function(n){
      var on = (n.href===path) || (n.href!=="/admin/" && path.indexOf(n.href)===0);
      return '<a href="'+n.href+'"'+(on?' class="on"':'')+'>'+esc(n.label)+'</a>';
    }).join("");
    host.className = "ac-head";
    host.innerHTML =
      '<div class="ac-wrap ac-top">'
        + '<a class="ac-brand" href="/admin/"><span class="ac-mark">H</span>'
        + '<span class="ac-bt"><b>HCPS Admin</b><span>Operating System</span></span></a>'
        + '<div class="ac-who">' + who + '<button type="button" id="ac-lock">Lock</button></div>'
      + '</div>'
      + '<nav class="ac-nav ac-wrap">' + nav + '</nav>';
    var lb = document.getElementById("ac-lock");
    if(lb) lb.addEventListener("click", function(){
      if(typeof window.lock === "function") { window.lock(); return; }
      if(window.HCPS && HCPS.signOut) HCPS.signOut();
      location.reload();
    });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", render); else render();
  window.addEventListener("hcps-token", render);   // refresh the name after sign-in
  window.ACAdmin = { render: render, NAV: NAV };
})();

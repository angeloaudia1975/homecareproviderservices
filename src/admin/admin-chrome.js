/* HCPS Admin — shared masthead + 4-hub navigation. Renders the same header on every
 * backend page and organizes navigation exactly around the dashboard's four hubs:
 *   Online Ordering → Website → Sales & Marketing → Sales Data & Analytics.
 * Top tier = the four hubs (link to the dashboard sections); second tier = the tools
 * inside the hub you're currently in, with the active tool highlighted. Pages include
 * this after staff-session.js and drop <header id="ac-head"></header>. */
(function () {
  "use strict";

  var HUBS = [
    { id:"ordering", label:"Online Ordering",       href:"/admin/#ordering", tools:[
        { href:"/admin/order-fulfillment.html", label:"Order Fulfillment" },
        { href:"/admin/catalog.html",     label:"Catalog" },
        { href:"/admin/images.html",      label:"Images" },
        { href:"/admin/featured.html",    label:"Featured" },
        { href:"/admin/home-editor.html", label:"Portal Home" }
    ]},
    { id:"website", label:"Website", href:"/admin/#website", tools:[
        { href:"/admin/website.html", label:"Website Editor" }
    ]},
    { id:"sales", label:"Sales & Marketing", href:"/admin/#sales", tools:[
        { href:"/admin/dealers.html",   label:"Dealer Manager" },
        { href:"/admin/health.html",    label:"Dealer Health" },
        { href:"/admin/call-list.html", label:"Who to Call" },
        { href:"/admin/tasks.html",     label:"My Tasks" },
        { href:"/admin/map.html",       label:"Territory Map" }
    ]},
    { id:"analytics", label:"Sales Data & Analytics", href:"/admin/#analytics", tools:[
        { href:"/admin/command-center.html",     label:"Command Center" },
        { href:"/admin/reps.html",               label:"Rep Performance" },
        { href:"/admin/pipeline.html",           label:"Pipeline & Forecast" },
        { href:"/admin/analytics.html",          label:"Analytics" },
        { href:"/admin/import-commissions.html", label:"Import Commissions" }
    ]}
  ];

  // Detail/child pages that belong to a hub but aren't top-level tools (so the hub still
  // highlights and its sub-nav shows). e.g. the per-dealer 360 profile lives in Sales & Marketing.
  var DETAIL = { "/admin/dealer.html": "sales" };

  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }
  function curPath(){ var p=location.pathname; return /\/admin\/(index\.html)?$/.test(p) ? "/admin/" : p; }
  function hubOf(path){
    for(var i=0;i<HUBS.length;i++){ for(var j=0;j<HUBS[i].tools.length;j++){ if(HUBS[i].tools[j].href===path) return HUBS[i]; } }
    if(DETAIL[path]){ for(var k=0;k<HUBS.length;k++){ if(HUBS[k].id===DETAIL[path]) return HUBS[k]; } }
    return null;
  }

  function render(){
    var host = document.getElementById("ac-head"); if(!host) return;
    var me = (window.HCPS && HCPS.profile && HCPS.profile()) || null;
    var path = curPath();
    var hub = hubOf(path);
    var who = me ? ('Hi, <b>'+esc(me.name||me.email||"")+'</b>'+(me.role?' · '+esc(me.role):'')) : '';

    var tier1 = '<a href="/admin/"'+(path==="/admin/"?' class="on"':'')+'>Dashboard</a>'
      + HUBS.map(function(h){ var on = hub && hub.id===h.id; return '<a href="'+h.href+'"'+(on?' class="on"':'')+'>'+esc(h.label)+'</a>'; }).join("");

    var tier2 = '';
    if(hub){
      tier2 = '<nav class="ac-sub ac-wrap"><span class="ac-sub-lbl">'+esc(hub.label)+'</span>'
        + hub.tools.map(function(t){ var on = t.href===path; return '<a href="'+t.href+'"'+(on?' class="on"':'')+'>'+esc(t.label)+'</a>'; }).join("")
        + '</nav>';
    }

    host.className = "ac-head";
    host.innerHTML =
      '<div class="ac-wrap ac-top">'
        + '<a class="ac-brand" href="/admin/"><span class="ac-mark">H</span>'
        + '<span class="ac-bt"><b>HCPS Admin</b><span>Operating System</span></span></a>'
        + '<div class="ac-who">' + who + '<a id="ac-taskbadge" href="/admin/tasks.html" class="ac-badge" style="display:none" title="Your open tasks">0</a><button type="button" id="ac-lock">Lock</button></div>'
      + '</div>'
      + '<nav class="ac-nav ac-wrap">' + tier1 + '</nav>'
      + tier2;

    var lb = document.getElementById("ac-lock");
    if(lb) lb.addEventListener("click", function(){
      if(typeof window.lock === "function") { window.lock(); return; }
      if(window.HCPS && HCPS.signOut) HCPS.signOut();
      location.reload();
    });
    loadBadge();
  }
  // Masthead open-task badge — the caller's own count, links to My Tasks. Silent if none/not signed in.
  function loadBadge(){
    if(!(window.HCPS && HCPS.token && HCPS.token())) return;
    fetch("/.netlify/functions/crm-api",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+HCPS.token()},body:JSON.stringify({action:"task_count"})})
      .then(function(r){return r.json();})
      .then(function(j){ var el=document.getElementById("ac-taskbadge"); if(el&&j&&j.ok){ el.textContent="✓ "+j.count; el.style.display=(j.count>0)?"inline-flex":"none"; } })
      .catch(function(){});
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", render); else render();
  window.addEventListener("hcps-token", render);   // refresh the name after sign-in
  window.ACAdmin = { render: render, HUBS: HUBS };
})();

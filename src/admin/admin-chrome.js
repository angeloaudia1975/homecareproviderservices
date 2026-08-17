/* HCPS Admin — shared masthead + hub navigation. Top tier = the four category hubs (each opens its
 * own card-based LANDING PAGE, hub.html?cat=<id>); second tier = EVERY tool inside the current hub.
 * Non-admin staff (sales reps + the Customer Relations Director) get a focused Rep Workspace instead.
 * Pages include this after staff-session.js and drop <header id="ac-head"></header>.
 * HUBS is the single source of truth — the sub-nav AND the landing-page cards both read it. */
(function () {
  "use strict";

  var HUBS = [
    { id:"ordering", label:"Online Ordering", icon:"🛒", accent:"#e07b00",
      purpose:"Run the dealer ordering platform — products, pricing, content & portal access.",
      href:"/admin/hub.html?cat=ordering", tools:[
        { href:"/admin/catalog.html",            label:"Catalog",                    icon:"📦", desc:"Products, SKUs, categories & descriptions per line" },
        { href:"/admin/images.html",             label:"Product Images",             icon:"🖼️", desc:"Upload & manage product photography" },
        { href:"/admin/featured.html",           label:"Featured Products",          icon:"⭐", desc:"Curate the promoted items dealers see first" },
        { href:"/admin/home-editor.html",        label:"Portal Home Content",        icon:"🏠", desc:"Hero banner, promos & the “what's new” tiles" },
        { href:"/admin/dealers.html",            label:"Contract Pricing",           icon:"💲", desc:"Per-dealer negotiated pricing by product" },
        { href:"/admin/dealers.html#logins",     label:"Dealer Portal Accounts",     icon:"🔑", desc:"Registrations, approvals & ordering access" },
        { href:"/admin/order-fulfillment.html",  label:"Order Review & Fulfillment", icon:"🧾", desc:"See, confirm & track submitted dealer orders" }
    ]},
    { id:"website", label:"Website", icon:"🌐", accent:"#2f6bd8",
      purpose:"Manage the public homecareproviderservices.us site & its content.",
      href:"/admin/hub.html?cat=website", tools:[
        { href:"/admin/website.html",               label:"Website Content",     icon:"📝", desc:"Manufacturers, documents, pages, team & settings" },
        { href:"/admin/website.html#manufacturers", label:"Manufacturer Pages",  icon:"🏭", desc:"Partner logos, profiles & catalog links" },
        { href:"/admin/website.html#landing",       label:"Landing Pages",       icon:"📄", desc:"Campaign & program landing pages" },
        { href:"/admin/website.html#media",         label:"Site Images & Media", icon:"🎞️", desc:"Hero images, banners & downloadable assets" },
        { href:"/admin/website.html#nav",           label:"Links & Navigation",  icon:"🔗", desc:"Menus, footer links & redirects" },
        { href:"/admin/traffic.html",               label:"Website Traffic",     icon:"📈", desc:"Live visits, top pages & sources (Plausible)" }
    ]},
    { id:"sales", label:"Sales & Marketing", icon:"🧭", accent:"#1f9d57",
      purpose:"Territories, dealers, reps, CRM & the programs that grow accounts.",
      href:"/admin/hub.html?cat=sales", tools:[
        { href:"/admin/opportunities.html", label:"Today's Opportunities", icon:"💡", desc:"The next best action for every dealer" },
        { href:"/admin/call-list.html",     label:"Who to Call",           icon:"📞", desc:"Daily worklist — intent, overdue reorders & dormant" },
        { href:"/admin/health.html",        label:"Dealer Health",         icon:"❤️", desc:"Every dealer scored on recency, rhythm & trend" },
        { href:"/admin/dealers.html",       label:"Dealer Manager",        icon:"🏢", desc:"Master dealer database, locations & hierarchy" },
        { href:"/admin/dealer.html",        label:"Dealer 360 & CRM",      icon:"📇", desc:"Full account command center — activity, contacts, tasks" },
        { href:"/admin/map.html",           label:"Territory Map",         icon:"🗺️", desc:"Dealer map, drive routes & saved trips" },
        { href:"/admin/staff.html",         label:"Sales Reps & Staff",    icon:"👥", desc:"Team accounts, roles & territory ownership" },
        { href:"/admin/tasks.html",         label:"My Tasks",              icon:"✅", desc:"Your task queue from dealer signals + manual tasks" },
        { href:"/admin/pipeline.html",      label:"Pipeline",              icon:"🔮", desc:"Open deals & weighted pipeline" },
        { href:"/admin/zoho-sync.html",     label:"Zoho Sync",             icon:"🔗", desc:"Two-way CRM sync — accounts, contacts, pipeline, notes" },
        { href:"/admin/cardchamp.html",     label:"CardChamp",             icon:"💳", desc:"Referral activity, conversions & commission" },
        { href:"/admin/audiences.html",     label:"Target Audiences",      icon:"🎯", desc:"Build campaign lists from dealers & contacts" },
        { href:"/admin/campaigns.html",     label:"Campaign Studio",       icon:"✉️", desc:"Brief → audience, copy & sequence → Zoho Campaigns" },
        { href:"/admin/product-interest.html", label:"Product Interest",    icon:"🎯", desc:"Dealers showing product intent who haven't ordered — build a campaign audience" }
    ]},
    { id:"analytics", label:"Sales Data & Analytics", icon:"📊", accent:"#3B599A",
      purpose:"The single source of truth for sales, cadence, opportunities & performance.",
      href:"/admin/hub.html?cat=analytics", tools:[
        { href:"/admin/command-center-360.html", label:"Command Center 360",      icon:"📊", desc:"Interactive BI — drill Summary → Dealer → Product → Order" },
        { href:"/admin/reps.html",               label:"Rep Performance & Goals", icon:"🏆", desc:"Scorecards, sales vs. target, YoY & leaderboard" },
        { href:"/admin/pipeline.html",           label:"Pipeline & Forecast",     icon:"🔮", desc:"Open deals & a 6-month revenue forecast" },
        { href:"/admin/analytics.html",          label:"Analytics Deep Dive",     icon:"📈", desc:"Cadence, orders, master accounts & rep assignments" },
        { href:"/admin/command-center.html",     label:"Manufacturer Performance",icon:"🏭", desc:"Revenue by line, rep, state & company" },
        { href:"/admin/traffic.html",            label:"Website Traffic",         icon:"🌐", desc:"Live visits, top pages & sources" },
        { href:"/admin/import-commissions.html", label:"Commission Import",       icon:"📥", desc:"Load manufacturer reports & reconcile sales" },
        { href:"/admin/sales-import.html",       label:"Sales Report Import",     icon:"📄", desc:"Load order/sales reports — products, qty, branches" },
        { href:"/admin/email-sync.html",         label:"Email Sync",              icon:"📧", desc:"Outlook email → matched to dealers for Dealer 360" },
        { href:"/admin/golden-activity.html",    label:"Golden Activity",         icon:"🟡", desc:"Live Golden portal behavior — logins, product interest, carts & orders" },
        { href:"/admin/activation.html",         label:"Activation & Go-Live",    icon:"🚦", desc:"Dev / Sandbox / Live switch & go-live date" }
    ]}
  ];

  // Detail/child pages that belong to a hub but aren't listed tools.
  var DETAIL = { "/admin/dealer.html":"sales", "/admin/my-commissions.html":"analytics" };

  // Sales reps + Customer Relations Director get a FOCUSED workspace (menu layer only; server-side
  // data scoping restricts what they can actually see).
  var REP_TOOLS = [
    { href:"/admin/rep-home.html",           label:"Portal Home" },
    { href:"/admin/rep-training.html",       label:"Training" },
    { href:"/admin/command-center-360.html", label:"Command Center 360" },
    { href:"/admin/dealers.html",            label:"Dealer 360" },
    { href:"/admin/map.html",                label:"Territory Map" },
    { href:"/admin/health.html",             label:"Dealer Health" },
    { href:"/admin/call-list.html",          label:"Who to Call" },
    { href:"/admin/reps.html",               label:"My Performance" },
    { href:"/admin/my-commissions.html",     label:"My Commissions" },
    { href:"/admin/pipeline.html",           label:"Pipeline" },
    { href:"/admin/tasks.html",              label:"My Tasks" }
  ];
  var ADMIN_ROLES = { president:1, admin:1, owner:1 };
  function isAdmin(me){ return !!(me && ADMIN_ROLES[String((me&&me.role)||"").toLowerCase()]); }

  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }
  // Netlify serves "clean URLs" (/admin/foo, no .html), so every path comparison strips a trailing
  // .html and any #anchor before matching — otherwise the sub-nav vanishes on link-clicked pages.
  function stripHtml(s){ return String(s==null?"":s).split("#")[0].replace(/\.html$/,""); }
  function curPath(){ var p=location.pathname; return /\/admin\/(index\.html)?$/.test(p) ? "/admin/" : p; }
  function samePage(a,b){ return stripHtml(a)===stripHtml(b); }
  function hubById(id){ for(var i=0;i<HUBS.length;i++){ if(HUBS[i].id===id) return HUBS[i]; } return null; }
  // Resolve which hub a page belongs to. Honors an explicit window.ACHUB set by the landing page and
  // tolerates clean URLs (/admin/hub) so the second-tier tool nav loads on the FIRST click.
  function hubOf(path){
    try{ if(window.ACHUB){ var hx=hubById(window.ACHUB); if(hx) return hx; } }catch(e){}
    var np=stripHtml(path);
    if(np==="/admin/hub"){ try{ return hubById(new URLSearchParams(location.search).get("cat")); }catch(e){ return null; } }
    for(var i=0;i<HUBS.length;i++){ for(var j=0;j<HUBS[i].tools.length;j++){ if(samePage(HUBS[i].tools[j].href,np)) return HUBS[i]; } }
    for(var k in DETAIL){ if(samePage(k,np)) return hubById(DETAIL[k]); }
    return null;
  }

  function render(){
    var host = document.getElementById("ac-head"); if(!host) return;
    var me = (window.HCPS && HCPS.profile && HCPS.profile()) || null;
    var path = curPath();
    var admin = isAdmin(me);
    var who = me ? ('Hi, <b>'+esc(me.name||me.email||"")+'</b>'+(me.role?' · '+esc(me.role):'')) : '';

    var tier1, tier2='';
    if(admin){
      var hub = hubOf(path);
      tier1 = '<a href="/admin/"'+(path==="/admin/"?' class="on"':'')+'>Dashboard</a>'
        + HUBS.map(function(h){ var on = hub && hub.id===h.id; return '<a href="'+h.href+'"'+(on?' class="on"':'')+'>'+esc(h.label)+'</a>'; }).join("");
      if(hub){
        tier2 = '<nav class="ac-sub ac-wrap"><span class="ac-sub-lbl">'+esc(hub.label)+'</span>'
          + hub.tools.map(function(t){ var on = samePage(t.href,path); return '<a href="'+t.href+'"'+(on?' class="on"':'')+'>'+esc(t.label)+'</a>'; }).join("")
          + '</nav>';
      }
    } else {
      // Focused rep workspace — one clean row of the rep's tools, active one highlighted.
      tier1 = REP_TOOLS.map(function(t){ var on = samePage(t.href,path); return '<a href="'+t.href+'"'+(on?' class="on"':'')+'>'+esc(t.label)+'</a>'; }).join("");
    }

    host.className = "ac-head";
    host.innerHTML =
      '<div class="ac-wrap ac-top">'
        + '<a class="ac-brand" href="'+(admin?'/admin/':'/admin/rep-home.html')+'"><span class="ac-mark">H</span>'
        + '<span class="ac-bt"><b>'+(admin?'HCPS Connect 360':'HCPS Sales')+'</b><span>'+(admin?'Operating System':'Rep Workspace')+'</span></span></a>'
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
  window.ACAdmin = { render: render, HUBS: HUBS, hubById: hubById, isAdmin: isAdmin };

  // Usage capture (Phase 3): load the silent rep tracker once per page. Best-effort — a no-op if the
  // user isn't signed in or the capture endpoint/tables aren't set up yet.
  try{ if(!window.__hcpsTrack){ window.__hcpsTrack=1; var _t=document.createElement("script"); _t.src="/admin/rep-track.js"; _t.defer=true; (document.head||document.documentElement).appendChild(_t); } }catch(e){}
})();

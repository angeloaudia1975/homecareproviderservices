/* ═══════════════════════════════════════════════════════════════════════════
   HCPS CONNECT 360 — THE NAVIGATION RULE
   ───────────────────────────────────────────────────────────────────────────
   Every feature in Connect 360 obeys four rules. They are enforced by code below
   and checkable at any time by running acNavAudit() in the browser console.

   1. ONE OWNER. Every page belongs to exactly one category. Add the tool to that
      category's `tools` array in HUBS — this file is the single source of truth for
      the sub-nav, the category landing pages AND the dashboard.

   2. A SHORTCUT IS NOT AN OWNER. A page may be listed in a second category when the
      relationship is genuinely useful (Pipeline is sales work and a forecast). Mark
      that second entry `xref:true`. An xref links to the page; it never captures it.
      Where the owner isn't obvious from array order, mark the real one `owns:true`.
      Without this, hubOf() returned whichever category was declared first, which is
      why opening Dealer Manager used to land you inside Online Ordering.

   3. RANK IT. Add the tool's label to ORDER[<category>] in the position it deserves:
      most important → most frequently used → supporting → advanced/specialised. An
      unranked tool still works; it just sorts to the end of its category.

   4. MAKE IT FAVOURITABLE. Any real tool page automatically gets the ☆ in the
      masthead and can be pinned to a user's own dashboard. Nothing to configure —
      but a tool that never appears in HUBS can never be favourited, which is another
      reason rule 1 matters.

   After adding anything, open any admin page and run acNavAudit(). Silence is a pass.
   ═══════════════════════════════════════════════════════════════════════════ */

/* HCPS Admin — shared masthead + hub navigation. Top tier = the four category hubs (each opens its
 * own card-based LANDING PAGE, hub.html?cat=<id>); second tier = EVERY tool inside the current hub.
 * Non-admin staff (sales reps + the Customer Relations Director) get a focused Rep Workspace instead.
 * Pages include this after staff-session.js and drop <header id="ac-head"></header>.
 * HUBS is the single source of truth — the sub-nav AND the landing-page cards both read it. */
(function () {
  "use strict";

  // ── SINGLE SOURCE OF TRUTH ───────────────────────────────────────────────
  // Every admin tool lives here exactly once. This one array drives (1) the
  // masthead sub-nav, (2) the category landing pages (hub.html), AND (3) the
  // dashboard grid (index.html). Add a tool here → it appears in all three.
  // status: "live" (default) | "new" | "planned". A "planned" tool (or any tool
  // with an empty href) is shown on the dashboard as a roadmap tile but is
  // hidden from the sub-nav and category pages until it has a real page.
  var HUBS = [
    { id:"ordering", label:"Online Ordering", icon:"🛒", accent:"#e07b00",
      dashTitle:"HCPS Online Ordering",
      purpose:"Run the dealer ordering platform — products, pricing, content & portal access.",
      href:"/admin/hub.html?cat=ordering",
      // One commerce catalog, four views of it. `groups` orders the sections in the sub-nav and on
      // the hub page; every tool below declares which view it belongs to. These are VIEWS of the same
      // product & SKU records — not separate databases.
      groups:[
        { id:"catalog",  label:"Catalog Management",     blurb:"The master product & SKU records — what exists, how it's classified, what it costs." },
        { id:"enrich",   label:"Product Enrichment",     blurb:"Import, structure, enrich and publish a manufacturer's catalog into Partner 360." },
        { id:"commerce", label:"Commerce Management",    blurb:"Dealer-specific pricing, orders and the rules each manufacturer trades under." },
        { id:"partner",  label:"Partner 360 Management", blurb:"What dealers actually see and can reach in the ordering portal." }
      ],
      tools:[
        { href:"/admin/catalog.html",            label:"Product Catalog",            icon:"📦", group:"catalog",  desc:"The master product & SKU records — codes, names, categories, list & MSRP pricing and active status, per manufacturer line" },
        { href:"/admin/product-content-review.html", label:"Product Content Enrichment & Review", icon:"🔬", status:"new", group:"enrich", desc:"The enrichment workspace: start a new line, import catalog & website sources, review SKU structure, fix categories & families, enrich content, images & documents, run Price Check and Catalog Health, then publish to Partner 360" },
        { href:"/admin/images.html",             label:"Product Images",             icon:"🖼️", group:"enrich",   desc:"Upload & manage product photography used across the catalog and dealer portal" },
        { href:"/admin/dealers.html",            label:"Contract Pricing",           icon:"💲", group:"commerce", xref:true, desc:"Per-dealer negotiated pricing that overrides the standard dealer price" },
        { href:"/admin/order-fulfillment.html",  label:"Order Review & Fulfillment", icon:"🧾", group:"commerce", desc:"See, confirm & track submitted dealer orders" },
        { href:"",                               label:"Manufacturer Lines & Freight", icon:"🚚", status:"planned", group:"commerce", desc:"Line setup, freight rules & territory eligibility" },
        { href:"/admin/featured.html",           label:"Featured Products",          icon:"⭐", group:"partner",  desc:"Curate the promoted items dealers see first" },
        { href:"/admin/home-editor.html",        label:"Portal Home Content",        icon:"🏠", group:"partner",  desc:"Hero banner, promos & the “what's new” tiles" },
        { href:"/admin/dealers.html#logins",     label:"Dealer Portal Accounts",     icon:"🔑", group:"partner", xref:true,  desc:"Registrations, approvals & which manufacturer lines each dealer can order" },
        { href:"https://hcpsonlineordering.netlify.app/", label:"Published Catalog", icon:"👁", group:"partner", ext:true, desc:"Open the live Partner 360 storefront exactly as a dealer sees it — the published result of everything above" }
    ]},
    { id:"website", label:"Website", icon:"🌐", accent:"#2f6bd8", dashTitle:"HCPS Website",
      purpose:"Manage the public homecareproviderservices.us site & its content.",
      href:"/admin/hub.html?cat=website", tools:[
        { href:"/admin/website.html",               label:"Website Content",     icon:"📝", desc:"Manufacturers, documents, pages, team & settings" },
        { href:"/admin/website.html#manufacturers", label:"Manufacturer Pages",  icon:"🏭", desc:"Partner logos, profiles & catalog links" },
        { href:"/admin/website.html#landing",       label:"Landing Pages",       icon:"📄", desc:"Campaign & program landing pages" },
        { href:"/admin/website.html#media",         label:"Site Images & Media", icon:"🎞️", desc:"Hero images, banners & downloadable assets" },
        { href:"/admin/website.html#nav",           label:"Links & Navigation",  icon:"🔗", desc:"Menus, footer links & redirects" },
        { href:"/admin/traffic.html",               label:"Website Traffic",     icon:"📈", owns:true, desc:"Live visits, top pages & sources (Plausible)" }
    ]},
    { id:"sales", label:"Sales & Marketing", icon:"🧭", accent:"#1f9d57", dashTitle:"Sales & Marketing",
      purpose:"Territories, dealers, reps, CRM & the programs that grow accounts.",
      href:"/admin/hub.html?cat=sales", tools:[
        { href:"/admin/opportunities.html", label:"Today's Opportunities", icon:"💡", desc:"The next best action for every dealer" },
        { href:"/admin/call-list.html",     label:"Who to Call",           icon:"📞", owns:true, desc:"Daily worklist — intent, overdue reorders & dormant" },
        { href:"/admin/health.html",        label:"Dealer Health",         icon:"❤️", desc:"Every dealer scored on recency, rhythm & trend" },
        { href:"/admin/dealers.html",       label:"Dealer Manager",        icon:"🏢", owns:true, desc:"Master dealer database, locations & hierarchy" },
        { href:"/admin/account-assignment.html", label:"Account Assignment", icon:"🧑‍💼", desc:"Assign every dealer to a sales rep — bulk & fast" },
        { href:"/admin/dealer.html",        label:"Dealer 360 & CRM",      icon:"📇", desc:"Full account command center — activity, contacts, tasks" },
        { href:"/admin/map.html",           label:"Territory Map",         icon:"🗺️", desc:"Dealer map, drive routes & saved trips" },
        { href:"/admin/scheduled-routes.html", label:"Scheduled Routes",   icon:"📅", desc:"Mobile field companion — today's visits, packages & voice notes" },
        { href:"/admin/territory.html",     label:"Territory Lines",       icon:"📍", desc:"Which manufacturer lines you represent in each state" },
        { href:"/admin/map.html#handout",   label:"Partnership Snapshots", icon:"📋", desc:"Printable dealer business-case handouts" },
        { href:"/admin/staff.html",         label:"Sales Reps & Staff",    icon:"👥", desc:"Team accounts, roles & territory ownership" },
        { href:"/admin/tasks.html",         label:"My Tasks & Follow-Up Engine", icon:"✅", desc:"Your task queue — auto-built from dealer signals plus manual tasks" },
        { href:"/admin/pipeline.html",      label:"Pipeline",              icon:"🔮", owns:true, desc:"Open deals & weighted pipeline" },
        { href:"/admin/zoho-sync.html",     label:"Zoho Sync",             icon:"🔗", desc:"Two-way CRM sync — accounts, contacts, pipeline, notes" },
        { href:"/admin/cardchamp.html",     label:"CardChamp",             icon:"💳", desc:"Referral activity, conversions & commission" },
        { href:"/admin/audiences.html",     label:"Target Audiences",      icon:"🎯", desc:"Build campaign lists from dealers & contacts" },
        { href:"/admin/campaigns.html",     label:"Campaign Studio",       icon:"✉️", desc:"Brief → audience, copy & sequence → Zoho Campaigns" },
        { href:"/admin/ai-style-guide.html", label:"AI Style Guide",       icon:"🖋️", status:"new", desc:"The writing rules every AI email generator follows — edit once, applies everywhere" },
        { href:"/admin/product-interest.html", label:"Product Interest",    icon:"🎯", status:"new", desc:"Dealers showing product intent who haven't ordered — build a campaign audience" },
        { href:"/admin/scheduling-console.html", label:"Scheduling Console", icon:"📆", desc:"Dealer Hub service requests — assign a rep, book Outlook & log to Dealer 360" }
    ]},
    { id:"analytics", label:"Sales Data & Analytics", icon:"📊", accent:"#3B599A", dashTitle:"Sales Data & Analytics",
      purpose:"The single source of truth for sales, cadence, opportunities & performance.",
      href:"/admin/hub.html?cat=analytics", tools:[
        { href:"/admin/command-center-360.html", label:"Command Center 360",      icon:"📊", desc:"Interactive BI — drill Summary → Dealer → Product → Order" },
        { href:"/admin/reps.html",               label:"Rep Performance & Goals", icon:"🏆", desc:"Scorecards, sales vs. target, YoY & leaderboard" },
        { href:"/admin/commission-report.html",  label:"Commission Report",       icon:"💵", status:"new", desc:"Total → rep share → President share, by rep & by month" },
        { href:"/admin/rep-usage.html",          label:"Rep Usage & Adoption",    icon:"🧑‍💻", status:"new", desc:"Who's signing in, how actively & whether they're using the tools" },
        { href:"/admin/pipeline.html",           label:"Pipeline & Forecast",     icon:"🔮", xref:true, desc:"Open deals & a 6-month revenue forecast" },
        { href:"/admin/analytics.html",          label:"Analytics Deep Dive",     icon:"📈", desc:"Cadence, orders, master accounts & rep assignments" },
        { href:"/admin/command-center.html",     label:"Manufacturer Sales Performance",icon:"🏭", desc:"Revenue by line, rep, state & company" },
        { href:"/admin/call-list.html",          label:"Dealer Activity & Cadence",icon:"🔁", xref:true, desc:"Who's buying, who's lapsing, who's due to reorder" },
        { href:"/admin/command-center.html",     label:"Opportunities & Account Trends", icon:"💡", desc:"Growth openings & at-risk (declining) accounts" },
        { href:"/admin/traffic.html",            label:"Website Traffic",         icon:"🌐", xref:true, desc:"Live visits, top pages & sources" },
        { href:"/admin/import-commissions.html", label:"Commission Report Import", icon:"📥", desc:"Load manufacturer reports & reconcile sales" },
        { href:"/admin/sales-import.html",       label:"Sales Report Import",     icon:"📄", desc:"Load order/sales reports — products, qty, branches" },
        { href:"/admin/email-sync.html",         label:"Email Sync & Deliverability", icon:"📧", desc:"Outlook email matched to dealers — plus SPF/DKIM/DMARC monitoring" },
        { href:"/admin/golden-activity.html",    label:"Golden Activity",         icon:"🟡", status:"new", desc:"Live Golden portal behavior — logins, product interest, carts & orders" },
        { href:"/admin/activation.html",         label:"Activation & Go-Live",    icon:"🚦", desc:"Dev / Sandbox / Live switch & go-live date" },
        { href:"",                               label:"Reports & Exports",       icon:"📤", status:"planned", desc:"Scheduled reports & data exports" }
    ]}
  ];

  /* ── ORDER WITHIN A CATEGORY ─────────────────────────────────────────────
     Main Category → Most Important → Most Frequently Used → Supporting → Advanced.
     Declared here as one ordered list per category so the priority is readable and
     editable in a single place, instead of being implied by the order of a 20-entry
     array literal that nobody wants to reshuffle. Anything not named here keeps its
     position and sorts after the ranked tools, so adding a tool never breaks the list —
     it just lands at the end until someone ranks it.
     Ordering's four groups already sequence the section; these rank within each group. */
  var ORDER = {
    ordering: [
      "Product Catalog",
      "Product Content Enrichment & Review", "Product Images",
      "Order Review & Fulfillment", "Contract Pricing", "Manufacturer Lines & Freight",
      "Dealer Portal Accounts", "Featured Products", "Portal Home Content", "Published Catalog"
    ],
    website: [
      "Website Content", "Manufacturer Pages", "Landing Pages",
      "Site Images & Media", "Links & Navigation", "Website Traffic"
    ],
    sales: [
      // Daily: what a rep opens first thing.
      "Today's Opportunities", "Who to Call", "Dealer 360 & CRM", "My Tasks & Follow-Up Engine",
      // Frequent: the working set through the week.
      "Dealer Health", "Dealer Manager", "Territory Map", "Scheduled Routes", "Pipeline",
      // Supporting: campaigns and scheduling around the core work.
      "Account Assignment", "Scheduling Console", "Target Audiences", "Campaign Studio",
      "Product Interest", "Partnership Snapshots",
      // Setup & specialized: touched rarely, mostly by an admin.
      "Sales Reps & Staff", "Territory Lines", "Zoho Sync", "CardChamp", "AI Style Guide"
    ],
    analytics: [
      // The numbers people actually open.
      "Command Center 360", "Rep Performance & Goals", "Dealer Activity & Cadence",
      // Regular reporting.
      "Manufacturer Sales Performance", "Opportunities & Account Trends",
      "Pipeline & Forecast", "Analytics Deep Dive", "Commission Report",
      // Supporting signals.
      "Rep Usage & Adoption", "Golden Activity", "Website Traffic", "Email Sync & Deliverability",
      // Feeds the data in, and system switches — infrequent, admin-only.
      "Sales Report Import", "Commission Report Import", "Activation & Go-Live", "Reports & Exports"
    ]
  };
  /* Apply the declared order. Stable: unranked tools keep their relative order at the end. */
  function rankTools(hub){
    var order=ORDER[hub.id]; if(!order) return hub.tools;
    var pos={}; order.forEach(function(l,i){ pos[l]=i; });
    return hub.tools.map(function(t,i){ return {t:t,i:i,r:(pos[t.label]!=null?pos[t.label]:1e6+i)}; })
      .sort(function(a,b){ return a.r-b.r || a.i-b.i; })
      .map(function(x){ return x.t; });
  }
  HUBS.forEach(function(h){ h.tools = rankTools(h); });

  // Detail/child pages that belong to a hub but aren't listed tools.
  var DETAIL = { "/admin/dealer.html":"sales", "/admin/my-commissions.html":"analytics" };

  // Sales reps + Customer Relations Director get a FOCUSED workspace (menu layer only; server-side
  // data scoping restricts what they can actually see).
  var REP_TOOLS = [
    { href:"/admin/rep-home.html",           label:"Portal Home" },
    { href:"/admin/rep-training.html",       label:"Training" },
    { href:"/admin/command-center-360.html", label:"Command Center 360" },
    { href:"/admin/dealer.html",             label:"Dealer 360 & CRM" },
    { href:"/admin/map.html",                label:"Territory Map" },
    { href:"/admin/scheduled-routes.html",   label:"Scheduled Routes" },
    { href:"/admin/health.html",             label:"Dealer Health" },
    { href:"/admin/call-list.html",          label:"Who to Call" },
    { href:"/admin/scheduling-console.html", label:"Scheduling" },
    { href:"/admin/reps.html",               label:"My Performance" },
    { href:"/admin/my-commissions.html",     label:"My Commissions" },
    { href:"/admin/pipeline.html",           label:"Pipeline" },
    { href:"/admin/tasks.html",              label:"My Tasks" }
  ];
  var ADMIN_ROLES = { president:1, admin:1, owner:1 };
  function isAdmin(me){ return !!(me && ADMIN_ROLES[String((me&&me.role)||"").toLowerCase()]); }

  // ---- View as Rep (impersonation) ----
  // When active, the browser holds a real rep session (minted server-side) and the admin's own
  // session is stashed so it can be restored on exit. A persistent banner shows on every page.
  var IMP_KEY = "hcps_impersonation";      // marker + meta {by_name, rep_name, rep_email, at}
  var IMP_STASH = "hcps_imp_admin";        // the admin's own session, stashed for restore
  var SESS_KEYS = ["hcps_staff_token","hcps_staff_profile","hcps_staff_refresh","hcps_staff_expires"];
  function lget(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lset(k,v){ try{ if(v==null) localStorage.removeItem(k); else localStorage.setItem(k,v); }catch(e){} }
  function impGet(){ try{ return JSON.parse(lget(IMP_KEY)||"null"); }catch(e){ return null; } }
  window.ACImpersonate = {
    active: impGet,
    // Begin viewing as a rep: stash the admin session, mark impersonation, activate the rep session.
    start: function(session, meta){
      var stash={}; SESS_KEYS.forEach(function(k){ stash[k]=lget(k); });
      lset(IMP_STASH, JSON.stringify(stash));
      lset(IMP_KEY, JSON.stringify(meta||{}));
      if(window.HCPS && HCPS.setSession) HCPS.setSession(session);   // activate rep session
      location.href = "/admin/rep-home.html";
    },
    // Exit: restore the admin session, clear the markers, log the end, return to Staff.
    exit: function(){
      var meta=impGet();
      try{
        var stash=JSON.parse(lget(IMP_STASH)||"null");
        if(stash){ SESS_KEYS.forEach(function(k){ lset(k, stash[k]); }); }
      }catch(e){}
      lset(IMP_KEY, null); lset(IMP_STASH, null);
      // Best-effort end-of-session audit, using the now-restored admin token.
      try{
        var tok=lget("hcps_staff_token");
        if(tok && meta){ fetch("/.netlify/functions/staff-auth",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+tok},body:JSON.stringify({action:"impersonate_end",email:meta.rep_email,target_name:meta.rep_name})}).catch(function(){}); }
      }catch(e){}
      location.href = "/admin/staff.html";
    }
  };

  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }
  // Netlify serves "clean URLs" (/admin/foo, no .html), so every path comparison strips a trailing
  // .html and any #anchor before matching — otherwise the sub-nav vanishes on link-clicked pages.
  function stripHtml(s){ return String(s==null?"":s).split("#")[0].replace(/\.html$/,""); }
  function curPath(){ var p=location.pathname; return /\/admin\/(index\.html)?$/.test(p) ? "/admin/" : p; }
  function samePage(a,b){ return stripHtml(a)===stripHtml(b); }
  function hubById(id){ for(var i=0;i<HUBS.length;i++){ if(HUBS[i].id===id) return HUBS[i]; } return null; }
  // A tool is "live-navigable" (shown in sub-nav & category pages) when it has a real page and
  // isn't marked planned. Planned/hrefless tools still appear on the dashboard as roadmap tiles.
  function liveTool(t){ return !!(t && t.href) && t.status !== "planned"; }
  // Resolve which hub a page belongs to. Honors an explicit window.ACHUB set by the landing page and
  // tolerates clean URLs (/admin/hub) so the second-tier tool nav loads on the FIRST click.
  /* ── THE NAVIGATION RULE ─────────────────────────────────────────────────
     A page belongs to exactly ONE category. Some pages are deliberately reachable
     from a second category as a shortcut — Pipeline is sales work AND a forecast —
     and those entries carry `xref:true`. An xref is a link, never an owner.

     Without this, hubOf() returned whichever hub happened to be listed first in
     HUBS, so opening Dealer Manager or Dealer Portal Accounts dropped you into
     Online Ordering's sub-nav: /admin/dealers.html is claimed by Online Ordering
     ("Contract Pricing", "Dealer Portal Accounts") and by Sales & Marketing
     ("Dealer Manager"), and Online Ordering is declared first. The page you opened
     was right; the category around it was not.

     Resolution order — explicit owner, then a non-xref listing, then DETAIL. An
     xref is only used as a last resort, so a shortcut can never capture a page. */
  function ownerOf(np){
    var i,j,t;
    for(i=0;i<HUBS.length;i++){ for(j=0;j<HUBS[i].tools.length;j++){ t=HUBS[i].tools[j];
      if(t.owns && samePage(t.href,np)) return HUBS[i]; } }
    for(i=0;i<HUBS.length;i++){ for(j=0;j<HUBS[i].tools.length;j++){ t=HUBS[i].tools[j];
      if(!t.xref && samePage(t.href,np)) return HUBS[i]; } }
    for(var k in DETAIL){ if(samePage(k,np)) return hubById(DETAIL[k]); }
    for(i=0;i<HUBS.length;i++){ for(j=0;j<HUBS[i].tools.length;j++){ t=HUBS[i].tools[j];
      if(samePage(t.href,np)) return HUBS[i]; } }
    return null;
  }
  function hubOf(path){
    try{ if(window.ACHUB){ var hx=hubById(window.ACHUB); if(hx) return hx; } }catch(e){}
    var np=stripHtml(path);
    if(np==="/admin/hub"){ try{ return hubById(new URLSearchParams(location.search).get("cat")); }catch(e){ return null; } }
    return ownerOf(np);
  }

  /* Self-check for the rule above: every page owned by exactly one category, every
     cross-listing declared. Run acNavAudit() in the console after adding a tool —
     it is the guardrail that keeps this from drifting back. */
  function navAudit(){
    var claims={}, problems=[];
    HUBS.forEach(function(h){ h.tools.forEach(function(t){
      if(!t.href || t.ext || t.status==="planned") return;
      var p=stripHtml(t.href);
      (claims[p]=claims[p]||[]).push({hub:h.id,label:t.label,xref:!!t.xref,owns:!!t.owns});
    }); });
    Object.keys(claims).forEach(function(p){
      var c=claims[p], owners=c.filter(function(x){ return !x.xref; });
      var hubs={}; owners.forEach(function(x){ hubs[x.hub]=1; });
      if(Object.keys(hubs).length>1)
        problems.push({page:p, issue:"claimed as owner by "+Object.keys(hubs).join(" + ")+" — mark the secondary one xref:true",
          entries:c.map(function(x){ return x.hub+":"+x.label+(x.xref?" (xref)":""); })});
      if(owners.length===0)
        problems.push({page:p, issue:"only ever cross-listed — one category must own it", entries:c.map(function(x){ return x.hub+":"+x.label; })});
    });
    if(problems.length) console.warn("HCPS nav audit — "+problems.length+" issue(s)", problems);
    else console.log("HCPS nav audit — every page has exactly one owning category.");
    return problems;
  }
  try{ window.acNavAudit=navAudit; window.ACHUBS=HUBS; }catch(e){}

  /* ── Favorites ───────────────────────────────────────────────────────────
     A person pins the tools they actually use; they appear on their dashboard. Stored
     against their own staff record server-side, so the same shortcuts follow them to
     any machine — a list kept only in this browser would be a different dashboard on
     their laptop and their phone. Cached in memory for the page's lifetime. */
  var FAVS=null, FAVQ=null;
  function favApi(body){
    var t=(window.HCPS&&HCPS.token&&HCPS.token())||null;
    return fetch("/.netlify/functions/staff-auth",{method:"POST",
      headers:{"content-type":"application/json",authorization:"Bearer "+t},
      body:JSON.stringify(body)}).then(function(r){ return r.json(); }).catch(function(){ return null; });
  }
  function loadFavs(){
    if(FAVS) return Promise.resolve(FAVS);
    if(FAVQ) return FAVQ;
    FAVQ=favApi({action:"my_favorites"}).then(function(j){
      FAVS=(j&&j.ok&&Array.isArray(j.favorites))?j.favorites:[]; FAVQ=null; return FAVS;
    });
    return FAVQ;
  }
  function isFav(href){ return !!(FAVS && FAVS.some(function(x){ return samePage(x,href); })); }
  function toggleFav(href){
    return loadFavs().then(function(list){
      var next = isFav(href) ? list.filter(function(x){ return !samePage(x,href); }) : list.concat([href]);
      return favApi({action:"save_favorites",favorites:next}).then(function(j){
        FAVS=(j&&j.ok&&Array.isArray(j.favorites))?j.favorites:next;
        try{ window.dispatchEvent(new CustomEvent("hcps-favs",{detail:FAVS})); }catch(e){}
        return FAVS;
      });
    });
  }
  /* The star only appears on a page that IS a tool — favouriting a hub landing page or
     the dashboard itself would put a shortcut to a list of shortcuts on the dashboard. */
  function toolAt(np){
    for(var i=0;i<HUBS.length;i++){ for(var j=0;j<HUBS[i].tools.length;j++){
      var t=HUBS[i].tools[j];
      if(t.href && !t.ext && t.status!=="planned" && samePage(t.href,np)) return t; } }
    return null;
  }
  function wireFavButton(path){
    var btn=document.getElementById("ac-fav"); if(!btn) return;
    var np=stripHtml(path);
    if(np==="/admin/" || np==="/admin/hub" || !toolAt(np)){ btn.style.display="none"; return; }
    var here=(toolAt(np)||{}).href||path;
    btn.style.display="";
    var paint=function(){ var on=isFav(here);
      btn.textContent=on?"★":"☆"; btn.classList.toggle("on",on);
      btn.title=on?"Remove from your dashboard favorites":"Add this page to your dashboard favorites"; };
    loadFavs().then(paint);
    btn.onclick=function(){ btn.disabled=true; toggleFav(here).then(function(){ paint(); btn.disabled=false; }); };
  }

  function ensureFavStyles(){
    if(document.getElementById("ac-fav-css")) return;
    var st=document.createElement("style"); st.id="ac-fav-css";
    st.textContent=".ac-favbtn{background:transparent;border:1px solid rgba(255,255,255,.25);color:#ffd479;border-radius:8px;"
      +"width:30px;height:28px;font-size:15px;line-height:1;cursor:pointer;padding:0;margin-right:2px}"
      +".ac-favbtn:hover{background:rgba(255,255,255,.10)}.ac-favbtn.on{color:#ffc233;border-color:rgba(255,194,51,.55)}"
      +".ac-favbtn[disabled]{opacity:.5;cursor:default}";
    (document.head||document.documentElement).appendChild(st);
  }
  function ensureImpStyles(){
    if(document.getElementById("ac-imp-css")) return;
    var s=document.createElement("style"); s.id="ac-imp-css";
    s.textContent=".ac-imp{display:flex;align-items:center;gap:10px;background:#7a1f1f;color:#fff;padding:7px 16px;font-size:13px;font-weight:600}.ac-imp b{color:#ffe0a3}.ac-imp-tx{flex:1;min-width:0}.ac-imp-dot{font-size:15px}.ac-imp button{background:#fff;color:#7a1f1f;border:0;border-radius:7px;padding:5px 12px;font-weight:800;font-size:12px;cursor:pointer;white-space:nowrap}.ac-imp button:hover{background:#ffe9e9}";
    (document.head||document.documentElement).appendChild(s);
  }
  function render(){
    var host = document.getElementById("ac-head"); if(!host) return;
    ensureImpStyles(); ensureFavStyles();
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
        var live = hub.tools.filter(liveTool);
        var linkOf = function(t){ var on = samePage(t.href,path);
          var cls = (on?'on':'') + (t.ext?(on?' ac-ext':'ac-ext'):'');
          return '<a href="'+t.href+'"'+(cls?' class="'+cls+'"':'')+(t.ext?' target="_blank" rel="noopener"':'')+'>'+esc(t.label)+'</a>'; };
        var inner;
        if(hub.groups && hub.groups.length){
          // Grouped sub-nav: the hub's tools are VIEWS of one catalog, shown under their view name.
          inner = hub.groups.map(function(g){
            var ts = live.filter(function(t){ return t.group===g.id; });
            if(!ts.length) return '';
            return '<span class="ac-sub-grp">'+esc(g.label)+'</span>' + ts.map(linkOf).join("");
          }).join("");
          var ungrouped = live.filter(function(t){ return !t.group || !hub.groups.some(function(g){ return g.id===t.group; }); });
          if(ungrouped.length) inner += '<span class="ac-sub-grp">More</span>' + ungrouped.map(linkOf).join("");
        } else {
          inner = live.map(linkOf).join("");
        }
        tier2 = '<nav class="ac-sub ac-wrap"><span class="ac-sub-lbl">'+esc(hub.label)+'</span>' + inner + '</nav>';
      }
    } else {
      // Focused rep workspace — one clean row of the rep's tools, active one highlighted.
      tier1 = REP_TOOLS.map(function(t){ var on = samePage(t.href,path); return '<a href="'+t.href+'"'+(on?' class="on"':'')+'>'+esc(t.label)+'</a>'; }).join("");
    }

    // While viewing as a rep, a persistent banner sits above the masthead on every page.
    var imp = impGet();
    var banner = imp
      ? '<div class="ac-imp"><span class="ac-imp-dot">🔎</span>'
        + '<span class="ac-imp-tx">Viewing as <b>'+esc(imp.rep_name||imp.rep_email||"rep")+'</b> — admin session'
        + (imp.by_name?' started by '+esc(imp.by_name):'')+'.</span>'
        + '<button type="button" id="ac-imp-exit">Exit view-as</button></div>'
      : '';

    host.className = "ac-head";
    host.innerHTML =
      banner
      + '<div class="ac-wrap ac-top">'
        + '<a class="ac-brand" href="'+(admin?'/admin/':'/admin/rep-home.html')+'"><span class="ac-mark">H</span>'
        + '<span class="ac-bt"><b>'+(admin?'HCPS Connect 360':'HCPS Sales')+'</b><span>'+(admin?'Operating System':'Rep Workspace')+'</span></span></a>'
        + '<div class="ac-who">' + who + '<button type="button" id="ac-fav" class="ac-favbtn" title="Add this page to your dashboard favorites" style="display:none">☆</button><a id="ac-taskbadge" href="/admin/tasks.html" class="ac-badge" style="display:none" title="Your open tasks">0</a><button type="button" id="ac-lock">'+(imp?'Exit view-as':'Lock')+'</button></div>'
      + '</div>'
      + '<nav class="ac-nav ac-wrap">' + tier1 + '</nav>'
      + tier2;

    var exitBtn = document.getElementById("ac-imp-exit");
    if(exitBtn) exitBtn.addEventListener("click", function(){ window.ACImpersonate.exit(); });

    wireFavButton(path);                 // the ☆ that pins this tool to the user's dashboard

    var lb = document.getElementById("ac-lock");
    if(lb) lb.addEventListener("click", function(){
      if(impGet()){ window.ACImpersonate.exit(); return; }   // don't sign the admin out — just exit view-as
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
  window.ACAdmin = { render: render, HUBS: HUBS, hubById: hubById, isAdmin: isAdmin, liveTool: liveTool,
    loadFavs: loadFavs, toggleFav: toggleFav, isFav: isFav, toolAt: toolAt, navAudit: navAudit,
    favs: function(){ return FAVS||[]; } };

  // Usage capture (Phase 3): load the silent rep tracker once per page. Best-effort — a no-op if the
  // user isn't signed in or the capture endpoint/tables aren't set up yet.
  try{ if(!window.__hcpsTrack){ window.__hcpsTrack=1; var _t=document.createElement("script"); _t.src="/admin/rep-track.js"; _t.defer=true; (document.head||document.documentElement).appendChild(_t); } }catch(e){}

  // Guided page tours ("Take a tour"): load the tour engine once per page. It self-gates — a floating
  // launcher only appears on pages that actually have a tour defined.
  try{ if(!window.__hcpsTour){ window.__hcpsTour=1; var _u=document.createElement("script"); _u.src="/admin/rep-tour.js"; _u.defer=true; (document.head||document.documentElement).appendChild(_u); } }catch(e){}
})();

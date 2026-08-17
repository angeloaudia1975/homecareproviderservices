/* HCPS Connect 360 — guided page tours ("Take a tour").
 * Dependency-free. Loaded on every admin page by admin-chrome.js. On pages that have a tour it drops
 * a floating "Take a tour" button; clicking it spotlights real elements on the page and walks the rep
 * through what each does. Auto-offers once on the Rep Portal home. Exposes window.HCPSTour.
 * Tours degrade gracefully — if a target element isn't on the page, that step shows centered instead. */
(function () {
  "use strict";

  // Page slug -> tour. Each step: {el:<selector|null>, title, body}. Null/missing el = centered step.
  var TOURS = {
    "rep-home": { steps: [
      { el:null, title:"Welcome to your Rep Portal", body:"This is your sales workspace. Everything here is scoped to your accounts — you only ever see your dealers, territory, tasks, and commissions." },
      { el:".today", title:"Start your day here", body:"Quick jumps to today's calls, your open tasks, planning a route, and reviewing dealer health." },
      { el:".tiles", title:"Your tools", body:"Every tool you need, as a tile. Click any one to open it. Each has a 'How to use' link if you're not sure." },
      { el:".train", title:"Training & how-to", body:"Short how-to cards for each tool. For the deep version — playbooks and a daily rhythm — open the full Training Center." },
      { el:"#ac-head .ac-nav", title:"Your menu is always up top", body:"This bar rides along on every page so you can jump between tools without coming back here." },
      { el:null, title:"Tip", body:"See 'Take a tour' on a page? Tap it for a quick walkthrough of that screen. You can replay any tour anytime." }
    ]},
    "dealers": { steps: [
      { el:"h1", title:"Dealer 360", body:"Your accounts. Search or click a dealer to open their complete record." },
      { el:null, title:"One screen per account", body:"Opening a dealer gives you their whole story: sales history, contacts, tasks, notes, recent activity, and email — all in one place." },
      { el:"#ac-head .ac-nav", title:"Work from here", body:"Open an account before every call or visit, then log your touch there so nothing slips." }
    ]},
    "dealer": { steps: [
      { el:"h1", title:"The full account picture", body:"Everything about this dealer in one place — history, health, contacts, tasks, notes, activity, and matched email." },
      { el:"#emailCard", title:"Their email, right here", body:"Outlook messages matched to this dealer show on the timeline. Click any message to read the whole thing while you're on the phone." },
      { el:null, title:"Log as you go", body:"Log a touch (call / visit / email), add a note, and keep contacts current while you're in the account — that's how follow-ups get created." }
    ]},
    "map": { steps: [
      { el:"h1", title:"Territory Map & Routing", body:"All your dealers plotted on a map." },
      { el:null, title:"Plan the shortest drive", body:"Pick your stops, Optimize the route, and save the trip with a date. You get turn-by-turn directions and a printable business-case handout for each stop." },
      { el:null, title:"Log the visit", body:"After each stop, log the visit right from the map so the touch is captured on the account." }
    ]},
    "call-list": { steps: [
      { el:"h1", title:"Who to Call Today", body:"Your ranked daily worklist — carts, overdue reorders, dormant accounts, and new dealers, in priority order." },
      { el:null, title:"Work top-down", body:"Start at the top, open each account in Dealer 360, make the call, and log the touch. This is your morning list." }
    ]},
    "health": { steps: [
      { el:"h1", title:"Dealer Health", body:"Every account scored on recency, rhythm, and trend." },
      { el:null, title:"Catch the slip early", body:"Watch the at-risk and dormant tiers — those are accounts cooling off. Reach out before they go cold and you can still save them." }
    ]},
    "tasks": { steps: [
      { el:"h1", title:"My Tasks", body:"Your follow-up queue — auto-generated from dealer signals plus tasks you add yourself." },
      { el:null, title:"Close the loop", body:"Clear what's due today, and turn a real opportunity into a new task so it doesn't get lost." }
    ]},
    "command-center-360": { steps: [
      { el:"h1", title:"Command Center 360", body:"Your territory's numbers, interactive." },
      { el:null, title:"Drill anywhere", body:"Click through manufacturer → state → company → dealer → product → order. Great for your weekly review and before a territory trip." }
    ]},
    "pipeline": { steps: [
      { el:"h1", title:"Pipeline", body:"Your open deals by stage, with a weighted pipeline total." },
      { el:null, title:"Keep it moving", body:"Advance deals as they progress and add new ones as you uncover them." }
    ]},
    "my-commissions": { steps: [
      { el:"h1", title:"My Commissions", body:"Your commissions and sales — by month, manufacturer line, and dealer. Your assigned accounts only." },
      { el:null, title:"Know your best accounts", body:"Check it after each commission import to see which lines and dealers pay you most." }
    ]},
    "reps": { steps: [
      { el:"h1", title:"My Performance", body:"Your scorecard — sales vs. goal, year-over-year, momentum, and your book's health mix." },
      { el:null, title:"Own your numbers", body:"Check it weekly so every territory conversation is a plan, not a surprise." }
    ]},
    "rep-usage": { steps: [
      { el:"h1", title:"Rep Usage & Adoption", body:"See how each rep is actually using the platform — not just whether they logged in." },
      { el:".kpis", title:"The headline", body:"How many reps are active, average engagement, and — importantly — how many logged in but didn't do any real work." },
      { el:null, title:"Drill into a rep", body:"Click any rep for their full activity timeline: logins, tools and dealers opened, touches, notes, tasks, routes, and opportunities." }
    ]}
  };

  function slug(){ try{ return location.pathname.replace(/^.*\/admin\//,"").replace(/\.html$/,"") || "index"; }catch(e){ return "index"; } }
  function seen(k){ try{ return !!localStorage.getItem("hct_seen_"+k); }catch(e){ return false; } }
  function markSeen(k){ try{ localStorage.setItem("hct_seen_"+k,"1"); }catch(e){} }

  var CSS = ""
    + "#hct-root{display:none}"
    + ".hct-hl{position:fixed;border-radius:10px;box-shadow:0 0 0 4000px rgba(15,27,43,.55);z-index:100000;pointer-events:none;transition:all .2s ease}"
    + ".hct-dim{position:fixed;inset:0;background:rgba(15,27,43,.55);z-index:100000}"
    + ".hct-catch{position:fixed;inset:0;z-index:100001;background:transparent}"
    + ".hct-tip{position:fixed;z-index:100002;background:#fff;border-radius:13px;box-shadow:0 20px 55px rgba(0,0,0,.35);padding:16px 18px;max-width:340px;font-family:inherit}"
    + ".hct-progress{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8a96a3;font-weight:800}"
    + ".hct-title{font-size:16px;font-weight:800;color:#1f2b45;margin:3px 0 5px}"
    + ".hct-body{font-size:13.5px;color:#3a4a5d;line-height:1.5}"
    + ".hct-btns{display:flex;align-items:center;gap:8px;margin-top:14px}"
    + ".hct-btns .hct-sp{flex:1}"
    + ".hct-btns button{border:0;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer}"
    + ".hct-skip{background:none;color:#8a96a3;padding:8px 4px!important}"
    + ".hct-back{background:#eef2f6;color:#3a4a5d}"
    + ".hct-next{background:#e07b00;color:#fff}"
    + "#hct-launch{position:fixed;right:18px;bottom:18px;z-index:99998;background:#1f2b45;color:#fff;border:0;border-radius:22px;padding:10px 16px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 8px 22px rgba(15,27,43,.3)}"
    + "#hct-launch:hover{background:#2c3e66}"
    + "#hct-launch.hct-pulse{animation:hctp 1.6s ease-in-out 3}"
    + "@keyframes hctp{0%,100%{box-shadow:0 8px 22px rgba(15,27,43,.3)}50%{box-shadow:0 0 0 8px rgba(224,123,0,.25),0 8px 22px rgba(15,27,43,.3)}}";

  function injectCSS(){ if(document.getElementById("hct-css"))return; var s=document.createElement("style"); s.id="hct-css"; s.textContent=CSS; document.head.appendChild(s); }

  var steps=[], idx=0, root=null, curEl=null, curKey=null;

  function build(){
    root=document.createElement("div"); root.id="hct-root";
    root.innerHTML='<div class="hct-hl"></div><div class="hct-dim"></div><div class="hct-catch"></div>'
      + '<div class="hct-tip" role="dialog" aria-live="polite"><div class="hct-progress"></div><div class="hct-title"></div><div class="hct-body"></div>'
      + '<div class="hct-btns"><button type="button" class="hct-skip">Skip</button><span class="hct-sp"></span><button type="button" class="hct-back">Back</button><button type="button" class="hct-next">Next</button></div></div>';
    document.body.appendChild(root);
    root.querySelector(".hct-skip").onclick=end;
    root.querySelector(".hct-back").onclick=function(){ go(idx-1); };
    root.querySelector(".hct-next").onclick=function(){ if(idx>=steps.length-1) end(); else go(idx+1); };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("keydown", function(e){ if(!root||root.style.display!=="block")return;
      if(e.key==="Escape")end(); else if(e.key==="ArrowRight"&&idx<steps.length-1)go(idx+1); else if(e.key==="ArrowLeft"&&idx>0)go(idx-1); });
  }

  function go(i){ idx=Math.max(0,Math.min(i,steps.length-1)); showStep(); }
  function showStep(){
    var st=steps[idx]||{};
    root.querySelector(".hct-title").textContent=st.title||"";
    root.querySelector(".hct-body").textContent=st.body||"";
    root.querySelector(".hct-progress").textContent="Step "+(idx+1)+" of "+steps.length;
    root.querySelector(".hct-back").style.visibility=idx>0?"visible":"hidden";
    root.querySelector(".hct-next").textContent=(idx>=steps.length-1)?"Done":"Next";
    curEl = st.el ? document.querySelector(st.el) : null;
    if(curEl && curEl.getBoundingClientRect){ try{ curEl.scrollIntoView({behavior:"smooth",block:"center"}); }catch(e){ try{curEl.scrollIntoView();}catch(_){} } }
    setTimeout(reposition, 240);
  }
  function reposition(){
    if(!root||root.style.display!=="block")return;
    var hl=root.querySelector(".hct-hl"), dim=root.querySelector(".hct-dim"), tip=root.querySelector(".hct-tip");
    var r = (curEl&&curEl.getBoundingClientRect)?curEl.getBoundingClientRect():null;
    var vw=window.innerWidth, vh=window.innerHeight;
    if(r && r.width>0 && r.height>0 && r.bottom>4 && r.top<vh-4){
      dim.style.display="none"; hl.style.display="block";
      var p=6;
      hl.style.top=(r.top-p)+"px"; hl.style.left=(r.left-p)+"px"; hl.style.width=(r.width+2*p)+"px"; hl.style.height=(r.height+2*p)+"px";
      var tw=Math.min(340, vw-24), th=tip.offsetHeight||170;
      var left=Math.max(12, Math.min(r.left, vw-tw-12)), top;
      if(r.bottom+th+16 < vh){ top=r.bottom+12; }
      else if(r.top-th-16 > 0){ top=r.top-th-12; }
      else { top=Math.max(12,(vh-th)/2); left=Math.max(12,(vw-tw)/2); }
      tip.style.transform="none"; tip.style.top=top+"px"; tip.style.left=left+"px";
    } else {
      hl.style.display="none"; dim.style.display="block";
      tip.style.transform="translate(-50%,-50%)"; tip.style.top="50%"; tip.style.left="50%";
    }
  }
  function start(key){
    key=key||slug(); var t=TOURS[key]; if(!t||!(t.steps&&t.steps.length)) return;
    curKey=key; steps=t.steps; idx=0; if(!root) build();
    root.style.display="block"; markSeen(key);
    var lb=document.getElementById("hct-launch"); if(lb) lb.classList.remove("hct-pulse");
    showStep();
  }
  function end(){ if(root) root.style.display="none"; }

  function addLauncher(){
    var s=slug(); if(!TOURS[s]) return;
    if(document.getElementById("hct-launch")) return;
    var b=document.createElement("button"); b.id="hct-launch"; b.type="button"; b.textContent="🧭 Take a tour";
    if(!seen(s)) b.className="hct-pulse";
    b.onclick=function(){ start(s); };
    document.body.appendChild(b);
  }

  function initTour(){
    injectCSS(); addLauncher();
    var s=slug();
    if(s==="rep-home" && !seen(s) && TOURS[s]) setTimeout(function(){ start(s); }, 900);  // welcome, once
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", initTour); else initTour();

  window.HCPSTour = { start:start, end:end, has:function(k){ return !!TOURS[k||slug()]; } };
})();

/* HCPS shared dealer leave-behind handout — the ONE template used by both the
 * Territory Map (map.html) and Dealer 360 & CRM (dealer.html). Both pages call
 * DealerHandout.html(businessCase, {HANDOUT, ME}); edit the sheet here once and
 * both surfaces update together. Self-contained: its own esc/fmtUsd, no page globals.
 *
 *   DealerHandout.html(c, {HANDOUT, ME})  -> full printable HTML document string
 *   DealerHandout.ORDERING_URL            -> default ordering URL (fallback)
 *   DealerHandout.UPDATES                 -> default "What's new" items (fallback)
 *
 * c comes from routes-api {action:"business_case"}; HANDOUT is the live app_settings
 * "handout" config (ordering_url + updates); ME is the signed-in staff profile (rep
 * fallback only — the sheet prefers the dealer's ASSIGNED rep, c.rep_name).
 */
(function(){
  "use strict";
  var ORDERING_URL="https://hcpsonlineordering.netlify.app";
  var HANDOUT_UPDATES=[
    "New online ordering platform — browse your lines, see your pricing, and place orders 24/7.",
    "New manufacturer lines added to our catalog — ask your rep what's now available in your territory.",
    "Freight programs & volume pricing on select lines — we'll help you reach free-freight thresholds."
  ];
  var esc=function(s){return String(s==null?"":s).replace(/[&<>"]/g,function(ch){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[ch];});};
  var fmtUsd=function(n){return "$"+Number(n||0).toLocaleString("en-US",{maximumFractionDigits:0});};
  function handoutHtml(c, ctx){
      ctx=ctx||{};
      var HANDOUT=ctx.HANDOUT||{ordering_url:ORDERING_URL,updates:HANDOUT_UPDATES};
      var ME=ctx.ME||null;
    // Show the dealer's ASSIGNED rep (from the directory), not just whoever printed the sheet. Fall
    // back to the signed-in user only when the dealer has no assigned rep on file.
    const rep=(c.rep_name)||(ME&&ME.name)||"Your HCPS Representative";
    const repEmail=c.rep_name?(c.rep_email||""):((ME&&ME.email)||"");
    const tile=(x,on)=>`<div class="ltile${on?" on":""}">${x.logo?`<img src="${esc(x.logo)}" alt="${esc(x.name)}" onerror="this.style.display='none'">`:""}<span class="ln">${esc(x.name)}</span></div>`;
    // Golden can reach the handout two ways — a real Golden account already sits in `carried`
    // (from dealer_manufacturers), and/or the dealer is a Golden prospect via golden status. To
    // avoid a double logo, strip any Golden entry out of carried/opps and render Golden exactly
    // ONCE: in "lines you carry" if they have an account, otherwise in "approved for your territory".
    const isGolden=s=>String(s||"").toLowerCase().includes("golden");
    const hasGoldenAcct=(c.golden==="Account")||(c.carried||[]).some(x=>isGolden(x.slug));
    const showGolden=hasGoldenAcct||c.golden==="Prospect";
    const goldenTile=showGolden?tile({name:"Golden Technologies",logo:c.golden_logo||""}, hasGoldenAcct):"";
    const carriedTiles=(c.carried||[]).filter(x=>!isGolden(x.slug)).map(x=>tile(x,true));
    if(hasGoldenAcct&&goldenTile) carriedTiles.push(goldenTile);
    const growTiles=(c.opps||[]).filter(x=>!isGolden(x.slug)).map(x=>tile(x,false));
    if(!hasGoldenAcct&&c.golden==="Prospect"&&goldenTile) growTiles.push(goldenTile);
    const yourLines=carriedTiles.length?`<div class="tiles">${carriedTiles.join("")}</div>`:`<span class="dim">Let's get your first line set up.</span>`;
    const growLines=growTiles.length?`<div class="tiles">${growTiles.join("")}</div>`:`<span class="dim">You're already set up across everything available in your area.</span>`;
    const updates=(HANDOUT.updates||HANDOUT_UPDATES).map(u=>`<li>${esc(u)}</li>`).join("");
    const ordUrl=(HANDOUT.ordering_url||ORDERING_URL);
    const ytd=Number(c.ytd)||0, life=Number(c.total)||0, rec=Number(c.recent60)||0, retail=Number(c.retail_value)||0;
    const coLife=Number(c.company_total)||0, coYtd=Number(c.company_ytd)||0;
    const stat=(l,v,col)=>`<div class="stat"><div class="sv"${col?` style="color:${col}"`:""}>${fmtUsd(v)}</div><div class="sl">${l}</div></div>`;
    const stats = c.multi_location
      ? `<div class="stats">${stat("This location — YTD",ytd,"#1f7a44")}${stat("This location — lifetime",life)}${stat("Company-wide — YTD",coYtd,"#2f73b8")}${stat("Company-wide — lifetime",coLife,"#2f73b8")}${retail?stat("Retail value (this location)",retail,"#F5821F"):""}</div>`
      : `<div class="stats">${stat("This year (YTD)",ytd,"#1f7a44")}${stat("Lifetime with HCPS",life)}${rec?stat("Last 60 days",rec,"#2f73b8"):""}${retail?stat("Retail value purchased",retail,"#F5821F"):""}</div>`;
    const moName=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const lastLbl=s=>{ const m=String(s||"").slice(0,7); if(!/^\d{4}-\d{2}$/.test(m)) return "—"; const p=m.split("-"); return moName[(+p[1])-1]+" "+p[0]; };
    // Purchasing activity across 60 / 120 / 180 days — momentum by line, with slowing/stopped flags so
    // the rep can open a conversation about anything that's gone quiet.
    const actLines=(c.lines||[]).filter(l=>(l.amount||0)>0);
    const actRows=actLines.map(l=>{ const a=+l.d60||0,b=+l.d120||0,e=+l.d180||0;
      let st,col; if(a>0){st="Active";col="#1f7a44";} else if(b>0){st="Slowing";col="#b26b00";} else {st="Stopped";col="#b42323";}
      return `<tr><td>${esc(l.name)}</td><td>${lastLbl(l.last)}</td><td class="r">${a?fmtUsd(a):"—"}</td><td class="r">${b?fmtUsd(b):"—"}</td><td class="r">${e?fmtUsd(e):"—"}</td><td><span class="badge" style="color:${col};border-color:${col}55;background:${col}12">${st}</span></td></tr>`; }).join("");
    const activityHtml=actRows?`<h2>Purchasing activity — last 60 / 120 / 180 days</h2>
        <p class="note" style="margin:2px 0 8px">Momentum by manufacturer line. <b style="color:#b26b00">Slowing</b> or <b style="color:#b42323">Stopped</b> flags a line worth talking through — what changed, and how we can help restart it.</p>
        <table class="act"><thead><tr><th>Manufacturer line</th><th>Last order</th><th class="r">60 days</th><th class="r">120 days</th><th class="r">180 days</th><th>Status</th></tr></thead><tbody>${actRows}</tbody></table>`:"";
    const cut60=new Date(Date.now()-60*864e5).toISOString().slice(0,10);
    const cut180=new Date(Date.now()-183*864e5).toISOString().slice(0,10);
    const dueProds=(c.products||[]).filter(p=>p.last&&p.last<cut60&&p.last>=cut180).slice(0,6);
    const dueHtml=dueProds.length?`<p style="margin:8px 0 0;font-size:12px"><b style="color:#2B4071">Products to circle back on:</b> ${dueProds.map(p=>`<span class="pill">${esc(p.name)} · last ${lastLbl(p.last)}</span>`).join(" ")}</p>`:"";
    // The one crossover opportunity to lead with this visit (regional trend, rotates weekly).
    const cx=c.crossover;
    const crossHtml=cx?`<div class="cross">
        <span class="crosstag">${cx.kind==="reorder"?"Re-stock opportunity":"This visit's opportunity"}</span>
        <div class="crossbody">${cx.logo?`<img class="crosslogo" src="${esc(cx.logo)}" alt="${esc(cx.name)}" onerror="this.style.display='none'">`:""}
          <div><div class="crossname">${esc(cx.name)}</div><div class="crossreason">${esc(cx.reason)}</div></div></div>
        <div class="crosscta">Ask your HCPS rep to add this to your next order — we'll help you price and merchandise it.</div>
      </div>`:"";
    // CardChamp — value-added dealer service.
    const cardchampHtml=`<h2>Turn card fees into cash flow — with CardChamp</h2>
        <div class="cc">
          <img class="cclogo" src="https://www.cardchamp.com/hubfs/_website-logos/cardchamp.svg" alt="CardChamp" onerror="this.style.display='none'">
          <div class="ccbody">
            <p style="margin:0 0 6px"><b>A new HCPS partner service.</b> CardChamp helps our dealers dramatically reduce — or eliminate — the credit-card processing fees you pay on every sale, putting that money back into your business.</p>
            <ul style="margin:6px 0 0"><li>Lower or offset merchant fees on in-store &amp; online payments</li><li>Keep more of every transaction — better margins and steadier cash flow</li><li>Simple switch with dedicated dealer support</li></ul>
            <div class="cccta"><b>Want to see what you'd save?</b> Ask your rep, or learn more at <b>cardchamp.com/homecareproviderservices</b>.</div>
          </div>
        </div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Your HCPS Partnership — ${esc(c.name||"")}</title><style>
      body{font:14px Arial,sans-serif;color:#1b2733;margin:0}
      .hero{position:relative;background:#10263f;color:#fff;padding:24px 28px}.hero .b{color:#F5821F;font-weight:800;letter-spacing:.5px;font-size:13px;text-transform:uppercase}
      .hero .herologo{position:absolute;top:20px;right:28px;max-height:52px;max-width:180px;object-fit:contain;background:#fff;border-radius:8px;padding:6px 10px}
      .hero h1{font-size:24px;margin:6px 0 2px}.hero p{margin:0;color:#c9d4e2;font-size:13px}
      .wrap{padding:22px 28px}h2{font-size:15px;color:#2B4071;margin:18px 0 8px;border-bottom:2px solid #eef1f4;padding-bottom:4px}
      .pill{display:inline-block;border:1px solid #cfd6de;border-radius:14px;padding:3px 11px;margin:3px;font-size:12px;color:#333c47}
      .pill.on{background:#eaf7ee;border-color:#bfe3ca;color:#1f7a44;font-weight:700}
      .tiles{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0}
      .ltile{border:1px solid #cfd6de;border-radius:10px;padding:8px 10px;min-width:96px;text-align:center;background:#fff}
      .ltile.on{border-color:#bfe3ca;background:#f6fbf7}
      .ltile img{max-height:34px;max-width:120px;object-fit:contain;display:block;margin:0 auto 5px}
      .ltile .ln{font-size:11px;color:#333c47;font-weight:600}
      .stats{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0}.stat{background:#f4f7fb;border:1px solid #e2e8f1;border-radius:10px;padding:10px 14px;min-width:118px}
      .sv{font-size:20px;font-weight:800}.sl{font-size:11px;color:#6b7683;margin-top:2px}.note{font-size:11px;color:#9aa4ae;margin:4px 0 0}
      ul{margin:6px 0;padding-left:18px}li{margin:4px 0}
      .cta{margin-top:16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:14px 16px}.cta b{color:#9a3412}
      .foot{margin-top:20px;border-top:1px solid #eef1f4;padding-top:12px;color:#5b6672;font-size:13px}.dim{color:#9aa4ae}
      .foot a{color:#2f73b8}
      table.act{width:100%;border-collapse:collapse;margin-top:2px}
      table.act th{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#5b6672;text-align:left;border-bottom:2px solid #e2e8f1;padding:5px 7px}
      table.act td{border-bottom:1px solid #eef1f4;padding:5px 7px;font-size:12.5px;text-align:left}
      table.act .r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
      .badge{display:inline-block;border:1px solid;border-radius:11px;padding:1px 9px;font-size:11px;font-weight:800}
      .cross{margin-top:14px;border:1px solid #fed7aa;background:linear-gradient(180deg,#fff8f0,#ffffff);border-radius:12px;padding:13px 16px}
      .crosstag{display:inline-block;background:#F5821F;color:#fff;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:3px 11px;border-radius:20px}
      .crossbody{display:flex;align-items:center;gap:14px;margin-top:11px}
      .crosslogo{max-height:46px;max-width:132px;object-fit:contain;flex:0 0 auto}
      .crossname{font-size:18px;font-weight:800;color:#2B4071}.crossreason{font-size:13px;color:#5b6672;margin-top:2px;line-height:1.4}
      .crosscta{margin-top:11px;font-size:12px;color:#9a3412;background:#fff7ed;border:1px dashed #f4b980;border-radius:8px;padding:8px 11px}
      .cc{display:flex;gap:14px;align-items:flex-start;border:1px solid #d6e6f5;background:#f7fbff;border-radius:12px;padding:13px 16px}
      .cclogo{max-height:38px;max-width:150px;object-fit:contain;flex:0 0 auto;margin-top:2px}
      .ccbody{flex:1;min-width:0}.ccbody ul{margin:6px 0 0;padding-left:18px}.ccbody li{margin:3px 0}
      .cccta{margin-top:9px;font-size:12px;color:#0f5a8a;background:#eef6fd;border:1px solid #d6e6f5;border-radius:8px;padding:8px 11px}
      .repcard{background:#f4f7fb;border:1px solid #e2e8f1;border-radius:10px;padding:10px 13px}
      .repcard .rl{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#6b7683;font-weight:700;margin-bottom:2px}.repcard b{color:#2B4071}
      @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}.cross,.cc,.badge,.crosstag,.crosscta,.cccta,.repcard{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
      </style></head><body>
      <div class="hero"><img class="herologo" src="https://homecareproviderservices.netlify.app/assets/hcps-logo.png" alt="HomeCare Provider Services" onerror="this.style.display='none'"><div class="b">HomeCare Provider Services</div><h1>Your Partnership Snapshot</h1><p>${esc(c.name||"")}${c.city?" · "+esc([c.city,c.state].filter(Boolean).join(", ")):""}</p>${(c.is_branch&&c.company&&c.company!==c.name)?`<p style="margin-top:2px;color:#c9d4e2;font-size:11px">A location of ${esc(c.company)}</p>`:""}${(c.accounts&&c.accounts.length)?`<p style="margin-top:6px;color:#eaf0f8;font-size:12px">Your accounts: ${c.accounts.map(a=>esc(a.name)+(a.account?` #${esc(a.account)}`:"")).join("&nbsp;·&nbsp;")}</p>`:""}</div>
      <div class="wrap">
        <h2>Your business with HCPS</h2>${stats}${retail?`<p class="note">Retail value = MSRP of the products you've purchased through us — your selling-revenue potential.</p>`:""}
        ${activityHtml}${dueHtml}
        ${crossHtml}
        <h2>Lines you carry with us</h2><div>${yourLines}</div>
        <h2>Ways we can help you grow</h2><p style="margin:2px 0 6px;color:#5b6672">Products approved for your territory that you're not carrying yet — new revenue we can help you add:</p><div>${growLines}</div>
        ${cardchampHtml}
        <h2>What's new at HCPS</h2><ul>${updates}</ul>
        <div class="cta"><b>Order online, anytime.</b> Your account, your lines, your pricing — at <b>${esc(ordUrl.replace(/^https?:\/\//,""))}</b>. Ask your rep to get you logged in.</div>
        <div class="foot">
          <div class="repcard"><div class="rl">Your HCPS Sales Representative</div><b>${esc(rep)}</b>${repEmail?` · <a href="mailto:${esc(repEmail)}">${esc(repEmail)}</a>`:""}</div>
          <div style="margin-top:10px">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.<br><b>www.homecareproviderservices.org</b></div>
        </div>
      </div>
      <scr`+`ipt>window.onload=function(){window.print();}</scr`+`ipt></body></html>`;
  }
  
  window.DealerHandout={ ORDERING_URL: ORDERING_URL, UPDATES: HANDOUT_UPDATES.slice(), html: handoutHtml };
})();

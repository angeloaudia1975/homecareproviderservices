// HCPS ordering portal — order persistence + history (service-role, server-side).
// Dealers reach ONLY their own orders, gated by their Supabase Auth JWT.
//   POST {action:"create", orders:[...], dealer:{...}}  + Bearer <jwt>  -> saves orders+items
//   POST {action:"list"}                                 + Bearer <jwt>  -> {orders:[{...,items:[]}]}
// The email to HCPS is still sent by submit-order.js; this only records the order so the
// dealer's dashboard can show history and reorder.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store",...CORS},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
const P = require("./_platform.js");

async function sb(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,
    headers:{...H(),"content-type":"application/json",...(extra||{})},
    body:body!=null?JSON.stringify(body):undefined});
  const t=await r.text(); const j=t?JSON.parse(t):null;
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
  return j;
}
const num = (v)=>{ const n=Number(v); return Number.isFinite(n)?n:0; };

// ---- dealer order confirmation (transactional email, via Resend) ------------
const MAIL_FROM=process.env.HCPS_MAIL_FROM||"HCPS Partner Portal <orders@homecareproviderservices.us>";
const PORTAL_URL=process.env.ORDERING_BASE||"https://hcpsonlineordering.netlify.app";
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const money=n=>"$"+(Math.round(num(n)*100)/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
async function sendMail({to,subject,html,text}){
  const apiKey=process.env.RESEND_API_KEY;
  if(!apiKey){ console.error("RESEND_API_KEY not set — skipping order confirmation:",subject); return {ok:false,skipped:true}; }
  try{ const res=await fetch("https://api.resend.com/emails",{method:"POST",
    headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
    body:JSON.stringify({from:MAIL_FROM,to:[to],subject,html,text})});
    return {ok:res.ok}; }catch(e){ return {ok:false}; }
}
function orderConfirmation(to,d,summaries){
  const blocks=summaries.map(s=>{
    const rows=(s.items||[]).map(it=>`<tr><td style="padding:5px 10px;border-bottom:1px solid #eef2f6;font-size:13px">${esc(it.name||it.code||"Item")}${it.code?` <span style="color:#9aa4ae">(${esc(it.code)})</span>`:""}</td><td style="padding:5px 10px;border-bottom:1px solid #eef2f6;font-size:13px;text-align:center">${num(it.qty)}</td><td style="padding:5px 10px;border-bottom:1px solid #eef2f6;font-size:13px;text-align:right">${money(it.unit_price)}</td><td style="padding:5px 10px;border-bottom:1px solid #eef2f6;font-size:13px;text-align:right">${money(it.line_total)}</td></tr>`).join("");
    return `<div style="margin:0 0 16px"><div style="font-weight:700;color:#2B4071;font-size:14px;margin:0 0 6px">${esc(s.line)}${s.po?` &middot; PO ${esc(s.po)}`:""}</div><table style="border-collapse:collapse;width:100%"><thead><tr><th style="text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8a96a3;padding:0 10px 4px">Item</th><th style="font-size:10px;color:#8a96a3;padding:0 10px 4px">Qty</th><th style="text-align:right;font-size:10px;color:#8a96a3;padding:0 10px 4px">Unit</th><th style="text-align:right;font-size:10px;color:#8a96a3;padding:0 10px 4px">Total</th></tr></thead><tbody>${rows}</tbody></table><div style="text-align:right;font-size:13px;font-weight:700;color:#1b2733;margin:6px 10px 0">Subtotal: ${money(s.subtotal)}</div></div>`;
  }).join("");
  const html=`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px">
    <h2 style="color:#2B4071;margin:0 0 4px">Order received${d.business?", "+esc(d.business):""}</h2>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 14px">Thanks for ordering through the HomeCare Provider Services portal. We've received the following and it's on its way to the manufacturer for fulfillment. You can view this anytime in your order history.</p>
    ${blocks}
    <a href="${PORTAL_URL}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;font-size:14px;margin-top:4px">View your order history &rarr;</a>
    <p style="font-size:12.5px;line-height:1.6;color:#6b7280;margin:16px 0 0">Pricing shown is your contract pricing; the manufacturer's invoice is the final billing document. Questions about this order? Reply to this email or reach your HCPS rep.</p>
    <p style="font-size:12px;color:#9aa4ae;margin:14px 0 0">HomeCare Provider Services &middot; Your partner in mobility &amp; home medical equipment.</p></div>`;
  const text=`Order received${d.business?", "+d.business:""}\n\nThanks for ordering through the HomeCare Provider Services portal. We've received your order and it's on its way to the manufacturer.\n\n`
    +summaries.map(s=>`${s.line}${s.po?" (PO "+s.po+")":""}\n`+(s.items||[]).map(it=>`  ${num(it.qty)} x ${it.name||it.code||"Item"} @ ${money(it.unit_price)} = ${money(it.line_total)}`).join("\n")+`\n  Subtotal: ${money(s.subtotal)}`).join("\n\n")
    +`\n\nView your order history: ${PORTAL_URL}`;
  return {to,subject:"Your HCPS order confirmation",html,text};
}

// ---- Phase 4: shipment tracking request to each manufacturer (best-effort, transactional) ----
// Asks the manufacturer (their contact if on file, else HCPS) to send tracking to the dealer and
// back to HCPS for sync. Logged in tracking_requests. Never throws into the order flow.
async function sendTrackingRequests(d, who, summaries){
  let contacts={};
  try{ const ms=await sb("GET","manufacturers?select=slug,name,contact_email"); for(const m of (ms||[])){ contacts[m.slug]={name:m.name||m.slug, email:m.contact_email||null}; } }catch(e){}
  const HCPS_TO=(process.env.PRICING_REQUEST_TO||process.env.ORDER_TO||"orders@homecareproviderservices.us");
  const dealerEmail=String((d&&d.email)||(who&&who.email)||"").trim();
  for(const s of (summaries||[])){
    if(!s.slug) continue;
    const c=contacts[s.slug]||{name:s.line,email:null};
    const to=c.email||HCPS_TO;
    const items=(s.items||[]).map(it=>`${num(it.qty)} x ${it.name||it.code||"Item"}`).join(", ");
    const ship=[d&&d.address,d&&d.city,d&&d.state,d&&d.zip].filter(Boolean).join(", ");
    const subject=`Tracking request — ${s.po?"PO "+s.po+" — ":""}${(d&&d.business)||"Dealer"} — ${c.name}`;
    const html=`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:600px"><h2 style="color:#2B4071;margin:0 0 8px">Shipment tracking request</h2>`
      +`<p style="font-size:13.5px;color:#374151">Please send shipment/tracking for this order to the dealer (${esc(dealerEmail)}) and to HCPS (${esc(HCPS_TO)}) so we can sync it to their order history.</p>`
      +`<table style="border-collapse:collapse;font-size:14px"><tr><td style="padding:3px 12px 3px 0;color:#6b7280">Manufacturer</td><td>${esc(c.name)}</td></tr>`
      +`<tr><td style="padding:3px 12px 3px 0;color:#6b7280">PO</td><td>${esc(s.po||"—")}</td></tr>`
      +`<tr><td style="padding:3px 12px 3px 0;color:#6b7280">Dealer</td><td><b>${esc((d&&d.business)||"—")}</b></td></tr>`
      +`<tr><td style="padding:3px 12px 3px 0;color:#6b7280">Ship to</td><td>${esc(ship||"—")}</td></tr>`
      +`<tr><td style="padding:3px 12px 3px 0;color:#6b7280;vertical-align:top">Items</td><td>${esc(items)}</td></tr></table></div>`;
    const text=`Shipment tracking request\nPlease send tracking to the dealer (${dealerEmail}) and HCPS (${HCPS_TO}).\nManufacturer: ${c.name}\nPO: ${s.po||"—"}\nDealer: ${(d&&d.business)||"—"}\nItems: ${items}`;
    try{ await sendMail({to,subject,html,text}); }catch(e){}
    try{ await sb("POST","tracking_requests",{dealer_id:who&&who.dealer_id,order_ref:s.order_id||null,manufacturer:s.slug,po:s.po||null,summary:items,status:"requested"},{Prefer:"return=minimal"}); }catch(e){}
  }
}

// Resolve the caller's JWT to an APPROVED dealer_id (or null).
async function dealerFromToken(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,""); if(!tok) return null;
  const ur=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
  if(!ur.ok) return null;
  const u=await ur.json();
  const rows=await sb("GET",`dealer_users?uid=eq.${u.id}&select=status,dealer_id,email`);
  const du=rows&&rows[0];
  if(!du||du.status!=="approved"||!du.dealer_id) return null;
  return {dealer_id:du.dealer_id,email:du.email};
}

exports.handler = async (event)=>{
  if(event.httpMethod==="OPTIONS") return {statusCode:204,headers:CORS,body:""};
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set (SUPABASE_URL, SUPABASE_SERVICE_ROLE)"});
    if(event.httpMethod!=="POST") return json(405,{error:"method not allowed"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}

    const who=await dealerFromToken(event);
    if(!who) return json(200,{ok:false,status:"unauthorized"});   // not signed in / not approved

    if(b.action==="create"){
      const orders=Array.isArray(b.orders)?b.orders:[];
      if(!orders.length) return json(400,{error:"no orders"});
      const d=b.dealer||{};
      // Operating env for this order (test account, or the current platform mode).
      const st=await P.getState();
      let isTest=false; try{ const dt=await sb("GET",`dealers?id=eq.${encodeURIComponent(who.dealer_id)}&select=is_test`); isTest=!!(dt&&dt[0]&&dt[0].is_test); }catch(e){}
      const env=P.envFor(st.mode,isTest);
      // validate manufacturer slugs against the real table; keep names for the confirmation email
      let known=new Set(), mfrName={};
      try{ const ms=await sb("GET","manufacturers?select=slug,name"); for(const m of (ms||[])){ known.add(m.slug); mfrName[m.slug]=m.name||m.slug; } }catch(e){}
      let saved=0; const summaries=[]; const slugs=new Set();
      for(const o of orders){
        const slug=o.manufacturer_slug||o.manufacturer||null;
        const cleanSlug=(slug&&known.has(slug))?slug:null;
        const row={
          dealer_id:who.dealer_id,
          hcps_account:d.account||null,
          manufacturer:cleanSlug,
          status:"submitted",
          po_number:o.po||null,
          notes:o.notes||null,
          ship_name:d.business||null, ship_address:d.address||null, ship_city:d.city||null,
          ship_state:d.state||null, ship_zip:d.zip||null,
          contact_name:d.contact||null, contact_email:d.email||null, contact_phone:d.phone||null,
          subtotal:num(o.items_subtotal!=null?o.items_subtotal:o.estimated_total),
          env,
        };
        let ins;
        try{ ins=await sb("POST","orders",row,{Prefer:"return=representation"}); }
        catch(e){ continue; }  // best-effort: skip a bad order, keep going
        const oid=ins&&ins[0]&&ins[0].id; if(!oid) continue;
        const items=(o.items||[]).map(it=>({
          order_id:oid, code:it.code||null, name:it.name||null,
          qty:Math.max(1,Math.round(num(it.qty))||1),
          unit_price:num(it.unit), line_total:Math.round(num(it.unit)*num(it.qty)*100)/100,
        }));
        if(items.length){ try{ await sb("POST","order_items",items,{Prefer:"return=minimal"}); }catch(e){} }
        summaries.push({slug:cleanSlug, line:cleanSlug?(mfrName[cleanSlug]||cleanSlug):(slug||"Order"), po:o.po||"", items, subtotal:row.subtotal, order_id:oid});
        if(cleanSlug) slugs.add(cleanSlug);
        saved++;
      }
      if(saved>0){
        // Dealer-facing order confirmation — TRANSACTIONAL: always sends, never counts
        // against the marketing frequency caps, and not gated by the dry-run switch.
        // Best-effort: a mail hiccup never fails the saved order.
        const to=String(d.email||who.email||"").trim();
        if(EMAIL_RE.test(to) && P.allowTransactional(st.mode,isTest)){ try{ await sendMail(orderConfirmation(to,d,summaries)); }catch(e){ console.error("order confirm email failed",e&&e.message); } }
        // Phase 4 — auto tracking request to each manufacturer (best-effort; never affects the saved order).
        if(P.allowTransactional(st.mode,isTest)){ try{ await sendTrackingRequests(d,who,summaries); }catch(e){ console.error("tracking request failed",e&&e.message); } }
        // Email→revenue attribution: credit this order to a recent email touch, if any.
        // A campaign CLICK for the line in the last 7d wins (strongest signal); otherwise
        // any automated marketing SEND to the dealer in the last 14d. Runs BEFORE the intent
        // reset below so a same-session campaign click is still visible. Best-effort.
        try{
          const now=Date.now();
          const clickCut=new Date(now-7*864e5).toISOString(), sendCut=new Date(now-14*864e5).toISOString();
          const sends=await sb("GET",`email_sends?dealer_id=eq.${encodeURIComponent(who.dealer_id)}&sent_at=gte.${encodeURIComponent(sendCut)}&select=template,sent_at&order=sent_at.desc&limit=1`).catch(()=>[]);
          const lastSend=sends&&sends[0];
          for(const su of summaries){
            const amt=num(su.subtotal); if(!su.slug||!su.order_id||amt<=0) continue;
            let kind=null,ref=null,touch=null;
            const clk=await sb("GET",`intent_events?dealer_id=eq.${encodeURIComponent(who.dealer_id)}&manufacturer=eq.${encodeURIComponent(su.slug)}&event_type=eq.email_click&source=eq.campaign&occurred_at=gte.${encodeURIComponent(clickCut)}&select=occurred_at,meta&order=occurred_at.desc&limit=1`).catch(()=>[]);
            if(clk&&clk[0]){ kind="campaign"; ref=(clk[0].meta&&clk[0].meta.campaign_id)||null; touch=clk[0].occurred_at; }
            else if(lastSend){ kind="automation"; ref=lastSend.template||null; touch=lastSend.sent_at; }
            if(kind){ try{ await sb("POST","email_attribution?on_conflict=order_id,manufacturer",
              {dealer_id:who.dealer_id,order_id:su.order_id,manufacturer:su.slug,amount:Math.round(amt*100)/100,kind,ref,touch_at:touch,env},
              {Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){} }
          }
        }catch(e){}
        // Order placed = conversion. Clear the browsing intent for the lines just ordered
        // so we never email a dealer about what they just bought online. (The monthly
        // commission upload can't see a same-day online order, so this IS the real reset.)
        for(const slug of slugs){ try{ await sb("DELETE",`intent_events?dealer_id=eq.${who.dealer_id}&manufacturer=eq.${encodeURIComponent(slug)}`,null,{Prefer:"return=minimal"}); }catch(e){} }
      }
      return json(200,{ok:true,saved});
    }

    if(b.action==="list"){
      const rows=await sb("GET",
        `orders?dealer_id=eq.${who.dealer_id}&select=id,manufacturer,status,po_number,notes,subtotal,submitted_at,order_items(code,name,qty,unit_price,line_total)&order=submitted_at.desc&limit=25`);
      const orders=(rows||[]).map(o=>({
        id:o.id, manufacturer:o.manufacturer||"", status:o.status||"submitted",
        po:o.po_number||"", notes:o.notes||"", subtotal:num(o.subtotal),
        submitted_at:o.submitted_at,
        items:(o.order_items||[]).map(i=>({code:i.code,name:i.name,qty:i.qty,unit:num(i.unit_price),line:num(i.line_total)})),
        items_count:(o.order_items||[]).reduce((n,i)=>n+num(i.qty),0),
      }));
      return json(200,{ok:true,orders});
    }

    return json(400,{error:"unknown action"});
  }catch(e){return json(500,{error:String(e.message||e)});}
};

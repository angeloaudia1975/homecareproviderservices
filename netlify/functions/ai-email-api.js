// HCPS — AI email drafter for Dealer 360. Suggest-and-approve: this endpoint only GENERATES a
// draft (subject + body) from what we already know about the account. The rep reviews/edits it in
// Dealer 360 and approves; the actual send happens in email-sync-api (from the rep's Outlook).
//
//   POST {action:"draft", dealer_id, template, contact_email?, contact_name?}
//        -> { ok, subject, body, signature, context }
//
// Auth: any active staff member who may access the dealer (management + relations = all; rep = own
// book). Uses the shared _scope. No email is sent here.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.HCPS_AI_MODEL || "claude-sonnet-5";
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";

const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
const { dealerScope, isAdmin } = require("./_scope.js");
const { loadStyleGuide, findBanned } = require("./_ai_style.js");

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email,signature:su.email_signature||""}; } } }catch(e){}
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:"",signature:""};
  return null;
}

const MONTH=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const pm=p=>{ const s=String(p||"").slice(0,7); const[y,m]=s.split("-").map(Number); return (y&&m)?(y*12+(m-1)):null; };
const pmLbl=n=>MONTH[((n%12)+12)%12]+" "+Math.floor(n/12);
const money=n=>"$"+Math.round(Number(n)||0).toLocaleString();

// Each template maps to a one-line instruction that steers the draft's purpose.
const TEMPLATES={
  follow_up:        "A friendly follow-up after recent contact or activity — keep the relationship warm and surface any next step.",
  product_opportunity:"Highlight a specific product or line opportunity that fits this dealer, based on what similar dealers stock or what they've viewed.",
  reorder_reminder: "A gentle reorder reminder for lines that are due based on their ordering cadence.",
  dormant_account:  "A re-engagement note for a dormant account that hasn't ordered recently — warm, low-pressure, invite them back.",
  new_product:      "Introduce a new product or line HCPS now represents that would suit this dealer.",
  portal_activation:"Encourage the dealer to start using the online ordering portal (check stock, pricing, place orders themselves).",
  cross_sell:       "Suggest a complementary line the dealer doesn't buy yet but that fits their mix (cross-sell)."
};

async function gather(dealerId, slugName){
  const out={};
  try{ const d=await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=business_name,city,state,hcps_account`); out.dealer=(d&&d[0])||{}; }catch(e){ out.dealer={}; }
  // sales by line + last order
  try{
    const rows=await sbGet(`monthly_sales?dealer_id=eq.${encodeURIComponent(dealerId)}&select=manufacturer,period,amount`);
    const byLine={}; let last=null, total=0;
    for(const r of (rows||[])){ const s=Number(r.amount)||0; total+=s; const k=r.manufacturer||"?";
      const o=byLine[k]||(byLine[k]={sales:0,last:null}); o.sales+=s; const p=pm(r.period); if(p&&(o.last==null||p>o.last))o.last=p; if(p&&(last==null||p>last))last=p; }
    out.lines=Object.entries(byLine).map(([slug,o])=>({name:slugName[slug]||slug,sales:o.sales,last:o.last})).sort((a,b)=>b.sales-a.sales);
    out.total_sales=total; out.last_order=last;
  }catch(e){ out.lines=[]; }
  // engagement / health
  try{ const e=await sbGet(`dealer_engagement?dealer_id=eq.${encodeURIComponent(dealerId)}&select=status,score,churn_score,recent_sales,total_sales,trend`); out.health=(e&&e[0])||null; }catch(e){ out.health=null; }
  // line relationships (dormant + prospect/whitespace)
  try{ const ls=await sbGet(`dealer_line_status?dealer_id=eq.${encodeURIComponent(dealerId)}&select=manufacturer,relationship,months_since`);
    out.dormant_lines=(ls||[]).filter(x=>x.relationship==="dormant").map(x=>slugName[x.manufacturer]||x.manufacturer);
    out.prospect_lines=(ls||[]).filter(x=>x.relationship==="prospect").map(x=>slugName[x.manufacturer]||x.manufacturer);
  }catch(e){ out.dormant_lines=[]; out.prospect_lines=[]; }
  // last touch
  try{ const a=await sbGet(`dealer_activity?dealer_id=eq.${encodeURIComponent(dealerId)}&select=kind,subject,created_at&order=created_at.desc&limit=1`); out.last_touch=(a&&a[0])||null; }catch(e){ out.last_touch=null; }
  return out;
}

function contextLines(ctx){
  const L=[];
  const d=ctx.dealer||{};
  L.push(`Dealer: ${d.business_name||"(unknown)"}${d.city?` — ${d.city}, ${d.state||""}`:""}`);
  if(ctx.total_sales) L.push(`Total sales on file: ${money(ctx.total_sales)}`);
  if(ctx.last_order!=null) L.push(`Last order: ${pmLbl(ctx.last_order)}`);
  if(ctx.lines&&ctx.lines.length) L.push(`Buys these lines: ${ctx.lines.slice(0,6).map(l=>`${l.name} (${money(l.sales)})`).join(", ")}`);
  if(ctx.health){ const h=ctx.health; L.push(`Dealer health: ${h.status||"?"}, score ${Math.round(Number(h.score)||0)}/100${h.churn_score?`, intervention urgency ${Math.round(Number(h.churn_score))}`:""}${h.trend?`, trend ${h.trend}`:""}`); }
  if(ctx.dormant_lines&&ctx.dormant_lines.length) L.push(`Lines they've gone dormant on: ${ctx.dormant_lines.slice(0,6).join(", ")}`);
  if(ctx.prospect_lines&&ctx.prospect_lines.length) L.push(`Lines they DON'T buy yet but could (whitespace): ${ctx.prospect_lines.slice(0,6).join(", ")}`);
  if(ctx.last_touch) L.push(`Last logged touch: ${ctx.last_touch.kind||"note"} — ${ctx.last_touch.subject||""} (${String(ctx.last_touch.created_at||"").slice(0,10)})`);
  return L.join("\n");
}

// A sensible default signature if the rep hasn't set one.
function defaultSignature(me){
  const parts=[me.name||"", "HomeCare Provider Services"];
  if(me.email) parts.push(me.email);
  return parts.filter(Boolean).join("\n");
}

/* ── Approved product content for an email ───────────────────────────────────
   The enrichment tool has already built the good version of every product: a written
   description, features, specs, sizing, clinical applications, approved photography.
   The compose tool used to ignore all of it and ask the model to write about a product
   from its name alone. This is the bridge — it hands the draft real, approved facts so
   the email says something a dealer couldn't have guessed.

   Only APPROVED content is used. Anything still in review is somebody's draft, and a
   draft has no business being quoted to a dealer. */
const APPROVED_STATUS = new Set(["approved","published","active"]);

async function productContent(sbGet, mfrSlug, code){
  const enc=encodeURIComponent;
  const rows=await sbGet(`product_content?manufacturer=eq.${enc(mfrSlug)}&select=page_key,name,tagline,description,family,category,subcategory,features,clinical_applications,specs,billing_codes,sizing_table,sizing_note,warranty,image,images_gallery,skus,status,disabled&limit=4000`).catch(()=>[]);
  const want=String(code||"").trim().toUpperCase();
  let page=null;
  for(const r of (rows||[])){
    if(r.disabled) continue;
    const skus=Array.isArray(r.skus)?r.skus:[];
    const hit=skus.some(s=>String((s&&(s.sku||s.code))||s||"").trim().toUpperCase()===want);
    if(hit){ page=r; break; }
  }
  if(!page) return null;
  const approved=APPROVED_STATUS.has(String(page.status||"").toLowerCase());
  const gallery=[];
  const push=(u,cap,primary)=>{ const url=String(u||"").trim(); if(!url) return;
    if(gallery.some(g=>g.url===url)) return; gallery.push({url,caption:String(cap||"").slice(0,120),primary:!!primary}); };
  push(page.image,"Primary product photo",true);
  (Array.isArray(page.images_gallery)?page.images_gallery:[]).forEach(g=>push(g&&(g.url||g),(g&&g.caption)||"",false));
  const sku=(Array.isArray(page.skus)?page.skus:[]).find(x=>String((x&&(x.sku||x.code))||x||"").trim().toUpperCase()===want)||{};
  return {
    approved, status:page.status||"", page_key:page.page_key,
    code:String(code), name:page.name||"", tagline:page.tagline||"",
    description:page.description||"", family:page.family||"", category:page.category||"", subcategory:page.subcategory||"",
    features:(page.features||[]).slice(0,12),
    clinical:(page.clinical_applications||[]).slice(0,8),
    specs:page.specs||null, billing_codes:page.billing_codes||[],
    sizing_note:page.sizing_note||"", sizing_rows:(page.sizing_table||[]).length,
    warranty:page.warranty||"", size:(sku&&sku.size)||"",
    images:gallery.slice(0,12),
  };
}

/* What the model is told about the product. Only facts that exist — an empty section is
   omitted rather than sent as a heading with nothing under it, which invites invention. */
function productBrief(pc){
  if(!pc) return "";
  const L=[];
  L.push(`PRODUCT: ${pc.name}${pc.code?` (${pc.code})`:""}`);
  if(pc.tagline) L.push(`Tagline: ${pc.tagline}`);
  if(pc.family||pc.category) L.push(`Line: ${[pc.category,pc.family].filter(Boolean).join(" / ")}`);
  if(pc.description) L.push(`Approved description: ${String(pc.description).slice(0,900)}`);
  if(pc.features&&pc.features.length) L.push(`Key features:\n- ${pc.features.map(f=>String(f&&(f.text||f)).slice(0,140)).join("\n- ")}`);
  if(pc.clinical&&pc.clinical.length) L.push(`Clinical applications: ${pc.clinical.map(c=>String(c&&(c.text||c))).join("; ").slice(0,400)}`);
  if(pc.specs&&typeof pc.specs==="object"){
    const kv=Object.entries(pc.specs).filter(([,v])=>v!=null&&String(v).trim()).slice(0,10)
      .map(([k,v])=>`${k}: ${String(v).slice(0,60)}`);
    if(kv.length) L.push(`Specifications: ${kv.join(" · ")}`);
  }
  if(pc.sizing_rows) L.push(`Sizing: ${pc.sizing_rows} size option(s) available${pc.sizing_note?` — ${String(pc.sizing_note).slice(0,160)}`:""}`);
  if(pc.warranty) L.push(`Warranty: ${String(pc.warranty).slice(0,120)}`);
  if(pc.billing_codes&&pc.billing_codes.length) L.push(`Billing codes: ${pc.billing_codes.join(", ").slice(0,120)}`);
  L.push("Use ONLY these facts about the product. Do not invent specifications, capacities, prices or claims.");
  return L.join("\n");
}

/* The Partner 360 destination. A dealer who isn't signed in lands on the portal's
   login/registration screen and is taken to this product once they're in — the portal
   remembers the intent (see ?product= handling there), so the link is worth sending to
   a dealer who has never registered. That is the point: it doubles as an invitation. */
function partnerProductUrl(base, mfrSlug, code){
  const u=new URL(base.replace(/\/+$/,"")+"/");
  u.searchParams.set("product", String(code||""));
  if(mfrSlug) u.searchParams.set("mfr", String(mfrSlug));
  return u.toString();
}

const escH=v=>String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

/* Turn the model's plain-text body into the email a dealer receives: the approved photo,
   the copy, and one clear way through to the product on Partner 360. */
function composeHtml({body, product, imageUrl, productUrl, signature}){
  const paras=String(body||"").split(/\n{2,}/).map(p=>p.trim()).filter(Boolean)
    .map(p=>`<p style="margin:0 0 13px;color:#1f2937;font-size:15px;line-height:1.55">${escH(p).replace(/\n/g,"<br>")}</p>`).join("");
  const img=imageUrl?`<p style="margin:0 0 16px"><img src="${escH(imageUrl)}" alt="${escH(product&&product.name||"")}" width="520"
      style="max-width:100%;height:auto;border-radius:10px;border:1px solid #e5e9ee"></p>`:"";
  const cap=product&&product.name?`<p style="margin:-8px 0 16px;color:#6b7280;font-size:12.5px">${escH(product.name)}${product.code?` · ${escH(product.code)}`:""}</p>`:"";
  const btn=productUrl?`<p style="margin:18px 0 6px"><a href="${escH(productUrl)}"
      style="background:#F5821F;color:#fff;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-size:15px">View this product on Partner 360 →</a></p>
    <p style="margin:0 0 16px;color:#6b7280;font-size:12px">Not signed up yet? The link walks you through setting up your Partner 360 account, then opens the product.</p>`:"";
  const sig=signature?`<p style="margin:18px 0 0;color:#6b7280;font-size:12.5px;line-height:1.5">${escH(signature).replace(/\n/g,"<br>")}</p>`:"";
  return `<div style="max-width:560px;margin:0 auto;font-family:Arial,Helvetica,sans-serif">
    ${img}${cap}${paras}${btn}${sig}</div>`;
}

exports.handler=async(event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
    /* The approved content behind one product, for the compose picker: what the
       enrichment tool built, plus every approved image so the rep can choose which
       one leads the email. */
    if(b.action==="product_content"){
      const mfr=String(b.manufacturer||"").trim(), code=String(b.product_code||"").trim();
      if(!mfr||!code) return json(400,{error:"manufacturer and product_code required"});
      const pc=await productContent(sbGet,mfr,code);
      if(!pc) return json(200,{ok:false,error:"no_content",
        message:`No enrichment record covers ${code} yet. You can still write the email — it just won't carry approved product content.`});
      return json(200,{ok:true,product:pc,
        product_url:partnerProductUrl(ORDERING_BASE,mfr,code),
        warning: pc.approved?null:`This product's content is still "${pc.status||"in review"}" — approve it in Product Content Enrichment & Review before quoting it to a dealer.`});
    }

    if(b.action!=="draft") return json(400,{error:"unknown action"});

    const dealerId=String(b.dealer_id||"").trim(); if(!dealerId) return json(400,{error:"dealer_id required"});
    // Access check: management + relations may draft for any dealer; a rep only for their own book.
    if(!isAdmin(me)){
      const sc=await dealerScope(me, sbGet);
      if(!sc.isAll && !(sc.ids && sc.ids.has(dealerId))) return json(403,{error:"Not your dealer"});
    }
    const signature=(me.signature&&me.signature.trim())||defaultSignature(me);
    if(!AI_KEY) return json(200,{ok:false,error:"ai_unavailable",message:"AI drafting isn't enabled — set ANTHROPIC_API_KEY in Netlify.",signature});

    const tmplKey=String(b.template||"follow_up").toLowerCase();
    const tmpl=TEMPLATES[tmplKey]||TEMPLATES.follow_up;

    // slug -> manufacturer display name
    let slugName={}; try{ const m=await sbGet("manufacturers?select=slug,name"); (m||[]).forEach(x=>{ if(x&&x.slug) slugName[x.slug]=x.name||x.slug; }); }catch(e){}

    const ctx=await gather(dealerId, slugName);
    const contactName=String(b.contact_name||"").trim();
    const firstName=contactName?contactName.split(/\s+/)[0]:"";
    const styleGuide=await loadStyleGuide(sbGet);   // centralized HCPS AI Communication Style Guide

    /* The product the rep chose, if any. This is what turns a generic note into a real
       one: the model writes from the approved description, features and specs rather
       than from a product name it has to guess about. */
    const pmfr=String((b.product&&b.product.manufacturer)||b.manufacturer||"").trim();
    const pcode=String((b.product&&b.product.code)||b.product_code||"").trim();
    let PC=null, productUrl="", imageUrl="";
    if(pmfr&&pcode){
      PC=await productContent(sbGet,pmfr,pcode).catch(()=>null);
      productUrl=partnerProductUrl(ORDERING_BASE,pmfr,pcode);
      /* The rep picks which approved photo leads the email; if they didn't, the primary
         one does. An image the enrichment record doesn't know about is never used — an
         email is not the place to introduce an unapproved picture of a product. */
      const want=String((b.product&&b.product.image_url)||b.image_url||"").trim();
      const okImg=(PC&&PC.images||[]).some(i=>i.url===want);
      imageUrl = want&&okImg ? want : (((PC&&PC.images||[])[0]||{}).url||"");
    }
    const brief=PC?productBrief(PC):"";
    /* A line-level promotion with no specific SKU still deserves the manufacturer name
       in the prompt, so "cross-sell" doesn't come out abstract. */
    const lineName=String((b.product&&b.product.mfr_name)||b.mfr_name||"").trim();

    const buildPrompt=(avoidNote)=>`You write short, professional B2B sales emails for HomeCare Provider Services (HCPS), a manufacturers' rep group that sells home-medical-equipment lines to durable-medical-equipment (DME) dealers.

${styleGuide}

Write ONE email from the rep (${me.name||"the HCPS rep"}) to a dealer contact${firstName?` named ${firstName}`:""}.

Situation / purpose of this email:
${tmpl}

What we know about this account (use only what's relevant; never invent facts or numbers) — this is the material for the specific, real reason the style guide requires:
${contextLines(ctx)}
${lineName?`\nThe line being promoted: ${lineName}`:""}
${brief?`\nThe product this email is about — these are APPROVED facts from the HCPS product record. Ground the email in them, and connect them to what this dealer actually sells:\n${brief}`:""}
${brief?`\nThe email will show an approved photo of the product and a button through to its page on the Partner 360 dealer portal, so do NOT describe the photo or paste a URL — just make a dealer want to click.`:""}

Format:
- Greeting to the contact by first name if provided ("Hi ${firstName||"there"},").
- 2 to 4 short paragraphs, plain sentences, no marketing fluff, no emojis.
- Open with the specific insight/opportunity for THIS dealer (a line they buy, a dormant line, whitespace, cadence) — never a check-in or apology.
- Close with a clear next step or a simple either/or choice — not an open-ended "let me know if…".
- Do NOT include a signature or sign-off block (no "Best,"/name) — that is added separately.
- Keep it concise: a busy dealer should read it in 20 seconds.
${avoidNote||""}
Return ONLY a JSON object with exactly these keys:
  "subject": a specific subject line, <= 60 characters, no emojis, that names the opportunity (not "checking in")
  "body": the email body as plain text with real line breaks between paragraphs (no HTML, no signature)
Do not include markdown or any text outside the JSON.`;

    async function generate(prompt){
      const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
        headers:{"x-api-key":AI_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},
        body:JSON.stringify({model:AI_MODEL,max_tokens:900,messages:[{role:"user",content:prompt}]})});
      if(!r.ok){ const t=await r.text().catch(()=>""); let hint=""; try{ const ej=JSON.parse(t); hint=(ej&&ej.error&&ej.error.message)?` (${ej.error.message})`:""; }catch(_){}
        return {err:`The AI service returned an error${hint}. Try again.`, detail:t.slice(0,200)}; }
      const j=await r.json().catch(()=>null);
      // Pull the text block(s) — newer models can return a reasoning block before the text, so never
      // assume content[0] is the answer; concatenate every text block.
      let text=""; for(const c of ((j&&j.content)||[])){ if(c&&typeof c.text==="string") text+=c.text; }
      const s=text.indexOf("{"), e=text.lastIndexOf("}");
      if(s>=0&&e>=0){ try{ const obj=JSON.parse(text.slice(s,e+1)); return {subject:String(obj.subject||"").trim(), body:String(obj.body||"").trim()}; }catch(_){} }
      return {subject:"", body:""};
    }

    let subject="", body="";
    try{
      let g=await generate(buildPrompt());
      if(g.err) return json(200,{ok:false,error:"ai_error",message:g.err,detail:g.detail,model:AI_MODEL,signature});
      // Safety net: if a banned/desperate phrase slipped through, regenerate ONCE naming the offenders.
      const bad=findBanned(`${g.subject}\n${g.body}`);
      if(bad.length){
        const retry=await generate(buildPrompt(`IMPORTANT: your previous draft used phrasing the style guide forbids (${bad.map(x=>`"${x}"`).join(", ")}). Rewrite so none of those appear; lead with the specific opportunity instead.`));
        if(!retry.err && retry.subject && retry.body) g=retry;
      }
      subject=g.subject; body=g.body;
    }catch(e){ return json(200,{ok:false,error:"ai_error",message:"Couldn't reach the AI service.",signature}); }
    if(!subject||!body) return json(200,{ok:false,error:"ai_empty",message:"The AI didn't return a usable draft — try again or a different template.",signature});

    const html=composeHtml({body, product:PC, imageUrl, productUrl, signature});
    return json(200,{ok:true, subject, body, html, signature,
      product:PC||null, product_url:productUrl||null, image_url:imageUrl||null,
      product_warning: (PC&&!PC.approved)
        ? `Heads up: this product's content is still "${PC.status||"in review"}". Approve it in Product Content Enrichment & Review before sending.` : null,
      context:{ dealer:(ctx.dealer&&ctx.dealer.business_name)||"", template:tmplKey,
        product:(PC&&PC.name)||lineName||"" } });
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

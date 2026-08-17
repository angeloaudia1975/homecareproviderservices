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
const AI_MODEL = process.env.HCPS_AI_MODEL || "claude-3-5-sonnet-latest";
const ORDERING_BASE = process.env.ORDERING_BASE || "https://hcpsonlineordering.netlify.app";

const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
const { dealerScope, isAdmin } = require("./_scope.js");

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

exports.handler=async(event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{return json(400,{error:"bad JSON"});}
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

    const prompt=`You write short, warm, professional B2B sales emails for HomeCare Provider Services (HCPS), a manufacturers' rep group that sells home-medical-equipment lines to durable-medical-equipment (DME) dealers.

Write ONE email from the rep (${me.name||"the HCPS rep"}) to a dealer contact${firstName?` named ${firstName}`:""}.

Situation / purpose of this email:
${tmpl}

What we know about this account (use only what's relevant; never invent facts or numbers):
${contextLines(ctx)}

Rules:
- Greeting to the contact by first name if provided ("Hi ${firstName||"there"},").
- 2 to 4 short paragraphs, plain sentences, no marketing fluff, no emojis.
- Reference the account specifics that fit the purpose (a line they buy, a dormant line, health, cadence) — but don't dump data; be natural.
- End with a clear, low-pressure next step (a question or a soft ask).
- Do NOT include a signature or sign-off block (no "Best,"/name) — that is added separately.
- Keep it concise: a busy dealer should read it in 20 seconds.

Return ONLY a JSON object with exactly these keys:
  "subject": a specific subject line, <= 60 characters, no emojis
  "body": the email body as plain text with real line breaks between paragraphs (no HTML, no signature)
Do not include markdown or any text outside the JSON.`;

    let subject="", body="";
    try{
      const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
        headers:{"x-api-key":AI_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},
        body:JSON.stringify({model:AI_MODEL,max_tokens:900,messages:[{role:"user",content:prompt}]})});
      if(!r.ok){ const t=await r.text().catch(()=>""); return json(200,{ok:false,error:"ai_error",message:"The AI service returned an error. Try again.",detail:t.slice(0,200),signature}); }
      const j=await r.json().catch(()=>null);
      let text=(j&&j.content&&j.content[0]&&j.content[0].text)||"";
      const s=text.indexOf("{"), e=text.lastIndexOf("}");
      if(s>=0&&e>=0){ const obj=JSON.parse(text.slice(s,e+1)); subject=String(obj.subject||"").trim(); body=String(obj.body||"").trim(); }
    }catch(e){ return json(200,{ok:false,error:"ai_error",message:"Couldn't reach the AI service.",signature}); }
    if(!subject||!body) return json(200,{ok:false,error:"ai_empty",message:"The AI didn't return a usable draft — try again or a different template.",signature});

    return json(200,{ok:true, subject, body, signature,
      context:{ dealer:(ctx.dealer&&ctx.dealer.business_name)||"", template:tmplKey } });
  }catch(e){ return json(500,{error:String(e.message||e)}); }
};

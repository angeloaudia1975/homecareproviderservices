// HCPS — Sales Call Strategy & Outreach Assistant (the engine behind Who to Call).
//
//   POST {action:"worklist"}                     -> ranked dealers to call, scoped to the caller
//   POST {action:"dossier",  dealer_id}          -> the account evidence pack, no AI
//   POST {action:"brief",    dealer_id, refresh?}-> the call strategy (cached until signals move)
//   POST {action:"log_outcome", ...}             -> record the call + generate the follow-up
//   POST {action:"insights"}                     -> what is actually working, once enough calls exist
//
// Suggest-and-approve, like the Dealer 360 email composer: nothing here sends, posts or
// commits anything to a dealer. log_outcome is the only writer, and it only runs when a rep
// has told it what happened.
//
// Auth: any active staff member. Management and a Relations Manager work the whole territory;
// a sales rep sees their own book. One rule, from _scope.js.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const AI_KEY   = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.HCPS_AI_MODEL || "claude-sonnet-5";

const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},
    body:body!=null?JSON.stringify(body):undefined});
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const t=await r.text(); return t?JSON.parse(t):null;
}
async function sbGetAll(base, orderCol="id"){
  const PAGE=1000; let from=0,out=[];
  for(;;){ const sep=base.includes("?")?"&":"?";
    const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`);
    out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; }
  return out;
}
const { dealerScope, isAdmin, seesAllDealers } = require("./_scope.js");
const { loadStyleGuide, findBanned } = require("./_ai_style.js");

// A missing table means the migration hasn't run — say which file, don't 500.
const MISSING = /PGRST20[45]|Could not find the table/i;
function setupNeeded(e, file){
  const m=String((e&&e.message)||e);
  return MISSING.test(m) ? {error:"storage_missing", setup:file, detail:m.slice(0,200)} : null;
}

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{
      const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email,signature:su.email_signature||""}; } }
    }catch(e){}
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",rep_name:"",name:"Admin",email:"",signature:""};
  return null;
}

const MONTH=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const pmOf=p=>{ const s=String(p||"").slice(0,7); const[y,m]=s.split("-").map(Number); return (y&&m)?(y*12+(m-1)):null; };
const pmLbl=n=>n==null?"":MONTH[((n%12)+12)%12]+" "+Math.floor(n/12);
const money=n=>"$"+Math.round(Number(n)||0).toLocaleString();
const clean=(s,n)=>String(s==null?"":s).trim().slice(0,n||2000);
const median=a=>{ if(!a.length) return null; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const daysAgo=t=>{ const d=new Date(t).getTime(); return isNaN(d)?null:Math.floor((Date.now()-d)/864e5); };
const ymd=d=>d.toISOString().slice(0,10);
function addDays(n){ const d=new Date(); d.setDate(d.getDate()+n); return ymd(d); }

/* A stable digest of the inputs a brief was built from. Same key -> the account has not
   moved -> reuse the brief instead of paying for another generation. Deliberately coarse on
   the intent score (banded) so ordinary drift doesn't invalidate a good brief hourly. */
function signalsKey(d){
  const parts=[
    d.sales && d.sales.last_period, d.sales && Math.round(d.sales.total||0),
    (d.lines||[]).map(l=>`${l.manufacturer}:${l.relationship}:${l.months_since}`).join(","),
    d.health && d.health.status, d.health && d.health.trend,
    d.intent && Math.round((d.intent.score||0)/10),
    d.latest && d.latest.note, d.latest && d.latest.activity, d.latest && d.latest.visit, d.latest && d.latest.email,
    d.cart && d.cart.value,
    (d.crosssell||[]).map(c=>c.rec_name).join(","),
  ].join("|");
  let h=5381; for(let i=0;i<parts.length;i++) h=((h*33)^parts.charCodeAt(i))>>>0;
  return h.toString(36)+"-"+parts.length.toString(36);
}

/* ===========================================================================
   The evidence pack. Every item Angelo listed, pulled from the table that owns it.
   Each query is independently defensive: one missing table degrades that section
   rather than losing the whole dossier, because a brief built from nine sources is
   still worth far more than an error page.
   =========================================================================== */
async function gatherDossier(dealerId){
  const did=encodeURIComponent(dealerId);
  const g=(p,f)=>sbGet(p).catch(()=>f);

  const [dealer, sales, lines, notes, acts, visits, emails, xs, health, intent, camps, accts, opps, cartRows] = await Promise.all([
    g(`dealers?id=eq.${did}&select=id,business_name,city,state,zip,email,phone,rep_name,hcps_account`, []),
    g(`monthly_sales?dealer_id=eq.${did}&select=manufacturer,period,amount`, []),
    g(`dealer_line_status?dealer_id=eq.${did}&select=manufacturer,relationship,months_since,last_order_period,status_since`, []),
    g(`dealer_notes?dealer_id=eq.${did}&select=*&order=created_at.desc&limit=8`, []),
    g(`dealer_activity?dealer_id=eq.${did}&select=*&order=created_at.desc&limit=12`, []),
    g(`dealer_visit_reports?dealer_id=eq.${did}&select=*&order=completed_at.desc&limit=3`, []),
    g(`email_messages?dealer_id=eq.${did}&select=subject,from_name,from_address,direction,received_at&order=received_at.desc&limit=8`, []),
    g(`cross_sell?dealer_id=eq.${did}&select=rec_name,basis_name,score,support,rank&order=rank.asc&limit=5`, []),
    g(`dealer_engagement?dealer_id=eq.${did}&select=status,score,churn_score,months_since,trend,total_sales,recent_sales,last_period`, []),
    g(`dealer_intent?dealer_id=eq.${did}&select=score_total,by_manufacturer,top_manufacturer,top_product,last_event_at`, []),
    g(`email_sends?dealer_id=eq.${did}&select=template,sent_at&order=sent_at.desc&limit=6`, []),
    g(`dealer_manufacturers?dealer_id=eq.${did}&select=manufacturer,account_ref,active`, []),
    g(`opportunities?dealer_id=eq.${did}&select=title,line,stage,value,expected_close&limit=5`, []),
    g(`dealer_carts?dealer_id=eq.${did}&select=cart,updated_at&order=updated_at.desc&limit=1`, []),
  ]);

  const D=(dealer&&dealer[0])||{};

  // ---- sales: totals, cadence per line, and what they have STOPPED buying -------------
  const byLine={}; let total=0, lastPm=null, firstPm=null;
  for(const r of (sales||[])){
    const amt=Number(r.amount)||0, p=pmOf(r.period); if(p==null) continue;
    total+=amt;
    if(lastPm==null||p>lastPm) lastPm=p;
    if(firstPm==null||p<firstPm) firstPm=p;
    const k=r.manufacturer||"?";
    const o=byLine[k]||(byLine[k]={manufacturer:k,total:0,pms:new Set(),last:null});
    o.total+=amt; o.pms.add(p); if(o.last==null||p>o.last) o.last=p;
  }
  // "now" is the newest month anywhere in the dataset, not the wall clock — commission
  // imports land a month or two behind, and cadence must be judged on the same calendar.
  let latest=lastPm;
  try{
    const mx=await sbGet("monthly_sales?select=period&order=period.desc&limit=1");
    const p=pmOf(mx&&mx[0]&&mx[0].period); if(p!=null) latest=p;
  }catch(e){}

  const lineRows=Object.values(byLine).map(o=>{
    const pms=[...o.pms].sort((a,b)=>a-b);
    const gaps=[]; for(let i=1;i<pms.length;i++) gaps.push(pms[i]-pms[i-1]);
    const cadence=median(gaps);
    const since=latest!=null&&o.last!=null?(latest-o.last):null;
    const overdue = cadence!=null && cadence>0 && since!=null && since >= cadence+Math.max(1,Math.round(cadence*0.5));
    return { manufacturer:o.manufacturer, total:Math.round(o.total), orders:pms.length,
             last_period:pmLbl(o.last), months_since:since,
             cadence_months:cadence!=null?Math.round(cadence*10)/10:null, overdue };
  }).sort((a,b)=>b.total-a.total);

  // Lines the relationship matrix knows about, including ones they've gone quiet on.
  const statusBy={}; for(const l of (lines||[])) statusBy[l.manufacturer]=l;
  const lapsed=lineRows.filter(l=>{
    const st=statusBy[l.manufacturer];
    return (st && st.relationship==="dormant") || (l.months_since!=null && l.months_since>=6 && l.orders>=2);
  }).map(l=>({manufacturer:l.manufacturer, last_period:l.last_period, months_since:l.months_since, total:l.total}));

  // ---- lines HCPS carries that this dealer has never bought ---------------------------
  let available=[];
  try{
    const all=await sbGet("manufacturers?select=slug,name,active");
    const bought=new Set(lineRows.map(l=>String(l.manufacturer||"").toLowerCase()));
    const known=new Set(Object.keys(statusBy).map(s=>String(s||"").toLowerCase()));
    available=(all||[]).filter(m=>m.active!==false)
      .filter(m=>!bought.has(String(m.slug||"").toLowerCase()) && !bought.has(String(m.name||"").toLowerCase())
                && !known.has(String(m.slug||"").toLowerCase()))
      .map(m=>({slug:m.slug,name:m.name||m.slug}));
  }catch(e){}

  // ---- regional signal: what dealers in the same state are buying that this one isn't --
  let regional=[];
  try{
    if(D.state){
      const peers=await sbGet(`dealers?state=eq.${encodeURIComponent(D.state)}&select=id&limit=400`);
      const ids=(peers||[]).map(p=>p.id).filter(x=>x&&x!==dealerId).slice(0,200);
      if(ids.length){
        const since=pmLbl(latest!=null?latest-11:null);
        const rows=await sbGet(`monthly_sales?dealer_id=in.(${ids.join(",")})&select=manufacturer,amount,period&limit=20000`);
        const cut = latest!=null ? latest-11 : null;
        const tally={};
        for(const r of (rows||[])){
          const p=pmOf(r.period); if(cut!=null && (p==null||p<cut)) continue;
          const k=r.manufacturer||"?"; const t=tally[k]||(tally[k]={manufacturer:k,total:0,dealers:new Set()});
          t.total+=Number(r.amount)||0; t.dealers.add(r.dealer_id);
        }
        const mine=new Set(lineRows.map(l=>l.manufacturer));
        regional=Object.values(tally).map(t=>({manufacturer:t.manufacturer,total:Math.round(t.total),
            peer_dealers:t.dealers.size, this_dealer_buys:mine.has(t.manufacturer)}))
          .sort((a,b)=>b.total-a.total).slice(0,8);
        void since;
      }
    }
  }catch(e){}

  // ---- open cart ----------------------------------------------------------------------
  let cart=null;
  try{
    const c=(cartRows&&cartRows[0])||null;
    const items=c&&c.cart&&(Array.isArray(c.cart)?c.cart:(c.cart.items||[]));
    if(items&&items.length){
      cart={ items:items.length, updated_at:c.updated_at,
             value:Math.round(items.reduce((s,i)=>s+((Number(i.qty)||0)*(Number(i.unit_price||i.price)||0)),0)),
             products:items.slice(0,6).map(i=>clean(i.name||i.code,80)) };
    }
  }catch(e){}

  const HE=(health&&health[0])||{}, IN=(intent&&intent[0])||{};
  const dossier={
    dealer:{ id:D.id||dealerId, name:D.business_name||"", city:D.city||"", state:D.state||"",
             rep:D.rep_name||"", account:D.hcps_account||"", phone:D.phone||"", email:D.email||"" },
    sales:{ total:Math.round(total), last_period:pmLbl(lastPm), months_since:latest!=null&&lastPm!=null?latest-lastPm:null,
            first_period:pmLbl(firstPm), recent:Math.round(Number(HE.recent_sales)||0) },
    lines:lineRows.slice(0,10).map(l=>({...l, relationship:(statusBy[l.manufacturer]||{}).relationship||null})),
    lapsed: lapsed.slice(0,5),
    overdue: lineRows.filter(l=>l.overdue).slice(0,5)
              .map(l=>({manufacturer:l.manufacturer,months_since:l.months_since,cadence_months:l.cadence_months,total:l.total})),
    available_lines: available.slice(0,8),
    regional: regional,
    crosssell: (xs||[]).map(c=>({recommend:c.rec_name,because_they_buy:c.basis_name,score:c.score,support:c.support})),
    health:{ status:HE.status||null, score:HE.score!=null?HE.score:null, trend:HE.trend||null,
             churn_score:HE.churn_score!=null?HE.churn_score:null, months_since:HE.months_since!=null?HE.months_since:null },
    intent:{ score:IN.score_total!=null?IN.score_total:null, top_manufacturer:IN.top_manufacturer||null,
             top_product:IN.top_product||null, last_event_at:IN.last_event_at||null },
    cart,
    notes: (notes||[]).map(n=>({kind:n.kind||"note", author:n.author_name||n.author_email||"", days_ago:daysAgo(n.created_at), body:clean(n.body,600)})),
    activity: (acts||[]).map(a=>({kind:a.kind||"", subject:clean(a.subject,140), detail:clean(a.detail,240),
                                  actor:a.actor||"", days_ago:daysAgo(a.created_at)})),
    visits: (visits||[]).map(v=>({ days_ago:daysAgo(v.completed_at||v.checkin_at), status:v.status||"",
                                   summary:clean(typeof v.fields==="string"?v.fields:JSON.stringify(v.fields||{}),600) })),
    emails: (emails||[]).map(e=>({ direction:e.direction||"", subject:clean(e.subject,140),
                                   who:e.from_name||e.from_address||"", days_ago:daysAgo(e.received_at) })),
    campaigns: (camps||[]).map(c=>({template:c.template||"", days_ago:daysAgo(c.sent_at)})),
    accounts: (accts||[]).filter(a=>a.active!==false).map(a=>({manufacturer:a.manufacturer, account_ref:a.account_ref||""})),
    opportunities: (opps||[]).map(o=>({title:clean(o.title,120), line:o.line||"", stage:o.stage||"", value:o.value||null, expected_close:o.expected_close||null})),
    latest:{ note:(notes&&notes[0]&&notes[0].created_at)||null, activity:(acts&&acts[0]&&acts[0].created_at)||null,
             visit:(visits&&visits[0]&&(visits[0].completed_at||visits[0].checkin_at))||null,
             email:(emails&&emails[0]&&emails[0].received_at)||null },
  };
  dossier.signals_key=signalsKey(dossier);
  return dossier;
}

/* ===========================================================================
   The brief. The prompt is built ONLY from dossier facts; the model is told in as many
   words that it may not invent a number, product, date or conversation. Anything the
   dossier does not carry is simply absent from the prompt, so there is nothing to
   embroider. The rep edits everything before it is used.
   =========================================================================== */
function briefPrompt(d, style, learned){
  const L=[];
  const put=(h,v)=>{ if(v && String(v).trim()) L.push(h+"\n"+v); };
  const list=(a,f)=>(a&&a.length)?a.map(f).join("\n"):"";

  L.push(`DEALER: ${d.dealer.name}${d.dealer.city?` — ${d.dealer.city}, ${d.dealer.state}`:""}`);
  if(d.dealer.rep) L.push(`Their HCPS rep: ${d.dealer.rep}`);

  put("PURCHASE HISTORY:", [
    d.sales.total?`Lifetime with HCPS: ${money(d.sales.total)}`:"",
    d.sales.last_period?`Last order: ${d.sales.last_period}${d.sales.months_since!=null?` (${d.sales.months_since} months ago)`:""}`:"",
    d.sales.first_period?`First order: ${d.sales.first_period}`:"",
  ].filter(Boolean).join("\n"));

  put("LINES THEY BUY (largest first):",
    list(d.lines,l=>`- ${l.manufacturer}: ${money(l.total)} across ${l.orders} month(s), last ${l.last_period}`
      +(l.cadence_months?`, usually every ~${l.cadence_months}mo`:"")
      +(l.overdue?" — OVERDUE":"")));
  put("LINES THEY HAVE STOPPED BUYING:",
    list(d.lapsed,l=>`- ${l.manufacturer}: last ${l.last_period}, ${l.months_since}mo ago, was worth ${money(l.total)}`));
  put("OVERDUE TO REORDER:",
    list(d.overdue,l=>`- ${l.manufacturer}: ${l.months_since}mo since last order, usual cycle ~${l.cadence_months}mo`));
  put("CROSS-SELL THE ENGINE SUGGESTS:",
    list(d.crosssell,c=>`- ${c.recommend} (because they buy ${c.because_they_buy})`));
  put("HCPS LINES THIS DEALER HAS NEVER BOUGHT:", (d.available_lines||[]).map(m=>m.name).join(", "));
  put("WHAT DEALERS IN THEIR STATE BUY (last 12 months):",
    list((d.regional||[]).filter(r=>!r.this_dealer_buys).slice(0,5),
      r=>`- ${r.manufacturer}: ${r.peer_dealers} nearby dealer(s), ${money(r.total)} — this dealer buys none`));
  put("ACCOUNT HEALTH:", [
    d.health.status?`Status: ${d.health.status}`:"",
    d.health.trend?`Trend: ${d.health.trend}`:"",
    d.health.score!=null?`Score: ${d.health.score}`:"",
  ].filter(Boolean).join(" · "));
  put("BUYING-INTENT SIGNALS:", [
    d.intent.score!=null?`Intent score ${d.intent.score}`:"",
    d.intent.top_manufacturer?`most interest in ${d.intent.top_manufacturer}`:"",
    d.intent.top_product?`viewed ${d.intent.top_product}`:"",
  ].filter(Boolean).join(" · "));
  if(d.cart) put("OPEN CART RIGHT NOW:", `${d.cart.items} item(s), about ${money(d.cart.value)}: ${(d.cart.products||[]).join(", ")}`);
  put("RECENT CRM NOTES (newest first):",
    list(d.notes,n=>`- [${n.kind}] ${n.days_ago!=null?n.days_ago+"d ago":""} by ${n.author}: ${n.body}`));
  put("RECENT CALLS, VISITS AND MEETINGS:",
    list(d.activity,a=>`- [${a.kind}] ${a.days_ago!=null?a.days_ago+"d ago":""}: ${a.subject}${a.detail?` — ${a.detail}`:""}`));
  put("FIELD VISIT REPORTS:", list(d.visits,v=>`- ${v.days_ago!=null?v.days_ago+"d ago":""}: ${v.summary}`));
  put("RECENT EMAIL WITH THIS DEALER:",
    list(d.emails,e=>`- ${e.direction==="out"?"we wrote":"they wrote"} ${e.days_ago!=null?e.days_ago+"d ago":""}: ${e.subject}`));
  put("MARKETING THEY HAVE BEEN SENT:", list(d.campaigns,c=>`- ${c.template} (${c.days_ago}d ago)`));
  put("OPEN OPPORTUNITIES:", list(d.opportunities,o=>`- ${o.title} (${o.stage}${o.value?`, ${money(o.value)}`:""})`));
  put("MANUFACTURER ACCOUNT NUMBERS ON FILE:", (d.accounts||[]).map(a=>`${a.manufacturer}${a.account_ref?` #${a.account_ref}`:""}`).join(", "));

  if(learned) put("WHAT HAS ACTUALLY WORKED ACROSS THE HCPS NETWORK:", learned);

  return `You are briefing an experienced HCPS manufacturer-rep before an outbound call to a home medical equipment dealer. HCPS represents 12 manufacturer lines across Kentucky, Tennessee, Southern Ohio, Southern Indiana and North Georgia.

Write the call strategy from the account facts below. These facts are the ONLY thing you know about this dealer.

HARD RULES — a brief that breaks one of these is useless and possibly harmful:
- Never invent a number, product name, manufacturer, date, person, price, promotion or past conversation. If it is not in the facts below, it does not exist.
- Never claim something was said, sent or promised unless the notes, activity, visits or email below record it.
- If the facts are thin, say so in the reason and build a genuine discovery call instead of manufacturing urgency.
- Do not reference a lapsed line as "recent" or an overdue reorder as confirmed — these are inferences from ordering cadence, so phrase them as the rep noticing a pattern, not as fact.
- The rep will read the script aloud. Write how a person talks, in short sentences. No marketing voice, no superlatives.

HOUSE WRITING STYLE:
${style}

ACCOUNT FACTS
${L.join("\n\n")}

Return ONLY a JSON object, no markdown and no text outside it:
{
  "reason": "1-2 sentences: why this dealer is worth a call today, citing the specific fact that makes it true",
  "opportunity": { "headline": "the single strongest opportunity, <=70 chars", "manufacturer": "the line it concerns, or empty", "angle": "one of: reorder | cross_sell | new_line | winback | new_product | intent | relationship | discovery", "detail": "2-3 sentences on why this is the best play and what it is worth" },
  "opening": "2-3 sentences the rep can say verbatim once the dealer picks up. It must give a concrete reason for the call drawn from the facts.",
  "script": "a natural conversational script of 150-250 words, in the rep's voice, with (pause) markers where the dealer talks. Built on this dealer's actual history.",
  "questions": ["4-6 discovery questions specific to this account — inventory, patient demand, competing products, business conditions, what changed"],
  "recommendations": [{ "name": "product or manufacturer", "why": "one line tied to a fact above" }],
  "objections": [{ "objection": "what this dealer is likely to say, based on their history", "response": "how to answer it honestly" }],
  "next_step": { "action": "one of: send_info | schedule_appointment | send_quote | introduce_line | showroom | discuss_reorder | follow_up_call", "detail": "one line on what to do", "due_in_days": 7 }
}`;
}

async function callClaude(prompt, maxTokens){
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
    headers:{"x-api-key":AI_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},
    body:JSON.stringify({model:AI_MODEL,max_tokens:maxTokens||2200,messages:[{role:"user",content:prompt}]})});
  if(!r.ok){ const t=await r.text().catch(()=>""); let hint="";
    try{ const ej=JSON.parse(t); hint=(ej&&ej.error&&ej.error.message)?` (${ej.error.message})`:""; }catch(_){}
    return {err:`The AI service returned an error${hint}.`, detail:t.slice(0,200)}; }
  const j=await r.json().catch(()=>null);
  // Newer models can emit a reasoning block before the answer — concatenate every text block
  // rather than assuming content[0] is it.
  let text=""; for(const c of ((j&&j.content)||[])) if(c&&typeof c.text==="string") text+=c.text;
  const s=text.indexOf("{"), e=text.lastIndexOf("}");
  if(s>=0&&e>=0){ try{ return {obj:JSON.parse(text.slice(s,e+1))}; }catch(_){} }
  return {err:"The AI didn't return a usable brief.", detail:text.slice(0,200)};
}

function normalizeBrief(o){
  const arr=(v,n)=>Array.isArray(v)?v.slice(0,n):[];
  const op=o.opportunity||{};
  const ns=o.next_step||{};
  return {
    reason: clean(o.reason,600),
    opportunity:{ headline:clean(op.headline,120), manufacturer:clean(op.manufacturer,80),
                  angle:clean(op.angle,40)||"discovery", detail:clean(op.detail,800) },
    opening: clean(o.opening,900),
    script: clean(o.script,3000),
    questions: arr(o.questions,8).map(q=>clean(q,220)).filter(Boolean),
    recommendations: arr(o.recommendations,6).map(r=>({name:clean(r&&r.name,100), why:clean(r&&r.why,240)})).filter(r=>r.name),
    objections: arr(o.objections,5).map(r=>({objection:clean(r&&r.objection,220), response:clean(r&&r.response,600)})).filter(r=>r.objection),
    next_step:{ action:clean(ns.action,40)||"follow_up_call", detail:clean(ns.detail,240),
                due_in_days: Math.min(60, Math.max(1, parseInt(ns.due_in_days,10)||7)) },
  };
}

module.exports.handler = async (event) => {
  if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
  let b={}; try{ b=JSON.parse(event.body||"{}"); }catch(e){ return json(400,{error:"bad JSON"}); }
  const me=await whoami(event);
  if(!me) return json(401,{error:"unauthorized"});

  try{
    // Per-dealer access: management and a Relations Manager work any dealer; a rep their own.
    if(b.dealer_id && !isAdmin(me)){
      const sc=await dealerScope(me, sbGet);
      if(!sc.isAll && !(sc.ids && sc.ids.has(String(b.dealer_id)))) return json(403,{error:"Not your dealer"});
    }

    if(b.action==="dossier"){
      if(!b.dealer_id) return json(400,{error:"dealer_id required"});
      return json(200,{ok:true, dossier:await gatherDossier(b.dealer_id)});
    }

    if(b.action==="brief"){
      if(!b.dealer_id) return json(400,{error:"dealer_id required"});
      const dossier=await gatherDossier(b.dealer_id);

      // Reuse a brief while the account hasn't moved. This is the whole cost story.
      if(!b.refresh){
        try{
          const hit=await sbGet(`call_briefs?dealer_id=eq.${encodeURIComponent(b.dealer_id)}&signals_key=eq.${encodeURIComponent(dossier.signals_key)}&select=*&order=created_at.desc&limit=1`);
          if(hit&&hit[0]) return json(200,{ok:true, cached:true, brief_id:hit[0].id, brief:hit[0].brief,
                                           dossier, generated_at:hit[0].created_at, model:hit[0].model});
        }catch(e){ const s=setupNeeded(e,"supabase/call_workspace.sql"); if(s) return json(503,s); }
      }

      if(!AI_KEY) return json(200,{ok:false, error:"ai_unavailable", dossier,
        message:"Call strategy needs ANTHROPIC_API_KEY set in Netlify. The account evidence below is still live."});

      const style=await loadStyleGuide(sbGet);
      const learned=await learnedSummary().catch(()=>null);
      let g=await callClaude(briefPrompt(dossier, style, learned));
      if(g.err) return json(200,{ok:false, error:"ai_error", message:g.err, detail:g.detail, dossier, model:AI_MODEL});
      let brief=normalizeBrief(g.obj||{});
      const bad=findBanned(`${brief.opening}\n${brief.script}`);
      if(bad.length){
        const retry=await callClaude(briefPrompt(dossier, style, learned)+
          `\n\nIMPORTANT: your previous draft used phrasing the style guide forbids (${bad.map(x=>`"${x}"`).join(", ")}). Rewrite so none of those appear.`);
        if(!retry.err && retry.obj) brief=normalizeBrief(retry.obj);
      }
      if(!brief.reason || !brief.script) return json(200,{ok:false, error:"ai_empty", dossier,
        message:"The AI didn't return a usable brief — try again."});

      let saved=null;
      try{
        const ins=await sbSend("POST","call_briefs",{
          dealer_id:b.dealer_id, brief, dossier, signals_key:dossier.signals_key,
          angle:brief.opportunity.angle, manufacturer:brief.opportunity.manufacturer||null,
          model:AI_MODEL, generated_by:me.email||me.name||null },{Prefer:"return=representation"});
        saved=(ins&&ins[0])||null;
      }catch(e){
        const s=setupNeeded(e,"supabase/call_workspace.sql");
        // A brief that can't be cached is still a brief — hand it over and say it wasn't saved.
        return json(200,{ok:true, cached:false, brief, dossier, model:AI_MODEL, brief_id:null,
          warning: s ? "Run supabase/call_workspace.sql to start saving briefs and call outcomes — this one wasn't stored."
                     : "This brief couldn't be saved, so it will be regenerated next time."});
      }
      return json(200,{ok:true, cached:false, brief_id:saved&&saved.id, brief, dossier, model:AI_MODEL,
                       generated_at:saved&&saved.created_at});
    }

    if(b.action==="worklist")     return await worklist(me);
    if(b.action==="log_outcome")  return await logOutcome(me,b);
    if(b.action==="insights")     return await insights(me);

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String((e&&e.message)||e)}); }
};

/* ===========================================================================
   The worklist. Built server-side from the engine's own tables rather than the
   analytics cube, which is why this page no longer needs to be president-only:
   the same _scope rule that governs Dealer 360 governs the list.
   =========================================================================== */
async function worklist(me){
  const g=(p,f)=>sbGet(p).catch(()=>f);
  const [dealers, eng, intent, lines, carts, sess] = await Promise.all([
    sbGetAll("dealers?select=id,business_name,city,state,rep_name").catch(()=>[]),
    g("dealer_engagement?select=dealer_id,status,score,churn_score,months_since,trend,total_sales,recent_sales,last_period&limit=5000", []),
    g("dealer_intent?select=dealer_id,score_total,top_manufacturer,top_product,last_event_at&limit=5000", []),
    g("dealer_line_status?select=dealer_id,manufacturer,relationship,months_since&limit=20000", []),
    g("dealer_carts?select=dealer_id,cart,updated_at&limit=2000", []),
    g("dealer_sessions?select=dealer_id,last_seen_at&limit=5000", []),
  ]);

  // Scope: a rep sees their own book, management and relations see everything.
  let allowed=null;
  if(!seesAllDealers(me)){
    const sc=await dealerScope(me, sbGet);
    allowed = sc.isAll ? null : (sc.ids||new Set());
  }

  const engBy={}; for(const e of eng) engBy[e.dealer_id]=e;
  const intBy={}; for(const i of intent) intBy[i.dealer_id]=i;
  const lineBy={}; for(const l of lines) (lineBy[l.dealer_id]||(lineBy[l.dealer_id]=[])).push(l);
  const cartBy={};
  for(const c of carts){
    try{
      const items=c.cart&&(Array.isArray(c.cart)?c.cart:(c.cart.items||[]));
      if(!items||!items.length) continue;
      const value=Math.round(items.reduce((s,i)=>s+((Number(i.qty)||0)*(Number(i.unit_price||i.price)||0)),0));
      const prev=cartBy[c.dealer_id];
      if(!prev||value>prev.value) cartBy[c.dealer_id]={value,items:items.length,at:c.updated_at};
    }catch(e){}
  }
  const seenBy={};
  for(const s of sess){ const t=new Date(s.last_seen_at).getTime();
    if(!isNaN(t) && (!seenBy[s.dealer_id]||t>seenBy[s.dealer_id])) seenBy[s.dealer_id]=t; }

  const out=[];
  for(const d of dealers){
    if(allowed && !allowed.has(String(d.id))) continue;
    const e=engBy[d.id]||{}, i=intBy[d.id]||{};
    const reasons=[]; let score=0;

    const cart=cartBy[d.id];
    if(cart){ reasons.push({t:"cart", label:`🛒 Open cart ${money(cart.value)}${cart.items?` · ${cart.items} item${cart.items===1?"":"s"}`:""}`});
              score+=100000+cart.value; }

    const seen=seenBy[d.id];
    if(seen && (Date.now()-seen)<21*864e5){
      const days=Math.max(0,Math.round((Date.now()-seen)/864e5));
      reasons.push({t:"login", label:days===0?"👤 Logged in today":`👤 Logged in ${days}d ago`});
      score+=50000-(days*100);
    }
    if(Number(i.score_total)>0){
      reasons.push({t:"intent", label:`🎯 Intent ${Math.round(i.score_total)}${i.top_manufacturer?` · ${i.top_manufacturer}`:""}`});
      score+=Number(i.score_total)*300;
    }
    const od=(lineBy[d.id]||[]).filter(l=>l.relationship==="dormant"&&Number(l.months_since)>=3);
    for(const l of od.slice(0,3)){ reasons.push({t:"overdue", label:`⏰ ${l.manufacturer}: ${l.months_since}mo`}); score+=8000; }

    if(e.status==="at_risk"){ reasons.push({t:"risk", label:`⚠ At risk${e.churn_score?` · urgency ${e.churn_score}`:""}`}); score+=Number(e.total_sales||0)*0.4; }
    else if(e.status==="dormant"){ reasons.push({t:"dormant", label:`💤 Dormant ${e.months_since||"?"}mo`}); score+=Number(e.total_sales||0)*0.3; }
    else if(e.status==="new"){ reasons.push({t:"new", label:"✨ New account"}); score+=20000; }
    if(e.trend==="down"){ reasons.push({t:"declining", label:"▼ Declining"}); score+=Number(e.recent_sales||0)*0.5; }

    if(!reasons.length) continue;
    out.push({ id:d.id, dealer:d.business_name||"", city:d.city||"", state:d.state||"",
      rep:d.rep_name||e.rep_name||"", sales:Math.round(Number(e.total_sales)||0),
      last_period:e.last_period||null, months_since:e.months_since!=null?e.months_since:null,
      health:e.status||null, trend:e.trend||null, reasons, types:[...new Set(reasons.map(r=>r.t))],
      score:Math.round(score) });
  }
  out.sort((a,b)=>b.score-a.score);

  // Which of these have already been called, so the list can show today's progress.
  let done={};
  try{
    const since=new Date(Date.now()-14*864e5).toISOString();
    const rows=await sbGet(`call_outcomes?called_at=gte.${since}&select=dealer_id,outcome,called_at&order=called_at.desc&limit=2000`);
    for(const r of (rows||[])) if(!done[r.dealer_id]) done[r.dealer_id]={outcome:r.outcome, days_ago:daysAgo(r.called_at)};
  }catch(e){ /* table not there yet — the list still works */ }
  for(const x of out) x.last_call=done[x.id]||null;

  return json(200,{ok:true, dealers:out.slice(0,400), total:out.length,
                   scope: seesAllDealers(me)?"all":"own", rep:me.rep_name||null});
}

/* ===========================================================================
   Outcome capture and the follow-up it produces.

   Deliberately split: the CRM note, the task and the suggested date are assembled
   from the outcome and the rep's own words — deterministic, auditable, and not worth
   a model call. Only the follow-up EMAIL and the next call's script need language, so
   only those go to Claude. Nothing is sent; both land as drafts the rep edits.
   =========================================================================== */
const OUTCOMES={
  interested:      {label:"Interested",          win:true,  days:3,  task:"Follow up on interest"},
  quote_requested: {label:"Quote requested",     win:true,  days:2,  task:"Send quote"},
  appointment:     {label:"Appointment set",     win:true,  days:1,  task:"Confirm appointment"},
  send_info:       {label:"Send information",    win:true,  days:2,  task:"Send product information"},
  follow_up:       {label:"Follow up",           win:false, days:7,  task:"Follow-up call"},
  call_later:      {label:"Call later",          win:false, days:14, task:"Call back"},
  no_answer:       {label:"No answer",           win:false, days:3,  task:"Try again"},
  not_interested:  {label:"Not interested",      win:false, days:0,  task:""},
};

async function logOutcome(me,b){
  if(!b.dealer_id) return json(400,{error:"dealer_id required"});
  const key=String(b.outcome||"").toLowerCase();
  const O=OUTCOMES[key];
  if(!O) return json(400,{error:"unknown outcome", allowed:Object.keys(OUTCOMES)});

  const repNotes=clean(b.rep_notes,3000);
  const talkedTo=clean(b.talked_to,120);
  const angle=clean(b.angle,40)||null;
  const manufacturer=clean(b.manufacturer,80)||null;
  const dueDays=Number.isFinite(+b.follow_up_days)?Math.min(120,Math.max(0,+b.follow_up_days)):O.days;
  const followOn=dueDays>0?addDays(dueDays):null;

  // The dossier is needed for the follow-up language and the recommended materials.
  let dossier=null; try{ dossier=await gatherDossier(b.dealer_id); }catch(e){}
  const dealerName=(dossier&&dossier.dealer&&dossier.dealer.name)||"this dealer";

  // ---- the CRM note: the rep's own words, framed. No model involved. -------------------
  const noteBody=[
    `📞 Call — ${O.label}${talkedTo?` · spoke with ${talkedTo}`:""}`,
    manufacturer?`Line discussed: ${manufacturer}`:"",
    repNotes,
    followOn?`Next: ${clean(b.next_step,200)||O.task} by ${followOn}.`:"",
  ].filter(Boolean).join("\n");

  let noteId=null, taskId=null, outcomeId=null, warnings=[];
  // dealer_notes.kind is optional (supabase/dealer_note_kind.sql) — post without it if absent.
  try{
    const row={dealer_id:b.dealer_id, author_email:me.email||null, author_name:me.name||null, body:clean(noteBody,4000)};
    let ins;
    try{ ins=await sbSend("POST","dealer_notes",Object.assign({kind:"call"},row),{Prefer:"return=representation"}); }
    catch(e){ if(!/PGRST204|Could not find the 'kind' column/i.test(String(e.message||e))) throw e;
              ins=await sbSend("POST","dealer_notes",row,{Prefer:"return=representation"}); }
    noteId=(ins&&ins[0]&&ins[0].id)||null;
  }catch(e){ warnings.push("The CRM note couldn't be saved."); }

  try{
    await sbSend("POST","dealer_activity",{dealer_id:b.dealer_id, kind:"call",
      subject:`${O.label}${manufacturer?` — ${manufacturer}`:""}`,
      detail:clean(repNotes,2000)||null, actor:me.name||me.email||null},{Prefer:"return=minimal"});
  }catch(e){ warnings.push("The timeline entry couldn't be saved."); }

  if(O.task && followOn){
    try{
      const t=await sbSend("POST","dealer_tasks",{dealer_id:b.dealer_id,
        title:`${O.task}${manufacturer?` — ${manufacturer}`:""} · ${dealerName}`,
        detail:clean(b.next_step,2000)||clean(repNotes,2000)||null,
        due_date:followOn, priority:O.win?"high":"normal", source:"manual",
        assigned_rep:me.rep_name||null, created_by:me.name||me.email||null, status:"open"},{Prefer:"return=representation"});
      taskId=(t&&t[0]&&t[0].id)||null;
    }catch(e){ warnings.push("The follow-up task couldn't be created."); }
  }

  try{
    const o=await sbSend("POST","call_outcomes",{
      dealer_id:b.dealer_id, brief_id:b.brief_id||null, rep_name:me.rep_name||me.name||null, rep_email:me.email||null,
      outcome:key, angle, manufacturer, talked_to:talkedTo||null, rep_notes:repNotes||null,
      next_step:clean(b.next_step,400)||O.task||null, follow_up_on:followOn,
      note_id:noteId, task_id:taskId, call_hour:new Date().getHours()},{Prefer:"return=representation"});
    outcomeId=(o&&o[0]&&o[0].id)||null;
  }catch(e){
    const s=setupNeeded(e,"supabase/call_workspace.sql");
    warnings.push(s ? "Run supabase/call_workspace.sql — the call was logged to the CRM but not to the outcome history the learning report reads."
                    : "The call outcome couldn't be recorded for reporting.");
  }

  // ---- the parts that need language ---------------------------------------------------
  let followup=null;
  if(AI_KEY && key!=="no_answer"){
    try{
      const style=await loadStyleGuide(sbGet);
      const g=await callClaude(followupPrompt(dossier, O, key, repNotes, talkedTo, manufacturer, followOn, style, me), 1400);
      if(g.obj){
        followup={
          email_subject: clean(g.obj.email_subject,120),
          email_body:    clean(g.obj.email_body,3000),
          next_script:   clean(g.obj.next_script,2000),
          materials:     (Array.isArray(g.obj.materials)?g.obj.materials:[]).slice(0,5).map(m=>clean(m,140)).filter(Boolean),
        };
        if(!followup.email_subject && !followup.next_script) followup=null;
      }
    }catch(e){}
  }

  return json(200,{ok:true, outcome_id:outcomeId, note_id:noteId, task_id:taskId,
    follow_up_on:followOn, outcome:O.label, followup,
    recommended: dossier ? (dossier.crosssell||[]).slice(0,3).map(c=>c.recommend) : [],
    warnings: warnings.length?warnings:undefined});
}

function followupPrompt(d, O, key, repNotes, talkedTo, manufacturer, followOn, style, me){
  const facts=[];
  if(d){
    facts.push(`Dealer: ${d.dealer.name}${d.dealer.city?` — ${d.dealer.city}, ${d.dealer.state}`:""}`);
    if(d.sales.last_period) facts.push(`Last order ${d.sales.last_period}${d.sales.months_since!=null?` (${d.sales.months_since}mo ago)`:""}`);
    if((d.lines||[]).length) facts.push(`Buys: ${d.lines.slice(0,5).map(l=>l.manufacturer).join(", ")}`);
    if((d.overdue||[]).length) facts.push(`Overdue: ${d.overdue.map(l=>`${l.manufacturer} (${l.months_since}mo)`).join(", ")}`);
    if((d.crosssell||[]).length) facts.push(`Cross-sell suggestions: ${d.crosssell.map(c=>c.recommend).join(", ")}`);
  }
  return `An HCPS manufacturer-rep has just finished an outbound call and recorded the result. Write the follow-up.

CALL RESULT: ${O.label}
${talkedTo?`Spoke with: ${talkedTo}`:""}
${manufacturer?`Line discussed: ${manufacturer}`:""}
WHAT THE REP WROTE DOWN (this is the truth about the call — everything else is background):
${repNotes||"(the rep left no notes)"}

ACCOUNT BACKGROUND:
${facts.join("\n")||"(little on file)"}

${followOn?`The next contact is scheduled for ${followOn}.`:""}

HARD RULES:
- The rep's notes are the only record of what was actually said. Never contradict them, and never invent commitments, prices, dates or products that are not in the notes or background.
- If the notes are empty or vague, write something short and honest that asks rather than asserts.
- The email is from ${me.name||"the rep"} to the dealer, plain text, no signature, no subject line inside the body.

HOUSE WRITING STYLE:
${style}

Return ONLY JSON:
{
  "email_subject": "<=60 chars, names the specific thing, not \\"following up\\"",
  "email_body": "plain text follow-up email of 60-130 words with real line breaks",
  "next_script": "60-120 words the rep can say at the start of the NEXT call, picking up exactly where this one left off",
  "materials": ["specific product sheet, line overview or document worth sending, drawn only from the lines named above"]
}`;
}

/* ===========================================================================
   What is actually working. This is the part that must not lie: with a handful of
   calls, any "win rate by angle" is noise. Every cell carries its sample size, and a
   rate is only reported once the cell reaches MIN_N. Below that the report says so.
   =========================================================================== */
const MIN_N=8;                 // below this, a percentage is storytelling
const WIN=new Set(Object.keys(OUTCOMES).filter(k=>OUTCOMES[k].win));

function tally(rows, keyFn){
  const m={};
  for(const r of rows){
    const k=keyFn(r); if(!k) continue;
    const t=m[k]||(m[k]={key:k,n:0,wins:0});
    t.n++; if(WIN.has(r.outcome)) t.wins++;
  }
  return Object.values(m).map(t=>({
    key:t.key, calls:t.n, wins:t.wins,
    win_rate: t.n>=MIN_N ? Math.round((t.wins/t.n)*100) : null,
    enough: t.n>=MIN_N,
  })).sort((a,b)=>(b.win_rate??-1)-(a.win_rate??-1) || b.calls-a.calls);
}

async function insights(me){
  let rows=[];
  try{
    rows=await sbGetAll("call_outcomes?select=outcome,angle,manufacturer,call_hour,rep_name,rep_email,called_at","called_at");
  }catch(e){
    const s=setupNeeded(e,"supabase/call_workspace.sql"); if(s) return json(503,s);
    throw e;
  }
  if(!seesAllDealers(me)) rows=rows.filter(r=>String(r.rep_email||"").toLowerCase()===String(me.email||"").toLowerCase());

  const total=rows.length, wins=rows.filter(r=>WIN.has(r.outcome)).length;
  const byOutcome={}; for(const r of rows) byOutcome[r.outcome]=(byOutcome[r.outcome]||0)+1;

  return json(200,{ok:true,
    total_calls: total,
    win_rate: total>=MIN_N ? Math.round((wins/total)*100) : null,
    min_sample: MIN_N,
    // Said plainly rather than dressed up as an insight.
    readiness: total>=MIN_N*4
      ? "enough"
      : `Only ${total} call${total===1?"":"s"} recorded so far. Rates appear once a group reaches ${MIN_N} calls; the breakdowns below show counts until then.`,
    by_outcome: Object.entries(byOutcome).map(([k,n])=>({key:k, label:(OUTCOMES[k]||{}).label||k, calls:n}))
                  .sort((a,b)=>b.calls-a.calls),
    by_angle: tally(rows, r=>r.angle),
    by_manufacturer: tally(rows, r=>r.manufacturer),
    by_hour: tally(rows, r=>r.call_hour==null?null:String(r.call_hour).padStart(2,"0")+":00"),
    by_rep: seesAllDealers(me) ? tally(rows, r=>r.rep_name) : [],
  });
}

/* A one-paragraph summary of what has actually worked, folded into new briefs — but only
   from groups big enough to mean something. With thin data this returns null and the brief
   prompt simply omits the section, rather than steering reps on three data points. */
async function learnedSummary(){
  let rows=[];
  try{ rows=await sbGetAll("call_outcomes?select=outcome,angle,manufacturer","outcome"); }catch(e){ return null; }
  if(rows.length < MIN_N*4) return null;
  const angles=tally(rows,r=>r.angle).filter(t=>t.enough).slice(0,3);
  const lines =tally(rows,r=>r.manufacturer).filter(t=>t.enough).slice(0,3);
  if(!angles.length && !lines.length) return null;
  const bits=[];
  if(angles.length) bits.push("Angles that have converted best: "+angles.map(a=>`${a.key} (${a.win_rate}% of ${a.calls} calls)`).join(", "));
  if(lines.length)  bits.push("Lines that have converted best: "+lines.map(a=>`${a.key} (${a.win_rate}% of ${a.calls} calls)`).join(", "));
  return bits.join(". ")+". Treat this as a mild prior, not a rule — the account's own facts still decide the angle.";
}

module.exports._internals={ gatherDossier, signalsKey, briefPrompt, normalizeBrief, worklist,
                            logOutcome, insights, learnedSummary, tally, OUTCOMES, WIN, MIN_N };

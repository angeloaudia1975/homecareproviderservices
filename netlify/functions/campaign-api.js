// HCPS Campaign Studio API (email spec Phase 3).
// You give a brief; the portal RESOLVES the audience from dealer data and GENERATES
// the campaign (subject lines, body, CTAs, a follow-up sequence, a send schedule),
// stores it, and — when Zoho is connected — pushes it to Zoho Campaigns as a DRAFT
// you review and launch. Nothing sends from here; Zoho send is a human step.
//
//   POST {action:"zoho_status"}                         -> {ready, scopes}
//   POST {action:"segments"}                            -> [{key,label,count,needs_mfr}]
//   POST {action:"generate", brief:{...}}               -> {campaign}
//   POST {action:"list"} / {action:"get",id}            -> campaign(s)
//   POST {action:"update", id, patch:{...}}             -> {ok}
//   POST {action:"push_to_zoho", id}                    -> {ok, zoho_campaign_key} | {not_configured}
//   POST {action:"results", id}                         -> {ok, results}
//   All require a staff Bearer token.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const ORDERING=process.env.ORDERING_BASE||"https://hcpsonlineordering.netlify.app";
const CAMPAIGN_FROM=process.env.ZOHO_CAMPAIGN_FROM||process.env.HCPS_MAIL_FROM||"info@homecareproviderservices.us";
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base,col="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${col}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE)break; from+=PAGE; } return out; }
const esc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const P=require("./_platform.js");
const ZC=require("./_zohocampaigns.js");
const A=require("./_audiences.js");                        // saved Target Audiences (Builder)
const { exchangeCode, hasCreds } = require("./_zoho.js");   // reuse the CRM Self-Client token exchange

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(!r.ok) return null; const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase(); if(!email) return null;
    const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,rep_name,name,active`).catch(()=>[]);
    const su=s&&s[0]; if(su&&su.active!==false) return {role:su.role||"rep",rep_name:su.rep_name||"",name:su.name||email,email};
  }catch(e){}
  return null;
}

// ---- audience resolution -----------------------------------------------------
const SEGMENTS=[
  {key:"prospect",   label:"Manufacturer prospects — fit a line, don't buy it yet", needs_mfr:true},
  {key:"active",     label:"Active dealers on a line",                              needs_mfr:true},
  {key:"cross_sell", label:"Cross-sell — buy adjacent lines, not this one",         needs_mfr:true},
  {key:"dormant",    label:"Dormant dealers — lapsed accounts",                     needs_mfr:false},
  {key:"reorder_due",label:"Reorder due — past their usual window",                 needs_mfr:false},
  {key:"all",        label:"All dealers with an email on file",                     needs_mfr:false},
];
async function dealerIdsFor(segment,mfr){
  const enc=encodeURIComponent;
  if(segment==="prospect"&&mfr)   return (await sbGetAll(`dealer_line_status?relationship=eq.prospect&manufacturer=eq.${enc(mfr)}&select=dealer_id`,"dealer_id")).map(r=>r.dealer_id);
  if(segment==="active"&&mfr)     return (await sbGetAll(`dealer_line_status?relationship=eq.active&manufacturer=eq.${enc(mfr)}&select=dealer_id`,"dealer_id")).map(r=>r.dealer_id);
  if(segment==="cross_sell"&&mfr) return (await sbGet(`cross_sell?rec_slug=eq.${enc(mfr)}&select=dealer_id`).catch(()=>[])).map(r=>r.dealer_id);
  if(segment==="dormant")         return (await sbGetAll(`dealer_engagement?status=eq.dormant&select=dealer_id`,"dealer_id")).map(r=>r.dealer_id);
  if(segment==="reorder_due")     return (await sbGetAll(`dealer_engagement?status=eq.overdue&select=dealer_id`,"dealer_id")).map(r=>r.dealer_id);
  if(segment==="all")             return (await sbGetAll("dealers?select=id","id")).map(r=>r.id);
  return [];
}
async function resolveAudience(segment,mfr,filters){
  filters=filters||{};
  let ids=[...new Set(await dealerIdsFor(segment,mfr))];
  if(!ids.length) return {count:0,dealer_ids:[],sample:[]};
  const dealers=await sbGetAll("dealers?select=id,business_name,email,state","id");
  const byId={}; dealers.forEach(d=>byId[d.id]=d);
  // Company-level targeting: narrow by state and/or rep.
  const st=String(filters.state||"").toUpperCase().trim();
  let repById={};
  if(filters.rep){ const eng=await sbGetAll("dealer_engagement?select=dealer_id,rep_name","dealer_id").catch(()=>[]); eng.forEach(e=>repById[e.dealer_id]=e.rep_name||""); }
  ids=ids.filter(id=>{ const d=byId[id]; if(!d)return false; if(st && String(d.state||"").toUpperCase()!==st) return false; if(filters.rep && repById[id]!==filters.rep) return false; return true; });
  if(!ids.length) return {count:0,dealer_ids:[],sample:[]};
  // Full email list on file = dealers.email + every dealer_contacts email, deduped.
  const opt=new Set((await sbGet("email_optout?select=email").catch(()=>[])).map(r=>String(r.email||"").toLowerCase()));
  const contactsByDealer={};
  for(let i=0;i<ids.length;i+=200){ const part=ids.slice(i,i+200); if(!part.length)break;
    const cs=await sbGet(`dealer_contacts?dealer_id=in.(${part.join(",")})&select=dealer_id,name,email`).catch(()=>[]);
    for(const c of (cs||[])) (contactsByDealer[c.dealer_id]=contactsByDealer[c.dealer_id]||[]).push(c);
  }
  const seen=new Set(); const list=[];
  for(const id of ids){ const d=byId[id]; if(!d)continue;
    const cand=[]; if(d.email) cand.push({name:d.business_name||"",email:d.email});
    (contactsByDealer[id]||[]).forEach(c=>{ if(c.email) cand.push({name:c.name||d.business_name||"",email:c.email}); });
    for(const e of cand){ const em=String(e.email||"").trim(); const lo=em.toLowerCase(); if(!EMAIL_RE.test(em)||opt.has(lo)||seen.has(lo))continue; seen.add(lo); list.push({dealer_id:id,name:e.name,email:em}); }
  }
  return {count:list.length,dealer_ids:[...new Set(list.map(x=>x.dealer_id))],sample:list.slice(0,3000)};
}

// ---- content generation (templated; an LLM can replace buildContent later) ----
async function topProducts(mfrSlug){
  if(!mfrSlug) return [];
  // catalog images + any product_images overrides on file
  let overrides={};
  try{ const io=await sbGet(`product_images?manufacturer=eq.${encodeURIComponent(mfrSlug)}&select=code,url`).catch(()=>[]); (io||[]).forEach(i=>{ if(i.code&&i.url) overrides[String(i.code).toUpperCase()]=i.url; }); }catch(e){}
  try{ const r=await fetch(`${ORDERING}/data/${mfrSlug}.json`); if(!r.ok)return[]; const arr=await r.json();
    return (arr||[]).filter(p=>p&&(p.name||p.code)).sort((a,b)=>(Number(b.msrp)||0)-(Number(a.msrp)||0)).slice(0,4)
      .map(p=>{ let img=overrides[String(p.code||"").toUpperCase()]||String(p.image||"").trim(); if(img&&!/^https?:/i.test(img)) img=ORDERING+(img.startsWith("/")?"":"/")+img; return {code:p.code||"",name:p.name||p.code||"",image:img||""}; }); }catch(e){ return []; }
}
function subjectsFor(goal,line,offer){
  const L=line||"our lines"; const O=offer?` — ${offer}`:"";
  const map={
    manufacturer_intro:[`Add ${L} to your shelves`,`${L} is a fit for your dealership${O}`,`A line worth carrying: ${L}`],
    launch:[`New from ${L}${O}`,`Just launched: ${L}`,`Fresh on the shelf — ${L}`],
    promo:[`${offer||"A limited-time offer"} on ${L}`,`Save on ${L}${O}`,`${L}: ${offer||"special pricing"} this month`],
    reactivation:[`We've missed you at HCPS`,`It's been a while — here's what's new`,`Come back to ${L}, ${offer||"we'd love to help"}`],
    acquisition:[`Partner with HomeCare Provider Services`,`Better lines, better pricing — let's talk`,`Grow your dealership with HCPS`],
    cross_sell:[`${L} pairs well with what you stock`,`Round out your mix with ${L}`,`Dealers like you are adding ${L}`],
  };
  return map[goal]||[`An update from HomeCare Provider Services`,`Something worth a look — ${L}`,`${L} at HCPS`];
}
function buildContent(brief,line,products){
  const goal=brief.goal||"manufacturer_intro"; const offer=(brief.offer||"").trim();
  const subjects=subjectsFor(goal,line,offer);
  const preheader = offer? offer : (line?`${line} — available now at your HCPS pricing`:"An update from your HCPS team");
  const prodGrid = (products&&products.length)
    ? `<table role="presentation" width="100%" style="border-collapse:collapse;margin:12px 0"><tr>${products.slice(0,3).map(p=>`<td valign="top" style="width:33%;padding:5px;text-align:center">${p.image?`<img src="${esc(p.image)}" alt="${esc(p.name)}" width="130" style="max-width:130px;height:auto;border-radius:8px;border:1px solid #eef1f4" onerror="this.style.display='none'">`:`<div style="height:90px;background:#f4f7fb;border-radius:8px"></div>`}<div style="font-size:12px;color:#374151;margin-top:5px;line-height:1.3">${esc(p.name)}${p.code?`<br><span style="color:#9aa4ae">${esc(p.code)}</span>`:""}</div></td>`).join("")}</tr></table>`
    : "";
  // Personalization tokens — {{first_name}} and {{company}} are merged per recipient
  // (Zoho merge tags at push; sample-filled for on-screen preview). Each dealer gets
  // a private, unique message addressed to their name and dealership.
  const intros={
    manufacturer_intro:`Dealers with {{company}}'s product mix do well adding ${esc(line||"this line")} — and it's already available on your HCPS account at your pricing.`,
    launch:`There's something new from ${esc(line||"one of our partners")} worth a look on {{company}}'s next order.`,
    promo:`${offer?esc(offer)+" ":""}on ${esc(line||"select lines")} — a good moment for {{company}} to stock up.`,
    reactivation:`It's been a little while since {{company}}'s last order. Here's what's new, and we'd love to help you restock.`,
    acquisition:`HomeCare Provider Services represents leading home-medical-equipment manufacturers with dealer pricing, easy online ordering, and hands-on support — a strong fit for {{company}}.`,
    cross_sell:`{{company}} already does well with your current lines — ${esc(line||"this one")} is a natural add that your customers are asking for.`,
  };
  const cta = {label: goal==="acquisition"?"Become a dealer":(line?`Explore ${line}`:"Browse your portal"), url:`${ORDERING}${brief.manufacturer?`/?line=${encodeURIComponent(brief.manufacturer)}`:""}`};
  const body_html=`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
    <h2 style="color:#2B4071;margin:0 0 6px">${esc(subjects[0])}</h2>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 4px">Hi {{first_name}},</p>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 10px">${intros[goal]||intros.manufacturer_intro}</p>
    ${prodGrid}
    <p style="margin:14px 0 12px"><a href="${cta.url}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;font-size:14px">${esc(cta.label)} &rarr;</a></p>
    <p style="font-size:12.5px;line-height:1.6;color:#6b7280;margin:14px 0 0">Questions, or want pricing on something specific? Just reply — your HCPS rep is glad to help.</p>
    <p style="font-size:12px;color:#9aa4ae;margin:14px 0 0">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.</p></div>`;
  const sequence=sequenceFor(goal,subjects,line,offer);
  return {subjects,preheader,body_html,ctas:[cta],sequence,tokens:["{{first_name}}","{{company}}"],schedule:{recommended:"a weekday mid-morning (Tue–Thu, ~10am ET)",note:"5 touches over ~4 weeks — the rule of thumb to convert a dealer or open a new line. Respects quiet weekends."}};
}
// A 5-touch sequence (the rule of thumb to convert a company / open a new line).
function sequenceFor(goal,subjects,line,offer){
  const L=line||"the line";
  const steps=[
    {step:1,wait_days:0, purpose:"Introduce",        subject:subjects[0]},
    {step:2,wait_days:4, purpose:"Value / benefits", subject:`Why dealers are adding ${L}`},
    {step:3,wait_days:9, purpose:"Products / proof", subject:`A closer look at ${L}`},
    {step:4,wait_days:16,purpose:"Offer / nudge",    subject:offer?`${offer} — ${L}`:`Ready to bring in ${L}?`},
    {step:5,wait_days:25,purpose:"Final check-in",   subject:`Anything I can answer on ${L}?`},
  ];
  return steps.map(s=>({...s,note:s.step>1?"Send to non-openers; stop on reply or order.":""}));
}

// ---- results normalization + per-audience rollup ---------------------------
// Zoho Campaigns' report JSON shape varies; scan it for the numbers we care about
// by key pattern so a rename doesn't silently zero a metric. Returns null when the
// campaign has no results yet.
function pickNum(obj,patterns){
  let found=null;
  const walk=o=>{ if(!o||typeof o!=="object")return;
    for(const k in o){ const v=o[k], kl=String(k).toLowerCase();
      if(typeof v==="number" || (typeof v==="string" && /^\d+(\.\d+)?$/.test(v))){
        for(const p of patterns){ if(p.test(kl)){ if(found===null) found=Number(v); break; } }
      } else if(v&&typeof v==="object") walk(v);
    } };
  walk(obj); return found;
}
function normalizeResults(raw){
  if(!raw||typeof raw!=="object"||Array.isArray(raw)) { if(!raw) return null; }
  const r=raw||{};
  const sent   = pickNum(r,[/emails?_?sent/,/^sent$/,/no_?of_?emails/,/totalsent/,/recipients?/,/delivered/]);
  const opens  = pickNum(r,[/unique_?open/,/uniqueopen/,/total_?open/,/^opens?$/,/opened/]);
  const clicks = pickNum(r,[/unique_?click/,/uniqueclick/,/total_?click/,/^clicks?$/,/clicked/]);
  const replies= pickNum(r,[/repl/]);
  const bounces= pickNum(r,[/bounce/,/hardbounce/,/softbounce/]);
  const unsub  = pickNum(r,[/unsub/,/optout/]);
  const any=[sent,opens,clicks,replies,bounces,unsub].some(x=>x!=null);
  if(!any) return null;
  return {sent:sent||0,opens:opens||0,clicks:clicks||0,replies:replies||0,bounces:bounces||0,unsub:unsub||0};
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{b={};}
    const act=b.action||"list";

    if(act==="zoho_status"){ return json(200,{ok:true,creds_set:hasCreds(),ready:await ZC.ready(),scopes:ZC.SCOPES,from:CAMPAIGN_FROM}); }

    // Exchange a Zoho Campaigns Self-Client code for a refresh token, stored under
    // app_settings 'zoho_campaigns_auth' (separate from the CRM's 'zoho_auth').
    if(act==="connect_zoho"){
      if(me.role!=="president") return json(403,{error:"President only"});
      const code=String(b.code||"").trim(); if(!code) return json(400,{error:"code required"});
      const ex=await exchangeCode(code);
      if(!ex.ok) return json(200,{ok:false,message:"Zoho rejected the code — it may have expired (they last only a few minutes) or the scopes were off. Generate a fresh code with the three Campaigns scopes and try again.",detail:ex.error});
      await sbSend("POST","app_settings?on_conflict=key",{key:"zoho_campaigns_auth",value:{refresh_token:ex.refresh_token,api_domain:ex.api_domain,connected_at:new Date().toISOString()},updated_at:new Date().toISOString()},{Prefer:"resolution=merge-duplicates,return=minimal"});
      return json(200,{ok:true,connected:true});
    }

    if(act==="segments"){
      const out=[]; for(const s of SEGMENTS){ let count=null; if(!s.needs_mfr){ try{ count=(await dealerIdsFor(s.key,null)).length; }catch(e){} } out.push({...s,count}); }
      const [mfrs,eng,dst]=await Promise.all([
        sbGet("manufacturers?select=slug,name&order=name").catch(()=>[]),
        sbGet("dealer_engagement?select=rep_name&limit=2000").catch(()=>[]),
        sbGet("dealers?select=state&limit=2000").catch(()=>[]),
      ]);
      const reps=[...new Set((eng||[]).map(e=>e.rep_name).filter(Boolean))].sort();
      const states=[...new Set((dst||[]).map(d=>String(d.state||"").toUpperCase().trim()).filter(Boolean))].sort();
      return json(200,{ok:true,segments:out,manufacturers:(mfrs||[]).map(m=>({slug:m.slug,name:m.name||m.slug})),reps,states});
    }

    // Saved Target Audiences (from the Builder) — list them for the campaign selector.
    if(act==="audiences"){
      const rows=await sbGet("audiences?select=id,name,type,company_count,contact_count,notes,updated_at&order=updated_at.desc&limit=200").catch(()=>[]);
      return json(200,{ok:true,audiences:rows||[]});
    }
    // Resolve one saved audience to its send breakdown (companies/contacts/valid/…) for preview.
    if(act==="preview_audience"){
      if(!b.audience_id) return json(400,{error:"audience_id required"});
      const r=await A.resolveById(b.audience_id).catch(()=>null);
      if(!r) return json(404,{error:"audience not found"});
      return json(200,{ok:true,audience:{id:r.audience.id,name:r.audience.name,type:r.audience.type},breakdown:r.breakdown,sample:r.send.slice(0,3)});
    }

    if(act==="generate"){
      const brief=(b.brief&&typeof b.brief==="object")?b.brief:{};
      const audienceId=String(brief.audience_id||"").trim()||null;
      const mfrs=await sbGet("manufacturers?select=slug,name").catch(()=>[]);
      const mfrSlug=String(brief.manufacturer||"").trim()||null;
      const line=mfrSlug?((mfrs.find(m=>m.slug===mfrSlug)||{}).name||mfrSlug):"";
      const products=await topProducts(mfrSlug);
      const generated=buildContent(brief,line,products);
      const st=await P.getState();

      let segment, audienceBlock, name;
      if(audienceId){
        // A saved Target Audience is the source of truth: resolve to its clean send list.
        const r=await A.resolveById(audienceId).catch(()=>null);
        if(!r) return json(400,{error:"saved audience not found"});
        segment="saved";
        const send=(r.send||[]).map(s=>({dealer_id:s.dealer_id,name:s.name,email:s.email,company:s.company}));
        audienceBlock={ source:"audience", audience_id:audienceId, audience_name:r.audience.name||"",
          count:r.breakdown.send, breakdown:r.breakdown,
          dealer_ids:[...new Set(send.map(s=>s.dealer_id))], sample:send.slice(0,3000) };
        name=String(brief.name||`${r.audience.name||"Audience"} — ${line||"HCPS"}`).slice(0,120);
      } else {
        segment=String(brief.segment||"").trim();
        if(!SEGMENTS.find(s=>s.key===segment)) return json(400,{error:"pick a valid segment or a saved audience"});
        const audience=await resolveAudience(segment,mfrSlug,{state:brief.state||"",rep:brief.rep||""});
        audienceBlock={ source:"segment", count:audience.count, dealer_ids:audience.dealer_ids, sample:audience.sample };
        name=String(brief.name||`${line||"HCPS"} — ${segment}`).slice(0,120);
      }
      const row={
        name, goal:brief.goal||"manufacturer_intro", manufacturer:mfrSlug, segment,
        brief, generated, audience:audienceBlock,
        status:"draft", env:P.envFor(st.mode,false), created_by:me.name||me.email,
        updated_at:new Date().toISOString(),
      };
      const ins=await sbSend("POST","marketing_campaigns",row,{Prefer:"return=representation"});
      return json(200,{ok:true,campaign:ins&&ins[0]});
    }

    if(act==="list"){
      const rows=await sbGet("marketing_campaigns?select=id,name,goal,manufacturer,segment,status,env,updated_at,audience,zoho_campaign_key&order=updated_at.desc&limit=100").catch(()=>[]);
      const campaigns=(rows||[]).map(r=>({id:r.id,name:r.name,goal:r.goal,manufacturer:r.manufacturer,segment:r.segment,status:r.status,env:r.env,updated_at:r.updated_at,audience_count:(r.audience&&r.audience.count)||0,pushed:!!r.zoho_campaign_key}));
      return json(200,{ok:true,campaigns});
    }
    if(act==="get"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}&select=*`).catch(()=>[]);
      const c=rows&&rows[0]; if(!c) return json(404,{error:"not found"});
      return json(200,{ok:true,campaign:c});
    }
    if(act==="update"){
      if(!b.id) return json(400,{error:"id required"});
      const patch=(b.patch&&typeof b.patch==="object")?b.patch:{};
      const allow={}; ["name","status","generated","brief"].forEach(k=>{ if(patch[k]!==undefined) allow[k]=patch[k]; });
      allow.updated_at=new Date().toISOString();
      await sbSend("PATCH",`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}`,allow,{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }

    // Pre-send contact review: exclude specific recipients from a campaign before it
    // pushes to Zoho. Excluded emails are kept on the campaign's audience JSON (no new
    // column) and filtered out of the send list at push time.
    if(act==="exclude"){
      if(!b.id) return json(400,{error:"id required"});
      const emails=(Array.isArray(b.emails)?b.emails:[]).map(e=>String(e||"").trim().toLowerCase()).filter(Boolean);
      const rows=await sbGet(`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}&select=audience`).catch(()=>[]);
      const c=rows&&rows[0]; if(!c) return json(404,{error:"not found"});
      const aud=c.audience||{}; aud.exclusions=[...new Set(emails)];
      await sbSend("PATCH",`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}`,{audience:aud,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
      const total=((aud.sample||[]).length)||(aud.count||0);
      return json(200,{ok:true,excluded:aud.exclusions.length,will_send:Math.max(0,total-aud.exclusions.length)});
    }

    if(act==="push_to_zoho"){
      if(!b.id) return json(400,{error:"id required"});
      if(!(await ZC.ready())) return json(200,{ok:false,not_configured:true,scopes:ZC.SCOPES,message:"Zoho Campaigns isn't connected yet — finish the OAuth step to enable pushing drafts."});
      const rows=await sbGet(`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}&select=*`).catch(()=>[]);
      const c=rows&&rows[0]; if(!c) return json(404,{error:"not found"});
      // Apply the pre-send review: drop any excluded recipients from the send list.
      const excl=new Set(((c.audience&&c.audience.exclusions)||[]).map(e=>String(e||"").toLowerCase()));
      if(excl.size && c.audience && Array.isArray(c.audience.sample)){
        c.audience.sample=c.audience.sample.filter(s=>!excl.has(String(s.email||"").toLowerCase()));
        c.audience.count=c.audience.sample.length;
      }
      if(c.audience && !(c.audience.sample&&c.audience.sample.length)) return json(200,{ok:false,message:"No recipients left to send — every contact was excluded."});
      const res=await ZC.pushCampaign(c,CAMPAIGN_FROM);
      if(!res.ok) return json(200,{ok:false,message:res.error||"Zoho push failed",step:res.step||null});
      await sbSend("PATCH",`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}`,{status:"pushed",zoho_list_key:res.zoho_list_key||null,zoho_campaign_key:res.zoho_campaign_key||null,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
      return json(200,{ok:true,zoho_campaign_key:res.zoho_campaign_key});
    }
    // Per-audience performance: roll up every campaign built from each saved audience.
    // Pass {refresh:true} to pull fresh numbers from Zoho for pushed campaigns first.
    if(act==="audience_stats"){
      const auds=await sbGet("audiences?select=id,name,type,company_count,contact_count&order=name").catch(()=>[]);
      const camps=await sbGet("marketing_campaigns?select=id,name,status,audience,results,zoho_campaign_key,updated_at&order=updated_at.desc&limit=500").catch(()=>[]);
      // Only campaigns that were built from a saved audience roll up here.
      const used=camps.filter(c=>c.audience&&c.audience.audience_id);
      if(b.refresh){
        for(const c of used){ if(c.zoho_campaign_key){ try{ const r=await ZC.getResults(c.zoho_campaign_key);
          if(r&&r.ok){ c.results=r.results||{}; await sbSend("PATCH",`marketing_campaigns?id=eq.${encodeURIComponent(c.id)}`,{results:c.results,updated_at:new Date().toISOString()},{Prefer:"return=minimal"}); } }catch(e){} } }
      }
      const byAud={};
      for(const c of used){ const aid=c.audience.audience_id; (byAud[aid]=byAud[aid]||[]).push(c); }
      const stats=auds.map(a=>{
        const cs=byAud[a.id]||[];
        let sent=0,opens=0,clicks=0,replies=0,bounces=0,unsub=0,haveMetrics=false,pushed=0,last=null;
        const campaigns=cs.map(c=>{
          const nr=normalizeResults(c.results);
          if(c.zoho_campaign_key) pushed++;
          if(!last || String(c.updated_at||"")>last) last=c.updated_at||null;
          if(nr){ haveMetrics=true; sent+=nr.sent; opens+=nr.opens; clicks+=nr.clicks; replies+=nr.replies; bounces+=nr.bounces; unsub+=nr.unsub; }
          const intended=(c.audience&&((c.audience.breakdown&&c.audience.breakdown.send)||c.audience.count))||0;
          return {id:c.id,name:c.name,status:c.status,pushed:!!c.zoho_campaign_key,updated_at:c.updated_at,intended,metrics:nr};
        });
        return {id:a.id,name:a.name,type:a.type,contact_count:a.contact_count||0,
          campaign_count:cs.length,pushed,haveMetrics,
          totals:{sent,opens,clicks,replies,bounces,unsub},
          open_rate:sent?opens/sent:null, click_rate:sent?clicks/sent:null, reply_rate:sent?replies/sent:null,
          last, campaigns};
      }).filter(s=>s.campaign_count>0).sort((x,y)=>(y.totals.sent-x.totals.sent)||(y.campaign_count-x.campaign_count));
      return json(200,{ok:true,stats});
    }

    if(act==="results"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}&select=zoho_campaign_key`).catch(()=>[]);
      const key=rows&&rows[0]&&rows[0].zoho_campaign_key; if(!key) return json(200,{ok:false,message:"Not pushed to Zoho yet."});
      const r=await ZC.getResults(key);
      if(r&&r.ok){ try{ await sbSend("PATCH",`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}`,{results:r.results||{},updated_at:new Date().toISOString()},{Prefer:"return=minimal"}); }catch(e){} }
      return json(200,{ok:!!(r&&r.ok),results:(r&&r.results)||null});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

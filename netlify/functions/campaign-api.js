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
async function resolveAudience(segment,mfr){
  const ids=[...new Set(await dealerIdsFor(segment,mfr))];
  if(!ids.length) return {count:0,dealer_ids:[],sample:[]};
  const opt=new Set((await sbGet("email_optout?select=email").catch(()=>[])).map(r=>String(r.email||"").toLowerCase()));
  const dealers=await sbGetAll("dealers?select=id,business_name,email","id");
  const byId={}; dealers.forEach(d=>byId[d.id]=d);
  const withEmail=[];
  for(const id of ids){ const d=byId[id]; if(!d)continue; const em=String(d.email||"").trim(); if(EMAIL_RE.test(em)&&!opt.has(em.toLowerCase())) withEmail.push({dealer_id:id,name:d.business_name||"",email:em}); }
  return {count:withEmail.length,dealer_ids:withEmail.map(x=>x.dealer_id),sample:withEmail.slice(0,2000)};
}

// ---- content generation (templated; an LLM can replace buildContent later) ----
async function topProducts(mfrSlug){
  if(!mfrSlug) return [];
  try{ const r=await fetch(`${ORDERING}/data/${mfrSlug}.json`); if(!r.ok)return[]; const arr=await r.json();
    return (arr||[]).filter(p=>p&&(p.name||p.code)).sort((a,b)=>(Number(b.msrp)||0)-(Number(a.msrp)||0)).slice(0,4)
      .map(p=>({code:p.code||"",name:p.name||p.code||""})); }catch(e){ return []; }
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
  const prodList = (products&&products.length)
    ? `<ul style="margin:8px 0 0;padding-left:18px;font-size:13.5px;color:#374151">${products.map(p=>`<li>${esc(p.name)}${p.code?` <span style="color:#9aa4ae">(${esc(p.code)})</span>`:""}</li>`).join("")}</ul>`
    : "";
  const intros={
    manufacturer_intro:`Dealers with your product mix do well adding ${esc(line||"this line")} — and it's already available on your HCPS account at your pricing.`,
    launch:`There's something new from ${esc(line||"one of our partners")} worth a look on your next order.`,
    promo:`${offer?esc(offer)+" ":""}on ${esc(line||"select lines")} — a good moment to stock up.`,
    reactivation:`It's been a little while since your last order. Here's what's new, and we'd love to help you restock.`,
    acquisition:`HomeCare Provider Services represents leading home-medical-equipment manufacturers with dealer pricing, easy online ordering, and hands-on support.`,
    cross_sell:`You already do well with your current lines — ${esc(line||"this one")} is a natural add that your customers are asking for.`,
  };
  const cta = {label: goal==="acquisition"?"Become a dealer":(line?`Explore ${line}`:"Browse your portal"), url:`${ORDERING}${brief.manufacturer?`/?line=${encodeURIComponent(brief.manufacturer)}`:""}`};
  const body_html=`<div style="font-family:Arial,sans-serif;color:#1b2733;max-width:560px">
    <h2 style="color:#2B4071;margin:0 0 6px">${esc(subjects[0])}</h2>
    <p style="font-size:13.5px;line-height:1.6;color:#374151;margin:0 0 10px">${intros[goal]||intros.manufacturer_intro}</p>
    ${prodList}
    <p style="margin:14px 0 12px"><a href="${cta.url}" style="display:inline-block;background:#F5821F;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;font-size:14px">${esc(cta.label)} &rarr;</a></p>
    <p style="font-size:12.5px;line-height:1.6;color:#6b7280;margin:14px 0 0">Questions, or want pricing on something specific? Just reply — your HCPS rep is glad to help.</p>
    <p style="font-size:12px;color:#9aa4ae;margin:14px 0 0">HomeCare Provider Services · Your partner in mobility &amp; home medical equipment.</p></div>`;
  const sequence=[
    {step:1, wait_days:0, subject:subjects[0]},
    {step:2, wait_days:5, subject:`Following up: ${subjects[1]||subjects[0]}`, note:"Send only to non-openers; stop on reply or click."},
  ];
  return {subjects,preheader,body_html,ctas:[cta],sequence,schedule:{recommended:"a weekday mid-morning (Tue–Thu, ~10am ET)",note:"Respects quiet weekends; avoid overlapping with a triggered send window."}};
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
      const mfrs=await sbGet("manufacturers?select=slug,name&order=name").catch(()=>[]);
      return json(200,{ok:true,segments:out,manufacturers:(mfrs||[]).map(m=>({slug:m.slug,name:m.name||m.slug}))});
    }

    if(act==="generate"){
      const brief=(b.brief&&typeof b.brief==="object")?b.brief:{};
      const segment=String(brief.segment||"").trim();
      if(!SEGMENTS.find(s=>s.key===segment)) return json(400,{error:"pick a valid segment"});
      const mfrSlug=String(brief.manufacturer||"").trim()||null;
      const mfrs=await sbGet("manufacturers?select=slug,name").catch(()=>[]);
      const line=mfrSlug?((mfrs.find(m=>m.slug===mfrSlug)||{}).name||mfrSlug):"";
      const audience=await resolveAudience(segment,mfrSlug);
      const products=await topProducts(mfrSlug);
      const generated=buildContent(brief,line,products);
      const st=await P.getState();
      const row={
        name:String(brief.name||`${line||"HCPS"} — ${segment}`).slice(0,120),
        goal:brief.goal||"manufacturer_intro", manufacturer:mfrSlug, segment,
        brief, generated, audience:{count:audience.count,sample:audience.sample.slice(0,200),dealer_ids:audience.dealer_ids},
        status:"draft", env:P.envFor(st.mode,false), created_by:me.name||me.email,
        updated_at:new Date().toISOString(),
      };
      // keep the full send-list separately in audience.sample for the Zoho push (cap 2000)
      row.audience.sample=audience.sample;
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

    if(act==="push_to_zoho"){
      if(!b.id) return json(400,{error:"id required"});
      if(!(await ZC.ready())) return json(200,{ok:false,not_configured:true,scopes:ZC.SCOPES,message:"Zoho Campaigns isn't connected yet — finish the OAuth step to enable pushing drafts."});
      const rows=await sbGet(`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}&select=*`).catch(()=>[]);
      const c=rows&&rows[0]; if(!c) return json(404,{error:"not found"});
      const res=await ZC.pushCampaign(c,CAMPAIGN_FROM);
      if(!res.ok) return json(200,{ok:false,message:res.error||"Zoho push failed",step:res.step||null});
      await sbSend("PATCH",`marketing_campaigns?id=eq.${encodeURIComponent(b.id)}`,{status:"pushed",zoho_list_key:res.zoho_list_key||null,zoho_campaign_key:res.zoho_campaign_key||null,updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
      return json(200,{ok:true,zoho_campaign_key:res.zoho_campaign_key});
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

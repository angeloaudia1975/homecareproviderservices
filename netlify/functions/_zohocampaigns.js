// HCPS ↔ Zoho Campaigns client (Campaign Studio Phase 3).
// Reuses the same OAuth mechanism as the Zoho CRM sync (accounts domain + client
// id/secret), but with a SEPARATE refresh token that carries the Campaigns scopes,
// so it never disturbs the CRM connection.
//
// ── OAuth scopes to authorize (this is the exact list for the API Console step) ──
//     ZohoCampaigns.campaign.ALL     (create lists, contacts & campaign drafts; read campaign details)
//     ZohoCampaigns.contact.ALL
//
// ── Where the refresh token lives (checked in this order) ──
//     1) env  ZOHO_CAMPAIGNS_REFRESH_TOKEN
//     2) Supabase app_settings key 'zoho_campaigns_auth' -> { refresh_token }
//
// Env: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET (shared with CRM),
//      ZOHO_ACCOUNTS_DOMAIN  (default accounts.zoho.com; .eu/.in/.com.au for other DCs),
//      ZOHO_CAMPAIGNS_DOMAIN (default campaigns.zoho.com; the API host for your DC).
//
// NOTE: the Campaigns REST paths below follow Zoho Campaigns API v1.1. They are wired
// to the documented shapes; confirm against current docs during live integration.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const ACCOUNTS=process.env.ZOHO_ACCOUNTS_DOMAIN||"accounts.zoho.com";
const CID=process.env.ZOHO_CLIENT_ID, CSECRET=process.env.ZOHO_CLIENT_SECRET;
const CAMP_HOST=process.env.ZOHO_CAMPAIGNS_DOMAIN||"campaigns.zoho.com";
const BASE=`https://${CAMP_HOST}/api/v1.1`;
const SCOPES=["ZohoCampaigns.campaign.ALL","ZohoCampaigns.contact.ALL"];   // reports read via campaign scope

// ── Personalization ──────────────────────────────────────────────────────────
// The portal writes body copy with neutral tokens ({{first_name}}, {{company}});
// at push we swap them for Zoho Campaigns merge tags so every recipient sees their
// own name and dealership. Adjust the right-hand side if a list uses different
// field labels — Zoho derives the tag from the list column name (spaces→no spaces,
// upper-cased): "First Name" -> $[FIRSTNAME]$, a "Company" column -> $[COMPANY]$.
const MERGE={ "{{first_name}}":"$[FIRSTNAME]$", "{{company}}":"$[COMPANY]$" };
function toMergeTags(html){ let s=String(html||""); for(const k in MERGE) s=s.split(k).join(MERGE[k]); return s; }
function firstName(name){ const w=String(name||"").trim().split(/\s+/)[0]||""; return /@/.test(w)?"":w; }

async function sbGet(path){ try{ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`}}); return r.ok?r.json():[]; }catch(e){ return []; } }
async function refreshToken(){
  if(process.env.ZOHO_CAMPAIGNS_REFRESH_TOKEN) return process.env.ZOHO_CAMPAIGNS_REFRESH_TOKEN;
  const rows=await sbGet("app_settings?key=eq.zoho_campaigns_auth&select=value");
  const v=rows&&rows[0]&&rows[0].value; return (v&&v.refresh_token)||null;
}
async function ready(){ return !!(CID&&CSECRET&&await refreshToken()); }

// refresh_token -> short-lived access token
async function accessToken(){
  const rt=await refreshToken();
  if(!CID||!CSECRET||!rt) return {ok:false,not_configured:true,error:"Zoho Campaigns not connected yet."};
  const body=new URLSearchParams({grant_type:"refresh_token",client_id:CID,client_secret:CSECRET,refresh_token:rt}).toString();
  try{
    const r=await fetch(`https://${ACCOUNTS}/oauth/v2/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.access_token) return {ok:false,error:(j&&(j.error||JSON.stringify(j).slice(0,160)))||"token refresh failed"};
    return {ok:true,access_token:j.access_token};
  }catch(e){ return {ok:false,error:String(e&&e.message||e)}; }
}
function authHeaders(token){ return {Authorization:`Zoho-oauthtoken ${token}`}; }
async function zpost(path,token,params){
  const body=new URLSearchParams(params).toString();
  const r=await fetch(`${BASE}${path}`,{method:"POST",headers:{...authHeaders(token),"content-type":"application/x-www-form-urlencoded"},body});
  const t=await r.text(); let j=null; try{ j=t?JSON.parse(t):null; }catch(e){ j={raw:t}; }
  return {ok:r.ok,status:r.status,json:j};
}
async function zget(path,token){
  const r=await fetch(`${BASE}${path}`,{headers:authHeaders(token)});
  const t=await r.text(); let j=null; try{ j=t?JSON.parse(t):null; }catch(e){ j={raw:t}; }
  return {ok:r.ok,status:r.status,json:j};
}

// Create a mailing list and seed it with the resolved audience.
async function createListWithContacts(token,listName,contacts){
  // contacts: [{email, name, company}] → Zoho "Contact Info" JSON keyed by column.
  // First Name + Company are what the merge tags ($[FIRSTNAME]$ / $[COMPANY]$) fill
  // per recipient. We pre-fill friendly fallbacks so no email reads "Hi ,".
  const info=JSON.stringify((contacts||[]).slice(0,5000).map(c=>({
    "Contact Email":c.email,
    "First Name":firstName(c.name)||"there",
    "Company":c.company||"your dealership"
  })));
  const res=await zpost("/addlistandcontacts",token,{
    resfmt:"JSON", listname:listName, signupform:"public", mode:"newlist", emailyn:"false", contactinfo:info
  });
  const key=res.json&&(res.json.listkey||res.json.list_key||(res.json.data&&res.json.data.listkey));
  return {ok:res.ok&&!!key, listkey:key||null, raw:res.json, status:res.status};
}
// Create the campaign as a DRAFT (not sent — the user launches it in Zoho after review).
async function createCampaign(token,{name,subject,fromEmail,html,listKey}){
  const res=await zpost("/createcampaign",token,{
    resfmt:"JSON", campaignname:name, from_email:fromEmail||"", subject:subject||name,
    list_details:JSON.stringify(listKey?{[listKey]:[]}:{}), content:html||""
  });
  const key=res.json&&(res.json.campaignkey||res.json.campaign_key||(res.json.data&&res.json.data.campaignkey));
  return {ok:res.ok&&!!key, campaignkey:key||null, raw:res.json, status:res.status};
}
async function getReport(token,campaignKey){
  const res=await zget(`/getcampaigndetails?resfmt=JSON&campaignkey=${encodeURIComponent(campaignKey)}`,token);
  return {ok:res.ok, data:res.json, status:res.status};
}

// High-level: push a stored campaign to Zoho as a reviewable draft.
async function pushCampaign(campaign,fromEmail){
  const at=await accessToken(); if(!at.ok) return at;
  const token=at.access_token;
  const contacts=((campaign.audience&&campaign.audience.sample)||[]).map(s=>({email:s.email,name:s.name,company:s.company}));
  let listKey=campaign.zoho_list_key||null;
  if(!listKey && contacts.length){
    const lr=await createListWithContacts(token,`HCPS · ${campaign.name||"Campaign"}`.slice(0,60),contacts);
    if(lr.ok) listKey=lr.listkey; else return {ok:false,step:"list",error:(lr.raw&&lr.raw.message)||"list create failed",raw:lr.raw};
  }
  const g=campaign.generated||{};
  const subject=toMergeTags((g.subjects&&g.subjects[0])||campaign.name||"HCPS");
  const cr=await createCampaign(token,{name:campaign.name||"HCPS Campaign",subject,fromEmail,html:toMergeTags(g.body_html||""),listKey});
  if(!cr.ok) return {ok:false,step:"campaign",error:(cr.raw&&cr.raw.message)||"campaign create failed",raw:cr.raw,zoho_list_key:listKey};
  return {ok:true,zoho_list_key:listKey,zoho_campaign_key:cr.campaignkey};
}
async function getResults(campaignKey){
  const at=await accessToken(); if(!at.ok) return at;
  const r=await getReport(at.access_token,campaignKey);
  return {ok:r.ok, results:r.data};
}

module.exports={ SCOPES, ready, accessToken, pushCampaign, getResults, createListWithContacts, createCampaign };

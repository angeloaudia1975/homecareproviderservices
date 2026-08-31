// HCPS Dealer 360 — Outlook Email ingestion (Phase 0).
// App-only Microsoft Graph client-credentials flow. Reads Inbox (inbound) + Sent Items
// (outbound) for the mailboxes in GRAPH_MAILBOXES, keeps business-relevant messages,
// matches each to a dealer (learned domains + dnorm name/alias), and upserts into
// email_messages / email_participants (+ contact_candidates). Staff (president) only.
//
//   POST {action:"status"}            -> which env vars are set, mailbox list (no secrets)
//   POST {action:"test", mailbox?}    -> auth + list 5 recent inbox/sent (proves connection)
//   POST {action:"sync",  days?}      -> pull + filter + match + upsert; returns counts
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, GRAPH_TENANT_ID, GRAPH_CLIENT_ID,
//      GRAPH_CLIENT_SECRET, GRAPH_MAILBOXES (comma/space separated UPNs).

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SERVICE_ROLE   = process.env.SUPABASE_SERVICE_ROLE;
const G_TENANT = process.env.GRAPH_TENANT_ID;
const G_CLIENT = process.env.GRAPH_CLIENT_ID;
const G_SECRET = process.env.GRAPH_CLIENT_SECRET;
const MAILBOXES = String(process.env.GRAPH_MAILBOXES || "").split(/[,\s]+/).map(s=>s.trim().toLowerCase()).filter(Boolean);
const INTERNAL_DOMAINS = [...new Set(MAILBOXES.map(m=>m.split("@")[1]).filter(Boolean))];
const CONSUMER = new Set(["gmail.com","yahoo.com","outlook.com","hotmail.com","icloud.com","aol.com","comcast.net","me.com","live.com","msn.com"]);

const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||400):null; };
const domainOf=a=>{ const m=String(a||"").toLowerCase().match(/@([^>\s]+)$/); return m?m[1]:""; };
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
// Render the rep's plain-text draft (body + signature) into safe HTML for the outbound email.
function emailHtml(text){
  const e=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const safe=e(text).replace(/\r\n/g,"\n").replace(/\n/g,"<br>");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.55">${safe}</div>`;
}

// ---- Microsoft Graph (app-only) ----
let _tok=null, _tokExp=0;
async function graphToken(force){
  /* force skips the cache. The health check uses it so that an admin who has just granted
     Mail.Read in Azure sees the new permission immediately — a token minted before the
     grant carries the old roles for up to an hour, and "I fixed it but it still says no"
     is exactly the wrong answer to give someone. */
  if(!force && _tok && Date.now()<_tokExp-60000) return _tok;
  const body=new URLSearchParams({client_id:G_CLIENT,client_secret:G_SECRET,scope:"https://graph.microsoft.com/.default",grant_type:"client_credentials"});
  const r=await fetch(`https://login.microsoftonline.com/${G_TENANT}/oauth2/v2.0/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`Graph auth ${r.status}: ${j.error||""} ${j.error_description||await r.text().catch(()=>"")}`.slice(0,300));
  _tok=j.access_token; _tokExp=Date.now()+(j.expires_in||3599)*1000; return _tok;
}
async function graphGet(path, extraHeaders){
  const tok=await graphToken();
  const r=await fetch(`https://graph.microsoft.com/v1.0${path}`,{headers:Object.assign({Authorization:`Bearer ${tok}`},extraHeaders||{})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`Graph ${r.status} on ${path}: ${(j.error&&j.error.message)||""}`.slice(0,300));
  return j;
}

/* ── Which application permissions Azure actually granted ────────────────────
   A client-credentials access token carries the granted app roles in its `roles`
   claim. Reading them is how "why is every email body blank?" gets a definite answer
   instead of a guess: Mail.ReadBasic returns a message's headers and recipients but
   DELIBERATELY strips body, bodyPreview and attachments, which looks exactly like an
   empty inbox body. Mail.Read is the permission that includes them.

   The claim is read, not trusted for any decision — nothing is authorised from it. */
function tokenRoles(tok){
  try{
    const part=String(tok||"").split(".")[1]; if(!part) return [];
    const b64=part.replace(/-/g,"+").replace(/_/g,"/");
    const pad=b64+"=".repeat((4-(b64.length%4))%4);
    const payload=JSON.parse(Buffer.from(pad,"base64").toString("utf8"));
    return Array.isArray(payload.roles)?payload.roles:[];
  }catch(e){ return []; }
}
const CAN_READ_BODY = roles => roles.some(r=>/^Mail\.(Read|ReadWrite)$/.test(r));
const SEL="id,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,conversationId,hasAttachments";
async function listFolder(mailbox, folder, days, top){
  const since=new Date(Date.now()-(days||30)*864e5).toISOString();
  const cmp = folder==="sentitems" ? "sentDateTime" : "receivedDateTime";
  const path=`/users/${encodeURIComponent(mailbox)}/mailFolders/${folder}/messages`
    +`?$select=${SEL}&$top=${top||50}&$orderby=${cmp} desc&$filter=${cmp} ge ${since}`;
  const j=await graphGet(path); return j.value||[];
}

// ---- staff auth (president) ----
async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
      if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
        if(su&&su.active!==false) return {role:su.role||"rep",email}; } } }catch(e){}
  return null;
}

// ---- dealer resolver: learned domains + dnorm name/alias ----
async function buildResolver(){
  const [dealers,aliases,domains,contacts]=await Promise.all([
    sbGetAll("dealers?select=id,business_name,parent_id,email","id").catch(()=>[]),
    sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
    sbGetAll("dealer_domains?select=domain,dealer_id","domain").catch(()=>[]),
    sbGetAll("dealer_contacts?select=dealer_id,email","dealer_id").catch(()=>[]),
  ]);
  const norm2id=new Map(); for(const d of dealers) norm2id.set(dnorm(d.business_name), d.id);
  for(const a of aliases){ if(a&&a.alias_norm&&!norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm, a.dealer_id); }
  const dom2id=new Map(); for(const x of domains){ if(x&&x.domain) dom2id.set(String(x.domain).toLowerCase(), x.dealer_id); }
  // exact contact-email → dealer (handles ISP/personal addresses like name@bbtel.com precisely)
  const email2id=new Map();
  for(const d of dealers){ if(d.email) email2id.set(String(d.email).toLowerCase(), d.id); }
  for(const c of contacts){ if(c.email&&c.dealer_id&&!email2id.has(String(c.email).toLowerCase())) email2id.set(String(c.email).toLowerCase(), c.dealer_id); }
  return {
    byEmail:a=>email2id.get(String(a||"").toLowerCase())||null,
    byDomain:d=>dom2id.get(String(d||"").toLowerCase())||null,
    byName:n=>norm2id.get(dnorm(n))||null,
    knownDomain:d=>dom2id.has(String(d||"").toLowerCase()),
  };
}

const BIZ=/(order|invoice|\bpo\b|purchase|quote|pricing|backorder|\brma\b|return|ship|tracking|catalog|reorder|net ?30|account|wholesale|dealer|bng\d|strongback|airavant|bongo|pedifix|golden)/i;
function isInternal(addr){ const d=domainOf(addr); return INTERNAL_DOMAINS.includes(d); }

// ---- Unmatched-sender noise controls: always-on automatic patterns + admin rules ----
// Automatic: any sender whose local-part contains one of these is hidden without a stored rule,
// so obvious machine senders never clutter the queue. Kept deliberately conservative (only clearly
// automated prefixes) so a real person like info@ or sales@ is never auto-hidden.
const AUTO_LOCAL=["noreply","no-reply","no_reply","no.reply","donotreply","do-not-reply","notification","notifications","mailer-daemon","mailer_daemon","postmaster","bounce","autoreply","auto-reply","automated"];
const autoHidden=email=>{ email=String(email||"").toLowerCase(); const at=email.indexOf("@"); const local=at>=0?email.slice(0,at):email; return AUTO_LOCAL.some(p=>local.includes(p)); };
async function loadSenderRules(){ try{ return await sbGetAll("email_sender_rules?select=id,kind,value,action,reason,created_by,created_at","id"); }catch(e){ return []; } }
// Returns a matcher: "rule" (admin-hidden), "auto" (pattern-hidden), or null (show it).
function buildHider(rules){
  const emails=new Set(), domains=new Set(), patterns=[];
  for(const r of (rules||[])){ const v=String(r.value||"").toLowerCase(); if(!v) continue;
    if(r.kind==="email") emails.add(v); else if(r.kind==="domain") domains.add(v); else if(r.kind==="pattern") patterns.push(v); }
  return email=>{ email=String(email||"").toLowerCase(); const at=email.indexOf("@"); const local=at>=0?email.slice(0,at):email; const dom=at>=0?email.slice(at+1):"";
    if(emails.has(email)) return "rule";
    if(dom&&domains.has(dom)) return "rule";
    if(patterns.some(p=>p&&(local.includes(p)||dom.includes(p)))) return "rule";
    if(autoHidden(email)) return "auto";
    return null; };
}

// Core sync — gather from Graph, match, bulk-write. Called by the API handler AND the cron.
async function runSync(opts){
  opts=opts||{};
  try{ await sbGet("email_messages?select=id&limit=1"); }
  catch(e){ return {ok:false,error:"tables_missing",message:"Run supabase/email_intelligence.sql first."}; }
  const R=await buildResolver();
  const days=Math.min(Math.max(parseInt(opts.days||30,10)||30,1),120);
  const PER_FOLDER=Math.min(Math.max(parseInt(opts.per_folder||120,10)||120,10),400);
  const CAP=Math.min(Math.max(parseInt(opts.cap||500,10)||500,50),1200);

  const gathered=[]; const perMailbox=[];
  for(const mbox of MAILBOXES){
    let got=0;
    for(const folder of ["inbox","sentitems"]){
      const direction = folder==="sentitems" ? "outbound" : "inbound";
      let msgs=[]; try{ msgs=await listFolder(mbox,folder,days,PER_FOLDER); }catch(e){ perMailbox.push({mailbox:mbox,folder,error:String(e.message||e)}); continue; }
      got+=msgs.length; for(const m of msgs) gathered.push({m,mbox,direction,folder});
    }
    perMailbox.push({mailbox:mbox,pulled:got});
  }
  gathered.sort((a,b)=>String((b.m.receivedDateTime||b.m.sentDateTime)||"").localeCompare(String((a.m.receivedDateTime||a.m.sentDateTime)||"")));
  const truncated = gathered.length>CAP; const work = truncated?gathered.slice(0,CAP):gathered;

  const recs=[]; const partsByKey=new Map(); const learn=new Map(); const cand=new Map();
  let kept=0, matched=0;
  for(const g of work){
    const m=g.m, mbox=g.mbox, direction=g.direction;
    const fromAddr=(m.from&&m.from.emailAddress&&m.from.emailAddress.address)||"";
    const fromName=(m.from&&m.from.emailAddress&&m.from.emailAddress.name)||"";
    const parts=[]; const push=(role,ea)=>{ if(ea&&ea.address) parts.push({role,address:String(ea.address).toLowerCase(),name:ea.name||"",domain:domainOf(ea.address)}); };
    push("from",m.from&&m.from.emailAddress);
    (m.toRecipients||[]).forEach(r=>push("to",r.emailAddress));
    (m.ccRecipients||[]).forEach(r=>push("cc",r.emailAddress));
    const externals=parts.filter(p=>p.domain&&!INTERNAL_DOMAINS.includes(p.domain)&&p.role!=="cc")
                         .concat(parts.filter(p=>p.domain&&!INTERNAL_DOMAINS.includes(p.domain)&&p.role==="cc"));
    const primary = direction==="inbound" ? (externals.find(p=>p.role==="from")||externals[0]) : (externals.find(p=>p.role==="to")||externals[0]);
    if(!primary) continue;
    const exact = R.byEmail(primary.address);
    let dealer_id = exact || R.byDomain(primary.domain) || R.byName(primary.name) || null;
    const bizSignal = BIZ.test(`${m.subject||""} ${m.bodyPreview||""}`);
    const consumer = CONSUMER.has(primary.domain);
    if(!dealer_id && consumer && !bizSignal) continue;
    if(dealer_id && !exact && primary.domain && !R.knownDomain(primary.domain) && !consumer && !learn.has(primary.domain)) learn.set(primary.domain,dealer_id);
    const conf = (exact||R.byDomain(primary.domain))?"high":(dealer_id?"medium":"low");
    const key = mbox+"|"+m.id;
    recs.push({ graph_id:m.id, internet_message_id:clean(m.internetMessageId,300), mailbox_upn:mbox, direction,
      subject:clean(m.subject,500), snippet:clean(m.bodyPreview,500),
      from_address:((clean(fromAddr,200)||"").toLowerCase()||null), from_name:clean(fromName,200),
      sent_at:m.sentDateTime||null, received_at:m.receivedDateTime||null,
      dealer_id:dealer_id||null, thread_id:clean(m.conversationId,300),
      has_attachments:!!m.hasAttachments, relevance_score:bizSignal?1:0.5, match_confidence:conf, folder:g.folder });
    partsByKey.set(key, parts);
    if(dealer_id && primary.address && !consumer && !cand.has(primary.address))
      cand.set(primary.address,{email:primary.address,name:clean(primary.name,200),domain:primary.domain,dealer_id,suggested_reason:"seen in dealer email",status:"pending"});
    kept++; if(dealer_id) matched++;
  }

  const idByKey=new Map();
  for(let i=0;i<recs.length;i+=500){
    const rows=await sbSend("POST","email_messages?on_conflict=mailbox_upn,graph_id",recs.slice(i,i+500),{Prefer:"resolution=merge-duplicates,return=representation"});
    for(const r of (rows||[])) idByKey.set(r.mailbox_upn+"|"+r.graph_id, r.id);
  }
  if(learn.size){ const arr=[...learn.entries()].map(([domain,dealer_id])=>({domain,dealer_id,source:"email",confidence:0.8,verified:false}));
    for(let i=0;i<arr.length;i+=500){ try{ await sbSend("POST","dealer_domains",arr.slice(i,i+500),{Prefer:"return=minimal"}); }catch(e){} } }
  const ids=[...idByKey.values()];
  for(let i=0;i<ids.length;i+=200){ const chunk=ids.slice(i,i+200); try{ await sbSend("DELETE",`email_participants?message_id=in.(${chunk.join(",")})`,null,{Prefer:"return=minimal"}); }catch(e){} }
  const allParts=[];
  for(const [key,parts] of partsByKey){ const id=idByKey.get(key); if(!id) continue; for(const p of parts) allParts.push({message_id:id,role:p.role,address:p.address,display_name:clean(p.name,200),domain:p.domain}); }
  for(let i=0;i<allParts.length;i+=500){ try{ await sbSend("POST","email_participants",allParts.slice(i,i+500),{Prefer:"return=minimal"}); }catch(e){} }
  let newCands=0;
  if(cand.size){ let existing=new Set();
    try{ const ex=await sbGetAll("contact_candidates?select=email","email"); for(const r of (ex||[])) existing.add(String(r.email||"").toLowerCase()); }catch(e){}
    const toAdd=[...cand.values()].filter(c=>!existing.has(String(c.email).toLowerCase()));
    for(let i=0;i<toAdd.length;i+=500){ try{ await sbSend("POST","contact_candidates",toAdd.slice(i,i+500),{Prefer:"return=minimal"}); newCands+=toAdd.slice(i,i+500).length; }catch(e){} } }
  return {ok:true, scanned:work.length, kept, matched, learned_domains:learn.size, new_candidates:newCands,
    truncated: truncated?`capped at ${CAP} of ${gathered.length} — run again or narrow days to get the rest`:false, per_mailbox:perMailbox};
}
exports.runSync = runSync;

exports.handler = async (event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{ b=JSON.parse(event.body||"{}"); }catch{ return json(400,{error:"bad JSON"}); }

    // Read a dealer's captured emails for the Dealer 360 timeline — any signed-in staff.
    if(b.action==="dealer"){
      const id=String(b.dealer_id||"").trim(); if(!id) return json(400,{error:"dealer_id required"});
      let rows;
      try{ rows=await sbGet(`email_messages?dealer_id=eq.${encodeURIComponent(id)}&select=id,direction,subject,snippet,from_address,from_name,sent_at,received_at,thread_id,mailbox_upn,has_attachments,match_confidence,folder&order=received_at.desc.nullslast&limit=${Math.min(parseInt(b.limit||60,10)||60,200)}`); }
      catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/email_intelligence.sql first."}); }
      const msgs=(rows||[]).map(r=>({ id:r.id, direction:r.direction, subject:r.subject||"", snippet:r.snippet||"",
        who:(r.direction==="outbound")?(r.mailbox_upn||""):(r.from_name||r.from_address||""),
        counter:(r.direction==="outbound")?"":(r.from_address||""),
        when:r.received_at||r.sent_at||null, thread:r.thread_id||"", attach:!!r.has_attachments, conf:r.match_confidence||"" }));
      const inbound=msgs.filter(m=>m.direction==="inbound").length;
      return json(200,{ ok:true, count:msgs.length, inbound, outbound:msgs.length-inbound, messages:msgs });
    }

    // Read the FULL body of one captured message on demand — fetched live from Outlook via Graph and
    // never stored. Looks the message up in email_messages first, so staff can only open messages that
    // were already captured onto a dealer timeline (not arbitrary mailbox content). Same access as the
    // dealer timeline above (any signed-in staff), so it sits before the president-only gate.
    /* Why are the bodies blank? Answers it definitively rather than by inference: reads
       the app permissions Azure actually granted this integration, and says which one is
       missing. Safe to expose — it reports permission NAMES, never the token or secret. */
    if(b.action==="graph_health"){
      if(!G_TENANT||!G_CLIENT||!G_SECRET)
        return json(200,{ok:true,configured:false,
          summary:"Outlook isn't connected yet — set GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET in Netlify."});
      let tok=null, err=null;
      try{ tok=await graphToken(true); }catch(e){ err=String(e.message||e); }
      if(!tok) return json(200,{ok:true,configured:true,can_sign_in:false,summary:"Couldn't sign in to Microsoft Graph.",detail:err});
      const roles=tokenRoles(tok);
      const mail=roles.filter(r=>/^Mail\./.test(r));
      const canBody=CAN_READ_BODY(roles);
      const canSend=roles.some(r=>/^Mail\.Send$/.test(r));
      return json(200,{ok:true,configured:true,can_sign_in:true,
        roles, mail_roles:mail, can_read_bodies:canBody, can_send:canSend,
        summary: canBody
          ? `Connected. Email bodies can be read${canSend?" and sent":""}. Granted: ${mail.join(", ")||"—"}.`
          : `Connected, but this app CANNOT read email bodies. Granted: ${mail.join(", ")||"none"}. `
            + `Mail.ReadBasic returns a message's headers and recipients but deliberately strips the body, the preview and attachments — which is why every email in Dealer 360 shows no message body.`,
        fix: canBody?null:[
          "Azure portal → Microsoft Entra ID → App registrations → the HCPS Connect 360 app",
          "API permissions → Add a permission → Microsoft Graph → Application permissions",
          "Tick Mail.Read (and Mail.Send if you want reps to send from Dealer 360)",
          "Click Grant admin consent for your tenant",
          "Come back here and run this check again — bodies appear immediately, nothing needs re-syncing",
        ]});
    }

    if(b.action==="message"){
      const id=String(b.id||"").trim(); if(!id) return json(400,{error:"id required"});
      let row; try{ const rows=await sbGet(`email_messages?id=eq.${encodeURIComponent(id)}&select=id,graph_id,mailbox_upn,subject,snippet,from_address,from_name,direction,sent_at,received_at,has_attachments`); row=rows&&rows[0]; }
      catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/email_intelligence.sql first."}); }
      if(!row) return json(404,{ok:false,error:"not_found"});
      if(!G_TENANT||!G_CLIENT||!G_SECRET) return json(200,{ok:false,error:"graph_env_missing",message:"Set GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET in Netlify to read full email bodies."});
      if(!row.graph_id||!row.mailbox_upn) return json(200,{ok:false,error:"no_source",message:"This message has no Outlook reference to open."});
      const base=`/users/${encodeURIComponent(row.mailbox_upn)}/messages/${encodeURIComponent(row.graph_id)}`;
      const PREFER={Prefer:'outlook.body-content-type="html"'};
      let m;
      try{ m=await graphGet(`${base}?$select=subject,body,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime`,PREFER); }
      catch(e){ return json(200,{ok:false,error:"fetch_failed",message:"Couldn't open this message in Outlook — it may have been moved or deleted."}); }
      /* If a narrowed $select came back without a body, ask for the whole message once
         before concluding anything. $select is the cheap path, not the only one, and one
         retry costs far less than a rep staring at a blank panel. */
      if(!(m&&m.body&&String(m.body.content||"").trim())){
        try{ const full=await graphGet(base,PREFER); if(full&&full.body) m=Object.assign({},m,full); }catch(e){}
      }
      const bt=((m.body&&m.body.contentType)||"").toLowerCase();
      const content=String((m.body&&m.body.content)||"");
      const preview=String(m.bodyPreview||row.snippet||"");
      const to=(m.toRecipients||[]).map(r=>r.emailAddress&&r.emailAddress.address).filter(Boolean);
      const cc=(m.ccRecipients||[]).map(r=>r.emailAddress&&r.emailAddress.address).filter(Boolean);

      /* When the body is still empty, say WHY. An empty panel that offers no reason is
         what turns a ten-minute permission fix into "the CRM is broken". The overwhelmingly
         common cause is the Azure app holding Mail.ReadBasic, which returns exactly this:
         full headers and recipients, no body, no bodyPreview. */
      let body_status="ok", body_note=null;
      if(!content.trim()){
        let roles=[]; try{ roles=tokenRoles(await graphToken(true)); }catch(e){}
        if(roles.length && !CAN_READ_BODY(roles)){
          body_status="permission";
          body_note=`Outlook returned this message's headers but not its body, because the HCPS app registration has ${roles.filter(r=>/^Mail\./.test(r)).join(", ")||"no Mail.Read permission"}. `
                  + `Mail.ReadBasic deliberately excludes the body. Grant Mail.Read (Application) in Azure → App registrations → API permissions, click Grant admin consent, and bodies appear immediately — nothing needs re-syncing.`;
        } else if(preview.trim()){
          body_status="preview_only";
          body_note="Outlook returned only a preview of this message, not its full body.";
        } else {
          body_status="empty";
          body_note="This message genuinely has no text body in Outlook — its content may be an attachment or an image.";
        }
      }
      return json(200,{ ok:true, id:row.id, subject:m.subject||row.subject||"", direction:row.direction,
        from:row.from_address||((m.from&&m.from.emailAddress&&m.from.emailAddress.address)||""),
        from_name:row.from_name||((m.from&&m.from.emailAddress&&m.from.emailAddress.name)||""),
        to, cc, when:row.received_at||row.sent_at||null, has_attachments:!!row.has_attachments,
        body_html: bt==="html"?content:"", body_text: bt!=="html"?content:"",
        body_preview:preview, body_status, body_note });
    }

    // Send an approved AI-drafted email FROM the rep's own Outlook mailbox (Graph sendMail), then log
    // it to the Dealer 360 timeline. Any signed-in staff may send from their own mailbox. If the Graph
    // app doesn't yet have the Mail.Send permission, we return a clear fallback signal (the UI then
    // offers "open in Outlook") — nothing is silently dropped.
    if(b.action==="send"){
      const dealerId=String(b.dealer_id||"").trim();
      const to=String(b.to||"").trim().toLowerCase();
      const cc=Array.isArray(b.cc)?b.cc.map(x=>String(x||"").trim()).filter(Boolean):[];
      const subject=String(b.subject||"").trim();
      const bodyText=String(b.body_text||b.body||"");
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json(200,{ok:false,error:"bad_to",message:"Enter a valid recipient email."});
      if(!subject) return json(200,{ok:false,error:"no_subject",message:"Add a subject line."});
      if(!bodyText.trim()) return json(200,{ok:false,error:"no_body",message:"The email body is empty."});
      const fromMailbox=String(me.email||"").toLowerCase();   // the rep's login email == their Outlook mailbox
      if(!fromMailbox) return json(200,{ok:false,error:"no_sender",message:"Your account has no email on file to send from."});
      if(!G_TENANT||!G_CLIENT||!G_SECRET) return json(200,{ok:false,error:"graph_env_missing",fallback:true,to,message:"Sending from Outlook isn't set up yet (Graph credentials)."});
      const msg={ message:{ subject, body:{contentType:"HTML", content:emailHtml(bodyText)},
        toRecipients:[{emailAddress:{address:to}}],
        ccRecipients:cc.map(a=>({emailAddress:{address:a}})) }, saveToSentItems:true };
      let sendErr=null;
      try{
        const tok=await graphToken();
        const r=await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromMailbox)}/sendMail`,
          {method:"POST",headers:{Authorization:`Bearer ${tok}`,"content-type":"application/json"},body:JSON.stringify(msg)});
        if(r.status!==202){
          const t=await r.text().catch(()=>"");
          if(r.status===403||/ErrorAccessDenied|Access is denied|Authorization_Request|does not have permission/i.test(t))
            sendErr={error:"mail_send_denied",message:"The Microsoft Graph app can't send yet — grant it the Mail.Send permission (admin consent in Azure) to send from Outlook."};
          else if(r.status===404) sendErr={error:"mailbox_not_found",message:`No Outlook mailbox found for ${fromMailbox}.`};
          else sendErr={error:"send_failed",message:"Outlook couldn't send this message.",detail:String(t).slice(0,200)};
        }
      }catch(e){ sendErr={error:"send_failed",message:String(e.message||e).slice(0,200)}; }
      if(sendErr) return json(200,{ok:false,fallback:true,to,...sendErr});
      // Sent — log it to the Dealer 360 timeline (best-effort; never blocks the success).
      if(dealerId){ try{ await sbSend("POST","dealer_activity",{dealer_id:dealerId,kind:"email",subject:subject,detail:"Sent to "+to,contact_email:to,actor:fromMailbox},{Prefer:"return=minimal"}); }catch(e){} }
      return json(200,{ok:true,to});
    }

    if(me.role!=="president") return json(403,{error:"president only"});

    if(b.action==="status"){
      return json(200,{ok:true, mailboxes:MAILBOXES, internal_domains:INTERNAL_DOMAINS,
        env:{ graph_tenant:!!G_TENANT, graph_client:!!G_CLIENT, graph_secret:!!G_SECRET, mailbox_count:MAILBOXES.length,
              supabase:!!(SUPABASE_URL&&SERVICE_ROLE), postmark_dmarc:!!process.env.POSTMARK_DMARC_API_TOKEN } });
    }

    // Email deliverability — Postmark DMARC monitoring. Reads SPF/DKIM/DMARC pass rates + the
    // sending sources seen for your domain, so deliverability lives next to the email sync it protects.
    // Env: POSTMARK_DMARC_API_TOKEN (from dmarc.postmarkapp.com). No-op with a clear message if unset.
    if(b.action==="deliverability"){
      const TOK=process.env.POSTMARK_DMARC_API_TOKEN;
      if(!TOK) return json(200,{ok:false,error:"not_configured",message:"Add POSTMARK_DMARC_API_TOKEN in Netlify (from dmarc.postmarkapp.com) to turn on deliverability monitoring."});
      const BASE="https://dmarc.postmarkapp.com", PH={"X-Api-Token":TOK,"Accept":"application/json"};
      const out={ok:true};
      try{ const r=await fetch(`${BASE}/records/my/verify`,{method:"POST",headers:PH}); const j=await r.json().catch(()=>({})); out.verified=(typeof j.verified==="boolean")?j.verified:null; }catch(e){ out.verified=null; }
      const isoDay=d=>new Date(Date.now()-d*864e5).toISOString().slice(0,10);
      const from=isoDay(30), to=isoDay(0);
      let reports=[]; try{ const r=await fetch(`${BASE}/records/my/reports?from_date=${from}&to_date=${to}&limit=100`,{headers:PH}); const j=await r.json().catch(()=>({})); reports=j.reports||j.entries||j.data||(Array.isArray(j)?j:[]); }catch(e){}
      out.window={from,to}; out.report_count=Array.isArray(reports)?reports.length:0;
      let total=0,spf=0,dkim=0,dmarc=0; const src={};
      for(const rep of (Array.isArray(reports)?reports.slice(0,20):[])){ const id=rep&&rep.id; if(!id) continue;
        try{ const r=await fetch(`${BASE}/records/my/reports/${encodeURIComponent(id)}`,{headers:PH}); const d=await r.json().catch(()=>({})); const recs=d.records||[];
          for(const rec of recs){ const c=Number(rec.count)||0; if(!c) continue; total+=c;
            const sp=/pass/i.test(rec.policy_evaluated_spf||""), dk=/pass/i.test(rec.policy_evaluated_dkim||"");
            if(sp)spf+=c; if(dk)dkim+=c; if(sp||dk)dmarc+=c;   // DMARC passes when SPF OR DKIM is aligned
            const key=rec.host_name||rec.source_ip||"unknown"; const s=src[key]=src[key]||{source:key,total:0,spf:0,dkim:0}; s.total+=c; if(sp)s.spf+=c; if(dk)s.dkim+=c; }
        }catch(e){}
      }
      const pct=n=>total?Math.round(n/total*100):null;
      out.totals={messages:total, spf_pct:pct(spf), dkim_pct:pct(dkim), dmarc_pct:pct(dmarc)};
      out.sources=Object.values(src).sort((a,b)=>b.total-a.total).slice(0,12)
        .map(s=>({source:s.source, messages:s.total, spf_pct:s.total?Math.round(s.spf/s.total*100):0, dkim_pct:s.total?Math.round(s.dkim/s.total*100):0}));
      return json(200,out);
    }

    // Seed dealer_domains from emails already on file (dealers.email + dealer_contacts).
    // High precision: only map a domain when every dealer using it belongs to ONE family (HQ root).
    if(b.action==="seed_domains"){
      try{ await sbGet("dealer_domains?select=domain&limit=1"); }
      catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/email_intelligence.sql first."}); }
      const [dealers,contacts]=await Promise.all([
        sbGetAll("dealers?select=id,business_name,parent_id,email","id").catch(()=>[]),
        sbGetAll("dealer_contacts?select=dealer_id,email","dealer_id").catch(()=>[]),
      ]);
      const byId=new Map(); for(const d of dealers) byId.set(d.id,d);
      const rootOf=id=>{ const d=byId.get(id); return (d&&d.parent_id)?d.parent_id:id; };
      const domRoots=new Map();
      const add=(email,dealer_id)=>{ const dom=domainOf(email); if(!dom||CONSUMER.has(dom)||INTERNAL_DOMAINS.includes(dom)) return;
        const root=rootOf(dealer_id); (domRoots.get(dom)||domRoots.set(dom,new Set()).get(dom)).add(root); };
      for(const d of dealers){ if(d.email) add(d.email,d.id); }
      for(const c of contacts){ if(c.email&&c.dealer_id) add(c.email,c.dealer_id); }
      let existing=new Set(); try{ existing=new Set((await sbGetAll("dealer_domains?select=domain","domain")).map(r=>String(r.domain).toLowerCase())); }catch(e){}
      const toAdd=[]; let ambiguous=0;
      for(const [dom,roots] of domRoots){ if(roots.size!==1){ ambiguous++; continue; } if(existing.has(dom)) continue; toAdd.push({domain:dom,dealer_id:[...roots][0],source:"seed",confidence:0.9,verified:false}); }
      let added=0; for(let i=0;i<toAdd.length;i+=500){ try{ await sbSend("POST","dealer_domains",toAdd.slice(i,i+500),{Prefer:"return=minimal"}); added+=toAdd.slice(i,i+500).length; }catch(e){} }
      return json(200,{ok:true, domains_added:added, skipped_ambiguous:ambiguous, already_had:existing.size, total_domains_seen:domRoots.size});
    }

    if(!G_TENANT||!G_CLIENT||!G_SECRET) return json(200,{ok:false,error:"graph_env_missing",message:"Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET in Netlify."});
    if(!MAILBOXES.length) return json(200,{ok:false,error:"no_mailboxes",message:"Set GRAPH_MAILBOXES (comma-separated) in Netlify."});

    if(b.action==="test"){
      const mbox=(b.mailbox&&String(b.mailbox).toLowerCase())||MAILBOXES[0];
      const [inb,snt]=await Promise.all([ listFolder(mbox,"inbox",b.days||14,5), listFolder(mbox,"sentitems",b.days||14,5) ]);
      const shape=m=>({ from:(m.from&&m.from.emailAddress&&m.from.emailAddress.address)||"", subject:m.subject||"",
        when:m.receivedDateTime||m.sentDateTime, to:(m.toRecipients||[]).map(r=>r.emailAddress&&r.emailAddress.address).filter(Boolean) });
      return json(200,{ok:true, mailbox:mbox, inbox_count:inb.length, sent_count:snt.length,
        inbox_sample:inb.map(shape), sent_sample:snt.map(shape) });
    }

    if(b.action==="sync"){
      const r=await runSync({days:b.days, per_folder:b.per_folder, cap:b.cap});
      return json(200,r);
    }

    // Dealer list for the unmatched-sender assignment dropdown.
    if(b.action==="dealers"){
      const ds=await sbGetAll("dealers?select=id,business_name,parent_id","id").catch(()=>[]);
      const list=ds.map(d=>({id:d.id,name:d.business_name||"",branch:!!d.parent_id})).filter(d=>d.name).sort((a,b)=>a.name.localeCompare(b.name));
      return json(200,{ok:true,dealers:list});
    }

    // Distinct unmatched senders — emails we captured but couldn't place with a dealer.
    if(b.action==="unmatched"){
      let rows; try{ rows=await sbGetAll("email_messages?dealer_id=is.null&select=from_address,from_name,subject,received_at,direction","received_at"); }
      catch(e){ return json(200,{ok:false,error:"tables_missing"}); }
      const hide=buildHider(await loadSenderRules());
      const by=new Map();
      for(const r of (rows||[])){ const a=String(r.from_address||"").toLowerCase(); if(!a) continue;
        if(INTERNAL_DOMAINS.includes(domainOf(a))) continue;               // skip our own sent-from
        const o=by.get(a)||{email:a,name:r.from_name||"",domain:domainOf(a),count:0,last_subject:"",last:""};
        o.count++; if(!o.last || String(r.received_at||"")>o.last){ o.last=r.received_at||""; o.last_subject=r.subject||""; } if(!o.name&&r.from_name)o.name=r.from_name;
        by.set(a,o); }
      const active=[]; let hiddenAuto=0, hiddenRule=0;
      for(const o of by.values()){ const h=hide(o.email); if(h==="rule"){hiddenRule++;continue;} if(h==="auto"){hiddenAuto++;continue;} active.push(o); }
      active.sort((a,b)=>b.count-a.count);
      return json(200,{ok:true, unmatched:active.slice(0,300), total_addresses:active.length, hidden:{auto:hiddenAuto, rule:hiddenRule}});
    }

    // Assign an unmatched sender to a dealer: save as a contact AND back-fill past messages.
    if(b.action==="assign_email"){
      const email=String(b.email||"").trim().toLowerCase(), dealer_id=clean(b.dealer_id,80);
      if(!email||!dealer_id) return json(400,{error:"email and dealer_id required"});
      try{ await sbSend("POST","dealer_contacts?on_conflict=dealer_id,email",{dealer_id,email,name:clean(b.name,120)||null},{Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){}
      // Back-fill this sender's past unmatched messages. from_address was historically stored with its
      // ORIGINAL casing while the queue groups and looks it up lowercased — so the old case-sensitive
      // `from_address=eq.<lowercased>` filter matched 0 rows ("assigned (0 emails)"). Match
      // case-insensitively by pulling the unmatched ids and comparing lowercased, then PATCH by id.
      let updated=0;
      try{
        const cands=await sbGetAll("email_messages?dealer_id=is.null&select=id,from_address").catch(()=>[]);
        const ids=(cands||[]).filter(r=>String(r.from_address||"").trim().toLowerCase()===email).map(r=>r.id);
        for(let i=0;i<ids.length;i+=200){ const slice=ids.slice(i,i+200);
          await sbSend("PATCH",`email_messages?id=in.(${slice.join(",")})`,{dealer_id,match_confidence:"high"},{Prefer:"return=minimal"}); }
        updated=ids.length;
      }catch(e){}
      return json(200,{ok:true, email, dealer_id, messages_updated:updated});
    }

    // Hide a noisy sender from the unmatched queue (reversible). Accepts an exact {email}, a whole
    // {domain}, or a {pattern} substring. classify is 'ignore' (default) or 'not_important'.
    if(b.action==="ignore_sender"){
      let kind, value;
      if(b.pattern){ kind="pattern"; value=String(b.pattern).toLowerCase().trim(); }
      else if(b.domain){ kind="domain"; value=String(b.domain).toLowerCase().trim().replace(/^@/,""); }
      else if(b.email){ kind="email"; value=String(b.email).toLowerCase().trim(); }
      else return json(400,{error:"email, domain, or pattern required"});
      if(!value) return json(400,{error:"empty value"});
      const classify=(b.classify==="not_important")?"not_important":"ignore";
      try{ await sbSend("POST","email_sender_rules?on_conflict=kind,value",{kind,value,action:classify,reason:clean(b.reason,200)||null,created_by:me.email||null},{Prefer:"resolution=merge-duplicates,return=minimal"}); }
      catch(e){ if(/relation|does not exist|email_sender_rules/i.test(String(e.message||e))) return json(200,{ok:false,error:"tables_missing",message:"Run supabase/email_sender_rules.sql first."}); return json(500,{error:String(e.message||e)}); }
      return json(200,{ok:true, kind, value, action:classify});
    }

    // Restore an ignored sender/domain/pattern back into the queue — delete the rule (by id, or kind+value).
    if(b.action==="restore_sender"){
      try{
        if(b.id!=null&&b.id!=="") await sbSend("DELETE",`email_sender_rules?id=eq.${encodeURIComponent(b.id)}`,null,{Prefer:"return=minimal"});
        else if(b.kind&&b.value) await sbSend("DELETE",`email_sender_rules?kind=eq.${encodeURIComponent(b.kind)}&value=eq.${encodeURIComponent(String(b.value).toLowerCase())}`,null,{Prefer:"return=minimal"});
        else return json(400,{error:"id or kind+value required"});
      }catch(e){ return json(500,{error:String(e.message||e)}); }
      return json(200,{ok:true});
    }

    // The Ignored Senders list (admin rules) + the always-on automatic patterns (for display).
    if(b.action==="ignored_list"){
      return json(200,{ok:true, rules:await loadSenderRules(), auto_patterns:AUTO_LOCAL});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

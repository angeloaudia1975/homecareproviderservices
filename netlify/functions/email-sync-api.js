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

// ---- Microsoft Graph (app-only) ----
let _tok=null, _tokExp=0;
async function graphToken(){
  if(_tok && Date.now()<_tokExp-60000) return _tok;
  const body=new URLSearchParams({client_id:G_CLIENT,client_secret:G_SECRET,scope:"https://graph.microsoft.com/.default",grant_type:"client_credentials"});
  const r=await fetch(`https://login.microsoftonline.com/${G_TENANT}/oauth2/v2.0/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`Graph auth ${r.status}: ${j.error||""} ${j.error_description||await r.text().catch(()=>"")}`.slice(0,300));
  _tok=j.access_token; _tokExp=Date.now()+(j.expires_in||3599)*1000; return _tok;
}
async function graphGet(path){
  const tok=await graphToken();
  const r=await fetch(`https://graph.microsoft.com/v1.0${path}`,{headers:{Authorization:`Bearer ${tok}`}});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`Graph ${r.status} on ${path}: ${(j.error&&j.error.message)||""}`.slice(0,300));
  return j;
}
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
  const [dealers,aliases,domains]=await Promise.all([
    sbGetAll("dealers?select=id,business_name,parent_id","id").catch(()=>[]),
    sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
    sbGetAll("dealer_domains?select=domain,dealer_id","domain").catch(()=>[]),
  ]);
  const norm2id=new Map(); for(const d of dealers) norm2id.set(dnorm(d.business_name), d.id);
  for(const a of aliases){ if(a&&a.alias_norm&&!norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm, a.dealer_id); }
  const dom2id=new Map(); for(const x of domains){ if(x&&x.domain) dom2id.set(String(x.domain).toLowerCase(), x.dealer_id); }
  return {
    byDomain:d=>dom2id.get(String(d||"").toLowerCase())||null,
    byName:n=>norm2id.get(dnorm(n))||null,
    knownDomain:d=>dom2id.has(String(d||"").toLowerCase()),
  };
}

const BIZ=/(order|invoice|\bpo\b|purchase|quote|pricing|backorder|\brma\b|return|ship|tracking|catalog|reorder|net ?30|account|wholesale|dealer|bng\d|strongback|airavant|bongo|pedifix|golden)/i;
function isInternal(addr){ const d=domainOf(addr); return INTERNAL_DOMAINS.includes(d); }

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

    if(me.role!=="president") return json(403,{error:"president only"});

    if(b.action==="status"){
      return json(200,{ok:true, mailboxes:MAILBOXES, internal_domains:INTERNAL_DOMAINS,
        env:{ graph_tenant:!!G_TENANT, graph_client:!!G_CLIENT, graph_secret:!!G_SECRET, mailbox_count:MAILBOXES.length,
              supabase:!!(SUPABASE_URL&&SERVICE_ROLE) } });
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
      // table present?
      try{ await sbGet("email_messages?select=id&limit=1"); }
      catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/email_intelligence.sql first."}); }
      const R=await buildResolver();
      const days=Math.min(Math.max(parseInt(b.days||30,10)||30,1),120);
      let kept=0, matched=0, learned=0, candidates=0, scanned=0; const perMailbox=[];
      for(const mbox of MAILBOXES){
        let mk=0,mm=0;
        for(const folder of ["inbox","sentitems"]){
          const direction = folder==="sentitems" ? "outbound" : "inbound";
          let msgs=[]; try{ msgs=await listFolder(mbox,folder,days,200); }catch(e){ perMailbox.push({mailbox:mbox,folder,error:String(e.message||e)}); continue; }
          for(const m of msgs){
            scanned++;
            const fromAddr=(m.from&&m.from.emailAddress&&m.from.emailAddress.address)||"";
            const fromName=(m.from&&m.from.emailAddress&&m.from.emailAddress.name)||"";
            const parts=[]; const push=(role,ea)=>{ if(ea&&ea.address) parts.push({role,address:String(ea.address).toLowerCase(),name:ea.name||"",domain:domainOf(ea.address)}); };
            push("from",m.from&&m.from.emailAddress);
            (m.toRecipients||[]).forEach(r=>push("to",r.emailAddress));
            (m.ccRecipients||[]).forEach(r=>push("cc",r.emailAddress));
            // external counterparties (not our own mailboxes/domain)
            const externals=parts.filter(p=>p.domain && !INTERNAL_DOMAINS.includes(p.domain) && p.role!=="cc")
                                  .concat(parts.filter(p=>p.domain && !INTERNAL_DOMAINS.includes(p.domain) && p.role==="cc"));
            const primary = direction==="inbound"
              ? externals.find(p=>p.role==="from")||externals[0]
              : externals.find(p=>p.role==="to")||externals[0];
            if(!primary) continue;                                   // internal-only → skip
            // relevance: known dealer domain, or matches a dealer by name, or business signal, drop pure-consumer noise
            let dealer_id = R.byDomain(primary.domain) || R.byName(primary.name) || null;
            const bizSignal = BIZ.test(`${m.subject||""} ${m.bodyPreview||""}`);
            const consumer = CONSUMER.has(primary.domain);
            if(!dealer_id && consumer && !bizSignal) continue;       // personal/consumer, no business signal → drop
            // learn: matched by name but domain unknown → remember domain→dealer
            if(dealer_id && primary.domain && !R.knownDomain(primary.domain) && !consumer){
              try{ await sbSend("POST","dealer_domains?on_conflict=domain",{domain:primary.domain,dealer_id,source:"email",confidence:0.8,verified:false},{Prefer:"resolution=merge-duplicates,return=minimal"}); learned++; }catch(e){}
            }
            const conf = R.byDomain(primary.domain)?"high":(dealer_id?"medium":"low");
            // upsert message (idempotent on mailbox_upn+graph_id)
            let row;
            try{
              row=await sbSend("POST","email_messages?on_conflict=mailbox_upn,graph_id",[{
                graph_id:m.id, internet_message_id:clean(m.internetMessageId,300), mailbox_upn:mbox, direction,
                subject:clean(m.subject,500), snippet:clean(m.bodyPreview,500),
                from_address:clean(fromAddr,200), from_name:clean(fromName,200),
                sent_at:m.sentDateTime||null, received_at:m.receivedDateTime||null,
                dealer_id:dealer_id||null, manufacturer:null, thread_id:clean(m.conversationId,300),
                has_attachments:!!m.hasAttachments, relevance_score:bizSignal?1:0.5, match_confidence:conf, folder,
              }],{Prefer:"resolution=merge-duplicates,return=representation"});
            }catch(e){ perMailbox.push({mailbox:mbox,folder,error:String(e.message||e)}); continue; }
            const mid=row&&row[0]&&row[0].id;
            if(mid){
              // replace participants for this message
              try{ await sbSend("DELETE",`email_participants?message_id=eq.${mid}`,null,{Prefer:"return=minimal"}); }catch(e){}
              try{ await sbSend("POST","email_participants",parts.map(p=>({message_id:mid,role:p.role,address:p.address,display_name:clean(p.name,200),domain:p.domain})),{Prefer:"return=minimal"}); }catch(e){}
            }
            kept++; mk++;
            if(dealer_id){ matched++; mm++; }
            // contact candidate: an external person tied to a matched dealer
            if(dealer_id && primary.address && !consumer){
              try{
                const ex=await sbGet(`contact_candidates?select=id,msg_count&email=eq.${encodeURIComponent(primary.address)}`).catch(()=>[]);
                if(ex&&ex[0]){ await sbSend("PATCH",`contact_candidates?id=eq.${ex[0].id}`,{last_seen:new Date().toISOString(),msg_count:(ex[0].msg_count||1)+1},{Prefer:"return=minimal"}); }
                else{ await sbSend("POST","contact_candidates",{email:primary.address,name:clean(primary.name,200),domain:primary.domain,dealer_id,suggested_reason:"seen in dealer email",status:"pending"},{Prefer:"return=minimal"}); candidates++; }
              }catch(e){}
            }
          }
        }
        perMailbox.push({mailbox:mbox,kept:mk,matched:mm});
      }
      return json(200,{ok:true, scanned, kept, matched, learned_domains:learned, new_candidates:candidates, per_mailbox:perMailbox});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

// HCPS Target Audience Builder API — the master audience layer.
// Assembles every dealer company + email contact with its attributes for the
// builder table, and saves named audiences (static hand-picked, or dynamic rules)
// inside HCPS. Campaign Studio resolves these into a send list (Phase 2).
//   POST {action:"contacts"}                         -> {companies:[...], meta:{states,reps,manufacturers}}
//   POST {action:"create", name,type,members,rules}  -> {audience}
//   POST {action:"list"} / {action:"get",id}         -> audience(s)
//   POST {action:"resolve", id}                       -> {companies,contacts,valid,unsubscribed,invalid,list}
//   POST {action:"update"|"delete"|"duplicate"|"add_members"|"remove_members", ...}
//   All require a staff Bearer token.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const json=(c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base,col="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${col}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE)break; from+=PAGE; } return out; }
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const P=require("./_platform.js");

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim(); if(!tok) return null;
  try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
    if(!r.ok) return null; const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase(); if(!email) return null;
    const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=role,name,active`).catch(()=>[]);
    const su=s&&s[0]; if(su&&su.active!==false) return {role:su.role||"rep",name:su.name||email,email};
  }catch(e){}
  return null;
}

// Build every company with its marketing contacts + attributes.
async function assembleContacts(){
  const [dealers,contacts,eng,lines,mfrs,opt]=await Promise.all([
    sbGetAll("dealers?select=id,business_name,email,state,city,parent_id","id"),
    sbGetAll("dealer_contacts?select=dealer_id,name,email,title,role","dealer_id").catch(()=>[]),
    sbGetAll("dealer_engagement?select=dealer_id,status,rep_name,last_period,months_since","dealer_id").catch(()=>[]),
    sbGetAll("dealer_line_status?select=dealer_id,manufacturer,relationship","dealer_id").catch(()=>[]),
    sbGet("manufacturers?select=slug,name").catch(()=>[]),
    sbGet("email_optout?select=email").catch(()=>[]),
  ]);
  const mfrName={}; mfrs.forEach(m=>mfrName[m.slug]=m.name||m.slug);
  const engById={}; eng.forEach(e=>engById[e.dealer_id]=e);
  const optSet=new Set((opt||[]).map(o=>String(o.email||"").toLowerCase()));
  const cByD={}; (contacts||[]).forEach(c=>{ (cByD[c.dealer_id]=cByD[c.dealer_id]||[]).push(c); });
  const lByD={}; (lines||[]).forEach(l=>{ (lByD[l.dealer_id]=lByD[l.dealer_id]||[]).push(l); });
  const companies=[];
  for(const d of dealers){
    const e=engById[d.id]||{};
    const rels=(lByD[d.id]||[]).map(l=>({slug:l.manufacturer,name:mfrName[l.manufacturer]||l.manufacturer,relationship:l.relationship}));
    const seen=new Set(), cs=[];
    const add=(name,email,title,role,source)=>{ const em=String(email||"").trim(); if(!EMAIL_RE.test(em))return; const lo=em.toLowerCase(); if(seen.has(lo))return; seen.add(lo); cs.push({name:name||"",email:em,title:title||"",role:role||"",unsub:optSet.has(lo),source}); };
    add(d.business_name,d.email,"","Company","company");
    (cByD[d.id]||[]).forEach(c=>add(c.name,c.email,c.title,c.role,"contact"));
    companies.push({ dealer_id:d.id, company:d.business_name||"", state:String(d.state||"").toUpperCase(), city:d.city||"",
      rep:e.rep_name||"", status:e.status||"", last_order:e.last_period||"", months_since:(e.months_since!=null?e.months_since:null),
      relationships:rels, contacts:cs });
  }
  const states=[...new Set(companies.map(c=>c.state).filter(Boolean))].sort();
  const reps=[...new Set(companies.map(c=>c.rep).filter(Boolean))].sort();
  const manufacturers=(mfrs||[]).map(m=>({slug:m.slug,name:m.name||m.slug})).sort((a,b)=>a.name.localeCompare(b.name));
  return {companies, meta:{states,reps,manufacturers}};
}
function applyRules(companies,rules){
  rules=rules||{}; let out=companies;
  if(rules.state) out=out.filter(c=>c.state===String(rules.state).toUpperCase());
  if(rules.rep) out=out.filter(c=>c.rep===rules.rep);
  if(rules.manufacturer) out=out.filter(c=>c.relationships.some(r=>r.slug===rules.manufacturer && (!rules.relationship||r.relationship===rules.relationship)));
  else if(rules.relationship) out=out.filter(c=>c.relationships.some(r=>r.relationship===rules.relationship));
  return out;
}
function flattenMembers(companies){
  const list=[];
  companies.forEach(c=>c.contacts.forEach(ct=>list.push({dealer_id:c.dealer_id,company:c.company,contact_name:ct.name,contact_email:ct.email})));
  return list;
}
function breakdown(members,optSet){
  let valid=0,unsub=0,invalid=0; const companies=new Set();
  for(const m of members){ const em=String(m.contact_email||"").trim().toLowerCase(); companies.add(m.dealer_id);
    if(!EMAIL_RE.test(em)) invalid++; else if(optSet.has(em)) unsub++; else valid++; }
  return {companies:companies.size, contacts:members.length, valid, unsubscribed:unsub, invalid};
}

exports.handler=async(event)=>{
  try{
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event); if(!me) return json(401,{error:"unauthorized"});
    let b; try{b=JSON.parse(event.body||"{}");}catch{b={};}
    const act=b.action||"list";

    if(act==="contacts"){ return json(200,{ok:true,...(await assembleContacts())}); }

    if(act==="create"){
      const name=String(b.name||"").trim(); if(!name) return json(400,{error:"name required"});
      const type=(b.type==="dynamic")?"dynamic":"static";
      const rules=(b.rules&&typeof b.rules==="object")?b.rules:{};
      const st=await P.getState();
      let members=[];
      if(type==="static"){ members=(Array.isArray(b.members)?b.members:[]).filter(m=>m&&EMAIL_RE.test(String(m.contact_email||"").trim())); }
      else { const {companies}=await assembleContacts(); members=flattenMembers(applyRules(companies,rules)); }
      const companies=new Set(members.map(m=>m.dealer_id)).size;
      const ins=await sbSend("POST","audiences",{name,type,rules,company_count:companies,contact_count:members.length,env:P.envFor(st.mode,false),created_by:me.name||me.email,updated_at:new Date().toISOString()},{Prefer:"return=representation"});
      const aud=ins&&ins[0];
      if(type==="static" && aud && members.length){
        const rows=members.map(m=>({audience_id:aud.id,dealer_id:m.dealer_id||null,company:m.company||"",contact_name:m.contact_name||"",contact_email:String(m.contact_email).trim()}));
        for(let i=0;i<rows.length;i+=300){ try{ await sbSend("POST","audience_members?on_conflict=audience_id,contact_email",rows.slice(i,i+300),{Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){} }
      }
      return json(200,{ok:true,audience:aud});
    }

    if(act==="list"){
      const rows=await sbGet("audiences?select=*&order=updated_at.desc&limit=200").catch(()=>[]);
      return json(200,{ok:true,audiences:rows||[]});
    }
    if(act==="get"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`audiences?id=eq.${encodeURIComponent(b.id)}&select=*`).catch(()=>[]);
      const a=rows&&rows[0]; if(!a) return json(404,{error:"not found"});
      let members=[];
      if(a.type==="static") members=await sbGetAll(`audience_members?audience_id=eq.${encodeURIComponent(a.id)}&select=dealer_id,company,contact_name,contact_email`,"contact_email").catch(()=>[]);
      else { const {companies}=await assembleContacts(); members=flattenMembers(applyRules(companies,a.rules||{})); }
      return json(200,{ok:true,audience:a,members});
    }
    if(act==="resolve"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`audiences?id=eq.${encodeURIComponent(b.id)}&select=*`).catch(()=>[]);
      const a=rows&&rows[0]; if(!a) return json(404,{error:"not found"});
      let members=[];
      if(a.type==="static") members=await sbGetAll(`audience_members?audience_id=eq.${encodeURIComponent(a.id)}&select=dealer_id,company,contact_name,contact_email`,"contact_email").catch(()=>[]);
      else { const {companies}=await assembleContacts(); members=flattenMembers(applyRules(companies,a.rules||{})); }
      const optSet=new Set((await sbGet("email_optout?select=email").catch(()=>[])).map(o=>String(o.email||"").toLowerCase()));
      const bd=breakdown(members,optSet);
      const list=members.filter(m=>{ const em=String(m.contact_email||"").trim().toLowerCase(); return EMAIL_RE.test(em)&&!optSet.has(em); });
      return json(200,{ok:true,audience:{id:a.id,name:a.name,type:a.type},...bd,send:list.length,list});
    }
    if(act==="update"){
      if(!b.id) return json(400,{error:"id required"});
      const patch={}; if(b.name!=null)patch.name=String(b.name).trim(); if(b.rules)patch.rules=b.rules; if(b.notes!=null)patch.notes=String(b.notes);
      patch.updated_at=new Date().toISOString();
      await sbSend("PATCH",`audiences?id=eq.${encodeURIComponent(b.id)}`,patch,{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }
    if(act==="delete"){
      if(!b.id) return json(400,{error:"id required"});
      await sbSend("DELETE",`audiences?id=eq.${encodeURIComponent(b.id)}`,null,{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }
    if(act==="duplicate"){
      if(!b.id) return json(400,{error:"id required"});
      const rows=await sbGet(`audiences?id=eq.${encodeURIComponent(b.id)}&select=*`).catch(()=>[]); const a=rows&&rows[0]; if(!a) return json(404,{error:"not found"});
      const st=await P.getState();
      const ins=await sbSend("POST","audiences",{name:(a.name||"Audience")+" (copy)",type:a.type,rules:a.rules,company_count:a.company_count,contact_count:a.contact_count,env:P.envFor(st.mode,false),created_by:me.name||me.email,updated_at:new Date().toISOString()},{Prefer:"return=representation"});
      const na=ins&&ins[0];
      if(a.type==="static"&&na){ const mem=await sbGetAll(`audience_members?audience_id=eq.${encodeURIComponent(a.id)}&select=dealer_id,company,contact_name,contact_email`,"contact_email").catch(()=>[]);
        const rws=mem.map(m=>({audience_id:na.id,dealer_id:m.dealer_id,company:m.company,contact_name:m.contact_name,contact_email:m.contact_email}));
        for(let i=0;i<rws.length;i+=300){ try{ await sbSend("POST","audience_members",rws.slice(i,i+300),{Prefer:"return=minimal"}); }catch(e){} } }
      return json(200,{ok:true,audience:na});
    }
    if(act==="add_members"||act==="remove_members"){
      if(!b.id) return json(400,{error:"id required"});
      const emails=(Array.isArray(b.members)?b.members:[]);
      if(act==="add_members"){ const rows=emails.filter(m=>EMAIL_RE.test(String(m.contact_email||"").trim())).map(m=>({audience_id:b.id,dealer_id:m.dealer_id||null,company:m.company||"",contact_name:m.contact_name||"",contact_email:String(m.contact_email).trim()}));
        for(let i=0;i<rows.length;i+=300){ try{ await sbSend("POST","audience_members?on_conflict=audience_id,contact_email",rows.slice(i,i+300),{Prefer:"resolution=merge-duplicates,return=minimal"}); }catch(e){} } }
      else { for(const m of emails){ try{ await sbSend("DELETE",`audience_members?audience_id=eq.${encodeURIComponent(b.id)}&contact_email=eq.${encodeURIComponent(String(m.contact_email||m))}`,null,{Prefer:"return=minimal"}); }catch(e){} } }
      // refresh cached counts
      const mem=await sbGetAll(`audience_members?audience_id=eq.${encodeURIComponent(b.id)}&select=dealer_id`,"dealer_id").catch(()=>[]);
      await sbSend("PATCH",`audiences?id=eq.${encodeURIComponent(b.id)}`,{contact_count:mem.length,company_count:new Set(mem.map(m=>m.dealer_id)).size,updated_at:new Date().toISOString()},{Prefer:"return=minimal"}).catch(()=>{});
      return json(200,{ok:true});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

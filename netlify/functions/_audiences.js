// Shared audience resolution — one source of truth for the Target Audience Builder
// and Campaign Studio. Assembles companies/contacts, applies dynamic rules, and
// resolves a saved audience (static or dynamic) into a clean send list + breakdown.
const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE;
const H=()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}`); return r.json(); }
async function sbGetAll(base,col="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${col}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE)break; from+=PAGE; } return out; }
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      rep:e.rep_name||"", status:e.status||"", last_order:e.last_period||"", months_since:(e.months_since!=null?e.months_since:null), relationships:rels, contacts:cs });
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
  const list=[]; companies.forEach(c=>c.contacts.forEach(ct=>list.push({dealer_id:c.dealer_id,company:c.company,contact_name:ct.name,contact_email:ct.email}))); return list;
}
async function resolveById(id){
  const rows=await sbGet(`audiences?id=eq.${encodeURIComponent(id)}&select=*`).catch(()=>[]);
  const a=rows&&rows[0]; if(!a) return null;
  let members;
  if(a.type==="static") members=await sbGetAll(`audience_members?audience_id=eq.${encodeURIComponent(id)}&select=dealer_id,company,contact_name,contact_email`,"contact_email").catch(()=>[]);
  else { const {companies}=await assembleContacts(); members=flattenMembers(applyRules(companies,a.rules||{})); }
  const opt=new Set((await sbGet("email_optout?select=email").catch(()=>[])).map(o=>String(o.email||"").toLowerCase()));
  const send=[]; let valid=0,unsub=0,invalid=0; const cos=new Set();
  for(const m of members){ const em=String(m.contact_email||"").trim(); const lo=em.toLowerCase(); cos.add(m.dealer_id);
    if(!EMAIL_RE.test(em)){invalid++;continue;} if(opt.has(lo)){unsub++;continue;} valid++; send.push({dealer_id:m.dealer_id,company:m.company||"",name:m.contact_name||"",email:em}); }
  return {audience:a, breakdown:{companies:cos.size,contacts:members.length,valid,unsubscribed:unsub,invalid,send:send.length}, send};
}
module.exports={assembleContacts,applyRules,flattenMembers,resolveById};

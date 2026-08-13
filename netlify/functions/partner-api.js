// HCPS Dealer-Services partner reporting API (CardChamp and future non-manufacturer lines).
// Staff-authenticated (president or rep). Supabase service-role for DB. No npm deps.
//
//   POST {action:"report", service?}                         -> KPIs, interested dealers, referral ledger
//   POST {action:"log_referral", service?, dealer_id?, dealer_name?, status?, monthly_volume?,
//                                revenue?, commission?, period?, applied_at?, activated_at?, note?}  -> {referral}
//   POST {action:"update_referral", id, ...fields}           -> {referral}
//   POST {action:"void_referral", id}                        -> {ok}
//   POST {action:"import_referrals", service?, rows:[...]}    -> {imported, matched, unmatched:[names]}
//   All require a staff Bearer token.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const json = (c,o)=>({statusCode:c,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(o)});
const H = ()=>({apikey:SERVICE_ROLE,Authorization:`Bearer ${SERVICE_ROLE}`});
async function sbGet(path){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{headers:H()}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r.json(); }
async function sbSend(method,path,body,extra){ const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{method,headers:{...H(),"content-type":"application/json",...(extra||{})},body:body!=null?JSON.stringify(body):undefined}); if(!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); const t=await r.text(); return t?JSON.parse(t):null; }
async function sbGetAll(base, orderCol="id"){ const PAGE=1000; let from=0,out=[]; for(;;){ const sep=base.includes("?")?"&":"?"; const rows=await sbGet(`${base}${sep}order=${orderCol}&limit=${PAGE}&offset=${from}`); out=out.concat(rows); if(rows.length<PAGE) break; from+=PAGE; } return out; }
const clean=(v,n)=>{ const s=(v==null?"":String(v)).trim(); return s?s.slice(0,n||400):null; };
const num=v=>{ if(v==null||v==="") return null; const n=Number(String(v).replace(/[$,\s]/g,"")); return Number.isFinite(n)?n:null; };
const SUF=/\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm=n=>String(n||"").toUpperCase().replace(/HEALTH ?CARE/g,"HEALTHCARE").replace(/[.,'&/#-]/g," ").replace(SUF," ").replace(/\s+/g," ").trim();
const STATUSES=["referred","applied","approved","active","declined","churned","void"];

// dealer_id -> business_name for a set of ids (chunked to keep URLs short).
async function namesFor(ids){ const out={}; const u=[...new Set(ids.filter(Boolean))]; for(let i=0;i<u.length;i+=150){ const part=u.slice(i,i+150).map(encodeURIComponent).join(","); try{ const ds=await sbGet(`dealers?id=in.(${part})&select=id,business_name`); for(const d of ds) out[d.id]=d.business_name; }catch(e){} } return out; }

async function whoami(event){
  const auth=event.headers["authorization"]||event.headers["Authorization"]||"";
  const tok=auth.replace(/^Bearer\s+/i,"").trim();
  if(tok){
    try{ const r=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_ROLE,Authorization:`Bearer ${tok}`}});
      if(r.ok){ const u=await r.json(); const email=u&&u.email&&String(u.email).toLowerCase();
        if(email){ const s=await sbGet(`staff_users?email=eq.${encodeURIComponent(email)}&select=*`).catch(()=>[]); const su=s&&s[0];
          if(su&&su.active!==false) return {role:su.role||"rep",name:su.name||email,email}; } } }catch(e){}
    return null;
  }
  const need=process.env.ANALYTICS_TOKEN, got=event.headers["x-analytics-token"]||"";
  if(need && got===need) return {role:"president",name:"Admin",email:""};
  return null;
}

exports.handler = async (event)=>{
  try{
    if(!SUPABASE_URL||!SERVICE_ROLE) return json(500,{error:"Supabase env vars not set"});
    if(event.httpMethod!=="POST") return json(405,{error:"POST only"});
    const me=await whoami(event);
    if(!me) return json(401,{error:"unauthorized"});
    let b; try{ b=JSON.parse(event.body||"{}"); }catch{ return json(400,{error:"bad JSON"}); }
    const service=clean(b.service,40)||"cardchamp";

    // Tables present? (friendly message if the migration hasn't run yet.)
    try{ await sbGet("partner_referrals?select=id&limit=1"); }
    catch(e){ return json(200,{ok:false,error:"tables_missing",message:"Run supabase/partner_services.sql in Supabase, then reload."}); }

    // ---- REPORT ------------------------------------------------------------
    if(b.action==="report"){
      const svc=encodeURIComponent(service);
      const [acts,refs]=await Promise.all([
        sbGetAll(`partner_activity?service=eq.${svc}&select=dealer_id,event_type,source,surface,occurred_at`,"occurred_at").catch(()=>[]),
        sbGetAll(`partner_referrals?service=eq.${svc}&select=*`,"created_at").catch(()=>[]),
      ]);
      const ids=[...new Set([...acts.map(a=>a.dealer_id),...refs.map(r=>r.dealer_id)].filter(Boolean))];
      const names=await namesFor(ids);
      const now=Date.now(), d30=now-30*864e5;
      // clicks per dealer
      const byDealer=new Map();
      for(const a of acts){ if(!a.dealer_id) continue; const o=byDealer.get(a.dealer_id)||{dealer_id:a.dealer_id,name:names[a.dealer_id]||"(unknown dealer)",clicks:0,last:null,surfaces:new Set()};
        o.clicks++; const t=new Date(a.occurred_at).getTime(); if(o.last==null||t>o.last)o.last=t; if(a.surface)o.surfaces.add(a.surface); byDealer.set(a.dealer_id,o); }
      const refByDealer=new Set(refs.filter(r=>r.dealer_id&&r.status!=="void").map(r=>r.dealer_id));
      const interested=[...byDealer.values()].map(o=>({dealer_id:o.dealer_id,name:o.name,clicks:o.clicks,
        last_click:o.last?new Date(o.last).toISOString():null, surfaces:[...o.surfaces], has_referral:refByDealer.has(o.dealer_id)}))
        .sort((a,b)=>(b.last_click||"").localeCompare(a.last_click||"")||b.clicks-a.clicks);
      const clicks_total=acts.length, clicks_30d=acts.filter(a=>new Date(a.occurred_at).getTime()>=d30).length;
      // referrals ledger (skip void from headline sums)
      const live=refs.filter(r=>r.status!=="void");
      const thisPeriod=new Date().toISOString().slice(0,7);
      const referrals=refs.map(r=>({...r, dealer_name:r.dealer_name||names[r.dealer_id]||"(unknown)"}))
        .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
      const byStatus={}; for(const s of STATUSES) byStatus[s]=0; for(const r of refs){ byStatus[r.status]=(byStatus[r.status]||0)+1; }
      const sum=(arr,k)=>Math.round(arr.reduce((s,x)=>s+(Number(x[k])||0),0)*100)/100;
      const kpis={
        clicks_total, clicks_30d,
        interested_dealers: interested.length,
        referrals_total: live.length,
        active: live.filter(r=>r.status==="active").length,
        commission_total: sum(live,"commission"),
        commission_period: sum(live.filter(r=>r.period===thisPeriod),"commission"),
        revenue_total: sum(live,"revenue"),
        conversion_rate: interested.length? Math.round((refByDealer.size/interested.length)*100):0,
      };
      return json(200,{ok:true, service, kpis, interested, referrals, by_status:byStatus, statuses:STATUSES, this_period:thisPeriod });
    }

    // ---- LOG a referral / conversion (manual entry) ------------------------
    if(b.action==="log_referral"){
      let dealer_name=clean(b.dealer_name,180);
      if(b.dealer_id && !dealer_name){ const n=await namesFor([b.dealer_id]); dealer_name=n[b.dealer_id]||null; }
      const status=STATUSES.includes(b.status)?b.status:"referred";
      const row={ service, dealer_id:b.dealer_id||null, dealer_name,
        status, monthly_volume:num(b.monthly_volume), revenue:num(b.revenue), commission:num(b.commission),
        period:clean(b.period,7), applied_at:clean(b.applied_at,10), activated_at:clean(b.activated_at,10),
        source:"manual", note:clean(b.note,1000), created_by:me.name||me.email||"admin" };
      const ins=await sbSend("POST","partner_referrals",row,{Prefer:"return=representation"});
      return json(200,{ok:true, referral:(ins&&ins[0])||row});
    }

    // ---- UPDATE a referral -------------------------------------------------
    if(b.action==="update_referral"){
      if(!b.id) return json(400,{error:"id required"});
      const patch={ updated_at:new Date().toISOString() };
      if(b.status!==undefined) patch.status=STATUSES.includes(b.status)?b.status:"referred";
      if(b.monthly_volume!==undefined) patch.monthly_volume=num(b.monthly_volume);
      if(b.revenue!==undefined) patch.revenue=num(b.revenue);
      if(b.commission!==undefined) patch.commission=num(b.commission);
      if(b.period!==undefined) patch.period=clean(b.period,7);
      if(b.applied_at!==undefined) patch.applied_at=clean(b.applied_at,10);
      if(b.activated_at!==undefined) patch.activated_at=clean(b.activated_at,10);
      if(b.note!==undefined) patch.note=clean(b.note,1000);
      const up=await sbSend("PATCH",`partner_referrals?id=eq.${encodeURIComponent(b.id)}`,patch,{Prefer:"return=representation"});
      return json(200,{ok:true, referral:(up&&up[0])||null});
    }

    // ---- VOID a referral (soft-remove; never hard-deletes) -----------------
    if(b.action==="void_referral"){
      if(!b.id) return json(400,{error:"id required"});
      await sbSend("PATCH",`partner_referrals?id=eq.${encodeURIComponent(b.id)}`,{status:"void",updated_at:new Date().toISOString()},{Prefer:"return=minimal"});
      return json(200,{ok:true});
    }

    // ---- IMPORT a CardChamp report (ready for when reports arrive) ----------
    // rows: [{dealer_name, status?, monthly_volume?, revenue?, commission?, period?, external_ref?, applied_at?, activated_at?, note?}]
    if(b.action==="import_referrals"){
      const rows=Array.isArray(b.rows)?b.rows:[];
      if(!rows.length) return json(200,{ok:true, imported:0, matched:0, unmatched:[]});
      const [dealers,aliases]=await Promise.all([
        sbGetAll("dealers?select=id,business_name","id").catch(()=>[]),
        sbGetAll("dealer_aliases?select=alias_norm,dealer_id","alias_norm").catch(()=>[]),
      ]);
      const norm2id=new Map(); for(const d of dealers) norm2id.set(dnorm(d.business_name), d.id);
      for(const a of aliases){ if(a&&a.alias_norm&&!norm2id.has(a.alias_norm)) norm2id.set(a.alias_norm, a.dealer_id); }
      const upserts=[], inserts=[], unmatched=[]; let matched=0;
      for(const r of rows){
        const nm=clean(r.dealer_name||r.name||r.company,180); if(!nm) continue;
        const did=norm2id.get(dnorm(nm))||null; if(did) matched++; else if(unmatched.length<200) unmatched.push(nm);
        const rec={ service, dealer_id:did, dealer_name:nm,
          status:STATUSES.includes(r.status)?r.status:"active",
          monthly_volume:num(r.monthly_volume), revenue:num(r.revenue), commission:num(r.commission),
          period:clean(r.period,7), applied_at:clean(r.applied_at,10), activated_at:clean(r.activated_at,10),
          source:"import", external_ref:clean(r.external_ref,120), note:clean(r.note,1000),
          created_by:me.name||"import", updated_at:new Date().toISOString() };
        if(rec.external_ref) upserts.push(rec); else inserts.push(rec);
      }
      if(upserts.length) for(let i=0;i<upserts.length;i+=500) await sbSend("POST","partner_referrals?on_conflict=service,external_ref",upserts.slice(i,i+500),{Prefer:"resolution=merge-duplicates,return=minimal"});
      if(inserts.length) for(let i=0;i<inserts.length;i+=500) await sbSend("POST","partner_referrals",inserts.slice(i,i+500),{Prefer:"return=minimal"});
      return json(200,{ok:true, imported:upserts.length+inserts.length, matched, unmatched});
    }

    return json(400,{error:"unknown action"});
  }catch(e){ return json(500,{error:String(e&&e.message||e)}); }
};

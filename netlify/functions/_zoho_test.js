// Phase 2F-2 — TEST isolation: the ONE rule every Zoho push path uses. SERVER-SIDE ONLY.
//
//   A dealer with is_test = true, and everything attached to it — its own email, its contacts, its
//   deals, tasks, notes, appointments, sales rows and campaign recipients — is never sent to Zoho.
//
// load() reads the TEST dealers once per run/request. It THROWS when it can't read them: a caller
// that can't tell TEST from real must push nothing (fail closed) and record why.
// Matching is by dealer id; records that only carry a company name (master-list imports, a booking
// not yet tied to a dealer) are matched by the normalized name, and import rows also by a TEST
// dealer's known email. Existing Zoho TEST records are left alone here (cleanup is a separate step).
const SUF = /\b(inc|incorporated|llc|corp|corporation|co|company|ltd|lp|pllc|plc|dba|the)\b/gi;
const dnorm = n => String(n || "").toUpperCase().replace(/HEALTH ?CARE/g, "HEALTHCARE").replace(/[.,'&/#-]/g, " ").replace(SUF, " ").replace(/\s+/g, " ").trim();
const lo = e => String(e || "").trim().toLowerCase();
// Names compare on letters and digits only, so "TEST — Golden Sandbox" and "Test - Golden Sandbox, Inc." match.
const nkey = n => dnorm(n).replace(/[^A-Z0-9]+/g, " ").trim();

async function load(sbGet){
  const rows = await sbGet("dealers?is_test=eq.true&select=id,business_name,email");
  const ids = new Set(), names = new Set(), emails = new Set();
  for(const d of (rows || [])){
    ids.add(String(d.id));
    if(nkey(d.business_name)) names.add(nkey(d.business_name));
    if(lo(d.email)) emails.add(lo(d.email));
  }
  if(ids.size){
    const list = [...ids];
    for(let i = 0; i < list.length; i += 100){
      const cs = await sbGet(`dealer_contacts?dealer_id=in.(${list.slice(i, i + 100).map(encodeURIComponent).join(",")})&select=email`);
      for(const c of (cs || [])) if(lo(c.email)) emails.add(lo(c.email));
    }
  }
  return {
    count: ids.size,
    dealer(id){ return id != null && ids.has(String(id)); },          // attached to a TEST dealer
    name(n){ const k = nkey(n); return !!k && names.has(k); },         // a company name that IS a TEST dealer
    email(e){ return !!lo(e) && emails.has(lo(e)); },                   // a TEST dealer's own or contact email
  };
}

module.exports = { load, dnorm, nkey };

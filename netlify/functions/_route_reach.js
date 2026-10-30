// HCPS Scheduled Routes — WHEN A ROUTE EXTENDS A REP'S DEALER ACCESS (security fix, Angelo 2026-10-30).
//
// A rep works the dealers in his book (_scope.js). A route reaches further ONLY when the President
// sent him on it: the route is assigned to him, somebody else holds it (he did not build it for
// himself), and whoever assigned it — `assigned_by`, else the route's owner for routes saved before
// assigned_by was recorded — is an ACTIVE President in staff_users. That is the President-planned
// route and the explicitly authorized ride-along. A route a rep builds for himself never extends his
// access: adding another rep's dealer to it opens nothing (and save_route refuses the addition).
//
// After a reassignment the rep keeps ONE narrow right: to finish and follow up the visit he
// personally performed (`visitGrant`) — that visit report only, its dealer only, and email only to
// that dealer's own addresses (`allowedRecipients`). Never the dealer's other records.
//
// Every read here is strict: a failed read THROWS, and callers refuse (503) rather than guess.
const low = s => String(s == null ? "" : s).trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const enc = encodeURIComponent;

// The person who handed the route over: assigned_by when it names an email, else the owner.
function assignerOf(r){
  const a = low(r && r.assigned_by);
  return EMAIL.test(a) ? a : low(r && r.owner_email);
}
// Shape-only part of the rule (no database): assigned to me, held by someone else.
function candidate(r, myEmail){
  const me = low(myEmail);
  return !!(me && r && low(r.assigned_to_email) === me && low(r.owner_email) !== me && EMAIL.test(assignerOf(r)));
}
// Active Presidents among these emails.
async function presidents(sbGet, emails){
  const list = [...new Set((emails || []).map(low).filter(e => EMAIL.test(e)))];
  if(!list.length) return new Set();
  const rows = await sbGet(`staff_users?email=in.(${list.map(enc).join(",")})&select=email,role,active`);
  return new Set((rows || []).filter(u => low(u.role) === "president" && u.active !== false).map(u => low(u.email)));
}
// The routes (from `routes`) that extend this person's access.
async function authorizedRoutes(myEmail, routes, sbGet){
  const cand = (routes || []).filter(r => candidate(r, myEmail));
  if(!cand.length) return [];
  const P = await presidents(sbGet, cand.map(assignerOf));
  return cand.filter(r => P.has(assignerOf(r)));
}
async function authorizedRoute(myEmail, route, sbGet){ return !!route && !route.archived_at && (await authorizedRoutes(myEmail, [route], sbGet)).length === 1; }
// Dealer ids reachable through authorized routes (the stops of every route assigned to me by the President).
async function reachDealerIds(myEmail, sbGet){
  const me = low(myEmail); if(!me) return new Set();
  // select=* so an archived route can be left out whether or not archived_at exists yet (review L1).
  const rs = await sbGet(`rep_routes?assigned_to_email=eq.${enc(me)}&select=*&limit=1000`);
  const ok = await authorizedRoutes(me, (rs || []).filter(r => !r.archived_at), sbGet);
  const out = new Set();
  for(const r of ok) for(const st of (Array.isArray(r.stops) ? r.stops : [])) if(st && st.dealer_id) out.add(String(st.dealer_id));
  return out;
}
const STARTED = "or=(checkin_at.not.is.null,ended_at.not.is.null,completed_at.not.is.null)";
/* The visit this rep personally performed at this dealer: the report named by reportId, or the one on
   routeId's stop. It must name the dealer and the rep and have actually started. null = no grant. */
async function visitGrant(myEmail, dealerId, ref, sbGet){
  const me = low(myEmail), did = String(dealerId || "").trim();
  const rid = String((ref && ref.report_id) || "").trim(), route = String((ref && ref.route_id) || "").trim();
  if(!me || !did || (!rid && !route)) return null;
  const where = rid ? `id=eq.${enc(rid)}` : `route_id=eq.${enc(route)}`;
  const rows = await sbGet(`dealer_visit_reports?${where}&dealer_id=eq.${enc(did)}&rep_email=eq.${enc(me)}&${STARTED}&select=id,route_id,dealer_id,rep_email&limit=1`);
  return (rows && rows[0]) || null;
}
/* Where an email may go outside the rep's book. On a President-sent route: the dealer's own email and
   its contacts. When his only right is his visit (reportId): the dealer's own email and the people
   recorded at THAT visit — not the dealer's whole contact list (review L2). */
async function allowedRecipients(dealerId, reportId, sbGet){
  const did = String(dealerId || "").trim(), out = new Set();
  const [d, c, p] = await Promise.all([
    sbGet(`dealers?id=eq.${enc(did)}&select=email&limit=1`),
    reportId ? Promise.resolve([]) : sbGet(`dealer_contacts?dealer_id=eq.${enc(did)}&select=email`),
    reportId ? sbGet(`dealer_visit_participants?visit_report_id=eq.${enc(String(reportId))}&dealer_id=eq.${enc(did)}&select=email_snapshot`) : Promise.resolve([]),
  ]);
  for(const x of (d || [])) if(EMAIL.test(low(x.email))) out.add(low(x.email));
  for(const x of (c || [])) if(EMAIL.test(low(x.email))) out.add(low(x.email));
  for(const x of (p || [])) if(EMAIL.test(low(x.email_snapshot))) out.add(low(x.email_snapshot));
  return out;
}
module.exports = { assignerOf, candidate, presidents, authorizedRoutes, authorizedRoute, reachDealerIds, visitGrant, allowedRecipients };

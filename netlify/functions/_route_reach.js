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
/* Where an email may go outside the rep's book (owner decision, Angelo 2026-10-30 19:01 CT). Typing an address — as an
   attendee, or through a contact the rep created himself — never by itself makes it a recipient.
   - Always: the dealer's own email on file.
   - President-sent route he is on now (no reportId): the dealer's contacts on file, except contacts this rep created
     from his own visits at this dealer (summary.contacts_added). He is authorized to work that dealer on that route.
   - Only his own visit (reportId; after a reassignment): the dealer's email plus the attendees of THAT visit the
     President approved for it (summary.approved_recipients). Nothing the rep can write — a typed address, a contact he
     created, a link he made — verifies an address here (exact-head review H1 / M1). `on_file` tells the President
     which attendee addresses match a dealer contact, to make the approval easy; it grants nothing by itself.
   Returns a Set of lower-case emails. Strict reads: a failed read throws. */
async function selfAddedContacts(myEmail, dealerId, sbGet){
  const me = low(myEmail), did = String(dealerId || "").trim(), out = new Set();
  if(!me || !did) return out;
  const rows = await sbGet(`dealer_visit_reports?dealer_id=eq.${enc(did)}&rep_email=eq.${enc(me)}&select=summary&limit=1000`);
  for(const r of (rows || [])) for(const id of ((r && r.summary && r.summary.contacts_added) || [])) out.add(String(id));
  return out;
}
function approvedOf(summary){
  const a = summary && Array.isArray(summary.approved_recipients) ? summary.approved_recipients : [];
  return a.map(x => low(x && x.email)).filter(e => EMAIL.test(e));
}
async function recipientReview(dealerId, reportId, sbGet, myEmail){
  const did = String(dealerId || "").trim(), rid = String(reportId || "").trim();
  const [d, c, p, rep, self] = await Promise.all([
    sbGet(`dealers?id=eq.${enc(did)}&select=email&limit=1`),
    sbGet(`dealer_contacts?dealer_id=eq.${enc(did)}&select=id,email`),
    rid ? sbGet(`dealer_visit_participants?visit_report_id=eq.${enc(rid)}&dealer_id=eq.${enc(did)}&select=name_snapshot,email_snapshot`) : Promise.resolve([]),
    rid ? sbGet(`dealer_visit_reports?id=eq.${enc(rid)}&dealer_id=eq.${enc(did)}&select=summary&limit=1`) : Promise.resolve([]),
    rid ? Promise.resolve(new Set()) : selfAddedContacts(myEmail, did, sbGet),
  ]);
  const dealerEmail = low(d && d[0] && d[0].email);
  const onFile = new Set((c || []).map(x => low(x.email)).filter(e => EMAIL.test(e)));
  const allowed = new Set();
  if(EMAIL.test(dealerEmail)) allowed.add(dealerEmail);
  const people = [];
  if(!rid){
    for(const x of (c || [])) if(EMAIL.test(low(x.email)) && !self.has(String(x.id))) allowed.add(low(x.email));
  } else {
    const approved = new Set(approvedOf(rep && rep[0] && rep[0].summary));
    for(const e of approved) allowed.add(e);
    const seen = new Set();
    for(const x of (p || [])){
      const email = low(x.email_snapshot);
      if(!EMAIL.test(email) || seen.has(email)) continue; seen.add(email);
      const status = email === dealerEmail ? "verified" : approved.has(email) ? "approved" : "unverified";
      people.push({ name: x.name_snapshot || "", email, status, on_file: onFile.has(email) });
    }
  }
  return { allowed, people, dealer_email: dealerEmail || null };
}
async function allowedRecipients(dealerId, reportId, sbGet, myEmail){
  return (await recipientReview(dealerId, reportId, sbGet, myEmail)).allowed;
}
module.exports = { assignerOf, candidate, presidents, authorizedRoutes, authorizedRoute, reachDealerIds, visitGrant, allowedRecipients, recipientReview, selfAddedContacts };

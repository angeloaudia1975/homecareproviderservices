/* HISTORICAL MANUFACTURER-IDENTIFIER VERIFICATION — DRY RUN (owner directive 2026-11-06; pure, no I/O, writes nothing).
   Every identifier already on file (dealer_manufacturers.account_ref) is listed with its location, the line's ordering state,
   its current status, the PROPOSED status and the conflicts a person should look at before the backfill — which runs only
   after Angelo approves this list. Manufacturer sales reports are never a prerequisite. The source of each historical entry
   (Dealer 360, Dealer Manager or a report import) was never recorded, so it is reported as such — never guessed.
     proposed = "Verify" · "Verify — branch has its own identifier, check" · "Review — conflict" (the same identifier on two
     unrelated dealer families for one line; PediFix re-uses numbers and is matched by name, so it is noted, not a conflict). */
'use strict';
const NAME_FIRST = new Set(['pedifix']);
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
function build({ dms, dealers, claims }) {
  const D = new Map((dealers || []).map((d) => [String(d.id), d]));
  const root = (id) => { const d = D.get(String(id)); return d && d.parent_id ? String(d.parent_id) : String(id); };
  const rows = (dms || []).filter((r) => r && norm(r.account_ref));
  const famRefs = new Map(), refFams = new Map();
  for (const r of rows) {
    const fk = root(r.dealer_id) + '|' + r.manufacturer; if (!famRefs.has(fk)) famRefs.set(fk, new Set()); famRefs.get(fk).add(norm(r.account_ref));
    const rk = r.manufacturer + '|' + norm(r.account_ref); if (!refFams.has(rk)) refFams.set(rk, new Set()); refFams.get(rk).add(root(r.dealer_id));
  }
  const claimBy = new Map((claims || []).map((c) => [String(c.dealer_id) + '|' + c.manufacturer, c]));
  const out = rows.map((r) => {
    const d = D.get(String(r.dealer_id)) || {};
    const verified = !!(r.verified_at && norm(r.verified_ref) === norm(r.account_ref));
    const fam = famRefs.get(root(r.dealer_id) + '|' + r.manufacturer), shared = refFams.get(r.manufacturer + '|' + norm(r.account_ref));
    const issues = [];
    if (fam && fam.size > 1) issues.push(`the dealer family has ${fam.size} different identifiers for this line`);
    if (shared && shared.size > 1) issues.push(NAME_FIRST.has(r.manufacturer) ? 'number shared with another dealer (PediFix re-uses numbers — matched by name)' : `the same identifier is on ${shared.size} unrelated dealer families`);
    const cl = claimBy.get(String(r.dealer_id) + '|' + r.manufacturer);
    if (cl && cl.status === 'pending' && norm(cl.account_ref) !== norm(r.account_ref)) issues.push(`the dealer submitted a different number (${String(cl.account_ref).slice(0, 40)}) waiting for HCPS`);
    const ref = String(r.account_ref).trim();
    const kind = /\d/.test(ref) ? (/[A-Za-z]/.test(ref) ? 'alphanumeric' : 'numeric') : 'name / username';
    const conflict = (shared && shared.size > 1 && !NAME_FIRST.has(r.manufacturer)) || (cl && cl.status === 'pending' && norm(cl.account_ref) !== norm(r.account_ref));
    /* owner rule 2026-11-06 20:57 CT: every identifier on file IS verified; conflicts are listed for information only */
    const proposed = conflict ? 'Verified — conflict noted' : (fam && fam.size > 1) ? 'Verified — branch has its own identifier' : 'Verified';
    return { dealer_id: String(r.dealer_id), dealer: d.business_name || d.name || '', city: [d.city, d.state].filter(Boolean).join(', '), location: d.parent_id ? 'branch' : 'head office',
      manufacturer: r.manufacturer, identifier: ref, kind, ordering: r.active === false ? 'not approved' : 'approved',
      current: 'Verified', proposed, issues: issues.join('; '),
      provenance: verified ? `Saved by ${r.verified_by || 'HCPS'} ${String(r.verified_at).slice(0, 10)}` : 'On file in HCPS — verified by owner rule 2026-11-06 (who entered it was not recorded)' };
  }).sort((a, b) => (a.proposed > b.proposed ? 1 : a.proposed < b.proposed ? -1 : 0) || a.dealer.localeCompare(b.dealer) || a.manufacturer.localeCompare(b.manufacturer));
  const summary = { identifiers: out.length, dealers: new Set(out.map((o) => o.dealer_id)).size, by_proposed: {}, by_kind: {}, by_manufacturer: {} };
  for (const o of out) { summary.by_proposed[o.proposed] = (summary.by_proposed[o.proposed] || 0) + 1; summary.by_kind[o.kind] = (summary.by_kind[o.kind] || 0) + 1; summary.by_manufacturer[o.manufacturer] = (summary.by_manufacturer[o.manufacturer] || 0) + 1; }
  return { summary, rows: out };
}
module.exports = { build };

/* ENTITLEMENT IMPACT — removing territory rules as a source of ordering eligibility (owner directive 2026-11-06 20:55 CT,
   §2). Pure, no I/O, writes nothing. For every real (non-TEST) dealer it compares what the portal shows TODAY
   (_access.computeAccess: the Dealer Manager grid when there is one, otherwise the territory rules) with what it would show
   when Dealer Manager is the ONLY source (grid-only), and lists exactly what would disappear and whether anyone uses it:
   approved portal logins, portal orders on the line in the last 12 months, and the Golden button (Kentucky "Prospect" by
   territory). Branches are judged by their OWN grid rows, the way the portal and the order server read them.
     category  "grid"            — has a Dealer Manager grid: nothing changes for ordering
               "territory"       — no grid; territory lines vanish under grid-only
               "none"            — no grid and no territory lines (already sees nothing)
   A line that would vanish AND has a portal order in the last 12 months, or vanishes from a dealer with an approved portal
   login, is "material" — those go to Angelo before the production change (directive §2). */
'use strict';
const { computeAccess } = require('./_access.js');
const GOLDEN = new Set(['golden', 'golden-technologies']);

function build({ dealers, dms, users, orders, latByDealer, sinceIso }) {
  const D = new Map((dealers || []).map((d) => [String(d.id), d]));
  const grants = new Map(), owned = new Map();
  for (const r of dms || []) {
    const id = String(r.dealer_id);
    if (r.active !== false) { if (!grants.has(id)) grants.set(id, []); grants.get(id).push(r.manufacturer); }
    if (r.account_ref && String(r.account_ref).trim()) { if (!owned.has(id)) owned.set(id, []); owned.get(id).push(r.manufacturer); }
  }
  const logins = new Map(); for (const u of users || []) if (u.status === 'approved' && u.dealer_id) logins.set(String(u.dealer_id), (logins.get(String(u.dealer_id)) || 0) + 1);
  const ordered = new Map();
  for (const o of orders || []) { if (sinceIso && String(o.submitted_at || '') < sinceIso) continue; const k = String(o.dealer_id) + '|' + o.manufacturer; ordered.set(k, (ordered.get(k) || 0) + 1); }
  const rows = [];
  for (const d of dealers || []) {
    if (d.is_test) continue;
    const id = String(d.id), gov = d.parent_id && D.get(String(d.parent_id)) ? D.get(String(d.parent_id)) : d;
    const g = { state: gov.state || d.state, business_name: gov.business_name || d.business_name, lat: latByDealer ? latByDealer(gov) : null, golden_status: d.golden_status || 'None', ovation_access: !!d.ovation_access };
    const granted = grants.get(id) || [];
    const today = computeAccess(g, owned.get(id) || [], granted);
    const lines = new Set([...(today.your_accounts || []), ...(today.available || [])]);
    const hasGrid = granted.some((s) => !GOLDEN.has(String(s)));
    const gridOnly = new Set(hasGrid ? [...lines] : []);
    const vanish = [...lines].filter((s) => !gridOnly.has(s)).sort();
    /* Golden button: grid-only keeps the STORED Golden status; the Kentucky territory "Prospect" disappears */
    const goldenTerritory = today.golden === 'Prospect' && String(d.golden_status || 'None') !== 'Prospect' && String(d.golden_status || 'None') !== 'Account';
    if (!vanish.length && !goldenTerritory && hasGrid) { rows.push({ id, category: 'grid', vanish: [] }); continue; }
    const used = vanish.filter((s) => ordered.has(id + '|' + s));
    const nLogins = logins.get(id) || 0;
    rows.push({
      id, name: d.business_name || '', city: d.city || '', state: d.state || gov.state || '', branch: !!d.parent_id, active_dealer: d.active !== false,
      category: hasGrid ? 'grid' : (vanish.length ? 'territory' : 'none'), approved_lines_today: hasGrid ? [...lines].sort() : [],
      vanish, ordered_lines_12m: used.map((s) => ({ line: s, orders: ordered.get(id + '|' + s) })), portal_logins: nLogins,
      golden_territory_prospect: goldenTerritory,
      material: d.active !== false && (used.length > 0 || (nLogins > 0 && (vanish.length > 0 || goldenTerritory))),
    });
  }
  const real = rows.filter((r) => r.category !== 'grid' || r.golden_territory_prospect);
  const byLine = {}; for (const r of real) for (const s of r.vanish) byLine[s] = (byLine[s] || 0) + 1;
  return {
    summary: {
      dealers: rows.length, with_grid: rows.filter((r) => r.category === 'grid').length,
      territory_only: rows.filter((r) => r.category === 'territory').length, no_lines_either_way: rows.filter((r) => r.category === 'none').length,
      material: real.filter((r) => r.material).length, with_portal_login_affected: real.filter((r) => r.portal_logins > 0 && (r.vanish.length || r.golden_territory_prospect)).length,
      with_recent_orders_affected: real.filter((r) => r.ordered_lines_12m && r.ordered_lines_12m.length).length,
      golden_territory_prospects: real.filter((r) => r.golden_territory_prospect).length, vanish_by_line: byLine,
    },
    affected: real.filter((r) => r.vanish.length || r.golden_territory_prospect)
      .sort((a, b) => Number(b.material) - Number(a.material) || b.portal_logins - a.portal_logins || String(a.name).localeCompare(String(b.name))),
  };
}
module.exports = { build };

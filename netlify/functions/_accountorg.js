// ============================================================================
// Organization-level manufacturer account numbers.
//
// A manufacturer account number belongs to the PARENT dealer organization, not
// to one branch. When a number is assigned to any location (by hand or by a
// commission import), it fills the whole dealer family (parent + branches) for
// that manufacturer — but ONLY where a branch has no number yet. A branch that
// already holds its own distinct number (e.g. a "Med Mart KY" with a different
// Access4U account) keeps it, and updates only when a report/edit gives THAT
// branch a new number.
//
// Rule, precisely:
//   1. The assigned dealer gets the number outright (explicit branch value).
//   2. Every family member with a BLANK number inherits the org's primary
//      number (the family root's number if set, otherwise the number just
//      assigned). Non-blank members are never overwritten.
//
// This is a factory over a caller's own service-role PostgREST helpers so it can
// be shared by crm-api, commissions-api, and dealers-api unchanged.
// ============================================================================
module.exports = function (sbGet, sbSend) {
  // Resolve a dealer's family: the root (parent org) id and every member id.
  async function family(dealerId) {
    const self = await sbGet(
      `dealers?id=eq.${encodeURIComponent(dealerId)}&select=id,parent_id`
    ).catch(() => []);
    if (!self || !self[0]) return { root: dealerId, ids: [dealerId] };
    const root = self[0].parent_id || self[0].id;
    const fam = await sbGet(
      `dealers?or=(id.eq.${encodeURIComponent(root)},parent_id.eq.${encodeURIComponent(root)})&select=id`
    ).catch(() => []);
    const ids = fam && fam.length ? fam.map((d) => d.id) : [dealerId];
    return { root, ids };
  }

  // Assign `ref` to `dealerId` for `slug`, then fill blanks across the family.
  async function propagateAccountRef(slug, dealerId, ref) {
    slug = String(slug || "").trim();
    ref = String(ref == null ? "" : ref).trim();
    if (!slug || !dealerId) return;
    // 1) Set on the dealer itself (explicit — may differ from the org number).
    await sbSend(
      "POST",
      "dealer_manufacturers?on_conflict=dealer_id,manufacturer",
      { dealer_id: dealerId, manufacturer: slug, account_ref: ref || null, active: true },
      { Prefer: "resolution=merge-duplicates,return=minimal" }
    ).catch(() => {});
    if (!ref) return;
    // 2) Fill blanks across the family with the org primary.
    const { root, ids } = await family(dealerId);
    if (ids.length <= 1) return;
    const inlist = ids.map(encodeURIComponent).join(",");
    const cur = await sbGet(
      `dealer_manufacturers?manufacturer=eq.${encodeURIComponent(slug)}&dealer_id=in.(${inlist})&select=dealer_id,account_ref`
    ).catch(() => []);
    const byId = {};
    for (const r of cur || []) byId[r.dealer_id] = String(r.account_ref || "").trim();
    const orgPrimary = byId[root] || ref; // prefer the parent org's number
    const fill = [];
    for (const id of ids) {
      if (!byId[id]) fill.push({ dealer_id: id, manufacturer: slug, account_ref: orgPrimary, active: true });
    }
    if (fill.length)
      await sbSend(
        "POST",
        "dealer_manufacturers?on_conflict=dealer_id,manufacturer",
        fill,
        { Prefer: "resolution=merge-duplicates,return=minimal" }
      ).catch(() => {});
  }

  return { family, propagateAccountRef };
};

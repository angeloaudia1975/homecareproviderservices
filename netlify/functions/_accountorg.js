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


  // A Dealer Manager grid save may grant a NEW manufacturer line with an existing
  // HQ account number. Fill branch BLANKS only; never change an independently assigned
  // branch number, and never re-enable an intentionally disabled branch line.
  // Conditional PATCH / insert-ignore protect against concurrent branch edits.
  async function fillHeadquartersBlanks(dealerId, selectedSlugs) {
    const rows = await sbGet('dealers?id=eq.'+enc(dealerId)+'&select=id,parent_id');
    if (!rows || !rows[0]) throw new Error("Dealer missing while syncing HQ accounts");
    if (rows[0].parent_id) return {filled:0,branches:0,reason:"branch"};
    const children = await sbGet('dealers?parent_id=eq.'+enc(dealerId)+'&select=id');
    if (!children || !children.length) return {filled:0,branches:0};
    const permitted = new Set((selectedSlugs||[]).map(String));
    if (!permitted.size) return {filled:0,branches:children.length};
    const hq = await sbGet('dealer_manufacturers?dealer_id=eq.'+enc(dealerId)+'&select=manufacturer,account_ref,active');
    const toInherit=(hq||[]).filter(r=>permitted.has(String(r.manufacturer)) && r.active!==false && String(r.account_ref||"").trim());
    if (!toInherit.length) return {filled:0,branches:children.length};
    const childIds=children.map(c=>String(c.id));
    const childRows=await sbGet('dealer_manufacturers?dealer_id=in.('+childIds.map(enc).join(',')+')&select=dealer_id,manufacturer,account_ref,active');
    const byKey=new Map((childRows||[]).map(r=>[String(r.dealer_id)+'|'+String(r.manufacturer),r]));
    let filled=0,preserved=0,concurrent=0;
    for(const h of toInherit){
      const ref=String(h.account_ref).trim(),slug=String(h.manufacturer);
      for(const id of childIds){
        const prior=byKey.get(id+'|'+slug);
        if(prior&&String(prior.account_ref||"").trim()){preserved++;continue;}
        if(prior){
          // Preserve existing active=false and avoid overwriting a new branch number.
          const empty=prior.account_ref==null?"is.null":"eq.";
          const patched=await sbSend("PATCH",
            'dealer_manufacturers?dealer_id=eq.'+enc(id)+'&manufacturer=eq.'+enc(slug)+'&account_ref='+empty,
            {account_ref:ref},{Prefer:"return=representation"});
          if(Array.isArray(patched)&&patched.length) filled++; else concurrent++;
        } else {
          const inserted=await sbSend("POST",
            "dealer_manufacturers?on_conflict=dealer_id,manufacturer",
            {dealer_id:id,manufacturer:slug,account_ref:ref,active:true},
            {Prefer:"resolution=ignore-duplicates,return=representation"});
          if(Array.isArray(inserted)&&inserted.length) filled++; else concurrent++;
        }
      }
    }
    return {filled,branches:children.length,preserved,concurrent};
  }

  const enc = encodeURIComponent;
  const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

  // Ensure the (dealer × manufacturer) relationship is marked ACTIVE without touching its
  // account number. Merge-duplicates updates only the columns in the payload, so account_ref
  // is preserved.
  async function markActive(slug, dealerId) {
    slug = String(slug || "").trim();
    if (!slug || !dealerId) return;
    await sbSend(
      "POST",
      "dealer_manufacturers?on_conflict=dealer_id,manufacturer",
      { dealer_id: dealerId, manufacturer: slug, active: true },
      { Prefer: "resolution=merge-duplicates,return=minimal" }
    ).catch(() => {});
  }

  // Conflict-aware account-number maintenance from a report. Compares the number the report
  // carries for a dealer to what's on file and decides what to do — never silently overwrites a
  // DIFFERENT existing number. Returns the outcome so the importer can report/flag it:
  //   {status:"set"}         — was blank, now set (and filled across the family) + marked active
  //   {status:"confirmed"}   — already matched; relationship (re)marked active
  //   {status:"active_only"} — report had no number; relationship marked active from activity
  //   {status:"conflict", existing, incoming} — differs; left untouched, flagged for review
  //   {status:"skip"}        — nothing to do
  // opts.apply=false makes it a DRY RUN (no writes) so a preview can show what WOULD change.
  async function reconcileAccountRef(slug, dealerId, incomingRef, opts) {
    opts = opts || {};
    const apply = opts.apply !== false;
    slug = String(slug || "").trim();
    incomingRef = String(incomingRef == null ? "" : incomingRef).trim();
    if (!slug || !dealerId) return { status: "skip" };
    const cur = await sbGet(
      `dealer_manufacturers?dealer_id=eq.${enc(dealerId)}&manufacturer=eq.${enc(slug)}&select=account_ref,active`
    ).catch(() => []);
    const row = cur && cur[0];
    const existing = row ? String(row.account_ref || "").trim() : "";
    if (!incomingRef) {
      if (apply) await markActive(slug, dealerId);
      return { status: "active_only", existing };
    }
    if (!existing) {
      if (apply) await propagateAccountRef(slug, dealerId, incomingRef);
      return { status: "set", incoming: incomingRef };
    }
    if (norm(existing) === norm(incomingRef)) {
      if (apply && (!row || row.active === false)) await markActive(slug, dealerId);
      return { status: "confirmed", existing };
    }
    return { status: "conflict", existing, incoming: incomingRef };
  }

  return { family, propagateAccountRef, fillHeadquartersBlanks, markActive, reconcileAccountRef };
};

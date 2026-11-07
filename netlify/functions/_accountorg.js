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
  /* IMPORTS NEVER GRANT ORDERING (owner directive 2026-11-06 20:55 CT, §3): this is called by the sales-report and
     commission importers. It records the identifier only — an existing row keeps its `active` exactly as Dealer Manager set
     it; a line with no row gets one with active=false (the column defaults to true, so it is always written). */
  async function propagateAccountRef(slug, dealerId, ref) {
    slug = String(slug || "").trim();
    ref = String(ref == null ? "" : ref).trim();
    if (!slug || !dealerId) return;
    // 1) Set on the dealer itself (explicit — may differ from the org number).
    const own = await sbGet(`dealer_manufacturers?dealer_id=eq.${encodeURIComponent(dealerId)}&manufacturer=eq.${encodeURIComponent(slug)}&select=dealer_id`).catch(() => null);
    if (Array.isArray(own) && own.length)
      await sbSend("PATCH", `dealer_manufacturers?dealer_id=eq.${encodeURIComponent(dealerId)}&manufacturer=eq.${encodeURIComponent(slug)}`, { account_ref: ref || null }, { Prefer: "return=minimal" }).catch(() => {});
    else if (Array.isArray(own) && ref)
      await sbSend("POST", "dealer_manufacturers?on_conflict=dealer_id,manufacturer", { dealer_id: dealerId, manufacturer: slug, account_ref: ref, active: false },
        { Prefer: "resolution=ignore-duplicates,return=minimal" }).catch(() => {});
    if (!ref) return;
    // 2) Fill blanks across the family with the org primary.
    const { root, ids } = await family(dealerId);
    if (ids.length <= 1) return;
    const inlist = ids.map(encodeURIComponent).join(",");
    const cur = await sbGet(
      `dealer_manufacturers?manufacturer=eq.${encodeURIComponent(slug)}&dealer_id=in.(${inlist})&select=dealer_id,account_ref,active`
    ).catch(() => null);
    if (!Array.isArray(cur)) return;   // unreadable: never guess (a guess could create rows)
    const byId = {}, has = new Set();
    for (const r of cur) { byId[r.dealer_id] = String(r.account_ref || "").trim(); has.add(String(r.dealer_id)); }
    const orgPrimary = byId[root] || ref; // prefer the parent org's number
    for (const id of ids) {
      if (byId[id]) continue;
      if (has.has(String(id)))   // existing row, blank number: fill the number only (its ordering state is untouched)
        await sbSend("PATCH", `dealer_manufacturers?dealer_id=eq.${encodeURIComponent(id)}&manufacturer=eq.${encodeURIComponent(slug)}&or=(account_ref.is.null,account_ref.eq.)`, { account_ref: orgPrimary }, { Prefer: "return=minimal" }).catch(() => {});
      else
        await sbSend("POST", "dealer_manufacturers?on_conflict=dealer_id,manufacturer", { dealer_id: id, manufacturer: slug, account_ref: orgPrimary, active: false },
          { Prefer: "resolution=ignore-duplicates,return=minimal" }).catch(() => {});
    }
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

  /* Formerly "markActive": a report used to turn the line ON for ordering. Owner directive 2026-11-06 §3: a report may
     identify the relationship and SUGGEST access for HCPS review, never grant it — nothing is written here. */
  async function markActive(slug, dealerId) { return { suggested: true, slug: String(slug || ""), dealer_id: dealerId, written: false }; }

  // Conflict-aware account-number maintenance from a report. Compares the number the report
  // carries for a dealer to what's on file and decides what to do — never silently overwrites a
  // DIFFERENT existing number. Returns the outcome so the importer can report/flag it:
  //   {status:"set"}         — was blank, now set (and filled across the family); ordering NOT changed
  //   {status:"confirmed"}   — already matched; ordering NOT changed
  //   {status:"active_only"} — report had no number; nothing written
  //   suggest_access:true    — the line is not on for ordering: listed for HCPS review in Dealer Manager (never granted)
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
    const suggest = !row || row.active === false;
    const sx = suggest ? { suggest_access: true } : {};
    if (!incomingRef) return Object.assign({ status: "active_only", existing }, sx);
    if (!existing) {
      if (apply) await propagateAccountRef(slug, dealerId, incomingRef);
      return Object.assign({ status: "set", incoming: incomingRef }, sx);
    }
    if (norm(existing) === norm(incomingRef)) return Object.assign({ status: "confirmed", existing }, sx);
    return { status: "conflict", existing, incoming: incomingRef };
  }

  /* HCPS-ENTERED ACCOUNT IDENTIFIER (owner directive 2026-11-06 17:40 CT): an identifier HCPS staff type in Dealer 360 is saved
     to the authoritative dealer_manufacturers row and is VERIFIED at once (who + when + the exact identifier) — no second
     button, no waiting for manufacturer reports. Numbers, letters or manufacturer usernames are all valid identifiers.
     Verification is NOT ordering authorization: an existing row keeps its `active` (Dealer Manager decides ordering); a line
     with no row gets one with active=false, so typing a number never opens ordering. Branches of the family with the line
     and no identifier of their own inherit it (verified with it); a branch with its own identifier is left alone. An empty
     identifier clears the number and its verification. Strict: a failed write throws (never a silent "saved"). */
  async function saveVerifiedAccountRef(slug, dealerId, ref, by) {
    slug = String(slug || "").trim(); ref = String(ref == null ? "" : ref).trim();
    if (!slug || !dealerId) throw new Error("dealer and manufacturer required");
    const at = new Date().toISOString(), who = String(by || "hcps").slice(0, 200);
    const ver = ref ? { verified_at: at, verified_by: who, verified_ref: ref } : { verified_at: null, verified_by: null, verified_ref: null };
    const q = (id) => `dealer_manufacturers?dealer_id=eq.${encodeURIComponent(id)}&manufacturer=eq.${encodeURIComponent(slug)}`;
    const cur = await sbGet(q(dealerId) + "&select=dealer_id,account_ref,active");
    if (cur && cur[0]) await sbSend("PATCH", q(dealerId), Object.assign({ account_ref: ref || null }, ver), { Prefer: "return=minimal" });
    else if (ref) await sbSend("POST", "dealer_manufacturers", Object.assign({ dealer_id: dealerId, manufacturer: slug, account_ref: ref, active: false }, ver), { Prefer: "return=minimal" });
    if (!ref) return { saved: true, verified: false, family_filled: 0 };
    /* The dealer's own identifier is saved from here on: a later failure must say "saved, branches not filled", never
       "nothing was changed". The family is read strictly (a failed read is reported, not treated as "no branches"). */
    let ids, filled = 0;
    try {
      const self = await sbGet(`dealers?id=eq.${encodeURIComponent(dealerId)}&select=id,parent_id`);
      if (!Array.isArray(self)) throw new Error("dealer read failed");
      const root = self[0] ? (self[0].parent_id || self[0].id) : dealerId;
      const fam = await sbGet(`dealers?or=(id.eq.${encodeURIComponent(root)},parent_id.eq.${encodeURIComponent(root)})&select=id`);
      if (!Array.isArray(fam)) throw new Error("family read failed");
      ids = fam.length ? fam.map((d) => d.id) : [dealerId];
    } catch (e) { return { saved: true, verified: true, verified_at: at, verified_by: who, family_filled: 0, family_incomplete: true }; }
    try {
    if (ids.length > 1) {
      const others = ids.filter((id) => String(id) !== String(dealerId));
      const rows = await sbGet(`dealer_manufacturers?manufacturer=eq.${encodeURIComponent(slug)}&dealer_id=in.(${others.map(encodeURIComponent).join(",")})&select=dealer_id,account_ref`);
      const have = new Set((rows || []).map((r) => String(r.dealer_id)));
      for (const r of rows || []) {
        if (String(r.account_ref || "").trim()) continue;
        await sbSend("PATCH", q(r.dealer_id) + "&or=(account_ref.is.null,account_ref.eq.)", Object.assign({ account_ref: ref }, ver), { Prefer: "return=minimal" });
        filled++;
      }
      /* a branch without the line gets the org's identifier on a row that does NOT open ordering (active=false) */
      const add = others.filter((id) => !have.has(String(id))).map((id) => Object.assign({ dealer_id: id, manufacturer: slug, account_ref: ref, active: false }, ver));
      if (add.length) { await sbSend("POST", "dealer_manufacturers", add, { Prefer: "return=minimal" }); filled += add.length; }
    }
    } catch (e) { return { saved: true, verified: true, verified_at: at, verified_by: who, family_filled: filled, family_incomplete: true }; }
    return { saved: true, verified: true, verified_at: at, verified_by: who, family_filled: filled };
  }

  return { family, propagateAccountRef, fillHeadquartersBlanks, markActive, reconcileAccountRef, saveVerifiedAccountRef };
};

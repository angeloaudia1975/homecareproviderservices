/* MANUFACTURER CENTER PIPELINE STATUS (Batch 3, 2026-10-26; tracker homecareproviderservices#42). Pure.

   One row per manufacturer line along the guided path Import → Match → Enrich → Review → Approve → Publish → Verify,
   built ONLY from what the existing services already measure — the Catalog Exceptions queue (on the launch-readiness
   matrix), the source register (mfr_sources), the decisions log (mfr_decisions) and the verification runs. It holds no
   product data and decides nothing: every step links to the tool that does the work.

   Each step: { key, label, state: done | attention | blocked | todo, summary, href, tool }.
   "Ready to publish" is a separate yes/no with its reasons: a line may move to Publish only when its commercial facts
   (an accepted price-list source, every active SKU priced, no parity error), image rights (no photo without recorded
   rights) and mandatory approvals (no unaccepted source, no unresolved duplicate conflict, no open regression fix) are
   resolved. A frozen Gold Standard line is "published"; changes to it go through the regression-fix procedure only.
   "Order-verified" is reported only when a verification order is on record (`order_verified`) — never inferred.
   NEVER a price: inputs carry counts and codes only. */
const CATS = ["pricing", "sku", "units", "content", "images", "freight", "retired"];
const MC = s => "/admin/manufacturer-center.html#line=" + encodeURIComponent(s);
const EXC = s => "/admin/catalog-exceptions.html#line=" + encodeURIComponent(s);
const has = (l, check) => (l.items || []).some(x => x.check === check);
const item = (l, check) => (l.items || []).find(x => x.check === check) || null;
const pct = v => v == null ? null : v;   // readiness stages are already whole percents

/* input: { queue: exceptionsQueue output, sources: mfr_sources rows (id, manufacturer, kind, status, legacy),
            decisions: [{manufacturer, kind, used_at}] , order_verified: {slug: true} } */
function pipeline(input) {
  const i = input || {}, q = i.queue || { lines: [] };
  const by = (rows, k) => { const o = {}; for (const r of rows || []) if (r) (o[r[k]] = o[r[k]] || []).push(r); return o; };
  const S = by(i.sources, "manufacturer"), D = by(i.decisions, "manufacturer");
  const lines = (q.lines || []).map(l => {
    const src = (S[l.slug] || []).filter(x => x.kind === "price_list");
    const accepted = src.filter(x => x.status === "accepted"), pending = (S[l.slug] || []).filter(x => x.status === "received");
    const current = accepted.filter(x => !x.legacy).slice(-1)[0] || accepted.slice(-1)[0] || null;
    const dec = D[l.slug] || [];
    const openFix = dec.filter(x => x.kind === "regression_fix" && !x.used_at).length;
    const window = dec.find(x => x.kind === "enrichment_window" && !x.used_at) || null;
    const counts = l.counts || {}, st = l.stages || {};
    const open = CATS.reduce((n, c) => n + (counts[c] || 0), 0);
    const ready = counts.ready || 0;
    const dupConflict = item(l, "catalog_duplicate_codes");
    const noData = l.status === "no_data";
    const gs = !!l.gold_standard;
    const steps = [];
    const step = (key, label, state, summary, href, tool) => steps.push({ key, label, state, summary, href, tool });

    // 1 Import — catalog rows on file and an accepted price-list source
    if (noData) step("import", "Import", "todo", "No catalog rows and no master records yet — register the manufacturer's price list in Sources.", MC(l.slug), "Manufacturer Center → Sources");
    else if (!current) step("import", "Import", "blocked", "Catalog rows on file, but no accepted price-list source" + (pending.length ? ` (${pending.length} received, not accepted)` : "") + ".", MC(l.slug), "Manufacturer Center → Sources");
    else step("import", "Import", current.legacy ? "attention" : "done", (current.legacy ? "Accepted legacy price list (receipt date not verified)" : "Accepted price list on file") + (st.catalog != null ? ` · catalog ${pct(st.catalog)}% coded` : ""), MC(l.slug), "Manufacturer Center → Sources");

    // 2 Match — master record covers the catalog
    const notMig = has(l, "not_migrated"), notIn = item(l, "catalog_codes_not_in_master");
    const matchState = noData ? "todo" : notMig ? "blocked" : (notIn || (counts.sku || 0) > 0) ? "attention" : "done";
    step("match", "Match", matchState, notMig ? "No master records yet — match the source rows to the catalog (Manufacturer Center → Match & decide)."
      : `Master record covers ${pct(st.master) == null ? "—" : pct(st.master) + "%"} of catalog codes${notIn ? ` · ${notIn.count || notIn.codes.length} not in the master` : ""}${counts.sku ? ` · ${counts.sku} part-number issue(s)` : ""}`,
      notMig || notIn ? MC(l.slug) + "&tab=match" : EXC(l.slug), notMig || notIn ? "Manufacturer Center → Match & decide" : "Catalog Exceptions → Bulk corrections");

    // 3 Enrich — product pages and photos
    const enrichOpen = (counts.content || 0) + (counts.images || 0);
    step("enrich", "Enrich", noData ? "todo" : st.enriched === 100 && !enrichOpen ? "done" : (st.enriched ? "attention" : "todo"),
      `${pct(st.enriched) == null ? "—" : pct(st.enriched) + "%"} of active SKUs on a visible product page${counts.content ? ` · ${counts.content} content item(s)` : ""}${counts.images ? ` · ${counts.images} photo item(s)` : ""}${window ? ` · enrichment window #${window.id} open (drafts)` : ""}`,
      MC(l.slug), "Manufacturer Center → Continue Product Enrichment");

    // 4 Review — open exceptions requiring action
    step("review", "Review", noData ? "todo" : open ? (l.blockers ? "blocked" : "attention") : "done",
      open ? `${open} open exception(s)${l.blockers ? ` · ${l.blockers} blocker(s)` : ""}` : "No open exceptions", EXC(l.slug), "Catalog Exceptions");

    // 5 Approve — documented approvals still waiting
    const waiting = [];
    if (pending.length) waiting.push(`${pending.length} source file(s) received, not accepted`);
    if (dupConflict) waiting.push(`${dupConflict.count || (dupConflict.codes || []).length} duplicate part number(s) to classify`);
    if (openFix) waiting.push(`${openFix} open regression fix(es)`);
    if (has(l, "parity_error")) waiting.push("parity error on the record");
    step("approve", "Approve", noData ? "todo" : waiting.length ? "attention" : "done", waiting.length ? waiting.join(" · ") : "No approvals waiting", MC(l.slug) + "&tab=decisions", "Manufacturer Center → Decisions");

    // Publication gate — commercial facts, rights, approvals
    const reasons = [];
    if (!current) reasons.push("no accepted price-list source (commercial facts unverified)");
    if (has(l, "active_sku_without_price")) reasons.push("active SKUs without a dealer price");
    if (notMig) reasons.push("no master records");
    if (has(l, "parity_error")) reasons.push("parity error on the record");
    if ((counts.images || 0) > 0) reasons.push(`${counts.images} photo item(s) without recorded rights`);
    if (pending.length) reasons.push("source file(s) not accepted");
    if (dupConflict) reasons.push("duplicate part numbers not classified");
    if (openFix) reasons.push("open regression fix");
    if ((counts.freight || 0) > 0) reasons.push("freight terms not traced to a source");
    const published = !!l.frozen || (gs && !has(l, "record_not_authoritative"));
    const ready_to_publish = !noData && !published && reasons.length === 0;

    // 6 Publish
    step("publish", "Publish", published ? "done" : ready_to_publish ? "attention" : (noData ? "todo" : "blocked"),
      published ? `Published · ${ready} SKU(s) active, priced and on a page` + (l.frozen ? " · frozen (changes by regression fix only)" : "")
        : ready_to_publish ? "Ready — run Stage (Approval 1) and Verify & activate (Approval 2)." : "Publication blocked: " + (reasons.join("; ") || "no data"),
      MC(l.slug) + "&tab=" + (l.frozen ? "decisions" : "stage"), l.frozen ? "Manufacturer Center → Decisions" : "Manufacturer Center → Stage");

    // 7 Verify — Gold Standard run + order verification on record
    const ov = !!(i.order_verified || {})[l.slug];
    step("verify", "Verify", gs && ov ? "done" : gs ? "attention" : (noData ? "todo" : "blocked"),
      gs ? "Gold Standard verification passed" + (ov ? " · dealer order verified" : " · dealer order verification not on record") : "No passing Gold Standard verification run",
      MC(l.slug) + "&tab=activate", "Manufacturer Center → Verify & activate");

    const done = steps.filter(s => s.state === "done").length;
    return { slug: l.slug, name: l.name, frozen: !!l.frozen, status: l.status, steps, done, total: steps.length,
      exceptions: open, approvals_waiting: waiting.length, ready_skus: ready, published, ready_to_publish, publish_blocked_by: published ? [] : reasons,
      order_verified: ov, readiness: l.status };
  });
  return { lines, steps: ["Import", "Match", "Enrich", "Review", "Approve", "Publish", "Verify"] };
}
module.exports = { pipeline, CATS };

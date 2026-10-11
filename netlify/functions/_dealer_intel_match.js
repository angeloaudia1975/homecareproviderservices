// MI-1c — matches the dealers a manufacturer's report prints to HCPS dealers. PURE: it reads the evidence it is given
// and PROPOSES; it never creates, merges, re-parents or re-assigns a dealer, never writes an alias, never changes
// rep ownership. A person confirms or corrects every proposal that is not automatic, in the review queue.
//
// Evidence, strongest first (SB-0, approved 2026-10-10):
//   0. a match a PERSON confirmed for the same printed name + city in an earlier report of this manufacturer;
//   1. exact name (the importers' own normaliser, _scope.dnorm): this manufacturer's sales rows already attributed to
//      an HCPS dealer under that customer name, dealer_aliases, and dealer business names;
//   2. only when 1 finds nothing: the same comparison on the name's DISTINCTIVE words (generic words such as
//      "medical", "supply", "pharmacy" and state names removed), so "All Star medical-TN" meets "All Star Medical
//      Supply TN" and "Georges" meets "George's".
// A dealer is matched AUTOMATICALLY only when ALL of these hold:
//   * the name is not on the held list (a relationship a person has not confirmed, e.g. Wyatt's Pharmacy);
//   * the evidence points at exactly ONE HCPS dealer (sales spread over several family members → review);
//   * that dealer is a real, active, ordinary account (not TEST, not inactive, not classed manufacturer/vendor/…);
//   * its name agrees with the printed name (equal, or the same distinctive words once city words are set aside) —
//     a printed name made only of generic words ("Medical Supply Store") can never agree on its own;
//   * its city agrees with the printed city, OR this manufacturer's own sales under the printed name already land on
//     it (a misspelt city such as "Ackworth" is then explained by the sales history, never "corrected").
// Anything else: one or more candidates → "review" (with every candidate and why); none → "unmatched".
const { dnorm } = require("./_scope.js");

const GENERIC = new Set(["THE", "OF", "AND", "INC", "LLC", "CO", "CORP", "COMPANY", "HQ", "MEDICAL", "SUPPLY", "SUPPLIES",
  "EQUIPMENT", "PHARMACY", "PHARMACIES", "DRUG", "DRUGS", "STORE", "STORES", "HOME", "HEALTH", "HEALTHCARE", "RETAIL",
  "CENTER", "CENTRE", "SERVICES", "SERVICE", "DME", "HME", "WAREHOUSE", "BRANCH", "ONLY", "PRODUCTS"]);
const STATE_WORDS = new Set(["AL", "FL", "GA", "IL", "IN", "KY", "MI", "MS", "MO", "NC", "OH", "SC", "TN", "VA", "WV",
  "ALABAMA", "FLORIDA", "GEORGIA", "ILLINOIS", "INDIANA", "KENTUCKY", "MICHIGAN", "MISSISSIPPI", "MISSOURI", "OHIO",
  "TENNESSEE", "VIRGINIA"]);
const NOT_ORDINARY = new Set(["manufacturer", "vendor", "service_provider", "internal", "not_relevant"]);
const cityNorm = c => String(c || "").toUpperCase().replace(/[^A-Z]+/g, " ").trim();
const words = s => dnorm(s).split(" ").filter(Boolean);
const sing = w => (w.length > 3 && w.endsWith("S") && !w.endsWith("SS") ? w.slice(0, -1) : w);
// Distinctive words of a name, optionally setting aside the words of one or more city names.
function keyOf(name, cities = []) {
  const cityWords = new Set(cities.flatMap(c => cityNorm(c).split(" ").filter(Boolean)));
  // A lone "S" is a possessive split off by the normaliser ("George's" → "GEORGE S"); it is dropped so that
  // "George's" and "Georges" compare equal, as plural and singular do ("Solution" / "Solutions").
  return words(name).filter(w => w !== "S" && !GENERIC.has(w) && !STATE_WORDS.has(w) && !cityWords.has(w)).map(sing).join("");
}

function matchDealers({ rows, hcps, held = [] }) {
  const D = new Map((hcps.dealers || []).map(d => [d.id, d]));
  const heldBy = new Map(held.map(h => [dnorm(h.name), h]));
  const out = [];
  for (const r of rows) {
    const n = dnorm(r.name), k = keyOf(r.name);
    const ev = new Map();   // dealer_id → [why]
    const add = (id, why) => { if (!id || !D.has(id)) return; (ev.get(id) || ev.set(id, []).get(id)).push(why); };
    const base = { row_no: r.row_no, printed_name: r.name, printed_city: r.city, printed_state: r.state };

    // 0. person-confirmed match in an earlier report (same printed name + city)
    const prev = (hcps.previous || []).filter(p => dnorm(p.printed_name) === n && cityNorm(p.printed_city) === cityNorm(r.city) && D.has(p.dealer_id));
    const prevIds = [...new Set(prev.map(p => p.dealer_id))];

    if (heldBy.has(n)) {
      const h = heldBy.get(n);
      // Evidence is still collected and shown — the hold only stops a match being made.
      for (const a of (hcps.aliases || [])) if (a.alias_norm === n) add(a.dealer_id, `alias "${a.alias_norm}"`);
      for (const s of (hcps.sales || [])) if (dnorm(s.customer_name) === n && s.dealer_id) add(s.dealer_id, `sales "${s.customer_name}"`);
      out.push({ ...base, status: "held", dealer_id: null, method: "held", reasons: [h.reason], candidates: cand(ev, D), sales_unattributed: unattributed(hcps, n, k) });
      continue;
    }
    if (prevIds.length === 1) {
      add(prevIds[0], `confirmed by ${prev[0].decided_by || "a person"} in an earlier report`);
      const d = D.get(prevIds[0]); const usable = ordinary(d);
      out.push({ ...base, status: usable ? "matched" : "review", dealer_id: usable ? d.id : null, method: "previous_confirmed",
        reasons: usable ? ["a person confirmed this dealer for the same printed name and city in an earlier report"] : [`the dealer confirmed earlier is ${why(d)}`],
        candidates: cand(ev, D), sales_unattributed: unattributed(hcps, n, k) });
      continue;
    }
    // 1. exact name
    const salesExact = (hcps.sales || []).filter(s => dnorm(s.customer_name) === n);
    for (const s of salesExact) if (s.dealer_id) add(s.dealer_id, `${s.n} Strongback sales row(s) "${s.customer_name}" (${s.ship_city || "?"}) attributed here`);
    for (const a of (hcps.aliases || [])) if (a.alias_norm === n) add(a.dealer_id, `alias "${a.alias_norm}"`);
    for (const d of D.values()) if (!d.is_test && dnorm(d.business_name) === n) add(d.id, "same business name");
    let tier = "exact", salesOnPrinted = new Set(salesExact.filter(s => s.dealer_id).map(s => s.dealer_id));
    // 2. distinctive words, only when nothing matched exactly
    if (!ev.size && k) {
      tier = "distinctive";
      const salesKey = (hcps.sales || []).filter(s => keyOf(s.customer_name) === k);
      for (const s of salesKey) if (s.dealer_id) add(s.dealer_id, `${s.n} Strongback sales row(s) "${s.customer_name}" (${s.ship_city || "?"}) attributed here — same distinctive name`);
      salesOnPrinted = new Set(salesKey.filter(s => s.dealer_id).map(s => s.dealer_id));
      for (const a of (hcps.aliases || [])) if (keyOf(a.alias_norm) === k) add(a.dealer_id, `alias "${a.alias_norm}" — same distinctive name`);
      for (const d of D.values()) if (!d.is_test && keyOf(d.business_name) === k) add(d.id, "same distinctive business name");
    }
    const candidates = cand(ev, D), sales_unattributed = unattributed(hcps, n, k);
    if (!ev.size) {
      out.push({ ...base, status: "unmatched", dealer_id: null, method: "none",
        reasons: ["no HCPS dealer, alias or attributed Strongback sale carries this name — nothing is created"], candidates: [], sales_unattributed });
      continue;
    }
    if (ev.size > 1) {
      const fam = familyOf([...ev.keys()], D);
      out.push({ ...base, status: "review", dealer_id: null, method: tier,
        reasons: [fam ? `the evidence points at ${ev.size} dealers of one family (${D.get(fam).business_name}) — choose the dealer this report means` : `the evidence points at ${ev.size} different HCPS dealers`],
        candidates, sales_unattributed });
      continue;
    }
    const d = D.get([...ev.keys()][0]);
    const reasons = [];
    if (!ordinary(d)) reasons.push(`the only candidate is ${why(d)}`);
    const pk = keyOf(r.name, [r.city]), dk = keyOf(d.business_name, [r.city, d.city]);
    const nameAgrees = dnorm(d.business_name) === n || (pk !== "" && pk === dk);
    if (!nameAgrees) reasons.push(pk === "" ? `"${r.name}" is made only of generic words, and the HCPS dealer is "${d.business_name}"` : `the HCPS name "${d.business_name}" differs from "${r.name}"`);
    const cityAgrees = cityNorm(d.city) === cityNorm(r.city) && (!d.state || !r.state || String(d.state).toUpperCase() === r.state);
    const salesCorroborate = salesOnPrinted.has(d.id);
    if (!cityAgrees && !salesCorroborate) reasons.push(`HCPS city "${d.city || "(blank)"}${d.state ? ", " + d.state : ""}" differs from the printed "${r.city}, ${r.state || "?"}", and no Strongback sale under the printed name lands on this dealer`);
    if (reasons.length) { out.push({ ...base, status: "review", dealer_id: null, method: tier, reasons, candidates, sales_unattributed }); continue; }
    out.push({ ...base, status: "matched", dealer_id: d.id, method: tier,
      reasons: [cityAgrees ? "name and city agree; the evidence points at this one dealer" : `name agrees and Strongback's own sales under "${r.name}" land on this dealer (printed city "${r.city}" kept as printed)`],
      candidates, sales_unattributed });
  }
  return out;
}

function ordinary(d) { return d && !d.is_test && d.active !== false && !NOT_ORDINARY.has(String(d.account_class || "").toLowerCase()); }
function why(d) { return !d ? "missing" : d.is_test ? "a TEST dealer" : d.active === false ? "inactive" : `classed "${d.account_class}"`; }
function cand(ev, D) {
  return [...ev.entries()].map(([id, whys]) => { const d = D.get(id);
    return { dealer_id: id, business_name: d.business_name, city: d.city || null, state: d.state || null, parent_id: d.parent_id || null, why: whys }; })
    .sort((a, b) => a.business_name.localeCompare(b.business_name));
}
function familyOf(ids, D) {
  const roots = new Set(ids.map(id => { const d = D.get(id); return d.parent_id && D.has(d.parent_id) ? d.parent_id : d.id; }));
  return roots.size === 1 ? [...roots][0] : null;
}
// HCPS sales rows under this name that no dealer carries — shown as evidence, never acted on.
function unattributed(hcps, n, k) {
  return (hcps.sales || []).filter(s => !s.dealer_id && (dnorm(s.customer_name) === n || (k && keyOf(s.customer_name) === k)))
    .map(s => ({ customer_name: s.customer_name, ship_city: s.ship_city || null, rows: s.n, amount: s.amount }));
}

module.exports = { matchDealers, keyOf, _internal: { cityNorm, GENERIC } };

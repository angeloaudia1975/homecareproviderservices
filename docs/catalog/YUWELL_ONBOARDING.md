# Yuwell onboarding (owner, 2026-11-04 — replaces Ohio Medical / GCE as the 12th manufacturing partner)

Status: **structure prepared; no product data, prices, freight terms or images exist yet.** Yuwell stays
unavailable to dealers until commercial data, testing and the owner's approval are complete. Nothing on this
branch writes production data, and the SQL file here is a draft, not run.

The website imagery, logos and marketing page are owned by a separate conversation and are not touched here
(see "Website coordination").

## Canonical identifier

One identifier, `yuwell`, everywhere:
- website `id` in `src/_data/manufacturers.json`;
- ordering `slug` in `public/data/manufacturers.json`;
- the files `public/data/yuwell.json`, `public/data/content/yuwell.json` and `content-overrides/yuwell.json`;
- the photo folder `public/assets/products/yuwell/`;
- the `manufacturers`, `manufacturer_meta` and `dealer_manufacturers` rows, `catalog_file_commercial.manufacturer`,
  `product_skus.manufacturer`, `monthly_sales.manufacturer` and the Manufacturer Center sources.

There are no aliases, and Yuwell is never mapped onto the retired Ohio Medical identifiers.

## How Yuwell flows through the existing architecture (no new admin tool)

| # | Requirement | Existing mechanism | Ready now? |
|---|---|---|---|
| 1 | Registration, slug `yuwell` | `manufacturers` + `manufacturer_meta` rows (`supabase/yuwell_manufacturer_register.sql`, draft) | SQL drafted — owner runs it |
| 2 | Admin and dealer entitlements | `dealer_manufacturers` rows; `_access.js` rule (all dealers / states / per account) | **Owner decision:** Yuwell's territory and eligibility. Nothing is granted until then |
| 3 | Option 2 catalog structure | public catalog file (no prices) + private `catalog_file_commercial` record, keyed by row fingerprint (P0) | Needs the price list |
| 4 | Families and variant pickers | content-overrides `_families` rules (`scripts/_catalog_families.js`) | Needs the product list |
| 5 | Photos, specs, descriptions | `scripts/catalog-enrich.js` (official site / catalog), `_content_review.js` (official hosts), `content-overrides` | Needs the official domain and catalog |
| 6 | Dealer pricing and MSRP | `scripts/catalog-import.js` adapter → review package → Manufacturer Center `mc_import_source_rows` → `stage_record_source` (two gates); `dealer_contract_prices` for any contract | Needs the price list |
| 7 | Freight and order rules | `manufacturer_meta.freight_terms` (record) or the `manufacturers.json` freight block; `min_order_qty` / `requires` order rules | Needs the written freight terms |
| 8 | Checkout and order delivery | `orders-api` (server prices with `_pricing.js`, freight with the shop's `computeFreight`) → HCPS intake email → Order Review → HCPS places the order with Yuwell | Needs Yuwell's order desk address and PO process |
| 9 | Customer MSRP Quote Builder | automatic: the builder uses the storefront's own merge for every entitled, listed line (`quotable` defaults to true) | Automatic once listed |
| 10 | Review sandbox (PR #26) | a Yuwell catalog PR labelled `owner-review` is merged into the sandbox automatically; production is never touched | When the first catalog PR exists |

## Source materials needed from Angelo (nothing is invented)

1. **The wholesale price list**, the file exactly as received. HCPS's received date comes from the email it arrived
   on (receipt evidence: mailbox, attachment name, SHA-256), and the effective date from the list itself.
   - Needed per row: item number, description, unit of measure and case/pack quantity, dealer price and any
     quantity breaks, MSRP and MAP **only where the list states them**.
2. **Yuwell's written freight terms:** free-freight threshold, flat fees, actual / LTL rules, drop-ship charges.
3. **Ordering terms:**
   - minimums and case-quantity rules;
   - accessories that require a main unit;
   - where HCPS sends the purchase order (order desk or EDI) and what confirmation comes back.
4. **The official product catalog / spec sheets, and Yuwell's official US website domain.** Enrichment and content
   review use only the domains listed for the line; nothing else is read.
5. **Territory and eligibility:** all dealers, certain states, or named accounts. Also whether Yuwell's MSRP may be
   shown on customer quotes.
6. **Images:** the website conversation is collecting logos, images and marketing content. Product photos for the
   storefront come from the same official sources, each matched to its SKU with its source recorded.

## Development work ready to stage without product data

- **Registration SQL (this branch):** draft, not run.
- **This plan:** the source checklist and the gates.
- **Launch gate (already true in the code):**
  - A line is orderable only when all of these hold:
    - its slug is listed in the storefront's `manufacturers.json`;
    - the catalog file exists;
    - a commercial record is seeded for that exact file;
    - the dealer has an active `dealer_manufacturers` row.
  - None of these exists for Yuwell today, so it cannot be ordered. That needs no new switch.
- **Importer adapter:** waits for the real file layout. Adapters are written against the actual columns, never
  guessed.
- **Report-capture profile (Outlook):** a draft (inactive) profile is added once Yuwell's sender addresses and report
  formats are known, the same way the other draft profiles were.

## Order of work once the materials arrive

1. Register the source in Manufacturer Center. The importer produces the review package; blockers come back as one
   exception list.
2. Build the public catalog file and the commercial record version: `p0-seed-catalog-commercial.js --export-sql`,
   run by Angelo.
3. Enrich from the official sources: content, families and photos.
4. **Open the catalog PR labelled `owner-review`:**
   - the sandbox shows it on the TEST dealer, with no prices exposed and no orders possible;
   - checks in the sandbox: browser and server prices agree, freight matches at every threshold, and the quote
     builder offers the same products.
5. Owner approval → exact-head review → merge.
6. Entitlement rows for the approved dealers (owner-approved SQL).
7. One controlled pilot order.

## Website coordination (another conversation owns this)

- `src/_data/manufacturers.json` (website) is **shared**. The Yuwell entry (id `yuwell`) and the Ohio Medical hide
  (`"hidden": true` on `ohio-medical`) should land in **one** coordinated change, made by whoever owns that file.
- Logos are deployed at `src/assets/logos/yuwell.jpg` and `yuwell-badge.jpg`, following the existing
  naming. The ordering site needs its own `public/assets/logos/yuwell.jpg` (the storefront loads logos from its own
  origin) — copied, not hot-linked.
- `redirects.json`: `/manufacturers/ohio-medical/*` → `/manufacturers/` (301) when Ohio Medical is hidden.
- The Resource Library's Ohio Medical documents are retired through the admin Resource tool
  (`documents.json` is admin-managed).

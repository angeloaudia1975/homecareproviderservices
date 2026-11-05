# Ohio Medical / GCE retirement (owner, 2026-11-04 — Yuwell replaces it)

Status: **prepared on draft branches only.** Nothing has been merged, deployed or run in production.

## What is kept (never deleted, renamed or exposed)

- **Dealer entitlements:** the 340 active `dealer_manufacturers` rows with `manufacturer = 'ohio-medical'`, including
  their `account_ref` account numbers and `active` flags.
- **Sales and commissions:** `monthly_sales`, commission statements, the quarantine, MI-1a batches, and the
  Report History records for Ohio Medical.
- **The `manufacturers` table row:** `slug = 'ohio-medical'` stays `active = true`. The Sales Report Import and the
  Commission Report Import read it, and final Ohio Medical commission statements may still arrive.
  Deactivating it is a separate owner decision.
- **Report capture:** the Ohio Medical Outlook capture profile (`mfr_report_profiles`) stays active for the same
  reason. Turning it off is a separate owner decision.
- **History:** past orders and quote items. A quote that already holds an Ohio Medical item keeps it, but no new
  quote can add one.
- **Zoho:** the account mapping ("GCE Acct #"), for historical accounts.

## What changes (code only)

**One shared rule, `_retired_lines.js`, in both repos** — byte-identical, and the `retired-lines` test in each
compares the two. It lists `complete-medical-supplies`, `ohio-medical` **and** `gce`. A line on it is closed to
everyone, staff included, whatever the entitlement rows say.

**Ordering site (homecareproviderservicesordering), branch `c3/ohio-medical-retire`:**
- `catalog-feed` and `catalog-layers` answer **410** for a retired line, under either identifier. They check this
  before any dealer or staff check, so the 340 `ohio-medical` rows can never open it.
- The storefront filters retired slugs out of `manufacturers.json` (`RETIRED_LINE_SLUGS`). `quotableLine` refuses
  them for new quotes.
- The `gce` entry is removed from `public/data/manufacturers.json`.
- `public/data/gce.json` (public half, no prices) and `public/assets/products/gce/` are deleted. This follows the
  Complete Medical precedent (ordering #4).
- Tests:
  - `retired-lines` is new.
  - `entitlement-matrix` now expects 410 for gce, ohio-medical and Complete Medical — including for a dealer whose
    rows carry both slugs, and for staff.
  - `quote-rules` covers retired lines.

**Admin site (homecareproviderservices), branch `c3/ohio-medical-retire`:**
- `_pricing.js`: a retired line is never priced, even if a manufacturers list or layers reappear.
- `_access.js`: `gce` is removed from `STATE_RULES`, so Ohio Medical is no longer offered as "available". The
  `NOT_REPRESENTED` set now reads the shared list, so account rows under either slug are dropped from "your accounts".
- `dealers-api.js` (`RETIRED`, the dealer grid) and `territory-api.js` (`NOT_REPRESENTED`) read the shared list.
- Test: `retired-lines` (admin side).

## Why an identifier correction cannot re-open Ohio Medical

The two spellings disagree today: the database says `ohio-medical`, the storefront says `gce`. Any later "fix" that
makes them agree — a `manufacturers.json` entry or catalog file named either way, or entitlement rows renamed — still
meets four gates that refuse both spellings by name:

1. the storefront list filter;
2. catalog-feed and catalog-layers (410);
3. the order server (`_pricing`);
4. dealer access (`_access`).

The only way back is to remove the line from `_retired_lines.js` in both repos, which takes an owner decision. The
`retired-lines` tests fail if either copy drifts.

## Not changed here — needs coordination or an owner decision

- **Public website (`src/_data/manufacturers.json`, entry `ohio-medical`):** add `"hidden": true`. The site's
  `activeManufacturers` filter then drops the `/manufacturers/ohio-medical/` page and the partner counts, and
  `redirects.json` should gain `/manufacturers/ohio-medical/*` → `/manufacturers/` (301).
  - **This file is shared with the Yuwell website work in another conversation, which will add the Yuwell entry.**
    Make one coordinated change; do not edit it concurrently.
- **Resource Library (`src/_data/documents.json`):** admin-managed. Its Ohio Medical documents are retired through
  the admin Resource tool, never by hand-editing.
- **Catalog importer:** `_catalog_import.js` / `_import_adapters.js` still accept an Ohio Medical price list. The
  importer is read-only and cannot make a line orderable. Its handoff test uses Ohio Medical as its synthetic line, so
  refusing it there is a separate, test-only follow-up.
- **Rep tools:** `routes-api` and `geocode-api` handout aliases and the `map.html` labels still name Ohio Medical
  for historical buying patterns. They are harmless; clean them up once commission reporting ends.

## Release order (each step needs explicit owner approval)

1. Exact-head review of both branches; CI green.
2. Merge **admin first**: the pricing, access and grid gates go live, while the storefront still lists gce. With
   the gates live, gce stays unpriceable, and no dealer was entitled to `gce` anyway.
3. Merge **ordering**: the listing, file and gates are removed.
4. Verify production as the TEST dealer:
   - Ohio Medical appears nowhere (catalog, "lines you don't carry", quotes).
   - `catalog-layers?manufacturer=gce` and `?manufacturer=ohio-medical` both return 410.
   - The order server refuses either slug.
   - All 1,352 live products still price identically.
5. Website hide plus redirect, together with the Yuwell website release (coordinated).

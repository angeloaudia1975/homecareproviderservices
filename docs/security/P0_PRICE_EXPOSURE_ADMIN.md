# P0 — dealer price exposure: admin/server side (issue homecareproviderservicesordering#2)

The full audit, design, rollout order, SQL checksums, rollback (marked TEMPORARY EMERGENCY EXPOSURE) and owner
decisions live in the storefront runbook: `homecareproviderservicesordering/docs/security/P0_PRICE_EXPOSURE.md`
(branch `security/p0-dealer-price-exposure`, PR ordering#3). This file records what THIS repository's part does and
the review status. Deploy order: private table + verified seed first, then this repository, then the storefront.

## What this branch changes
- `netlify/functions/_catalog_commercial.js` — verbatim copy of the storefront module (drift-tested by
  `test/pricing-parity.test.js`): row identity fingerprints, line identity, `validOverlayRecord`, `recordForFile`.
- `netlify/functions/_pricing.js` — `commercialFor`: the private record whose `identity_sha256` equals the identity of
  the public file the server just read; checked internally; restored row by row (a differing fingerprint fails);
  versions stored but none for this file → `pricing_unavailable: catalog_version_not_seeded`; the engine's
  catalog-layers read is answered only for that version. Plus admin#37 (merged in): a line not in
  `manufacturers.json` is never priced; a missing / empty / broken list fails closed.
- `netlify/functions/catalog-api.js` — the Product Catalog file read uses the same version pick (strict).
- `netlify/functions/orders-api.js` — a dealer prices and orders only its active `dealer_manufacturers` lines
  (403 `not_entitled`, no commercial field in the refusal; unreadable list → 503); staff / preview / anonymous
  callers are `unauthorized`.
- `_shop_engine.js` — regenerated from the storefront page with `test/extract-engine.js` (never hand-edited).

## Tests (local)
`p0-server` 20/20 · `p0-orderpath` 24/24 (Climbing Steps, Strongback, Ovation, Bemis × layers / record mode: price_check,
create, stored order + lines, dealer email, My Orders identical today vs P0; edited / swapped / newer / older file
refused, nothing stored or sent) · `pricing-parity` 6/6 · `pricing` 23/23 · `p0-server.mutants` control + 15 killed ·
pricing / packunit / msrpauto / freight / bemisfreight / freightterms / orderhistory / shopcart / pooling mutants all
killed · full suite = base except the pre-existing `mi1c-*` (PDF absent) and `resources-render` (documents.json).
Integration (this branch + admin#37, against storefront #3 + #4 merged with the Complete Medical file deleted): see §Review.

## Review findings — status (independent reviews of ordering#3 @ 2d58741 and admin#36 @ a9e170d, 2026-10-23)

| # | Finding | Status | Where (commit · test) |
|---|---------|--------|------------------------|
| 1 | **RELEASE BLOCKER** — overlay matched by `code#occurrence` only; `public_sha256` never checked; reorder / edit could attach the wrong price | **RESOLVED** | per-row fingerprints + line identity + version-keyed table, checked in catalog-layers, the browser restore, `_pricing.commercialFor` and the DB guard · `p0commercial` (swapped duplicates, same-count edits, missing fingerprint), `p0layers` (newer / older file, versions side by side), `p0shop`, `p0sql`, admin `p0-server` + `p0-orderpath` (refusals on the real frozen files), mutants (storefront 18 new, admin 6 new) |
| 1a | How a legacy static catalog update re-seeds atomically, before/with deployment | **RESOLVED** | versions stored side by side; `--reseed` (by fingerprint, explicit supply) before deploy, `--prune` after (§5.2) · `p0seed.test.js` + seed mutants |
| 2 | Browse ≠ buy: no wholesale price or order permission for a line not carried; same user across manufacturers; staff preview vs dealer | **RESOLVED** (tests added; behaviour was already in a9e170d) | `p0-server`: staff / preview / anonymous unauthorized with no commercial field, dealer with no active line 403, two carried lines priced, a non-carried line refuses the whole cart without echoing prices; `p0layers` preview scope |
| 2a | Approved dealers without an active line (one found live) | **OPEN — owner** | §5 step 0: confirm intended before release |
| 3 | Whole order path on the four frozen lines (price_check, create, saved totals, email, My Orders, contract prices, case packs, pooled breaks, freight) | **RESOLVED** | admin `p0-orderpath.test.js` 24/24 (layers + record mode); storefront `p0parity` 22/22 fingerprints unchanged (§4); Bemis #908–#911 / its dry run untouched (no content/decision write in this release) |
| 3a | Live Gold Standard fingerprints (`mc_verify`) | **OPEN — production step** | §5 steps 3 and 8 (needs the deployed code) |
| 4 | Runbook: order private table → seed → admin → storefront → lockdown → old permalinks → final verification; rollback marked as emergency exposure; protect permalinks ahead | **RESOLVED** | §5, §5.3 |
| 4a | Make both repos private (checklist, do not change visibility) | **OPEN — owner** | §6.1 |
| 4b | Confidential data left in public files | **REPORTED** | §6.2 — storefront clean; admin repo holds real prices / totals in CLAUDE.md, fixtures, SQL |
| 5 | SQL changed → migration, rollback, preflight + checksums; local Postgres tests; WHERE on every UPDATE/DELETE; RULE 19 | **RESOLVED** | §5 table · `p0sql.pg.test.js` 31/31 (no UPDATE/DELETE in the files; the seed's prune DELETE carries a WHERE) |
| 6 | Retired lines (ordering#4 / admin#37): seed, row counts, scans, parity, runbook skip Complete Medical; both merge orders | **RESOLVED** | `scripts/p0-lines.js` (current = manufacturers.json; `RETIRED` only for the probe) · `p0seed` dry run on this tree and on a tree without the file; integration worktree #3+#4 (all suites green) |
| 7 | Integration heads: admin #36+#37, storefront #3+#4 | **RESOLVED (local)** | admin branch merged with `catalog/retire-complete-medical` (ec6f712) — retire guard + entitlement + identity all active, full suite as main; storefront #3+#4 merged in a scratch worktree (CMS file deleted in the conflict) — all suites + admin cross-repo pricing/checkout tests green (§3) |
| 8 | Production evidence (table absent, legacy public SELECT still on) | **OPEN — production** | §5 steps 1–8 are Angelo's; nothing run against production here |

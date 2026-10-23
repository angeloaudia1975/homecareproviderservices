# Partner 360 — manufacturer launch readiness

Generated 2026-10-23T17:58:34.081Z · sources: shop repo homecareproviderservicesordering@4b1bad3, read-only snapshot taken 2026-10-23 17:53 UTC (run by Angelo)

**Launch-ready: 0 of 12 lines** (Gold Standard + no blocker + dealer checkout verified).

Average stage completion 60% — an equal-weight average of the five stage percentages over the 10 lines with data (excluded, no data: abm-respiratory-care, dalton). It is NOT a launch-ready percentage. Gold Standard 4 · blocked 6 · in progress 0 · no data 2.

"Listed" means present in manufacturers.json with rows — not that an approved dealer sees prices or can order.

| Line | Status | Launch-ready | Stage avg | Catalog | Master | Enriched | Listed | Verified | Rows | Master active | Blockers |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ABM Respiratory Care | no_data | no | 0% | 0% | 0% | 0% | 0% | 0% | 0 | 0 | 0 |
| Access4U | blocked | no | 40% | 100% | 0% | 0% | 100% | 0% | 230 | 0 | 1 |
| AIRAVANT / BongoRx | blocked | no | 40% | 100% | 0% | 0% | 100% | 0% | 12 | 0 | 1 |
| BEMIS Assurance | gold_standard | no | 89% | 100% | 100% | 44% | 100% | 100% | 9 | 9 | 0 |
| Climbing Steps | gold_standard | no | 100% | 100% | 100% | 100% | 100% | 100% | 23 | 21 | 0 |
| complete-medical-supplies | blocked | no | 20% | 100% | 0% | 0% | 0% | 0% | 473 | 0 | 3 |
| Corsicana Healthcare | blocked | no | 40% | 100% | 0% | 0% | 100% | 0% | 14 | 0 | 1 |
| Dalton Medical | no_data | no | 0% | 0% | 0% | 0% | 0% | 0% | 0 | 0 | 1 |
| Ohio Medical / GCE | blocked | no | 40% | 100% | 0% | 0% | 100% | 0% | 29 | 0 | 1 |
| Ovation Medical | gold_standard | no | 100% | 100% | 100% | 100% | 100% | 100% | 276 | 303 | 0 |
| PediFix | blocked | no | 40% | 100% | 0% | 0% | 100% | 0% | 515 | 0 | 1 |
| Strongback Mobility | gold_standard | no | 92% | 100% | 58% | 100% | 100% | 100% | 12 | 14 | 0 |

## Exceptions

### ABM Respiratory Care (abm-respiratory-care)
- **info** `no_catalog_file` — no public/data catalog file for this line

### Access4U (access4u)
- **blocker** `not_migrated` — catalog rows exist but no master record rows — legacy data, not empty
- **warn** `catalog_duplicate_codes` — the same part number appears more than once in the catalog file (2: SR3, PRK)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (9: MSR3X36, MRS2X36, MRS3X36, MRS4X36, MRS5X36, MRS6X36, MRS7X36, MRS8X36, MP5X5)
- **warn** `no_freight_terms` — no freight terms on the listing — the cart uses the generic rule

### AIRAVANT / BongoRx (airavant-bongorx)
- **blocker** `not_migrated` — catalog rows exist but no master record rows — legacy data, not empty
- **warn** `no_freight_terms` — no freight terms on the listing — the cart uses the generic rule

### BEMIS Assurance (bemis)
- **warn** `open_regression_fix` — 1 regression fix(es) recorded and not yet carried out
- **info** `active_skus_without_visible_page` — deferred by decision — active SKUs no visible enrichment page claims (5: 444DISPLAY, 7YA05313BLK, 7YA05313GRY, 7YA06303TWA, 7YE82350TC)
- **info** `master_only_codes` — active master codes not in the catalog file (added rows / custom_products) (1: 444DISPLAY)

### Climbing Steps (climbing-steps)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (1: MSP02GEN)
- **info** `master_only_codes` — active master codes not in the catalog file (added rows / custom_products) (3: MPP12, MPP13, MPP14)

### complete-medical-supplies (complete-medical-supplies)
- **blocker** `image_file_missing` — image path set but the file does not exist — a broken image (27: 3816C, 3816A, 3816B, SIMO2DS, BJ210822, BJ1104101, BJ1105001, BJ1102101, BJ100151, BJ100154, BJ215110XS, 10043D, …)
- **blocker** `not_listed` — not in manufacturers.json — dealers cannot reach it
- **blocker** `not_migrated` — catalog rows exist but no master record rows — legacy data, not empty

### Corsicana Healthcare (corsicana)
- **blocker** `not_migrated` — catalog rows exist but no master record rows — legacy data, not empty
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (2: LBHR, LBCW)

### Dalton Medical (dalton)
- **blocker** `listed_without_rows` — listed with hasData:true but nothing to show

### Ohio Medical / GCE (gce)
- **blocker** `not_migrated` — catalog rows exist but no master record rows — legacy data, not empty
- **warn** `catalog_duplicate_codes` — the same part number appears more than once in the catalog file (3: RS00515, RS00512, RS00544)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (6: RS00515, RS00522, RS00508, RS00515, RS00604, RS00605)
- **warn** `no_freight_terms` — no freight terms on the listing — the cart uses the generic rule

### Ovation Medical (ovation-medical)
- **warn** `catalog_duplicate_codes` — the same part number appears more than once in the catalog file (1: 720MXL)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (6: TC002N, TC001N, BE002N, BE003N, BE004N, BE006N)
- **info** `master_only_codes` — active master codes not in the catalog file (added rows / custom_products) (87: 10002BLACK, 10002BLUE, 10002GREY, 10002RED, 10003BLACK, 10003BLUE, 10003GREY, 10003RED, 10005BLACK, 10005BLUE, 10005GREY, 10005RED, …)

### PediFix (pedifix)
- **blocker** `not_migrated` — catalog rows exist but no master record rows — legacy data, not empty
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (142: P6055, P6050, P3036, R3295, P1014M, P1014S, P1036LL, P1036LR, P1036SL, P1036SR, P1114, P2853LL, …)

### Strongback Mobility (strongback-mobility)
- **warn** `catalog_codes_not_in_master` — catalog codes with no master record row (5: 1002, 1016AB, 1007, 1010, SEATA)
- **info** `master_only_codes` — active master codes not in the catalog file (added rows / custom_products) (7: A1000, A1001, A1004, A1005, ES0001, R0001, SB100)

# Partner 360 — manufacturer launch readiness

Generated 2026-10-23T17:02:43.655Z · sources: shop repo /home/claude/homecareproviderservicesordering, public product_content, public manufacturer_meta

**Platform completion not claimed (partial measurement)** across 10 lines with data · Gold Standard 0 · blocked 1 · in progress 0 · no data 2

| Line | Status | Done | Catalog | Master | Enriched | Visible | Verified | Rows | Master active | Blockers |
|---|---|---|---|---|---|---|---|---|---|---|
| ABM Respiratory Care | no_data | 0% | 0% | — | 0% | 0% | — | 0 | 0 | 0 |
| Access4U | partial_measurement | partial | 100% | — | 0% | 100% | — | 230 | 0 | 0 |
| AIRAVANT / BongoRx | partial_measurement | partial | 100% | — | 0% | 100% | — | 12 | 0 | 0 |
| BEMIS Assurance | partial_measurement | partial | 100% | — | 44% | 100% | — | 9 | 0 | 0 |
| Climbing Steps | partial_measurement | partial | 100% | — | 78% | 100% | — | 23 | 0 | 0 |
| complete-medical-supplies | blocked | partial | 100% | — | 0% | 0% | — | 473 | 0 | 2 |
| Corsicana Healthcare | partial_measurement | partial | 100% | — | 0% | 100% | — | 14 | 0 | 0 |
| Dalton Medical | no_data | 0% | 0% | — | 0% | 0% | — | 0 | 0 | 1 |
| Ohio Medical / GCE | partial_measurement | partial | 100% | — | 0% | 100% | — | 29 | 0 | 0 |
| Ovation Medical | partial_measurement | partial | 100% | — | 79% | 100% | — | 276 | 0 | 0 |
| PediFix | partial_measurement | partial | 100% | — | 0% | 100% | — | 515 | 0 | 0 |
| Strongback Mobility | partial_measurement | partial | 100% | — | 58% | 100% | — | 12 | 0 | 0 |

## Exceptions

### ABM Respiratory Care (abm-respiratory-care)
- **info** `no_catalog_file` — no public/data catalog file for this line

### Access4U (access4u)
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (228: STR08X30, STR12X30, STR16X30, STR20X30, STR24X30, STR08X36, STR12X36, STR16X36, STR20X36, STR24X36, STRA12X30, STRA16X30, …)
- **warn** `catalog_duplicate_codes` — the same part number appears more than once in the catalog file (2: SR3, PRK)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (9: MSR3X36, MRS2X36, MRS3X36, MRS4X36, MRS5X36, MRS6X36, MRS7X36, MRS8X36, MP5X5)
- **warn** `no_freight_terms` — no freight terms on the listing — the cart uses the generic rule

### AIRAVANT / BongoRx (airavant-bongorx)
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (12: BNG500, BNG501, BNG502, BNG503, BNG504, BNG505, BNG511, BNG512, BNG513, BNG514, BNG515, BNG530)
- **warn** `no_freight_terms` — no freight terms on the listing — the cart uses the generic rule

### BEMIS Assurance (bemis)
- **info** `active_skus_without_visible_page` — deferred by decision — active SKUs no visible enrichment page claims (5: 7YA05313GRY, 7YA05313BLK, 7YA06303TWA, 7YE82350TC, DO5300RD444)

### Climbing Steps (climbing-steps)
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (5: DSC06132, ARMS3, MPP10, LIFTB, DSC00912)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (1: MSP02GEN)

### complete-medical-supplies (complete-medical-supplies)
- **blocker** `image_file_missing` — image path set but the file does not exist — a broken image (27: 3816C, 3816A, 3816B, SIMO2DS, BJ210822, BJ1104101, BJ1105001, BJ1102101, BJ100151, BJ100154, BJ215110XS, 10043D, …)
- **blocker** `not_listed` — not in manufacturers.json — dealers cannot reach it
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (473: 14002, 14002A, 5DEC02DS, BJ240700, OM812, BJ240100, BJ240120, BJ240306, BJ240701, BJ240702, BJ240140, BJ240302, …)

### Corsicana Healthcare (corsicana)
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (14: 6EVEREST, 6ELEVATE, 6ESSENTIALS, 10ESSCATL, 8ESSCATL, SBLBTL, SPKDP2TL, SBKD3TL, 10ERGOCB1, SB10MATPRON1TL, PSP1TL, SBKDB30, …)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (2: LBHR, LBCW)

### Dalton Medical (dalton)
- **blocker** `listed_without_rows` — listed with hasData:true but nothing to show

### Ohio Medical / GCE (gce)
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (26: RS00502XDRS00536, RS00502XD, RS00608XS, RS00501, RS00515, RS00513, RS00522, RS00536, RS00508, RS00526, RS00512, RS00544, …)
- **warn** `catalog_duplicate_codes` — the same part number appears more than once in the catalog file (3: RS00515, RS00512, RS00544)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (6: RS00515, RS00522, RS00508, RS00515, RS00604, RS00605)
- **warn** `no_freight_terms` — no freight terms on the listing — the cart uses the generic rule

### Ovation Medical (ovation-medical)
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (59: 10002, 10003, 10005, 10007, 10008, 10102, 10103, 10105, 10107, 10108, 11002, 11003, …)
- **warn** `catalog_duplicate_codes` — the same part number appears more than once in the catalog file (1: 720MXL)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (6: TC002N, TC001N, BE002N, BE003N, BE004N, BE006N)

### PediFix (pedifix)
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (515: P280L, P280M, P280MIX, P280S, P83, P57, P55, P58L, P58R, P6055, P15, P16, …)
- **warn** `catalog_rows_without_image` — rows with no image (the shop shows the placeholder) (142: P6055, P6050, P3036, R3295, P1014M, P1014S, P1036LL, P1036LR, P1036SL, P1036SR, P1114, P2853LL, …)

### Strongback Mobility (strongback-mobility)
- **warn** `active_skus_without_visible_page` — active SKUs no visible enrichment page claims (5: 1002, 1016AB, 1007, 1010, SEATA)

## Not measured in this run

- master record (product_skus) — closed to the public key; run supabase/readiness_snapshot.sql read-only and pass --snapshot
- verification runs (Gold Standard) — same snapshot

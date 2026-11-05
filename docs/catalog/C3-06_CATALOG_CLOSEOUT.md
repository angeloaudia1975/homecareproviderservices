# Manufacturer catalog project — closeout (C3-06, owner 2026-11-05)

The owner accepted the existing catalog content as **complete**. Enrichment work is **not** reopened for minor missing
photos, unconfirmed features or outstanding source discrepancies. This file records those known limitations so a
future manufacturer update (a new price list, new photos, a new source file) can pick them up. Nothing here changes an
approved price, a product status, a page or any dealer's access.

## How to use this list
- Only a **new manufacturer source** (Manufacturer Center flow, two human gates) or an **owner decision** reopens an item.
- The four frozen Gold Standard lines (Climbing Steps, Strongback, Ovation, Bemis) and Yuwell are unaffected.
- No wholesale prices belong in this file (public repository).

## Known limitations by line (as audited 2026-11-05, live public data)
| Line | Photos | Content | Open source questions |
|---|---|---|---|
| **Access4U** | VPLK and CK have no photo; DLOOP photo is small (102×124) | 12 of 14 pages have few or no feature bullets | MSRP ×1.5 / MAP rule (raw, not applied); legacy part numbers not on the current list are preserved, not retired; no master record |
| **ABM Respiratory Care** | Placeholder photo on BK389, BK281, BC21095, BC23400, BC23406, BC23412, BC23418, BC23387, BC23394 | All 27 pages have no feature list; 8 short descriptions | BK388 title and warranty; named-account price column never used as a dealer price; no master record |
| **Corsicana** | SB10MATPRON1-TL photo is small (256×168) | 4 thin pages | C-1 … C-5, C-7 … C-10 and the "Ice" wording; freight TBD items; case quantity read from free text; no master record |
| **Dalton Medical** | 6 small photos | 15 thin pages; 13 SKUs have no official manufacturer page | D-1, D-4 … D-15 (23 SKUs); pack quantities from pack text; November 1, 2026 list as printed (never an extra discount); no master record |
| **PediFix** | D17-DEX, P3036 and P3071-PACKET-100 have no photo | D17-DEX and the six P244 items have no description; ~164 pages have no feature list | PF-1 … PF-14; the 2025 document is not a current 2026 list; no master record |

## Retired, not a limitation
- **PediFix (owner, 2026-11-05):** 8520, 8521, 8620, P3012, P3012-12, P3305, P3355-STR, 6210-L-S, 6210-L-M, 6210-L-L,
  6210-M-S, 6210-M-M, 6210-M-L, 6210-M-XL are permanently retired, and the duplicate P3095-115 stays retired. They are
  listed in the storefront's `RETIRED_SKUS` (ordering `public/index.html`), which the order server runs verbatim
  (`_shop_engine.js`): never shown, priced or ordered, whatever a catalog file, an import, an override or an added
  product says. Order, sales and commission history is untouched. Removing a code needs the owner's decision.

## Dealers who browse but cannot order a line
Request access (C3-06 closeout): a line a dealer may browse by territory but does not carry (no active
`dealer_manufacturers` row) shows "Request access". The request is stored in `dealer_access_requests` and emailed to
HCPS staff; it grants nothing. Staff approve by turning the line on in the dealer's Ordering Access grid.

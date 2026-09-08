# HCPS Ovation — handoff brief

Paste this into a new conversation to continue.

## Repos (both connected to Cowork)
- `C:\Users\angel\OneDrive\Documents\GitHub\homecareproviderservices` — admin pages (`src/admin/`) + Netlify functions (`netlify/functions/`)
- `C:\Users\angel\OneDrive\Documents\GitHub\homecareproviderservicesordering` — Partner 360 shop (`public/index.html`)

Claude writes changes straight into these folders. Angelo pushes from GitHub Desktop.

## DEPLOY STATE — check this first
The **ordering** repo is live. The **admin** repo is NOT, despite being pushed.

Files confirmed present locally with these exact sizes:

| File | Bytes |
|---|---|
| `netlify/functions/catalog-api.js` | 162,500 |
| `netlify/functions/_catalog-join.js` | 23,516 |
| `netlify/functions/_intent.js` | 32,916 |
| `src/admin/catalog.html` | 137,358 |
| `src/admin/product-content-review.html` | 398,398 |

Live check that must pass before any further work:
- `merge_review` action returns rows, not `"unknown action"`
- `window.unmergeProduct` is a function on the Product Catalog page
- A "⇄ Merged pricing" button exists in the Product Catalog toolbar

While undeployed: **dealer search events are being silently discarded** (the shop sends them; `ALLOWED_EVENTS` accepting `search` is in the undeployed `_intent.js`).

## Architecture rule (Angelo's, and correct)
Structure Map = organisation · Enrichment = content/identity · Product Catalog = SKU/pricing/status · Partner 360 = published output.
One master record. No tool keeps its own copy.

## Live Ovation state (303 SKUs, 57 cards)
- 54 of 57 cards offer "Choose options"
- **4 cards hide 5 SKUs a dealer cannot select** — two SKUs share one option cell:
  - `Pneumatic Ankle Stirrups` — 2000B+2100B, 2000W+2100W (4 SKUs, 2 selectable)
  - `Nu-Form Universal Back Brace (L0637/L0650)` — 62007 + 61008-2
  - `Compact Pro ROM — Standard` — 51500 + 51508
  - `Compact Pro ROM — Cool Wrap` — 51600 + 51608
- 3 single-SKU cards: 62001, 62002, 51700 (correct)

## Open work, in order
1. **Deploy the admin repo.** Everything below is blocked on it.
2. **Accessories are not variants.** 61000-2 / 61008-2 are extension belts listed as SKUs on brace pages, so they compete to be the selectable variant. The shop already has `product_related` (kind=accessory) rendering a "Related products" section. Move them there and off the SKU lists. Same for the Compact Pro ROM pairs once Angelo says what distinguishes them.
3. **Render quantity tiers on the product page.** Tiers are stored and already applied by `unitPrice(p,qty)` (combined qty across a family, not per SKU) — they are simply never displayed. 62002 carries 1 → $139.95, 2+ → $99.95, 6+ → $84.95, 11+ → $74.99, 21+ → $65.99. Show the table plus "add N more for $X". The `price_note` "Volume price (mix sizes): …" text duplicates this and should retire once tiers render.
4. **120 SKU name mismatches** between Product Catalog and Enrichment (enrichment is right). One previewed bulk repair, not by hand.
5. **Fix a false positive Claude introduced**: `structure_audit` flags a SKU on two pages as an error. A shared *accessory* is legitimate — only a shared *variant* is a bug.
6. **Then** the governed category tree + Family as a level. Extend `manufacturer_meta.category_map` rather than creating a second store.

## Facts Angelo confirmed
- 62001 = Nu-Form Universal Back Brace 0627
- 62002 = Nu-Form Universal Back Brace 0631
- 61000-2 = Extension Belt, intentionally offered with both braces
- 62002 was wrongly merged into 61000-2; now separated, active, $139.95, tiers intact
- The 25 remaining Ovation merges (`10002 → 10002BLUE` etc.) look intentional

## Testing discipline in force
50 suites, ~2,494 assertions, 426/426 mutations, in `/home/claude/t-*.mjs` and `mut-*.mjs` (session-local — recreate as needed). Suites EXECUTE real functions against stubs; every change gets a mutation harness proving the tests fail when the behaviour is broken.

Recurring trap: identical code in two functions means a string-replace mutation hits the wrong one. Anchor mutation patterns with surrounding context. This bit three times.

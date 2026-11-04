# Golden Commerce API — contract v1 (golden-commerce-v1)

**Contract version:** 1.4.0 (1.0.0 frozen 2026-11-02, Stage 0 batch B0; 1.1.0 adds the Stage 2 read routes, batch B2; 1.2.0 the product-detail route; 1.3.0 the Stage 3 configurator, batch B3; 1.4.0 the Stage 4a read-only quote, batch B4) · **Blueprint:** `docs/FEDERATED_ARCHITECTURE.md` v1.3.0
**Committed byte-identical in:** `golden-dealer-portal/docs/contracts/` and `homecareproviderservices/docs/contracts/`.
`golden-commerce-v1.lock.json` pins the SHA-256 of this file, the schema, the signing vectors and the shared
signing module. Each repo's tests fail on drift. Change all copies together and bump the lock.

## 1. Parties and direction

| Party | Role |
|---|---|
| Golden Dealer Portal (Tenant 0 `hcps`) | Authoritative engine: Golden catalog, dealer pricing, inventory, configuration, orders, fulfilment, history. Serves `/v1/*`. |
| HCPS `golden-proxy` (homecareproviderservices) | The only caller. Turns a signed-in Partner 360 dealer into a signed, delegated request. |
| Partner 360 browser | Never calls Golden. Never holds an integration credential. |

HCPS never writes Golden tables. `/v1/identity/assign` and (Stage 4) `/v1/orders` are calls into Golden's own API.
Golden decides and writes.

## 2. Transport

- HTTPS only, JSON bodies, UTF-8.
- Every response carries `contract_version`, `tenant` and `request_id`, plus header `X-Request-Id`. `Cache-Control: no-store`.
- Errors use one envelope: `{"error":{"code","message","retryable"},"request_id",…}`. No stack traces and no upstream text.
- Each route is off until `GOLDEN_V1_API=true` is set in Golden's Netlify env and the site is redeployed. While off, every route answers **503 `golden_v1_disabled`**.

## 3. Routes in v1

| Method · path | Scope | Delegation | Stage | Status |
|---|---|---|---|---|
| GET `/v1/health` | `golden:health` | no | 0/1 | **built (B1)** |
| GET `/v1/eligibility` | `golden:read` | required | 1 | **built (B1)** |
| POST `/v1/identity/assign` | `golden:identity` | required, role `hcps_staff` | 1 | **built (B1)** |
| GET `/v1/catalog` | `golden:read` | required | 2 | **built (B2)** |
| GET `/v1/inventory` | `golden:read` | required | 2 | **built (B2)** |
| GET `/v1/catalog/family?family=` | `golden:read` | required | 2 | **built (B2 enrichment, 1.2.0)** |
| GET `/v1/config?sku=&fabric=&color=&tier=&footrest=` | `golden:read` | required | 3 | **built (B3 configurator, 1.3.0)** |
| POST `/v1/quote` | `golden:read` | required | 4a | **built (B4a, read-only, 1.4.0)** |
| GET `/v1/ship-to` | `golden:read` | required | 4b | **built (B4b, read-only, 1.4.0)** |
| POST `/v1/orders` `mode:"validate"` | `golden:read` | required + `Idempotency-Key` | 4b | **built (B4b, validate-only, 1.4.0)** |
| POST `/v1/orders` (placement) | `golden:order` | required + `Idempotency-Key` | 4c | not built (any other mode → 403 `ordering_disabled`) |
| GET `/v1/orders/{order_id}`, `/v1/history` | `golden:history` | required | 5 | not built |

A route that is not built does not exist. A later stage adds it with a **minor** contract bump and its
schema. Field names, codes and meanings in this file never change within v1.

## 4. Payloads (B1 routes)

**GET /v1/health → 200**
`{ status:"ok", capabilities:{ eligibility, identity_assign, catalog, quote, orders, history } }`. Each value is a boolean.

**GET /v1/eligibility → 200.** The caller is the dealer named in the delegation.

| `state` | Meaning |
|---|---|
| `none` | No verified link, or the Golden account is switched off (`reason`: `no_verified_link` · `golden_account_inactive`) |
| `browse_only` | Verified link, but dealer prices are hidden and ordering is off |
| `account` | Verified link with dealer prices shown and/or ordering on |

Body: `{ state, reason?, link_id?, capabilities:{see_prices, order, history}, order_route: null|"direct"|"review", multi_location? }`.

- `order_route` is `"review"` when the Golden account runs Multi-Location mode and the delegation is a branch user. Such an order goes to the account's review queue, never straight to Golden.
- Errors: 403 `branch_not_permitted` (a delegated branch that is not verified for this link), 409 `link_ambiguous`, 503 `integration_store_unavailable`.
- Never returned: Golden account number, terms, email, prices.

**POST /v1/identity/assign**
Request: `{ golden_dealer_id, hcps_dealer_id, customer_no?, evidence:{ method:"account_number"|"federation_event"|"manual", note? } }`.

- `hcps_dealer_id` must equal the delegation's `sub_dealer`.
- 200: `{ result:"proposed"|"unchanged", link_id, status }`.
- Errors:
    - 404 `unknown_golden_dealer`
    - 409 `link_conflict`
    - 422 `golden_dealer_id` · `hcps_dealer_mismatch` · `evidence_method`
    - 403 `role`
- A `customer_no` that differs from Golden's is **not** reported back. It is Golden's default dealer login secret, so a distinct answer would let a caller test guesses. Instead it is recorded on the proposal for the Golden admin.
- The result is a **proposal** only. It becomes usable only when a Golden admin verifies it (`admin-integration-links`), and verifying never enables ordering.

## 4a. Payloads (B2 routes, contract 1.1.0)

Both routes resolve the caller exactly like `/v1/eligibility`: only a **verified** link of the calling client counts,
the Golden account must be active, and a delegated branch needs its own verified branch row (else 403
`branch_not_permitted`). 409 `link_ambiguous` and 503 `integration_store_unavailable` as in §4.

**GET /v1/catalog → 200** (schema `catalog_200`)
`{ as_of, etag, catalog_version, prices_visible, linked, reason, products:[catalog_product] }`. Header `ETag`.

- The products are the Golden portal's own cards (one per orderable SKU), with Golden's merchandising layer applied
  as the portal applies it: a hidden model is left out; name/description overrides, badges, ribbon note and the
  primary photo are applied. Lift chairs and beds share a `family` (the model) and carry `size_code` / `size_label`.
- `dealer_price` and `price_source` are present **only** when `prices_visible` is true (verified link with
  `price_visibility = 'dealer'`). Otherwise the keys are absent — never null, never 0.
- `dealer_price` follows the portal's rule: promotion price, else the dealer's own Golden pricing row, else the
  portal's standard dealer price (`price_source` = `promo` · `account` · `standard`).
- `image` and `brochure_url` are absolute `https://` or null. `msrp` / `emap` are the portal's retail values.
- Errors: 503 `catalog_unavailable` (merchandising layer unreadable — fails closed), 503 `pricing_unavailable`
  (the dealer's prices could not be read — never a guessed or standard price instead).
- Never returned: Golden account number, terms, email, another dealer's price, Golden's dealer id.

**GET /v1/inventory → 200** (schema `inventory_200`)
`{ as_of, stale, low_stock_threshold, items:[{ sku, status, qty }] }`.

- `status` per catalog SKU uses the portal's card-badge rule: lift chairs by model + size, everything else by
  plain model; `low` at or below `low_stock_threshold` (50); a product family absent from the stock feed is
  `on_request`; Golden's merchandising `in_stock_override` wins (then `qty` is null).
- `as_of` is the newest inventory sync; `stale` is true when it is older than 36 hours or there is no feed.
  Golden stock is a daily file sync: a consumer shows it "as of" `as_of`, never as live.
- Errors: 503 `inventory_unavailable`.

## 4b. Payloads (B2 enrichment, contract 1.2.0)

**GET /v1/catalog/family?family=PR511 → 200** (schema `family_200`)
`{ as_of, etag, enrichment_as_of, prices_visible, linked, reason, family }`. Header `ETag`. Caller resolution, pricing
rule, merchandising layer and errors are exactly those of `/v1/catalog` (§4a); plus 400 `bad_request` (family code
malformed) and 404 `not_found` (unknown family, or a model Golden has hidden).

`family` carries the product-detail content Golden publishes for that model, built from Golden's own sources by
`repo/scripts/golden-enrichment/build.js` (goldentech.com pages and their PDFs, Golden's official owner's-manual
folders, Golden's YouTube channel, the portal's own catalog and fabric rules) into `repo/functions/lib/golden-enrichment.json`:

- `skus` — the same `catalog_product` objects as `/v1/catalog` for this family (dealer prices under the same rule).
- `gallery[]` — `{ url, role, skus, w, h, quality, primary, shared, source_url }`, verified Golden photos only (each
  loaded, measured and hashed; a photo whose file name names another Golden model or line is never included). At most
  one `primary`. `shared:true` = the same picture appears on another Golden model's page (a feature / lifestyle shot,
  never the primary). `skus` lists the sizes a photo shows when Golden says so. Golden's own merchandising photos lead.
- `specs` — `{ columns:[sku], rows:[{ label, values:{sku:value}, key }], basis, source }`. A value is attached to a
  size only where Golden's source states it for that size (`basis` `sell_sheet_size_table` or, for a one-model page,
  `product_page`). `website_unscoped[]` holds values Golden's website shows without naming the size; a consumer labels
  them so and never assigns them to a size. `compare` = the rows that have a `key`, for side-by-side comparison.
- `features` — `{ standard, optional, accessories, benefits, groups, warranty_terms, none_published, source }` in
  Golden's own words. `none_published:true` = Golden's sell sheet for this model is a spec sheet without a feature list.
- `documents[]` — `{ kind, title, url, format, language, pages, bytes, version, applies, note, source }`;
  `kind` ∈ sell_sheet · accessories_sheet · brochure · owners_manual · quick_start · option_manual · warranty ·
  setup_instructions · document. `version.date` is the date the file states (file name, folder or PDF metadata — `version.basis` says which).
  A document Golden restricts (`access:"dealer"`) is included only for a dealer with a verified link.
- `videos[]` — `{ youtube_id, title, embed, thumbnail, relevance }`, only videos embedded on Golden's product page and
  published by Golden Technologies' YouTube channel; `embed` is the privacy-enhanced youtube-nocookie URL.
- `fabrics[]` — the portal's standard palette for the model with Golden's swatch photos.
- `related[]` — Golden's related models that the portal sells. `page` — Golden's product page. `enriched` — false when
  no enrichment exists yet for the family (the consumer shows the card data only).
- Never returned: website retail prices, internal reconciliation notes, image hashes.

## 4c. Payloads (B3 configurator, contract 1.3.0)

**GET /v1/config?sku=PR511-LAR&fabric=xover&color=JBO&tier=nirvana&footrest=1 → 200** (schema `config_200`)
`{ as_of, etag, engine, prices_visible, linked, reason, config }`. Header `ETag`. Caller resolution and the pricing rule are
those of `/v1/catalog` (§4a). **Golden decides:** the answer is computed by the Golden dealer portal's OWN configurator
code (extracted verbatim from `portals/dealer/index.html` into `repo/functions/lib/golden-config-portal.js`, drift-tested;
`engine` = the first 16 hex of its SHA-256) run on Golden's server with this dealer's Golden pricing and Golden's inventory
rows. A consumer renders it and never re-computes a price, stock level, lead time or item number.

Query: `sku` (a configurable lift-chair size, `PR\d{3}-[A-Z]{3}`), optional `fabric` (`std` · `xover` · `brisa`, default
`std`), `color` (3-character Golden colour code), `tier` (`standard` · `irheat` · `hvib` · `nirvana`), `footrest` (`0`|`1`).

- `config.sizes[]` — every size of the model `{ sku, code, label, msrp, status }` (+ `dealer_price` with prices visible).
- `config.tabs[]` — the fabric tabs the portal offers for the model `{ key, label, colors[] }` (+ `upcharge` with prices
  visible); each colour `{ code, name, hex, swatch, status }` with `status` in · low · out for the selected size and tier.
- `config.tiers` — `{ included, included_text, options[{ key, msrp, prebuilt_status }] }` (+ `upcharge`). An `included`
  model (PR447, PR442) has exactly its built-in tier at no charge.
- `config.footrest` — `{ eligible, part }` (+ `upcharge`). A chair with a footrest extension is always a custom build.
- `config.quote` (only when `color` is given) — `{ ok:true, sku, fabric, color, color_name, tier, footrest, lead_note,
  in_stock, custom, item_no, item_no_resolved, upgrades[], details }` (+ `unit_price`, `breakdown` with prices visible).
  `item_no` is Golden's full item number only for the matching in-stock unit of the SAME tier (portal rules #143 /
  PO#90151); otherwise it is the model-size and `item_no_resolved:false` — the order carries the spec breakdown.
- Exact quantities (`qty`, `prebuilt`) only for a dealer with a verified link; everyone else gets the status only.
- Errors: 400 `bad_request` (malformed query, or a colour / tier the portal does not offer for that model — `detail` names
  it), 404 `not_found` (not a configurable model or size), 503 `inventory_unavailable` · `pricing_unavailable` ·
  `config_unavailable`. Never a guessed price or stock level.
- Ordering a configuration is Stage 4 (`POST /v1/orders`); this route never reserves stock or records anything.

## 4d. Payloads (B4a quote, contract 1.4.0)

**POST /v1/quote → 200** (schema `quote_200`). Body `{ lines:[{ sku, fabric, color, tier?, footrest?, qty }], split_order?, ship_to?:{ id } }`
— 1 to 30 configured lift-chair lines (`sku` `PR\d{3}-[A-Z]{3}`, `color` required, `qty` 1–20). Answer
`{ as_of, engine, sh_terms_checked, ship_to_id, ordering_enabled:false, quote:{ lines[], totals, freight, quote_hash } }`.

- **Golden decides every amount.** Each line is priced by the portal's own configurator (§4c) with this dealer's Golden
  pricing; S&H by the portal's one S&H rule (`golden-sh.priceOrder`, the function `save-order` stores orders with):
  per shipment `max(minimum, merchandise × rate)`, split into in-stock and build shipments when `split_order` is true,
  waived only by the account's own special terms for that ship-to. Any price sent by the caller is ignored.
- `ship_to` names one of Golden's OWN authorized ship-tos by id (§4e) — a free-text address is refused (400 `ship_to`), so
  special terms can only waive S&H for an address Golden holds for that dealer / branch. No ship-to = standard S&H.
- Only a verified link whose Golden prices are visible may quote: otherwise 403 `prices_not_visible` (or the §4a link codes).
- `quote_hash` (sha256 of engine + priced lines + totals + ship-to id) lets Stage 4b's order route refuse an order whose prices changed
  since the dealer reviewed them. Freight and delivery add-ons are not in 4a (`freight.included:false`).
- `sh_terms_checked:false` = the special-terms read failed and standard S&H was applied (as `save-order` does).
- Errors: 400 `bad_request` (`message` names the field and line, e.g. `color@1`), 404 `not_found` (not a configurable
  size), 503 `pricing_unavailable` (no dealer cost on a line — not retryable; or the pricing read failed — retryable),
  503 `inventory_unavailable` · `config_unavailable`.
- **Read-only.** No order, reservation, email or stock change. Ordering is Stage 4b (`POST /v1/orders`, `Idempotency-Key`).

## 4e. Payloads (B4b ship-to, contract 1.4.0)

**GET /v1/ship-to → 200** (schema `ship_to_200`) `{ scope:"account"|"branch", ship_to:[{ id, kind, label, address, city, state, zip }] }`.
Golden's own records, never the caller's: an account delegation gets the Golden dealer's primary address (`id:"primary"`,
from `dealer_locations`) and its saved ship-to locations (`dealer_ship_locations`, id = uuid); a branch delegation gets ONLY
its verified branch's own default ship-to (`dealer_branches.ship_location_id`) — or none. Only a verified, price-visible link
(else 403 `prices_not_visible` / the §4a link codes). A failed read is 503 `ship_to_unavailable`, never an empty list.

## 4f. Payloads (B4b validate-only order, contract 1.4.0)

**POST /v1/orders** with header `Idempotency-Key: <uuid v4>` (§6) and body
`{ mode:"validate", quote_hash, lines:[{ sku, fabric, color, tier?, footrest?, qty, reference_names?:[≤ qty names] }],
split_order?, ship_to:{ id }, po_number?, contact:{ name, phone, email? }, attention?, notes? }` (unknown fields → 400).

- **Places nothing.** No orders row, reservation, email or federation event. Any `mode` other than `validate` → 403
  `ordering_disabled` (placement is Stage 4c).
- Golden re-prices now with the same code as `/v1/quote` (dealer pricing, stock, S&H, the special-terms waiver of the chosen
  authorized ship-to). If the result's `quote_hash` differs from the one the dealer reviewed → 409 `prices_changed` with the
  new `quote` (nothing validated). A failed special-terms read → 503 `pricing_unavailable` (never shown as a price change).
- `po_number` optional (Golden's auto-PO `WEB-MMDDYY-HHMMSS` otherwise, `po_auto:true`); 400 `po_required` when the Golden
  account requires one. **A reused PO is valid** (§6). Free text (contact, attention, notes, reference names, PO) may not
  contain `<` `>` or control characters.
- **200** (schema `orders_validate_200`): `{ mode:"validate", valid:true, ordering_enabled:false, idempotent_replay, engine,
  order:{ po_number, po_auto, ship_to, contact, attention, notes, delivery_type:"business", split_order, lines[] }, quote,
  emails:{ golden_order:{ recipient:"golden_order_desk", recipient_configured, subject, html },
  dealer_confirmation:{ to, subject, html, text } | null } }` — the emails are byte-identical to what `save-order` would
  send for this order (same `buildEmailHtml`, subject and confirmation template); the order desk address is not disclosed.
- Errors also: 422 `idempotency_conflict`, 409 `idempotency_in_progress` (retry), 503 `idempotency_unavailable`.

## 5. Authentication: HMAC request signing (shared module `hcps-s2s.js`)

```
Authorization: HCPS-S2S kid=<kid>, ts=<unix seconds>, nonce=<uuid v4>, sig=<64 lowercase hex>
X-HCPS-Delegation: <base64url(JSON claims)>        (routes that require delegation)

sig = HMAC-SHA256(secret, join("\n",
        "HCPS-S2S-v1", "golden-commerce-v1", METHOD, PATH, SORTED_ENCODED_QUERY,
        ts, nonce, SHA256hex(raw body bytes), SHA256hex(X-HCPS-Delegation value or "")))
```

- **Secret storage.** Each side keeps the shared secret only in its Netlify environment:
    - Golden: `HCPS_P360_KEYS`, a JSON object `{"<kid>":"<secret>"}`. It can hold two kids during a rotation.
    - HCPS: `GOLDEN_P360_KEY_ID` + `GOLDEN_P360_SECRET`.

  The secret is ≥ 32 bytes (`openssl rand -base64 48`). It is **never** stored in a database, a repo, a log or a chat. Golden's `integration_clients` row holds only `kid`, a stable `client_id`, `scopes`, `active`, `tenant_id` and a 16-hex `secret_fingerprint`. The fingerprint confirms which secret is configured and is never used to sign or verify.

  **Rotation:** add a second key id with the **same `client_id`**. Dealer links hang on `client_id`, so they survive the change. Move HCPS to the new key, then set the old row `active=false`.

  **Environments:** each environment (production, preview, staging) has its **own** secret. The signature does not cover the host, so a shared secret would let a request signed for one environment be replayed once against another.
- **Golden's checks, in order. Each refusal is logged without values:**
    1. API switch on.
    2. Header grammar.
    3. `|now − ts| ≤ 300 s`.
    4. Kid known in env.
    5. Constant-time comparison of the 32 decoded signature bytes.
    6. Delegation claims valid.
    7. `integration_clients` row active, same tenant, scope present, fingerprint = fingerprint(env secret).
    8. Nonce unseen: `integration_nonce_claim`, unique `(kid, nonce)`, kept 15 min.

  A database that cannot be read fails **closed** (503).
- **Delegation claims:** `{ sub_dealer:uuid (HCPS dealers.id), sub_branch:uuid|null, actor:string, role, aud:"golden-commerce-v1", iat, exp }`.
    - `role` is one of `dealer`, `dealer_admin`, `branch_user`, `staff_preview`, `hcps_staff`.
    - `exp − iat ≤ 120 s`. `iat` may be at most 30 s in the future.
    - The claims never carry a Golden slug, account number, price or total.
- **Codes (401 unless noted):**
    - `missing_signature`, `bad_signature_header`, `bad_nonce`, `stale_request`, `unknown_key`, `bad_signature`
    - `delegation_required`, `delegation_invalid`, `delegation_audience`, `delegation_lifetime`, `delegation_not_yet_valid`, `delegation_expired`, `delegation_subject`, `delegation_branch`, `delegation_role`, `delegation_actor`
    - `key_mismatch`, `replayed_nonce`
    - 400 `bad_query`
    - 403 `tenant` · `scope`
- **Sign-in links are a separate secret.** Staff links use `HCPS_SSO_SECRET` (Golden) = `GOLDEN_SSO_SECRET` (HCPS).
    - Claims: `{slug, exp, aud:"golden-sso"}`.
    - `aud` is always required, and `exp` may be at most 300 s ahead.
    - The event-signing secret is accepted for links **only** while `SSO_LEGACY_SECRET=on`. That is opt-in and off by default.

`golden-commerce-v1.signing-vectors.json` holds fixed inputs and the exact expected headers. Both repos test their implementation against it.

## 6. Retry safety and idempotency (binding for Stage 4)

- `POST /v1/orders` requires `Idempotency-Key: <uuid v4>`. HCPS mints one key per checkout attempt and reuses it on every retry of that attempt.
- Validate-only (4b): Golden records `(client_id, idempotency_key)` → `request_hash` + the first DETERMINATE answer (200 / 4xx)
  in `integration_order_requests` (`config/migrate-hcps-integration-v1-orders.sql`); a 503 releases the key so the same
  attempt can be retried. The answer for a key never changes; a new review (e.g. after `prices_changed`) = a new key.
- Golden stores `(tenant_id, client_id, idempotency_key)` → `request_hash` + the full first response, in one transaction with the order:
    - Same key and same body: Golden replays the stored response with `idempotent_replay:true`.
    - Concurrent duplicate while the first is still running: 409 `idempotency_in_progress` (retry).
    - Same key and a different body: 422 `idempotency_conflict`.
    - Concurrent duplicates: exactly one order.
- **PO numbers are not unique and are not an idempotency key.** Dealers reuse a PO across several orders (2026-11-02 production check: 100 dealer/PO groups, 222 orders). Golden's existing PO behaviour is preserved, and no uniqueness constraint is added.

## 7. Versioning

- Patch: wording only.
- Minor: a new route, field or code.
- Major: any rename or removal. That needs a new `golden-commerce-v2` contract served alongside v1.

# Golden Commerce API — contract v1 (golden-commerce-v1)

**Contract version:** 1.1.0 (1.0.0 frozen 2026-11-02, Stage 0 batch B0; 1.1.0 adds the Stage 2 read routes, batch B2) · **Blueprint:** `docs/FEDERATED_ARCHITECTURE.md` v1.3.0
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
| GET `/v1/config/engine` | `golden:read` | required | 3 | not built |
| POST `/v1/quote` | `golden:quote` | required | 4 | not built |
| POST `/v1/orders` | `golden:order` | required + `Idempotency-Key` | 4 | not built |
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
- Golden stores `(tenant_id, client_id, idempotency_key)` → `request_hash` + the full first response, in one transaction with the order:
    - Same key and same body: Golden replays the stored response with `idempotent_replay:true`.
    - Same key and a different body: 422 `idempotency_conflict`.
    - Concurrent duplicates: exactly one order.
- **PO numbers are not unique and are not an idempotency key.** Dealers reuse a PO across several orders (2026-11-02 production check: 100 dealer/PO groups, 222 orders). Golden's existing PO behaviour is preserved, and no uniqueness constraint is added.

## 7. Versioning

- Patch: wording only.
- Minor: a new route, field or code.
- Major: any rename or removal. That needs a new `golden-commerce-v2` contract served alongside v1.

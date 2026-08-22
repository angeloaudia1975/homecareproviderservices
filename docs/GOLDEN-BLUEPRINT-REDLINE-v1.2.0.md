# FEDERATED_ARCHITECTURE.md — Red-line to v1.2.0

Apply these exact edits to bump the blueprint from **v1.1.0 → v1.2.0**, authorizing HCPS-front-end order submission through a manufacturer's own ordering API (the Golden ⇄ Partner 360 shared-engine model). Companion detail lives in `GOLDEN-PARTNER360-INTEGRATION.md`.

---

## 1. Version header

**Find:**
```
**Version:** 1.1.0
**Status:** Adopted — architectural source of truth
```
**Replace:**
```
**Version:** 1.2.0
**Status:** Adopted — architectural source of truth
```

## 2. Changelog — add above the v1.1.0 line

**Insert immediately before** `> **Changelog v1.1.0:** …`:
```
> **Changelog v1.2.0:** Authorized **HCPS front-end order submission through a manufacturer platform's own ordering API** (§1 doctrine #2 exception; new §2.4), where the manufacturer platform remains the executing, authoritative owner of the order — enabling the Golden ⇄ Partner 360 shared-commerce-engine model (two front-ends, one Golden engine, one synchronized order record). Added `order.status.changed` to the event catalog (§5.3) and the `order_source` tag + shared `order_id` convention; added the front-end-submission direction rule (§5.4) and refined the Conformance boundary check (§13).
```

## 3. §1 Doctrine #2 — replace the boundary rule

**Find:**
```
2. **One-way at the boundary.** Manufacturer/Golden platforms **emit** events to HCPS. HCPS **MUST NOT** write into a manufacturer platform's operational workflow (its ordering, its CRM, its campaigns).
```
**Replace:**
```
2. **One-way at the boundary.** Manufacturer/Golden platforms **emit** events to HCPS. HCPS **MUST NOT** write into a manufacturer platform's operational **data** — its order tables, CRM records, campaigns, inventory, pricing, or configuration. **Exception (v1.2.0):** an HCPS front-end **MAY submit an order through a manufacturer platform's own ordering API** (§2.4), where that platform remains the executing and authoritative owner of the resulting order. This front-end submission is a client call to the manufacturer's ordering endpoint — it is **not** a direct data write and grants no other write access. Order status, tracking, inventory, pricing, catalog, and configuration remain manufacturer-authoritative and continue to flow **one-way** (manufacturer → HCPS).
```

## 4. Add §2.4 (new subsection at the end of §2)

**Insert after §2.3 (Ownership summary), before §3:**
```
### 2.4 Front-end order submission (v1.2.0)

An HCPS interface (e.g. HCPS Partner 360) MAY act as a **second front-end** on a manufacturer platform's commerce engine: it reads the manufacturer's catalog, dealer pricing, live inventory, and configurators through that platform's APIs, and submits orders through that platform's own ordering API on the dealer's behalf. Constraints:

- The manufacturer platform **mints the order**, assigns the **single shared `order_id`**, sends the confirmation, and owns every subsequent status transition. There is **one order record**, never a duplicate.
- Each order records an **`order_source`** (`"partner360"` | `"golden_platform"` | manufacturer-front-end slug) for analytics only; it does not change ownership.
- HCPS holds a **read-only mirror** of the order (per §1 #5), kept current by `order.created` / `order.status.changed` events.
- The HCPS front-end **MUST NOT** write manufacturer inventory, pricing, configuration, or order status directly. Dealer **eligibility** gates access: only dealers the manufacturer authorizes may see dealer pricing or submit orders.
- Golden independence is preserved: this path is additive and the manufacturer platform remains fully operable with the HCPS adapter disabled.
```

## 5. §5.3 Standard event catalog — add / annotate rows

**Add these rows to the §5.3 table** (after `order.completed`):
```
| `order.status.changed` | Order status transitions (acknowledged, processing, shipped, tracking available, cancelled) | `order_id`, `from`, `to`, `tracking?`, `order_source` |
```

**Annotate the existing `order.created` and `order.completed` rows** so their `data` includes the shared id + source — replace their `Key data fields` cells with:
```
`order.created`  → `order_id` (shared), `order_source`, `total`, `lines[]`
`order.completed` → `order_id` (shared), `order_source`, `total`
```

## 6. §5.4 Direction rules — add a bullet

**Find:**
```
- HCPS → Golden (Tenant 0 only, via adapter, minimal): `dealer.identity.assigned` (backfill `hcps_dealer_id`) and reference data the instance opts to consume. HCPS **MUST NOT** push operational commands.
```
**Replace:**
```
- HCPS → Golden (Tenant 0 only, via adapter, minimal): `dealer.identity.assigned` (backfill `hcps_dealer_id`) and reference data the instance opts to consume. HCPS **MUST NOT** push operational commands or write manufacturer data directly.
- HCPS → Golden **front-end order submission** (Tenant 0, v1.2.0): an authorized HCPS front-end MAY `POST` an order to Golden's own versioned ordering API (`/v1/orders`, i.e. `save-order`) on the dealer's behalf. Golden creates, owns, confirms, and advances the order and emits `order.created` / `order.status.changed` back to HCPS. This is a client call to Golden's ordering API — **not** an operational command and **not** a data write into Golden (§2.4).
```

## 7. §13 Conformance checklist — refine the boundary item

**Find:**
```
- [ ] **Boundary:** does it respect one-way federation (no HCPS→manufacturer operational writes)?
```
**Replace:**
```
- [ ] **Boundary:** does it respect one-way federation — no direct HCPS→manufacturer data writes (order tables, inventory, pricing, config, status)? Front-end order submission via the manufacturer's own ordering API (§1 #2 exception / §2.4) is permitted and is not a direct write.
```

---

## 8. Footer version line

**Find:** `*End of Master Blueprint v1.1.0 — give this file, at this version, to both the HCPS and Golden development chats.*`
**Replace:** `*End of Master Blueprint v1.2.0 — give this file, at this version, to both the HCPS and Golden development chats.*`

---

After applying, re-issue `FEDERATED_ARCHITECTURE.md` (v1.2.0) to both dev chats alongside `GOLDEN-PARTNER360-INTEGRATION.md`.

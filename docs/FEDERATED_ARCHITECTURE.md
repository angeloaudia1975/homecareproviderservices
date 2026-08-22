# HCPS ⇄ Golden — Federated Architecture Master Blueprint

**Version:** 1.2.0
**Status:** Adopted — architectural source of truth
**Owner:** Angelo Audia (HCPS)
**Applies to:** the HCPS development effort **and** the Golden Ordering Platform / Golden Admin development effort

> **Changelog v1.2.0:** Authorized **HCPS front-end order submission through a manufacturer platform's own ordering API** (§1 doctrine #2 exception; new §2.4), where the manufacturer platform remains the executing, authoritative owner of the order — enabling the Golden ⇄ Partner 360 shared-commerce-engine model (two front-ends, one Golden engine, one synchronized order record). Added `order.status.changed` to the event catalog (§5.3) and the `order_source` tag + shared `order_id` convention; added the front-end-submission direction rule (§5.4) and refined the Conformance boundary check (§13).

> **Changelog v1.1.0:** Added the **single-user Zoho operating model** (§6.1a — Zoho is a headless admin backend; reps stay in the portals). Clarified **rep-level attribution is HCPS-owned** (§6.2). Split Golden licensing into **build-ready (now)** vs **commercial activation (gated on Golden Technologies written approval)** (§10). Added **§14 DNS, registrar & email authentication**.

---

## 0. How to use this document

This is the **single source of truth** for both development projects. Neither the HCPS chat nor the Golden chat should make a major architectural change that conflicts with this blueprint. Every new feature is evaluated against it using the **Conformance Checklist (§13)**.

- Both chats should be given **this exact file, at this version**. When it changes, the version bumps and both chats re-sync to the new version.
- Normative keywords: **MUST** / **MUST NOT** (required), **SHOULD** (strongly recommended), **MAY** (optional). These carry their usual RFC-2119 meaning.
- The two projects share **standards and identifiers**, not databases. They interoperate through the **API + Event layer (§5)**, never through direct cross-database access.

**Guiding sentence:** *Shared standards and intelligence — separate applications and data boundaries.*

---

## 1. Doctrine

1. **Federation, not fusion.** The platforms cooperate through shared identifiers and a defined event stream. They do not merge into one system and do not share one database.
2. **One-way at the boundary.** Manufacturer/Golden platforms **emit** events to HCPS. HCPS **MUST NOT** write into a manufacturer platform's operational **data** — its order tables, CRM records, campaigns, inventory, pricing, or configuration. **Exception (v1.2.0):** an HCPS front-end **MAY submit an order through a manufacturer platform's own ordering API** (§2.4), where that platform remains the executing and authoritative owner of the resulting order. This front-end submission is a client call to the manufacturer's ordering endpoint — it is **not** a direct data write and grants no other write access. Order status, tracking, inventory, pricing, catalog, and configuration remain manufacturer-authoritative and continue to flow **one-way** (manufacturer → HCPS).
3. **Golden runs standalone.** The Golden platform **MUST** be fully operable with zero connection to HCPS. All HCPS ties live behind one optional, feature-flagged **HCPS Federation Adapter**. Golden core code **MUST NOT** import or hard-depend on HCPS.
4. **Manufacturers are data, not code.** Adding a manufacturer is configuration (registry + rules), never an infrastructure rewrite.
5. **One owner per data domain.** Every data domain has exactly one authoritative system (§7). Others hold read-only mirrors kept current by sync/events.
6. **Tenants never cross.** In Golden, every record is tenant-scoped; no query, export, or event may leak one tenant's data to another.
7. **Portals are the cockpit; Zoho is the backend.** Reps work exclusively in the HCPS and Golden portals (Dealer 360). Zoho is a **headless, single-administrator engine** reached through APIs/automation — reps never log into Zoho. The user path is `Rep → Dealer 360`, never `Rep → Dealer 360 → Zoho → …`.

---

## 2. System responsibilities — HCPS vs Golden

### 2.1 HCPS ecosystem (the umbrella intelligence platform)
Components: **HCPS Website · HCPS Ordering Platform · HCPS Admin Portal · HCPS Dealer 360 · Zoho CRM Plus · Dealer Engagement Engine · Campaign Studio · Analytics.**

HCPS is authoritative for the **cross-manufacturer view** of a dealer: the canonical dealer identity, the manufacturer-relationship map across all lines, commissions/sales rollups, and portfolio-wide intelligence. HCPS **consumes** federated events from every manufacturer platform (including its own Golden instance) and never controls those platforms' internal workflows.

### 2.2 Golden ecosystem (advanced, independent, license-ready)
Components: **Golden Ordering Platform · Golden Admin Portal · Golden Dealer 360 · Golden product catalog · Golden ordering history · Golden campaigns & communication.**

Golden is authoritative for **everything inside Golden**: its dealers-as-it-knows-them, its product catalog, its orders, its own CRM activity and campaigns — all tenant-scoped. The **HCPS-owned Golden instance (Tenant `hcps`)** additionally runs the Federation Adapter to publish selected standardized events to HCPS. A **licensed Golden instance** runs the same code with the adapter disabled.

### 2.3 Ownership summary

| Domain | Authoritative owner | Notes |
|---|---|---|
| Canonical dealer identity | **HCPS** | Issues `dealer_id`; see §3.9 |
| Cross-manufacturer relationship map | **HCPS** (Manufacturer Relationship Engine) | Active/Prospect/Dormant/Restricted |
| Manufacturer account numbers | **HCPS** | Org-level with branch override (existing model) |
| Commissions / sales rollups | **HCPS** | From commission imports |
| Golden dealers/orders/products/campaigns | **Golden** (per tenant) | Tenant-scoped |
| Other manufacturer orders/activity | **that manufacturer platform** | Emits events |
| Master contact records | **HCPS** (mirrored to Zoho) | Email is the natural key |
| Marketing automation / campaign delivery / pipeline | **Zoho CRM Plus** (HCPS) | Per-tenant Zoho for licensees is optional |
| Website/ordering behavioral activity | **originating platform** | Federated as events |

### 2.4 Front-end order submission (v1.2.0)

An HCPS interface (e.g. HCPS Partner 360) MAY act as a **second front-end** on a manufacturer platform's commerce engine: it reads the manufacturer's catalog, dealer pricing, live inventory, and configurators through that platform's APIs, and submits orders through that platform's own ordering API on the dealer's behalf. Constraints:

- The manufacturer platform **mints the order**, assigns the **single shared `order_id`**, sends the confirmation, and owns every subsequent status transition. There is **one order record**, never a duplicate.
- Each order records an **`order_source`** (`"partner360"` | `"golden_platform"` | manufacturer-front-end slug) for analytics only; it does not change ownership.
- HCPS holds a **read-only mirror** of the order (per §1 #5), kept current by `order.created` / `order.status.changed` events.
- The HCPS front-end **MUST NOT** write manufacturer inventory, pricing, configuration, or order status directly. Dealer **eligibility** gates access: only dealers the manufacturer authorizes may see dealer pricing or submit orders.
- Golden independence is preserved: this path is additive and the manufacturer platform remains fully operable with the HCPS adapter disabled.

---

## 3. Canonical data model & identifiers

Both systems **MUST** use these object definitions and identifier semantics in their APIs and events, even if their internal storage differs. Internal storage is each project's business; **the wire contract is shared.**

### 3.1 Identifier conventions
- All primary identifiers are **globally unique, opaque strings** (UUIDv4 recommended), stable for the life of the entity.
- `manufacturer_id` is the **exception**: it is a short, stable **slug** (e.g. `golden-technologies`, `access4u`, `strongback`) — human-readable and identical across all systems. The slug is the shared manufacturer key.
- Events and API payloads reference entities **by id**, never by display name.
- A system that mirrors another system's entity **MUST** store the origin's id as an external reference (e.g. `hcps_dealer_id`) rather than minting a conflicting local meaning.

### 3.2 Dealer — `dealer_id`
The **organization** (the top-level company). Canonical `dealer_id` is issued and owned by HCPS.
Core fields: `dealer_id`, `legal_name`, `display_name`, `status`, `primary_branch_id`, `created_at`.
> HCPS today models branches as dealer rows linked by `parent_id`; in the **canonical model** the organization is a *Dealer* and each location is a *Branch*. HCPS maps its parent/child rows onto this canonical Dealer/Branch split at the API boundary.

### 3.3 Branch — `branch_id`
A **physical location** belonging to exactly one Dealer.
Core fields: `branch_id`, `dealer_id`, `name`, `address`, `city`, `state`, `zip`, `is_primary`, `status`.
Rule: **branches never nest.** A branch belongs directly to a Dealer.

### 3.4 Manufacturer — `manufacturer_id` (slug)
A product line / brand HCPS represents.
Core fields: `manufacturer_id` (slug), `name`, `active`, `brand` (colors/logo/voice), `ordering_url` (optional), `campaign_rules`.

### 3.5 Manufacturer Relationship — (`dealer_id` + `manufacturer_id`)
The relationship between a dealer and a manufacturer. **This is the heart of the model.**
Core fields:
`dealer_id`, `manufacturer_id`, `account_number`, `status` (`active|prospect|dormant|restricted`), `flagship_level` (nullable, e.g. `golden:L2`, `mobility:L3`), `restrictions` (e.g. `["ovation:no_contact"]`), `branch_overrides[]` (optional per-branch `account_number`), `updated_at`.
Rules:
- Account numbers are **organization-level** by default; a `branch_override` sets a distinct number for one branch (existing "fill-blanks, never clobber" rule).
- `status` transitions follow the state machine in **§6.3**.

### 3.6 Contact — `contact_id`
A person at a dealer/branch.
Core fields: `contact_id`, `dealer_id`, `branch_id` (nullable), `first_name`, `last_name`, `email`, `phone`, `title`, `role`, `email_eligibility` (per-manufacturer opt state), `is_primary`.
Natural key for CRM/marketing matching: **email** (lowercased).

### 3.7 Product — (`manufacturer_id` + `product_id`)
A catalog item, always namespaced by manufacturer.
Core fields: `manufacturer_id`, `product_id` (SKU/model, e.g. `PR519`), `name`, `category`, `active`.
The manufacturer platform owns its catalog; HCPS only needs `(manufacturer_id, product_id, name)` to interpret activity.

### 3.8 Dealer Activity — event record
A single behavioral event: **dealer + branch + manufacturer + product + event + context.** Defined by the Event Envelope (§5.2). Activity is **append-only**; it is never edited, only recorded.

### 3.9 Tenant — `tenant_id`
An independent Golden deployment. `tenant_id = "hcps"` is the HCPS-owned instance (**Tenant 0**). Each licensee is its own `tenant_id`. Every Golden record **MUST** carry a `tenant_id`. `tenant_id` **MUST NOT** appear in HCPS's own core tables (HCPS is a single tenant from its own perspective); it appears on federated events so HCPS knows the source instance.

### 3.10 Cross-system identity (how two databases agree on "the same dealer")
- The **HCPS-owned Golden instance** stores the canonical HCPS `dealer_id` on each of its dealers as `hcps_dealer_id`. Federated events carry both the Golden-local id and `hcps_dealer_id` when known.
- Matching when `hcps_dealer_id` is absent: HCPS resolves identity by the same alias/normalization rules already used (name + address/zip), then backfills `hcps_dealer_id` into Golden via the adapter.
- **Licensee instances have no `hcps_dealer_id`** and never federate — their dealers are theirs alone.

---

## 4. Tenant model

1. Golden is **multi-tenant from day one.** `tenant_id` scopes every record, query, export, campaign, and analytics view.
2. **Tenant 0 (`hcps`)** = the HCPS-owned Golden instance; it enables the Federation Adapter.
3. **Licensee tenants** are fully isolated: own dealers, branches, orders, CRM data, campaigns, analytics, branding, and users. A licensee **MUST NOT** be able to read HCPS data or any other tenant's data by any path (query, API, export, event).
4. Isolation approach: **row-level `tenant_id` scoping** is the baseline; a large licensee **MAY** be graduated to a dedicated schema/instance without changing the contract.
5. Every data-access path (API handler, query, background job) **MUST** enforce the caller's `tenant_id`. Absence of a `tenant_id` filter on a tenant-scoped table is a defect.

---

## 5. API & Event standards

The two platforms communicate **only** through this layer. No shared DB, no cross-database joins.

### 5.1 Transport & security
- **HTTPS only.** JSON payloads. Versioned routes (`/v1/...`).
- Every event/webhook is **signed** (HMAC-SHA256 over the raw body using a per-source shared secret); receivers **MUST** verify the signature and reject on mismatch.
- Delivery is **at-least-once**; every event carries a unique `event_id` and consumers **MUST** be idempotent (dedupe on `event_id`).
- Failed deliveries retry with backoff. Receivers return `2xx` only after durable acceptance.
- Auth for request/response APIs: bearer tokens scoped to a `tenant_id` and a least-privilege scope set. A token for one tenant **MUST NOT** access another.

### 5.2 Canonical Event Envelope
Every federated event uses this envelope. Producers include all fields they know; unknown optional fields are omitted (not null-spammed).

```json
{
  "event": "product.viewed",
  "event_id": "evt_9f2c…",            // globally unique; idempotency key
  "event_version": "1.0",
  "occurred_at": "2026-08-12T15:04:05Z",
  "source": { "system": "golden", "tenant_id": "hcps" },
  "dealer": { "dealer_id": "dlr_…", "hcps_dealer_id": "dlr_…" },
  "branch_id": "brn_…",                // nullable
  "contact_id": "cnt_…",               // nullable
  "manufacturer_id": "golden-technologies",
  "product": { "product_id": "PR519", "name": "Lift Chair PR519" }, // when relevant
  "actor": { "type": "dealer_user", "id": "usr_…" },                // nullable
  "data": { },                          // event-specific payload
  "idempotency_key": "evt_9f2c…"
}
```

### 5.3 Standard event catalog (v1)
Both projects **MUST** use these exact event names. New events are added by version bump, never renamed.

| Event | Emitted when | Key `data` fields |
|---|---|---|
| `dealer.login` | A dealer user authenticates | `session_id` |
| `product.viewed` | A product page/detail is viewed | `dwell_ms` |
| `product.clicked` | A product/promo is clicked | `placement` |
| `product.added_to_cart` | Item added to cart | `qty` |
| `cart.abandoned` | Cart idle past threshold | `cart_value`, `items[]` |
| `order.created` | Order submitted (from any authorized front-end) | `order_id` (shared), `order_source`, `total`, `lines[]` |
| `order.status.changed` | Order status transitions (acknowledged, processing, shipped, tracking available, cancelled) | `order_id`, `from`, `to`, `tracking?`, `order_source` |
| `order.completed` | Order finalized/shipped | `order_id` (shared), `order_source`, `total` |
| `email.sent` | Marketing/transactional email sent | `campaign_id`, `email` |
| `email.opened` | Email opened | `campaign_id` |
| `email.clicked` | Email link clicked | `campaign_id`, `url` |
| `manufacturer.account.updated` | Account number/status changed | `account_number`, `status` |
| `dealer.status.changed` | Relationship status transitions | `manufacturer_id`, `from`, `to` |
| `dealer.interest.updated` | Engagement Engine recomputes interest | `manufacturer_id`, `score`, `signals[]` |

### 5.4 Direction rules
- Manufacturer/Golden → HCPS: **all** catalog events above (behavioral + order + email).
- HCPS → Golden (Tenant 0 only, via adapter, minimal): `dealer.identity.assigned` (backfill `hcps_dealer_id`) and reference data the instance opts to consume. HCPS **MUST NOT** push operational commands or write manufacturer data directly.
- HCPS → Golden **front-end order submission** (Tenant 0, v1.2.0): an authorized HCPS front-end MAY `POST` an order to Golden's own versioned ordering API (`/v1/orders`, i.e. `save-order`) on the dealer's behalf. Golden creates, owns, confirms, and advances the order and emits `order.created` / `order.status.changed` back to HCPS. This is a client call to Golden's ordering API — **not** an operational command and **not** a data write into Golden (§2.4).
- HCPS internal (Zoho/Dealer 360/Engagement Engine) uses the same envelope for consistency.

---

## 6. Component responsibilities (contracts)

### 6.1 Zoho CRM Plus (HCPS)
Owns: master dealer/contact mirror, marketing automation, campaign delivery, sales pipeline/opportunities, BI (Analytics), Zia AI.
Contract: receives dealer/contact/segment data **from** HCPS (HCPS is authoritative); emits campaign/pipeline events **to** HCPS Dealer 360. Custom fields hold manufacturer accounts, flagship level, and relationship status for segmentation. For licensees, Zoho is an **optional per-tenant connector**, never required.

#### 6.1a Zoho operating model — single administrator, headless
HCPS runs **one** Zoho CRM Plus Enterprise seat (the administrator). Field reps are **not** Zoho users — they work in the portals, and Dealer 360 surfaces whatever Zoho intelligence they need. Consequences the build **MUST** honor:
- **Integration is server-to-server**, via Zoho API credentials (self-client / OAuth) tied to the admin account — **not** per-user seats. Adding reps to Zoho is out of scope.
- **Record ownership in Zoho is single-owner** (the admin). Zoho's per-user features (owner assignment, per-rep dashboards, rep leaderboards *inside Zoho*) are **not** used.
- Therefore **rep-level attribution, assignment, activity, and performance are HCPS-owned** and computed/displayed in Dealer 360 (see §6.2), never in Zoho.
- Zoho earns its keep as the **engine**: master records, marketing automation, Campaigns, Analytics, and Zia — all driven by API from HCPS and surfaced back into the portals.

### 6.2 HCPS Dealer 360
Owns: the assembled cross-manufacturer profile (the cockpit). Reads from every engine + federated events; writes dealer master edits. It is a **read/assemble** surface for federated data, **authoritative** only for the canonical dealer/branch/contact/relationship master.
Because Zoho is single-user (§6.1a), Dealer 360 is also the **authoritative home for rep-level data** — rep assignment to dealers, rep activity/touches, and rep performance/attribution. Zoho holds none of this per-rep; HCPS computes it and shows it to reps in the portal.

### 6.3 Manufacturer Relationship Engine (MRE)
Computes, per `(dealer_id, manufacturer_id)`, exactly one `status`:

```
                 has active account + recent orders
   prospect ───────────────▶ active
      ▲                        │  no orders past window
      │ becomes eligible       ▼
      └──────── dormant ◀── active
   restricted  (terminal until rule lifted; overrides all — never targeted)
```

- `active`: account on file **and** ordering within the recency window.
- `prospect`: eligible, no active relationship yet.
- `dormant`: previously active, silent past threshold → reactivation eligible.
- `restricted`: explicit do-not-target (e.g. Ovation `Access Denied`); **overrides** any other status for messaging.
- Emits `dealer.status.changed` on transition. Reads existing `dealer_manufacturers`, `monthly_sales`, and restriction flags — it is computed intelligence, not a new master store.

### 6.4 Dealer Engagement Engine
Owns: interest detection, scoring, next-best-action. Consumes federated activity + MRE status; produces a per-manufacturer interest score and recommended actions; emits `dealer.interest.updated`. It **routes** which manufacturer relationship and communication path apply (§6.5). Combines HCPS behavioral signals with Zia predictions.

### 6.5 Campaign & email architecture
- **Routing by relationship + context**, never one generic blast. Golden activity → Golden-branded path; Strongback → Strongback path; Access4U → Access4U path; corporate → HCPS path.
- **Suppression is mandatory and global per manufacturer:** any `restricted` relationship is excluded from that manufacturer's sends, everywhere, always.
- **Channel split:** transactional/1:1 mail **MAY** use Resend directly; bulk marketing/journeys use Zoho Campaigns/Marketing Automation. Both emit `email.*` events back to Dealer 360.
- A licensee tenant uses its **own** sending identity/connector; sends never cross tenants.

### 6.6 Analytics architecture
- Zoho Analytics blends Zoho data (pipeline, campaigns, tickets) with HCPS data (dealers, commissions, activity) via connector; dashboards embed in the Admin Portal.
- Per-tenant analytics for Golden; **only Tenant 0 rolls up into HCPS BI.** Licensee analytics stay within the licensee tenant.

---

## 7. Data ownership & source-of-truth matrix

| Data domain | Owner (writes) | Readers (mirror) | Sync direction |
|---|---|---|---|
| Canonical dealer/branch/contact master | HCPS | Zoho, Golden(T0) | HCPS → others |
| Manufacturer accounts / flagship / restrictions | HCPS | Zoho, Golden(T0) | HCPS → others |
| Relationship status (MRE) | HCPS | Zoho, Dealer 360 | HCPS internal → Zoho |
| Commissions / sales | HCPS | Zoho, Analytics | HCPS → Zoho (rollup) |
| Golden dealers/orders/products/campaigns | Golden (per tenant) | HCPS (as events) | Golden → HCPS (events) |
| Other manufacturer orders/activity | that platform | HCPS (as events) | platform → HCPS |
| Campaigns / pipeline / marketing automation | Zoho | Dealer 360 | Zoho → HCPS (events) |
| Behavioral activity | originating platform | HCPS | platform → HCPS (events) |

**Rule:** a mirror is never edited directly; it is corrected at its owner and re-synced.

---

## 8. Synchronization rules

1. **Events, not database links.** Golden ↔ HCPS synchronize via the Event layer only. Neither reads the other's database.
2. **Idempotent upserts** keyed by canonical ids (`dealer_id`, `manufacturer_id`, `event_id`). Re-processing an event **MUST** be safe.
3. **One-way per domain.** Follow §7; never write back into another system's owned domain.
4. **Conflict resolution:** the domain owner always wins; mirrors converge to the owner. There is no two-way merge.
5. **Identity backfill:** HCPS resolves and returns `hcps_dealer_id` so future Golden events are pre-linked.
6. **No PII in URLs/query strings.** PII travels in signed request bodies only.
7. **Ordering & lateness:** consumers tolerate out-of-order and late events (use `occurred_at`, not receipt time, for state).

---

## 9. Security boundaries

- **Tenant isolation** is the top invariant: every tenant-scoped access enforces `tenant_id`; no cross-tenant read by any path.
- **Signed events** (HMAC) + **scoped bearer tokens**; least privilege; per-tenant secrets. Rotating a tenant's secret **MUST NOT** affect another tenant.
- **HCPS availability independence:** a Zoho or HCPS outage **MUST NOT** block core operations of any Golden instance. Federation degrades gracefully (queue + retry).
- **Auditability:** account/relationship changes and cross-tenant-relevant actions are logged.
- **Prohibited by design:** credentials, financial trades/transfers, and destructive bulk deletes are never automated by either platform's agents; a human performs them.

---

## 10. Golden licensing requirements

> **Gating (v1.1.0): build-ready now, activate later.** The commercial licensing program is **held pending written approval from Golden Technologies** and **MUST NOT** be activated before it. Two clearly separated tracks:
> - **Build-ready (proceed now):** the *technical* capabilities below — tenancy, adapter isolation, per-tenant config — are built and tested against a single tenant (`hcps`). This is design/plumbing only; it commercializes nothing.
> - **Commercial activation (blocked until approval):** external tenant *provisioning*, licensing agreements, billing, licensee onboarding, isolated per-licensee databases/deployments, and marketing the offer. None of this is switched on until Golden Technologies approves.
> Building the plumbing early is what prevents a later redesign; keeping activation gated is what keeps you from getting ahead of Golden's approval.

The Golden platform **MUST** satisfy all of the following, designed in from the start (not retrofitted):

1. **Standalone operation.** Runs with zero HCPS connectivity. Disabling the Federation Adapter yields a complete product.
2. **Adapter-isolated HCPS ties.** All HCPS integration lives behind one optional, feature-flagged adapter. Golden core has no HCPS imports/dependencies.
3. **Full tenancy.** `tenant_id` on every record; strict scoping; provisioning flow for a new tenant (dealers, users, branding).
4. **Per-tenant everything.** Dealers, territory, orders, CRM data, campaigns, analytics, branding, users — all isolated.
5. **Optional per-tenant marketing connector.** A licensee may connect their own Zoho/Resend; Tenant 0 connects HCPS's.
6. **Data guarantee.** A licensee sees only their own data; never HCPS or another licensee. Isolation is covered by explicit tests.
7. **Same codebase, config-driven differences.** HCPS's instance differs from a licensee's only by configuration (adapter on, HCPS connectors), not by forked code.

---

## 11. Change control & governance

- This document is **versioned** (semver). Breaking changes to identifiers, the envelope, or event names bump **major**; additive changes bump **minor**; clarifications bump **patch**.
- On any change, **both chats must be re-synced** to the new version before continuing architectural work.
- Each project keeps this file committed in-repo (e.g. `docs/FEDERATED_ARCHITECTURE.md`) at the version it is building against.
- Disagreements are resolved by updating **this** document first, then the code — never the reverse.

---

## 12. Glossary (shared vocabulary)

**Dealer** organization · **Branch** location under a dealer · **Manufacturer** product line (slug id) · **Manufacturer Relationship** dealer×manufacturer with account + status · **Contact** person · **Product** manufacturer-namespaced catalog item · **Activity** append-only behavioral event · **Tenant** an independent Golden deployment · **Tenant 0** the HCPS-owned Golden instance · **Federation Adapter** the optional module carrying Golden↔HCPS ties · **MRE** Manufacturer Relationship Engine · **Cockpit** HCPS Dealer 360 · **Engine** Zoho / MRE / Engagement Engine.

---

## 13. Conformance checklist (apply to every new feature, in either chat)

Before building a feature, confirm:

- [ ] **Boundary:** does it respect one-way federation — no direct HCPS→manufacturer data writes (order tables, inventory, pricing, config, status)? Front-end order submission via the manufacturer's own ordering API (§1 #2 exception / §2.4) is permitted and is not a direct write.
- [ ] **Golden independence:** would Golden still work with the HCPS adapter disabled?
- [ ] **Identifiers:** does it use canonical ids (`dealer_id`, `branch_id`, `manufacturer_id` slug, `contact_id`, `product_id`, `tenant_id`) on the wire?
- [ ] **Ownership:** does it write only to a domain this system owns (§7)?
- [ ] **Tenant safety:** is every tenant-scoped access filtered by `tenant_id`? No cross-tenant path?
- [ ] **Events:** does it emit/consume standard events (§5.3) with the signed envelope, idempotently?
- [ ] **Messaging:** does it route by manufacturer relationship and honor `restricted` suppression?
- [ ] **Sync:** are mirrors updated from their owner, not edited directly?
- [ ] **Security:** signed, scoped, PII out of URLs, degrades gracefully if HCPS/Zoho is down?
- [ ] **Licensing:** for Golden — same codebase, config-driven, isolation testable?

If any box is unchecked, revise the design or amend this blueprint (with a version bump) before building.

---

## 14. DNS, registrar & email authentication

**Principle:** the **domain registrar and the DNS host are separable.** You do not move the registrar to gain DNS control — you delegate DNS. What the architecture actually needs is reliable control over records, not a particular registrar.

**Records this platform will require** (as integrations come online): `A`/`CNAME` for Netlify, API subdomains, **SPF**, **DKIM**, **DMARC**, plus **verification TXT** for Zoho and Resend, Cloudflare config, and SSL/TLS. Marketing deliverability (Zoho Campaigns + Resend) depends on SPF/DKIM/DMARC being correct.

**Stance (adopted):** keep `homecareproviderservices.org` at its current registrar (Weebly/Register.com) **for now**. Do **not** transfer mid-build — a registrar move during active integration adds an unnecessary variable. Sequence: *stabilize DNS + platform integrations → implement Zoho CRM Plus → complete the federated architecture → then evaluate the registrar/DNS host separately.*

**Insight / trigger to act:** the likely forcing function is **email authentication**. Zoho and Resend both need SPF/DKIM/DMARC and verification TXT records, and Weebly's DNS editor is limited (we already hit this during the SSL work). When adding those records fights you, the clean fix is **not** a registrar transfer — it's delegating DNS to **Cloudflare** (which uses **two** nameservers, and Weebly accepts two), keeping Weebly as registrar. That gives full record control for email auth and subdomains without a transfer, and can be done as one planned cutover once current integrations are stable.

---

*End of Master Blueprint v1.2.0 — give this file, at this version, to both the HCPS and Golden development chats.*

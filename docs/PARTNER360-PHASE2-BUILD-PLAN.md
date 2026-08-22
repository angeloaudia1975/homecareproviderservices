# HCPS Partner 360 — Phase 2 Build Plan (spec → live platform)

**Goal:** implement the approved **Direction A** design and the **HCPS Partner 360** brand directly into the live ordering portal (`homecareproviderservicesordering/public/index.html`), reusing the existing commerce engine and every proven tool — delivered in **reviewable stages**, verified headlessly, never auto-pushed to the live store.

## Operating principles

- **One platform.** Everything lands in the portal SPA (`index.html`) — its tab nav (`#tabs`), content mount (`#content`), `AUTH`/`CONFIG`, and `selectManufacturer` router. The standalone `dashboard.html` is retired once its views are folded in.
- **Reuse, don't rebuild.** Re-home proven code rather than rewriting: the Phase 1–5 business-tool views, the Access4U ramp calculator, and the Golden showroom engine all move over intact; only the skin and integration change.
- **Backend already exists.** `dealer-auth`, `order-history-api`, `dealer-tools-api`, `orders-api` are live and returning real data. No backend rewrites — new work is front-end integration + the Golden APIs.
- **Safety.** Each stage is built on a working copy, verified with the headless harness (`node --check` on functions + mocked-API render walkthroughs), and delivered as a reviewable `index.html` with any SQL migrations documented. Nothing is pushed to the live store by me; you review and deploy.

## What we build on

The portal is already a single-app SPA with catalog-by-line, cart, checkout, reorder, a signed-in home dashboard, and auth. Partner 360 = that engine, reskinned, dashboard-first, with the business tools and configurators folded into the same nav.

---

## Stage 0 — Prep & safety
- Branch the ordering repo; snapshot `index.html`.
- Stand up the verification harness for the portal (mocked `dealer-auth` / `order-history-api` / `dealer-tools-api` / `/data/*.json`, pinned headless Chromium) so every stage is render-verified before delivery.
- **Deliver:** nothing yet — this is scaffolding.

## Stage 1 — Shell reskin + Partner 360 brand
- Apply the Direction A design system to the portal shell: tokens (ink / HCPS blue / orange→gold / paper), Archivo + Inter, the top strip + app header + top nav, the orange→gold gradient CTAs, card styling, hover/slide-in animation.
- Brand lockup: "HCPS Partner 360 · by HomeCare Provider Services"; "Partner 360 Login" / "Launch Partner 360" on the auth screen.
- Make an approved dealer **land on the dashboard** (dashboard-first).
- **Verify:** render login → dashboard landing; nav highlights; no JS errors.
- **Deliver:** reskinned `index.html` (shell only), reviewable.

## Stage 2 — Fold the business tools into the portal
Re-home the Phase 1–5 views from `dashboard.html` into the portal SPA as sections of the one nav, wired to the existing backend:
- **Dashboard** (KPIs, recent orders, monthly + by-manufacturer, "Grow your business" intelligence) → `order-history-api`.
- **Reports & Margin** (retail-margin math, exports) · **Quotes** · **Account & Pricing** (credit apps, resale cert, terms, pricing export — no card storage) · **Resources** → `dealer-tools-api`.
- Reconcile globals (portal `AUTH`/`CONFIG` vs the dashboard's `SESSION`/`api()`); add `HISTORY_ENDPOINT` + `TOOLS_ENDPOINT` to `CONFIG`.
- Retire `dashboard.html`.
- **Verify:** click through every tab against mocked APIs; 0 JS errors (same harness that passed Phase 5).
- **Deliver:** `index.html` with all business tabs live; migration notes carried forward.

## Stage 3 — Shop deepening
- **Product Detail** as a Shop drill-in state (breadcrumb + back; gallery, specs, warranty, documents, accessories, related, ordering) — not a new nav item.
- **Cart & Checkout** polished to Direction A: grouped by manufacturer with credit/prepay terms, no card storage, HCPS confirmations + tracking.
- Add the **global product search** in the header (name/SKU across the dealer's lines).
- **Deliver:** Shop + Product Detail + Cart in the Partner 360 skin.

## Stage 4 — Quotes & Configurators
- **Quotes & Configurators hub** (reached from the Quotes nav): quick customer quote + advanced configurators + saved projects.
- **Access4U Ramp Designer:** re-home the existing calculator **preserving its logic exactly** (SR3/RR/PS/GP/GATE/STP/PRK families, ADA 1:12 check, plan diagram, 23% aluminum surcharge, shipping) into the Partner 360 skin; add the enhancements — per-dealer Access4U tier pricing, save/reopen project, generate customer quote, export/print, and **convert to order** flowing into order history + reports.
- **Verify:** ramp math parity against the current calculator (identical BOM + totals for sample configs).
- **Deliver:** Configurators hub + Ramp Designer.

## Stage 5 — Showroom Builder (private-label the proven engine)
- Lift the Golden dealer portal's **Showroom Design engine** (grid floor editor, drag-and-drop placement, icon set, pricing/profit math, revenue opportunity, multi-floorplan save/rename/switch + CRUD) and **rebrand** it to Partner 360 (palette, typography, buttons, cards, animation).
- **Expand product data** from Golden-only to the full HCPS multi-manufacturer catalog.
- **Verify:** placement, calculations, and saved-floorplan round-trip intact after reskin.
- **Deliver:** Partner 360 Showroom Builder.

## Stage 6 — Golden integration (per FEDERATED_ARCHITECTURE v1.2.0 + integration spec)
Sequenced exactly as the integration spec's four phases:
1. **Connect** — Partner 360 reads Golden catalog, dealer pricing, live inventory, and order history via Golden's APIs (`get-portal-data`), gated by dealer identity + Golden eligibility. *Note: Golden → HCPS order sync already runs (`save-order` emits; `order-history-api` ingests `source="golden"`), so consolidated history is partly live already.*
2. **Configure & order** — reuse Golden configurators; Partner 360 submits Golden orders through Golden's own `save-order` (the §2.4 front-end-submission path), minting the shared `order_id` + `order_source`.
3. **Status & tracking sync** — surface the full lifecycle (submitted → acknowledged → processing → shipped → tracking available → completed / cancelled) from `order.status.changed` events in both UIs.
4. **Business layer** — feed Golden transactions into Partner 360 reports, showroom analysis, reorder recommendations, revenue, favorites, and business-development tools.
- **Prereq:** adopt blueprint **v1.2.0** (already drafted) and re-issue to both dev efforts.

---

## Sequencing & dependencies

```
Stage 0 (prep)
  └─ Stage 1 (shell + brand)
       └─ Stage 2 (business tools)   ← retires dashboard.html
            ├─ Stage 3 (shop + product detail + cart + search)
            ├─ Stage 4 (quotes & configurators — Access4U)
            └─ Stage 5 (showroom builder)
                 └─ Stage 6 (Golden integration 1→2→3→4)  ← needs blueprint v1.2.0
```

Stages 3–5 are independent of each other and can run in any order (or in parallel) once Stage 2 lands. Stage 6 benefits from Stages 2–5 being in place (so Golden data flows into the reports/showroom/reorder surfaces) and requires the v1.2.0 adoption before its Phase 2 (ordering).

## Delivery & verification (every stage)
- Built on a working copy; `node --check` on any touched function; headless render walkthrough against mocked APIs (the harness that verified Phases 1–5 with 0 JS errors).
- Delivered as a reviewable `index.html` (+ any function changes and documented SQL migrations). You review and deploy; nothing auto-pushed to the live store.
- Reversible: each stage is additive to the shell; the working commerce engine (catalog/cart/checkout) is reused, not replaced.

## Open items for you
- Confirm the **nav label** ("Quotes" vs "Quotes & Configurators").
- Adopt blueprint **v1.2.0** (version bump) so Golden Stage 6 is conformant.
- Confirm you want me to build on a **branch** and deliver reviewable files (recommended) rather than push.

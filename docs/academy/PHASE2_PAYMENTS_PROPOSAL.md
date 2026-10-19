# HCPS Academy — Phase 2: paid course access (implementation proposal)

Status: **built on branch `academy/phase2-commerce` (19 Oct 2026) with the agreed defaults — see `PHASE2_COMMERCE.md`. M8 not run in production; no live payment possible.** Original proposal below. Phase 1 shows prices as "coming soon"
and takes no payment. Each numbered owner decision below must be settled before Phase 2 code starts.

## 1. Who is an "eligible HCPS network dealer" (free) — what the data supports today

| Signal (existing) | Where | Use |
|---|---|---|
| `dealers.status` | Dealer 360 / dealers-api | `active` = in the network today (dormant / closed accounts excluded) |
| `dealers.account_class` | Dealer 360 › Edit company info (President/Admin) | blank / `dealer` eligible; `prospect`, `manufacturer`, `vendor`, `service_provider`, `internal`, `not_relevant` not eligible |
| `dealers.parent_id` | dealer families | a branch inherits its head office's eligibility (same rule as Training Manager scope, D3) |
| `dealers.is_test` | everywhere | TEST dealers: pilot only, never billed |
| `dealer_users` (approved) | Partner 360 | proof the person works for that dealer (handoff already uses it) |
| purchase / commission history (`monthly_sales`, `dealer_engagement`) | Analytics | optional "bought from an HCPS line in the last N months" rule |

**Proposed rule:** eligible = `status = active` AND `account_class` blank or `dealer` AND not TEST, evaluated on the
head office for a branch. One server function (`_academy_eligibility.js`) decides it, used by enrollment and checkout
alike; the President can override per dealer (audited) for edge cases.
**Owner decision 1:** confirm the rule (and whether a recent-purchase test is added).

## 2. Per-course pricing, editable in Connect 360

- New columns on `academy_course_versions` (or a small `academy_prices` table, RULE 19 locked): `price_outside_cents`,
  `currency`, `network_included boolean`, `premium_rule text|null` — written only by an audited President operation
  (`academy_price_op_set`), never on a published version's immutable content (price is commercial metadata, versioned
  with its own history row).
- Command Center → Courses → **Pricing** panel: price for outside dealers, "included for HCPS dealers" toggle, premium
  eligibility note. The public landing page reads the published price instead of the editor's display text.
- Golden course proposed price $19.99; floor $9.99 for other courses. **Owner decision 2:** final prices.

## 3. Checkout and enrollment (Stripe Checkout)

```
Outside buyer → /academy/ "Buy course" → academy-checkout (server) creates a Stripe Checkout Session
   (price from the database, never from the browser; metadata = course version + buyer org id + idempotency key)
→ Stripe hosted payment page (card data never touches HCPS)
→ Stripe webhook → academy-stripe-webhook: verify the Stripe-Signature with STRIPE_WEBHOOK_SECRET (raw body),
   ignore anything unsigned → one audited database operation academy_purchase_op_grant(session_id …):
   unique on the Stripe session id (a replayed or duplicated webhook grants nothing twice) → membership + enrollment
→ email receipt via Resend (ACADEMY_MAIL_FROM)
```

- Access is granted **only** by the verified webhook, never by the browser's success page.
- Duplicate payment protection: one open Checkout Session per buyer + course (re-use it); the grant is idempotent on
  the session id; an already-enrolled buyer is told so before paying.
- Purchase history: `academy_purchases` (session id, payment intent id, amount, currency, buyer, course version, status
  paid / refunded / disputed, timestamps) — RULE 19 locked, written only by the grant / refund operations; visible to
  the President in the Command Center and to the buyer on "My purchases".
- Refunds: issued in Stripe (or from the Command Center through the Stripe API, President only); the
  `charge.refunded` webhook → `academy_purchase_op_refund` withdraws the enrollment (audited). **Owner decision 3:**
  refund window, and whether a certificate already earned stays valid after a refund (recommended: stays — it was earned).
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Netlify, Functions + Production scope, entered by the owner.
  **Owner decision 4 / external cost:** a Stripe account in HCPS's name (fees ~2.9% + 30¢ per card payment in the US).

## 4. Outside dealerships without weakening tenant security

- Outside buyers are **not** added to the CRM `dealers` table (keeps Dealer 360, reps' books, analytics and Zoho clean).
  New `academy_organizations` (outside company name, contact, created by purchase) — RULE 19 locked; memberships gain an
  `organization_id` alternative to `dealer_id` (exactly one set), with the same Training Manager scope rules.
- Outside learners sign in with the same Academy-only email codes; the pilot/eligibility gate decides which dealers
  are free; nothing about an outside organization is visible to HCPS dealers or reps, and vice versa.
- Every existing isolation test (Training Manager scope, cross-dealer refusal, no score to reps) is re-run with an
  outside organization added; M5–M7 security behaviour is unchanged.

## 5. Manufacturer permissions for commercial training

Golden confirmed (10 Oct 2026) that approved education materials may be **used**; selling a course that contains
Golden photography, videos or product content to non-network dealers is a **commercial use** not yet confirmed.
**Owner decision 5:** obtain Golden's written permission for paid outside access to the Golden course (or offer it free
/ network-only). Same check per manufacturer for every future paid course; record it on the course (rights field).

## 6. Order of work once the decisions are made

1. Eligibility function + President override (no payments) → tests.
2. Pricing table / panel + landing page reading real prices → tests.
3. `academy_organizations` + outside memberships + isolation re-run → tests (migration, owner-run).
4. Stripe Checkout + verified webhook + purchases + refunds in Stripe **test mode** on a staging/deploy-preview host.
5. Pilot with one friendly outside dealer → switch `academy_payments` on.

Estimated: 2–3 working sessions of build + tests, one owner-run migration, and the Stripe account setup.

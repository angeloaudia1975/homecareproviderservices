# HCPS Academy — Phase 2: eligibility, pricing, outside dealerships, Stripe (runbook)

Status: **built on branch `academy/phase2-commerce` (draft PR). Migration M8 NOT run in production. No live payment
can be taken:** sales need the `academy_payments` switch, a Stripe key and the webhook secret; LIVE payments also need
`academy_payments_live`, a live key, and manufacturer commercial permission recorded on the course. TEST mode sells only
TEST courses (slug `test-…`), so a Stripe test card can never open a real course.

Defaults applied (PR #25 comment 6278300397; proposal `PHASE2_PAYMENTS_PROPOSAL.md`):

| Topic | Built behaviour |
|---|---|
| Free eligibility | Dealer AND its head office: `status = active`, `account_class` blank or `dealer`, not TEST. No recent-purchase test. President override (reason, audited, append-only) on the dealer or its head office wins. Prospects, manufacturers, vendors, internal, inactive and TEST accounts pay. One function: `academy_commerce_eligibility`. |
| Who is "already covered" | An approved Partner 360 login (`dealer_users`) or an active Academy membership at an eligible dealer → checkout answers "included, sign in" instead of charging. |
| Prices | One row per course (`academy_course_prices`), separate from immutable course versions; publishing never freezes a price. President only; every change with its reason in `academy_course_price_history`. Golden course recorded at $19.99, **not on sale**. |
| Marketing page | Unchanged: "Paid course access coming soon" until checkout is live. |
| Outside dealerships | `academy_organizations` (Academy-only). A buyer's access = membership with `organization_id` (never a dealer), role learner, access `purchased`. Never in Dealer 360, reps' books, analytics, Zoho, Training Manager teams or dealership figures; shown apart in the Command Center. |
| Checkout | Stripe hosted Checkout, cards only. Server opens a checkout at the DATABASE price; one open checkout per buyer + course; Stripe Idempotency-Key per checkout; rate limit 5/address and 10/network address per hour. |
| Access | Granted ONLY by the signature-verified webhook (`academy-stripe-webhook`), idempotent on the Stripe event id and the Checkout Session id; amount, currency and mode must equal the checkout's or nothing is granted (recorded for review). |
| Refunds | Buyer may ask within **14 days**; President approves/declines (reason, audited); approval sends the refund to Stripe with an idempotency key; access ends when Stripe's signed `charge.refunded` arrives. A completed course and any earned certificate are **kept**. Partial refunds recorded; a late smaller total never lowers the record. |
| Abuse review | Two refunds in 12 months → next purchase waits for a President buyer review (allow / block, audited). Disputes mark the purchase for review. |
| Manufacturer rights | `rights_status` per course; LIVE sale impossible (database check) until `confirmed` with a reference. Golden's education-use permission is NOT recorded as commercial permission. |

## Files

- `supabase/academy_p2_m8_commerce.sql` (+ `_rollback.sql`, `_postcheck.sql`) — 8 tables, 21 functions (11 operations +
  eligibility callable by the server), guards. M1–M7 functions byte-identical.
- `netlify/functions/_academy_commerce.js` (Stripe: signature check, sessions, refunds), `academy-checkout.js` (public),
  `academy-stripe-webhook.js`, `_academy_commerce_admin.js` (Command Center actions), learner `my_purchases` /
  `refund_request`.
- Pages: `/academy/buy/`, `/academy/buy/done/`; learner "My purchases"; Command Center → Learners & Dealerships →
  **Pricing & purchases**.
- Tests: `test/academy-p2.pg.test.js` (37 + 5 browser checks at 390 / 1280 px, real Postgres 16 with pg-safeupdate), `test/academy-p2.test.js` (8 unit),
  `test/academy-p2.mutants.js` (25 mutants).

## Order of work in production (each step separately)

1. **Owner:** Stripe account in HCPS's name (see "What Angelo provides").
2. **Owner runs M8** in the SQL editor (preflight = `academy_p2_m8_postcheck.sql` before; same file after; fingerprints
   below). Code may be deployed before or after M8: before M8 every commerce call answers 503 and nothing else changes.
3. Deploy the branch; outside probe with the public key (the 8 tables + 12 functions must answer 401/42501).
4. TEST-mode run on a TEST course end to end (checkout with a Stripe test card → webhook → sign in → refund).
5. LIVE only after: Golden (or another course's) written commercial permission recorded; live key; `academy_payments_live`.

Switch lines (owner runs; never by Claude):

```sql
update app_settings set value = value || '{"academy_payments": true}' where key = 'phase2_flags';
-- live payments, only when everything above is done:
update app_settings set value = value || '{"academy_payments_live": true}' where key = 'phase2_flags';
-- off again (rollback step 1, no deploy):
update app_settings set value = value || '{"academy_payments": false, "academy_payments_live": false}' where key = 'phase2_flags';
```

## What Angelo provides (external, cannot be done from here)

1. A **Stripe account** in Home Care Provider Services' name (business details, bank account for payouts). Fees are
   Stripe's (about 2.9% + 30¢ per US card payment).
2. In Netlify → Site configuration → Environment variables (Functions scope, Production), entered by Angelo himself:
   - `STRIPE_SECRET_KEY` = the **test** secret key first (`sk_test_…`, or a restricted key `rk_test_…` with write access
     to Checkout Sessions and Refunds).
   - `STRIPE_WEBHOOK_SECRET` = the signing secret (`whsec_…`) of the endpoint below.
   Then redeploy (env changes reach functions only after a new deploy).
3. Stripe → Developers → Webhooks → Add endpoint:
   `https://www.homecareproviderservices.org/.netlify/functions/academy-stripe-webhook`, events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`,
   `charge.refunded`, `charge.dispute.created`.
4. For the Golden course to be sold to outside dealerships: **Golden's written permission** for paid outside access to
   the course content (photos, videos, product content). Until then it stays "not on sale".

## Review of the defaults — legal / commercial points (not legal advice)

- **Refund policy disclosure:** the 14-day window is shown on the purchase page and in "My purchases". A short written
  Academy terms-of-sale page (what is bought, how long access lasts, refunds) is recommended before LIVE sales.
- **Sales tax:** whether online training is taxable depends on the buyer's state. Decide before LIVE (accountant, or
  Stripe Tax, which charges a per-transaction fee). Not built; prices are charged as entered.
- **Manufacturer rights:** the database refuses a LIVE sale without recorded commercial permission. The Golden 10 Oct
  confirmation covers education use only.
- **Certificates after a refund:** kept (it was earned), per the agreed default; repeat refunders go to buyer review.
- **Access across versions:** a purchase opens the course's current published version. Whether a later version
  (re-certification) needs a new purchase is an open policy point (recommended: yes, a new version is a new purchase).
- **Card data:** never touches HCPS (Stripe hosted page). HCPS stores the buyer's name, company, email, amounts and
  Stripe ids only.

## Fingerprints (after M8)

See `academy_p2_m8_postcheck.sql`. `m8_code_fingerprint`: Unix line endings **9d4ad838ea15ee19b263fa91e307e979**; pasted from Windows **0070da6d6f70aec8da3d37be5b188ac8** (both reproduced locally on PG16; M1–M7 fingerprint identical before and after M8).
`m1_m7_fingerprint` must equal the value read before M8.

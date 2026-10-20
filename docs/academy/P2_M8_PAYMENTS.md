# HCPS Academy — Phase 2 / M8: paid course access (Stripe SANDBOX)

Status (20 Oct 2026): M8 installed, sales switch ON in **Sandbox**, Golden on sale at $19.99 (commercial permission recorded);
sandbox paid / declined / refund tests PASSED. Live payments still need a reviewed migration + approval.
Live payments are impossible by construction (live keys refused in code, `livemode = false` enforced by the table).

## What it does
| Who | Result |
|---|---|
| HCPS network dealer (active, account class blank/dealer; branch follows its head office; TEST dealers included) | Free — the checkout answers "included" and never calls Stripe |
| Outside dealership | Buys on Stripe Checkout (`/academy/buy/`); access only after the **signature-verified** webhook |
| Manufacturer course (Golden) | Never on sale to outside dealerships until the President records the manufacturer's commercial-use permission (database trigger, every path) |

Price = `academy_prices.price_outside_cents` (President, Command Center → Courses → Paid access). A price change closes open
checkouts at the old price. Refunds are issued in the Stripe Dashboard; `charge.refunded` withdraws the enrollment unless
the course was completed (earned certificates stay). Disputes withdraw; a won dispute restores.

## Files
| File | sha256 |
|---|---|
| `supabase/academy_p2_m8_payments.sql` (41,382 bytes) | `85bedc8bf2fb495014e1115953ebf40429529a804c97ebed46b523d616692f08` |
| `supabase/academy_p2_m8_payments_rollback.sql` | `10113cd035e1c748158876c7aba3120241f829a8f20a453e86c40ec8e6831b56` |
| `supabase/academy_p2_m8_postcheck.sql` | `00158433538f5805d7f226f78b20c1cf6f496fbbe8e0f000f48a000b6b2a9370` |

Installed-code fingerprint (postcheck row 1, 15 functions): `f7ea1b2d029d2a5324e77059a2601f1a` (LF) /
`e0edbbf862729ce2abb44e546ea122b0` (pasted from Windows, CRLF). Code: `netlify/functions/_stripe.js`, `academy-checkout.js`,
`academy-stripe-webhook.js`, `academy-admin-api.js` (payments / set_price / set_eligibility), `src/academy/buy/`,
`src/admin/academy.html` (Paid access card).

## Stripe Sandbox configuration
- Account: HomeCare Provider Services **sandbox** (`acct_1UQJ0wGbhQzRXLGH`, test mode). No products, prices, payment links or
  subscriptions are created — Checkout uses inline `price_data`.
- Webhook destination: `https://www.homecareproviderservices.org/.netlify/functions/academy-stripe-webhook`, events
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
  `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.

## Owner steps (in order)
1. **Netlify env vars** (Site configuration → Environment variables; scope Functions; Production + Deploy previews), entered by
   Angelo, never pasted in chat: `STRIPE_SECRET_KEY` = the Sandbox **secret** key (`sk_test_…`, Developers → API keys);
   `STRIPE_WEBHOOK_SECRET` = the webhook destination's signing secret (`whsec_…`). Then **Trigger deploy** and wait for Published.
2. **Run M8** in the Supabase SQL editor (check the sha256 first); all install checks true; then the postcheck (all ok).
3. Public-key probe (Claude, public key only) — expect every M8 table/RPC blocked.
4. Set a price on a non-manufacturer course (President), then — with separate approval — turn sales on:
   `update app_settings set value = value || '{"academy_payments": true}' where key = 'phase2_flags';`
   Off: same line with `false` (refunds/disputes still recorded while off).
5. Sandbox purchase with Stripe test card `4242 4242 4242 4242` (any future date / CVC), and decline test `4000 0000 0000 0002`,
   entered by Angelo on Stripe's page; refund from the Stripe Dashboard; Claude verifies the records.

## Tests (local, PG16)
`academy-payments.pg` 26 · `academy-stripe` 14 + mutants 6/6 · `academy-buy.browser` 8 (360/390/768/1280) · Academy regression
15 suites / 308 tests unchanged · `academy-c1.browser` 7 (hostile data) · rollback restores the schema exactly; a second install is refused.

## Not built / owner decisions
Refund window (Stripe Dashboard is the control); refunds from the Command Center; Training Managers for outside organizations;
receipt email (Stripe sends its own receipt in test mode only if enabled); production (live) activation — needs a reviewed
follow-up migration + approval.

# HCPS Academy — Phase 2 / M8: paid course access (Stripe SANDBOX)

Status (20 Oct 2026): M8 installed; M9 (live) prepared — see the end of this file;, sales switch ON in **Sandbox**, Golden on sale at $19.99 (commercial permission recorded);
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


---

# M9 — LIVE card payments (prepared 20 Oct 2026; NOT installed; real payments NOT switched on)

| File | sha256 |
|---|---|
| `supabase/academy_p2_m9_live_payments.sql` (24,186 bytes) | `fedffe8ed7feca91784b6774ec5971733559e7fc4404635c3db178ce660ca925` |
| `supabase/academy_p2_m9_live_payments_rollback.sql` | `f98b112862fc38a5467a1ee24703368fc8b7bbc6bf1e6e466ed1f782da7d51f9` |
| `supabase/academy_p2_m9_postcheck.sql` (read-only) | `e1bd7a2431f67e8993c566b68b54a3c9ffbd4060402a5e4373bd6d328000e0ba` |

Postcheck row 1 fingerprint (4 functions): `0543c55fe1346d254fc4314b9076d392` (Unix) / `3047df24ab9f020aea02819cb7706cb4`
(pasted from Windows, CRLF) — both computed by installing the exact file on top of M8. Tests: academy-payments.pg 35,
academy-m9.pg (rollback round trip + 18/18 SQL mutants), academy-stripe 21 + 8/8 mutants, academy-buy.browser 8,
academy-c1.browser 7; all 21 earlier Academy suites green with pg-safeupdate loaded (as on Supabase).
The sandbox keeps working beside live. ONE switch decides the mode of every new checkout:
`phase2_flags.academy_payments_live` (exactly true = live; anything else = sandbox). The database stamps each purchase with
it; a Stripe session, a webhook event and a refund/dispute must all be of that purchase's mode.

| | Sandbox | Live |
|---|---|---|
| Netlify key | `STRIPE_SECRET_KEY` (sk_test_/rk_test_ only) | `STRIPE_SECRET_KEY_LIVE` (sk_live_/rk_live_ only) |
| Netlify webhook secret | `STRIPE_WEBHOOK_SECRET` | `STRIPE_WEBHOOK_SECRET_LIVE` |
| Stripe webhook destination | `we_1USPKeGbhQzRXLGHewmNRsiV` (sandbox acct_1UQJ0wGbhQzRXLGH) | `we_1USfBPCuUJFT4hsNPdcMLoH5` (live acct_1USOeYCuUJFT4hsN, created 20 Oct 2026, 7 events) |
| Who may buy | HCPS test mailboxes only (`angelo+academy-…@homecareproviderservices.us`) — a test card must never enroll a real buyer | anyone outside the HCPS network |

Security review fixes (independent payment-security + migration reviews, 20 Oct 2026), all tested:
sandbox checkout limited to HCPS test mailboxes (deployed at once — before it, the public sandbox page let anyone enroll with
Stripe's public test card); a sandbox payment never enrolls anyone while live is on; superseded checkouts are expired at Stripe
(price change / buyer starting again); a second payment for a course already paid goes to review; the payment id is stored even
when a payment goes to review; refunds / disputes that arrive before the payment confirmation are applied when it comes;
`tax_behavior = exclusive` (tax on top, never inside the price); full refund = price + tax; a lost dispute withdraws access; a
won dispute never restores a refunded purchase; absurd tax → review; daily-usable "Check Stripe against HCPS" (Command Center →
Courses → Paid access) lists paid Stripe checkouts without their HCPS record. Install refuses if the live switch is already on.

## Production activation checklist (owner = Angelo)
1. **Run M9** in the Supabase SQL editor (check its sha256 first). All 4 install checks must read true — if any is false, stop.
2. **Netlify → Environment variables** (Functions; Production): add `STRIPE_SECRET_KEY_LIVE` = a live **restricted key** with
   *Checkout Sessions: Write* (Stripe → Developers → API keys → Create restricted key; a full `sk_live_` also works) and
   `STRIPE_WEBHOOK_SECRET_LIVE` = the signing secret of destination `we_1USfBPCuUJFT4hsNPdcMLoH5` (Workbench → Webhooks →
   HCPS Academy payments (LIVE) → Signing secret → reveal → copy). Keep the two sandbox variables. **Trigger deploy**, wait
   for Published. Never paste either value in chat.
3. **Stripe live settings → Public details:** support email info@homecareproviderservices.us, phone 937-626-5141,
   statement descriptor (e.g. HCPS ACADEMY); after step 4, the Terms and Refund policy URLs.
4. **Approve** the Terms of Sale / Refund Policy / Sales tax doc; Claude publishes `/academy/terms/` and the agreement line.
5. **Sales tax decision:** with your accountant — if collecting, add the registration(s) in Stripe Tax, then switch
   `academy_payments_tax` on; otherwise leave it off.
6. **Final readiness review** (Claude): Command Center shows Live key set · live webhook secret set · M9 installed; public-key
   probe of the M9 objects all blocked; tests green on main.
7. **Turn live on:** `update app_settings set value = value || '{"academy_payments_live": true}' where key = 'phase2_flags';`
8. **First real purchase:** buy the course yourself with a real card from a non-HCPS address, confirm access, refund it in the
   Stripe dashboard, confirm access withdrawn; then "Check Stripe against HCPS" shows no problems.

**Emergency stop:** `update app_settings set value = value || '{"academy_payments": false}' where key = 'phase2_flags';`
(closes checkout entirely; refunds/disputes are still recorded). Turning only `academy_payments_live` off returns to the
sandbox, which is limited to HCPS test mailboxes.

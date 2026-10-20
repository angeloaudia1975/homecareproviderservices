# HCPS Academy — Phase 2 / M9: refund requests, price history, buyer review, TEST eligibility fix

Status (20 Oct 2026): **branch `academy/phase2-refunds-m9`, draft PR. M9 NOT run.** Incremental on top of main's M8
(`academy_p2_m8_payments.sql`, the canonical Phase 2 migration — owner decision A, PR #26 comment 6293379665). There is
no alternate M8: M9 refuses to run without M8 and replaces exactly one M8 function. Stripe stays **SANDBOX ONLY**
(`academy_purchases.livemode = false`, live keys refused) — M9 takes or returns no money.

## What M9 adds (ported from draft PR #26, rebuilt on M8)

| Addition | How |
|---|---|
| TEST eligibility fix | `academy_purchase_dealer_eligible` (M8 helper, replaced): a TEST dealership is free only if the dealership **itself** is TEST. A real branch under a TEST head office is no longer free by inheritance (M8 made it free). Real-dealer rule otherwise unchanged. |
| Price history | Trigger on `academy_prices` → append-only `academy_price_history` (before, after, reason, who). A change without a reason is refused on every path. Prices change through `academy_sale_op_set_price` (President + reason); the server role loses M8's reason-less `academy_purchase_op_set_price`. M8's rules (range, manufacturer rights, superseding open checkouts) still run — M9 calls M8's operation. |
| Refund requests | Buyer asks within **14 days** of payment, once per purchase, with a reason (`academy_sale_op_refund_request`, learner = the purchase's learner). President approves / declines with a reason (`academy_sale_op_refund_decide`). **Approval moves no money**: the President refunds that payment in the Stripe Dashboard (the Command Center shows the payment id); M8's signed `charge.refunded` then marks the purchase refunded and a trigger closes the request. A declined reason is shown to the buyer. |
| Refund record safety | Trigger on `academy_purchases`: a late / replayed / out-of-order `charge.refunded` never lowers `amount_refunded_cents` and never turns "refunded" back into "partially refunded". |
| Buyer review | Two or more refunded purchases in 12 months → a new checkout is refused (`academy_sale_buyer_check`, every insert) until the President records "allow"; "block" stops a buyer. Append-only decisions. |
| Learner "My purchases" | `academy-api` `my_purchases`, `refund_request`; nav item for learners of an outside organization. Certificates of outside buyers no longer print "of null". |
| Command Center | Courses → Paid access: reason field on price changes; refund requests (decide), buyer reviews, price history. |

Not ported, on purpose:
- **Test-course sales in TEST mode** (PR #26 allowed them): M8 never sells a `test-…` course at all — stricter; kept.
- **Separate live switch** (`academy_payments_live`): M8 makes live payments impossible (code + table). A live switch
  belongs in the reviewed live-activation migration, not here.
- **Refunds through the Stripe API from the Command Center**: see "Admin refund API — assessment".

## Admin refund API — assessment (owner item 4)

Kept OFF. Refunds stay in the Stripe Dashboard. What an in-app refund would need first:
- **Least privilege:** a Stripe *restricted* key with write access only to Refunds and Checkout Sessions (`rk_test_…`), never the
  full secret key; M8's `_stripe.js` already accepts `rk_test_`.
- **Partial refunds:** M8 records Stripe's running total `amount_refunded`; M9 makes it monotonic. An in-app refund must send
  an Idempotency-Key per (purchase, amount) so a retry never refunds twice.
- **Out-of-order / replayed events:** handled — each Stripe event once (M8), totals never go down (M9).
- **Certificates:** a full refund withdraws an unfinished enrollment only; a completed enrollment and an earned HCPS
  certificate stay (M8 + tested in M9).
- **Who:** the President only, with a recorded approval first (M9's request flow is the natural trigger).

## M8 review findings (main `9327d40`) — for the independent review

1. **Fixed in M9:** a real (non-TEST) branch whose head office is TEST was free (TEST inheritance).
2. **Fixed in M9:** a late smaller `charge.refunded` lowered the recorded refunded amount.
3. **Owner decision, not changed:** M8 judges a branch only by its head office — a branch marked closed / prospect under
   an active head office is free. PR #25's default said "HQ/branch status = active". Say if branches should also need
   their own status active.
4. **Minor, not changed:** `charge.dispute.closed` with status lost marks the purchase refunded but leaves
   `amount_refunded_cents` at 0 (reporting shows $0 refunded).
5. Overrides are replaced in place (history kept in the audit rows only) — acceptable; M9 history tables are append-only.

## Production state (read-only, 20 Oct 2026)

Through the President's signed-in Command Center (`payments` action, read-only): **M8 tables answer (installed: true)**,
Stripe key mode **test**, webhook secret **set**, sales switch **off**, 0 purchases. Secrets were not viewed. The production
PostgreSQL version and the M8 fingerprint were not read (no read-only database connection from this workspace): run
`supabase/academy_p2_m9_preflight.sql` (read-only) in the SQL editor and compare with the values below.

## Fingerprints (`academy_p2_m9_preflight.sql`)

| | M8 pasted as LF | M8 pasted from Windows (CRLF) |
|---|---|---|
| before M9: `m8_fingerprint` | `f7ea1b2d029d2a5324e77059a2601f1a` | `e0edbbf862729ce2abb44e546ea122b0` |
| `m8_without_eligibility_fingerprint` (never changes) | `93410414b0da012def601829abaa92d7` | `38cf07f805a44f70641cbe43bdd52eec` |
| after M9 (LF) `m8_fingerprint` | `61b2560bb2ff8535da1e120f9a7f05a6` | `aaf6c169ba2cc5a178fda34b4706149b` |
| after M9 (CRLF) `m8_fingerprint` | `2784a40890b336614995636098aed3b2` | `10d13428855a778472562f90619d3f1a` |
| `m9_fingerprint` | M9 LF `7976704f6b223e97aff47e77c6159858` · M9 CRLF `e1e1f50ef81ff6bb99171e12c1f7a57b` | |

After M9: `m9_functions` 10, `m9_server_ops` 4, `m9_public` 0, `m8_price_op_server` false.

## Order (each step separately; owner-only steps marked)

1. Independent review of M8 + M9 together (this PR).
2. **Owner:** run `academy_p2_m9_preflight.sql` (read-only) — record `server_version` and the M8 fingerprint.
3. **Owner:** run M9 (after approval); then the preflight again (after values above).
4. Merge + deploy (code works before M9: the new screens say "arrives with M9"; prices keep M8's behaviour until M9).
5. Public-key probe of the 3 M9 tables and 4 operations (expect 401).
6. Sandbox run: buy with Stripe test card → request refund → approve → refund in the Stripe Dashboard → request closes.

Still owner-only before any real payment: Golden's **written** commercial permission; a terms-of-sale / refund page; a
sales-tax decision; a reviewed live-activation migration.

## Tests (local, PostgreSQL 16 + pg-safeupdate; not production)

`academy-m9.pg` 15 + 2 browser checks at 390 / 1280 px (on M8 + M9 as committed: install, M8 changed in exactly one function, RULE 19, TEST semantics, price
history, 14-day requests, President decisions, Stripe-closed requests, out-of-order refunds, earned training kept, decline,
buyer review, rollback restoring M8's fingerprint) · `academy-m9.mutants` 16/16 · M8 suites unchanged (`academy-payments.pg`,
`academy-stripe`, `academy-buy.browser`) · Academy regression suites.

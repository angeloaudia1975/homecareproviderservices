# Phase 2 / F1 — free launch access (issue #29)

Owner decision (20 Oct 2026): launch the Academy **free**, for HCPS network dealers and outside learners alike; paid
enrollment later. Stripe stays sandbox-only and no live payment is possible.

## What F1 adds

| Piece | What it does |
|---|---|
| `academy_course_access` | Per-course access policy: `free` · `paid` · `off`. Independent of the price; the price row is kept. No row = M8's price rules. Only the President sets it, with a reason (audited). |
| `academy_free_no_checkout` trigger | A course whose policy is not `paid` can never get a checkout row, on any path. Setting a course free also closes its open checkouts. |
| `academy_free_op_register` | Outside learner sign-up: learner record + outside organization (M8's `academy_organizations`, never a CRM dealer) + learner-only membership. Grants **no course**. Rate-limited (10 / hour per network address, 3 / hour per email). Refuses HCPS staff, suspended learners and Partner 360 users (one identity: they open Training from Partner 360). |
| `academy_free_op_enroll` | A signed-in, active learner enrolls in a FREE published course. `access_source = 'free'`. Idempotent (a repeat or simultaneous click returns the same enrollment). Through an eligible network dealership membership first, else the outside organization. TEST courses only for TEST dealerships. A withdrawn (e.g. refunded) enrollment is restored, never duplicated. |
| Eligibility fix | Replaces M8's `academy_purchase_dealer_eligible`. M8 required `dealers.status = 'active'`, but the CRM lifecycle is `dealers.active` (status is blank for almost every dealer), so M8 treated nearly every real dealer as outside the network. |
| Membership guard | M8's guard allowed an outside organization membership only from a verified purchase; F1 adds the free registration as the one other road. |

Code: `netlify/functions/academy-free.js` (public: catalog, register), `academy-api` `free_courses` / `enroll_free`,
`academy-admin-api` `set_course_access` (President) + access modes in `payments`, `academy-checkout` refuses a free course
(409 `free`) and leaves it out of the paid catalog, `/academy/start/` (free sign-up page), learner page "Free courses",
Command Center → Paid access → **Access** column, landing wording.

## Branch / network recommendation (explicit)

A dealership is in the HCPS network for Academy purposes only when **the dealership itself AND its head office** are
active (`active` is not false), not prospect / closed / inactive / dormant by status, and have account class blank or
`dealer`. A branch never inherits network status from an active head office, and an active branch of an inactive or
prospect head office is not in the network either. TEST is in the network only for a dealership that is itself TEST. The
President's audited override (on the dealer, or on its head office) still wins.

Network status only decides *which membership* a free enrollment is recorded under. It never grants ordering, pricing,
Partner 360, CRM or Training Manager rights. A person at an inactive / prospect branch can still learn free as an outside
learner (outside organization, no dealer link). Ordering / CRM status is untouched.

## Existing records

- Paid sandbox purchases, the refunded test, Stripe events and the webhook keep working (refunds, disputes, review).
- The Golden course id, slug, published version 1, enrollments, progress, attempts and certificates are unchanged.
- Later switching a course to `paid` (or `off`) never removes a free learner's enrollment, progress or certificate.

## Production steps (owner gate)

1. **Preflight (read-only):** `supabase/academy_p2_f1_preflight.sql`. Expect M8 installed, F1 absent, `dealers.active` present.
2. **Angelo runs** `supabase/academy_p2_f1_free_access.sql` in the SQL editor (pasted verbatim, sha256 checked first).
   All 6 install checks must read true.
3. **Postcheck (read-only):** `supabase/academy_p2_f1_postcheck.sql`. Fingerprint below; 0 access policies.
4. Merge the PR → Netlify Published.
5. **Angelo** (President) in Command Center → Courses → Paid access → *Set access* on the lift chair course → **Free during
   launch**, reason e.g. "Free launch — issue #29". This closes any open sandbox checkout for it.
6. Live checks (read-only + one TEST mailbox sign-up): `/academy/start/` lists the course, the checkout answers `free`.

**Rollback:** set the course's access to `paid` or `off` in the Command Center (audited; no SQL). The SQL rollback
`academy_p2_f1_free_access_rollback.sql` is refused once any policy, registration or free enrollment exists, by design.

## Checksums and fingerprints

| File | sha256 |
|---|---|
| `academy_p2_f1_free_access.sql` | `13114bc7bb3dd3fc1be1d0c653dc0829c2460e6ca5faa50611f2a3f1e7591598` (Windows paste: `134a18db…b7ea3`) |
| `academy_p2_f1_free_access_rollback.sql` | `6099a48993bb46f461e4955e39f154371e56ecee92dc8ecb2800b6a6b71dae50` |
| `academy_p2_f1_preflight.sql` | `792d9b31bb71e9fe78d944a6fb00fb9dd54d063b785d22174f74871d8ffbe2f1` |
| `academy_p2_f1_postcheck.sql` | `6178c1b149b6f69e8d4e1eb5e3b332e0cd83b6ab677c429d9dbfad5c31b82f5e` |

Postcheck code fingerprint (5 F1 functions + the 2 replaced M8 functions): **`06e0d7c92237625eb0930f6c21e6fb5b`** (Unix
line endings) or **`d1b5396cac417171ec568313401e75f2`** (pasted from Windows, CRLF) — both reproduced on a local install.

## Tests

- `test/academy-free.pg.test.js` (24) — real handlers + real Postgres (A1, M1–M8, F1): install checks; eligibility matrix
  (active flag, prospect / closed / manufacturer, inactive / prospect head office, inactive branch, TEST self vs TEST head,
  overrides); RULE 19; President-only policy (API + database); free course never sold (catalog, API, trigger); free catalog
  excludes TEST; registration security (header, origin, switches, pilot); refusals (staff, Partner 360, suspended);
  outside sign-up → code → enroll → lesson → exam → HCPS certificate → public verification; repeat / simultaneous clicks;
  dealer path through an eligible branch; inactive branch is not network; TEST course; suspension; old purchase refund
  webhook after the switch + restored enrollment; later paid / off keeps everyone; audit; rollback restores M8 byte for byte.
- `test/academy-free.mutants.js` — 23 mutants (SQL + JS), all killed (the advisory-lock mutant is killed by a real two-session concurrency test).
- `test/academy-start.browser.js` — `/academy/start/` at 360 / 390 / 768 / 1280.
- `test/training-academy.browser.js` — landing wording (Free during launch, no prices, Start Free link).
- Regression: payments.pg, pilot.pg, a2b.pg, a2f.pg, m5.pg, m7.pg, phase3.pg, stripe, c1, a2a, lesson, builder, d360,
  buy / learner / landing-editor browser suites.

## M9 (PR #27) note

F1 now owns `academy_purchase_dealer_eligible`. M9 must drop its own replacement of that function before it is ever
installed, or it would put back the status-based rule.

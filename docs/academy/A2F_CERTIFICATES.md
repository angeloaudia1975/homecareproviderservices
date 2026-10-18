# HCPS Academy — A2F: HCPS certificates and verification (M7)

Status: **development** on branch `academy/a2f-certificates` (draft PR, base `academy/a2e-exams`). M7 is **not** run in
production. Issuance stays OFF (`academy_certificates` false) until the owner authorizes it.

## What it does

| Area | Rule |
|---|---|
| Issuer | Home Care Provider Services (HCPS). Every certificate, learner screen, Training Manager line, Command Center card and the public verification page says it is **not issued or endorsed by Golden Technologies**. |
| Earning it | A passing final exam (M6: 25 questions, 45 min, 80%). The learner's own passed attempt is claimed through `academy_cert_op_claim`; when issuance is on, a pass claims it automatically in `exam_submit`. A failure to issue never fails the graded exam (the result carries `certificate_pending`; the learner or a retry claims it later). |
| Who | Only `learner:<id>` of the attempt's own learner, active, non-staff, enrollment not withdrawn, membership still active. |
| Dealership | Read in the database from the learner's membership (`dealers.business_name`), never from a caller. |
| Validity | 12 months (M1: version `validity_months` → `academy.hcps_cert_validity_months` → 12). Shown as *expired* after `expires_at`; "expiring soon" = 60 days or fewer. |
| One per enrollment | M1's unique `enrollment_id`. A repeat claim returns the same certificate (idempotent; advisory lock per enrollment). |
| Number | M1's `HCPS-XXXX-XXXX` (32-letter alphabet, no 0/O/1/I). |
| Verification | Public page `/academy/verify/` + `GET /.netlify/functions/academy-verify?n=`. Shows number, holder, dealership, certification, issued, expires, status valid / expired / revoked, revoked date, issuer. Never an email, score, attempt, enrollment or revocation reason. `enabled:false` while issuance is off. |
| Revocation | The **active HCPS President only** (role read from staff_users at the moment of the change, in the database AND the API), reason 5–500 characters, audited with before/after through M1. The certificate stays on record and verifies as *revoked*. No new certificate is issued automatically after a revocation. |
| Training Manager | Roster line per course: certificate number, status, validity date, expiring soon — never a score; only people in the TM's dealership + direct branches. |
| Command Center | Certifications tab: valid / expiring within 60 days / expired / revoked counts (TEST courses not counted), reason and revoker visible to staff, **Revoke…** button for the President. |
| Download / print | Learner → My certificates → View and print → the browser's Print / Save as PDF (one landscape page; header, buttons and footer hidden). |

## Database (M7, prefix `academy_cert_`; no new table or view — RULE 19 unaffected)

| Function | Kind | Callable by |
|---|---|---|
| `academy_cert_op_claim(actor, attempt)` | SECURITY DEFINER, pinned path | service_role |
| `academy_cert_op_revoke(actor, certificate, reason)` | SECURITY DEFINER, pinned path | service_role |
| `academy_cert_op_verify(number)` | SECURITY DEFINER, STABLE, read only | service_role |
| `academy_cert_president(actor)` | helper | owner only |
| `academy_cert_view(certificate)` | helper | owner only |

The server role loses EXECUTE on M1's `academy_op_issue_certificate` / `academy_op_revoke_certificate` and INSERT /
UPDATE / DELETE / TRUNCATE on `academy_certificates` (keeps SELECT). M1's code is unchanged and called inside M7.

## Files and checksums

| File | sha256 |
|---|---|
| `supabase/academy_a2f_m7_certificates.sql` (11,492 bytes, LF) | `1ac6883070aaace7ade250da2dfaf3919d6421fa719f1f75853b68d071872219` |
| same file pasted from Windows (CRLF) | `e8519483448e3bb6ca132daa398735b03bd18ee2d39318506aee739cb944904a` |
| `supabase/academy_a2f_m7_certificates_rollback.sql` | `0b814587e0779bf635e4687280780c4551915fb39fc896ff0cc461f5d22a148d` |
| `supabase/academy_a2f_m7_preflight.sql` (read only) | `af5c14c9ff7b9d27163c874b6038ebf595e94dbc7738313f590683bf6793f2c2` |
| `supabase/academy_a2f_m7_postcheck.sql` (read only) | `785d6815d2b7658f0b90b174ee3c67a214d91f877dd010365869c93d70e6cc1e` |
| `scripts/academy_m7_public_probe_browser.js` (9 checks) | `d760b3a8145888bb5d014612a9668d1bc8e5e372c7b8a62b7d78f74b06771e36` |

Installed-code fingerprint (`m7_code_fingerprint` in the postcheck): **`f216169489d9cf3f9c6b3980e15f7a47`** (Unix) /
**`ccf86058023056f3ad429aad480b7c39`** (pasted from Windows), both reproduced locally on A1 + M1–M6.

## Production order (each step needs the owner; nothing here is authorized yet)

1. M6 installed and accepted (M7 refuses to install without it).
2. Preflight `academy_a2f_m7_preflight.sql` → `ready_for_m7` true; record `m1_fingerprint`.
3. Owner pastes the exact M7 file (checksum first) in the SQL editor → 7 install checks `ok = true`. A second run is refused ("already installed").
4. Postcheck: fingerprint as above, functions 5 / server 3 / public 0, M1 issue/revoke server `[false,false]`,
   certificate writes false, certificates 0, `m1_fingerprint` = the preflight value, switches unchanged.
5. Public-key probe: all 9 BLOCKED.
6. Merge + deploy the A2F code (after the A2E PR).
7. Switch `academy_certificates` on only with the owner's separate approval (with the pilot).

## Rollback

`academy_a2f_m7_certificates_rollback.sql` removes the 5 functions and restores the server's M1 rights. It is **refused
while any HCPS certificate exists** — once one has been issued, removing the President-only revocation path is a policy
change, not a rollback. First rollback step for issuance is always the switch: `academy_certificates` false (no deploy).

## Open owner decision (not blocking)

Re-certification after a certificate expires or is revoked: M1 allows one certificate per enrollment (a learner is
enrolled once per course version). Options: (a) re-certify on a NEW course version (no schema change); (b) a reviewed
M1 schema change allowing a new certificate per enrollment after expiry/revocation. Recommended: (a) for the launch
year; nothing expires before October 2027.

## Tests

| Suite | Count |
|---|---|
| `test/academy-m7.pg.test.js` (PG16 + PG17.6) | 16 |
| `test/academy-a2f.pg.test.js` (real handlers, real database rules) | 11 |
| `test/academy-a2f.browser.js` (360 / 390 / 768 / 1280, print, axe, strict CSP) | 4 |
| `test/academy-a2f.mutants.js` | 31/31 killed (clean control; one equivalent mutant documented) |

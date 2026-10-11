# A2C M2: atomic content operations

Status: **draft PR, for Angelo's review.** It is not merged and has not been run in production. All seven Academy
switches stay OFF. The Command Center stays off until M2 is installed, tested and separately approved for staff-only
activation. Design approved by Angelo on 11 Oct 2026 (Option A in `A2C_C1_COMMAND_CENTER.md`).

## What M2 guarantees
These guarantees apply to creating and editing courses, draft versions, modules and lessons, and to moving a version between draft and in review:
- **One transaction.** The change and its `academy_events` row are saved together, or neither is.
- **If the change fails, no audit row claims it.** Each operation reads its row again under the version lock. It must change exactly one row before it writes the audit row.
- **If the audit row fails, the change is not saved.**
- **Direct writes are refused.** The guard trigger `academy_content_guard` on `academy_courses`, `academy_course_versions`, `academy_modules` and `academy_lessons` refuses every insert, edit or delete that is not made by an audited operation, and `academy_content_guard_truncate` refuses TRUNCATE. That includes:
  - the database owner without an operation;
  - the server role, even when it sets the operation marker itself.
- **Published and retired content stays protected.** The A1 freeze triggers, the M1 guard and the M2 draft-only checks all still apply.
- **M1 is unchanged.** It keeps its 19 functions and 6 triggers, and its installed-code fingerprint (130e45fa…, or e70543ba… as installed) does not change. The M2 names start with `academy_content_`, so they never match M1's `academy\_op\_%`.
- **The acting person comes from verified authentication.** The server passes `staff:<signed-in email>` (`contentOp()` in `_academy.js`). The database accepts only an **active** president, admin or owner, and requires the President for a course learners have seen.
- **Nothing else is touched.** M2 changes no other HCPS table, ordering function or sales system. It reads `staff_users` and `manufacturers` and writes only the four content tables (and `academy_events` through M1's audit helper).

## Objects

| Kind | Name | Who may run it |
|---|---|---|
| 11 operations | `academy_content_op_create_course`, `update_course`, `create_version`, `update_version`, `move_version`, `create_module`, `update_module`, `delete_module`, `create_lesson`, `update_lesson`, `delete_lesson` | server role only |
| 3 helpers | `academy_content_actor_president`, `academy_content_lock_draft`, `academy_content_keys` | owner only |
| Guard | `academy_content_guard()` + 4 row triggers + 4 TRUNCATE triggers | owner only |

**Operation rules:**
- Operations are SECURITY DEFINER with a pinned search path. They reuse M1's owner-only helpers (`academy_op_begin` / `end` / `audit` / `actor_staff`).
- **Error codes:**
  - 42501: not allowed;
  - P0002: not found;
  - 22023: invalid input or a field that cannot be set;
  - 55000: locked (in review, published or retired, or a module that still has lessons);
  - 23505: duplicate.
- **What the server sends back:** the server maps these to 403, 404, 400, 409 `locked` and 409. If M2 is not installed, the answer is 503 and the server never falls back to a plain write.
- **Fields each operation accepts:**
  - courses: slug, title, type, manufacturer, category and link;
  - versions: pass mark, exam questions and validity;
  - modules: title and objectives;
  - lessons: title and minutes.
- **Set only by the database:** the issuer (from the type), the status (always draft), positions and version numbers.

## Files

| File | sha256 |
|---|---|
| `supabase/academy_a2c_m2_content_ops.sql` (migration, one transaction) | b4e28fd082ba3bd333c98f31a69579a289ccee80476eeefae0fe428b9e3d9f9b |
| `supabase/academy_a2c_m2_rollback.sql` | e998b6b68e254f1c5d4b47b458e3648690fce28a6e51814f3eeb36329d88445c |
| `supabase/academy_a2c_m2_preflight.sql` (read-only) | 91e7dad5be5f82f04460264d0af09bfc717327c47be1edf682784f6d52879f77 |
| `supabase/academy_a2c_m2_postcheck.sql` (read-only) | 3284b9524108567f1c8994c777fca3deab964f039ae5700c3d32af24381d1f7a |
| `supabase/academy_a2c_m2_acceptance_tests.sql` (20 tests + check 21) | 9b89456c1a6b4092bdca7633b65f7859536387fc71ba7ab0baceeb3217b4c4b0 |
| `scripts/academy_m2_public_probe_browser.js` (public-key probe) | — |

**Installed-code fingerprint** (postcheck `m2_code_fingerprint`):
- f24e4f888c8ed7a4e0765382737dfe35 with the file's own line endings;
- 794f3c3e007bf3cc6d72b574aac614e3 when pasted from Windows (CRLF).

Both were computed by installing the file locally.

**Changed for M2 compatibility only:** the A1 and M1 acceptance files (and two local test files) now set the
operation marker, as the owner, around the inserts that build their test courses. Without that, M2's guard would
refuse their setup. Their new sha256 values:
- `academy_a1_acceptance_tests.sql`: 10c3ad57… (was 60c6f191…);
- `academy_a2a_m1_acceptance_tests.sql`: 1046b528… (was 81766882…).

They pass before M2 (27/27, 43/43) and after it.

## Production runbook (Angelo runs every step; Claude never does)
1. **Preflight** (read-only). Paste the result back.
   - `ready_for_m2` must be true;
   - `m1.code_fingerprint` must be e70543ba… (as installed);
   - `active_presidents` must be at least 1;
   - every switch must be false.
2. **Check the file.** Confirm the sha256 of the committed migration matches the approved value.
3. **Run the migration.** Paste the file verbatim into the SQL editor and press Run once. If it fails, nothing is installed (it is one transaction). Stop and send the error.
4. **Postcheck** (read-only). Expect:
   - 15 functions;
   - operations_server_only 11;
   - helpers_callable_by_server 0;
   - callable_by_public_keys 0;
   - guard on the 4 tables;
   - m1_functions 19 and m1_guard_triggers 6;
   - the M1 fingerprint unchanged;
   - the M2 fingerprint f24e4f88… or 794f3c3e… (Windows paste);
   - the same content and audit row counts as the preflight.
5. **Acceptance tests.** Expect 21 rows, all PASS. Test 15 may say PASS with a note when there is no non-President administrator; that refusal is proven by the local tests.
6. **Re-run the A1 and M1 acceptance files** (the updated versions). Expect 27/27 and 43/43.
7. **Run the preflight again.** Every fingerprint must be identical to step 1; only `m2_installed`, `m2_objects` and `content_triggers` may change.
8. **Public-key probe** (`scripts/academy_m2_public_probe_browser.js`, in a blank browser tab). Expect all 26 checks BLOCKED.
9. **If anything fails:** stop and investigate. Never roll back automatically. The rollback (drop the 8 guard triggers and the `academy_content_%` functions) refuses to run unless M1 is intact. It is used only on Angelo's decision, and only after the Command Center code that calls M2 is switched off or reverted.

Merging the code can come before or after the production run. With M2 absent, every content write answers 503, and the switch is OFF either way. The recommended order is: run M2 and verify it, then merge.

## Local test results (this branch)

| Suite | Result |
|---|---|
| `test/academy-m2.pg.test.js` (real Postgres 16 with pg-safeupdate; fixture → A1 → M1 → M2) | 18/18 |
| ↳ M2 acceptance (sent as one request, like the editor) | 21/21 (Unix and CRLF installs) |
| ↳ M2 local hardening (`test/academy/m2_content.sql`) | 9/9 |
| ↳ with M2 installed: A1 acceptance / M1 acceptance / M1 hardening / M1 all-or-nothing | 27 / 43 / 28 / 11 |
| ↳ rollback: refuses if M1 is incomplete; removes M2 only; M1 and every row intact; M2 re-applies | pass |
| `test/academy-a2a.pg.test.js` (M1 suite, with the updated acceptance files) | 18/18 |
| `node test/academy-c1.test.js` | 49/49 |
| `node test/academy-c1.mutants.js` | 39/39 killed |
| `test/academy-c1.browser.js` (Playwright) | 6/6 |

The **acceptance tests** check:
- structure, privileges, and M1 left untouched;
- direct writes refused;
- each operation's audit row;
- refused input leaving no audit row;
- manufacturer programs;
- version numbering;
- draft-only and in-review locks;
- M1 publish and retire working on M2 content;
- the President rule;
- actor checks;
- all-or-nothing for all 11 operations with the audit store refusing;
- failed or empty changes leaving no audit row;
- no marker left behind;
- nothing left behind.

The **local hardening tests** cover what the SQL editor cannot show:
- roles as the API uses them (anon, authenticated, service_role, including a forged marker);
- a non-President administrator;
- a failed operation caught by its caller;
- the audit "after" matching the saved row;
- TEST courses;
- TRUNCATE refused;
- a lesson with linked product facts not deleted silently.

## Independent review
A separate reviewer (who did not write M2) found no blocking defect. It confirmed:
- the marker is undone on a caught error;
- a decimal pass mark is refused;
- the rollback and tests 13 and 17 are valid.

Its four findings are fixed in this branch:
1. `update_course` now waits for a publish in progress before applying the President rule. The version rows are taken `for share`, which closes a narrow race against M1 publishing.
2. A comment in the migration records that foreign-key cascades run as the table owner. Any future cascade into these four tables must be reviewed against the guard.
3. TRUNCATE is now guarded.
4. `delete_lesson` refuses while product facts are linked to the lesson, instead of letting the cascade remove them unrecorded.

Also changed: a JSON `null` objectives list is stored as empty.

# A2D migration M3 — audited lesson-content operations (DEVELOPMENT, draft PR)

Status: **built and tested locally; not run in production; not merged.** Authorized by Angelo on 11 Oct 2026 at 17:23 CT,
for "M3 design, implementation in a development branch, local database testing and preparation of a draft pull request".

Running M3 in production, merging it, and starting the next A2D stage (the lesson engine) each need Angelo's separate
approval. All Academy switches stay as they are: `academy_admin` is ON for the President-only pilot; the other six are OFF.

## What M3 adds

**Purpose:** the lesson builder can write lesson blocks, the question bank, media records and product-fact links.

**How every write works:**
- Each write is one transaction: the change and its `academy_events` row are saved together, or neither is.
- Writes are allowed on draft versions only.
- Only an active HCPS administrator can write. The acting person comes from the verified sign-in.

| Operation (server role only) | What it does |
|---|---|
| `academy_author_op_set_blocks` | Saves a lesson's blocks after the database checks them (14 kinds, decision A) |
| `academy_author_op_reorder_modules` / `_reorder_lessons` | Saves a new order; the list must be complete |
| `academy_author_op_set_exam_distribution` | Sets how many exam questions each module gives (decision B), or clears it |
| `academy_author_op_create_question` / `_update_question` / `_set_question_status` | Question bank: create, edit, retire or restore |
| `academy_author_op_create_media` / `_update_media` / `_delete_media` | Media with rights and alt text (decision C) |
| `academy_author_op_link_fact` / `_unlink_fact` | Links a lesson or question to a product fact |

**Guards:** `academy_author_guard` (on rows) and `academy_author_guard_truncate` cover `academy_questions`, `academy_media` and `academy_content_refs`. They refuse every write that does not come from an audited operation. This applies to the database owner and to the server role, even with a forged marker.

**Publish check:** the trigger `academy_author_publish_check` runs when M1 publishes a version (M1's publish is unchanged). The version is published only if two things hold:
- its exam can be drawn under its distribution;
- every lesson's blocks still pass their checks.

The check also locks the media those blocks use until the publish commits.

### The block checker

Every block kind has a fixed list of allowed keys. The checker refuses:
- **Content:** HTML, control characters, and text that is too long.
- **Size:** more than 40 blocks, or more than 64 KB in total.
- **Links:** anything other than `https://`.

Rules for particular block kinds:
- **Objectives:** come first, if the lesson has them.
- **Image:** needs either a media record or a labelled placeholder. A placeholder needs real alt text.
- **Video:** must be a YouTube no-cookie or Vimeo embed.
- **Fact and comparison:** every product fact shown, and every comparison cell, must be linked to the lesson. Model codes are stored upper-case.
- **Manufacturer quote:** needs its source and a source date.
- **Scenario:** needs at least one best choice.
- **Knowledge check:** 2–5 **practice** questions from the same version. An exam question is never shown in a lesson.
- **Credential evidence:** a learner's uploaded evidence can never be used in a lesson.

### Media rules (decision C and the Golden photography rule)

- **Images:**
  - must be a stored JPEG, PNG or WebP;
  - alt text is required and must describe the picture (10–300 characters, not a file name);
  - `""` marks a purely decorative image, which screen readers skip.
- **Videos:** YouTube (youtube-nocookie.com/embed) or Vimeo (player.vimeo.com) links only.
- **Documents and links:**
  - a stored PDF or an https link;
  - link-only material is never stored;
  - HCPS-owned files name no manufacturer.
- **Manufacturer-permitted media** must name both the manufacturer and the permission.
- **The President only** may record or change a stored image or a stored manufacturer file, including downgrading one away from manufacturer-permitted. This is how "no Golden photography without my approval of the specific files" is enforced. The database cannot tell a Golden photo from an HCPS one, so it requires the President for every stored image.
- **Media in use:**
  - a media record used by a lesson outside a draft can never be edited;
  - a record still used anywhere cannot be deleted;
  - two records can never claim the same stored file.

### Questions

- **Content checks:**
  - kinds are single, multi or scenario;
  - 2–6 choices with ids a–f;
  - the answer must be one of the choices;
  - multi answers are stored sorted;
  - 1–10 topic tags;
  - an explanation is required.
- **No overlap between banks:** an exam question can never also appear as a practice question (identical prompt), because practice feedback would give its answer away.
- **Answer keys** stay in `academy_questions`. Audit rows record only `answer_key_changed`, never the key.
- **Knowledge checks:** a practice question used in one can be neither retired nor turned into an exam question until the check stops using it.

### The exam draw: the ONE change to M1 (decision B)

`academy_op_start_attempt` now gets its questions from `academy_author_exam_draw`. Only that one statement differs from M1; the owner, rights (server role only), SECURITY DEFINER and the pinned search path are all unchanged.

Which questions can be drawn:
- Only active exam questions whose pinned product facts are still current and verified. A question that depends on an unverified or replaced fact never reaches a scored exam.

How many come from each module:
- **With a distribution** (`academy_modules.exam_quota` set):
  - every module needs a number between 1 and 200;
  - the numbers must add up to the version's exam size;
  - each module gives exactly its number;
  - every exam question must belong to a module.
- **Without one (automatic):** every module needs at least one usable exam question and gives one; the rest are drawn at random.

Either way every module is represented, the questions are drawn at random within each module, and the whole set is shuffled.

Error messages:
- For an unpublished version or a withdrawn enrollment, start-attempt gives exactly M1's messages.
- For a short question bank on a published version, it names the module that is short.

### One new column

`academy_modules.exam_quota` is nullable and is written only by `set_exam_distribution`.

The A2D plan said "no new columns". Decision B, a distribution that is "configurable rather than permanently hard-coded", needs a stored setting, so M3 adds this one column. Nothing else in the schema changes.

## Decision for Angelo (from the independent review)

**Facts are checked when the exam is drawn, not when it is graded.**

If a product fact is withdrawn or replaced while a learner has an attempt open, that attempt is still graded on the questions it drew. Every later attempt excludes the question.

Changing this would mean changing M1's grading (`academy_op_submit_attempt`), which would need its own review.

- **Recommended:** accept "checked when drawn". Attempts are short, and the next attempt is already protected.
- **Alternative:** a separately reviewed M1 grading change that voids such questions at submission.

The reviewer's approval of the start-attempt change assumes this decision.

**Decided (Angelo, 11 Oct 2026 18:34 CT): APPROVED — facts are checked when an attempt begins.**
- An attempt keeps the questions it drew (`academy_attempts.question_ids`, written once by start-attempt).
- Those questions' fact versions stay fixed for the whole attempt: they are pinned per course version at publication
  (`academy_content_refs.pinned_fact_id`), and after publication no operation can change a pin (fact links are guarded
  and draft-only; M1 publishing pins only unpinned links of the version being published).
- New attempts exclude any question whose pinned fact has since been replaced or withdrawn.

### Future procedure (documented only — NOT built; needs its own design, review and approval)

For a serious safety error or a material content error found while learners have attempts open, a future audited,
administrator-controlled operation would:
1. name the affected course version and the reason (safety / material content), recorded by an administrator;
2. mark each affected **open** attempt as invalidated (never delete it; never change a submitted, graded attempt or a
   certificate), with one audit row per attempt in the same transaction;
3. let the learner start again at once, without counting the invalidated attempt against the retake limits (cooldown and
   daily limit, A2E), and tell the learner plainly why;
4. fix the content through a NEW course version (published content stays frozen).

It touches M1's attempt rules, so it is not part of M3 and must not be added as an unreviewed M1 change. It belongs with
A2E (retake rules), where the cooldown and daily limits are built and tested under simultaneous requests.

## Known limits (documented, not blocking)

- **A Golden PDF can be mislabelled.** An administrator could store a Golden brochure PDF labelled `hcps_owned`. The President rule covers every stored image and every manufacturer-permitted file; the database cannot detect mislabelling.
- **Credential evidence, the other direction.** M3 refuses credential evidence that is put into a lesson. But a future learner-upload operation (A2E) could attach a media record that a draft lesson already uses as credential evidence. That operation must create its own media record and refuse media that a lesson already uses.
- **Learner error messages.** The draw's detailed errors (module names, counts) are for staff. The A2E learner API must map an exam-start refusal to a generic "exam not available".
- **Availability.**
  - A routine fact correction can make a published version's exam refuse to start (by design: no unverified fact reaches a scored exam).
  - The builder (stage 3) should warn about this when a fact is corrected.
  - A lesson with no blocks can still be published. The readiness check (builder, then C2) covers this.
- **Rollback limit.** The rollback cannot run once a version with a distribution is published (see Rollback).

## Files and SHA-256

| File | SHA-256 | Bytes / lines |
|---|---|---|
| `supabase/academy_a2d_m3_author_ops.sql` (migration) | `a7409b5685b8dff8b922ea990efa5c328e4e423793584a7bfc6e9f0487de4d92` | 73,375 / 1,018 |
| `supabase/academy_a2d_m3_rollback.sql` | `f98cda23f94083b3df0c8a8dd8f43fbeea2cf2614aac7c7e1cf6aa619f5f4d78` | 6,574 / 90 |
| `supabase/academy_a2d_m3_preflight.sql` (read-only) | `349805569f34c00126500f84961c96c284f96441e7be571733fa42f014f5d324` | 11,256 / 135 |
| `supabase/academy_a2d_m3_postcheck.sql` (read-only) | `6da005a89bed7595857ead1cfe1dea96676f9256f5f380babc303ed4bff2e6b2` | 7,258 / 60 |
| `supabase/academy_a2d_m3_acceptance_tests.sql` | `61e10dd32945e9341bbd49ed84b776d01fce4ea6da65a6a53e778fa985d17ab9` | 62,639 / 583 |
| `scripts/academy_m3_public_probe_browser.js` | `82236c7fe58d840832878901b8c07b1b8716056f94334565f2cd3bfdce9aa87e` | 5,707 / 73 |
| `supabase/academy_a1_acceptance_tests.sql` (was `10c3ad57…`) | `359947c03432bc1fd5bbcbb87b0ede3910076795f55d167af01d8789e8ebb192` | 20,515 / 277 |
| `supabase/academy_a2a_m1_acceptance_tests.sql` (was `1046b528…`) | `7041abe22765f11717fc084d8750a9b844a888587076cfe6b34cc109fb6e885b` | 35,704 / 392 |
| `supabase/academy_a2c_m2_acceptance_tests.sql` (was `9b89456c…`) | `fff5e7c7ad30a6c5904bca4262af36e1faab4daecc170aeeffaa1547f9197805` | 34,135 / 379 |

Installed-code fingerprints, also written in the postcheck header:

| What | Unix line endings | Pasted from Windows |
|---|---|---|
| M3 functions | `e48e4c2758dae2be0e679c3b9cbe97e8` | `9f41ee27d9ea6b271b35ea5ec1a25c7e` |
| start-attempt (after M3) | `c433af0a852d208e9a6047d9e654e612` | `4ab3615ae6825feac9ac27feaa09dbe2` |
| the other 18 M1 functions (unchanged) | `e05951fca31652f7289b1be904cc079a` | `30a6a689fca7ed63c0c24ce774d514be` |
| M2 (unchanged) | `f24e4f888c8ed7a4e0765382737dfe35` | `794f3c3e007bf3cc6d72b574aac614e3` |

The full M1 fingerprint changes because start-attempt changes. The rollback restores `130e45fa…` (Unix) or `e70543ba…` (production's Windows form).

### Why the A1, M1 and M2 acceptance files changed again

- **Marker lines.** Their setups wrote questions, media and fact links directly. M3 guards those tables, so the setups now set the operation marker around those inserts, the same way M2 did for content. These are added or moved marker lines only; no test or expectation changed.
- **M2 check 3** ("M1 untouched"):
  - without M3 installed, it checks M1's full fingerprint as before;
  - with M3 installed, it checks the other 18 M1 functions exactly and that start-attempt draws through M3.
- **Local hardening files** (not production files):
  - `test/academy/atomicity.sql` and `test/academy/m2_content.sql` got the same marker lines;
  - `m2_content.sql`'s one exam question now has a module, because every module is represented.

The suites prove both states:
- **Without M3:** A1 27/27, M1 43/43 and M2 21/21 still pass.
- **With M3:** all three, plus the M1/M2 hardening files, pass too.

## Test results (local)

| Suite | PostgreSQL 16.15 (with pg-safeupdate) | PostgreSQL 17.6 (production's version) |
|---|---|---|
| `test/academy-m3.pg.test.js` (28: preflight, install, postcheck, acceptance, hardening, A1/M1/M2 regressions, 5 two-session concurrency tests, rollback, re-install, Windows-paste form, static checks) | 28/28 | 28/28 |
| M3 acceptance (24 tests + leftover check) | 25/25 | 25/25 |
| M3 hardening `test/academy/m3_author.sql` | 12/12 | 12/12 |
| With M3: A1 / M1 / M2 acceptance | 27 / 43 / 21 | 27 / 43 / 21 |
| With M3: M1 hardening / all-or-nothing / M2 hardening | 28 / 11 / 9 | 28 / 11 / 9 |
| `test/academy-a2a.pg.test.js` / `test/academy-m2.pg.test.js` | 18 / 18 | 17 + the known safeupdate line / 18 |
| SQL mutation tests `test/academy-m3.mutants.js` (each removes one safeguard; clean control first) | **75/75 killed** | — |
| Academy JS suites: a2a 31, c1 49, c1 mutants 39/39, a2a mutants 32/32 | all pass | — |

PG17.6 has no pg-safeupdate locally. The static check that every UPDATE and DELETE has a WHERE clause covers that.

The rest of the repo was checked too:
- All 93 test files were run.
- The only failures come from the workspace itself (the ordering repo and the `xlsx` package are missing here), and the same files fail in the same way on `main`.
- M3 changes no application code.

## Security and compatibility review

An independent reviewer worked without seeing how M3 was written.

**First pass:**
- **No blocking issues:** no privilege escalation, no way around the guard, no answer key exposed, no way to change published content.
- **Should-fix findings, now fixed:**
  - a downgrade could remove the President's approval of a manufacturer file;
  - automatic mode could skip a module;
  - upper-case module ids silently cleared the distribution;
  - the rollback needed its own exact-restore check and a documented limit;
  - credential media could be used in a lesson;
  - two records could claim the same file;
  - seven test gaps.

**Second pass:** every finding confirmed fixed. One missing test, now added.

**Verdict on the start-attempt change: APPROVE**, assuming Angelo accepts the "checked when drawn" decision above.

**What M3 leaves alone:**
- A1, M1 (other than start-attempt) and M2 code;
- grants, policies, RLS and other functions outside and inside the Academy;
- every table outside the Academy;
- every switch.

Only one table's columns change (`academy_modules`), and the preflight reports that column separately.

## Production preflight plan (for when Angelo approves the run, not before)

### Before the run

1. **Read-only preflight.** Angelo pastes `supabase/academy_a2d_m3_preflight.sql` into the SQL editor and sends back the JSON. It should show:
   - `ready_for_m3` true;
   - M1 `e70543ba…` (19 functions, 6 triggers) and M2 `794f3c3e…` (15 functions, 8 triggers);
   - `m3_installed` false and `exam_quota_column` false;
   - switches with only `academy_admin` true;
   - `start_attempt.server` true and `public_keys` false.

   Record its content and audit row counts as the baseline.

   **If any Academy record exists:** if Angelo has created any Academy record since the activation check (`content_rows` or `audit_rows` above 0), then A1 check 27 and M1 check 43 will report FAIL **by design**, because those two checks require completely empty Academy tables. In that case the M2 check 21 and M3 check 25 leftover checks, which compare before and after counts, are the ones that count. That situation is to be discussed before running anything.
2. **Backup.** Confirm a recent daily backup exists. Point-in-time recovery is not enabled.
3. **Checksum and paste.** Claude reads the exact migration (sha256 `a7409b56…4d92`) from the merged or approved commit. Angelo pastes it into the editor himself and checks the sha256 there before pressing Run. **Do not run any read-only query in that editor tab while the migration waits** (MI-1b lesson).

### Run

4. Angelo runs the migration. Expected outcome: it commits with no error (it is one transaction).

### After the run, one step at a time (stop at any unexpected result)

5. **Postcheck.** Expected values:
   - `m3_code_fingerprint` `9f41ee27…` (Windows paste) or `e48e4c27…`;
   - `start_attempt_fingerprint` `4ab3615a…` or `c433af0a…`;
   - `m1_except_start_attempt` `30a6a689…`;
   - M2 `794f3c3e…`;
   - 24 functions, 12 server-only operations, 0 helpers callable by the server, 0 callable by the public keys;
   - the guards on the three tables and the publish check on versions;
   - start-attempt `{draws_through_m3: true, server_only: true}`;
   - `exam_quota_column` true;
   - switches unchanged.
6. **M3 acceptance:** 24 tests + check 25, all PASS. Test 13 may note that no second administrator exists; that part is covered locally.
7. **A1 acceptance:** 27/27. **M1 acceptance:** 43/43. **M2 acceptance:** 21/21. All are re-run because their setups changed and M2 check 3 now reads the M3 state.
8. **Preflight again.** Every fingerprint must equal step 1. Only the M3 objects, `exam_quota_column`, `start_attempt` (new fingerprint, still server-only), `content_triggers` and `ready_for_m3` may change. Row counts must be as in step 1.
9. **Postcheck again** after the tests. Rows must be as in step 1.
10. **Public-key probe:** `scripts/academy_m3_public_probe_browser.js` in a blank tab, with the key checked first. Expected: **ALL 32 CHECKS BLOCKED** (22 M3 functions, start-attempt, and insert/edit/delete on the 3 tables).

### Rules during and after

- Never roll back on suspicion.
- Never rerun A1, M1, M2 or M3.
- The Command Center does not call M3 until the builder PR is merged. Until then, M3 changes nothing anyone sees.

## Rollback

`supabase/academy_a2d_m3_rollback.sql` runs as one transaction. It:
1. puts back M1's start-attempt exactly, checked against the approved text with `md5(replace(prosrc, E'\r',''))` = `9efd2e88…`;
2. drops the publish check, the six guard triggers and every `academy_author_*` function;
3. drops `exam_quota`.

It removes no rows. It refuses to run, removing nothing:
- while any module still holds a distribution number;
- if M1 or M2 is not intact.

**Limit: no rollback after a distribution is published.** A **published** version's distribution is frozen, so once a version with a distribution is published this rollback can no longer run, because it would change how live exams are drawn. That would need its own reviewed plan.

Rule 19 applies: the rollback re-opens direct writes to questions, media and fact links, so it is never a reaction to suspicion.

## Next stages (not started; each needs Angelo's approval)

1. **Production run of M3** (the plan above).
2. **Lesson engine PR:** block renderer, staff preview, five-width and accessibility tests.
3. **Builder PR:** Courses-tab builder, question-bank editor, media upload, readiness check, and `_academy.js authorOp()` calling these operations.
4. **Review gate before A2F:** Samples A and B, on desktop and on mobile.

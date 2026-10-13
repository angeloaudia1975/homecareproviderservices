# A2D M3.1 — Atomic lesson save (runbook)

Design approved by Angelo on 12 Oct 2026 at 21:00 CT, for development and local testing only. Production installation and
merging the PR are separate approvals. Design doc: claude.ai/code/artifact/58bc45d7-70b4-4449-a6b7-02a0f82aec2e.

## What it is

One database operation saves a lesson's screens and their product-fact links together:
`academy_save_op_lesson(p_actor, p_lesson_id, p_base_blocks, p_blocks)`.

In one transaction it:
1. checks the acting person is an active administrator (named from the sign-in);
2. locks the draft version, then the lesson;
3. compares the stored screens with the starting point, and refuses with "changed" (40001) **before writing anything**;
4. works out the fact links from the screens and creates the missing ones;
5. runs the unchanged M3 block checker (it sees the new links, so its "link the fact first" rule is met in the same transaction);
6. writes the screens and removes this lesson's links that the screens no longer use (never question links, other
   lessons' links or product facts);
7. writes ONE audit row (`save_lesson`, with the links added and removed).

Any failure rolls everything back. The builder's save is now that one call; without M3.1 it answers 503, never the old
sequence. President-only editing stays in the server; the database keeps M3's rule (any active administrator).

New objects: `academy_save_op_lesson` (server role only) and `academy_save_lesson_links` (owner only). Nothing else changes:
no table, column, trigger, policy or grant on a table; M1, M2 and M3 code is byte-identical.

## Files and checksums (sha256)

| File | sha256 |
|---|---|
| `supabase/academy_a2d_m3_1_save_lesson.sql` (the migration) | `22fdbd9fd5b4391404cabad22e820b57ca1343e1c225069df8a91bb73ebf4d64` |
| `supabase/academy_a2d_m3_1_rollback.sql` | `a6a0425b964a66c66301e98dec774c02cab8e76ab2c9068ef80232761910f315` |
| `supabase/academy_a2d_m3_1_preflight.sql` (read-only) | `11f1a4d8ca6e725d1c5162dbce221a4a32bcc0238051808e558ff9821d6e3761` |
| `supabase/academy_a2d_m3_1_postcheck.sql` (read-only) | `b3a46211bd3e315b711a7c7bbdc79d1c767741d5654f2c992203ab4ce768c492` |
| `supabase/academy_a2d_m3_1_acceptance_tests.sql` (undone) | `29da8880e55c74ae2d309add3eca0b4e90178fafd9af65049b4e2c45b75366e9` |
| `scripts/academy_m3_1_public_probe_browser.js` | `3b1dd746450eaaa03422bcac6e99b2fe13be5c36bfb94e3a7fc0d95ff5c25072` |

Installed-code fingerprint (postcheck `m3_1_code_fingerprint`): `17088d8189f50faa7662f6cec4899825` with Unix line endings,
or `1306b90bb29549c2c1e2aec0428cdb0f` when pasted into the SQL editor from Windows (as production M1/M2/M3 were).

## Production procedure (only after Angelo approves this exact file)

1. **Preflight (read-only):** run the preflight; expect `ready_for_m3_1: true`. M1 `a809004b…`, M2 `794f3c3e…`, M3 `9f41ee27…`
   (the Windows-paste forms), only `academy_admin` on. Keep the output: `lessons_fingerprint` and
   `content_refs_fingerprint` record the Golden draft.
2. **Migration:** Angelo pastes the migration verbatim in the SQL editor (checksum confirmed first) and presses Run. A
   second Run is refused ("already exists") and changes nothing.
3. **Postcheck (read-only):** `m3_1_code_fingerprint` `1306b90b…` (or `17088d81…`); M1/M2/M3 fingerprints unchanged;
   functions 2; operation server-only; helper not callable by the server; 0 for public keys; content rows,
   `lessons_fingerprint`, `content_refs_fingerprint` and `audit_rows` exactly as in the preflight.
4. **Acceptance tests:** 17/17 PASS (check 17 confirms nothing was left behind and every lesson is byte-identical). Then
   M3 acceptance (25) and M2 acceptance (21) as leftover checks. A1 check 27 and M1 check 43 need empty Academy tables, so
   they FAIL by design now that the Golden draft exists; do not run them.
5. **Preflight again:** identical to step 1 except `m3_1_installed`, `m3_1_objects` and `ready_for_m3_1`.
6. **Public-key probe:** `scripts/academy_m3_1_public_probe_browser.js`, 8 checks, all BLOCKED.
7. **Only then** merge the PR (with Angelo's approval) and deploy. The deployed builder needs M3.1: never deploy it first.
8. **Live check:** one real save in the builder by the President (a genuine edit to a sample lesson), then preview.

Any unexpected value = stop and report. Never roll back on suspicion.

**Rollback:** revert the builder first (the old builder saves through M3), then run the rollback file. It drops only the
two functions and refuses unless M1, M2 and M3 are intact. Lessons, links and `save_lesson` audit rows stay.

## Tests (local)

| Test | What it covers | Result |
|---|---|---|
| `test/academy-m3_1.pg.test.js` | Preflight, migration (and refused re-run), postcheck, preflight after, acceptance ×2, M3/M2 acceptance, simultaneous saves (one wins), a reader during a save sees the old screens, saves of two lessons serialize, a save killed mid-transaction leaves nothing, forged marker refused, rights, rollback and reinstall, Windows paste fingerprints | 16/16 on PG16 (pg-safeupdate) and PG17.6 |
| `supabase/academy_a2d_m3_1_acceptance_tests.sql` | 16 tests + leftover check: links created and accepted in the same transaction, one audit row, conflicting version, refused screens roll back their links, pruning only this lesson's links (question links, other lessons and product facts untouched), checker still decides, drafts only, actor rules, marker, audit failure, interrupted write, link reuse, null-field links, other columns untouched | 17/17 |
| `test/academy-m3_1.mutants.js` | SQL mutants: no compare-and-set, no locks, pruning other lessons / question links / needed links, no link creation, no checker, no audit row, any actor, marker left set, public grant, missing base, variant | 13/13 killed, clean control |
| `test/academy-builder.pg.test.js` | The builder against real Postgres with M3.1: one call, one audit row, refused saves leave nothing, failure injection (write refused after links, audit refused, someone saves first, lost answer → "reload", connection failure, not installed → 503), question links untouched | 28/28 on PG16 and PG17.6 |
| `test/academy-builder.mutants.js` | Builder server mutants incl. the new save | 30/30 killed, 6 held by a second layer |
| Regression | builder browser 13, builder 16, C1 50, A2A 31 + pg 18, M2 pg 18, M3 pg 28 (PG16 and PG17.6), lesson 23 + pg 5 | All pass |

## Production preflight (read-only) — PASSED, Angelo, 12 Oct 2026 22:19 CT

`ready_for_m3_1: true`. M1 19 / 6 / `a809004b8fe77dce69cfc555ff984bdb`, M2 15 / 8 / `794f3c3e007bf3cc6d72b574aac614e3`,
M3 24 / 7 / `9f41ee27d9ea6b271b35ea5ec1a25c7e`, start-attempt `4ab3615ae6825feac9ac27feaa09dbe2` (server only, draws through M3),
no M3.1 object, PostgreSQL 17.6, 1 active President, switches `{academy_admin: true}` only.
Baseline to compare after the migration and the tests:
- content rows: courses 1, versions 1, modules 11, lessons 17, questions 7, media 0, content_refs 71, product_facts 0; audit rows 110;
- `lessons_fingerprint` `9bdb8f44c5ee30d220d1a91a467ebb66`, `content_refs_fingerprint` `7fbd3ca991475ef34cdeb12b9bac390f`;
- Academy grants `7af6d10ef284760d9fb9ca840fad04b7 / 252`, columns `162e4192ddd7b833caf836c9e5800844 / 180`, policies 0, RLS 18 / 18;
- outside the Academy: grants `248be67b18fe1fdefe6c70d143afdfc1 / 2956`, columns `764813c5ddc56dd0c1cc8dc7e22b6691 / 127 tables`,
  policies `219ac18ed7a25a0db2d9a50c5b8a88e7 / 29`, other functions `b116ce12e0682238c373156d8fe8b944 / 106`.
Backup: newest daily backup 12 Oct 2026 09:10 UTC (before the Golden draft was created); PITR not enabled.

## Production installation — Angelo, 12 Oct 2026 ~22:24 CT

- Migration run in the SQL editor ("Success. No rows returned").
- Postcheck: M3.1 `1306b90bb29549c2c1e2aec0428cdb0f` (Windows paste, as precomputed); 2 functions; operation server-only; helper not
  callable by the server; 0 for public keys; M1 `a809004b…` / M2 `794f3c3e…` / M3 `9f41ee27…` and their counts unchanged; content
  rows, `lessons_fingerprint` `9bdb8f44…`, `content_refs_fingerprint` `7fbd3ca9…` and 110 audit rows identical to the preflight;
  only `academy_admin` on.
- M3.1 acceptance tests: 17/17 PASS (check 17: nothing left behind, every lesson byte-identical) — 22:26 CT.
- Public-key probe (`scripts/academy_m3_1_public_probe_browser.js`, Angelo, 22:31 CT): ALL 8 BLOCKED (401) — both M3.1 functions
  and the direct insert / edit / delete on academy_lessons and academy_content_refs.
- Preflight again (Angelo, 13 Oct 2026 ~10:02 CT): identical to the 22:19 baseline on every recorded value — M1 19 / 6 /
  `a809004b…`, M2 15 / 8 / `794f3c3e…`, M3 24 / 7 / `9f41ee27…`, start-attempt `4ab3615a…` (server only, draws through M3),
  content rows 1 / 1 / 11 / 17 / 7 / 0 / 71 / 0, `lessons_fingerprint` `9bdb8f44…`, `content_refs_fingerprint` `7fbd3ca9…`,
  110 audit rows, 1 active President, switches `{academy_admin: true}` only, Academy grants `7af6d10e… / 252`, columns
  `162e4192… / 180`, 0 policies, RLS 18 / 18; outside grants `248be67b… / 2956`, columns `764813c5… / 127`, policies
  `219ac18e… / 29`, other functions `b116ce12… / 106`. Only `m3_1_installed` (true), `m3_1_objects` (the two functions) and
  `ready_for_m3_1` (false) changed, as expected. The 20 content triggers are the A1 / M1 / M2 / M3 set (M3.1 adds none).
  Outside row counts (monthly_sales 12,575 = the 12 Oct 21:37 CT recorded baseline) were not part of the 22:19 record.
  **Record-integrity comparison PASSED.** PR #12 waits for Angelo's merge approval.

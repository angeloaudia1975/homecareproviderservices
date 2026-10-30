# Smart Email Learning — Phase 2: learning, suggestions, owner approval, versions

Owner decisions (Angelo, 2026-10-30; CLAUDE.md §16). Phase 2 turns the owner's repeated edits into **suggested** writing rules.
Nothing is used until the owner approves it, and **approved rules change no email in Phase 2** — applying them to drafts is Phase 3,
behind its own switch.

## What it does
- **Analyser** (`netlify/functions/_email_learn.js`, pure code — no AI, no network; owner decision 5): compares each kept draft with
  the version sent (sentence by sentence) and finds: deleted sentences, rewritten sentences, added sentences (opening / closing /
  middle), greeting changes, cutting or growing the email by a quarter or more, and subject rewrites.
- **Masking** before anything is compared or stored: e-mail addresses, links, phone numbers, amounts, dates, times, numbers, the
  dealer's own name and the greeted person's name become `{email} {link} {phone} {amount} {date} {time} {number} {dealer} {name}`;
  any other capitalised word inside a sentence becomes `{name}` (manufacturer names, HCPS words and weekdays stay). A phrase that
  still holds a digit or an "@" is dropped; the database refuses one too (`email_learning_rules_masked_ck`).
- **Suggestion threshold** (owner decision 3): the same masked edit in **3+ different sent emails to 2+ different dealers**, checked in
  the code and again in the database. One email counts once. The same edit across types is suggested once for "every type".
- **Owner decisions** (Email Learning → Learned rules): Approve (optionally reworded), Reject, Retire, Reword — each with a reason,
  by the verified sign-in (never a name in the request), only by the **active President** in `staff_users`, only from the version
  on screen (`version_conflict` otherwise; simultaneous decisions are serialised). A rejected rule is never suggested again; the
  analyser never changes a decided rule's status or wording.
- **Versions** (Email Learning → Versions): every change of the approved set is a numbered version holding the whole set. Restore
  an earlier version or Reset (version 0 = no rules) creates a new version; nothing is erased. Versions and events are insert-only.
- **When it runs:** "Look for patterns now" (owner's button), and daily in `email-learning-purge-cron` **only while
  `phase2_flags.email_learning_suggest` is exactly `true`** (default off). It reads only sent, edited drafts whose text is still kept.

## Database — `supabase/email_learning_p2_rules.sql` (NOT RUN; Angelo runs it; needs Phase 1)
sha256 `998eaac5b700f7478914ac115e2a57a6ad154d8970ddc0a458955ff34b8dd9c0`. Tables `email_learning_rules`,
`email_learning_profiles`, `email_learning_rule_events` — RULE 19 locked (RLS on, no policies, nothing for anon / authenticated /
PUBLIC, service_role SELECT only). Writes only through `hcps_email_rule_note`, `hcps_email_rule_decide`,
`hcps_email_profile_rollback` (+ read `hcps_email_rule_version`), security definer, service_role only; helpers `hcps_email_rule_president`
/ `hcps_email_rule_snapshot` / the guard callable by nobody. Guard = marker + the owner's rights (a role given write rights is still
refused). Every UPDATE has a WHERE clause; no DELETE. Install ends with 8 checks (all ok = true; check 8 = the suggestion switch was
not turned on by the migration).

Postcheck (read-only): `supabase/email_learning_p2_postcheck.sql` — sha256 `86d0ac92ef71e9761cb5332e6023d0b82838fa4461b564e9decb8378bf57678b`.
Expected code fingerprint (row 2): `cfe685124db794e4939cfdd5b0f446fd` when pasted into the SQL editor (Windows line endings),
`9be1dfb8622011dfa37c883c54550028` with Unix line endings — both reproduced locally. **A comment line inside a function body is part of
the fingerprint (Phase 1 lesson): paste the committed file byte for byte.** Per function (Windows paste):

| function | md5 | length |
|---|---|---|
| hcps_email_profile_rollback | eebc4ccd19cadc3986171bf2dbeb0f7d | 3085 |
| hcps_email_rule_decide | e7d8661a63651105541519ff38f8d576 | 3153 |
| hcps_email_rule_guard | dd7d7dbb0a361e058635def175a21b67 | 2052 |
| hcps_email_rule_note | 303db108f65c07a0096b5c86ebfaeff0 | 2803 |
| hcps_email_rule_president | f514edab5ad61faca0d18474220a6d9f | 199 |
| hcps_email_rule_snapshot | 031c70acb6977f5bd725c7a1e34f80e8 | 237 |
| hcps_email_rule_version | 5f83faa3746ad7c40be08bc93607ba18 | 74 |

Public-key probe: `scripts/email_learning_p2_public_probe_browser.js` (18 checks, all BLOCKED).
Rollback: `supabase/email_learning_p2_rules_rollback.sql` — sha256 `ce97a63a55f1d4b99be601948d7fbd0aba79fbc740bef69d1f4cf59f601613c0`;
refuses while any rule, version or event exists; leaves Phase 1 alone.

## Order when approved
1. Merge + deploy the code (safe before the SQL: the page says "Learning isn't installed yet"; learning actions answer 503; the
   daily job skips). 2. Angelo runs the migration (8/8 ok). 3. Postcheck (row 2 = `cfe68512…`) + public-key probe (18/18 BLOCKED).
4. Owner tries "Look for patterns now". 5. Only if he wants the daily check: `email_learning_suggest` → true.
Turning the switch off stops the daily check; decided rules stay as they are.

## Tests (synthetic data only)
`test/email-learning-p2.test.js` (16, real handlers), `test/email-learning-p2.pg.test.js` (24, Postgres 16 incl. true concurrency and
a role given write rights), `test/email-learning-p2.ui.js` (11, Chromium, 360 / 390 / 768 / 1280), mutants
`test/email-learning.mutants.js` (Phase 1 + 2: 53/53 killed, both controls clean). Phase 1 suites unchanged and passing.

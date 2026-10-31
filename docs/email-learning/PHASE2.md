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
  any other capitalised word — at the start of a sentence, after a title (Mr., Dr.) or ":", or inside it — becomes `{name}` unless it is
  an ordinary sentence-opening word ("Please", "Thanks", "We"); only "I", "HCPS", "OK" and weekdays stay (manufacturer names are masked
  too: they appear inside dealer names). The greeted person's name is masked in any case ("thanks pat"); bare domains and spelled-out
  addresses ("bob at acme dot com") are masked as links / addresses. Masking over-masks rather than under-masks. A phrase that
  still holds a digit or an "@" is dropped; the database refuses one too (`email_learning_rules_masked_ck`).
- **Suggestion threshold** (owner decision 3): the same masked edit in **3+ different sent emails to 2+ different dealers**, checked in
  the code and again in the database. One email counts once. The same edit across types is suggested once for "every type", and an
  edit already known under any email type (`pattern_key`) — suggested, approved, rejected or retired — never becomes a second rule:
  a rejected edit never comes back in another scope.
- **Owner decisions** (Email Learning → Learned rules): Approve (optionally reworded), Reject, Retire, Reword — each with a reason,
  by the verified sign-in (never a name in the request), only by the **active President** in `staff_users`, only from the version
  on screen (`version_conflict` otherwise; simultaneous decisions are serialised). A rejected rule is never suggested again; the
  analyser never changes a decided rule's status or wording.
- **Versions** (Email Learning → Versions): every change of the approved set is a numbered version holding the whole set. Restore
  an earlier version or Reset (version 0 = no rules) creates a new version; nothing is erased. Versions and events are insert-only.
- **When it runs:** "Look for patterns now" (the owner's own click — it works whatever the daily switch says), and daily in `email-learning-purge-cron` **only while
  `phase2_flags.email_learning_suggest` is exactly `true`** (default off). It reads only sent, edited drafts whose text is still kept.

## Database — `supabase/email_learning_p2_rules.sql` (NOT RUN; Angelo runs it; needs Phase 1)
sha256 `f440d45c59cb9367c83f8c8a5de947f86df90455b5fc7d57a5ba6e986284efa1` (exact-head review fixes, 2026-10-31; was `5a464349…`).
The note function COUNTS the evidence itself from the `draft_ids` it is given (only sent, edited drafts written by the active
President); a decision must carry the rule's status on screen (`expected_status`); one rule per edit (unique `pattern_key` +
advisory lock); the wording holds no digit except a percentage. Tables `email_learning_rules`,
`email_learning_profiles`, `email_learning_rule_events` — RULE 19 locked (RLS on, no policies, nothing for anon / authenticated /
PUBLIC, service_role SELECT only). Writes only through `hcps_email_rule_note`, `hcps_email_rule_decide`,
`hcps_email_profile_rollback` (+ read `hcps_email_rule_version`), security definer, service_role only; helpers `hcps_email_rule_president`
/ `hcps_email_rule_snapshot` / the guard callable by nobody. Guard = marker + the owner's rights (a role given write rights is still
refused). Every UPDATE has a WHERE clause; no DELETE. Install ends with 9 checks (all ok = true; check 8 = the suggestion switch was
not turned on by the migration; check 9 = one rule per edit, unique `pattern_key`).

Postcheck (read-only): `supabase/email_learning_p2_postcheck.sql` — sha256 `bcdc6c17aba78133c2ee2ffe23d23af400039c13d07242fb43009f5b8bed78a8` (row 8 = the plain-text rule works under the
production collation: expect `true / true / false`, ok = true); earlier `86d0ac92…`.
Expected code fingerprint (row 2): `e566e3410ea75bf69ea5f57518ae675a` when pasted into the SQL editor (Windows line endings),
`eb5db477787b5e3fbcafccc4d779e189` with Unix line endings — both reproduced locally. **A comment line inside a function body is part of
the fingerprint (Phase 1 lesson): paste the committed file byte for byte.** Per function (Windows paste):

| function | md5 | length |
|---|---|---|
| hcps_email_profile_rollback | 9e5f9abd9d03f5ddd802d5f2ad454af8 | 3078 |
| hcps_email_rule_decide | c052bc6dd912ace166c02961b903a7e3 | 3508 |
| hcps_email_rule_guard | dd7d7dbb0a361e058635def175a21b67 | 2052 |
| hcps_email_rule_note | 9d773b4152873ce3f3ec1f0b13551400 | 3811 |
| hcps_email_rule_president | f514edab5ad61faca0d18474220a6d9f | 199 |
| hcps_email_rule_snapshot | 031c70acb6977f5bd725c7a1e34f80e8 | 237 |
| hcps_email_rule_version | 5f83faa3746ad7c40be08bc93607ba18 | 74 |

Public-key probe: `scripts/email_learning_p2_public_probe_browser.js` (18 checks, all BLOCKED).
Rollback: `supabase/email_learning_p2_rules_rollback.sql` — sha256 `ce97a63a55f1d4b99be601948d7fbd0aba79fbc740bef69d1f4cf59f601613c0`;
refuses while any rule, version or event exists; leaves Phase 1 alone.

## Order when approved
1. Merge + deploy the code (safe before the SQL: the page says "Learning isn't installed yet"; learning actions answer 503; the
   daily job skips). 2. Angelo runs the migration (9/9 ok). 3. Postcheck (row 2 = `e566e341…`) + public-key probe (18/18 BLOCKED).
4. Owner tries "Look for patterns now". 5. Only if he wants the daily check: `email_learning_suggest` → true.
Turning the switch off stops the daily check; decided rules stay as they are.

## Tests (synthetic data only)
`test/email-learning-p2.test.js` (21, real handlers), `test/email-learning-p2.pg.test.js` (28, Postgres 16 incl. true concurrency for
decisions AND for two analysis runs, a role given write rights, drafts that must not count), `test/email-learning-p2.ui.js` (11,
Chromium, 360 / 390 / 768 / 1280), mutants `test/email-learning.mutants.js` (Phase 1 + 2: 77/77 killed, both controls clean).
Phase 1 suites unchanged and passing.

## Independent review (2026-10-30)
- HIGH (fixed): names at the start of a sentence / after titles / after ":" / in lowercase, other dealers' names, bare domains and
  spelled-out addresses could survive masking. Now masked (tests list every case; mutants for each mask rule).
- MEDIUM (fixed): a rejected edit could return under another email type → `pattern_key` + `sibling_exists` in the database.
- LOW (fixed): non-numeric versions / missing counts answer a status instead of an error; newest drafts are read first.
- LOW (by design): "Look for patterns now" works with the daily switch off — it is the owner's explicit click.

## Exact-head review (2026-10-31, head ce45507 after merging main incl. PR #71) — verdict NO-GO, every finding fixed
- HIGH (fixed): names after "(", quotes, dashes, "/" or a comma with no space, names in other alphabets ("José"), spelled-out
  addresses without spaces and domains with other endings survived masking — and rule rows can never be deleted. Now masked, and a
  phrase still holding a non-A–Z letter, a capitalised non-opener or "(at)" / "[dot]" is dropped (fail closed). Tests list each case.
- MEDIUM (fixed): a reject makes no version, so a stale tab could approve a rule rejected meanwhile → `expected_status` (API + DB).
- MEDIUM (fixed): the analyser read every author's drafts → only the active President's (runner + database recount).
- LOW (fixed): the database trusted the caller's counts → it counts `draft_ids` itself; digits in the wording → refused except a
  percentage (code + DB); two simultaneous runs could suggest an edit twice → unique `pattern_key` + advisory lock; "not installed"
  matched any "does not exist" error → only a missing Phase 2 table / function.

## Second exact-head review (2026-10-31, head f9ee195) — verdict NO-GO (one MEDIUM), fixed
- MEDIUM (fixed): full-width digits, "＠", "_at_" / "-at-", "。" and zero-width characters got past the ASCII-only checks in code
  AND database. Now every phrase is NFKC-normalised and stripped of invisible characters before masking; a stored phrase, example
  or wording may hold only printable ASCII + ‘ ’ “ ” – — … → − (code: `ALLOWED_TEXT`; database: the masked check and decide).
- LOW (fixed): "I've / I'll / I'm / I'd" and more ordinary openers are not names; install check 9 uses `to_regclass`; a bare
  42P01 no longer reads as "not installed".
- LOW (open, recorded for Phase 3): a lowercase name repeated in 3 sends to 2 dealers ("lori will call you") is not masked — no
  masker without a dictionary catches it. Proposed remedy: a President-only **Redact** decision (blank the pattern and examples,
  keep the row and log the event). Until then the owner rejects such a suggestion; the text stays in the rejected row.
- LOW (open): an "every type" rule stops refreshing its counts once a single type also qualifies (evidence only, no security).

## Third exact-head review (2026-10-31, head bdc4b68) — verdict GO
MEDIUM-1, LOW-2, LOW-4 verified closed. Fixed after it (JS + read-only postcheck only; the migration is unchanged, sha `f440d45c…`):
a "{word}" that is not a real placeholder ("{jordan}", "{at}") is refused; postcheck row 8 proves the plain-text rule under the
production collation. Open, recorded: deliberately obfuscated ASCII addresses ("patATacmeDOTcom") — same class as LOW-1, Redact in
Phase 3; decision reasons are the owner's own free text (3–500 characters) and are stored as he types them.

## Installed and verified in production (2026-10-31 ~13:10 CT)
Migration run by Angelo (sha256 `f440d45c…efa1`): install checks 9/9 ok. Postcheck: 7 functions, row 2 =
`e566e3410ea75bf69ea5f57518ae675a` (Windows paste, as expected), RLS 3 / 0 policies, 0 anon / authenticated / PUBLIC grants,
6 guard triggers, `email_learning_suggest` absent (OFF), 0 / 0 / 0 rules / approved / versions, row 8 `true / true / false`.
Public-key probe (storefront publishable key, verified on a public table first): 18/18 BLOCKED (HTTP 401). Live page: Learned
rules and Versions render (current version 0). Never rerun or roll back the migration. The daily switch stays OFF until Angelo
turns it on; "Look for patterns now" is available to him.

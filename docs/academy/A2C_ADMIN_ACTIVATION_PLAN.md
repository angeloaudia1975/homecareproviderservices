# Academy Command Center: staff-only activation plan (PROPOSED, not approved)

Status: **proposal for Angelo's review.** `academy_admin` stays OFF until Angelo approves activation separately.
Learner access, enrollment, real course publishing, certificates, payments and automatic Golden product updates stay
disabled throughout.

## Who gets access when it is on
The server lets in only an active `staff_users` row whose role is president, admin or owner (`A.requireAdmin`).
- Reps and Relations get 403 on every action; the page shows "HCPS administrators only".
- Anyone without a Connect 360 staff sign-in gets 401: dealers, Partner 360 accounts, learner cookies, forged tokens.
- The database repeats the check on every write (M2): the actor must be an active president, admin or owner, and
  only the President may change a course learners have seen.

Production today has one active President and no admin or owner accounts (M2 acceptance test 15). In practice,
switching on means **Angelo only** until another administrator account is created.

## Step 1: before switching on (read-only)
1. **Who would get access.** Angelo runs:
   ```sql
   select email, role, coalesce(active, true) as active from staff_users order by role, email;
   ```
   Expect exactly the intended administrators to show president, admin or owner with active true. Fix any role before
   activation; a stale admin row would get access.
2. **Switch state.** Every switch must be off: whoami shows them all false, and preflight `academy_switches` is `{}`.
3. **Live refusals while still OFF**, as checked after the PR #7 merge:
   - the President gets 403 `flag_off`;
   - no token or a forged token gets 401;
   - the learner API gets 403;
   - handoff reports `{enabled:false}`.

## Step 2: the switch (one line, reviewed, run by Angelo)
```sql
insert into app_settings (key, value) values ('phase2_flags', '{"academy_admin": true}')
on conflict (key) do update set value = app_settings.value || '{"academy_admin": true}';
```
It changes only the `academy_admin` key and leaves every other switch untouched.

**Switching off again** is the same line with `false`. It is safe at any time: no data is lost, and the page and API
answer "switched off" at once.
```sql
update app_settings set value = value || '{"academy_admin": false}' where key = 'phase2_flags';
```

## Step 3: right after switching on (live, signed in)
1. **President:** whoami `enabled: true`; all six tabs load; the Overview shows 0 courses, versions, learners and
   certificates; the records check reports clean, with nothing to check.
2. **Rep and Relations:** with Greg's or Lori's sign-in (or a staff test account with those roles), the page shows
   "HCPS administrators only" and every API action returns 403. No new menu entry appears for them.
3. **Dealer, learner and anonymous visitors:**
   - a Partner 360 dealer token gets 401;
   - a learner cookie gets 401;
   - no token gets 401;
   - the learner API stays 403 `flag_off`, because `academy_learner` is OFF.
4. **The other six switches** are still false.
5. **Postcheck** (read-only) shows the same M2 fingerprint `794f3c3e…`, M1 `e70543ba…`, and only `academy_admin`
   true in the switches.

## Step 4: first real use (optional, Angelo's choice)
Content writes are permanent history. There is no "delete course" operation, and the audit log is append-only. So the
first authoring action should be content Angelo wants to keep:
- **Option (a):** the real Golden course as a DRAFT. Drafts are never visible to learners: `academy_learner` is OFF,
  and nothing is published without the President.
- **Option (b):** a clearly marked TEST course (`test-…` slug). TEST courses stay out of real figures and can never
  issue a certificate.

After that first write: one audit row with Angelo as the actor, the records check clean, and nothing else changed.

## Guardrails while on
- Do not publish a real course; C2 decides the publication rules first.
- Do not enable learner access, enrollment, certificates, payments, handoff or invites.
- Product facts: approval-required facts need the President as approver; nothing updates automatically.
- If anything looks wrong, switch off with the one-line SQL above. Never roll back M2 for it.

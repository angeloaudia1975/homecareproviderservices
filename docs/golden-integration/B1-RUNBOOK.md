# Golden ⇄ Partner 360 — B0 + B1 activation runbook

This batch is built and tested, but **nothing in it is switched on**. Every step below is a production action that needs Angelo's approval at the time it is done.

- Do the steps in order.
- Each step has a check, and the next step starts only when that check passes.
- Each step can be undone by itself.

**Secrets.** Angelo generates every secret on his own computer (PowerShell, below) and types it into Netlify himself. A secret is never pasted into chat, a ticket, a file, a log or a screenshot.

```powershell
# Windows PowerShell — prints a 48-byte random secret (64 base64 characters). Run once per secret.
$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

## Order of steps

1. **Merge the PRs.** Merge Golden first, then HCPS, then Partner 360, after review and CI.
    - Effect: with every switch off, nothing changes for dealers. One exception: Partner 360's Golden card now links to the Golden platform instead of an empty in-platform catalog.
    - The new Golden `/sso` route is live once merged.
2. **Sign-in secret (separate from events).**
    1. Generate secret A.
    2. Golden Netlify: set `HCPS_SSO_SECRET` = A.
    3. HCPS Netlify: set `GOLDEN_SSO_SECRET` = A.
    4. Trigger a deploy on both sites and confirm both show "Published".
    5. Check: open a Golden sign-in link from Dealer 360. It should land in that dealer's Golden portal.
    6. Then on Golden set `SSO_LEGACY_SECRET` = `off`, redeploy, and confirm the link still works.
3. **Golden storage.** Run `config/migrate-hcps-integration-v1.sql` in the Golden Supabase project: PART 1, then PART 2, then PART 3.
    - Check: PART 3 returns 6 rows. The first five say `ok`; the last says `ok` (no clients yet).
4. **HCPS storage.** Run `supabase/golden_dealer_links.sql` in the HCPS project.
    - Check: the last query returns `t | t | t`.
5. **Integration key.**
    1. Generate secret B.
    2. Golden Netlify: set `HCPS_P360_KEYS` = `{"hcps-p360-1":"<B>"}`.
    3. HCPS Netlify: set `GOLDEN_P360_KEY_ID` = `hcps-p360-1` and `GOLDEN_P360_SECRET` = `<B>`.
    4. Redeploy both sites.
    5. Golden: add the client row with B's **fingerprint**, not the secret. The SQL is sent in chat when this step is approved; its fingerprint comes from a local command.
6. **Switch the Golden API on.** Golden Netlify: `GOLDEN_V1_API` = `true`, then redeploy.
    - Check: Connect 360 → Golden Partner Links shows "configured" and "reachable".
    - `GOLDEN_V1_ORDERS` stays unset.
7. **Linking.** HCPS `app_settings.phase2_flags.golden_p360_links` = `true`.
    1. Propose links for the pilot dealers.
    2. A Golden admin verifies them at `/admin/integration-links.html`.
    3. Refresh them in Connect 360.
8. **Partner 360 eligibility, pilot only.** HCPS `phase2_flags`:
    - `golden_p360_catalog` = `true`
    - `golden_p360_pilot_dealers` = `[<HCPS dealer ids>]`

    The storefront does not use eligibility until Stage 2 ships the Golden catalog adapter.

**Rollback, at any step:**

- HCPS: set `golden_p360_catalog` and `golden_p360_links` to `false`.
- Golden: unset `GOLDEN_V1_API` and redeploy.
- Golden: `update integration_clients set active=false` takes effect immediately.
- The tables stay.
- The sign-in secret: unset `HCPS_SSO_SECRET`, and remove `SSO_LEGACY_SECRET` so the legacy secret works again.

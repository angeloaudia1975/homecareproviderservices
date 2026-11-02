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

1. **Merge the PRs, in this order, after review and CI:**
    1. Partner 360 (#16). It must be **live before** HCPS #74 deploys. Today's live storefront sends Golden lines to `orders-api` and ignores the answer, so once #74 refuses those requests a Golden line would be lost without anyone noticing. Check the live page no longer contains `submitGoldenOrder` before merging #74.
    2. Golden (#278).
    3. HCPS (#74).
    - Effect: with every switch off, nothing changes for dealers. One exception: Partner 360's Golden card now links to the Golden platform instead of an empty in-platform catalog.
    - The new Golden `/sso` route is live once merged.
2. **Sign-in secret (separate from events).**
    1. Generate secret A.
    2. Golden Netlify: set `HCPS_SSO_SECRET` = A.
    3. HCPS Netlify: set `GOLDEN_SSO_SECRET` = A.
    4. Trigger a deploy on both sites and confirm both show "Published".
    5. Check: open a Golden sign-in link from Dealer 360. It should land in that dealer's Golden portal.
    6. Golden accepts the old event secret for links only if `SSO_LEGACY_SECRET` = `on`, which is not set (off by default). Links must carry `aud` and expire within 5 minutes; HCPS #74 builds them that way.
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
6. **Prove the signed path on a deploy preview first.** Give the preview its **own** test secret and key id: never production's, because the signature does not cover the host. Make one signed `/v1/health` call against the preview and confirm 200. This proves Netlify passes `/v1/...` in `rawUrl` exactly as the tests assume. Then:
7. **Switch the Golden API on.** Golden Netlify: `GOLDEN_V1_API` = `true`, then redeploy.
    - Check: Connect 360 → Golden Partner Links shows "configured" and "reachable".
    - `GOLDEN_V1_ORDERS` stays unset.
8. **Linking.** HCPS `app_settings.phase2_flags.golden_p360_links` = `true`.
    1. Propose links for the pilot dealers.
    2. A Golden admin verifies them at `/admin/integration-links.html`.
    3. Refresh them in Connect 360.
9. **Partner 360 eligibility, pilot only.** HCPS `phase2_flags`:
    - `golden_p360_catalog` = `true`
    - `golden_p360_pilot_dealers` = `[<HCPS dealer ids>]`

    The storefront does not use eligibility until Stage 2 ships the Golden catalog adapter.

**Rollback, at any step:**

- HCPS: set `golden_p360_catalog` and `golden_p360_links` to `false`.
- Golden: unset `GOLDEN_V1_API` and redeploy.
- Golden: `update integration_clients set active=false` takes effect immediately.
- The tables stay.
- Sign-in: unsetting `HCPS_SSO_SECRET` turns links off. Setting `SSO_LEGACY_SECRET=on` temporarily accepts the old event secret again, but links still need `aud`.

**Key rotation, any time:**

1. Generate a new secret.
2. Add a **new key id** to `HCPS_P360_KEYS` next to the old one, then redeploy Golden.
3. Insert its `integration_clients` row with the **same `client_id`** (`hcps-partner360`) and its fingerprint.
4. Switch HCPS's `GOLDEN_P360_KEY_ID` / `GOLDEN_P360_SECRET` to the new key and redeploy.
5. Set the old row `active=false`, then remove the old key from the env.

Dealer links hang on `client_id`, so they are unaffected.

**Branches (known Stage 1 limit):** a Partner 360 user on an HCPS **branch** dealer row is answered `branch_not_permitted` until a branch mapping (`dealer_integration_branch_map`) exists. That write path is not built in B1; organisation-level dealers work.

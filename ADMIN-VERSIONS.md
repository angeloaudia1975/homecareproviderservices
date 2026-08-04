# Admin page versions

Every admin page shows a small **VER x.x** badge in the bottom-right corner. It's the
fast way to confirm a deploy actually went live: push, wait ~1–2 min for Netlify, then
hard-refresh (Ctrl+Shift+R) — if the badge number matches the latest below, you're on
the new version.

**Rule for future updates:** whenever an admin page changes, bump that page's version by
0.1 (e.g. 1.1 → 1.2) in both the page and this table, so the badge always tells the truth.

| Page | File | Version | Notes |
|------|------|---------|-------|
| Home | src/admin/index.html | 1.5 | Live dashboard KPIs (1.2) + Map (1.3) + Territory (1.4) + Staff nav link & card (1.5) |
| Territory | src/admin/territory.html | 1.0 | New — assign manufacturer lines by state (drives map filters, opportunity flags, targets). Function: territory-api.js. SQL: territory.sql |
| Staff | src/admin/staff.html | 1.0 | New — team logins & roles (President/Sales Rep/Customer Relations), travel/route access, instant revoke. First sign-in on an empty table becomes President; teammates set their own password on first login. Function: staff-auth.js. SQL: staff.sql. NOTE: role-based data scoping across the other tools is the NEXT phase — this phase adds login + management only, alongside the existing passcode. |
| Territory Map | src/admin/map.html | 1.2 | OSM pins + filters + geocoding (1.0); route planner (1.1); home base — routes start & end at a saved address, round-trip toggle, nearest-neighbor from home (1.2). Function: geocode-api.js. SQL: geocode.sql |
| Analytics | src/admin/analytics.html | 1.3 | Remembered passcode (1.2) + Map nav link (1.3) |
| Dealer Manager | src/admin/dealers.html | 2.0 | Contacts tile (1.2) + PDF export (1.4) + Map link (1.5) + **Phase 2 role scoping (2.0)**: signs in with staff email/password (not the shared passcode); reps see only their own book (scoped server-side in dealers-api, default-deny), and president-only tools (merge/import/logins/dupes) are hidden for reps and blocked in the function. Requires staff-auth.js + staff.sql. |
| Images | src/admin/images.html | 1.3 | Remembered passcode (1.2) + Map nav link (1.3) |
| Featured | src/admin/featured.html | 1.3 | Remembered passcode (1.2) + Map nav link (1.3) |
| Catalog | src/admin/catalog.html | 1.3 | Manufacturer on/off manager (1.1) + remembered passcode (1.2) + Map nav link (1.3) |
| Portal Home | src/admin/home-editor.html | 1.3 | Remembered passcode (1.2) + Map nav link (1.3) |
| Website | src/admin/website.html | 1.2 | Separate GitHub-editor login (own password); Map nav link (1.2) |

## Shared sign-in ("enter your passcode once")

The analytics-token pages (Home, Analytics, Dealer Manager, Map, Images, Featured, Catalog,
Portal Home) remember your admin passcode in the browser session (`sessionStorage`, key
`hcps_admin_token`). Enter it on any one and the rest stay unlocked until you close the
browser or click **Lock** on the dashboard/map. A wrong/expired code clears itself and
re-prompts. The **Website** editor uses its own separate password.

## Territory Map — activation

1. Run **geocode.sql** in Supabase (creates the `geocache` table; `create_tables.sql` must
   already be run so `dealer_addresses` exists).
2. Push the marketing repo (map.html, geocode-api.js, index.html).
3. Admin → Map → **Geocode addresses** once (free US Census geocoder, no key). Coordinates
   are cached by address text, so re-importing contacts never forces a re-geocode.

## Which repo deploys what (so changes land in the right place)

- **Admin portal + marketing website** live in the **`homecareproviderservices`** repo →
  deploys to **homecareproviderservices.netlify.app**. Admin pages are in `src/admin/`,
  admin functions in `netlify/functions/`.
- **Dealer ordering portal** lives in the **`homecareproviderservicesordering`** repo →
  deploys to **hcpsonlineordering.netlify.app** (`public/index.html`).
- Both share **one Supabase project**.

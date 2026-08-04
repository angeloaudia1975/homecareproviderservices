# Admin page versions

Every admin page shows a small **VER x.x** badge in the bottom-right corner. It's the
fast way to confirm a deploy actually went live: push, wait ~1–2 min for Netlify, then
hard-refresh (Ctrl+Shift+R) — if the badge number matches the latest below, you're on
the new version.

**Rule for future updates:** whenever an admin page changes, bump that page's version by
0.1 (e.g. 1.1 → 1.2) in both the page and this table, so the badge always tells the truth.

| Page | File | Version | Notes |
|------|------|---------|-------|
| Home | src/admin/index.html | 1.3 | Live dashboard (1.2) + Map nav link & card (1.3) |
| Territory Map | src/admin/map.html | 1.0 | New — OpenStreetMap pins by dealer location, state/status filters, one-click US Census geocoding. Function: netlify/functions/geocode-api.js. SQL: geocode.sql |
| Analytics | src/admin/analytics.html | 1.2 | Remembered passcode (shared sign-in) |
| Dealer Manager | src/admin/dealers.html | 1.3 | "Contacts on file" tile (1.2) + remembered passcode (1.3) |
| Images | src/admin/images.html | 1.2 | Remembered passcode |
| Featured | src/admin/featured.html | 1.2 | Remembered passcode |
| Catalog | src/admin/catalog.html | 1.2 | Manufacturer on/off manager (1.1) + remembered passcode (1.2) |
| Portal Home | src/admin/home-editor.html | 1.2 | Remembered passcode |
| Website | src/admin/website.html | 1.1 | Separate GitHub-editor login (own password) — unchanged |

## Shared sign-in ("enter your passcode once")

The six analytics-token pages (Home, Analytics, Dealer Manager, Images, Featured, Catalog,
Portal Home) now remember your admin passcode in the browser session (`sessionStorage`,
key `hcps_admin_token`). Enter it on any one of them and the rest stay unlocked until you
close the browser or click **Lock** on the dashboard. A wrong/expired code clears itself
and re-prompts. The **Website** editor uses its own separate password and is unaffected.

## Which repo deploys what (so changes land in the right place)

- **Admin portal + marketing website** live in the **`homecareproviderservices`** repo →
  deploys to **homecareproviderservices.netlify.app**. Admin pages are in `src/admin/`,
  admin functions in `netlify/functions/`.
- **Dealer ordering portal** lives in the **`homecareproviderservicesordering`** repo →
  deploys to **hcpsonlineordering.netlify.app** (`public/index.html`).
- Both share **one Supabase project**, so a manufacturer turned off in Admin → Catalog
  (writes `manufacturer_meta.active`) is instantly hidden on the ordering portal.

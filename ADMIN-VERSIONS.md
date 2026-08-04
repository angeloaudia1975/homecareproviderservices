# Admin page versions

Every admin page shows a small **VER x.x** badge in the bottom-right corner. It's the
fast way to confirm a deploy actually went live: push, wait ~1–2 min for Netlify, then
hard-refresh (Ctrl+Shift+R) — if the badge number matches the latest below, you're on
the new version.

**Rule for future updates:** whenever an admin page changes, bump that page's version by
0.1 (e.g. 1.1 → 1.2) in both the page and this table, so the badge always tells the truth.

| Page | File | Version | Notes |
|------|------|---------|-------|
| Home | src/admin/index.html | 1.1 | Baseline |
| Catalog | src/admin/catalog.html | 1.1 | Adds "Manufacturers on the ordering platform" on/off manager (remove/restore a whole line) |
| Analytics | src/admin/analytics.html | 1.1 | Baseline |
| Dealers | src/admin/dealers.html | 1.1 | Baseline |
| Featured | src/admin/featured.html | 1.1 | Baseline |
| Home editor | src/admin/home-editor.html | 1.1 | Baseline |
| Images | src/admin/images.html | 1.1 | Baseline |
| Website | src/admin/website.html | 1.1 | Baseline |

## Which repo deploys what (so changes land in the right place)

- **Admin portal + marketing website** live in the **`homecareproviderservices`** repo →
  deploys to **homecareproviderservices.netlify.app**. Admin pages are in `src/admin/`,
  admin functions in `netlify/functions/`.
- **Dealer ordering portal** lives in the **`homecareproviderservicesordering`** repo →
  deploys to **hcpsonlineordering.netlify.app** (`public/index.html`).
- Both share **one Supabase project**, so a manufacturer turned off in Admin → Catalog
  (writes `manufacturer_meta.active`) is instantly hidden on the ordering portal.

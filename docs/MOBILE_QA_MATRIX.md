# HCPS Mobile QA Matrix

The reusable device/viewport check that enforces **RULE 10** (CLAUDE.md): every page must work on
desktop, tablet, iPhone, and Android before it's "done." Run it against every build.

## How to run

```bash
npm run build                      # produce _site/
npx playwright install chromium    # first time only
node test/mobile-qa.js             # exit 0 = all green, exit 1 = failures listed
```

The script builds a tiny local server over `_site/`, opens each page at each viewport, and asserts
the pass criteria below. Failures print as `viewport/page: reason`.

## The matrix

| Viewport | Width × Height | Represents |
|---|---|---|
| desktop | 1280 × 900 | Laptop / desktop (nav must stay the classic hover menu) |
| tablet  | 768 × 1024 | iPad portrait |
| iphone  | 390 × 844  | iPhone 14/15 — **Safari** |
| android | 360 × 800  | Common Android — **Chrome** |

Pages checked (edit `PAGES` in `test/mobile-qa.js` to add more): home, manufacturers, a manufacturer
detail, dealer-hub, dealer-services, resources, consulting, contact, become-a-dealer.

## Pass criteria (per page × viewport)

1. **No horizontal overflow** — `document.scrollWidth` must not exceed the viewport. (Catches
   fixed-width blocks, un-collapsed grids, and off-screen scroll-reveal transforms.)
2. **Nav correctness** —
   - Desktop: hamburger **hidden**, classic hover menu present.
   - Mobile/tablet: hamburger **shown**, the panel **opens**, and a dropdown **accordion expands**.

These are automated. The following are the manual spot-checks to run on a real device before a big
release (the automated pass covers the structural side of each):

| Area | What to verify by hand |
|---|---|
| Touch targets | Buttons/links ≥ 44px, easy to tap, no mis-taps |
| Cards | Manufacturer/product cards stack 2-up then 1-up, images not cut off |
| Hero pop-out | Manufacturer hero image expands (lightbox) and closes on tap/Esc |
| Forms | Fields are full-width, 16px (no iOS zoom-on-focus), submit works |
| Tables/reports | Stack (label-per-row) or scroll horizontally — never overflow the page |
| Ordering / checkout | Browse → cart → checkout completes by touch (portal repo) |
| Tools | Calculators / configurators / dashboards operable by touch (Partner/Connect 360) |
| Motion | Smooth; honors reduced-motion; no jank on a mid-range phone |

## Current status

Main site (`homecareproviderservices`): **✅ all green** — 4 viewports × 9 pages, 46 automated
checks. Mobile system lives in `layouts/base.njk` (hamburger panel + accordions + table-wrap) and
`assets/css/site.css` (banners: `Mobile navigation`, `MOBILE HARDENING`, and the mobile reveal
override). Desktop is unchanged (all mobile rules gated to `@media (max-width:980px)`).

## Extending to the other properties

The same criteria apply to the ordering portal (`homecareproviderservicesordering` — catalog,
product detail, cart, checkout, Connect 360 admin, Partner 360 tools) and the Golden dealer portal.
Point a copy of this matrix at each property's built output (adjust `ROOT` and `PAGES`) and drive the
count to green there too. Those waves are tracked separately.

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

## Ordering portal (`homecareproviderservicesordering`) — Wave 2

Status: **hardened; login + shell verified green on mobile.** The portal already had a strong
responsive base (cart grid stacks at 900px, dealer nav scrolls, catalog uses `auto-fill minmax`,
grids collapse at their breakpoints). Wave 2 added a `MOBILE HARDENING` block to
`public/index.html`:

- **16px inputs on mobile** (`!important`) — the portal's fields were 13–14px, which made iOS zoom
  on focus across every form (login, checkout, quote, account). Fixed.
- **Overflow safety net** + `img{max-width:100%}`.
- **Dynamic table wrapper** — a `MutationObserver` wraps every `<table>` (including
  orders/reports/tools rendered after login) in a `.table-scroll` container so wide tables scroll
  instead of breaking the page.
- **Touch heights** on primary actions (`.btn`, `.subbtn`, cart submit, login).

Verified at iPhone (390) and Android (360): no horizontal overflow, all 36 inputs ≥16px, no console
errors, login/shell render cleanly. **Not yet visually verified:** the authenticated shop, cart,
checkout, Partner 360 dashboard, and reports require a dealer login — run the manual spot-checks
(above) from a logged-in session, or point `test/mobile-qa.js` at an authenticated URL, to close
those out.

## Golden dealer portal — Wave 3

Status: **hardened; shells verified.** Canonical tree is `repo/portals/` (the per-dealer files in a
stray `src/repo/` copy are not deployed). The same `MOBILE HARDENING` block + dynamic table wrapper
were added to the interactive pages: `dealer/index.html` (the 2 MB dealer ordering portal),
`admin/index.html`, `admin/crm.html`, `admin/dealer-360.html`, `admin/campaign-studio.html`.

- All inputs now ≥16px on mobile (they were 11–15px → iOS zoom); verified across all five.
- Overflow guard + dynamic table wrapper in place; no JS errors.
- **Caught & fixed:** these files embed HTML inside JS template strings, so a naive "insert before
  last `</style>`" lands inside a script. Insertion is done before the *real* standalone `</body>`
  only. (Rule for future edits to these files.)

**Open items (need a Golden dealer login to finish):** `dealer/index.html` has one ~43px-wide
category-header element the overflow guard currently clips rather than reflows; the authenticated
shop/cart/checkout, admin dashboards, and CRM tables need the manual device spot-checks from a
logged-in session. Not visually QA'd authenticated.

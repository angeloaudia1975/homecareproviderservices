# HCPS Website — Phase 1

Static site built with Eleventy. Content lives in data files; templates generate pages.

## Deploy to Netlify

Connect this repo to Netlify. `netlify.toml` already has the settings:
- Build command: `npm run build`
- Publish directory: `_site`

Every push to `main` rebuilds and deploys automatically.

## Local commands (optional — Netlify does this for you)

```
npm install
npm run build     # builds to _site/
npm start         # dev server with live reload
```

## Where content lives

```
src/_data/
  site.json           Contact info, stats, territory, regional reps
  manufacturers.json  The 12 partners
  documents.json      PDF library + access levels
  team.json           Team members
  testimonials.json   Dealer quotes
```

Edit a data file, push, and every page that uses it updates.

## Adding a document

1. Put the PDF in `src/assets/docs/`
2. Add a record to the `items` array in `src/_data/documents.json`:

```json
{
  "id": "golden-cloud-brochure",
  "title": "Golden Cloud Series Brochure",
  "type": "brochure",
  "manufacturer": "golden-technologies",
  "file": "/assets/docs/golden-cloud-brochure.pdf",
  "description": "Cloud and Cloud Plus power recliners.",
  "access": "public",
  "dealers": [],
  "featured": false
}
```

It appears on the Golden Technologies page AND in the Resources library, filterable by
manufacturer and type. No template edits.

## Access levels

| Level | Who sees it | Use for |
|---|---|---|
| `public` | Anyone | Brochures, credit applications, spec sheets |
| `dealer` | Logged-in dealers | Standard price lists |
| `dealer-specific` | Only accounts listed in `dealers` | Custom negotiated price lists |

Public documents download directly today. `dealer` and `dealer-specific` render a locked
state — the gate itself gets wired up when dealer login is added (Phase 2, alongside the
dealer master record).

**Never set a custom price list to `public`.** The `dealers` array holds HCPS dealer IDs,
not manufacturer account numbers, so one custom price list can be scoped to a dealer
regardless of which manufacturer's account number they use.

## Adding a manufacturer

Add one record to `manufacturers.json`, drop the logo in `src/assets/logos/`. That produces
the homepage card, the logo strip tile, the nav dropdown entry, the manufacturers index card,
and a full manufacturer page with its own document library.

## Structure

```
src/
  _data/                 Content (edit these)
  _includes/layouts/     base.njk — header, nav, footer
  assets/
    css/site.css         Design system + page styles
    logos/               Manufacturer logos
    docs/                PDFs go here
  index.njk              Homepage
  resources.njk          Document library (filter + search)
  manufacturers/
    index.njk            Manufacturer index
    manufacturer.njk     Generates all 12 manufacturer pages
```

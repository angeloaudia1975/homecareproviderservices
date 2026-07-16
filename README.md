# HomeCare Provider Services — Website

Live marketing/landing page for HomeCare Provider Services (HCPS), a Golden Technologies-and-more distributor serving 300+ dealers across Southern Ohio, Southern Indiana, Kentucky, Tennessee, and Georgia.

## What's in this repo

- `index.html` — the entire site (single self-contained file: HTML, CSS, and JS all in one place, including 12 manufacturer logos embedded directly in the page).

## Editing content in the browser (no code needed)

The live page has a built-in **✎ Edit This Page** button (bottom-right corner):

1. Click it to turn on edit mode.
2. Click any text on the page to edit it directly.
3. Add/remove manufacturer cards, team members, and testimonials with the `+` / `×` controls.
4. Upload logos/photos directly onto any card.
5. Click **Export HTML** to download your changes as a file — send that file back to Claude (or open a PR) to make the changes permanent on the live site.

⚠️ **Save** only stores edits in that one browser (not shared across devices, not permanent). **Export HTML** is the reliable way to keep changes.

## Deployment

This repo is connected to Netlify. Every push to `main` deploys automatically — no build step required (it's a static file).

## Making bigger changes

For structural changes (new sections, layout, adding fields to the manufacturer template, etc.), ask Claude to edit this repo directly rather than using the in-browser edit mode — that keeps future regenerations from overwriting one-off browser edits.

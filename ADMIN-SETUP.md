# HCPS Site Editor (`/admin`) — setup

The editor lets you change page content, upload images and PDFs, add/reorder page
sections, and manage the document library — no JSON editing, no file renaming. Every
"Publish" writes a real commit to GitHub, which Netlify rebuilds into the live site in
about 1–2 minutes.

Once the four environment variables below are set, the editor lives at:

```
https://<your-site>.netlify.app/admin/
```

---

## 1. Create a GitHub access token

The editor commits on your behalf using a token you store in Netlify (never in the
browser).

1. Go to GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access:** *Only select repositories* → choose your HCPS site repo.
3. **Permissions → Repository permissions → Contents: Read and write.** (That is the only permission needed.)
4. Set an expiration you're comfortable with (you'll rotate it when it lapses).
5. Generate and copy the token (starts with `github_pat_…`). You won't see it again.

## 2. Set the environment variables in Netlify

Netlify → your site → **Site configuration → Environment variables → Add a variable**.
Add these four:

| Key | Value | Notes |
|---|---|---|
| `ADMIN_PASSWORD` | a strong password | This is what you type to sign in to `/admin`. Share it only with editors. |
| `GITHUB_TOKEN` | the `github_pat_…` token from step 1 | |
| `GITHUB_REPO` | `owner/repo` | e.g. `angeloaudia/hcps-site` — the exact owner and repository name. |
| `GITHUB_BRANCH` | `main` | Optional. Only set if your deploy branch isn't `main`. |

After saving, trigger a redeploy (Netlify → Deploys → **Trigger deploy → Deploy site**)
so the function picks up the new variables.

## 3. Use it

1. Open `https://<your-site>.netlify.app/admin/` and sign in with `ADMIN_PASSWORD`.
2. **Manufacturers tab** — pick a manufacturer, edit its details and page sections. Use
   **+ Add section** to build out the eight stub pages, and the ↑ ↓ / Remove controls to
   arrange them. Click **Publish changes** when done.
3. **Documents tab** — add or edit brochures, price lists, forms, and videos; set the
   access level; upload the PDF with the **Upload file** button.
4. Uploads land automatically in the repo: product/section images in
   `src/assets/products/<manufacturer-id>/`, logos in `src/assets/logos/`, and documents
   in `src/assets/docs/`. You never touch file paths by hand.

The top-right indicator reads **"Publishing live"** when GitHub is configured correctly,
or **"GitHub not configured"** if a variable is missing.

---

## How it works (for reference)

- The app shell is static files under `src/admin/`, copied verbatim to `/admin/` at build
  time (Eleventy is told to ignore them as templates).
- All reads and writes go through one serverless function,
  `netlify/functions/admin-api.js`, which checks your password, issues a short-lived
  signed session token, and talks to the GitHub Contents API.
- Because the editor commits to your deploy branch, **the change history is your GitHub
  history** — every edit is a commit you can review or revert.

## Security notes

- The `/admin` page is `noindex` and its API rejects every request without a valid
  session. The password is checked server-side with a constant-time comparison; it is
  never stored in the browser (only a short-lived signed token is).
- To rotate access, change `ADMIN_PASSWORD` in Netlify and redeploy — existing sessions
  stop working.
- Keep the custom/dealer-specific price-list rule from the main README in mind: never set
  those documents to `public`.

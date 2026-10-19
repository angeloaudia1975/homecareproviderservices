# A2B activation gate — Netlify client-IP verification

Purpose: prove on Netlify's real edge (not mocked events) that `x-nf-client-connection-ip`, the only header the
Academy's rate limits read (`_academy_learner.js clientIp`), is set by Netlify and cannot be set by a visitor.
Required before `academy_learner` is switched on (ChatGPT re-review of PR #20, gate 1).

Procedure (no production data, no secrets, nothing merged):
1. Create a throwaway branch from main, e.g. `academy/ip-verify-diag`, and copy `academy-ip-echo.js` to
   `netlify/functions/academy-ip-echo.js`. Open it as a DRAFT PR so Netlify builds a deploy preview.
2. Open the deploy preview in Chrome and paste `probe_browser.js` into the console (same origin). Also repeat once
   with a different network (e.g. a phone hotspot) to see the real address change.
3. PASS = the same real address in every row and never the forged value. Record the table in the activation report.
4. Close the PR WITHOUT merging and delete the branch. The diagnostic must never reach main or production.

If it FAILS: keep learner sign-in off; the fix is to key the network limit on a value a visitor cannot influence
(e.g. drop the network bucket and rely on the per-address and per-code limits), then re-run.

## Result — PASS (18 Oct 2026 ~18:30 CT, deploy preview of throwaway PR #24, closed unmerged)

`x-nf-client-connection-ip` was the same real address in all 5 requests, including when the visitor forged it; it never
showed the forged `203.0.113.66`. `x-forwarded-for` WAS visitor-influenced (`203.0.113.66, <real>`), which confirms the
rule: the Academy rate limits read only `x-nf-client-connection-ip`. Full table: PR #22 comment 6257614309. The
diagnostic function never reached main.

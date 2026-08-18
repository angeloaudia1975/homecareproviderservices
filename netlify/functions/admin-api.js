// Admin API — GitHub-backed content editor for the HCPS site.
//
// A single shared password (ADMIN_PASSWORD) gates every write. On login the
// function returns a short-lived HMAC-signed session token; the browser sends it
// back as a Bearer token on every subsequent request. Nothing sensitive is ever
// stored in the browser.
//
// All content is read from and written to GitHub via the Contents API, so the
// admin always edits the true source of truth and every save is a real commit to
// the branch Netlify deploys (a push triggers a rebuild ~1-2 min later).
//
// Required Netlify environment variables:
//   ADMIN_PASSWORD   The shared editor password.
//   GITHUB_TOKEN     Fine-grained PAT with "Contents: Read and write" on the repo.
//   GITHUB_REPO      "owner/repo" (e.g. "angeloaudia/hcps-site").
// Optional:
//   GITHUB_BRANCH    Branch to commit to. Defaults to "main".
//   ADMIN_SECRET     Token-signing secret. Defaults to a value derived from ADMIN_PASSWORD.

const crypto = require("crypto");

const GITHUB_API = "https://api.github.com";
const TOKEN_TTL_SECONDS = 60 * 60 * 8; // 8-hour editing session

// ---------- helpers ----------

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signingSecret() {
  return process.env.ADMIN_SECRET || `hcps:${process.env.ADMIN_PASSWORD || ""}`;
}

function makeToken(ttl = TOKEN_TTL_SECONDS) {
  const payload = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttl }));
  const sig = b64url(crypto.createHmac("sha256", signingSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = b64url(crypto.createHmac("sha256", signingSecret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function passwordMatches(supplied) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bearer(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || "";
  return raw.startsWith("Bearer ") ? raw.slice(7) : "";
}

// Single sign-on from the admin portal: a staff member already signed into the HCPS admin portal
// (staff-auth session) can open the Website Editor without a second password. We validate their
// Supabase session token and confirm they're an active admin-level staff user; if so they get the
// same short-lived editor token the password login issues. Website publishing is management-level,
// so reps are excluded here (widen STAFF_EDIT_ROLES to grant more roles).
const STAFF_EDIT_ROLES = new Set(["president", "management"]);
async function staffWhoami(token) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;
  if (!token || !url || !key) return null;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    const email = u && u.email && String(u.email).toLowerCase();
    if (!email) return null;
    const svc = process.env.SUPABASE_SERVICE_ROLE || key;
    const sr = await fetch(`${url}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=role,active`, { headers: { apikey: svc, Authorization: `Bearer ${svc}` } });
    if (!sr.ok) return null;
    const s = await sr.json();
    const su = s && s[0];
    if (su && su.active !== false) return { email, role: su.role || "rep" };
  } catch (e) {}
  return null;
}

function githubConfig() {
  const repo = process.env.GITHUB_REPO || "";
  const token = process.env.GITHUB_TOKEN || "";
  const branch = process.env.GITHUB_BRANCH || "main";
  return { repo, token, branch, ok: Boolean(repo && token && repo.includes("/")) };
}

async function gh(path, opts = {}) {
  const { token } = githubConfig();
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hcps-admin",
      ...(opts.headers || {}),
    },
  });
  return res;
}

// Read a file's current sha (null if it does not exist yet).
async function getSha(repo, path, branch) {
  const res = await gh(`/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
  const data = await res.json();
  return data.sha || null;
}

// ---------- actions ----------

async function handleGet(body) {
  const { repo, branch, ok } = githubConfig();
  if (!ok) return json(500, { error: "GitHub is not configured (set GITHUB_REPO and GITHUB_TOKEN)." });
  const path = body.path;
  if (!path) return json(400, { error: "Missing path." });
  const res = await gh(`/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return json(200, { content: null, sha: null });
  if (!res.ok) return json(502, { error: `GitHub read failed (${res.status}).` });
  const data = await res.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf8");
  return json(200, { content, sha: data.sha });
}

// List a directory's files (for the media library). Returns [] if the folder doesn't exist.
async function handleList(body) {
  const { repo, branch, ok } = githubConfig();
  if (!ok) return json(500, { error: "GitHub is not configured (set GITHUB_REPO and GITHUB_TOKEN)." });
  const path = body.path;
  if (!path) return json(400, { error: "Missing path." });
  const res = await gh(`/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return json(200, { files: [] });
  if (!res.ok) return json(502, { error: `GitHub list failed (${res.status}).` });
  const data = await res.json();
  const arr = Array.isArray(data) ? data : [];
  const files = arr.filter(x => x.type === "file").map(x => ({ name: x.name, path: x.path, size: x.size }));
  return json(200, { files });
}

async function handlePut(body, isBinary) {
  const { repo, branch, ok } = githubConfig();
  if (!ok) return json(500, { error: "GitHub is not configured (set GITHUB_REPO and GITHUB_TOKEN)." });
  const path = body.path;
  if (!path) return json(400, { error: "Missing path." });

  let contentB64;
  if (isBinary) {
    if (typeof body.contentBase64 !== "string") return json(400, { error: "Missing file data." });
    contentB64 = body.contentBase64;
  } else {
    if (typeof body.content !== "string") return json(400, { error: "Missing content." });
    contentB64 = Buffer.from(body.content, "utf8").toString("base64");
  }

  // Resolve the sha so we can update an existing file without a 409 conflict.
  let sha = body.sha;
  if (sha === undefined) {
    try {
      sha = await getSha(repo, path, branch);
    } catch (e) {
      return json(502, { error: e.message });
    }
  }

  const message = body.message || `Update ${path} via admin`;
  const payload = { message, content: contentB64, branch };
  if (sha) payload.sha = sha;

  const res = await gh(`/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  if (res.status === 409) return json(409, { error: "This file changed since you loaded it. Reload and try again." });
  if (!res.ok) {
    const detail = await res.text();
    console.error("GitHub write failed:", res.status, detail);
    return json(502, { error: `GitHub write failed (${res.status}).` });
  }
  const data = await res.json();
  return json(200, {
    ok: true,
    path,
    sha: data.content && data.content.sha,
    commit: data.commit && data.commit.html_url,
  });
}

// Delete a file (used by the media library to remove an unused image).
async function handleDelete(body) {
  const { repo, branch, ok } = githubConfig();
  if (!ok) return json(500, { error: "GitHub is not configured (set GITHUB_REPO and GITHUB_TOKEN)." });
  const path = body.path;
  if (!path) return json(400, { error: "Missing path." });
  let sha = body.sha;
  if (!sha) {
    try { sha = await getSha(repo, path, branch); } catch (e) { return json(502, { error: e.message }); }
  }
  if (!sha) return json(404, { error: "File not found." });
  const message = body.message || `Delete ${path} via admin`;
  const res = await gh(`/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha, branch }),
  });
  if (res.status === 409) return json(409, { error: "This file changed since you loaded it. Reload and try again." });
  if (!res.ok) { const detail = await res.text(); console.error("GitHub delete failed:", res.status, detail); return json(502, { error: `GitHub delete failed (${res.status}).` }); }
  return json(200, { ok: true, path });
}

// ---------- entry ----------

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request." });
  }

  const action = body.action;

  // Login is the only unauthenticated action.
  if (action === "login") {
    if (!process.env.ADMIN_PASSWORD) return json(500, { error: "Admin password is not configured." });
    if (!passwordMatches(body.password)) return json(401, { error: "Incorrect password." });
    return json(200, { token: makeToken(), expiresIn: TOKEN_TTL_SECONDS, github: githubConfig().ok });
  }

  // Single sign-on from the admin portal — exchange a valid staff session for an editor token (no
  // second password). Authenticated by the staff Bearer token, not the editor token, so it sits
  // alongside "login" as a bootstrap action.
  if (action === "login_staff") {
    const me = await staffWhoami(bearer(event) || body.staff_token || "");
    if (!me) return json(401, { error: "Not signed in to the admin portal." });
    if (!STAFF_EDIT_ROLES.has(me.role)) return json(403, { error: "Your admin role doesn't have website-editing access." });
    return json(200, { token: makeToken(), expiresIn: TOKEN_TTL_SECONDS, github: githubConfig().ok });
  }

  // Everything else requires a valid session token.
  if (!verifyToken(bearer(event))) return json(401, { error: "Session expired. Please sign in again." });

  try {
    switch (action) {
      case "ping":
        return json(200, { ok: true, github: githubConfig().ok });
      case "get":
        return await handleGet(body);
      case "list":
        return await handleList(body);
      case "put":
        return await handlePut(body, false);
      case "upload":
        return await handlePut(body, true);
      case "delete":
        return await handleDelete(body);
      default:
        return json(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("admin-api error:", err);
    return json(500, { error: "Unexpected server error." });
  }
};

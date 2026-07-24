// Local mock of Netlify static hosting + admin-api function, backed by real files
// in a scratch copy so we can exercise the admin UI end-to-end without GitHub.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "_site");
const SCRATCH = path.join(__dirname, "scratch"); // holds mutable copies of data files
const PASSWORD = "testpass";

const files = {
  "src/_data/manufacturers.json": path.join(SCRATCH, "manufacturers.json"),
  "src/_data/documents.json": path.join(SCRATCH, "documents.json"),
};

function sha() { return "sha-" + Math.random().toString(36).slice(2); }

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const full = path.join(SITE, p);
  if (!full.startsWith(SITE) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/.netlify/functions/admin-api")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let d = {}; try { d = JSON.parse(body || "{}"); } catch {}
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const auth = (req.headers.authorization || "").startsWith("Bearer ");
      if (d.action === "login") { return d.password === PASSWORD ? send(200, { token: "mock.token", github: true }) : send(401, { error: "Incorrect password." }); }
      if (!auth) return send(401, { error: "Session expired." });
      if (d.action === "ping") return send(200, { ok: true, github: true });
      if (d.action === "get") { const f = files[d.path]; return send(200, f && fs.existsSync(f) ? { content: fs.readFileSync(f, "utf8"), sha: sha() } : { content: null, sha: null }); }
      if (d.action === "put") { const f = files[d.path]; if (f) fs.writeFileSync(f, d.content); return send(200, { ok: true, sha: sha() }); }
      if (d.action === "upload") { fs.mkdirSync(path.join(SCRATCH, "uploads"), { recursive: true }); fs.writeFileSync(path.join(SCRATCH, "uploads", path.basename(d.path)), Buffer.from(d.contentBase64, "base64")); return send(200, { ok: true, sha: sha() }); }
      return send(400, { error: "unknown action " + d.action });
    });
    return;
  }
  serveStatic(req, res);
});

// seed scratch copies
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(ROOT, "src/_data/manufacturers.json"), files["src/_data/manufacturers.json"]);
fs.copyFileSync(path.join(ROOT, "src/_data/documents.json"), files["src/_data/documents.json"]);

server.listen(8899, () => console.log("mock server on http://localhost:8899  (password: " + PASSWORD + ")"));

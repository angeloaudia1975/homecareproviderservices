// Single foreground process: start mock server as a child, run the drive, kill it.
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const dir = __dirname;

const server = spawn("node", [path.join(dir, "mock-server.js")], { stdio: "inherit" });

setTimeout(() => {
  const r = spawnSync("node", [path.join(dir, "drive.js")], { stdio: "inherit" });
  server.kill("SIGTERM");
  process.exit(r.status || 0);
}, 1800);

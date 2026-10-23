import http from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fixed document root; never accept a caller-provided directory or bind address.
const root = await realpath(fileURLToPath(new URL("../docs/architecture/", import.meta.url)));
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8", ".png": "image/png" };
const port = Number(process.env.ARCHITECTURE_PREVIEW_PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port");
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const name = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname).replace(/^\//, "") || "ai-agent-router.html";
    // Only flat public artifacts; no directory listing, hidden files or traversal.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || !types[path.extname(name)]) { res.writeHead(404).end(); return; }
    const file = await realpath(path.join(root, name));
    if (path.dirname(file) !== root || !(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(name)], "Content-Length": content.length });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`Architecture preview: http://127.0.0.1:${port}/`));
server.on("error", (error) => { console.error(`Preview failed: ${error.code || "unknown error"}`); process.exitCode = 1; });

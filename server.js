// Zero-dependency static server. Serves the app on http://localhost (a secure
// context, so the browser allows camera access) and exposes the MediaPipe
// runtime from node_modules so nothing has to come from a CDN.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || "127.0.0.1";
const MOUNTS = [
  ["/vendor/tasks-vision/", resolve(root, "node_modules/@mediapipe/tasks-vision")],
  ["/", resolve(root, "public")],
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
};

async function resolveFile(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = normalize(decodeURIComponent(urlPath.slice(prefix.length))).replace(/^([/\\]|\.\.[/\\])+/, "");
    let file = join(dir, rel);
    if (!file.startsWith(dir)) return null;
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, "index.html");
      await stat(file);
      return file;
    } catch {
      return null;
    }
  }
  return null;
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const file = await resolveFile(pathname);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] || "application/octet-stream",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  res.end(await readFile(file));
}).listen(PORT, HOST, () => {
  console.log(`SkinShield running at http://localhost:${PORT}`);
});

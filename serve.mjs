#!/usr/bin/env node
/**
 * Local preview server.
 *
 *   node serve.mjs                 -> serve ./dist   (the built output)
 *   node serve.mjs 4173 --source   -> serve the project root (raw source files)
 *   node serve.mjs 4173 --dist     -> serve ./dist
 *
 * "source" mode lets you check edits in the .html files directly, with no
 * build step. The homepage lives in `home-2.html` there, so "/" is mapped
 * to it automatically.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const portArg = args.find((a) => /^\d+$/.test(a));
const PORT = Number(portArg || 4173);
const SOURCE = args.includes("--source");

const ROOT = SOURCE ? HERE : path.join(HERE, "dist");
const MODE = SOURCE ? "source" : "dist";
// In source mode the homepage file is named home-2.html
const INDEX_ALIASES = SOURCE ? ["home-2.html", "index.html"] : ["index.html", "index.htm"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
};

if (!fs.existsSync(ROOT)) {
  console.error(`  ${ROOT} not found.`);
  if (!SOURCE) console.error("  Run `npm run build` first.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    // A bad request must never take the preview server down.
    console.error("  request error:", err.message);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("500 Internal Server Error");
  }
});

function handle(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  // --- Clean URLs (mirrors the .htaccess rules that build.mjs writes) ---
  //   /about.html -> 301 /about ; /about/ -> 301 /about ; /about -> about.html
  const CLEAN_PAGES = ["/about", "/gallery", "/contact", "/book"];
  const cleanBase = urlPath.replace(/\.html$/, "").replace(/\/$/, "");
  if (CLEAN_PAGES.includes(cleanBase)) {
    if (urlPath !== cleanBase) {
      res.writeHead(301, { Location: cleanBase }).end();
      return;
    }
    urlPath = cleanBase + ".html";
  }
  // Production also redirects these to the root.
  if (!SOURCE && (urlPath === "/index.html" || urlPath === "/home-2.html")) {
    res.writeHead(301, { Location: "/" }).end();
    return;
  }

  if (urlPath === "/" || urlPath.endsWith("/")) {
    urlPath = "/" + INDEX_ALIASES.find((f) => fs.existsSync(path.join(ROOT, f))) || "index.html";
  }
  // In source mode "/index.html" should also reach the homepage.
  if (SOURCE && urlPath === "/index.html" && !fs.existsSync(path.join(ROOT, "index.html"))) {
    urlPath = "/home-2.html";
  }

  const filePath = path.join(ROOT, urlPath);

  // Keep the preview inside the project and away from dev folders.
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith("..") || rel.split(path.sep).some((p) => p === "node_modules" || p === ".git")) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const notFound = path.join(ROOT, "404.html");
    if (fs.existsSync(notFound)) {
      res.writeHead(404, { "Content-Type": MIME[".html"] });
      fs.createReadStream(notFound).pipe(res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("404 Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": fs.statSync(filePath).size,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Stop the other process, or start this one on a different port:\n`);
    console.error(`    node serve.mjs ${PORT + 1} ${SOURCE ? "--source" : "--dist"}\n`);
  } else {
    console.error("\n  Server error:", err.message, "\n");
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n  Serving ${MODE === "source" ? "SOURCE files" : "dist/"} at ${base}\n`);
  console.log(`    ${base}/                 -> homepage`);
  for (const p of ["about", "gallery", "contact", "book"]) {
    console.log(`    ${base}/${p}`);
  }
  console.log(`\n  (Ctrl+C to stop)\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\n  Preview server stopped.\n");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

// A preview server should stay up even if something unexpected happens.
process.on("uncaughtException", (err) => {
  console.error("  uncaught exception (server still running):", err && err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("  unhandled rejection (server still running):", reason);
});


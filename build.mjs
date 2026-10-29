#!/usr/bin/env node
/**
 * Teonox Studio — static production build.
 *
 * The project is a hand-written static HTML site (no framework, no bundler):
 *   - CSS lives inline in <style> blocks
 *   - JS lives inline in <script> blocks
 *   - fonts come from the Google Fonts CDN
 *
 * This script turns the source folder into a clean, deploy-ready `dist/`
 * folder that can be uploaded as-is to any static host (Hostinger, Netlify,
 * Cloudflare Pages, GitHub Pages, ...). No Node.js runtime is required on
 * the server.
 *
 * Steps
 *   1. wipe + recreate dist/
 *   2. copy / optimise images (PNG -> WebP, JPEG re-encode)
 *   3. re-encode the hero video (H.264, web-optimised)
 *   4. minify every page, rewrite links, emit index.html at the root
 *   5. emit static-hosting extras (404.html, robots.txt, sitemap.xml, .htaccess)
 *   6. verify the output (every local reference must resolve on disk)
 *
 * Usage:  node build.mjs [--clean-only] [--no-optimise-media]
 *
 * Preview the result with:  npm run preview   (serves ./dist on :4173)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minify } from "html-minifier-terser";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = HERE;
const DIST = path.join(HERE, "dist");

const argv = process.argv.slice(2);
const CLEAN_ONLY = argv.includes("--clean-only");
const OPTIMISE_MEDIA = !argv.includes("--no-optimise-media");

/* ------------------------------------------------------------------ *
 * 1. Manifest
 * ------------------------------------------------------------------ */

/** Pages that ship to the server. `home-2.html` becomes `index.html`. */
const PAGES = [
  { src: "home-2.html", out: "index.html" },
  { src: "about.html", out: "about.html" },
  { src: "gallery.html", out: "gallery.html" },
  { src: "contact.html", out: "contact.html" },
  { src: "book.html", out: "book.html" },
];

/** PNG -> WebP. Every one of these changes a reference in the HTML. */
const PNG_TO_WEBP = [
  // Logos are flat vector-ish art: lossless WebP is pixel-perfect AND smaller
  // than the source PNG (20.9K / 21.6K vs 58.8K / 64.2K).
  { rel: "logo-black.png", lossless: true },
  { rel: "logo-white.png", lossless: true },
  // The decorative camera is always displayed at ~20% of its 1015px source
  // width, so lossy WebP is imperceptible and 75% smaller.
  { rel: "section image/camera.png", lossless: false },
  ...fs
    .readdirSync(path.join(SRC, "images/gallery"))
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .map((f) => ({ rel: path.posix.join("images/gallery", f), lossless: false })),
];

/** JPEG re-encode, same file name => no reference changes needed. */
const RECOMPRESS_JPEG = [
  "images/setup/creator-setup.jpg",
  "images/setup/curtain-setup.jpg",
  "images/setup/premium-setup.jpg",
  "images/avatars/harsh-pawale.jpg",
  "images/avatars/prajakta-badhe.jpg",
  "images/avatars/sowmitra-desai.jpg",
  "images/avatars/vishal-bhedurkar.jpg",
];

/**
 * Large JPEG -> WebP. These ship as .webp instead of .jpg, so every
 * reference (preload, poster, <img>, CSS url()) is rewritten in
 * buildRewrites(). All of them are >150 KB as JPEG; WebP q80 renders
 * identically at a fraction of the bytes (hero-bg is the LCP image).
 */
const JPG_TO_WEBP = [
  "images/hero/hero-bg.jpg",
  "images/hero/hero-bg-mobile.jpg",
  "images/studio/classroom-bg.jpg",
  "images/studio/creator-classroom.jpg",
  "images/studio/studio-experience.jpg",
];

/** Already small / already optimised — copied byte-for-byte. */
const COPY_VERBATIM = [
  "favicon_teonox.png",
  "line-shape.png",
  "a2-camera.webp",
  "p2-img-shape-1-1.webp",
  "section image/c1-shape-1.webp",
  ...fs
    .readdirSync(path.join(SRC, "images/gear"))
    .filter((f) => f.toLowerCase().endsWith(".webp"))
    .map((f) => path.posix.join("images/gear", f)),
];

/** Hero background video — re-encoded to a web-friendly H.264 MP4. */
const VIDEO = {
  src: path.join(SRC, "Hero Video", "Teonox-Studio.mp4"),
  out: "Hero Video/Teonox-Studio.mp4",
  width: 1600,
  height: 900,
  fps: 30,
  crf: 30,
};

/** Quality settings for lossy re-encodes. */
const WEBP_QUALITY = 80;
const JPEG_QUALITY = 82;

/* ------------------------------------------------------------------ *
 * 2. Small helpers
 * ------------------------------------------------------------------ */

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const human = (n) => (n > 1024 * 1024 ? mb(n) : kb(n));

let savedBytes = 0;

function ensureDir(rel) {
  const abs = path.join(DIST, rel);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

function writeFile(rel, data) {
  const abs = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

function sourceSize(rel) {
  const abs = path.join(SRC, rel);
  return fs.existsSync(abs) ? fs.statSync(abs).size : 0;
}

function copyVerbatim(rel) {
  const src = path.join(SRC, rel);
  if (!fs.existsSync(src)) throw new Error(`missing source asset: ${rel}`);
  const data = fs.readFileSync(src);
  writeFile(rel, data);
  savedBytes += sourceSize(rel) - data.length;
  return data.length;
}

function dirSize(dir, skip = new Set()) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p, skip) : fs.statSync(p).size;
  }
  return total;
}

/** Size of the authoring tree, ignoring build output and dependencies. */
function sourceTreeSize() {
  return dirSize(SRC, new Set(["node_modules", "dist", ".git"]));
}

/* ------------------------------------------------------------------ *
 * 3. Reference rewriting
 * ------------------------------------------------------------------ */

/**
 * Builds the list of literal string replacements applied to every page.
 * Everything is an exact-string swap so nothing can be matched by accident.
 */
function buildRewrites() {
  const rules = [];

  // Clean (extensionless) URLs. Physical files stay `.html` on disk and
  // .htaccess maps /about -> about.html (plus 301s old .html URLs). In the
  // markup, links, canonical tags and og:url all use the clean form.
  rules.push(["home-2.html", "/"]);
  rules.push(["index.html", "/"]);
  for (const { out } of PAGES) {
    if (out !== "index.html") rules.push([out, out.replace(/\.html$/, "")]);
  }

  // Gallery photos: PNG -> WebP.
  //  a) plain <img src="images/gallery/X.png">  (gallery.html)
  //  b) JS template  'images/gallery/'+p+'.png'   (home page marquee)
  rules.push(["images/gallery/'+p+'.png", "images/gallery/'+p+'.webp"]);
  for (const { rel } of PNG_TO_WEBP) {
    if (rel.startsWith("images/gallery/")) {
      rules.push([`images/gallery/${path.basename(rel)}`, `images/gallery/${path.basename(rel, ".png")}.webp`]);
    }
  }

  // The decorative camera PNG is referenced URL-encoded in the markup.
  rules.push(["section%20image/camera.png", "section%20image/camera.webp"]);
  rules.push(["section image/camera.png", "section image/camera.webp"]);

  // Logos.
  rules.push(["logo-black.png", "logo-black.webp"]);
  rules.push(["logo-white.png", "logo-white.webp"]);

  // Large JPEGs -> WebP: covers <link rel=preload>, poster=, <img src>
  // and CSS url() in one pass (every reference uses the plain source path).
  for (const rel of JPG_TO_WEBP) {
    rules.push([rel, rel.replace(/\.jpe?g$/i, ".webp")]);
  }

  return rules;
}

function applyRewrites(html, rules) {
  let out = html;
  for (const [from, to] of rules) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. Media pipeline
 * ------------------------------------------------------------------ */

async function buildImages() {
  const written = [];

  // PNG -> WebP
  for (const { rel, lossless } of PNG_TO_WEBP) {
    const src = path.join(SRC, rel);
    if (!fs.existsSync(src)) throw new Error(`missing source asset: ${rel}`);
    const outRel = rel.replace(/\.png$/i, ".webp");
    const buf = lossless
      ? await sharp(src, { failOn: "none" }).webp({ lossless: true, effort: 6 }).toBuffer()
      : await sharp(src, { failOn: "none" })
          .webp({ quality: WEBP_QUALITY, effort: 6, alphaQuality: 90 })
          .toBuffer();
    writeFile(outRel, buf);
    savedBytes += sourceSize(rel) - buf.length;
    written.push([rel, outRel, sourceSize(rel), buf.length]);
  }

  // JPEG -> WebP for the big background/hero photos (see JPG_TO_WEBP).
  for (const rel of JPG_TO_WEBP) {
    const src = path.join(SRC, rel);
    if (!fs.existsSync(src)) throw new Error(`missing source asset: ${rel}`);
    const outRel = rel.replace(/\.jpe?g$/i, ".webp");
    const buf = await sharp(src, { failOn: "none" })
      .webp({ quality: WEBP_QUALITY, effort: 6 })
      .toBuffer();
    writeFile(outRel, buf);
    savedBytes += sourceSize(rel) - buf.length;
    written.push([rel, outRel, sourceSize(rel), buf.length]);
  }

  // JPEG re-encode (mozjpeg is high quality + small)
  for (const rel of RECOMPRESS_JPEG) {
    const src = path.join(SRC, rel);
    if (!fs.existsSync(src)) throw new Error(`missing source asset: ${rel}`);
    const buf = await sharp(src)
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true, chromaSubsampling: "4:2:0" })
      .toBuffer();
    writeFile(rel, buf);
    savedBytes += sourceSize(rel) - buf.length;
    written.push([rel, rel, sourceSize(rel), buf.length]);
  }

  for (const rel of COPY_VERBATIM) {
    copyVerbatim(rel);
  }

  return written;
}

async function buildVideo() {
  let ffmpegPath = null;
  try {
    const mod = await import("ffmpeg-static");
    ffmpegPath = mod.default || null;
  } catch {
    /* ffmpeg-static is optional */
  }
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    console.warn("  ! ffmpeg not available - copying the original video unchanged");
    const data = fs.readFileSync(VIDEO.src);
    writeFile(VIDEO.out, data);
    return { out: VIDEO.out, bytes: data.length, encoded: false };
  }

  const outAbs = path.join(DIST, VIDEO.out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", VIDEO.src,
    "-vf", `scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos,fps=${VIDEO.fps}`,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.0",
    "-pix_fmt", "yuv420p",
    "-crf", String(VIDEO.crf),
    "-preset", "slow",
    "-g", String(VIDEO.fps * 2),
    "-movflags", "+faststart",
    "-an",
    outAbs,
  ];

  await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 32 });

  const bytes = fs.statSync(outAbs).size;
  savedBytes += fs.statSync(VIDEO.src).size - bytes;
  return { out: VIDEO.out, bytes, encoded: true };
}

/* ------------------------------------------------------------------ *
 * 5. Pages
 * ------------------------------------------------------------------ */

const MINIFY_OPTIONS = {
  collapseWhitespace: "conservative",
  conservativeCollapse: true,
  removeComments: true,
  removeRedundantAttributes: false, // keep explicit type="" on form inputs
  removeEmptyAttributes: false, // keep alt="" — meaningful for a11y
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  minifyCSS: true,
  minifyJS: true,
  useShortDoctype: true,
  html5: true,
};

async function buildPages(rules) {
  const results = [];

  for (const page of PAGES) {
    const srcFile = path.join(SRC, page.src);
    if (!fs.existsSync(srcFile)) throw new Error(`missing page: ${page.src}`);
    const raw = fs.readFileSync(srcFile, "utf8");
    const rewritten = applyRewrites(raw, rules);

    let html;
    try {
      html = await minify(rewritten, MINIFY_OPTIONS);
    } catch (err) {
      throw new Error(`minification failed for ${page.src}: ${err.message}`);
    }

    // Guard: the rewrite must not have introduced a dangling reference.
    writeFile(page.out, html);
    results.push({ out: page.out, before: Buffer.byteLength(raw), after: Buffer.byteLength(html) });
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * 6. Static-hosting extras
 * ------------------------------------------------------------------ */

const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Page not found - Teonox Studio</title>
<meta name="robots" content="noindex" />
<link rel="icon" type="image/png" href="favicon_teonox.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" />
<style>
  :root{--bg:#0C0805;--bg2:#120C07;--fg:#FDF6EE;--muted:#B9A795;--primary:#FF6A2B;--border:rgba(255,255,255,.10)}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:radial-gradient(120% 80% at 50% 0%,#1A120B 0%,var(--bg) 60%);color:var(--fg);
    font-family:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
  .box{max-width:620px;width:100%;text-align:center;background:linear-gradient(180deg,#1A120B,#140D08);
    border:1px solid var(--border);border-radius:24px;padding:56px 32px;box-shadow:0 30px 80px rgba(0,0,0,.55)}
  img{width:150px;height:auto;margin-bottom:22px}
  h1{margin:0 0 10px;font-family:"Plus Jakarta Sans",Inter,sans-serif;font-size:clamp(30px,6vw,46px);font-weight:800;letter-spacing:-.02em}
  h1 span{background:linear-gradient(90deg,var(--primary),#FFB27A);-webkit-background-clip:text;background-clip:text;color:transparent}
  p{margin:0 0 28px;color:var(--muted);line-height:1.65;font-size:15px}
  .row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
  a.btn{display:inline-block;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;transition:transform .2s,filter .2s}
  a.btn:hover{transform:translateY(-2px)}
  .primary{background:linear-gradient(135deg,var(--primary),#D8481A);color:#fff;box-shadow:0 10px 30px rgba(255,106,43,.32)}
  .ghost{border:1px solid var(--border);color:var(--fg);background:rgba(255,255,255,.03)}
</style>
</head>
<body>
  <main class="box">
    <img src="logo-white.webp" alt="Teonox Studio" />
    <h1>Page <span>not found</span></h1>
    <p>The page you are looking for has moved or never existed. Head back to the studio or explore the gallery.</p>
    <div class="row">
      <a class="btn primary" href="index.html">Back to Home</a>
      <a class="btn ghost" href="gallery.html">View Gallery</a>
      <a class="btn ghost" href="contact.html">Contact Us</a>
    </div>
  </main>
</body>
</html>
`;

const ROBOTS_TXT = `User-agent: *
Allow: /

Sitemap: https://teonoxstudio.com/sitemap.xml
`;

/**
 * sitemap.xml, generated from the PAGES manifest so it can never drift
 * from what actually ships. `index.html` is listed as the site root.
 */
function buildSitemap() {
  const lastmod = new Date().toISOString().slice(0, 10);
  const entries = PAGES.map((p) => {
    // The sitemap must list the clean URLs exactly as links/canonical do.
    const loc =
      p.out === "index.html"
        ? "https://teonoxstudio.com/"
        : `https://teonoxstudio.com/${p.out.replace(/\.html$/, "")}`;
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}

const HTACCESS = `# Teonox Studio — static hosting config (Apache / LiteSpeed).
# Hostinger uses LiteSpeed, which reads this file.

# Serve 404.html for missing pages.
ErrorDocument 404 /404.html

DirectoryIndex index.html index.htm

# Default charset.
AddDefaultCharset UTF-8

# --- Clean URLs (/about -> about.html) -------------------------------------
# 1) Old .html URLs 301-redirect to the clean form so links, canonical tags
#    and the sitemap all agree. The THE_REQUEST check means only real
#    browser requests redirect - the internal rewrite below never loops.
# 2) Extensionless requests are served from the physical <name>.html file.
#    Requests that already carry a file extension (images, video, robots.txt
#    ...) and paths that exist on disk are left untouched; anything missing
#    still falls through to ErrorDocument 404.
# NOTE: use [.] classes and [[:space:]], never \. or \s - backslashes are
# eaten by the JS template literal that generates this file (see the
# dotfiles note below).
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{THE_REQUEST} home-2[.]html([[:space:]]|[?]) [NC]
  RewriteRule ^home-2[.]html$ / [R=301,L]
  RewriteCond %{THE_REQUEST} index[.]html([[:space:]]|[?]) [NC]
  RewriteRule ^index[.]html$ / [R=301,L]
  RewriteCond %{THE_REQUEST} (about|gallery|contact|book)[.]html([[:space:]]|[?]) [NC]
  RewriteRule ^(about|gallery|contact|book)[.]html$ /$1 [R=301,L]
  RewriteCond %{THE_REQUEST} (about|gallery|contact|book)/([[:space:]]|[?]) [NC]
  RewriteRule ^(about|gallery|contact|book)/$ /$1 [R=301,L]
  RewriteCond %{REQUEST_URI} ![.][a-z0-9]+$ [NC]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^(.+?)/?$ $1.html [L]
</IfModule>

# --- Caching -------------------------------------------------------------
<IfModule mod_expires.c>
  ExpiresActive On
  # HTML: zero caching horizon - revalidate on every hit so a new deploy is
  # visible within seconds instead of waiting out a 1-hour CDN edge TTL.
  ExpiresByType text/html                "access plus 0 seconds"
  ExpiresByType text/css                 "access plus 1 year"
  ExpiresByType application/javascript   "access plus 1 year"
  ExpiresByType image/webp               "access plus 1 year"
  ExpiresByType image/png                "access plus 1 year"
  ExpiresByType image/jpeg               "access plus 1 year"
  ExpiresByType image/svg+xml            "access plus 1 year"
  ExpiresByType video/mp4                "access plus 6 months"
  ExpiresByType font/woff2               "access plus 1 year"
</IfModule>

# --- Compression ---------------------------------------------------------
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/plain text/css text/xml
  AddOutputFilterByType DEFLATE application/javascript application/json
  AddOutputFilterByType DEFLATE image/svg+xml
</IfModule>

# --- Security headers ----------------------------------------------------
# HSTS without "preload" initially (safest; preload is a one-way door).
# CSP is intentionally minimal: all CSS/JS is inline, so a full CSP would
# need hashes/nonces - frame-ancestors + HTTPS upgrade give the easy wins.
<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set X-Frame-Options "SAMEORIGIN"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"
  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  Header always set Content-Security-Policy "frame-ancestors 'none'; upgrade-insecure-requests"
  # HTML only: explicit no-cache (belt + braces over mod_expires above) so no
  # shared cache/CDN edge may reuse a stale copy after a deploy. Images/CSS/JS
  # keep their 1-year Expires rules above.
  # NOTE: use [.] not \. -- a backslash is eaten by the JS template literal.
  <FilesMatch "[.](html|htm)$">
    Header always set Cache-Control "no-cache, max-age=0, must-revalidate"
  </FilesMatch>
</IfModule>

# Block access to dotfiles.
# NOTE: use [.] instead of \. -- a backslash here is eaten by the JS
# template literal, which would turn the regex into "^." (matches EVERYTHING)
# and make LiteSpeed return 403 for all files.
<FilesMatch "^[.]">
  Require all denied
</FilesMatch>
`;

/* ------------------------------------------------------------------ *
 * 7. Verification
 * ------------------------------------------------------------------ */

function collectLocalRefs(html) {
  const refs = new Set();
  const add = (raw) => {
    if (!raw) return;
    if (/^(https?:|data:|mailto:|tel:|javascript:|#|\/\/)/i.test(raw)) return;
    const clean = raw.split("#")[0].split("?")[0];
    if (!clean) return;
    refs.add(decodeURIComponent(clean));
  };
  for (const m of html.matchAll(/(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/gi)) {
    if (m[1].startsWith("#")) continue;
    add(m[1]);
  }
  return [...refs];
}

function verify() {
  const errors = [];
  const warnings = [];

  // index.html must exist at the root of the deploy folder.
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    errors.push("dist/index.html is missing");
  }

  const htmlFiles = fs
    .readdirSync(DIST)
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join(DIST, f));

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    const rel = path.relative(DIST, file);
    for (const ref of collectLocalRefs(html)) {
      // url(#gradient) fragments were filtered above; this is a real path.
      const target = path.join(DIST, ref);
      if (fs.existsSync(target)) continue;
      // Clean URL: "/about" is served from about.html by .htaccess.
      if (!path.extname(ref) && fs.existsSync(target + ".html")) continue;
      errors.push(`${rel} -> missing asset "${ref}"`);
    }
  }

  // No leftover references to the pre-rename homepage.
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    if (html.includes("home-2.html")) {
      warnings.push(`${path.relative(DIST, file)} still mentions home-2.html`);
    }
  }

  // Nothing from the development tree leaked into the output.
  const forbidden = ["node_modules", "package.json", "package-lock.json", ".git", "build.mjs", "serve.mjs", ".env"];
  for (const name of forbidden) {
    if (fs.existsSync(path.join(DIST, name))) errors.push(`dist/${name} should not be uploaded`);
  }

  // sitemap.xml must exist and only point at pages that actually ship.
  const sitemapPath = path.join(DIST, "sitemap.xml");
  if (!fs.existsSync(sitemapPath)) {
    errors.push("dist/sitemap.xml is missing");
  } else {
    const xml = fs.readFileSync(sitemapPath, "utf8");
    for (const m of xml.matchAll(/<loc>https:\/\/teonoxstudio\.com\/([^<]*)<\/loc>/g)) {
      const target = m[1] === "" ? "index.html" : m[1];
      const file = path.join(DIST, target);
      const ok = fs.existsSync(file) || (!path.extname(target) && fs.existsSync(file + ".html"));
      if (!ok) {
        errors.push(`sitemap.xml -> missing page "${m[1]}"`);
      }
    }
  }

  // robots.txt must advertise the sitemap.
  const robotsPath = path.join(DIST, "robots.txt");
  if (!fs.existsSync(robotsPath) || !fs.readFileSync(robotsPath, "utf8").includes("Sitemap: https://teonoxstudio.com/sitemap.xml")) {
    errors.push("dist/robots.txt is missing the Sitemap line");
  }

  return { errors, warnings, htmlFiles };
}

/* ------------------------------------------------------------------ *
 * 8. Main
 * ------------------------------------------------------------------ */

async function main() {
  const started = Date.now();

  console.log("\n  Teonox Studio - production build\n  " + "-".repeat(46));

  // 1. clean
  fs.rmSync(DIST, { recursive: true, force: true });
  ensureDir("");
  console.log("  [1/6] cleaned dist/");

  if (CLEAN_ONLY) {
    console.log("  clean-only mode: nothing else to do.\n");
    return;
  }

  const rules = buildRewrites();

  // 2 + 3. media
  console.log("  [2/6] optimising images...");
  const images = OPTIMISE_MEDIA ? await buildImages() : COPY_VERBATIM.map((r) => [r, r, sourceSize(r), copyVerbatim(r)]);
  console.log(`        ${images.length} images written`);

  console.log("  [3/6] encoding hero video...");
  const video = await buildVideo();
  console.log(`        ${video.out} -> ${human(video.bytes)}${video.encoded ? " (H.264 web-optimised)" : " (copied)"}`);

  // 4. pages
  console.log("  [4/6] building pages...");
  const pages = await buildPages(rules);
  for (const p of pages) {
    console.log(`        ${p.out.padEnd(16)} ${human(p.before)} -> ${human(p.after)}`);
  }

  // 5. extras
  console.log("  [5/6] writing hosting extras...");
  writeFile("404.html", applyRewrites(NOT_FOUND_HTML, rules));
  writeFile("robots.txt", ROBOTS_TXT);
  writeFile("sitemap.xml", buildSitemap());
  writeFile(".htaccess", HTACCESS);
  console.log("        404.html, robots.txt, sitemap.xml, .htaccess");

  // 6. verify
  console.log("  [6/6] verifying output...");
  const { errors, warnings } = verify();

  const total = dirSize(DIST);
  const sourceTotal = sourceTreeSize();

  console.log("\n  " + "-".repeat(46));
  console.log(`  dist size: ${human(total)}  (source tree ${human(sourceTotal)})`);
  console.log(`  build time: ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (warnings.length) {
    console.log("\n  warnings:");
    for (const w of warnings) console.log(`    - ${w}`);
  }

  if (errors.length) {
    console.error("\n  BUILD FAILED - unresolved references:");
    for (const e of errors) console.error(`    x ${e}`);
    console.error("");
    process.exit(1);
  }

  console.log("\n  BUILD OK - every local reference resolves inside dist/.\n");
}

main().catch((err) => {
  console.error("\n  BUILD ERROR:", err.message, "\n");
  console.error(err.stack);
  process.exit(1);
});

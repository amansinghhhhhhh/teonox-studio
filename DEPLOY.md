# Deploying Teonox Studio to Hostinger (static hosting)

## What this project is

A **hand-written static HTML site** — no framework, no bundler, no backend.

- CSS is inline in `<style>` blocks
- JS is inline in `<script>` blocks (no framework, no imports)
- Fonts come from the Google Fonts CDN
- The booking form on `book.html` is client-side only; it finishes on WhatsApp
- No API keys, no database, no server-side code

It was therefore already "static", but it had no build step, no `index.html`
at the root, and ~68 MB of oversized assets. `build.mjs` fixes all three.

## Build

```bash
npm install       # once
npm run build     # produces ./dist
npm run preview   # optional: serve ./dist at http://localhost:4173
```

### Local preview (Windows)

Double-click **`preview.bat`** to open the preview in its own console window:

| Command | Serves | URL |
| --- | --- | --- |
| `preview.bat` | the source `.html` files | http://localhost:4173/ |
| `preview.bat dist` | the built `dist/` folder | http://localhost:4173/ |
| `preview.bat dist 4180` | `dist/` on another port | http://localhost:4180/ |

The equivalent npm scripts are `npm run dev` (source) and `npm run serve` (dist).
Close the console window to stop the server.

## Upload to Hostinger

Upload the **contents of `dist/`** into `public_html/` (or the
`public_html/<subfolder>/` of your domain). Do **not** upload the project
root — `dist/` is the only thing the server needs.

```
public_html/
├── index.html          <- homepage (required at the root)
├── about.html
├── gallery.html
├── contact.html
├── book.html
├── 404.html
├── robots.txt
├── .htaccess
├── logo-black.webp
├── logo-white.webp
├── favicon_teonox.png
├── a2-camera.webp
├── p2-img-shape-1-1.webp
├── line-shape.png
├── Hero Video/Teonox-Studio.mp4
├── images/{hero,setup,studio,gallery,gear,avatars}/
└── section image/
```

`node_modules/`, the `.html` source files, `build.mjs`, `package.json`
and the unused design-source folders (`Setup Styles/`, `Hero images/`,
`Studio Experience/`, `Creator Classroom Space/`, `gear images/`, `font/`,
`fonts/`) are all excluded from `dist/` on purpose.

## What the build does

| Step | Detail |
| --- | --- |
| Homepage | `home-2.html` → `index.html`, all internal links rewritten |
| Clean URLs | `/about`, `/gallery`, `/contact`, `/book` — `.htaccess` serves the `.html` file internally and 301-redirects old `.html` URLs |
| HTML | minified (whitespace, comments, inline CSS + JS) |
| Gallery photos | 11 PNGs (~28 MB) → WebP (~2 MB) |
| Logos | PNG → **lossless** WebP (pixel-identical, smaller) |
| Other photos | JPEG re-encoded with mozjpeg |
| Hero video | 22 MB 1080p60 → 1.55 MB 1600×900@30 H.264, `faststart` |
| Extras | `404.html`, `robots.txt`, `sitemap.xml`, `.htaccess` (caching + gzip + 404 doc + clean URLs + security headers) |

## Notes

- The `.htaccess` sets `ErrorDocument 404 /404.html`. If you upload to a
  subfolder rather than `public_html/`, change that to the relative path.
- `about-embed.html` in the source folder is a standalone offline-copy
  variant of the About page (2.7 MB, fonts inlined as base64). Nothing links
  to it, so it is intentionally **not** deployed.
- Fonts load from `fonts.googleapis.com`. If you need the site to work fully
  offline, deploy `about-embed.html` instead of `about.html`.

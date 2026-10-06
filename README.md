# SiteCrawl

A small Next.js tool that takes the URL of a web page and gives you two downloads:

- **Self-contained HTML** — the page's HTML with every linked stylesheet inlined as a `<style>` block, so the layout renders from a single file.
- **Brand kit JSON** — colours, fonts, type sizes, button styles, logo and favicon pulled out of the page's CSS and markup.

It's built for preparing a local copy of a client page without having to save and stitch files together by hand. The two files are then used as input for later steps, such as a Next.js rebuild or a Figma import.

SiteCrawl does not create anything for Figma itself. Importing into Figma is a separate step: run the **html-brank-kit-to-figma** Claude Code skill and give it the HTML file and the brand kit JSON. That skill generates the Figma plugin that you then import into Figma.

## Requirements

- Node.js 18.18 or later (Node 20+ recommended)
- npm

## Getting started

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

For a production build:

```bash
npm run build
npm start
```

## Using the app

1. Paste a page URL into the box. If you leave off the scheme, `https://` is assumed.
2. Choose a download:
   - **Fetch & Download** saves `<host>-<timestamp>.html`.
   - **Download Brand Kit** saves `<host>-<timestamp>.brandkit.json`.
3. A summary appears under the form. For the HTML download it lists how many stylesheets were inlined and any that were skipped, with the reason (for example `HTTP 404` or a timeout).

### What the HTML snapshot includes

- The original HTML, unchanged except that each `<link rel="stylesheet">` is replaced by a `<style>` block holding that file's CSS, in the same position and order. Each block is preceded by a comment naming the URL it came from.
- Existing inline `<style>` blocks are left where they are.

What it does **not** do:

- `@import` rules inside stylesheets are not followed.
- Images, fonts and scripts are not downloaded. They still load from the original site, so the snapshot needs a network connection to look complete, and assets will break if the live site moves them.
- Content rendered only by JavaScript after page load is not captured. You get the HTML the server sends.

### What the brand kit contains

| Field | What it holds |
| --- | --- |
| `colorScheme` | `light` or `dark`, from the page background |
| `fonts` | Font families with a `body` or `heading` role |
| `colors` | `primary`, `secondary`, `tertiary`, `accent`, `background`, `textPrimary`, `textSecondary`, `link` |
| `typography` | Primary and heading families, full font stacks, and `h1` / `h2` / body sizes |
| `spacing` | `baseUnit` (always `4`, since a spacing scale can't be reliably read from CSS) and the most common button border radius |
| `components` | Background, text colour, border colour, radius and shadow for the primary and secondary buttons |
| `images` | Logo, favicon and Open Graph image URLs, plus the logo's link and alt text |
| `brandName` | `og:site_name`, else the page `<title>`, else the logo's alt text |
| `sourceUrl` | The page the kit was built from, after redirects |

The values come from code heuristics, not a reading of the design:

- **Primary / secondary** are the most frequent background colours on button-like elements, in that order.
- **Accent** is the background of the call-to-action button in the header (a filled "Sign up" or "Get started" rather than a menu link), falling back to the first button in the hero.
- **Tertiary** comes from icon colours and button hover states.
- CSS custom properties (including Tailwind v4 `@theme` tokens) are resolved, preferring the definitions that actually apply to the page's `<html>` / `<body>`.
- Colours that can't be found fall back to the theme's neutral (white or black). Button fields fall back to CSS initial values (`transparent`, `0px`, `none`). Other fields that can't be read are `null`.

Treat the kit as a starting point and check it against the live page. A site's real brand colour is not always the one used most often on buttons.

## API

The UI calls two routes, and you can call them directly. Both accept either a `?url=` query parameter or a JSON body `{ "url": "..." }`, over `GET` or `POST`.

| Route | Returns |
| --- | --- |
| `/api/fetch-html` | `{ url, html, css: [{ url, start, end, content }], inlineStyles, failed }`. The `start` / `end` values are character offsets of each `<link>` tag in `html`. The browser does the splicing into a single file. |
| `/api/fetch-brandkit` | The brand kit object described above. |

```bash
curl "http://localhost:3000/api/fetch-brandkit?url=https://example.com"
```

Errors come back as `{ "error": "..." }` with status `400` (bad URL), `415` (not an HTML page) or `502` (the site failed or couldn't be reached).

## Limits and safety

- Up to 50 stylesheets per page, fetched 6 at a time, with a 15-second timeout per request and at most 5 redirects.
- Only `http://` and `https://` URLs are accepted.
- Requests to private or internal addresses (localhost, `10.x`, `192.168.x`, `169.254.x` cloud metadata and similar) are refused, including when a redirect points there. This check runs before each request, so it does not protect against DNS rebinding. Don't expose the app publicly without further hardening.
- Requests use a desktop Chrome user agent. Sites behind bot protection (Cloudflare challenges and similar) may still block it.

## Project layout

```
app/
  page.tsx                   UI, plus building the HTML snapshot in the browser
  api/fetch-html/route.ts    Returns the page HTML and its stylesheets
  api/fetch-brandkit/route.ts Returns the derived brand kit
lib/
  page.ts                    Fetches the page and its stylesheets (shared by both routes)
  brandkit.ts                Brand kit heuristics
  color.ts                   Colour parsing and luminance maths
  url.ts                     URL parsing, SSRF checks, href resolution
  request.ts                 Reads the url parameter from a request
```

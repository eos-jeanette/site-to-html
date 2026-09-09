import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { USER_AGENT, UrlError, assertPublicHost, parseUserUrl, resolveHref } from "@/lib/url";

// This route does DNS lookups for SSRF checks, so it needs the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REDIRECTS = 5;
const MAX_STYLESHEETS = 50;
const FETCH_TIMEOUT_MS = 15_000;

export type CssFile = {
  url: string;
  /** Character offsets of the original <link> tag in `html`, so the client can splice it out. */
  start: number;
  end: number;
  content: string;
};

export type FetchHtmlResponse = {
  url: string;
  html: string;
  css: CssFile[];
  inlineStyles: string[];
  failed: { url: string; error: string }[];
};

/**
 * Fetch that follows redirects manually so every hop is SSRF-checked — an
 * allowed public URL must not be able to bounce us into an internal address.
 */
async function safeFetch(startUrl: URL, accept: string): Promise<Response> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current.hostname);

    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = resolveHref(location, current.toString());
      if (!next) throw new UrlError("Server redirected to an unsupported URL.");
      current = new URL(next);
      continue;
    }

    return response;
  }

  throw new UrlError("Too many redirects.");
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.url !== "string") {
      return NextResponse.json({ error: "Expected a JSON body with a 'url' string." }, { status: 400 });
    }

    const target = parseUserUrl(body.url);
    const pageResponse = await safeFetch(target, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");

    if (!pageResponse.ok) {
      return NextResponse.json(
        { error: `The site responded with ${pageResponse.status} ${pageResponse.statusText}.` },
        { status: 502 },
      );
    }

    const contentType = pageResponse.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return NextResponse.json(
        { error: `That URL returned "${contentType || "an unknown type"}", not HTML.` },
        { status: 415 },
      );
    }

    const html = await pageResponse.text();
    // Redirects mean the final URL may differ from the input; relative hrefs resolve against it.
    const baseUrl = pageResponse.url || target.toString();
    // sourceCodeLocationInfo gives exact offsets into the raw HTML, which lets the
    // client swap out each <link> tag without re-serialising (and thus altering) the page.
    const $ = cheerio.load(html, { sourceCodeLocationInfo: true });

    // A <base href> in the document overrides the page URL for relative hrefs.
    const documentBase = resolveHref($("base[href]").first().attr("href") ?? "", baseUrl) ?? baseUrl;

    const inlineStyles: string[] = [];
    $("style").each((_, el) => {
      const css = $(el).html();
      if (css && css.trim()) inlineStyles.push(css);
    });

    const seen = new Set<string>();
    const links: { url: string; start: number; end: number }[] = [];
    $("link").each((_, el) => {
      const rel = ($(el).attr("rel") ?? "").toLowerCase();
      if (!rel.split(/\s+/).includes("stylesheet")) return;
      const resolved = resolveHref($(el).attr("href") ?? "", documentBase);
      if (!resolved || seen.has(resolved)) return;
      const location = el.sourceCodeLocation;
      if (!location) return; // no offsets (e.g. parser-invented node) — leave the tag alone
      seen.add(resolved);
      links.push({ url: resolved, start: location.startOffset, end: location.endOffset });
    });

    const css: CssFile[] = [];
    const failed: { url: string; error: string }[] = [];

    // Sequential-ish batching keeps us from hammering the origin with 50 parallel requests.
    const batches = chunk(links.slice(0, MAX_STYLESHEETS), 6);
    for (const batch of batches) {
      const results = await Promise.all(
        batch.map(async (link) => {
          try {
            const res = await safeFetch(new URL(link.url), "text/css,*/*;q=0.1");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // NOTE: stylesheet text is taken as-is. @import rules inside it are not
            // followed, and referenced assets (images, fonts) are not fetched or
            // inlined, so the snapshot may still reach out to the network for those.
            return { ...link, content: await res.text() };
          } catch (error) {
            failed.push({ url: link.url, error: messageOf(error) });
            return null;
          }
        }),
      );
      for (const result of results) if (result) css.push(result);
    }

    const payload: FetchHtmlResponse = { url: baseUrl, html, css, inlineStyles, failed };
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof UrlError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: `Could not fetch that page: ${messageOf(error)}` }, { status: 502 });
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "the request timed out";
    return error.message;
  }
  return String(error);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

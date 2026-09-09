"use client";

import { useState } from "react";
import type { FetchHtmlResponse } from "./api/fetch-html/route";
import type { FetchBrandKitResponse } from "./api/fetch-brandkit/route";

type Job = "html" | "brandkit";

type Result = {
  filename: string;
  summary: string;
  failed?: FetchHtmlResponse["failed"];
};

export default function Home() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  /** Both downloads share this: same validation, loading and error handling. */
  async function run<T>(job: Job, endpoint: string, build: (data: T) => Result & { blob: Blob }) {
    setError(null);
    setResult(null);

    if (!url.trim()) {
      setError("Please enter a URL.");
      return;
    }

    setBusy(job);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await response.json();
      if (!response.ok || (data && typeof data === "object" && "error" in data)) {
        setError(typeof data?.error === "string" ? data.error : `Request failed (${response.status}).`);
        return;
      }

      const { blob, ...info } = build(data as T);
      download(blob, info.filename);
      setResult(info);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  function downloadHtml() {
    return run<FetchHtmlResponse>("html", "/api/fetch-html", (data) => {
      const filename = stampedFilename(data.url, "html");
      const inline = data.inlineStyles.length;
      return {
        blob: new Blob([buildSnapshot(data)], { type: "text/html;charset=utf-8" }),
        filename,
        summary:
          `${data.css.length} stylesheet${data.css.length === 1 ? "" : "s"} inlined, ` +
          `${inline} inline <style> block${inline === 1 ? "" : "s"} kept.`,
        failed: data.failed,
      };
    });
  }

  function downloadBrandKit() {
    return run<FetchBrandKitResponse>("brandkit", "/api/fetch-brandkit", (kit) => {
      const derived = countDerived(kit);
      return {
        blob: new Blob([JSON.stringify(kit, null, 2)], { type: "application/json;charset=utf-8" }),
        filename: stampedFilename(kit.sourceUrl, "brandkit.json"),
        summary:
          `${kit.colorScheme} scheme, ${kit.fonts.length} font${kit.fonts.length === 1 ? "" : "s"}, ` +
          `${derived.found} of ${derived.total} colour slots derived.`,
      };
    });
  }

  return (
    <main>
      <h1>SiteCrawl</h1>
      <p className="lede">
        Fetch a page and download it as a self-contained HTML file, or extract its brand kit as JSON.
      </p>

      <form onSubmit={(event) => event.preventDefault()}>
        <input
          type="text"
          inputMode="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com"
          aria-label="Page URL"
          disabled={busy !== null}
        />
        <button type="submit" onClick={downloadHtml} disabled={busy !== null}>
          {busy === "html" ? "Fetching…" : "Fetch & Download"}
        </button>
        <button type="button" className="secondary" onClick={downloadBrandKit} disabled={busy !== null}>
          {busy === "brandkit" ? "Analysing…" : "Download Brand Kit"}
        </button>
      </form>

      {error && (
        <div className="panel error" role="alert">
          {error}
        </div>
      )}

      {result && (
        <div className="panel">
          <h2>Downloaded {result.filename}</h2>
          <div>{result.summary}</div>
          {result.failed && result.failed.length > 0 && (
            <ul>
              {result.failed.map((item) => (
                <li key={item.url}>
                  Skipped {item.url} — {item.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="note">
        Stylesheets are inlined as-is. <code>@import</code> rules are not followed and images, fonts and
        scripts are still loaded from the original site. Brand kit values are derived by code heuristics
        from the CSS and markup; anything that can&apos;t be read directly is left <code>null</code>.
      </p>
    </main>
  );
}

/** How many of the six colour slots came back with a value — a rough quality signal. */
function countDerived(kit: FetchBrandKitResponse): { found: number; total: number } {
  const slots = Object.values(kit.colors);
  return { found: slots.filter(Boolean).length, total: slots.length };
}

/**
 * Swap each <link rel="stylesheet"> for a <style> block holding the CSS the server
 * fetched. Tags are spliced out by their source offsets, working backwards so earlier
 * offsets stay valid, which leaves the rest of the document byte-for-byte intact and
 * preserves stylesheet order. Inline <style> blocks are already in the HTML and stay
 * where they are.
 */
function buildSnapshot(data: FetchHtmlResponse): string {
  let html = data.html;

  for (const file of [...data.css].sort((a, b) => b.start - a.start)) {
    const css = neutraliseClosingTag(file.content);
    const block = `<!-- inlined from ${escapeComment(file.url)} -->\n<style>\n${css}\n</style>`;
    html = html.slice(0, file.start) + block + html.slice(file.end);
  }

  return html;
}

/** Stop a stray "</style" inside CSS text from closing the block early. */
function neutraliseClosingTag(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

function escapeComment(text: string): string {
  return text.replace(/--/g, "- -").replace(/>/g, "&gt;");
}

function stampedFilename(pageUrl: string, extension: string): string {
  let host = "page";
  try {
    host = new URL(pageUrl).hostname.replace(/[^a-z0-9.-]/gi, "") || "page";
  } catch {
    // fall through to the default
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${host}-${stamp}.${extension}`;
}

function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

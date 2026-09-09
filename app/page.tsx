"use client";

import { useState } from "react";
import type { FetchHtmlResponse } from "./api/fetch-html/route";

type Result = { filename: string; cssCount: number; inlineCount: number; failed: FetchHtmlResponse["failed"] };

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (!url.trim()) {
      setError("Please enter a URL.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/fetch-html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = (await response.json()) as FetchHtmlResponse | { error: string };
      if (!response.ok || "error" in data) {
        setError("error" in data ? data.error : `Request failed (${response.status}).`);
        return;
      }

      const combined = buildSnapshot(data);
      const filename = snapshotFilename(data.url);
      downloadHtml(combined, filename);
      setResult({
        filename,
        cssCount: data.css.length,
        inlineCount: data.inlineStyles.length,
        failed: data.failed,
      });
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1>SiteCrawl</h1>
      <p className="lede">
        Fetch a page and download it as a single HTML file with its stylesheets inlined.
      </p>

      <form onSubmit={handleSubmit}>
        <input
          type="text"
          inputMode="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com"
          aria-label="Page URL"
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Fetching…" : "Fetch & Download"}
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
          <div>
            {result.cssCount} stylesheet{result.cssCount === 1 ? "" : "s"} inlined, {result.inlineCount} inline{" "}
            <code>&lt;style&gt;</code> block{result.inlineCount === 1 ? "" : "s"} kept.
          </div>
          {result.failed.length > 0 && (
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
        scripts are still loaded from the original site.
      </p>
    </main>
  );
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
  return css.replace(/<\/(style)/gi, "<\/$1");
}

function escapeComment(text: string): string {
  return text.replace(/--/g, "- -").replace(/>/g, "&gt;");
}

function snapshotFilename(pageUrl: string): string {
  let host = "page";
  try {
    host = new URL(pageUrl).hostname.replace(/[^a-z0-9.-]/gi, "") || "page";
  } catch {
    // fall through to the default
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${host}-${stamp}.html`;
}

function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

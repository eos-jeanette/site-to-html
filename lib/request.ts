import { UrlError } from "@/lib/url";

/**
 * Read the target URL from a request, accepting either a `?url=` query param or
 * a JSON body with a `url` string, so both API routes take the same input either way.
 */
export async function readUrlParam(request: Request): Promise<string> {
  const fromQuery = new URL(request.url).searchParams.get("url");
  if (fromQuery && fromQuery.trim()) return fromQuery;

  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.json().catch(() => null);
    if (body && typeof body.url === "string" && body.url.trim()) return body.url;
  }

  throw new UrlError("Expected a 'url' query parameter or a JSON body with a 'url' string.");
}

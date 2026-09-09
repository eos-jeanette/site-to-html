import { NextResponse } from "next/server";
import { UrlError } from "@/lib/url";
import { type PageBundle, UpstreamError, fetchPageBundle, messageOf } from "@/lib/page";
import { readUrlParam } from "@/lib/request";

// This route does DNS lookups for SSRF checks, so it needs the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type { CssFile } from "@/lib/page";
export type FetchHtmlResponse = PageBundle;

export async function POST(request: Request) {
  try {
    const url = await readUrlParam(request);
    const bundle = await fetchPageBundle(url);
    return NextResponse.json(bundle satisfies FetchHtmlResponse);
  } catch (error) {
    if (error instanceof UrlError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof UpstreamError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: `Could not fetch that page: ${messageOf(error)}` }, { status: 502 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}

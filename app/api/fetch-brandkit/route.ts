import { NextResponse } from "next/server";
import { UrlError } from "@/lib/url";
import { UpstreamError, fetchPageBundle, messageOf } from "@/lib/page";
import { readUrlParam } from "@/lib/request";
import { type BrandKit, deriveBrandKit } from "@/lib/brandkit";

// Shares the SSRF-checked fetching in lib/page.ts, so this route needs the Node.js runtime too.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type { BrandKit } from "@/lib/brandkit";

export type FetchBrandKitResponse = BrandKit & {
  /** The page the kit was derived from, after redirects. */
  sourceUrl: string;
};

export async function POST(request: Request) {
  try {
    const url = await readUrlParam(request);
    // Same fetch/parse path as /api/fetch-html — the page and every linked stylesheet.
    const bundle = await fetchPageBundle(url);
    const kit = deriveBrandKit(bundle);
    return NextResponse.json({ ...kit, sourceUrl: bundle.url } satisfies FetchBrandKitResponse);
  } catch (error) {
    if (error instanceof UrlError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof UpstreamError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: `Could not build a brand kit for that page: ${messageOf(error)}` },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  return POST(request);
}

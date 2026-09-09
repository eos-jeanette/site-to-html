import { lookup } from "node:dns/promises";
import net from "node:net";

/** Browser-like UA so servers don't hand us a bot-blocked page. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class UrlError extends Error {}

/**
 * Parse user input into a URL, defaulting to https:// when no scheme is given.
 * Only http/https are permitted (blocks file:, data:, gopher:, etc.).
 */
export function parseUserUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new UrlError("Please enter a URL.");

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new UrlError("That doesn't look like a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlError("Only http:// and https:// URLs are supported.");
  }
  if (!url.hostname) throw new UrlError("That doesn't look like a valid URL.");
  return url;
}

/** True for loopback, private, link-local, CGNAT, and other non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // not a parseable IP — treat as unsafe
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // strip zone id
  if (addr === "::" || addr === "::1") return true; // unspecified / loopback
  if (addr.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique local
  // IPv4-mapped / -compatible (::ffff:10.0.0.1) — re-check the embedded v4 address.
  const embedded = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) return isPrivateIpv4(embedded[1]);
  return false;
}

/**
 * Resolve the hostname and reject it if any DNS answer points at a
 * private/internal address. Basic SSRF protection: this checks before the
 * request is made, so a host whose DNS flips between the check and the fetch
 * (DNS rebinding) is not covered.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");

  if (net.isIP(bare)) {
    if (isPrivateIp(bare)) throw new UrlError("Refusing to fetch a private or internal address.");
    return;
  }

  const lower = bare.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    throw new UrlError("Refusing to fetch a private or internal address.");
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    throw new UrlError(`Could not resolve host "${bare}".`);
  }

  if (addresses.length === 0) throw new UrlError(`Could not resolve host "${bare}".`);
  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new UrlError("Refusing to fetch a private or internal address.");
  }
}

/** Resolve a possibly-relative href against the page URL; null if unusable. */
export function resolveHref(href: string, base: string): string | null {
  const value = href.trim();
  if (!value || value.startsWith("data:") || value.startsWith("#")) return null;
  try {
    const resolved = new URL(value, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

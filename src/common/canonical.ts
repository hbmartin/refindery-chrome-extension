// Best-effort, client-side URL canonicalization used ONLY for local cooldown
// throttling. The Refindery server is authoritative for dedupe (it also applies
// per-domain keep-param rules we can't know here), so this only needs to be a
// good-enough stable key to avoid re-POSTing the same page repeatedly.

// Mirrors the server's default tracking-param strip list.
const STRIP_EXACT = new Set(['fbclid', 'gclid', 'ref', 'si']);
const STRIP_PREFIX = ['utm_'];

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (STRIP_EXACT.has(lower)) return true;
  return STRIP_PREFIX.some((p) => lower.startsWith(p));
}

/**
 * Returns a canonical key (scheme + host + path + sorted non-tracking query),
 * or null if the URL is unparseable. Fragment is dropped; host is lowercased;
 * a trailing slash on the path is normalized away (except root).
 */
export function canonicalKey(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let path = u.pathname || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '') || '/';

  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.map(([k, v]) => `${k}=${v}`).join('&');

  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  return `${scheme}://${host}${path}${query ? '?' + query : ''}`;
}

/** Registrable-ish domain (host without a leading "www."). */
export function domainOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Full lowercased hostname (keeps subdomains, no www stripping). */
export function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

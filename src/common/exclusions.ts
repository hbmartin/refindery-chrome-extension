// Decides whether a page may be auto-captured. All checks here are LOCAL
// (pre-send); nothing leaves the browser. Distinct from the server-side
// blacklist created by POST /v1/forget.

import type { Settings, UserSkipRule } from './settings';
import { hostOf } from './canonical';

export interface SensitiveDomain {
  category: 'banking' | 'health' | 'webmail' | 'adult';
  domain: string;
}

// Editable default blocklist of sensitive-category domains. Users can disable
// individual categories/entries in Options; they cannot be sent by mistake.
export const DEFAULT_SENSITIVE_DOMAINS: SensitiveDomain[] = [
  // banking / financial
  { category: 'banking', domain: 'chase.com' },
  { category: 'banking', domain: 'bankofamerica.com' },
  { category: 'banking', domain: 'wellsfargo.com' },
  { category: 'banking', domain: 'citi.com' },
  { category: 'banking', domain: 'capitalone.com' },
  { category: 'banking', domain: 'paypal.com' },
  { category: 'banking', domain: 'venmo.com' },
  { category: 'banking', domain: 'coinbase.com' },
  { category: 'banking', domain: 'fidelity.com' },
  { category: 'banking', domain: 'schwab.com' },
  { category: 'banking', domain: 'vanguard.com' },
  // health
  { category: 'health', domain: 'mychart.com' },
  { category: 'health', domain: 'mychart.org' },
  { category: 'health', domain: 'healthcare.gov' },
  { category: 'health', domain: 'kaiserpermanente.org' },
  { category: 'health', domain: 'goodrx.com' },
  // webmail
  { category: 'webmail', domain: 'mail.google.com' },
  { category: 'webmail', domain: 'outlook.live.com' },
  { category: 'webmail', domain: 'outlook.office.com' },
  { category: 'webmail', domain: 'mail.yahoo.com' },
  { category: 'webmail', domain: 'proton.me' },
  { category: 'webmail', domain: 'mail.proton.me' },
  // adult
  { category: 'adult', domain: 'pornhub.com' },
  { category: 'adult', domain: 'xvideos.com' },
  { category: 'adult', domain: 'xnxx.com' },
  { category: 'adult', domain: 'onlyfans.com' },
];

const LOCAL_HOST_EXACT = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** RFC-1918 / loopback / link-local / *.local hosts. */
export function isLocalHost(host: string): boolean {
  if (LOCAL_HOST_EXACT.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;
  // IPv4 private ranges
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

function isWebScheme(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Host suffix match: "a.example.com" matches rule "example.com". */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\*?\.?/, '');
  return host === d || host.endsWith('.' + d);
}

/** Glob match supporting '*' wildcards for URL-kind rules. */
export function urlMatchesGlob(url: string, glob: string): boolean {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$', 'i').test(url);
}

function matchesUserRule(url: string, host: string, rule: UserSkipRule): boolean {
  if (rule.kind === 'domain') return hostMatchesDomain(host, rule.pattern);
  return urlMatchesGlob(url, rule.pattern);
}

export interface SkipDecision {
  skip: boolean;
  reason?: string;
}

/**
 * Pure decision function (no chrome APIs) so it is unit-testable. The caller
 * supplies the incognito flag and global-pause state.
 */
export function decideSkip(
  url: string,
  opts: { incognito: boolean; paused: boolean; settings: Settings },
): SkipDecision {
  if (opts.paused) return { skip: true, reason: 'paused' };
  if (opts.incognito) return { skip: true, reason: 'incognito' };
  if (!isWebScheme(url)) return { skip: true, reason: 'non-web-scheme' };

  const host = hostOf(url);
  if (!host) return { skip: true, reason: 'unparseable-url' };
  if (isLocalHost(host)) return { skip: true, reason: 'local-host' };

  const disabled = new Set(opts.settings.disabledDefaultCategories);
  for (const entry of DEFAULT_SENSITIVE_DOMAINS) {
    if (disabled.has(entry.category)) continue;
    if (hostMatchesDomain(host, entry.domain)) {
      return { skip: true, reason: `sensitive:${entry.category}` };
    }
  }

  for (const rule of opts.settings.userSkipRules) {
    if (matchesUserRule(url, host, rule)) {
      return { skip: true, reason: `user-rule:${rule.pattern}` };
    }
  }

  return { skip: false };
}

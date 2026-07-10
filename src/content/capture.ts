// Isolated-world content script. On page load and on SPA route changes, asks
// the worker whether to capture; if so, sanitizes the DOM and sends a payload.

import DOMPurify from 'dompurify';
import type { CapturePayload, CaptureTrigger, ShouldCaptureReply } from '@/common/types';
import { canonicalKey } from '@/common/canonical';
import { MAX_BODY_BYTES } from '@/common/settings';

const MIN_TEXT_CHARS = 200; // skip near-empty HTML pages
const DEBOUNCE_MS = 700;

let lastAttemptedHref = '';
// MAIN-world messages are forgeable by the page. Only treat one as navigation
// when the isolated world can observe that the browser URL actually changed.
let lastObservedHref = location.href;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function faviconUrl(): string | null {
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel~="icon"], link[rel="shortcut icon"]',
  );
  if (link?.href) return link.href;
  try {
    return new URL('/favicon.ico', location.origin).href;
  } catch {
    return null;
  }
}

function sanitizeDocument(): string {
  // Keep document structure/text for the server's extractor, but drop scripts,
  // styles, event handlers, and other non-content noise to shrink the payload.
  return DOMPurify.sanitize(document.documentElement.outerHTML, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template'],
    FORBID_ATTR: ['style'],
    KEEP_CONTENT: true,
  });
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

async function buildPayload(trigger: CaptureTrigger): Promise<CapturePayload | null> {
  const url = location.href;
  const contentType = (document.contentType || '').toLowerCase();
  const isPdf = contentType === 'application/pdf' || /\.pdf($|\?)/i.test(url);

  let bodyHtml: string | null = null;
  let bodyBytes = 0;

  if (isPdf) {
    // PDFs: send URL-only; the server fetches/extracts.
    bodyHtml = null;
  } else if (
    contentType &&
    contentType !== 'text/html' &&
    contentType !== 'application/xhtml+xml'
  ) {
    // Non-HTML document (JSON, plain text, images) — skip entirely.
    return null;
  } else {
    const textLen = (document.body?.innerText ?? '').trim().length;
    if (textLen < MIN_TEXT_CHARS) return null; // too thin to be worth indexing
    const sanitized = sanitizeDocument();
    const bytes = byteLength(sanitized);
    if (bytes > MAX_BODY_BYTES) {
      bodyHtml = null; // oversize → URL-only fallback
    } else {
      bodyHtml = sanitized;
      bodyBytes = bytes;
    }
  }

  return {
    url,
    title: document.title || null,
    bodyHtml,
    bodyBytes,
    fetchedAt: new Date().toISOString(),
    trigger,
    referrer: document.referrer || null,
    favicon: faviconUrl(),
    canonicalKey: canonicalKey(url) ?? url,
  };
}

async function attemptCapture(trigger: CaptureTrigger): Promise<void> {
  const url = location.href;
  if (url === lastAttemptedHref && trigger !== 'manual') return;
  lastAttemptedHref = url;

  let reply: ShouldCaptureReply;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'shouldCapture', url });
  } catch {
    return; // worker not available (e.g. during reload)
  }
  if (!reply?.capture) return;

  const payload = await buildPayload(trigger);
  if (!payload) return;

  try {
    await chrome.runtime.sendMessage({ type: 'capture', payload });
  } catch {
    /* swallow — worker may be restarting; next trigger will retry */
  }
}

function scheduleCapture(trigger: CaptureTrigger): void {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void attemptCapture(trigger), DEBOUNCE_MS);
}

// SPA navigations relayed from the MAIN-world hook.
window.addEventListener('message', (e) => {
  if (e.source === window && e.data?.source === 'refindery' && e.data.kind === 'locationchange') {
    const currentHref = location.href;
    if (currentHref === lastObservedHref) return;
    lastObservedHref = currentHref;
    // A genuine URL change resets the attempt dedupe so rapid A→B→A hops
    // within the debounce window can still capture the final route.
    lastAttemptedHref = '';
    scheduleCapture('spa');
  }
});

// Initial capture for the full page load. document_idle means the DOM is ready;
// give late-rendering content a moment before snapshotting.
scheduleCapture('load');

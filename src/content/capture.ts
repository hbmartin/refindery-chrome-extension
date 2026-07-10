// Isolated-world content script. On page load and on SPA route changes, asks
// the worker whether to capture; if so, sanitizes the DOM and sends a payload.
// Also handles an explicit "capture now" request relayed from the popup / a
// keyboard command / the context menu.

import DOMPurify from 'dompurify';
import type {
  CapturePayload,
  CaptureResult,
  CaptureTrigger,
  ShouldCaptureReply,
} from '@/common/types';
import { canonicalKey } from '@/common/canonical';
import { MAX_BODY_BYTES } from '@/common/settings';
import { redactSecrets } from '@/common/redact';
import { browserApi } from '@/common/browser';

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

// A visible password field is a strong signal that the page is a login / auth
// surface even when its domain isn't on the sensitive list. Skipping these is a
// privacy-safety default that applies even to explicit manual captures.
function hasVisiblePasswordField(root: Document | ShadowRoot = document): boolean {
  // Lazily walk each tree so a match can abort without allocating a NodeList
  // containing every element in a potentially large document.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let el = walker.nextNode() as Element | null;
  while (el) {
    if (el instanceof HTMLInputElement && el.type === 'password') {
      // offsetParent is null for display:none (and for position:fixed, which may
      // still be visible) — fall back to client rects to catch the fixed case.
      if (el.offsetParent !== null || el.getClientRects().length > 0) return true;
    }
    // Closed shadow roots expose no `.shadowRoot`, so their contents are
    // intentionally out of reach; only open roots can be traversed.
    if (el.shadowRoot && hasVisiblePasswordField(el.shadowRoot)) return true;
    el = walker.nextNode() as Element | null;
  }
  return false;
}

function sanitizeDocument(): string {
  // Keep document structure/text for the server's extractor, but drop scripts,
  // styles, event handlers, and other non-content noise to shrink the payload.
  const clean = DOMPurify.sanitize(document.documentElement.outerHTML, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template'],
    FORBID_ATTR: ['style'],
    KEEP_CONTENT: true,
  });
  // Defence-in-depth: mask high-confidence secrets (payment cards, SSNs) that
  // can appear in the DOM of an otherwise-allowed page before anything is sent.
  return redactSecrets(clean);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

async function buildPayload(
  trigger: CaptureTrigger,
  opts: { manual?: boolean } = {},
): Promise<CapturePayload | null> {
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
    // A manual capture is an explicit user request, so don't gate it on the
    // thin-content threshold that suppresses noisy auto-captures.
    if (!opts.manual && textLen < MIN_TEXT_CHARS) return null;
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

async function attemptCapture(trigger: CaptureTrigger): Promise<CaptureResult> {
  const manual = trigger === 'manual';
  const url = location.href;
  if (!manual && url === lastAttemptedHref) return { captured: false, reason: 'duplicate' };
  lastAttemptedHref = url;

  let reply: ShouldCaptureReply;
  try {
    reply = await browserApi.runtime.sendMessage({ type: 'shouldCapture', url, manual });
  } catch {
    return { captured: false, reason: 'worker-unavailable' };
  }
  if (!reply?.capture) return { captured: false, reason: reply?.reason ?? 'skipped' };

  // DOM-based sensitivity check runs here (the worker can't see the page).
  if (hasVisiblePasswordField()) return { captured: false, reason: 'sensitive-page' };

  const payload = await buildPayload(trigger, { manual });
  if (!payload) return { captured: false, reason: 'no-content' };

  try {
    await browserApi.runtime.sendMessage({ type: 'capture', payload });
    return { captured: true };
  } catch {
    // worker may be restarting; an auto-trigger will retry, a manual one reports.
    return { captured: false, reason: 'worker-unavailable' };
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

// Explicit "capture this page now" from the popup / command / context menu.
// Runs immediately (no debounce) and reports its outcome back to the caller.
browserApi.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (
    typeof msg !== 'object' ||
    msg === null ||
    (msg as { type?: unknown }).type !== 'captureNow'
  ) {
    return false;
  }
  void attemptCapture('manual').then(sendResponse, () =>
    sendResponse({ captured: false, reason: 'error' }),
  );
  return true; // async response
});

// Initial capture for the full page load. document_idle means the DOM is ready;
// give late-rendering content a moment before snapshotting.
scheduleCapture('load');

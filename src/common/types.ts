// Types for the Refindery upstream ingest/lifecycle API plus internal extension types.

// ── Refindery API: requests ──────────────────────────────────────────────

export interface IngestPageRequest {
  url: string;
  title?: string | null;
  /** Already-extracted plain text. Mutually exclusive with body_html. */
  body_extracted?: string | null;
  /** Raw HTML; server extracts text. Mutually exclusive with body_extracted. */
  body_html?: string | null;
  /** Aware ISO-8601 timestamp (must carry an offset). */
  fetched_at?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ForgetRequest {
  url?: string;
  domain?: string;
  reason?: string;
}

// ── Refindery API: responses ─────────────────────────────────────────────

export const PAGE_STATUSES = [
  'queued',
  'indexing',
  'indexed',
  'failed',
  'dead',
] as const;

export type PageStatus = (typeof PAGE_STATUSES)[number];

/** Terminal states — no further polling needed. */
export const TERMINAL_STATUSES: ReadonlySet<PageStatus> = new Set([
  'indexed',
  'dead',
]);

export interface IngestAcceptedResponse {
  page_id: string;
  status: 'queued';
}

export interface IngestRevisitResponse {
  page_id: string;
  status: PageStatus;
  revisit: true;
  content_hash_differs: boolean;
}

export interface BlacklistedResponse {
  error: 'blacklisted';
  pattern: string;
}

export interface PageStatusResponse {
  page_id: string;
  status: PageStatus;
  last_error: string | null;
  features?: {
    entities?: { status: string; last_error: string | null };
  };
}

export interface PageResponse {
  page_id: string;
  canonical_url: string;
  original_url: string;
  domain: string;
  title: string | null;
  body_text: string | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
  visit_count: number;
  indexed_at: string | null;
  status: PageStatus;
}

export interface BlacklistEntry {
  id: string;
  pattern: string;
  kind: 'url' | 'domain';
  reason: string | null;
  created_at: string;
}

export interface BlacklistResponse {
  entries: BlacklistEntry[];
}

export interface ForgetResponse {
  blacklist_id: string;
  pattern: string;
  kind: 'url' | 'domain';
  pages_purged: number;
  vector_deletes_queued: number;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'dead';

export interface JobRow {
  id: string;
  kind: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  page_id?: string | null;
}

export interface JobListResponse {
  jobs: JobRow[];
}

// ── Client result union for POST /v1/pages ───────────────────────────────

export type IngestOutcome =
  | { kind: 'accepted'; body: IngestAcceptedResponse }
  | { kind: 'revisit'; body: IngestRevisitResponse }
  | { kind: 'blacklisted'; body: BlacklistedResponse }
  | { kind: 'invalid'; detail: string } // 422
  | { kind: 'no_extraction' } // 501 — body_html unsupported
  | { kind: 'unauthorized' } // 401
  | { kind: 'network_error'; message: string }
  | { kind: 'server_error'; httpStatus: number; message: string };

// ── Internal: capture payload built by the content script ────────────────

export type CaptureTrigger = 'load' | 'spa' | 'manual';

export interface CapturePayload {
  url: string;
  title: string | null;
  /** Sanitized HTML, or null when URL-only (PDF / oversize / fallback). */
  bodyHtml: string | null;
  bodyBytes: number;
  fetchedAt: string; // aware ISO-8601
  trigger: CaptureTrigger;
  referrer: string | null;
  favicon: string | null;
  /** Client-side canonical key used for local cooldown throttling. */
  canonicalKey: string;
}

// ── Internal: durable queue item ─────────────────────────────────────────

export interface QueueItem {
  /** Auto-increment insertion order key (assigned by IndexedDB). */
  _seq?: number;
  id: string; // local uuid
  payload: CapturePayload;
  /** How many times we've attempted to POST this item. */
  attempts: number;
  enqueuedAt: number; // epoch ms
  nextAttemptAt: number; // epoch ms — backoff gate
  /** True after a 501: resend without body (URL-only). */
  forceUrlOnly: boolean;
}

// ── Internal: recent-activity record surfaced in the popup ───────────────

export type RecentState =
  | 'queued'
  | 'sending'
  | 'indexing'
  | 'indexed'
  | 'revisit'
  | 'blacklisted'
  | 'failed'
  | 'dead'
  | 'error';

export interface RecentEntry {
  localId: string;
  url: string;
  domain: string;
  title: string | null;
  state: RecentState;
  pageId: string | null;
  contentChanged?: boolean;
  lastError?: string | null;
  updatedAt: number;
}

// ── Messaging between content script / popup / options and worker ─────────

export type RuntimeMessage =
  | { type: 'shouldCapture'; url: string }
  | { type: 'capture'; payload: CapturePayload }
  | { type: 'getState' }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'forgetDomain'; domain: string; reason?: string }
  | { type: 'forgetUrl'; url: string; reason?: string }
  | { type: 'listBlacklist' }
  | { type: 'deleteBlacklist'; id: string }
  | { type: 'retryDead'; localId: string }
  | { type: 'testConnection' }
  | { type: 'settingsChanged' };

export interface ShouldCaptureReply {
  capture: boolean;
  reason?: string;
}

// Minimal in-memory mock of the Refindery upstream API for local E2E testing.
// NOT production code — just enough to exercise the extension's ingest,
// status-polling, forget/blacklist, and dead-retry paths.
//
//   REFINDERY_AUTH_TOKEN=test-token node mock-server/index.mjs
//
// Fixture behaviors (by URL substring):
//   "no-extract"  → 501 when body_html is sent (forces URL-only fallback)
//   "will-die"    → indexing job goes to `dead` (retry via jobs API → indexed)
// Everything else: 202 → queued → indexing → indexed over ~4s.

import http from 'node:http';
import crypto from 'node:crypto';

const TOKEN = process.env.REFINDERY_AUTH_TOKEN || 'test-token';
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const NOT_READY = process.env.MOCK_NOT_READY === '1';

/** @type {Map<string, any>} canonical_url → page */
const pages = new Map();
/** @type {Array<{id,pattern,kind,reason,created_at}>} */
const blacklist = [];
/** @type {Map<string, any>} job_id → job */
const jobs = new Map();

const now = () => new Date().toISOString();

function canonical(url) {
  try {
    const u = new URL(url);
    // Snapshot keys because deleting from URLSearchParams during live iteration
    // can skip adjacent tracking parameters.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || ['fbclid', 'gclid', 'ref', 'si'].includes(k.toLowerCase())) {
        u.searchParams.delete(k);
      }
    }
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isBlacklisted(url) {
  const host = domainOf(url);
  const canon = canonical(url);
  for (const b of blacklist) {
    if (b.kind === 'domain' && (host === b.pattern || host.endsWith('.' + b.pattern))) return b;
    if (b.kind === 'url' && canonical(b.pattern) === canon) return b;
  }
  return null;
}

function hash(s) {
  return crypto
    .createHash('sha256')
    .update(s || '')
    .digest('hex');
}

function send(res, code, body) {
  const data = body == null ? '' : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

function authed(req) {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

/** Advance a page's lifecycle based on elapsed time. */
function statusOf(page) {
  const elapsed = Date.now() - page._createdMs;
  if (page._willDie) {
    return elapsed < 3000 ? (elapsed < 1500 ? 'queued' : 'indexing') : page._status;
  }
  if (elapsed < 1500) return 'queued';
  if (elapsed < 3500) return 'indexing';
  return 'indexed';
}

function findPageById(pageId) {
  return [...pages.values()].find((page) => page.page_id === pageId);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // ── unauthenticated health ──
  if (path === '/healthz') return send(res, 200, { status: 'ok' });
  if (path === '/readyz') {
    return NOT_READY
      ? send(res, 503, { status: 'not ready', reason: 'no active embedding model' })
      : send(res, 200, { status: 'ready' });
  }

  // ── everything else requires auth ──
  if (!authed(req)) return send(res, 401, { detail: 'missing or invalid bearer token' });

  // POST /v1/pages
  if (path === '/v1/pages' && method === 'POST') {
    const body = await readBody(req);
    if (!body) return send(res, 422, { detail: 'invalid json' });
    if (body.body_extracted && body.body_html) {
      return send(res, 422, { detail: 'body_extracted and body_html are mutually exclusive' });
    }
    if (!body.url || !/^https?:\/\//.test(body.url)) {
      return send(res, 422, { detail: 'url must have a scheme and host' });
    }
    const bl = isBlacklisted(body.url);
    if (bl) return send(res, 403, { error: 'blacklisted', pattern: bl.pattern });

    if (/no-extract/.test(body.url) && body.body_html) {
      return send(res, 501, { detail: 'extraction unavailable' });
    }

    const canon = canonical(body.url);
    const contentHash = hash(body.body_html || body.body_extracted || '');
    const existing = pages.get(canon);
    if (existing) {
      existing.visit_count += 1;
      existing.last_seen_at = body.fetched_at || now();
      return send(res, 200, {
        page_id: existing.page_id,
        status: statusOf(existing),
        revisit: true,
        content_hash_differs:
          Boolean(body.body_html || body.body_extracted) && contentHash !== existing._contentHash,
      });
    }

    const willDie = /will-die/.test(body.url);
    const page = {
      page_id: 'pg_' + crypto.randomBytes(6).toString('hex'),
      canonical_url: canon,
      original_url: body.url,
      domain: domainOf(body.url),
      title: body.title ?? null,
      body_text: body.body_html || body.body_extracted || null,
      source: body.source ?? null,
      metadata: body.metadata ?? null,
      first_seen_at: body.fetched_at || now(),
      last_seen_at: body.fetched_at || now(),
      visit_count: 1,
      indexed_at: null,
      _contentHash: contentHash,
      _createdMs: Date.now(),
      _willDie: willDie,
      _status: willDie ? 'dead' : 'indexed',
      _lastError: willDie ? 'simulated indexing failure' : null,
    };
    pages.set(canon, page);

    if (willDie) {
      const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
      jobs.set(jobId, {
        id: jobId,
        kind: 'index_page',
        status: 'dead',
        attempts: 3,
        max_attempts: 3,
        last_error: 'simulated indexing failure',
        created_at: now(),
        updated_at: now(),
        page_id: page.page_id,
        _canon: canon,
      });
    }
    return send(res, 202, { page_id: page.page_id, status: 'queued' });
  }

  // GET /v1/pages/:id/status
  const statusMatch = path.match(/^\/v1\/pages\/([^/]+)\/status$/);
  if (statusMatch && method === 'GET') {
    const page = findPageById(statusMatch[1]);
    if (!page) return send(res, 404, { detail: 'unknown page' });
    const st = statusOf(page);
    return send(res, 200, {
      page_id: page.page_id,
      status: st,
      last_error: st === 'dead' ? page._lastError : null,
      features: {
        entities: { status: st === 'indexed' ? 'done' : 'not_queued', last_error: null },
      },
    });
  }

  // GET /v1/pages/:id
  const pageMatch = path.match(/^\/v1\/pages\/([^/]+)$/);
  if (pageMatch && method === 'GET') {
    const page = findPageById(pageMatch[1]);
    if (!page) return send(res, 404, { detail: 'unknown page' });
    const status = statusOf(page);
    // Mock-only shortcut: lazily backfill indexed_at on first read since this
    // server has no real indexing pipeline that would stamp it.
    if (status === 'indexed' && page.indexed_at == null) page.indexed_at = now();
    const { _contentHash, _createdMs, _willDie, _status, _lastError, ...pageOut } = page;
    return send(res, 200, { ...pageOut, status });
  }

  // POST /v1/forget
  if (path === '/v1/forget' && method === 'POST') {
    const body = await readBody(req);
    const hasUrl = !!body?.url;
    const hasDomain = !!body?.domain;
    if (hasUrl === hasDomain)
      return send(res, 422, { detail: 'provide exactly one of url or domain' });
    const kind = hasUrl ? 'url' : 'domain';
    const pattern = hasUrl ? canonical(body.url) : body.domain;
    const entry = {
      id: 'bl_' + crypto.randomBytes(5).toString('hex'),
      pattern,
      kind,
      reason: body.reason ?? null,
      created_at: now(),
    };
    blacklist.unshift(entry);
    let purged = 0;
    for (const [canon, p] of pages.entries()) {
      const match =
        kind === 'domain'
          ? p.domain === pattern || p.domain.endsWith('.' + pattern)
          : canon === pattern;
      if (match) {
        pages.delete(canon);
        purged++;
      }
    }
    return send(res, 200, {
      blacklist_id: entry.id,
      pattern,
      kind,
      pages_purged: purged,
      vector_deletes_queued: purged,
    });
  }

  // GET /v1/blacklist
  if (path === '/v1/blacklist' && method === 'GET') {
    return send(res, 200, { entries: blacklist });
  }

  // DELETE /v1/blacklist/:id
  const blMatch = path.match(/^\/v1\/blacklist\/([^/]+)$/);
  if (blMatch && method === 'DELETE') {
    const i = blacklist.findIndex((b) => b.id === blMatch[1]);
    if (i < 0) return send(res, 404, { detail: 'unknown rule' });
    blacklist.splice(i, 1);
    res.writeHead(204);
    return res.end();
  }

  // GET /v1/jobs
  if (path === '/v1/jobs' && method === 'GET') {
    const filter = url.searchParams.get('status_filter');
    const requestedLimit = url.searchParams.get('limit');
    let list = [...jobs.values()];
    if (filter) list = list.filter((j) => j.status === filter);
    if (requestedLimit !== null) {
      const limit = Number.parseInt(requestedLimit, 10);
      if (Number.isFinite(limit) && limit >= 0) list = list.slice(0, limit);
    }
    return send(res, 200, { jobs: list.map(({ _canon, ...j }) => j) });
  }

  // POST /v1/jobs/:id/retry
  const retryMatch = path.match(/^\/v1\/jobs\/([^/]+)\/retry$/);
  if (retryMatch && method === 'POST') {
    const job = jobs.get(retryMatch[1]);
    if (!job) return send(res, 404, { detail: 'unknown job' });
    if (job.status !== 'dead') return send(res, 409, { detail: 'only dead jobs are retryable' });
    job.status = 'pending';
    job.updated_at = now();
    // On retry, let the page succeed this time.
    const page = pages.get(job._canon);
    if (page) {
      page._willDie = false;
      page._status = 'indexed';
      page._createdMs = Date.now();
    }
    return send(res, 200, { ...job, _canon: undefined });
  }

  return send(res, 404, { detail: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`mock refindery on http://${HOST}:${PORT} (token: ${TOKEN})`);
});

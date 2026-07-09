// Typed HTTP client for the Refindery upstream ingest/lifecycle API.
// Every method takes the resolved base URL + bearer token so it stays testable
// and stateless.

import { endpoint } from '@/common/settings';
import type {
  BlacklistResponse,
  ForgetRequest,
  ForgetResponse,
  IngestPageRequest,
  IngestOutcome,
  JobListResponse,
  JobRow,
  PageStatusResponse,
} from '@/common/types';

export interface ServerConfig {
  baseUrl: string;
  token: string;
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/** GET /readyz — unauthenticated. Returns true when 200 ready. */
export async function isReady(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(endpoint(baseUrl, '/readyz'), {
      method: 'GET',
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** POST /v1/pages — the core ingest call. Never throws; returns an outcome. */
export async function postPage(
  cfg: ServerConfig,
  req: IngestPageRequest,
): Promise<IngestOutcome> {
  let res: Response;
  try {
    res = await fetch(endpoint(cfg.baseUrl, '/v1/pages'), {
      method: 'POST',
      headers: authHeaders(cfg.token),
      body: JSON.stringify(req),
    });
  } catch (e) {
    return { kind: 'network_error', message: String((e as Error)?.message ?? e) };
  }

  if (res.status === 202) {
    return { kind: 'accepted', body: await res.json() };
  }
  if (res.status === 200) {
    return { kind: 'revisit', body: await res.json() };
  }
  if (res.status === 403) {
    return { kind: 'blacklisted', body: await safeJson(res) };
  }
  if (res.status === 401) {
    return { kind: 'unauthorized' };
  }
  if (res.status === 422) {
    const body = await safeJson(res);
    return { kind: 'invalid', detail: body?.detail ?? 'unprocessable' };
  }
  if (res.status === 501) {
    return { kind: 'no_extraction' };
  }
  return {
    kind: 'server_error',
    httpStatus: res.status,
    message: await res.text().catch(() => ''),
  };
}

/** GET /v1/pages/{id}/status */
export async function getStatus(
  cfg: ServerConfig,
  pageId: string,
): Promise<PageStatusResponse | null> {
  try {
    const res = await fetch(
      endpoint(cfg.baseUrl, `/v1/pages/${encodeURIComponent(pageId)}/status`),
      { headers: authHeaders(cfg.token) },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** POST /v1/forget — destructive purge + blacklist. */
export async function forget(
  cfg: ServerConfig,
  req: ForgetRequest,
): Promise<ForgetResponse> {
  const res = await fetch(endpoint(cfg.baseUrl, '/v1/forget'), {
    method: 'POST',
    headers: authHeaders(cfg.token),
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`forget failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** GET /v1/blacklist */
export async function listBlacklist(
  cfg: ServerConfig,
): Promise<BlacklistResponse> {
  const res = await fetch(endpoint(cfg.baseUrl, '/v1/blacklist'), {
    headers: authHeaders(cfg.token),
  });
  if (!res.ok) throw new Error(`blacklist list failed: ${res.status}`);
  return res.json();
}

/** DELETE /v1/blacklist/{id} → 204 */
export async function deleteBlacklist(
  cfg: ServerConfig,
  id: string,
): Promise<void> {
  const res = await fetch(
    endpoint(cfg.baseUrl, `/v1/blacklist/${encodeURIComponent(id)}`),
    { method: 'DELETE', headers: authHeaders(cfg.token) },
  );
  if (res.status !== 204 && res.status !== 200) {
    throw new Error(`blacklist delete failed: ${res.status}`);
  }
}

/** GET /v1/jobs?status_filter=&limit= */
export async function listJobs(
  cfg: ServerConfig,
  opts: { status?: string; limit?: number } = {},
): Promise<JobListResponse> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status_filter', opts.status);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const res = await fetch(
    endpoint(cfg.baseUrl, `/v1/jobs${qs ? '?' + qs : ''}`),
    { headers: authHeaders(cfg.token) },
  );
  if (!res.ok) throw new Error(`jobs list failed: ${res.status}`);
  return res.json();
}

/** POST /v1/jobs/{id}/retry — only valid for dead jobs (409 otherwise). */
export async function retryJob(
  cfg: ServerConfig,
  jobId: string,
): Promise<JobRow> {
  const res = await fetch(
    endpoint(cfg.baseUrl, `/v1/jobs/${encodeURIComponent(jobId)}/retry`),
    { method: 'POST', headers: authHeaders(cfg.token) },
  );
  if (!res.ok) throw new Error(`job retry failed: ${res.status}`);
  return res.json();
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

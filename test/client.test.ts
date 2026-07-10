import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deleteBlacklist,
  forget,
  getStatus,
  isReady,
  listBlacklist,
  listJobs,
  postPage,
  REQUEST_TIMEOUT_MS,
  retryJob,
} from '@/background/client';
import type { IngestPageRequest } from '@/common/types';

const cfg = { baseUrl: 'http://127.0.0.1:8000', token: 't' };
const req: IngestPageRequest = { url: 'https://ex.com/a' };

function fakeRes(status: number, json?: any, text = ''): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => json,
    text: async () => text,
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('postPage outcome mapping', () => {
  it('202 → accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(202, { page_id: 'pg_1', status: 'queued' })),
    );
    const out = await postPage(cfg, req);
    expect(out).toEqual({ kind: 'accepted', body: { page_id: 'pg_1', status: 'queued' } });
  });

  it('200 → revisit with content_hash_differs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeRes(200, {
          page_id: 'pg_1',
          status: 'indexed',
          revisit: true,
          content_hash_differs: true,
        }),
      ),
    );
    const out = await postPage(cfg, req);
    expect(out).toEqual({
      kind: 'revisit',
      body: {
        page_id: 'pg_1',
        status: 'indexed',
        revisit: true,
        content_hash_differs: true,
      },
    });
  });

  it('403 → blacklisted with pattern', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(403, { error: 'blacklisted', pattern: 'ex.com' })),
    );
    const out = await postPage(cfg, req);
    expect(out).toEqual({
      kind: 'blacklisted',
      body: { error: 'blacklisted', pattern: 'ex.com' },
    });
  });

  it('401 → unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(401, { detail: 'bad token' })),
    );
    expect((await postPage(cfg, req)).kind).toBe('unauthorized');
  });

  it('422 → invalid with detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(422, { detail: 'bad url' })),
    );
    const out = await postPage(cfg, req);
    expect(out).toEqual({ kind: 'invalid', detail: 'bad url' });
  });

  it('501 → no_extraction', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(501, { detail: 'unavailable' })),
    );
    expect((await postPage(cfg, req)).kind).toBe('no_extraction');
  });

  it('500 → server_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(500, undefined, 'boom')),
    );
    const out = await postPage(cfg, req);
    expect(out.kind).toBe('server_error');
  });

  it('thrown fetch → network_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = await postPage(cfg, req);
    expect(out).toEqual({ kind: 'network_error', message: 'ECONNREFUSED' });
  });

  it.each([
    [202, {}],
    [200, { page_id: 'pg_1', status: 'indexed' }],
    [403, { error: 'blacklisted' }],
  ])('maps malformed %s bodies to server_error', async (status, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(status, body)),
    );
    const out = await postPage(cfg, req);
    expect(out).toMatchObject({
      kind: 'server_error',
      httpStatus: status,
      message: 'malformed upstream response body',
    });
  });

  it('aborts a stalled ingest request at the shared timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );

    const outcome = postPage(cfg, req);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    expect(await outcome).toMatchObject({ kind: 'network_error', message: 'aborted' });
  });
});

describe('lifecycle client methods', () => {
  it('reports server readiness and treats request failures as not ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(200)),
    );
    await expect(isReady(cfg.baseUrl)).resolves.toBe(true);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(503)),
    );
    await expect(isReady(cfg.baseUrl)).resolves.toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(isReady(cfg.baseUrl)).resolves.toBe(false);
  });

  it('reads page status and returns null for HTTP or network failures', async () => {
    const status = { page_id: 'page/1', status: 'indexed', last_error: null };
    const fetchMock = vi.fn(async () => fakeRes(200, status));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStatus(cfg, 'page/1')).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/pages/page%2F1/status',
      expect.objectContaining({ headers: expect.any(Object) }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(404)),
    );
    await expect(getStatus(cfg, 'missing')).resolves.toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(getStatus(cfg, 'page-1')).resolves.toBeNull();
  });

  it('forgets pages and reports non-success responses', async () => {
    const response = {
      blacklist_id: 'blacklist-1',
      pattern: 'example.com',
      kind: 'domain',
      pages_purged: 2,
      vector_deletes_queued: 2,
    };
    const fetchMock = vi.fn(async () => fakeRes(200, response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(forget(cfg, { domain: 'example.com' })).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/forget',
      expect.objectContaining({ method: 'POST', body: '{"domain":"example.com"}' }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(500, undefined, 'boom')),
    );
    await expect(forget(cfg, { domain: 'example.com' })).rejects.toThrow('forget failed: 500 boom');
  });

  it('lists and deletes blacklist entries', async () => {
    const list = { entries: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(200, list)),
    );
    await expect(listBlacklist(cfg)).resolves.toEqual(list);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(401)),
    );
    await expect(listBlacklist(cfg)).rejects.toThrow('blacklist list failed: 401');

    const fetchMock = vi.fn(async () => fakeRes(204));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteBlacklist(cfg, 'rule/1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/blacklist/rule%2F1',
      expect.objectContaining({ method: 'DELETE' }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(500)),
    );
    await expect(deleteBlacklist(cfg, 'rule-1')).rejects.toThrow('blacklist delete failed: 500');
  });

  it('lists filtered jobs and retries dead jobs', async () => {
    const jobs = { jobs: [] };
    const listFetch = vi.fn(async () => fakeRes(200, jobs));
    vi.stubGlobal('fetch', listFetch);
    await expect(listJobs(cfg, { status: 'dead', limit: 10 })).resolves.toEqual(jobs);
    expect(listFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/v1/jobs?status_filter=dead&limit=10',
      expect.any(Object),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(500)),
    );
    await expect(listJobs(cfg)).rejects.toThrow('jobs list failed: 500');

    const job = {
      id: 'job-1',
      kind: 'index_page',
      status: 'pending',
      attempts: 0,
      max_attempts: 3,
      last_error: null,
      created_at: '2026-07-09T12:00:00Z',
      updated_at: '2026-07-09T12:00:00Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(200, job)),
    );
    await expect(retryJob(cfg, 'job/1')).resolves.toEqual(job);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes(409)),
    );
    await expect(retryJob(cfg, 'job-1')).rejects.toThrow('job retry failed: 409');
  });
});

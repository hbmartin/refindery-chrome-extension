import { describe, it, expect, vi, afterEach } from 'vitest';
import { postPage } from '@/background/client';
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

afterEach(() => vi.unstubAllGlobals());

describe('postPage outcome mapping', () => {
  it('202 → accepted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(202, { page_id: 'pg_1', status: 'queued' })));
    const out = await postPage(cfg, req);
    expect(out.kind).toBe('accepted');
    if (out.kind === 'accepted') expect(out.body.page_id).toBe('pg_1');
  });

  it('200 → revisit with content_hash_differs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(200, { page_id: 'pg_1', status: 'indexed', revisit: true, content_hash_differs: true })));
    const out = await postPage(cfg, req);
    expect(out.kind).toBe('revisit');
    if (out.kind === 'revisit') expect(out.body.content_hash_differs).toBe(true);
  });

  it('403 → blacklisted with pattern', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(403, { error: 'blacklisted', pattern: 'ex.com' })));
    const out = await postPage(cfg, req);
    expect(out.kind).toBe('blacklisted');
    if (out.kind === 'blacklisted') expect(out.body.pattern).toBe('ex.com');
  });

  it('401 → unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(401, { detail: 'bad token' })));
    expect((await postPage(cfg, req)).kind).toBe('unauthorized');
  });

  it('422 → invalid with detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(422, { detail: 'bad url' })));
    const out = await postPage(cfg, req);
    expect(out.kind).toBe('invalid');
    if (out.kind === 'invalid') expect(out.detail).toBe('bad url');
  });

  it('501 → no_extraction', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(501, { detail: 'unavailable' })));
    expect((await postPage(cfg, req)).kind).toBe('no_extraction');
  });

  it('500 → server_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(500, undefined, 'boom')));
    const out = await postPage(cfg, req);
    expect(out.kind).toBe('server_error');
  });

  it('thrown fetch → network_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const out = await postPage(cfg, req);
    expect(out.kind).toBe('network_error');
    if (out.kind === 'network_error') expect(out.message).toContain('ECONNREFUSED');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageStatusResponse } from '@/common/types';

vi.mock('@/background/client', () => ({
  getStatus: vi.fn(),
  listJobs: vi.fn(),
  retryJob: vi.fn(),
}));
vi.mock('@/background/recent', () => ({
  getRecent: vi.fn(async () => []),
  upsertRecent: vi.fn(async () => undefined),
}));
vi.mock('@/background/notify', () => ({
  notifyDead: vi.fn(async () => undefined),
}));

import { getStatus } from '@/background/client';
import { pollDue, trackPage } from '@/background/poller';
import { upsertRecent } from '@/background/recent';
import { notifyDead } from '@/background/notify';

const cfg = { baseUrl: 'http://127.0.0.1:8000', token: 'token' };
let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.clearAllMocks();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(storage[key]) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storage, structuredClone(values));
        }),
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('pending poll serialization', () => {
  it('preserves concurrent trackPage additions', async () => {
    await Promise.all([trackPage('local-1', 'page-1'), trackPage('local-2', 'page-2')]);

    expect(storage.pending).toEqual([
      expect.objectContaining({ localId: 'local-1', pageId: 'page-1' }),
      expect.objectContaining({ localId: 'local-2', pageId: 'page-2' }),
    ]);
  });

  it('does not lose a page tracked while pollDue is running', async () => {
    storage.pending = [{ localId: 'local-1', pageId: 'page-1', pollCount: 0, nextPollAt: 0 }];
    let resolveStatus!: (status: PageStatusResponse | null) => void;
    vi.mocked(getStatus).mockReturnValueOnce(
      new Promise<PageStatusResponse | null>((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const polling = pollDue(cfg);
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledOnce());
    // trackPage must complete while the status request is still in flight —
    // the pending lock is not held across network calls.
    await trackPage('local-2', 'page-2');
    resolveStatus({
      page_id: 'page-1',
      status: 'indexing',
      last_error: null,
    });
    await polling;

    expect(storage.pending).toEqual([
      expect.objectContaining({ localId: 'local-1', pollCount: 1 }),
      expect.objectContaining({ localId: 'local-2', pageId: 'page-2' }),
    ]);
  });

  it('preserves a retry tracked while a terminal poll is finishing', async () => {
    storage.pending = [{ localId: 'local-1', pageId: 'page-1', pollCount: 2, nextPollAt: 0 }];
    vi.mocked(getStatus).mockResolvedValueOnce({
      page_id: 'page-1',
      status: 'dead',
      last_error: 'indexing failed',
    });
    let finishNotification!: () => void;
    vi.mocked(notifyDead).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishNotification = resolve;
      }),
    );

    const polling = pollDue(cfg);
    await vi.waitFor(() => expect(notifyDead).toHaveBeenCalledOnce());

    await trackPage('local-1', 'page-1');
    finishNotification();
    await polling;

    expect(storage.pending).toEqual([
      expect.objectContaining({
        localId: 'local-1',
        pageId: 'page-1',
        pollCount: 0,
        revision: 1,
      }),
    ]);
  });

  it('clears stale errors while a page is still indexing', async () => {
    storage.pending = [{ localId: 'local-1', pageId: 'page-1', pollCount: 0, nextPollAt: 0 }];
    vi.mocked(getStatus).mockResolvedValueOnce({
      page_id: 'page-1',
      status: 'indexing',
      last_error: null,
    });

    await pollDue(cfg);

    expect(upsertRecent).toHaveBeenCalledWith({
      localId: 'local-1',
      state: 'indexing',
      lastError: null,
    });
  });
});

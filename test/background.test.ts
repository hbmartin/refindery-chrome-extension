import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestOutcome, QueueItem, RuntimeMessage } from '@/common/types';
import { DEFAULT_SETTINGS } from '@/common/settings';

vi.mock('@/common/settings', async () => {
  const actual = await vi.importActual<typeof import('@/common/settings')>('@/common/settings');
  return { ...actual, getSettings: vi.fn(), setSettings: vi.fn() };
});
vi.mock('@/background/client', () => ({
  deleteBlacklist: vi.fn(),
  forget: vi.fn(),
  isReady: vi.fn(),
  listBlacklist: vi.fn(),
  postPage: vi.fn(),
}));
vi.mock('@/background/queue', () => ({
  all: vi.fn(),
  clear: vi.fn(),
  count: vi.fn(),
  due: vi.fn(),
  enqueue: vi.fn(),
  releaseBackoffs: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/background/poller', () => ({
  pendingCount: vi.fn(),
  pollDue: vi.fn(),
  retryDeadPage: vi.fn(),
  trackPage: vi.fn(),
}));
vi.mock('@/background/recent', () => ({
  getRecent: vi.fn(),
  updateBadge: vi.fn(),
  upsertRecent: vi.fn(),
}));
vi.mock('@/background/notify', () => ({
  notifyServerDown: vi.fn(),
}));

import { getSettings, setSettings } from '@/common/settings';
import { deleteBlacklist, forget, isReady, listBlacklist, postPage } from '@/background/client';
import * as queue from '@/background/queue';
import { notifyServerDown } from '@/background/notify';
import { pendingCount, pollDue, retryDeadPage, trackPage } from '@/background/poller';
import { getRecent, updateBadge, upsertRecent } from '@/background/recent';
import { drainQueue, handleMessage, registerMessageListener, tick } from '@/background/index';

let storage: Record<string, unknown>;
let messageListener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] | undefined;

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'local-1',
    payload: {
      url: 'https://example.com/article',
      title: 'Article',
      bodyHtml: '<main>Article</main>',
      bodyBytes: 20,
      fetchedAt: '2026-07-09T12:00:00Z',
      trigger: 'load',
      referrer: null,
      favicon: null,
      canonicalKey: 'https://example.com/article',
    },
    attempts: 0,
    enqueuedAt: 1,
    nextAttemptAt: 1,
    forceUrlOnly: false,
    ...overrides,
  };
}

beforeEach(() => {
  storage = {};
  messageListener = undefined;
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue({
    ...DEFAULT_SETTINGS,
    token: 'token',
  });
  vi.mocked(queue.due).mockResolvedValue([]);
  vi.mocked(queue.count).mockResolvedValue(0);
  vi.mocked(isReady).mockResolvedValue(true);
  vi.mocked(pollDue).mockResolvedValue(false);
  vi.mocked(getRecent).mockResolvedValue([]);
  vi.mocked(updateBadge).mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(storage[key]) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storage, structuredClone(values));
        }),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((listener: typeof messageListener) => {
          messageListener = listener;
        }),
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('drainQueue', () => {
  it('does not probe readiness when no item is due', async () => {
    expect(await drainQueue()).toBe(true);
    expect(isReady).not.toHaveBeenCalled();
  });

  it('stops when the server is not ready', async () => {
    vi.mocked(queue.due).mockResolvedValueOnce([item()]);
    vi.mocked(isReady).mockResolvedValueOnce(false);

    expect(await drainQueue()).toBe(false);
    expect(notifyServerDown).toHaveBeenCalledOnce();
    expect(postPage).not.toHaveBeenCalled();
  });

  it('handles accepted pages', async () => {
    vi.mocked(queue.due).mockResolvedValueOnce([item()]);
    vi.mocked(postPage).mockResolvedValueOnce({
      kind: 'accepted',
      body: { page_id: 'page-1', status: 'queued' },
    });

    expect(await drainQueue()).toBe(true);
    expect(trackPage).toHaveBeenCalledWith('local-1', 'page-1');
    expect(queue.remove).toHaveBeenCalledWith('local-1');
    expect(upsertRecent).toHaveBeenCalledWith(
      expect.objectContaining({ localId: 'local-1', state: 'queued', pageId: 'page-1' }),
    );
    expect(storage.cooldown).toEqual({ 'https://example.com/article': expect.any(Number) });
  });

  it('handles revisits and tracks nonterminal states', async () => {
    vi.mocked(queue.due).mockResolvedValueOnce([item()]);
    vi.mocked(postPage).mockResolvedValueOnce({
      kind: 'revisit',
      body: {
        page_id: 'page-1',
        status: 'indexing',
        revisit: true,
        content_hash_differs: true,
      },
    });

    await drainQueue();

    expect(upsertRecent).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'indexing', contentChanged: true }),
    );
    expect(trackPage).toHaveBeenCalledWith('local-1', 'page-1');
  });

  it('handles blacklisted pages without retrying', async () => {
    vi.mocked(queue.due).mockResolvedValueOnce([item()]);
    vi.mocked(postPage).mockResolvedValueOnce({
      kind: 'blacklisted',
      body: { error: 'blacklisted', pattern: 'example.com' },
    });

    await drainQueue();

    expect(storage.blocked403).toEqual(['example.com']);
    expect(queue.remove).toHaveBeenCalledWith('local-1');
    expect(upsertRecent).toHaveBeenCalledWith(expect.objectContaining({ state: 'blacklisted' }));
  });

  it('retries no_extraction once as URL-only, then records an error', async () => {
    const first = item();
    const second = item({ forceUrlOnly: true });
    vi.mocked(queue.due).mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
    vi.mocked(postPage)
      .mockResolvedValueOnce({ kind: 'no_extraction' })
      .mockResolvedValueOnce({ kind: 'no_extraction' });

    await drainQueue();
    expect(queue.update).toHaveBeenCalledWith(expect.objectContaining({ forceUrlOnly: true }));

    await drainQueue();
    expect(queue.remove).toHaveBeenCalledWith('local-1');
    expect(upsertRecent).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'error', lastError: 'no extraction path' }),
    );
  });

  it('drops invalid payloads and preserves the server detail', async () => {
    vi.mocked(queue.due).mockResolvedValueOnce([item()]);
    vi.mocked(postPage).mockResolvedValueOnce({ kind: 'invalid', detail: 'bad payload' });

    await drainQueue();

    expect(queue.remove).toHaveBeenCalledWith('local-1');
    expect(upsertRecent).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'error', lastError: 'bad payload' }),
    );
  });

  it('backs off the whole remaining batch on unauthorized and stops the drain', async () => {
    const first = item();
    const second = item({ id: 'local-2' });
    vi.mocked(queue.due).mockResolvedValueOnce([first, second]);
    vi.mocked(postPage).mockResolvedValueOnce({ kind: 'unauthorized' });

    expect(await drainQueue()).toBe(false);
    // Only one request went out with the bad token; the untried item was
    // backed off too instead of burning a request on the next tick.
    expect(postPage).toHaveBeenCalledOnce();
    for (const queued of [first, second]) {
      expect(queued.attempts).toBe(1);
      expect(queued.nextAttemptAt).toBeGreaterThan(Date.now());
      expect(queue.update).toHaveBeenCalledWith(queued);
    }
    expect(storage.authError).toBe(true);
  });

  it.each(['network_error', 'server_error'] as const)('backs off %s outcomes', async (kind) => {
    const queued = item();
    vi.mocked(queue.due).mockResolvedValueOnce([queued]);
    const outcome: IngestOutcome =
      kind === 'network_error'
        ? { kind, message: 'offline' }
        : { kind, httpStatus: 500, message: 'boom' };
    vi.mocked(postPage).mockResolvedValueOnce(outcome);

    expect(await drainQueue()).toBe(true);
    expect(queued.attempts).toBe(1);
    expect(queue.update).toHaveBeenCalledWith(queued);
    expect(queue.remove).not.toHaveBeenCalled();
  });
});

describe('tick and message orchestration', () => {
  it('does not poll or self-chain while the server is unavailable', async () => {
    vi.mocked(queue.due).mockResolvedValueOnce([item()]);
    vi.mocked(queue.count).mockResolvedValueOnce(1);
    vi.mocked(isReady).mockResolvedValueOnce(false);
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as never);

    await tick();

    expect(pollDue).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(updateBadge).toHaveBeenCalledWith({ queueCount: 1, error: false });
  });

  it('self-chains when ready work remains', async () => {
    vi.mocked(queue.count).mockResolvedValueOnce(1);
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as never);

    await tick();

    expect(pollDue).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('prevents concurrent tick re-entry', async () => {
    const queued = item();
    vi.mocked(queue.due).mockResolvedValue([queued]);
    let resolvePost!: (outcome: IngestOutcome) => void;
    vi.mocked(postPage).mockReturnValueOnce(
      new Promise<IngestOutcome>((resolve) => {
        resolvePost = resolve;
      }),
    );

    const first = tick();
    await vi.waitFor(() => expect(postPage).toHaveBeenCalledOnce());
    await tick();
    expect(postPage).toHaveBeenCalledOnce();

    resolvePost({ kind: 'invalid', detail: 'stop' });
    await first;
  });

  it('releases backoffs after an in-flight old-settings tick before retrying', async () => {
    const queued = item();
    vi.mocked(queue.due).mockResolvedValueOnce([queued]).mockResolvedValueOnce([queued]);
    let resolvePost!: (outcome: IngestOutcome) => void;
    vi.mocked(postPage)
      .mockReturnValueOnce(
        new Promise<IngestOutcome>((resolve) => {
          resolvePost = resolve;
        }),
      )
      .mockResolvedValueOnce({ kind: 'invalid', detail: 'stop' });

    const activeTick = tick();
    await vi.waitFor(() => expect(postPage).toHaveBeenCalledOnce());

    await expect(handleMessage({ type: 'settingsChanged' }, {})).resolves.toEqual({
      ok: true,
    });
    expect(queue.releaseBackoffs).not.toHaveBeenCalled();

    resolvePost({ kind: 'unauthorized' });
    await activeTick;

    expect(queue.releaseBackoffs).toHaveBeenCalledOnce();
    expect(postPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(queue.releaseBackoffs).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(queue.update).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(postPage).mock.invocationCallOrder[1]).toBeGreaterThan(
      vi.mocked(queue.releaseBackoffs).mock.invocationCallOrder[0],
    );
  });

  it('always responds when asynchronous message handling rejects', async () => {
    registerMessageListener();
    vi.mocked(queue.enqueue).mockRejectedValueOnce(new Error('database unavailable'));
    const sendResponse = vi.fn();
    const message: RuntimeMessage = { type: 'capture', payload: item().payload };

    expect(messageListener?.(message, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: 'database unavailable',
      });
    });
  });

  it('releases queue backoffs when settings change', async () => {
    await expect(handleMessage({ type: 'settingsChanged' }, {})).resolves.toEqual({
      ok: true,
    });
    await vi.waitFor(() => expect(queue.releaseBackoffs).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(updateBadge).toHaveBeenCalled());
  });

  it('persists and retries a failed backoff release on the next tick', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(queue.releaseBackoffs)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(handleMessage({ type: 'settingsChanged' }, {})).resolves.toEqual({
      ok: true,
    });
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
    expect(queue.releaseBackoffs).toHaveBeenCalledOnce();
    expect(updateBadge).not.toHaveBeenCalled();
    expect(storage.releaseBackoffsRequest).toEqual(expect.any(String));
    expect(storage.releaseBackoffsHandled).toBeUndefined();

    // The next maintenance tick, including one in a restarted worker, reads
    // the durable request and retries rather than dropping it.
    await tick();

    expect(queue.releaseBackoffs).toHaveBeenCalledTimes(2);
    expect(updateBadge).toHaveBeenCalled();
    expect(storage.releaseBackoffsHandled).toBe(storage.releaseBackoffsRequest);
  });

  it('does not acknowledge a newer backoff-release request', async () => {
    let finishFirstRelease!: () => void;
    vi.mocked(queue.releaseBackoffs)
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishFirstRelease = resolve;
        }),
      )
      .mockResolvedValueOnce(undefined);

    await expect(handleMessage({ type: 'settingsChanged' }, {})).resolves.toEqual({
      ok: true,
    });
    await vi.waitFor(() => expect(queue.releaseBackoffs).toHaveBeenCalledOnce());
    const firstRequest = storage.releaseBackoffsRequest;

    await expect(handleMessage({ type: 'settingsChanged' }, {})).resolves.toEqual({
      ok: true,
    });
    const secondRequest = storage.releaseBackoffsRequest;
    expect(secondRequest).not.toBe(firstRequest);

    finishFirstRelease();

    await vi.waitFor(() => expect(queue.releaseBackoffs).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(storage.releaseBackoffsHandled).toBe(secondRequest);
    });
    await vi.waitFor(() => expect(updateBadge).toHaveBeenCalledTimes(2));
  });

  it('keeps a follow-up timer when a later coalesced pass fails', async () => {
    const queued = item();
    const captured = item({ id: 'local-2' });
    vi.mocked(queue.due)
      .mockResolvedValueOnce([queued])
      .mockRejectedValueOnce(new Error('database unavailable'));
    vi.mocked(queue.count).mockResolvedValueOnce(1);
    vi.mocked(queue.enqueue).mockResolvedValueOnce(captured);
    let resolvePost!: (outcome: IngestOutcome) => void;
    vi.mocked(postPage).mockReturnValueOnce(
      new Promise<IngestOutcome>((resolve) => {
        resolvePost = resolve;
      }),
    );
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as never);

    const activeTick = tick();
    await vi.waitFor(() => expect(postPage).toHaveBeenCalledOnce());
    await expect(
      handleMessage({ type: 'capture', payload: captured.payload }, {}),
    ).resolves.toEqual({ ok: true });

    resolvePost({ kind: 'invalid', detail: 'stop' });
    await expect(activeTick).rejects.toThrow('database unavailable');

    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('clears stale errors when retrying a dead page', async () => {
    vi.mocked(getRecent).mockResolvedValueOnce([
      {
        localId: 'local-1',
        url: 'https://example.com/article',
        domain: 'example.com',
        title: 'Article',
        state: 'dead',
        pageId: 'page-1',
        lastError: 'old failure',
        updatedAt: 1,
      },
    ]);
    vi.mocked(retryDeadPage).mockResolvedValueOnce(true);

    await expect(handleMessage({ type: 'retryDead', localId: 'local-1' }, {})).resolves.toEqual({
      ok: true,
    });

    expect(upsertRecent).toHaveBeenCalledWith({
      localId: 'local-1',
      state: 'queued',
      lastError: null,
    });
    expect(trackPage).toHaveBeenCalledWith('local-1', 'page-1');
  });

  it('routes state reads, pause changes, and incognito capture checks', async () => {
    vi.mocked(queue.count).mockResolvedValueOnce(2);
    vi.mocked(pendingCount).mockResolvedValueOnce(1);

    await expect(handleMessage({ type: 'getState' }, {})).resolves.toMatchObject({
      queueCount: 2,
      pending: 1,
      authError: false,
    });
    await expect(handleMessage({ type: 'setPaused', paused: true }, {})).resolves.toEqual({
      ok: true,
    });
    expect(setSettings).toHaveBeenCalledWith({ paused: true });

    await expect(
      handleMessage({ type: 'shouldCapture', url: 'https://example.com' }, {
        tab: { incognito: true },
      } as chrome.runtime.MessageSender),
    ).resolves.toEqual({ capture: false, reason: 'incognito' });
  });

  it('routes forget and blacklist operations', async () => {
    vi.mocked(forget).mockResolvedValueOnce({
      blacklist_id: 'blacklist-1',
      pattern: 'example.com',
      kind: 'domain',
      pages_purged: 2,
      vector_deletes_queued: 2,
    });
    await expect(
      handleMessage({ type: 'forgetDomain', domain: 'example.com', reason: 'test' }, {}),
    ).resolves.toMatchObject({ ok: true });
    expect(storage.blocked403).toEqual(['example.com']);

    vi.mocked(forget).mockRejectedValueOnce(new Error('forget unavailable'));
    await expect(
      handleMessage({ type: 'forgetUrl', url: 'https://example.com/private' }, {}),
    ).resolves.toEqual({ ok: false, error: 'forget unavailable' });

    vi.mocked(listBlacklist).mockResolvedValueOnce({ entries: [] });
    await expect(handleMessage({ type: 'listBlacklist' }, {})).resolves.toEqual({
      ok: true,
      entries: [],
    });

    vi.mocked(deleteBlacklist).mockResolvedValueOnce(undefined);
    storage.blocked403 = ['example.com'];
    await expect(
      handleMessage({ type: 'deleteBlacklist', id: 'blacklist-1' }, {}),
    ).resolves.toEqual({ ok: true });
    expect(storage.blocked403).toEqual([]);
  });

  it('returns useful failures when configuration or upstream calls are unavailable', async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({ ...DEFAULT_SETTINGS, token: '' });
    await expect(
      handleMessage({ type: 'forgetDomain', domain: 'example.com' }, {}),
    ).resolves.toEqual({ ok: false, error: 'not configured' });

    vi.mocked(listBlacklist).mockRejectedValueOnce(new Error('unauthorized'));
    await expect(handleMessage({ type: 'listBlacklist' }, {})).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
      entries: [],
    });

    vi.mocked(getRecent).mockResolvedValueOnce([]);
    await expect(handleMessage({ type: 'retryDead', localId: 'missing' }, {})).resolves.toEqual({
      ok: false,
      error: 'no page id',
    });
  });

  it('tests readiness and authentication independently', async () => {
    vi.mocked(isReady).mockResolvedValueOnce(true);
    vi.mocked(listBlacklist).mockResolvedValueOnce({ entries: [] });
    await expect(handleMessage({ type: 'testConnection' }, {})).resolves.toEqual({
      ready: true,
      authOk: true,
    });
    expect(storage.authError).toBe(false);

    vi.mocked(isReady).mockResolvedValueOnce(false);
    vi.mocked(listBlacklist).mockRejectedValueOnce(new Error('unauthorized'));
    await expect(handleMessage({ type: 'testConnection' }, {})).resolves.toEqual({
      ready: false,
      authOk: false,
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, getSettings } from '@/common/settings';
import { notifyDead, notifyServerDown } from '@/background/notify';

vi.mock('@/common/settings', async () => {
  const actual = await vi.importActual<typeof import('@/common/settings')>('@/common/settings');
  return { ...actual, getSettings: vi.fn() };
});

const storageGet = vi.fn();
const storageSet = vi.fn();
const createNotification = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  storageGet.mockResolvedValue({});
  storageSet.mockResolvedValue(undefined);
  vi.mocked(getSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
      },
    },
    notifications: {
      create: createNotification,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('desktop notifications', () => {
  it('honors the dead-page preference and includes the failure details', async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      notify: { ...DEFAULT_SETTINGS.notify, onDead: false },
    });
    await notifyDead('https://example.com', 'indexing failed');
    expect(createNotification).not.toHaveBeenCalled();

    await notifyDead('https://example.com', 'indexing failed');
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Refindery: page failed to index',
        message: 'https://example.com\nindexing failed',
      }),
    );
  });

  it('rate-limits server-down notifications and records successful sends', async () => {
    storageGet.mockResolvedValueOnce({
      notifyMeta: { serverDownLastAt: Date.now() },
    });
    await notifyServerDown();
    expect(createNotification).not.toHaveBeenCalled();

    storageGet.mockResolvedValueOnce({
      notifyMeta: { serverDownLastAt: 0 },
    });
    await notifyServerDown();
    expect(storageSet).toHaveBeenCalledWith({
      notifyMeta: { serverDownLastAt: expect.any(Number) },
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Refindery unreachable' }),
    );
  });
});

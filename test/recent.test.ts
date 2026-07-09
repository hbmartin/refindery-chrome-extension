import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecent, upsertRecent } from '@/background/recent';

describe('recent activity', () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({
            [key]: structuredClone(storage[key]),
          })),
          set: vi.fn(async (changes: Record<string, unknown>) => {
            Object.assign(storage, structuredClone(changes));
          }),
        },
      },
    });
  });

  it('preserves concurrent updates to different entries', async () => {
    await Promise.all([
      upsertRecent({ localId: 'a', url: 'https://a.example', state: 'indexed' }),
      upsertRecent({ localId: 'b', url: 'https://b.example', state: 'dead' }),
      upsertRecent({ localId: 'c', url: 'https://c.example', state: 'indexing' }),
    ]);

    const ids = (await getRecent()).map((entry) => entry.localId).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

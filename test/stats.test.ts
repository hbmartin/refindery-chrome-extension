import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStats, recordCapture } from '@/background/stats';
import type { CaptureStats } from '@/common/types';

let storage: Record<string, unknown>;
const today = '2026-01-02';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 2, 12));
  storage = {};
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('capture stats', () => {
  it('formats the local day without relying on locale output', async () => {
    expect(await getStats()).toEqual({ total: 0, today: 0, day: '2026-01-02' });
  });

  it('starts from zero for the current day', async () => {
    expect(await getStats()).toEqual({ total: 0, today: 0, day: today });
  });

  it('increments total and today together', async () => {
    await recordCapture();
    await recordCapture();
    expect(await getStats()).toEqual({ total: 2, today: 2, day: today });
  });

  it('rolls today over to a new calendar day while preserving total', async () => {
    storage.captureStats = { total: 5, today: 4, day: '2000-01-01' } satisfies CaptureStats;

    // Reading on a new day zeroes today but keeps total.
    expect(await getStats()).toEqual({ total: 5, today: 0, day: today });

    await recordCapture();
    expect(await getStats()).toEqual({ total: 6, today: 1, day: today });
  });

  it('serializes concurrent increments without losing any', async () => {
    await Promise.all(Array.from({ length: 10 }, () => recordCapture()));
    expect(await getStats()).toEqual({ total: 10, today: 10, day: today });
  });
});

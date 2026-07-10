// Lightweight capture counters (total + today) surfaced in the popup so the
// user can see the auto-capture is actually working. Persisted in
// chrome.storage.local; writes are serialized so concurrent drains can't lose
// an increment.

import type { CaptureStats } from '@/common/types';
import { browserApi } from '@/common/browser';
import { createMutex } from '@/common/mutex';

const STATS_KEY = 'captureStats';
const statsMutex = createMutex();

/** Local calendar day as YYYY-MM-DD, independent of runtime locale data. */
function todayKey(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function getStats(): Promise<CaptureStats> {
  const raw = await browserApi.storage.local.get(STATS_KEY);
  const stored = raw[STATS_KEY] as CaptureStats | undefined;
  const day = todayKey();
  if (!stored) return { total: 0, today: 0, day };
  // Roll `today` over when the calendar day has advanced since the last write.
  return stored.day === day ? stored : { total: stored.total, today: 0, day };
}

/** Increment both counters by one successful ingest. */
export function recordCapture(): Promise<void> {
  return statsMutex(async () => {
    const current = await getStats();
    const next: CaptureStats = {
      total: current.total + 1,
      today: current.today + 1,
      day: current.day,
    };
    await browserApi.storage.local.set({ [STATS_KEY]: next });
  });
}

// Recent-activity log surfaced in the popup, plus the badge. Persisted in
// chrome.storage.local so it survives service-worker restarts.

import type { RecentEntry } from '@/common/types';
import { MAX_RECENT_ENTRIES } from '@/common/settings';

const RECENT_KEY = 'recent';

// chrome.storage.local has no atomic read-modify-write primitive. Serialize all
// recent-entry writes in this worker so concurrent capture/poll callbacks cannot
// overwrite one another with stale snapshots.
let recentWrite = Promise.resolve();

export async function getRecent(): Promise<RecentEntry[]> {
  const raw = await chrome.storage.local.get(RECENT_KEY);
  return (raw[RECENT_KEY] as RecentEntry[]) ?? [];
}

export function upsertRecent(
  entry: Partial<RecentEntry> & Pick<RecentEntry, 'localId'>,
): Promise<void> {
  const write = recentWrite.then(async () => {
    const list = await getRecent();
    const idx = list.findIndex((e) => e.localId === entry.localId);
    const now = Date.now();
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...entry, updatedAt: now };
    } else {
      list.unshift({
        localId: entry.localId,
        url: entry.url ?? '',
        domain: entry.domain ?? '',
        title: entry.title ?? null,
        state: entry.state ?? 'queued',
        pageId: entry.pageId ?? null,
        contentChanged: entry.contentChanged,
        lastError: entry.lastError ?? null,
        updatedAt: now,
      });
    }
    // newest first, capped
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    await chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, MAX_RECENT_ENTRIES) });
  });

  // Keep the chain usable after a failed storage operation while still
  // returning the original rejection to the caller.
  recentWrite = write.catch(() => undefined);
  return write;
}

export async function findByPageId(
  pageId: string,
): Promise<RecentEntry | undefined> {
  const list = await getRecent();
  return list.find((e) => e.pageId === pageId);
}

// ── Badge ────────────────────────────────────────────────────────────────

export async function updateBadge(opts: {
  queueCount: number;
  error?: boolean;
}): Promise<void> {
  if (opts.error) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
    return;
  }
  if (opts.queueCount > 0) {
    const text = opts.queueCount > 99 ? '99+' : String(opts.queueCount);
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#4F46E5' });
    return;
  }
  await chrome.action.setBadgeText({ text: '' });
}

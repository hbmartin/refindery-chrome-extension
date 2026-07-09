// Tracks 202'd pages to a terminal indexing state (indexed / dead) by polling
// GET /v1/pages/{id}/status. Pending records persist in storage so polling
// resumes after a service-worker restart. Also drives dead-page retry via the
// jobs API.

import type { ServerConfig } from './client';
import { getStatus, listJobs, retryJob } from './client';
import { TERMINAL_STATUSES } from '@/common/types';
import { pollBackoffMs } from '@/common/backoff';
import { getRecent, upsertRecent } from './recent';
import { notifyDead } from './notify';

interface PendingPoll {
  localId: string;
  pageId: string;
  pollCount: number;
  nextPollAt: number;
}

const PENDING_KEY = 'pending';
// Cap concurrent status requests so high capture volume can't flood the server.
const MAX_CONCURRENT_POLLS = 4;

// chrome.storage.local has no compare-and-swap operation. Serialize every
// pending-list mutation so trackPage() and pollDue() cannot overwrite one
// another with stale snapshots.
let pendingWrite = Promise.resolve();

function withPendingLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = pendingWrite.then(fn);
  pendingWrite = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function getPending(): Promise<PendingPoll[]> {
  const raw = await chrome.storage.local.get(PENDING_KEY);
  return (raw[PENDING_KEY] as PendingPoll[]) ?? [];
}

async function setPending(list: PendingPoll[]): Promise<void> {
  await chrome.storage.local.set({ [PENDING_KEY]: list });
}

export async function pendingCount(): Promise<number> {
  return (await getPending()).length;
}

export async function trackPage(localId: string, pageId: string): Promise<void> {
  return withPendingLock(async () => {
    const list = await getPending();
    if (list.some((p) => p.localId === localId)) return;
    list.push({ localId, pageId, pollCount: 0, nextPollAt: Date.now() });
    await setPending(list);
  });
}

/**
 * Poll all due pending pages (up to the concurrency cap). Returns true if any
 * pending records remain (so the caller keeps a poll timer alive).
 */
export async function pollDue(cfg: ServerConfig): Promise<boolean> {
  const due = await withPendingLock(async () => {
    const list = await getPending();
    const now = Date.now();
    return list.filter((p) => p.nextPollAt <= now).slice(0, MAX_CONCURRENT_POLLS);
  });

  // Status requests run outside the lock so trackPage() callers (e.g. the
  // retryDead message handler) aren't blocked behind slow network calls.
  await Promise.all(
    due.map(async (p) => {
      const status = await getStatus(cfg, p.pageId);
      if (!status) {
        // transient failure — back off and retry later
        p.pollCount += 1;
        p.nextPollAt = Date.now() + pollBackoffMs(p.pollCount);
        return;
      }
      if (TERMINAL_STATUSES.has(status.status)) {
        await upsertRecent({
          localId: p.localId,
          state: status.status === 'indexed' ? 'indexed' : 'dead',
          lastError: status.last_error,
        });
        if (status.status === 'dead') {
          const entry = (await getRecent()).find((e) => e.localId === p.localId);
          await notifyDead(entry?.url ?? p.pageId, status.last_error);
        }
        p.pollCount = -1; // mark for removal
      } else {
        await upsertRecent({ localId: p.localId, state: 'indexing', lastError: null });
        p.pollCount += 1;
        p.nextPollAt = Date.now() + pollBackoffMs(p.pollCount);
      }
    }),
  );

  return withPendingLock(async () => {
    // Re-read and merge so pages tracked while requests were in flight survive.
    const merged = (await getPending())
      .map((existing) => due.find((d) => d.localId === existing.localId) ?? existing)
      .filter((p) => p.pollCount !== -1);
    await setPending(merged);
    return merged.length > 0;
  });
}

/**
 * Retry a dead page: find its dead indexing job via the jobs ledger and
 * re-enqueue it. Returns true if a retry was issued.
 */
export async function retryDeadPage(
  cfg: ServerConfig,
  pageId: string,
): Promise<boolean> {
  const { jobs } = await listJobs(cfg, { status: 'dead', limit: 100 });
  const job = jobs.find((j) => j.page_id === pageId);
  if (!job) return false;
  await retryJob(cfg, job.id);
  return true;
}

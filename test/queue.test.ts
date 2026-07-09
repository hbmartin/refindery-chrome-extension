import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import * as queue from '@/background/queue';
import { MAX_QUEUE_ITEMS } from '@/common/settings';
import type { CapturePayload } from '@/common/types';

function payload(n: number): CapturePayload {
  return {
    url: `https://ex.com/${n}`,
    title: `t${n}`,
    bodyHtml: '<html></html>',
    bodyBytes: 13,
    fetchedAt: '2026-07-09T12:00:00Z',
    trigger: 'load',
    referrer: null,
    favicon: null,
    canonicalKey: `https://ex.com/${n}`,
  };
}

beforeEach(async () => {
  await queue.clear();
});

describe('queue', () => {
  it('enqueues and counts', async () => {
    await queue.enqueue(payload(1));
    await queue.enqueue(payload(2));
    expect(await queue.count()).toBe(2);
  });

  it('returns items oldest-first', async () => {
    const a = await queue.enqueue(payload(1));
    const b = await queue.enqueue(payload(2));
    const all = await queue.all();
    expect(all.map((i) => i.id)).toEqual([a.id, b.id]);
  });

  it('due() honors nextAttemptAt gating', async () => {
    const item = await queue.enqueue(payload(1));
    item.nextAttemptAt = Date.now() + 60_000;
    await queue.update(item);
    expect((await queue.due(Date.now(), 10)).length).toBe(0);
    expect((await queue.due(Date.now() + 120_000, 10)).length).toBe(1);
  });

  it('persists forceUrlOnly across update', async () => {
    const item = await queue.enqueue(payload(1));
    item.forceUrlOnly = true;
    await queue.update(item);
    const reloaded = (await queue.all())[0];
    expect(reloaded.forceUrlOnly).toBe(true);
  });

  it('removes items', async () => {
    const item = await queue.enqueue(payload(1));
    await queue.remove(item.id);
    expect(await queue.count()).toBe(0);
  });

  it('enforces the size cap by dropping oldest', async () => {
    for (let i = 0; i < MAX_QUEUE_ITEMS + 5; i++) {
      await queue.enqueue(payload(i));
    }
    expect(await queue.count()).toBe(MAX_QUEUE_ITEMS);
    const all = await queue.all();
    // oldest five (0..4) should have been dropped; first remaining is #5
    expect(all[0].payload.url).toBe('https://ex.com/5');
  });

  it('does not over-delete when enforceCap runs concurrently', async () => {
    for (let i = 0; i < MAX_QUEUE_ITEMS; i++) {
      await queue.enqueue(payload(i));
    }
    // Inject overflow via update() (which bypasses the per-enqueue cap) so two
    // concurrent enforceCap calls both observe the same oversized queue.
    for (let i = 0; i < 6; i++) {
      await queue.update({
        id: `overflow-${i}`,
        payload: payload(1000 + i),
        attempts: 0,
        enqueuedAt: Date.now(),
        nextAttemptAt: Date.now(),
        forceUrlOnly: false,
      });
    }

    const dropped = await Promise.all([queue.enforceCap(), queue.enforceCap()]);

    expect(dropped.reduce((sum, count) => sum + count, 0)).toBe(6);
    expect(await queue.count()).toBe(MAX_QUEUE_ITEMS);
  });

  it('releaseBackoffs makes backed-off items immediately due', async () => {
    const a = await queue.enqueue(payload(1));
    const b = await queue.enqueue(payload(2));
    a.nextAttemptAt = Date.now() + 60_000;
    b.nextAttemptAt = Date.now() + 120_000;
    await queue.update(a);
    await queue.update(b);
    expect((await queue.due(Date.now(), 10)).length).toBe(0);

    await queue.releaseBackoffs();

    expect((await queue.due(Date.now(), 10)).map((i) => i.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });
});

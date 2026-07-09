// Durable send queue backed by IndexedDB so captures survive service-worker
// restarts and server downtime. Insertion order is the auto-increment primary
// key (`_seq`), so ordering is intrinsic even for same-millisecond enqueues.
// Enforces a hard size cap by dropping the oldest items.

import type { CapturePayload, QueueItem } from '@/common/types';
import { MAX_QUEUE_ITEMS } from '@/common/settings';

const DB_NAME = 'refindery';
const DB_VERSION = 1;
const STORE = 'queue';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: '_seq',
          autoIncrement: true,
        });
        store.createIndex('id', 'id', { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeId(): string {
  return crypto.randomUUID();
}

export async function enqueue(payload: CapturePayload): Promise<QueueItem> {
  const db = await openDb();
  const now = Date.now();
  const item: QueueItem = {
    id: makeId(),
    payload,
    attempts: 0,
    enqueuedAt: now,
    nextAttemptAt: now,
    forceUrlOnly: false,
  };
  const key = await reqToPromise(store(db, 'readwrite').add(item));
  item._seq = key as number;
  await enforceCap();
  return item;
}

export async function count(): Promise<number> {
  const db = await openDb();
  return reqToPromise(store(db, 'readonly').count());
}

/** All items in insertion order (oldest first). */
export async function all(): Promise<QueueItem[]> {
  const db = await openDb();
  return reqToPromise(store(db, 'readonly').getAll() as IDBRequest<QueueItem[]>);
}

/** Items due to be attempted now (nextAttemptAt <= now), oldest first, limited. */
export async function due(now: number, limit: number): Promise<QueueItem[]> {
  const items = await all();
  return items.filter((i) => i.nextAttemptAt <= now).slice(0, limit);
}

export async function update(item: QueueItem): Promise<void> {
  const db = await openDb();
  await reqToPromise(store(db, 'readwrite').put(item));
}

export async function remove(id: string): Promise<void> {
  const db = await openDb();
  const s = store(db, 'readwrite');
  const key = await reqToPromise(s.index('id').getKey(id));
  if (key !== undefined) await reqToPromise(s.delete(key));
}

/**
 * Make every backed-off item immediately due. Used when the user changes
 * server settings so a fixed token/URL doesn't wait out stale retry delays.
 */
export async function releaseBackoffs(): Promise<void> {
  const now = Date.now();
  const items = (await all()).filter((i) => i.nextAttemptAt > now);
  for (const item of items) {
    item.nextAttemptAt = now;
    await update(item);
  }
}

export async function clear(): Promise<void> {
  const db = await openDb();
  await reqToPromise(store(db, 'readwrite').clear());
}

/** Drop oldest items beyond the cap. Returns number dropped. */
export async function enforceCap(): Promise<number> {
  const db = await openDb();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const s = tx.objectStore(STORE);
    let dropped = 0;
    const countReq = s.count();

    countReq.onsuccess = () => {
      const overflow = countReq.result - MAX_QUEUE_ITEMS;
      if (overflow <= 0) return;

      // Schedule the next request while the count success event keeps the
      // transaction active, then delete oldest records within that same
      // serialized write transaction.
      const cursorReq = s.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || dropped >= overflow) return;
        cursor.delete();
        dropped++;
        cursor.continue();
      };
    };

    tx.oncomplete = () => resolve(dropped);
    tx.onerror = () => reject(tx.error ?? new Error('Queue cap transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Queue cap transaction aborted'));
  });
}

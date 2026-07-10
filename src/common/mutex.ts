// A minimal async mutex. `chrome.storage.local` has no atomic
// read-modify-write, so concurrent callbacks that read-then-write the same key
// can clobber one another with stale snapshots. Serializing those sections
// through a shared mutex removes the lost-update race.

export type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Returns a `runExclusive` function that runs the supplied callbacks strictly
 * one at a time, in call order. A rejected callback still returns its rejection
 * to that caller, but does not wedge the queue for later callers.
 */
export function createMutex(): RunExclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

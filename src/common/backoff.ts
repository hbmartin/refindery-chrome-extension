// Deterministic backoff schedules (no randomness → unit-testable).

/** Exponential send-retry delay for the queue drain, capped. */
export function sendBackoffMs(attempts: number): number {
  const base = 2000; // 2s
  const cap = 5 * 60 * 1000; // 5 min
  const exp = base * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(cap, exp);
}

// Status polling schedule: 1s, 2s, 5s, then 10s, capped at 30s.
const POLL_SCHEDULE = [1000, 2000, 5000, 10000, 30000];

/** Delay before the Nth status poll (0-indexed pollCount). */
export function pollBackoffMs(pollCount: number): number {
  const i = Math.min(pollCount, POLL_SCHEDULE.length - 1);
  return POLL_SCHEDULE[i];
}

import { describe, it, expect } from 'vitest';
import { sendBackoffMs, pollBackoffMs } from '@/common/backoff';

describe('sendBackoffMs', () => {
  it('grows exponentially from 2s and caps at 5 min', () => {
    expect(sendBackoffMs(1)).toBe(2000);
    expect(sendBackoffMs(2)).toBe(4000);
    expect(sendBackoffMs(3)).toBe(8000);
    expect(sendBackoffMs(50)).toBe(5 * 60 * 1000);
  });
});

describe('pollBackoffMs', () => {
  it('follows 1s,2s,5s,10s and caps at 30s', () => {
    expect(pollBackoffMs(0)).toBe(1000);
    expect(pollBackoffMs(1)).toBe(2000);
    expect(pollBackoffMs(2)).toBe(5000);
    expect(pollBackoffMs(3)).toBe(10000);
    expect(pollBackoffMs(4)).toBe(30000);
    expect(pollBackoffMs(99)).toBe(30000);
  });
});

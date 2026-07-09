import { describe, expect, it } from 'vitest';
import { revisitDisposition } from '@/background/revisit';
import type { PageStatus } from '@/common/types';

describe('revisitDisposition', () => {
  it.each<[PageStatus, string, boolean]>([
    ['indexed', 'revisit', false],
    ['dead', 'dead', false],
    ['queued', 'queued', true],
    ['indexing', 'indexing', true],
    ['failed', 'failed', true],
  ])('maps %s to state %s with tracking=%s', (status, state, shouldTrack) => {
    expect(revisitDisposition(status)).toEqual({ state, shouldTrack });
  });
});

import type { PageStatus, RecentState } from '@/common/types';

export interface RevisitDisposition {
  state: RecentState;
  shouldTrack: boolean;
}

/** Map the server's existing-page status to popup state and polling behavior. */
export function revisitDisposition(status: PageStatus): RevisitDisposition {
  return {
    state: status === 'indexed' ? 'revisit' : status,
    shouldTrack: status !== 'indexed' && status !== 'dead',
  };
}

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { DEFAULT_SETTINGS } from '@/common/settings';
import type { RuntimeMessage } from '@/common/types';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@/ui/messaging', () => ({ send: sendMock }));

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('popup action errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal('chrome', {
      runtime: {
        getManifest: () => ({ version: '0.1.0' }),
        openOptionsPage: vi.fn(),
      },
      tabs: {
        query: vi.fn(async () => [{ url: 'https://example.com/article' }]),
      },
    });

    sendMock.mockImplementation(async (message: RuntimeMessage) => {
      switch (message.type) {
        case 'getState':
          return {
            settings: DEFAULT_SETTINGS,
            recent: [
              {
                localId: 'local-dead',
                url: 'https://example.com/article',
                domain: 'example.com',
                title: 'Example article',
                state: 'dead',
                pageId: 'page-dead',
                updatedAt: Date.now(),
              },
            ],
            queueCount: 0,
            pending: 0,
            stats: { total: 3, today: 1, day: '2026-07-10' },
            authError: false,
          };
        case 'testConnection':
          return { ready: true, authOk: true };
        case 'forgetDomain':
          return { ok: false, error: 'Server refused to forget this domain.' };
        case 'retryDead':
          return { ok: false, error: 'This page is no longer retryable.' };
        default:
          return { ok: true };
      }
    });
  });

  afterEach(() => {
    const app = document.getElementById('app');
    if (app) render(null, app);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows background errors for forget-domain and retry failures', async () => {
    await act(async () => {
      await import('@/popup/main');
    });
    await flushEffects();

    await act(async () => button('Forget domain…').click());
    await act(async () => button('Purge + block').click());

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Server refused to forget this domain.',
    );
    expect(sendMock).toHaveBeenCalledWith({
      type: 'forgetDomain',
      domain: 'example.com',
      reason: 'user requested from popup',
    });

    await act(async () => button('Retry indexing').click());

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'This page is no longer retryable.',
    );
    expect(sendMock).toHaveBeenCalledWith({ type: 'retryDead', localId: 'local-dead' });
  });
});

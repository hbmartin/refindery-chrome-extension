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
    (c) => c.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return match;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function stubBaseState(captureReply: unknown): void {
  sendMock.mockImplementation(async (message: RuntimeMessage) => {
    switch (message.type) {
      case 'getState':
        return {
          settings: DEFAULT_SETTINGS,
          recent: [],
          queueCount: 0,
          pending: 0,
          stats: { total: 0, today: 0, day: '2026-07-10' },
          authError: false,
        };
      case 'testConnection':
        return { ready: true, authOk: true };
      case 'captureNow':
        return captureReply;
      default:
        return { ok: true };
    }
  });
}

describe('popup manual capture', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '0.1.0' }), openOptionsPage: vi.fn() },
      tabs: { query: vi.fn(async () => [{ url: 'https://example.com/article' }]) },
    });
  });

  afterEach(() => {
    const app = document.getElementById('app');
    if (app) render(null, app);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('confirms a successful manual capture', async () => {
    stubBaseState({ ok: true, captured: true });
    await act(async () => {
      await import('@/popup/main');
    });
    await flushEffects();

    await act(async () => button('Capture this page').click());
    await flushEffects();

    expect(document.querySelector('output')?.textContent).toContain('Captured this page.');
    expect(sendMock).toHaveBeenCalledWith({ type: 'captureNow' });
  });

  it('explains a skipped capture with a friendly reason', async () => {
    stubBaseState({ ok: true, captured: false, reason: 'cooldown' });
    await act(async () => {
      await import('@/popup/main');
    });
    await flushEffects();

    await act(async () => button('Capture this page').click());
    await flushEffects();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'already captured recently',
    );
  });

  it('surfaces a hard failure from the background', async () => {
    stubBaseState({ ok: false, error: 'This page can’t be captured.' });
    await act(async () => {
      await import('@/popup/main');
    });
    await flushEffects();

    await act(async () => button('Capture this page').click());
    await flushEffects();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'This page can’t be captured.',
    );
  });
});

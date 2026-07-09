// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('@/ui/messaging', () => ({ send: sendMock }));

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('options cooldown validation', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
      permissions: {
        contains: vi.fn(async () => true),
        request: vi.fn(async () => true),
      },
    });
    sendMock.mockResolvedValue({ ok: true, entries: [] });
  });

  afterEach(() => {
    const app = document.getElementById('app');
    if (app) render(null, app);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('rejects fractional hours instead of persisting a rounded-looking value', async () => {
    await act(async () => {
      await import('@/options/main');
    });
    await flushEffects();

    const input = document.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error('Cooldown input not found');

    await act(async () => {
      input.value = '1.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(document.querySelector('.err-text')?.textContent).toBe(
      'Enter a whole number of hours, 1 or more.',
    );
  });
});

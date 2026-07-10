// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
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
    // Drain enough microtask turns to settle chained awaits (settings mutex →
    // storage get/set → follow-up messaging).
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

describe('options cooldown validation', () => {
  beforeEach(() => {
    vi.resetModules();
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
    vi.useRealTimers();
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

  it('saves settings and manages local and server exclusion rules', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    sendMock.mockImplementation(async (message: RuntimeMessage) => {
      switch (message.type) {
        case 'listBlacklist':
          return {
            ok: true,
            entries: [
              {
                id: 'blacklist-1',
                pattern: 'blocked.example',
                kind: 'domain',
                reason: null,
                created_at: '2026-07-09T12:00:00Z',
              },
            ],
          };
        case 'testConnection':
          return { ready: true, authOk: true };
        default:
          return { ok: true };
      }
    });

    await act(async () => {
      await import('@/options/main');
    });
    await flushEffects();

    const baseUrl = document.querySelector<HTMLInputElement>(
      'input[placeholder="http://127.0.0.1:8000"]',
    );
    if (!baseUrl) throw new Error('Base URL input not found');
    await act(async () => {
      baseUrl.value = 'http://localhost:9000';
      baseUrl.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button('Save').click();
    });
    await flushEffects();

    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ['http://localhost:9000/*'],
    });
    expect(sendMock).toHaveBeenCalledWith({ type: 'settingsChanged' });

    await act(async () => button('Test connection').click());
    await flushEffects();
    expect(sendMock).toHaveBeenCalledWith({ type: 'testConnection' });
    expect(document.body.textContent).toContain('Ready: true');

    const pause = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.parentElement?.textContent?.includes('Pause all auto-capture'),
    );
    if (!pause) throw new Error('Pause checkbox not found');
    await act(async () => pause.click());

    const ruleInput = document.querySelector<HTMLInputElement>('input[placeholder="example.com"]');
    if (!ruleInput) throw new Error('Rule input not found');
    await act(async () => {
      ruleInput.value = 'private.example';
      ruleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button('Add').click();
    });
    expect(document.querySelector('.list-item')?.textContent).toContain('private.example');
    await act(async () => button('Remove').click());

    const forgetInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="domain (example.com) or full URL to forget"]',
    );
    if (!forgetInput) throw new Error('Forget input not found');
    await act(async () => {
      forgetInput.value = 'forgotten.example';
      forgetInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button('Forget').click();
    });
    await flushEffects();
    expect(sendMock).toHaveBeenCalledWith({
      type: 'forgetDomain',
      domain: 'forgotten.example',
    });

    await act(async () => button('Unblock').click());
    await flushEffects();
    expect(sendMock).toHaveBeenCalledWith({ type: 'deleteBlacklist', id: 'blacklist-1' });

    await act(async () => {
      vi.runOnlyPendingTimers();
    });
  });
});

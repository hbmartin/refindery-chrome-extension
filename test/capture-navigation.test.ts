// @vitest-environment jsdom

import { afterAll, describe, expect, it, vi } from 'vitest';

const locationChange = () =>
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      data: { source: 'refindery', kind: 'locationchange' },
    }),
  );

describe('capture navigation messages', () => {
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ignores same-URL messages but captures a genuine route change', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main>${'article '.repeat(40)}</main>`;
    Object.defineProperty(document.body, 'innerText', {
      configurable: true,
      value: 'article '.repeat(40),
    });

    const sendMessage = vi.fn(async (message: { type: string }) =>
      message.type === 'shouldCapture' ? { capture: true } : { ok: true },
    );
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });

    await import('@/content/capture');
    await vi.advanceTimersByTimeAsync(700);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    locationChange();
    await vi.advanceTimersByTimeAsync(700);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    history.pushState({}, '', '/next-article');
    locationChange();
    await vi.advanceTimersByTimeAsync(700);
    expect(sendMessage).toHaveBeenCalledTimes(4);

    // Rapid A→B→A hops inside one debounce window still capture the final
    // route, even though that URL was attempted before.
    history.pushState({}, '', '/');
    locationChange();
    history.pushState({}, '', '/next-article');
    locationChange();
    await vi.advanceTimersByTimeAsync(700);
    expect(sendMessage).toHaveBeenCalledTimes(6);
  });
});

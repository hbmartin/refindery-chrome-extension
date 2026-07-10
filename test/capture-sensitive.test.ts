// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

function primeArticleDom(): void {
  document.body.innerHTML = `<main>${'article '.repeat(40)}</main>`;
  Object.defineProperty(document.body, 'innerText', {
    configurable: true,
    value: 'article '.repeat(40),
  });
}

describe('content capture — sensitive + manual', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not send a capture when a visible password field is present', async () => {
    primeArticleDom();
    const pw = document.createElement('input');
    pw.type = 'password';
    // jsdom does no layout; simulate an on-screen field via client rects.
    pw.getClientRects = () => [{ width: 5, height: 5 }] as unknown as DOMRectList;
    document.body.appendChild(pw);

    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === 'shouldCapture' ? { capture: true } : { ok: true },
    );
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });

    await import('@/content/capture');
    await vi.advanceTimersByTimeAsync(700);

    // Only the shouldCapture probe went out; the DOM password check aborted the
    // send before any content left the page.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'shouldCapture' }));
  });

  it('does not capture when a visible password field is inside an open shadow root', async () => {
    primeArticleDom();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const pw = document.createElement('input');
    pw.type = 'password';
    pw.getClientRects = () => [{ width: 5, height: 5 }] as unknown as DOMRectList;
    shadow.appendChild(pw);
    document.body.appendChild(host);

    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === 'shouldCapture' ? { capture: true } : { ok: true },
    );
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });

    await import('@/content/capture');
    await vi.advanceTimersByTimeAsync(700);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'shouldCapture' }));
  });

  it('captures on demand (manual) when the popup relays captureNow', async () => {
    primeArticleDom();
    let listener: Listener | undefined;
    const sendMessage = vi.fn(async (m: { type: string }) =>
      m.type === 'shouldCapture' ? { capture: true } : { ok: true },
    );
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (fn: Listener) => {
            listener = fn;
          },
        },
      },
    });

    await import('@/content/capture');
    await vi.advanceTimersByTimeAsync(700); // initial load capture
    sendMessage.mockClear();

    const sendResponse = vi.fn();
    expect(listener).toBeTypeOf('function');
    listener!({ type: 'captureNow' }, {}, sendResponse);
    await vi.runAllTimersAsync();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // Manual capture probes with the manual flag (bypassing cooldown) and sends.
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'shouldCapture', manual: true }),
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'capture' }));
    expect(sendResponse).toHaveBeenCalledWith({ captured: true });
  });
});

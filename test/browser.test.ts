import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserApi } from '@/common/browser';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserApi shim', () => {
  it('prefers the promise-based browser global when present', () => {
    const marker = { storage: { local: {} }, runtime: {} };
    vi.stubGlobal('browser', marker);
    vi.stubGlobal('chrome', { storage: { local: { get: () => undefined } } });
    expect(browserApi.storage).toBe(marker.storage);
    expect('storage' in browserApi).toBe(true);
  });

  it('falls back to chrome when browser is absent', () => {
    vi.stubGlobal('browser', undefined);
    const c = { runtime: { id: 'x' } };
    vi.stubGlobal('chrome', c);
    expect(browserApi.runtime).toBe(c.runtime);
    expect('tabs' in browserApi).toBe(false);
  });

  it('throws when neither global is available', () => {
    vi.stubGlobal('browser', undefined);
    vi.stubGlobal('chrome', undefined);
    expect(() => browserApi.runtime).toThrow(/No WebExtension API/);
  });
});

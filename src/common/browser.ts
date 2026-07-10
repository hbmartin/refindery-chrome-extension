// Single cross-browser handle for the WebExtension APIs.
//
// Firefox exposes the promise-based `browser` global; Chrome exposes `chrome`
// (also promise-based under MV3). Reading through this proxy lets the whole
// codebase call `browserApi.storage.local.get(...)` and get promises on both.
//
// The proxy resolves the underlying namespace lazily on every top-level access
// (rather than capturing it once at import time) so that test suites which
// `vi.stubGlobal('chrome', …)` per case still see their stub. Only the top-level
// namespace goes through the proxy; nested objects (`.storage`, `.runtime`, …)
// are the real API objects, so method `this` binding is preserved.

interface GlobalWithExtensionApis {
  browser?: typeof chrome;
  chrome?: typeof chrome;
}

function resolveApi(): typeof chrome {
  const g = globalThis as unknown as GlobalWithExtensionApis;
  const api = g.browser ?? g.chrome;
  if (!api) throw new Error('No WebExtension API (browser/chrome) available');
  return api;
}

export const browserApi: typeof chrome = new Proxy({} as typeof chrome, {
  get(_target, prop) {
    return resolveApi()[prop as keyof typeof chrome];
  },
  has(_target, prop) {
    return prop in resolveApi();
  },
});

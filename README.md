# Refindery Capture

A Chrome (MV3) extension that acts as an **upstream source** for
[Refindery](https://github.com/hbmartin/refindery): it auto-captures the pages
you read and ingests them into your local Refindery instance so everything you
read becomes durably searchable — with no manual effort.

It only implements the *ingest & lifecycle* surface of the Refindery API
(`POST /v1/pages`, status polling, forget/blacklist, jobs). Search/compare/
clustering are consumer features and are out of scope here.

## How it works

- **Auto-capture** on full page loads **and** SPA route changes (a MAIN-world
  hook relays `history.pushState`/`popstate`).
- Sends **sanitized `body_html`** (DOMPurify strips scripts/styles/handlers).
  Falls back to **URL-only** when the page is a PDF, over the size cap (~2 MB),
  or the server returns `501` (no extraction path).
- **Never captures** incognito/private windows, non-web/local pages
  (`chrome://`, `file://`, localhost/RFC-1918), or a default, editable list of
  **sensitive-category** domains (banking, health, webmail, adult) — plus any
  custom skip rules you add.
- Re-sends are **throttled** per canonical URL (default 24h cooldown).
- A **durable IndexedDB queue** holds captures; sending is gated on
  `GET /readyz` and drains with exponential backoff, so nothing is lost while
  the server is offline.
- Each accepted page is **polled to a terminal state** (`indexed`/`dead`);
  dead pages can be **retried** via the jobs API from the popup.
- The popup **Forget domain** button calls `POST /v1/forget` — a **destructive,
  irreversible** purge + blacklist, gated behind an explicit confirm.

## Setup

1. Run Refindery locally with an auth token:
   ```bash
   export REFINDERY_AUTH_TOKEN="$(openssl rand -hex 32)"
   python -m refindery        # serves http://127.0.0.1:8000
   ```
2. Build and load the extension:
   ```bash
   npm install
   npm run build              # → dist/
   ```
   Then open `chrome://extensions`, enable Developer mode, **Load unpacked** →
   select `dist/`.
3. Open the extension **Options**, paste the token (and a custom Base URL if
   your server isn't on `http://127.0.0.1:8000`), and **Test connection**.

## Development

```bash
npm run dev        # Vite + HMR (load dist/ unpacked, reloads on change)
npm test           # Vitest unit tests
npm run lint:architecture # enforce background/UI dependency boundaries
npm run lint:semgrep      # check timeout, parsing, and messaging guardrails
npm run mock       # start the in-memory mock Refindery server (port 8000)
npm run build      # typecheck + production build
npm run zip        # package dist/ → refindery-extension.zip
```

`npm run lint:semgrep` expects the Semgrep CLI to be available on `PATH`.

### Manual E2E against the mock server

```bash
REFINDERY_AUTH_TOKEN=test-token npm run mock
```

The mock implements the full ingest lifecycle and supports fixture URLs:
`*no-extract*` forces a `501` (exercises URL-only fallback) and `*will-die*`
drives a page to `dead` (exercises retry).

## Privacy

See [PRIVACY.md](./PRIVACY.md). In short: page content is sent **only** to the
Refindery server you configure (loopback by default). The bearer token is stored
in `chrome.storage.local` (this device only, never synced).

## Architecture

| Area | Module |
|------|--------|
| Capture (isolated world) | `src/content/capture.ts` |
| SPA hook (MAIN world) | `src/content/spa-hook.ts` |
| Orchestrator | `src/background/index.ts` |
| Durable queue | `src/background/queue.ts` |
| API client | `src/background/client.ts` |
| Status poller / retry | `src/background/poller.ts` |
| Canonicalization | `src/common/canonical.ts` |
| Exclusion rules | `src/common/exclusions.ts` |
| Settings | `src/common/settings.ts` |
| Popup / Options (Preact) | `src/popup`, `src/options` |

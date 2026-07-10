# Refindery Capture

A Chrome (MV3) extension that acts as an **upstream source** for
[Refindery](https://github.com/hbmartin/refindery): it auto-captures the pages
you read and ingests them into your local Refindery instance so everything you
read becomes durably searchable — with no manual effort.

It only implements the _ingest & lifecycle_ surface of the Refindery API
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
- **Heuristic sensitive-page skips** complement the domain list: pages whose URL
  path names an auth/payment flow (`/login`, `/checkout`, `/account`, …) or that
  contain a **visible password field** are skipped even on allowed domains.
- **Secret redaction**: before HTML is sent, Luhn-valid payment-card numbers and
  US SSNs found in the DOM are masked (`[REDACTED-CC]` / `[REDACTED-SSN]`).
- **Capture this page** on demand from the popup, the `Ctrl/Cmd+Shift+S`
  keyboard command, or the right-click context menu — a manual capture bypasses
  the pause switch and the re-capture cooldown (but still honours privacy skips).
- The popup shows lightweight **capture stats** (today / total).
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
npm run dev               # Vite + HMR (load dist/ unpacked, reloads on change)
npm run format            # format supported files with Oxfmt
npm run format:check      # verify formatting without rewriting files
npm run lint:code         # type-aware Oxlint checks
npm run lint:architecture # enforce background/UI dependency boundaries
npm run lint:semgrep      # check timeout, parsing, and messaging guardrails
npm run lint              # run every formatting and linting gate
npm test                  # Vitest unit tests
npm run test:coverage     # tests plus global coverage thresholds
npm run audit             # fail on high-or-worse dependency vulnerabilities
npm run mock              # start the in-memory mock Refindery server (port 8000)
npm run build             # typecheck + production build (Chrome, → dist/)
npm run check:package     # validate built manifest assets after a build
npm run zip               # package dist/ → refindery-extension.zip
npm run build:firefox     # build, then emit a Firefox MV3 build → dist-firefox/
npm run zip:firefox       # package dist-firefox/ → refindery-extension-firefox.zip
```

### Firefox

`npm run build:firefox` runs the normal Chrome build, then rewrites the manifest
for Firefox MV3 (`background.scripts` instead of `service_worker`, plus a
`browser_specific_settings.gecko` id) into `dist-firefox/`. All WebExtension API
calls go through a single `browserApi` shim (`src/common/browser.ts`) that
resolves to Firefox's promise-based `browser` global or Chrome's `chrome`, so
one code path serves both. Load it via `about:debugging` → **This Firefox** →
**Load Temporary Add-on** → `dist-firefox/manifest.json`. The Firefox build is
produced by construction from the Chrome bundle; validate it in Firefox before
publishing.

`npm run lint:semgrep` expects the Semgrep CLI to be available on `PATH`.

Oxlint enables type-aware correctness, suspicious-code, performance, import,
Vitest, React-hooks, and accessibility checks. Its configuration keeps narrow
exceptions for Preact's automatic JSX runtime and string styles, intentional
sequential queue processing, CSS/IndexedDB side-effect patterns, Chrome and DOM
type boundaries, and ES2022-compatible test mocks. Oxfmt preserves the existing
single-quote and semicolon style at a 100-column print width.

## Continuous integration

GitHub Actions runs formatting, linting, architecture checks, TypeScript,
Semgrep, dependency auditing/review, CodeQL, and the test suite on Node 22 and 24. The Node 24 test run enforces 70% statements, branches, and lines plus 60%
functions. Successful builds are validated, zipped, integrity-checked, and
retained as workflow artifacts for seven days.

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

| Area                     | Module                     |
| ------------------------ | -------------------------- |
| Capture (isolated world) | `src/content/capture.ts`   |
| SPA hook (MAIN world)    | `src/content/spa-hook.ts`  |
| Orchestrator             | `src/background/index.ts`  |
| Durable queue            | `src/background/queue.ts`  |
| API client               | `src/background/client.ts` |
| Status poller / retry    | `src/background/poller.ts` |
| Capture stats            | `src/background/stats.ts`  |
| Canonicalization         | `src/common/canonical.ts`  |
| Exclusion rules          | `src/common/exclusions.ts` |
| Secret redaction         | `src/common/redact.ts`     |
| Settings                 | `src/common/settings.ts`   |
| Storage write mutex      | `src/common/mutex.ts`      |
| Cross-browser API shim   | `src/common/browser.ts`    |
| Popup / Options (Preact) | `src/popup`, `src/options` |

# Privacy Policy — Refindery Capture

_Last updated: 2026-07-09_

Refindery Capture is a personal-knowledge tool. It captures the pages you read
and sends them to **your own Refindery server** so you can search them later.

## What data is handled

- **Page content**: the URL, title, and sanitized HTML (or, in fallback cases,
  just the URL) of web pages you visit that are not excluded (see below).
- **Metadata**: capture trigger (page load vs. SPA navigation), referrer,
  favicon URL, and capture timestamp.
- **Your settings**: the Refindery server URL and bearer token.

## Where data goes

- Captured page content and metadata are sent **only** to the Refindery server
  URL you configure in Options — by default `http://127.0.0.1:8000`, a server
  running on your own machine. The extension has **no other network
  destination**; it does not send data to the developer or any third party.
- The bearer token and all settings are stored in `chrome.storage.local`, which
  is local to this device and **never synced** to your Google account.

## What is never captured

- Incognito / private-browsing windows.
- Non-web and local pages (`chrome://`, `about:`, `file://`, extension pages,
  and localhost / private-network addresses).
- A default, user-editable list of **sensitive-category** sites (banking,
  health portals, webmail, adult), plus any custom skip rules you add.

## Broad host access

The extension requests access to all sites you visit so it can read page content
for capture. This access is used **solely** to extract and queue readable
content for your Refindery server, subject to the exclusions above. No browsing
data is collected for advertising, analytics, or resale.

## Your controls

- **Pause** all capture at any time from the popup.
- **Exclusion rules** and sensitive-category toggles in Options.
- **Forget**: permanently purge a page or domain from Refindery and blacklist
  future ingests (irreversible).

## Contact

Questions: open an issue at
<https://github.com/hbmartin/refindery>.

import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

// MV3 manifest. Broad host access is required because the extension
// auto-captures the content of every article the user reads; captured content
// is sent ONLY to the user-configured loopback Refindery server. See PRIVACY.md.
export default defineManifest({
  manifest_version: 3,
  name: 'Refindery Capture',
  version: pkg.version,
  description: 'Auto-captures pages you read and ingests them into your local Refindery instance.',
  minimum_chrome_version: '116',
  icons: {
    16: 'src/icons/icon-16.png',
    48: 'src/icons/icon-48.png',
    128: 'src/icons/icon-128.png',
  },
  action: {
    default_title: 'Refindery Capture',
    default_popup: 'src/popup/index.html',
    default_icon: {
      16: 'src/icons/icon-16.png',
      48: 'src/icons/icon-48.png',
      128: 'src/icons/icon-128.png',
    },
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      // MAIN-world hook: observes the page's own SPA navigations and relays
      // them to the isolated capture script via postMessage.
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/spa-hook.ts'],
      run_at: 'document_start',
      all_frames: false,
      world: 'MAIN',
    },
    {
      // Isolated-world capture logic (has access to chrome.runtime).
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/capture.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  permissions: ['storage', 'alarms', 'notifications', 'tabs'],
  // Default server origin. Custom origins are requested at runtime via
  // optional_host_permissions when the user changes the base URL in Options.
  host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
});

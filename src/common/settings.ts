// Typed access to extension settings, persisted in chrome.storage.local.
// The bearer token is a secret and is intentionally kept in `local` (never
// `sync`, which would replicate it through the user's Google account).

export interface NotifyPrefs {
  onDead: boolean;
  onServerDown: boolean;
  /** Minimum ms between server-down notifications. */
  serverDownCooldownMs: number;
}

export interface UserSkipRule {
  /** Domain suffix (e.g. "example.com") or glob-ish URL pattern with "*". */
  pattern: string;
  /** 'domain' matches host suffix; 'url' matches the full URL (glob). */
  kind: 'domain' | 'url';
}

export interface Settings {
  baseUrl: string;
  token: string;
  paused: boolean;
  /** Per-URL re-capture cooldown in ms (user-configurable). */
  cooldownMs: number;
  /** Default sensitive-category domains the user has turned OFF. */
  disabledDefaultCategories: string[];
  /** User-added skip rules (always local; never sent to the server). */
  userSkipRules: UserSkipRule[];
  notify: NotifyPrefs;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed (non-user-facing) tuning constants.
export const MAX_QUEUE_ITEMS = 500;
export const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — over this → URL-only
export const MAX_RECENT_ENTRIES = 50;

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'http://127.0.0.1:8000',
  token: '',
  paused: false,
  cooldownMs: DAY_MS,
  disabledDefaultCategories: [],
  userSkipRules: [],
  notify: {
    onDead: true,
    onServerDown: true,
    serverDownCooldownMs: 30 * 60 * 1000, // 30 min
  },
};

const SETTINGS_KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = (raw[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    notify: { ...DEFAULT_SETTINGS.notify, ...(stored.notify ?? {}) },
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = {
    ...current,
    ...patch,
    notify: { ...current.notify, ...(patch.notify ?? {}) },
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      getSettings().then(cb);
    }
  });
}

/** Normalize base URL (strip trailing slash) and build an endpoint URL. */
export function endpoint(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

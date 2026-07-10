// Service-worker orchestrator: message routing, queue drain, status polling,
// cooldown/403 bookkeeping, badge, and notifications.

import type {
  CaptureResult,
  IngestPageRequest,
  QueueItem,
  RuntimeMessage,
  ShouldCaptureReply,
} from '@/common/types';
import { getSettings } from '@/common/settings';
import { canonicalKey, domainOf, hostOf } from '@/common/canonical';
import { decideSkip, hostMatchesDomain } from '@/common/exclusions';
import { sendBackoffMs } from '@/common/backoff';
import { browserApi } from '@/common/browser';
import { createMutex } from '@/common/mutex';
import type { ServerConfig } from './client';
import { deleteBlacklist, forget, isReady, listBlacklist, postPage } from './client';
import * as queue from './queue';
import { pollDue, pendingCount, trackPage, retryDeadPage } from './poller';
import { getRecent, upsertRecent, updateBadge } from './recent';
import { notifyServerDown } from './notify';
import { revisitDisposition } from './revisit';
import { getStats, recordCapture } from './stats';

const CONTEXT_MENU_ID = 'refindery-capture-now';
const CAPTURE_COMMAND = 'capture-now';

const MAINTENANCE_ALARM = 'maintenance';
const DRAIN_BATCH = 10;
const RELEASE_BACKOFFS_REQUEST_KEY = 'releaseBackoffsRequest';
const RELEASE_BACKOFFS_HANDLED_KEY = 'releaseBackoffsHandled';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime message: ${JSON.stringify(value)}`);
}

// ── Cooldown (per canonical URL) ─────────────────────────────────────────

const COOLDOWN_KEY = 'cooldown';

// Serialize the read-modify-write of the shared cooldown map so concurrent
// drains/captures can't clobber one another's entries.
const cooldownMutex = createMutex();

async function getCooldownMap(): Promise<Record<string, number>> {
  const raw = await browserApi.storage.local.get(COOLDOWN_KEY);
  return (raw[COOLDOWN_KEY] as Record<string, number>) ?? {};
}

async function isOnCooldown(key: string, windowMs: number): Promise<boolean> {
  const map = await getCooldownMap();
  const last = map[key];
  return last != null && Date.now() - last < windowMs;
}

async function markSent(key: string): Promise<void> {
  await cooldownMutex(async () => {
    const map = await getCooldownMap();
    map[key] = Date.now();
    await browserApi.storage.local.set({ [COOLDOWN_KEY]: map });
  });
}

// Drop cooldown entries older than the window. Run from the maintenance alarm
// rather than on every send, so the drain hot path doesn't rescan/rewrite the
// whole map each time a page is accepted.
async function pruneCooldownMap(windowMs: number): Promise<void> {
  await cooldownMutex(async () => {
    const map = await getCooldownMap();
    const cutoff = Date.now() - windowMs;
    let changed = false;
    for (const k of Object.keys(map)) {
      if (map[k] < cutoff) {
        delete map[k];
        changed = true;
      }
    }
    if (changed) await browserApi.storage.local.set({ [COOLDOWN_KEY]: map });
  });
}

// ── Cached server-blacklist patterns (avoid re-POSTing known-403 targets) ──

const BLOCKED_KEY = 'blocked403';

// Serialize writes to the cached blacklist so a concurrent add + clear (or two
// adds) can't drop an entry via a stale snapshot.
const blockedMutex = createMutex();

async function getBlockedPatterns(): Promise<string[]> {
  const raw = await browserApi.storage.local.get(BLOCKED_KEY);
  return (raw[BLOCKED_KEY] as string[]) ?? [];
}

async function addBlockedPattern(pattern: string): Promise<void> {
  await blockedMutex(async () => {
    const list = await getBlockedPatterns();
    if (!list.includes(pattern)) {
      list.push(pattern);
      await browserApi.storage.local.set({ [BLOCKED_KEY]: list });
    }
  });
}

async function clearBlockedPatterns(): Promise<void> {
  await blockedMutex(async () => {
    await browserApi.storage.local.set({ [BLOCKED_KEY]: [] });
  });
}

async function isBlocked(url: string): Promise<boolean> {
  const host = hostOf(url);
  if (!host) return false;
  const patterns = await getBlockedPatterns();
  return patterns.some((p) => hostMatchesDomain(host, p) || url.startsWith(p));
}

// ── Auth-error flag (drives the badge "!" state) ─────────────────────────

const AUTH_ERR_KEY = 'authError';
async function setAuthError(v: boolean): Promise<void> {
  await browserApi.storage.local.set({ [AUTH_ERR_KEY]: v });
}
async function hasAuthError(): Promise<boolean> {
  const raw = await browserApi.storage.local.get(AUTH_ERR_KEY);
  return Boolean(raw[AUTH_ERR_KEY]);
}

// ── Capture decision (called by content script before it serializes) ──────

async function shouldCapture(url: string, manual = false): Promise<ShouldCaptureReply> {
  const settings = await getSettings();
  const decision = decideSkip(url, {
    incognito: false, // sender.tab.incognito is checked separately below
    // An explicit manual capture overrides the global pause, but still honours
    // the privacy exclusions (sensitive domains/paths, local hosts, …).
    paused: manual ? false : settings.paused,
    settings,
  });
  if (decision.skip) return { capture: false, reason: decision.reason };

  if (await isBlocked(url)) return { capture: false, reason: 'server-blacklisted' };

  // Manual captures deliberately bypass the re-capture cooldown.
  const key = canonicalKey(url);
  if (!manual && key && (await isOnCooldown(key, settings.cooldownMs))) {
    return { capture: false, reason: 'cooldown' };
  }
  return { capture: true };
}

// ── Ingest request builder ────────────────────────────────────────────────

function buildRequest(item: QueueItem): IngestPageRequest {
  const p = item.payload;
  const useHtml = p.bodyHtml != null && !item.forceUrlOnly;
  return {
    url: p.url,
    title: p.title,
    ...(useHtml ? { body_html: p.bodyHtml } : {}),
    fetched_at: p.fetchedAt,
    source: 'chrome-extension',
    metadata: {
      trigger: p.trigger,
      referrer: p.referrer,
      favicon: p.favicon,
      body_bytes: p.bodyBytes,
      url_only: !useHtml,
    },
  };
}

async function serverConfig(): Promise<ServerConfig | null> {
  const s = await getSettings();
  if (!s.token || !s.baseUrl) return null;
  return { baseUrl: s.baseUrl, token: s.token };
}

// ── Queue drain ────────────────────────────────────────────────────────────

export async function drainQueue(): Promise<boolean> {
  const cfg = await serverConfig();
  if (!cfg) return false; // not configured yet

  const items = await queue.due(Date.now(), DRAIN_BATCH);
  // Avoid waking the server just to inspect queue items that are still backed off.
  if (items.length === 0) return true;

  if (!(await isReady(cfg.baseUrl))) {
    await notifyServerDown();
    return false;
  }

  for (const item of items) {
    const outcome = await postPage(cfg, buildRequest(item));
    const p = item.payload;
    const domain = domainOf(p.url) ?? '';

    switch (outcome.kind) {
      case 'accepted': {
        await setAuthError(false);
        if (p.canonicalKey) await markSent(p.canonicalKey);
        await recordCapture();
        await upsertRecent({
          localId: item.id,
          url: p.url,
          domain,
          title: p.title,
          state: 'queued',
          pageId: outcome.body.page_id,
        });
        await trackPage(item.id, outcome.body.page_id);
        await queue.remove(item.id);
        break;
      }
      case 'revisit': {
        await setAuthError(false);
        if (p.canonicalKey) await markSent(p.canonicalKey);
        await recordCapture();
        const disposition = revisitDisposition(outcome.body.status);
        await upsertRecent({
          localId: item.id,
          url: p.url,
          domain,
          title: p.title,
          // Keep the successful revisit label, but surface dead immediately and
          // show the actual progress state for nonterminal existing pages.
          state: disposition.state,
          pageId: outcome.body.page_id,
          contentChanged: outcome.body.content_hash_differs,
        });
        if (disposition.shouldTrack) await trackPage(item.id, outcome.body.page_id);
        await queue.remove(item.id);
        break;
      }
      case 'blacklisted': {
        await setAuthError(false);
        await addBlockedPattern(outcome.body.pattern);
        await upsertRecent({
          localId: item.id,
          url: p.url,
          domain,
          title: p.title,
          state: 'blacklisted',
        });
        await queue.remove(item.id);
        break;
      }
      case 'no_extraction': {
        // server can't extract the HTML — resend as URL-only
        if (!item.forceUrlOnly) {
          item.forceUrlOnly = true;
          item.nextAttemptAt = Date.now();
          await queue.update(item);
        } else {
          await queue.remove(item.id); // already tried URL-only; give up
          await upsertRecent({
            localId: item.id,
            url: p.url,
            domain,
            title: p.title,
            state: 'error',
            lastError: 'no extraction path',
          });
        }
        break;
      }
      case 'invalid': {
        await upsertRecent({
          localId: item.id,
          url: p.url,
          domain,
          title: p.title,
          state: 'error',
          lastError: outcome.detail,
        });
        await queue.remove(item.id); // bad payload — don't retry blindly
        break;
      }
      case 'unauthorized': {
        await setAuthError(true);
        // Every remaining send would fail the same way, so back off the whole
        // rest of the batch instead of burning one request per tick.
        for (const pending of items.slice(items.indexOf(item))) {
          pending.attempts += 1;
          pending.nextAttemptAt = Date.now() + sendBackoffMs(pending.attempts);
          await queue.update(pending);
        }
        return false; // stop the whole drain; token is bad
      }
      case 'network_error':
      case 'server_error': {
        item.attempts += 1;
        item.nextAttemptAt = Date.now() + sendBackoffMs(item.attempts);
        await queue.update(item);
        break;
      }
    }
  }
  return true;
}

// ── Manual capture (popup button / keyboard command / context menu) ───────

interface ManualCaptureReply {
  ok: boolean;
  captured?: boolean;
  reason?: string;
  error?: string;
}

/**
 * Relay a "capture now" request to the content script in the given tab (or the
 * active tab). Fails cleanly when the tab has no content script — chrome://,
 * the PDF viewer, the web store, etc.
 */
async function triggerManualCapture(tabId?: number): Promise<ManualCaptureReply> {
  let id = tabId;
  if (id == null) {
    const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
    id = tab?.id;
  }
  if (id == null) return { ok: false, error: 'no active tab' };
  try {
    const res = (await browserApi.tabs.sendMessage(id, { type: 'captureNow' })) as
      | CaptureResult
      | undefined;
    return { ok: true, captured: res?.captured ?? false, reason: res?.reason };
  } catch {
    return { ok: false, error: 'This page can’t be captured.' };
  }
}

// ── Tick: drain + poll + badge, self-chaining while work remains ──────────

let ticking = false;
let tickRequested = false;

async function pendingReleaseBackoffsRequest(): Promise<string | null> {
  const [requestedRaw, handledRaw] = await Promise.all([
    browserApi.storage.local.get(RELEASE_BACKOFFS_REQUEST_KEY),
    browserApi.storage.local.get(RELEASE_BACKOFFS_HANDLED_KEY),
  ]);
  const requested = requestedRaw[RELEASE_BACKOFFS_REQUEST_KEY];
  const handled = handledRaw[RELEASE_BACKOFFS_HANDLED_KEY];
  return typeof requested === 'string' && requested !== handled ? requested : null;
}

/**
 * Callers must go through scheduleTick(): a direct call while a tick is
 * already running returns without coalescing another pass.
 */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  let moreWork = false;
  try {
    do {
      tickRequested = false;
      const releaseRequest = await pendingReleaseBackoffsRequest();
      if (releaseRequest) {
        // Mark this durable request handled only after the release succeeds.
        // A newer request written during the release retains a different ID
        // and is therefore processed by the next coalesced pass.
        await queue.releaseBackoffs();
        await browserApi.storage.local.set({
          [RELEASE_BACKOFFS_HANDLED_KEY]: releaseRequest,
        });
      }

      const ready = await drainQueue();
      const cfg = await serverConfig();
      let morePolls = false;
      if (cfg && ready) morePolls = await pollDue(cfg);

      const qCount = await queue.count();
      await updateBadge({ queueCount: qCount, error: await hasAuthError() });

      moreWork = ready && (qCount > 0 || morePolls);
    } while (tickRequested);
  } finally {
    ticking = false;
    if (moreWork) {
      // Keep making progress faster than the 1-min maintenance alarm. This is
      // deliberately in finally so a successful pass still schedules its
      // follow-up if a later coalesced pass fails.
      setTimeout(scheduleTick, 3000);
    }
  }
}

function scheduleTick(): void {
  if (ticking) {
    tickRequested = true;
    return;
  }
  void tick().catch((error: unknown) => {
    console.error('Refindery background tick failed', error);
  });
}

// ── Message routing ────────────────────────────────────────────────────────

const RUNTIME_MESSAGE_TYPES = {
  shouldCapture: true,
  capture: true,
  captureNow: true,
  getState: true,
  setPaused: true,
  forgetDomain: true,
  forgetUrl: true,
  listBlacklist: true,
  deleteBlacklist: true,
  retryDead: true,
  testConnection: true,
  settingsChanged: true,
} satisfies Record<RuntimeMessage['type'], true>;

function isRuntimeMessage(msg: unknown): msg is RuntimeMessage {
  if (typeof msg !== 'object' || msg === null || !('type' in msg)) return false;
  return Object.hasOwn(RUNTIME_MESSAGE_TYPES, (msg as { type: PropertyKey }).type);
}

export function registerMessageListener(): void {
  browserApi.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(msg)) return false;

    void handleMessage(msg, sender).then(sendResponse, (error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true; // async
  });
}

export async function handleMessage(
  msg: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (msg.type) {
    case 'shouldCapture': {
      if (sender.tab?.incognito) return { capture: false, reason: 'incognito' };
      return shouldCapture(msg.url, msg.manual ?? false);
    }
    case 'capture': {
      const item = await queue.enqueue(msg.payload);
      await upsertRecent({
        localId: item.id,
        url: msg.payload.url,
        domain: domainOf(msg.payload.url) ?? '',
        title: msg.payload.title,
        state: 'queued',
      });
      scheduleTick();
      return { ok: true };
    }
    case 'captureNow': {
      return triggerManualCapture(msg.tabId);
    }
    case 'getState': {
      const [settings, recent, queueCount, pending, stats] = await Promise.all([
        getSettings(),
        getRecent(),
        queue.count(),
        pendingCount(),
        getStats(),
      ]);
      return {
        settings,
        recent,
        queueCount,
        pending,
        stats,
        authError: await hasAuthError(),
      };
    }
    case 'setPaused': {
      const { setSettings } = await import('@/common/settings');
      await setSettings({ paused: msg.paused });
      return { ok: true };
    }
    case 'forgetDomain': {
      const cfg = await serverConfig();
      if (!cfg) return { ok: false, error: 'not configured' };
      try {
        const res = await forget(cfg, { domain: msg.domain, reason: msg.reason });
        await addBlockedPattern(res.pattern);
        return { ok: true, result: res };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
    case 'forgetUrl': {
      const cfg = await serverConfig();
      if (!cfg) return { ok: false, error: 'not configured' };
      try {
        const res = await forget(cfg, { url: msg.url, reason: msg.reason });
        await addBlockedPattern(res.pattern);
        return { ok: true, result: res };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
    case 'listBlacklist': {
      const cfg = await serverConfig();
      if (!cfg) return { ok: false, error: 'not configured', entries: [] };
      try {
        const res = await listBlacklist(cfg);
        return { ok: true, entries: res.entries };
      } catch (error) {
        return { ok: false, error: errorMessage(error), entries: [] };
      }
    }
    case 'deleteBlacklist': {
      const cfg = await serverConfig();
      if (!cfg) return { ok: false, error: 'not configured' };
      try {
        await deleteBlacklist(cfg, msg.id);
        // The cached 403 set is only an optimization; clear it so unblocked
        // targets can be captured again.
        await clearBlockedPatterns();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
    case 'retryDead': {
      const cfg = await serverConfig();
      if (!cfg) return { ok: false, error: 'not configured' };
      const entry = (await getRecent()).find((e) => e.localId === msg.localId);
      if (!entry?.pageId) return { ok: false, error: 'no page id' };
      const ok = await retryDeadPage(cfg, entry.pageId);
      if (ok) {
        await upsertRecent({ localId: msg.localId, state: 'queued', lastError: null });
        await trackPage(msg.localId, entry.pageId);
        scheduleTick();
      }
      return { ok };
    }
    case 'testConnection': {
      const cfg = await serverConfig();
      if (!cfg) return { ready: false, authOk: false, error: 'not configured' };
      const ready = await isReady(cfg.baseUrl);
      let authOk = false;
      try {
        await listBlacklist(cfg);
        authOk = true;
        await setAuthError(false);
      } catch {
        authOk = false;
      }
      return { ready, authOk };
    }
    case 'settingsChanged': {
      // A fixed token or server URL should take effect immediately rather than
      // waiting out retry backoffs accrued while the old settings were broken.
      // Defer the release to the next tick pass so an in-flight request using
      // the old settings cannot write a fresh backoff after we clear them.
      await browserApi.storage.local.set({
        [RELEASE_BACKOFFS_REQUEST_KEY]: crypto.randomUUID(),
      });
      scheduleTick();
      return { ok: true };
    }
    default:
      // Exhaustiveness guard: every RuntimeMessage variant is handled above, so
      // adding a new one without a case here becomes a compile error.
      return assertNever(msg);
  }
}

// ── Lifecycle wiring ────────────────────────────────────────────────────────

// Periodic upkeep on the maintenance alarm: prune stale cooldown entries off
// the drain hot path, then run a normal tick.
async function runMaintenance(): Promise<void> {
  try {
    const s = await getSettings();
    await pruneCooldownMap(s.cooldownMs);
  } catch (error) {
    console.error('Refindery cooldown prune failed', error);
  }
  scheduleTick();
}

export async function ensureContextMenu(): Promise<void> {
  if (!browserApi.contextMenus) return;
  // removeAll first so onInstalled/onStartup don't create duplicate entries.
  await Promise.resolve(browserApi.contextMenus.removeAll());
  browserApi.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Capture this page for Refindery',
    contexts: ['page'],
  });
}

export function registerLifecycleListeners(): void {
  browserApi.runtime.onInstalled.addListener(() => {
    void browserApi.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
    void ensureContextMenu().catch((error: unknown) => {
      console.error('Refindery context menu setup failed', error);
    });
    scheduleTick();
  });

  browserApi.runtime.onStartup.addListener(() => {
    void browserApi.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
    void ensureContextMenu().catch((error: unknown) => {
      console.error('Refindery context menu setup failed', error);
    });
    scheduleTick();
  });

  browserApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MAINTENANCE_ALARM) void runMaintenance();
  });
}

// Keyboard command + context-menu entry both funnel through triggerManualCapture.
export function registerManualCaptureTriggers(): void {
  if (browserApi.contextMenus) {
    browserApi.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === CONTEXT_MENU_ID) void triggerManualCapture(tab?.id);
    });
  }
  if (browserApi.commands) {
    browserApi.commands.onCommand.addListener((command) => {
      if (command === CAPTURE_COMMAND) void triggerManualCapture();
    });
  }
}

if (import.meta.env.MODE !== 'test') {
  registerMessageListener();
  registerLifecycleListeners();
  registerManualCaptureTriggers();
  // Kick once when the worker spins up (e.g. after being suspended).
  scheduleTick();
}

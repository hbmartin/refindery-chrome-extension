// Service-worker orchestrator: message routing, queue drain, status polling,
// cooldown/403 bookkeeping, badge, and notifications.

import type {
  IngestPageRequest,
  QueueItem,
  RuntimeMessage,
  ShouldCaptureReply,
} from '@/common/types';
import { getSettings } from '@/common/settings';
import { canonicalKey, domainOf, hostOf } from '@/common/canonical';
import { decideSkip, hostMatchesDomain } from '@/common/exclusions';
import { sendBackoffMs } from '@/common/backoff';
import type { ServerConfig } from './client';
import { deleteBlacklist, forget, isReady, listBlacklist, postPage } from './client';
import * as queue from './queue';
import { pollDue, pendingCount, trackPage, retryDeadPage } from './poller';
import { getRecent, upsertRecent, updateBadge } from './recent';
import { notifyServerDown } from './notify';
import { revisitDisposition } from './revisit';

const MAINTENANCE_ALARM = 'maintenance';
const DRAIN_BATCH = 10;
const RELEASE_BACKOFFS_REQUEST_KEY = 'releaseBackoffsRequest';
const RELEASE_BACKOFFS_HANDLED_KEY = 'releaseBackoffsHandled';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Cooldown (per canonical URL) ─────────────────────────────────────────

const COOLDOWN_KEY = 'cooldown';

async function getCooldownMap(): Promise<Record<string, number>> {
  const raw = await chrome.storage.local.get(COOLDOWN_KEY);
  return (raw[COOLDOWN_KEY] as Record<string, number>) ?? {};
}

async function isOnCooldown(key: string, windowMs: number): Promise<boolean> {
  const map = await getCooldownMap();
  const last = map[key];
  return last != null && Date.now() - last < windowMs;
}

async function markSent(key: string, windowMs: number): Promise<void> {
  const map = await getCooldownMap();
  map[key] = Date.now();
  // prune stale entries so the map can't grow unbounded
  const cutoff = Date.now() - windowMs;
  for (const k of Object.keys(map)) {
    if (map[k] < cutoff) delete map[k];
  }
  await chrome.storage.local.set({ [COOLDOWN_KEY]: map });
}

// ── Cached server-blacklist patterns (avoid re-POSTing known-403 targets) ──

const BLOCKED_KEY = 'blocked403';

async function getBlockedPatterns(): Promise<string[]> {
  const raw = await chrome.storage.local.get(BLOCKED_KEY);
  return (raw[BLOCKED_KEY] as string[]) ?? [];
}

async function addBlockedPattern(pattern: string): Promise<void> {
  const list = await getBlockedPatterns();
  if (!list.includes(pattern)) {
    list.push(pattern);
    await chrome.storage.local.set({ [BLOCKED_KEY]: list });
  }
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
  await chrome.storage.local.set({ [AUTH_ERR_KEY]: v });
}
async function hasAuthError(): Promise<boolean> {
  const raw = await chrome.storage.local.get(AUTH_ERR_KEY);
  return Boolean(raw[AUTH_ERR_KEY]);
}

// ── Capture decision (called by content script before it serializes) ──────

async function shouldCapture(url: string): Promise<ShouldCaptureReply> {
  const settings = await getSettings();
  const decision = decideSkip(url, {
    incognito: false, // sender.tab.incognito is checked separately below
    paused: settings.paused,
    settings,
  });
  if (decision.skip) return { capture: false, reason: decision.reason };

  if (await isBlocked(url)) return { capture: false, reason: 'server-blacklisted' };

  const key = canonicalKey(url);
  if (key && (await isOnCooldown(key, settings.cooldownMs))) {
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
        if (p.canonicalKey) await markSentForItem(p.canonicalKey);
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
        if (p.canonicalKey) await markSentForItem(p.canonicalKey);
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

async function markSentForItem(key: string): Promise<void> {
  const s = await getSettings();
  await markSent(key, s.cooldownMs);
}

// ── Tick: drain + poll + badge, self-chaining while work remains ──────────

let ticking = false;
let tickRequested = false;

async function pendingReleaseBackoffsRequest(): Promise<string | null> {
  const [requestedRaw, handledRaw] = await Promise.all([
    chrome.storage.local.get(RELEASE_BACKOFFS_REQUEST_KEY),
    chrome.storage.local.get(RELEASE_BACKOFFS_HANDLED_KEY),
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
        await chrome.storage.local.set({
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

export function registerMessageListener(): void {
  chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
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
      return shouldCapture(msg.url);
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
    case 'getState': {
      const [settings, recent, queueCount, pending] = await Promise.all([
        getSettings(),
        getRecent(),
        queue.count(),
        pendingCount(),
      ]);
      return {
        settings,
        recent,
        queueCount,
        pending,
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
        await chrome.storage.local.set({ [BLOCKED_KEY]: [] });
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
      await chrome.storage.local.set({
        [RELEASE_BACKOFFS_REQUEST_KEY]: crypto.randomUUID(),
      });
      scheduleTick();
      return { ok: true };
    }
  }

  return undefined;
}

// ── Lifecycle wiring ────────────────────────────────────────────────────────

export function registerLifecycleListeners(): void {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
    scheduleTick();
  });

  chrome.runtime.onStartup.addListener(() => {
    void chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 1 });
    scheduleTick();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MAINTENANCE_ALARM) scheduleTick();
  });
}

if (import.meta.env.MODE !== 'test') {
  registerMessageListener();
  registerLifecycleListeners();
  // Kick once when the worker spins up (e.g. after being suspended).
  scheduleTick();
}

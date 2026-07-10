// Desktop notifications, gated by user verbosity prefs.

import { getSettings } from '@/common/settings';
import { browserApi } from '@/common/browser';

const ICON = 'src/icons/icon-128.png';
const META_KEY = 'notifyMeta';

interface NotifyMeta {
  serverDownLastAt: number;
}

async function getMeta(): Promise<NotifyMeta> {
  const raw = await browserApi.storage.local.get(META_KEY);
  return (raw[META_KEY] as NotifyMeta) ?? { serverDownLastAt: 0 };
}

async function setMeta(meta: NotifyMeta): Promise<void> {
  await browserApi.storage.local.set({ [META_KEY]: meta });
}

export async function notifyDead(url: string, error: string | null): Promise<void> {
  const s = await getSettings();
  if (!s.notify.onDead) return;
  browserApi.notifications.create({
    type: 'basic',
    iconUrl: ICON,
    title: 'Refindery: page failed to index',
    message: `${url}\n${error ?? 'Retries exhausted (dead).'}`,
    priority: 0,
  });
}

export async function notifyServerDown(): Promise<void> {
  const s = await getSettings();
  if (!s.notify.onServerDown) return;
  const meta = await getMeta();
  const now = Date.now();
  if (now - meta.serverDownLastAt < s.notify.serverDownCooldownMs) return;
  await setMeta({ ...meta, serverDownLastAt: now });
  browserApi.notifications.create({
    type: 'basic',
    iconUrl: ICON,
    title: 'Refindery unreachable',
    message:
      'Captured pages are being queued but the Refindery server is not ready. Check the server and your Options settings.',
    priority: 0,
  });
}

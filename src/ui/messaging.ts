// Thin typed wrapper around the runtime messaging API for UI pages.
import type { RuntimeMessage } from '@/common/types';
import { browserApi } from '@/common/browser';

export function send<T = any>(msg: RuntimeMessage): Promise<T> {
  return browserApi.runtime.sendMessage(msg) as Promise<T>;
}

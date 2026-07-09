// Thin typed wrapper around chrome.runtime.sendMessage for UI pages.
import type { RuntimeMessage } from '@/common/types';

export function send<T = any>(msg: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

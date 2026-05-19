/** Tiny unread-counter for the Messenger tab. Stores `lastReadAt` in SecureStore,
 * counts outbound messenger entries newer than it. Subscribers re-render when it changes. */

import { useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import type { HistoryEntry } from './types';

const KEY = 'messenger-last-read-iso';
let lastReadIso: string = new Date(0).toISOString();
const listeners = new Set<(iso: string) => void>();

void SecureStore.getItemAsync(KEY).then(v => {
  if (v) { lastReadIso = v; listeners.forEach(l => l(lastReadIso)); }
});

export async function markMessengerRead(): Promise<void> {
  lastReadIso = new Date().toISOString();
  listeners.forEach(l => l(lastReadIso));
  await SecureStore.setItemAsync(KEY, lastReadIso).catch(() => { /* ignore */ });
}

export function getMessengerLastRead(): string { return lastReadIso; }

export function useMessengerUnread(events: HistoryEntry[]): number {
  const [lastRead, setLastRead] = useState(lastReadIso);
  useEffect(() => {
    listeners.add(setLastRead);
    return (): void => { listeners.delete(setLastRead); };
  }, []);
  return events.filter(e => e.kind === 'outbound' && e.station === 'messenger' && e.ts > lastRead).length;
}

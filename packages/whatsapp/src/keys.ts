import { TrainError } from '@metro-labs/mcp/train-error';
import type { WAMessageKey } from 'baileys';
import { isGroupJid } from './parse.js';

const MAX_TRACKED_KEYS = 4000;

export interface KeyCache {
  remember(key: WAMessageKey | null | undefined): void;
  lookup(jid: string, id: string): WAMessageKey | undefined;
}

const slotOf = (jid: string, id: string): string => `${jid}|${id}`;

export function makeKeyCache(max: number = MAX_TRACKED_KEYS): KeyCache {
  const seen = new Map<string, WAMessageKey>();
  return {
    remember(key) {
      const id = key?.id;
      const jid = key?.remoteJid;
      if (!key || !id || !jid) return;
      const slot = slotOf(jid, id);
      seen.delete(slot);
      seen.set(slot, key);
      while (seen.size > max) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    },
    lookup(jid, id) {
      return seen.get(slotOf(jid, id));
    },
  };
}

export function knownKey(
  cache: KeyCache,
  jid: string,
  id: string,
  fromMe: boolean,
): WAMessageKey {
  return cache.lookup(jid, id) ?? { remoteJid: jid, id, fromMe };
}

export function targetKey(
  cache: KeyCache,
  jid: string,
  id: string,
  verb: string,
): WAMessageKey {
  const known = cache.lookup(jid, id);
  if (known) return known;
  if (isGroupJid(jid))
    throw new TrainError(
      'whatsapp_unknown_message',
      `cannot ${verb} message '${id}' in group ${jid}: this connection never saw that message, so the group key naming its original sender cannot be built — WhatsApp would accept the send and display nothing`,
    );
  return { remoteJid: jid, id, fromMe: false };
}

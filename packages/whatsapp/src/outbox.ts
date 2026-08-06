import type { WAMessageKey, proto } from 'baileys';

const MAX_TRACKED_SENDS = 256;

export interface Outbox {
  remember(
    key: WAMessageKey | null | undefined,
    message: proto.IMessage | null | undefined,
  ): void;
  lookup(key: WAMessageKey): proto.IMessage | undefined;
}

const slotOf = (jid: string, id: string): string => `${jid}|${id}`;

export function makeOutbox(max: number = MAX_TRACKED_SENDS): Outbox {
  const sent = new Map<string, proto.IMessage>();
  return {
    remember(key, message) {
      const id = key?.id;
      const jid = key?.remoteJid;
      if (!id || !jid || !message || key?.fromMe !== true) return;
      const slot = slotOf(jid, id);
      sent.delete(slot);
      sent.set(slot, message);
      while (sent.size > max) {
        const oldest = sent.keys().next().value;
        if (oldest === undefined) break;
        sent.delete(oldest);
      }
    },
    lookup(key) {
      const id = key.id;
      const jid = key.remoteJid;
      if (!id || !jid) return undefined;
      return sent.get(slotOf(jid, id));
    },
  };
}

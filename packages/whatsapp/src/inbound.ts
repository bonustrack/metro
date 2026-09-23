import type { WAMessage } from 'baileys';
import { emit } from './wire.js';
import { reportAttachment } from '@metro-labs/core/stations/train-events';
import { lineOf } from './accounts.js';
import {
  envelope,
  reactionEnvelope,
  type InboundMessage,
} from './format.js';
import { saveWhatsAppMedia } from './attachments.js';
import type { WAClient } from './client.js';

function saveMedia(
  client: WAClient,
  m: InboundMessage,
  raw: WAMessage,
  sourceId: string,
): void {
  const ref = m.media;
  if (!ref) return;
  reportAttachment(
    saveWhatsAppMedia(m.accountId, raw, ref, m.messageId, 0, (msg) => client.reuploadMedia(msg)),
    { station: 'whatsapp', account: m.accountId, line: lineOf(m.accountId, m.chatJid), forId: sourceId, index: 0 },
    { saved: { kind: ref.kind }, failed: { kind: ref.kind, name: ref.name, mime: ref.mime } },
  );
}

export async function startInbound(client: WAClient): Promise<void> {
  await client.start({
    onMessage: (m, raw) => {
      const env = envelope(m);
      emit(env);
      if (!m.media) return;
      saveMedia(client, m, raw, String(env.id));
    },
    onReaction: (r) => {
      emit(reactionEnvelope(r));
    },
  });
}

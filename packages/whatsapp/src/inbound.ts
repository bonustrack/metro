import type { WAMessage } from 'baileys';
import { errMsg } from '@metro-labs/mcp/log';
import { emit } from './wire.js';
import {
  attachmentFailedEnvelope,
  attachmentSavedEnvelope,
  envelope,
  reactionEnvelope,
  type InboundMessage,
} from './format.js';
import { saveWhatsAppMedia } from './attachments.js';
import type { WAClient } from './client.js';

async function saveMedia(
  client: WAClient,
  m: InboundMessage,
  raw: WAMessage,
  sourceId: string,
): Promise<void> {
  const ref = m.media;
  if (!ref) return;
  try {
    const saved = await saveWhatsAppMedia(
      m.accountId,
      raw,
      ref,
      m.messageId,
      0,
      (msg) => client.reuploadMedia(msg),
    );
    emit(attachmentSavedEnvelope(m, sourceId, ref, saved, 0));
  } catch (err) {
    const reason = errMsg(err);
    process.stderr.write(
      `whatsapp[${m.accountId}] ${ref.kind} download failed for ${m.messageId}: ${reason}\n`,
    );
    emit(attachmentFailedEnvelope(m, sourceId, ref, 0, reason));
  }
}

export async function startInbound(client: WAClient): Promise<void> {
  await client.start({
    onMessage: (m, raw) => {
      const env = envelope(m);
      emit(env);
      if (!m.media) return;
      saveMedia(client, m, raw, String(env.id)).catch((err: unknown) => {
        process.stderr.write(
          `whatsapp[${m.accountId}] media event not emitted: ${errMsg(err)}\n`,
        );
      });
    },
    onReaction: (r) => {
      emit(reactionEnvelope(r));
    },
  });
}

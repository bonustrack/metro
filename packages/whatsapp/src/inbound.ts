import type { WAMessage } from 'baileys';
import { errMsg } from '@metro-labs/core/log';
import { makeProfileCache } from '@metro-labs/core/stations/sender-profile';
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
  const senders = makeProfileCache((jid) => client.senderProfile(jid), {
    onError: (jid, err) => process.stderr.write(`whatsapp[${client.account.id}] could not read the profile of ${jid}: ${errMsg(err)}\n`),
  });
  await client.start({
    onMessage: (m, raw) => {
      senders
        .within(m.senderJid)
        .then((profile) => {
          const env = { ...envelope(m), ...profile };
          emit(env);
          deliverMedia(client, m, raw, env);
        })
        .catch((err: unknown) => {
          process.stderr.write(`whatsapp[${m.accountId}] inbound not emitted: ${errMsg(err)}\n`);
        });
    },
    onReaction: (r) => {
      emit(reactionEnvelope(r));
    },
  });
}

function deliverMedia(client: WAClient, m: InboundMessage, raw: WAMessage, env: Record<string, unknown>): void {
  if (!m.media) return;
  saveMedia(client, m, raw, String(env.id)).catch((err: unknown) => {
    process.stderr.write(`whatsapp[${m.accountId}] media event not emitted: ${errMsg(err)}\n`);
  });
}

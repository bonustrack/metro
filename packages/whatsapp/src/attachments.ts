import {
  downloadMediaMessage,
  type WAMessage,
} from '@whiskeysockets/baileys';
import {
  assertAttachmentSize,
  saveStreamToCache,
  type SavedAttachment,
} from '@metro-labs/mcp/stations/attachments';
import { silentLogger } from './logger.js';
import type { WAMediaRef } from './media.js';

export type { SavedAttachment };

const IDLE_TIMEOUT_MS = 60_000;

export type ReuploadRequest = (m: WAMessage) => Promise<WAMessage>;

export async function saveWhatsAppMedia(
  raw: WAMessage,
  ref: WAMediaRef,
  messageId: string,
  index = 0,
  reupload?: ReuploadRequest,
): Promise<SavedAttachment> {
  if (ref.bytes !== undefined) assertAttachmentSize(ref.bytes);
  const stream = await downloadMediaMessage(
    raw,
    'stream',
    { options: { timeout: IDLE_TIMEOUT_MS } },
    reupload
      ? { reuploadRequest: reupload, logger: silentLogger() }
      : undefined,
  );
  try {
    return await saveStreamToCache(stream, messageId, index, {
      mime: ref.mime,
      name: ref.name,
    });
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

import { downloadMediaMessage, type WAMessage } from 'baileys';
import {
  assertAttachmentSize,
  saveStreamToCache,
  type SavedAttachment,
} from '@metro-labs/mcp/stations/attachments';
import { TrainError } from '@metro-labs/mcp/train-error';
import { baileysLogger } from './logger.js';
import type { WAMediaRef } from './media.js';

export type { SavedAttachment };

const IDLE_TIMEOUT_MS = 60_000;

export type ReuploadRequest = (m: WAMessage) => Promise<WAMessage>;

export async function* withIdleTimeout(
  chunks: AsyncIterable<Uint8Array>,
  ms: number,
): AsyncGenerator<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new TrainError(
            'whatsapp_media_stalled',
            `WhatsApp sent no media bytes for ${ms}ms, so the download was abandoned`,
          ),
        );
      }, ms);
    });
    try {
      const next = await Promise.race([iterator.next(), idle]);
      if (next.done === true) return;
      yield next.value;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function saveWhatsAppMedia(
  accountId: string,
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
    {},
    reupload
      ? { reuploadRequest: reupload, logger: baileysLogger(accountId) }
      : undefined,
  );
  try {
    return await saveStreamToCache(
      withIdleTimeout(stream, IDLE_TIMEOUT_MS),
      messageId,
      index,
      { mime: ref.mime, name: ref.name },
    );
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

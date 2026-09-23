import { readFile } from 'node:fs/promises';
import { emit } from '@metro-labs/core/stations/station-runtime';
import { attachmentFailedEvent, attachmentSavedEvent, emitInbound } from '@metro-labs/core/stations/train-events';
import { assertAttachmentSize, isImageMime, kindOf, saveBufferToCache } from '@metro-labs/core/stations/attachments';
import { TrainError } from '@metro-labs/core/train-error';
import type { Account } from './accounts.js';
import { downloadBlob, uploadBlob } from './api.js';
import { bytesToHex, hexToBytes, newBlobKey, openBlob, sealBlob } from './crypto.js';
import { textEnvelope, type InboundMeta, type Room } from './format.js';
import { encodeFile, encodeGroupFile, type FileData, type GroupRef } from './messages.js';

export const MAX_BLOB_BYTES = 50 * 1024 * 1024;

export interface OutgoingFile {
  path: string;
  mime: string;
  name: string;
}

export async function packFile(acct: Account, file: OutgoingFile, caption: string | null): Promise<FileData> {
  const data = await readFile(file.path);
  assertAttachmentSize(data.length);
  if (data.length > MAX_BLOB_BYTES) throw new TrainError('threema_file_too_big', `Threema carries files up to 50 MB; ${file.name} is bigger`, { retryable: false });
  const key = newBlobKey();
  const blobId = await uploadBlob(acct.cfg, sealBlob(new Uint8Array(data), key));
  return { blobId, key: bytesToHex(key), mime: file.mime, name: file.name, size: data.length, caption, media: isImageMime(file.mime) };
}

export const encodeFileFor = (group: GroupRef | null, file: FileData): Uint8Array => (group === null ? encodeFile(file) : encodeGroupFile(group, file));

export const fileLabel = (file: OutgoingFile): string => kindOf(file.mime, file.path);

async function fetchFile(acct: Account, m: InboundMeta, file: FileData): Promise<{ path: string; bytes: number }> {
  const sealed = await downloadBlob(acct.cfg, file.blobId);
  const plain = openBlob(sealed, hexToBytes(file.key, 'blob key'));
  if (plain === null) throw new TrainError('threema_bad_blob', 'the file did not decrypt with the key in the message', { retryable: false });
  const saved = await saveBufferToCache(plain, m.messageId, 0, { mime: file.mime, name: file.name });
  return { path: saved.path, bytes: saved.bytes };
}

export function deliverFile(acct: Account, m: InboundMeta, file: FileData, room: Room, sentByUs: (id: string) => boolean): void {
  const env = textEnvelope(acct.cfg.id, m, file.caption ?? '', sentByUs, room);
  const line = String(env.line);
  const forId = String(env.id);
  const payload = { ...(env.payload as Record<string, unknown>), attachments: [{ kind: kindOf(file.mime, file.name), name: file.name, mime: file.mime, ...(file.size === null ? {} : { size: file.size }) }] };
  emitInbound(acct.cfg.id, { ...env, payload });
  const at = { station: 'threema', account: acct.cfg.id, line, forId, index: 0 };
  const kind = kindOf(file.mime, file.name);
  fetchFile(acct, m, file)
    .then(({ path, bytes }) => {
      emit(attachmentSavedEvent({ ...at, saved: { path, mime: file.mime, name: file.name }, extra: { kind, size: bytes } }));
    })
    .catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`threema[${acct.cfg.id}]: could not fetch ${file.name} from ${m.from}: ${reason}\n`);
      emit(attachmentFailedEvent({ ...at, reason, extra: { kind } }));
    });
}

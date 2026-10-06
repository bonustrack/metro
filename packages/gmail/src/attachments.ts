import { stat } from 'node:fs/promises';
import { assertAttachmentSize, saveBufferToCache, type SavedAttachment } from '@metro-labs/core/stations/attachments';
import type { OutgoingFile } from '@metro-labs/core/stations/mail';
import { TrainError } from '@metro-labs/core/train-error';
import type { Account } from './accounts.js';
import { gmailJson, USER } from './api.js';
import { unloadedBodies, type GmailMessage, type MailFile } from './message.js';

export const MAX_FILES_BYTES = 25 * 1024 * 1024;

const attachmentData = async (acct: Account, messageId: string, attachmentId: string): Promise<string | null> =>
  (await gmailJson<{ data?: string }>(acct, `${USER}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)).data ?? null;

export async function withBodies(acct: Account, m: GmailMessage): Promise<GmailMessage> {
  for (const part of unloadedBodies(m)) part.body = { ...part.body, data: (await attachmentData(acct, m.id, part.body?.attachmentId ?? '')) ?? '' };
  return m;
}

export async function saveFile(acct: Account, messageId: string, file: MailFile, index: number): Promise<SavedAttachment> {
  if (file.size !== undefined) assertAttachmentSize(file.size);
  const data = file.data ?? (file.attachmentId === null ? null : await attachmentData(acct, messageId, file.attachmentId));
  if (data === null) throw new TrainError('gmail_file_missing', `Gmail gave no content for ${file.name}`, { retryable: false });
  acct.check();
  const saved = await saveBufferToCache(new Uint8Array(Buffer.from(data, 'base64url')), messageId, index, { mime: file.mime, name: file.name });
  acct.check();
  return saved;
}

export async function assertSendable(files: OutgoingFile[]): Promise<void> {
  let total = 0;
  for (const file of files) total += (await stat(file.path)).size;
  if (total > MAX_FILES_BYTES)
    throw new TrainError(
      'gmail_files_too_big',
      `Gmail takes up to 25 MB of files in one email; these are ${(total / 1024 / 1024).toFixed(1)} MB, so share a link instead`,
      { retryable: false },
    );
}

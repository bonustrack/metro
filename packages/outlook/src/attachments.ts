import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { assertAttachmentSize, kindOf, saveBufferToCache, type SavedAttachment } from '@metro-labs/core/stations/attachments';
import { TrainError } from '@metro-labs/core/train-error';
import type { Account } from './accounts.js';
import type { AttachmentMeta } from './format.js';
import { graph, graphJson, messagePath } from './graph.js';

export const MAX_FILE_BYTES = 3 * 1024 * 1024;

const FILE_TYPE = '#microsoft.graph.fileAttachment';

export interface GraphAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  '@odata.type'?: string;
}

export interface MailFile extends AttachmentMeta {
  id: string;
}

export const metaOf = (f: MailFile): AttachmentMeta => ({
  kind: f.kind,
  name: f.name,
  mime: f.mime,
  ...(f.size === undefined ? {} : { size: f.size }),
});

export async function listFiles(acct: Account, messageId: string): Promise<MailFile[]> {
  const body = await graphJson<{ value?: GraphAttachment[] }>(
    acct,
    `${messagePath(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
  );
  return (body.value ?? [])
    .filter((a) => a['@odata.type'] === undefined || a['@odata.type'] === FILE_TYPE)
    .map((a) => {
      const name = a.name ?? 'attachment';
      const mime = a.contentType ?? 'application/octet-stream';
      return { id: a.id, name, mime, kind: kindOf(mime, name), ...(typeof a.size === 'number' ? { size: a.size } : {}) };
    });
}

const cacheKey = (messageId: string): string => createHash('sha256').update(messageId).digest('hex').slice(0, 16);

export async function saveFile(acct: Account, messageId: string, file: MailFile, index: number): Promise<SavedAttachment> {
  if (file.size !== undefined) assertAttachmentSize(file.size);
  const res = await graph(acct, `${messagePath(messageId)}/attachments/${encodeURIComponent(file.id)}/$value`);
  const data = new Uint8Array(await res.arrayBuffer());
  return saveBufferToCache(data, cacheKey(messageId), index, { mime: file.mime, name: file.name });
}

export interface OutgoingFile {
  path: string;
  mime: string;
  name: string;
}

export const filesOf = (raw: unknown): OutgoingFile[] =>
  (Array.isArray(raw) ? raw : [])
    .map((a) => (a ?? {}) as Record<string, unknown>)
    .filter((a) => typeof a.path === 'string' && a.path !== '')
    .map((a) => ({
      path: String(a.path),
      mime: typeof a.mime === 'string' && a.mime !== '' ? a.mime : 'application/octet-stream',
      name: typeof a.name === 'string' && a.name !== '' ? a.name : 'file',
    }));

export async function assertSendable(files: OutgoingFile[]): Promise<void> {
  for (const file of files) {
    const { size } = await stat(file.path);
    if (size > MAX_FILE_BYTES)
      throw new TrainError(
        'outlook_file_too_big',
        `Metro sends Outlook files up to 3 MB for now; ${file.name} is ${(size / 1024 / 1024).toFixed(1)} MB, so share a link to it instead`,
        { retryable: false },
      );
  }
}

export async function attachFile(acct: Account, draftId: string, file: OutgoingFile): Promise<string> {
  const data = await readFile(file.path);
  await graph(acct, `${messagePath(draftId)}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      '@odata.type': FILE_TYPE,
      name: file.name,
      contentType: file.mime,
      contentBytes: data.toString('base64'),
    }),
  });
  return kindOf(file.mime, file.path);
}

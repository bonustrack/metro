import { appendFile } from '@metro-labs/core/stations/attachments';
import type { CanonicalAttachment } from '@metro-labs/core/stations/types';

export interface OutgoingFile {
  path: string;
  name: string;
  kind: string;
}

type WireAttachment = CanonicalAttachment & { kind?: string };

const basenameOf = (path: string, index: number): string =>
  path.split('/').pop() ?? `file-${index}`;

export function outgoingFiles(attachments: unknown): OutgoingFile[] {
  if (!Array.isArray(attachments)) return [];
  const out: OutgoingFile[] = [];
  (attachments as WireAttachment[]).forEach((a, i) => {
    const path = a.path;
    if (path === undefined || path === '') return;
    out.push({
      path,
      name: a.name !== undefined && a.name !== '' ? a.name : basenameOf(path, i),
      kind: a.kind ?? 'file',
    });
  });
  return out;
}

export async function appendFiles(
  form: FormData,
  files: OutgoingFile[],
): Promise<string[]> {
  const delivered: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    await appendFile(form, `files[${i}]`, file.path, file.name);
    delivered.push(file.kind);
  }
  return delivered;
}

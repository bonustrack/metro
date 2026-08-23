import { appendFile } from '@metro-labs/mcp/stations/attachments';

export interface OutgoingFile {
  path: string;
  name: string;
  kind: string;
}

const basenameOf = (path: string, index: number): string =>
  path.split('/').pop() ?? `file-${index}`;

export function outgoingFiles(
  paths: string[],
  names: string[] | undefined,
  kinds: string[] | undefined,
): OutgoingFile[] {
  const out: OutgoingFile[] = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (path === undefined || path === '') continue;
    const given = names?.[i];
    out.push({
      path,
      name: given !== undefined && given !== '' ? given : basenameOf(path, i),
      kind: kinds?.[i] ?? 'file',
    });
  }
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

import { readFileSync } from 'node:fs';
import { resolveCachedAttachment } from '../stations/attachments.js';
import { writeSecure } from './secure-fs.js';

function ownerPath(name: string): string | null {
  const path = resolveCachedAttachment(name);
  return path === null ? null : `${path}.owner`;
}

export function recordAttachmentOwner(name: string, agentId: number): void {
  const path = ownerPath(name);
  if (path === null) return;
  writeSecure(path, `${agentId}\n`);
}

export function attachmentOwner(name: string): number | undefined {
  const path = ownerPath(name);
  if (path === null) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const agentId = Number(raw.trim());
  return Number.isInteger(agentId) && agentId > 0 ? agentId : undefined;
}

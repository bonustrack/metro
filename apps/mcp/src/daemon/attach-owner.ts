import { readFileSync } from 'node:fs';
import { resolveCachedAttachment } from '../stations/attachments.js';
import { writeSecure } from './secure-fs.js';

const OWNER_SUFFIX = '.owner';

export function recordOwner(path: string, agentId: number): void {
  writeSecure(`${path}${OWNER_SUFFIX}`, `${agentId}\n`);
}

export function ownerOf(path: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(`${path}${OWNER_SUFFIX}`, 'utf8');
  } catch {
    return undefined;
  }
  const agentId = Number(raw.trim());
  return Number.isInteger(agentId) && agentId > 0 ? agentId : undefined;
}

export function recordAttachmentOwner(name: string, agentId: number): void {
  const path = resolveCachedAttachment(name);
  if (path === null) return;
  recordOwner(path, agentId);
}

export function attachmentOwner(name: string): number | undefined {
  const path = resolveCachedAttachment(name);
  return path === null ? undefined : ownerOf(path);
}

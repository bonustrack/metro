import { readFileSync } from 'node:fs';
import { ID_RE } from '../db/ids.js';
import { resolveCachedAttachment } from '../stations/attachments.js';
import { writeSecure } from './secure-fs.js';

const OWNER_SUFFIX = '.owner';

export function recordOwner(path: string, agentId: string): void {
  writeSecure(`${path}${OWNER_SUFFIX}`, `${agentId}\n`);
}

export function ownerOf(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(`${path}${OWNER_SUFFIX}`, 'utf8');
  } catch {
    return undefined;
  }
  const agentId = raw.trim();
  return ID_RE.test(agentId) ? agentId : undefined;
}

export function recordAttachmentOwner(name: string, agentId: string): void {
  const path = resolveCachedAttachment(name);
  if (path === null) return;
  recordOwner(path, agentId);
}

export function attachmentOwner(name: string): string | undefined {
  const path = resolveCachedAttachment(name);
  return path === null ? undefined : ownerOf(path);
}

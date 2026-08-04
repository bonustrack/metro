import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveCachedAttachment } from '../stations/attachments.js';
import { writeSecure } from './secure-fs.js';

const GRANT_SUFFIX = '.grant';

export interface AttachmentGrant {
  token: string;
  agentId: number;
  mintedAt: number;
}

function grantPath(name: string): string | null {
  const path = resolveCachedAttachment(name);
  return path === null ? null : `${path}${GRANT_SUFFIX}`;
}

export function newAttachmentToken(): string {
  return `at_${randomBytes(32).toString('base64url')}`;
}

function parseGrant(raw: string): AttachmentGrant | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { token, agentId, mintedAt } = parsed as Record<string, unknown>;
  if (typeof token !== 'string' || token === '') return undefined;
  if (typeof agentId !== 'number' || !Number.isInteger(agentId) || agentId <= 0)
    return undefined;
  return {
    token,
    agentId,
    mintedAt: typeof mintedAt === 'number' ? mintedAt : 0,
  };
}

export function readAttachmentGrant(name: string): AttachmentGrant | undefined {
  const path = grantPath(name);
  if (path === null) return undefined;
  try {
    return parseGrant(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function issueAttachmentGrant(
  name: string,
  agentId: number,
): string | undefined {
  const path = grantPath(name);
  if (path === null) return undefined;
  const existing = readAttachmentGrant(name);
  if (existing?.agentId === agentId) return existing.token;
  const grant: AttachmentGrant = {
    token: newAttachmentToken(),
    agentId,
    mintedAt: Date.now(),
  };
  writeSecure(path, `${JSON.stringify(grant)}\n`);
  return grant.token;
}

function sameToken(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function grantAllows(
  name: string,
  owner: number,
  presented: string,
): boolean {
  if (presented === '') return false;
  const grant = readAttachmentGrant(name);
  if (grant === undefined) return false;
  if (grant.agentId !== owner) return false;
  return sameToken(presented, grant.token);
}

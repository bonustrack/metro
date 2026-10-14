import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ensureSecureDir } from '@metro-labs/core/secure-fs';
import { agentKeyId, rawPublicKey } from '@metro-labs/http/agent-signature';
import { ApiError } from '@metro-labs/http/api-error';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import { agentsDir } from '../agents/files.js';

const FILE = 'agent-key.json';

export interface Enrollment {
  server: string;
  organization: string;
  at: string;
}

export interface AgentKey {
  keyId: string;
  signingKey: string;
  signing: KeyObject;
  enrollment: Enrollment | null;
}

const pathOf = (dir: string): string => join(dir, FILE);

function privateSigningKey(raw: unknown): KeyObject | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const key = createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function enrollmentOf(raw: unknown): Enrollment | null {
  if (!isRecord(raw) || typeof raw.organization !== 'string' || typeof raw.at !== 'string') return null;
  const server = parseId(raw.server);
  return server !== null && isOrganizationId(raw.organization) ? { server, organization: raw.organization, at: raw.at } : null;
}

function agentKeyOf(signing: KeyObject, enrollment: Enrollment | null): AgentKey {
  const signingKey = rawPublicKey(createPublicKey(signing));
  return { keyId: agentKeyId(signingKey), signingKey, signing, enrollment };
}

const unreadable = (): null => {
  log.warn('agent-key.json: Metro cannot read this agent key, so the agent must be enrolled again');
  return null;
};

function storedOf(path: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return unreadable();
  }
  return isRecord(parsed) ? parsed : unreadable();
}

function keyOf(stored: Record<string, unknown> | null): AgentKey | null {
  if (stored === null) return null;
  const signing = privateSigningKey(stored.signing);
  if (stored.version !== 1 || signing === null) return unreadable();
  return agentKeyOf(signing, enrollmentOf(stored.enrollment));
}

export function readAgentKey(dir = agentsDir()): AgentKey | null {
  const path = existsSync(pathOf(dir)) ? pathOf(dir) : join(dir, 'box-key.json');
  return existsSync(path) ? keyOf(storedOf(path)) : null;
}

const pendingPath = (dir: string): string => join(dir, 'agent-key.pending.json');

function pendingFields(stored: Record<string, unknown> | null): { owner: string; ticketHash: string; expectedServer: string | null } {
  if (typeof stored?.ticketHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(stored.ticketHash) || typeof stored.owner !== 'string' || !isOrganizationId(stored.owner)) {
    throw new ApiError('Metro cannot read the pending enrollment key. Restore its file or permissions before enrolling again.', 503);
  }
  const expectedServer = stored.expectedServer === undefined ? null : parseId(stored.expectedServer);
  if (stored.expectedServer !== undefined && expectedServer === null) throw new ApiError('Metro cannot read the pending enrollment identity. Restore its file before enrolling again.', 503);
  return { owner: stored.owner, ticketHash: stored.ticketHash, expectedServer };
}

export function readPendingAgentKey(owner: string, dir: string): (AgentKey & { ticketHash: string; expectedServer: string | null }) | null {
  if (!existsSync(pendingPath(dir))) return null;
  const stored = storedOf(pendingPath(dir));
  const fields = pendingFields(stored);
  const key = keyOf(stored);
  if (key === null) throw new ApiError('Metro cannot read the pending enrollment key. Restore its file or permissions before enrolling again.', 503);
  return fields.owner === owner ? { ...key, ticketHash: fields.ticketHash, expectedServer: fields.expectedServer } : null;
}

function flush(path: string): void {
  const file = openSync(path, 'r');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function writeKey(path: string, stored: Record<string, unknown>): void {
  const dir = dirname(path);
  ensureSecureDir(dir);
  const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const file = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temp, path);
    flush(dir);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function clearPendingAgentKey(dir: string): void {
  rmSync(pendingPath(dir), { force: true });
  flush(dir);
}

export function newAgentKey(): AgentKey {
  return agentKeyOf(generateKeyPairSync('ed25519').privateKey, null);
}

const exported = (key: KeyObject): string => key.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const privateKeys = (key: AgentKey): Record<string, unknown> => ({ version: 1, signing: exported(key.signing) });

export function savePendingAgentKey(key: AgentKey, owner: string, ticketHash: string, dir: string, expectedServer?: string): void {
  writeKey(pendingPath(dir), { ...privateKeys(key), owner, ticketHash, ...(expectedServer === undefined ? {} : { expectedServer }) });
}

export function saveAgentKey(key: AgentKey, enrollment: Enrollment, dir = agentsDir()): void {
  writeKey(pathOf(dir), { ...privateKeys(key), enrollment });
}

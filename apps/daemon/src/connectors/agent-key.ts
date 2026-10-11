import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { agentKeyId, rawPublicKey } from '@metro-labs/http/agent-signature';
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
  sealingKey: string;
  signing: KeyObject;
  sealing: KeyObject;
  enrollment: Enrollment | null;
}

const pathOf = (dir: string): string => join(dir, FILE);

function privateKeyOf(raw: unknown, type: 'ed25519' | 'x25519'): KeyObject | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const key = createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
    return key.asymmetricKeyType === type ? key : null;
  } catch {
    return null;
  }
}

function enrollmentOf(raw: unknown): Enrollment | null {
  if (!isRecord(raw) || typeof raw.organization !== 'string' || typeof raw.at !== 'string') return null;
  const server = parseId(raw.server);
  return server !== null && isOrganizationId(raw.organization) ? { server, organization: raw.organization, at: raw.at } : null;
}

function agentKeyOf(signing: KeyObject, sealing: KeyObject, enrollment: Enrollment | null): AgentKey {
  const signingKey = rawPublicKey(createPublicKey(signing));
  return { keyId: agentKeyId(signingKey), signingKey, sealingKey: rawPublicKey(createPublicKey(sealing)), signing, sealing, enrollment };
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

export function readAgentKey(dir = agentsDir()): AgentKey | null {
  const path = existsSync(pathOf(dir)) ? pathOf(dir) : join(dir, 'box-key.json');
  if (!existsSync(path)) return null;
  const stored = storedOf(path);
  if (stored === null) return null;
  const signing = privateKeyOf(stored.signing, 'ed25519');
  const sealing = privateKeyOf(stored.sealing, 'x25519');
  if (stored.version !== 1 || signing === null || sealing === null) return unreadable();
  return agentKeyOf(signing, sealing, enrollmentOf(stored.enrollment));
}

export function newAgentKey(): AgentKey {
  return agentKeyOf(generateKeyPairSync('ed25519').privateKey, generateKeyPairSync('x25519').privateKey, null);
}

const exported = (key: KeyObject): string => key.export({ format: 'der', type: 'pkcs8' }).toString('base64');

export function saveAgentKey(key: AgentKey, enrollment: Enrollment, dir = agentsDir()): void {
  const stored = { version: 1, signing: exported(key.signing), sealing: exported(key.sealing), enrollment };
  writeSecure(pathOf(dir), `${JSON.stringify(stored, null, 2)}\n`);
}

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { boxKeyId, rawPublicKey } from '@metro-labs/http/box-signature';
import { isOrganizationId } from '@metro-labs/http/workos-token';
import { agentsDir } from '../agents/files.js';

const FILE = 'box-key.json';

export interface Enrollment {
  server: string;
  organization: string;
  at: string;
}

export interface BoxKey {
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

function boxKeyOf(signing: KeyObject, sealing: KeyObject, enrollment: Enrollment | null): BoxKey {
  const signingKey = rawPublicKey(createPublicKey(signing));
  return { keyId: boxKeyId(signingKey), signingKey, sealingKey: rawPublicKey(createPublicKey(sealing)), signing, sealing, enrollment };
}

const unreadable = (): null => {
  log.warn('box-key.json: Metro cannot read this box key, so the box must be enrolled again');
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

export function readBoxKey(dir = agentsDir()): BoxKey | null {
  if (!existsSync(pathOf(dir))) return null;
  const stored = storedOf(pathOf(dir));
  if (stored === null) return null;
  const signing = privateKeyOf(stored.signing, 'ed25519');
  const sealing = privateKeyOf(stored.sealing, 'x25519');
  if (stored.version !== 1 || signing === null || sealing === null) return unreadable();
  return boxKeyOf(signing, sealing, enrollmentOf(stored.enrollment));
}

export function newBoxKey(): BoxKey {
  return boxKeyOf(generateKeyPairSync('ed25519').privateKey, generateKeyPairSync('x25519').privateKey, null);
}

const exported = (key: KeyObject): string => key.export({ format: 'der', type: 'pkcs8' }).toString('base64');

export function saveBoxKey(key: BoxKey, enrollment: Enrollment, dir = agentsDir()): void {
  const stored = { version: 1, signing: exported(key.signing), sealing: exported(key.sealing), enrollment };
  writeSecure(pathOf(dir), `${JSON.stringify(stored, null, 2)}\n`);
}

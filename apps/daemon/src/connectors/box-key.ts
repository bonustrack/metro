import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { boxKeyId, rawPublicKey } from '@metro-labs/http/box-signature';
import { parseId } from '@metro-labs/core/ids';
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

interface StoredKey {
  version: 1;
  signing: string;
  sealing: string;
  createdAt: string;
  enrollment?: Enrollment;
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

function boxKeyOf(stored: StoredKey, signing: KeyObject, sealing: KeyObject): BoxKey {
  const signingKey = rawPublicKey(createPublicKey(signing));
  return {
    keyId: boxKeyId(signingKey),
    signingKey,
    sealingKey: rawPublicKey(createPublicKey(sealing)),
    signing,
    sealing,
    enrollment: stored.enrollment ?? null,
  };
}

function readStored(dir: string): StoredKey | null {
  const raw = readJson<unknown>(pathOf(dir), null, { warn: 'box-key.json: malformed, ignoring' });
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.signing !== 'string' || typeof raw.sealing !== 'string') return null;
  const enrollment = enrollmentOf(raw.enrollment);
  return { version: 1, signing: raw.signing, sealing: raw.sealing, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '', ...(enrollment === null ? {} : { enrollment }) };
}

export function readBoxKey(dir = agentsDir()): BoxKey | null {
  const stored = readStored(dir);
  if (stored === null) return null;
  const signing = privateKeyOf(stored.signing, 'ed25519');
  const sealing = privateKeyOf(stored.sealing, 'x25519');
  if (signing === null || sealing === null) {
    log.warn('box-key.json: its keys cannot be read, ignoring');
    return null;
  }
  return boxKeyOf(stored, signing, sealing);
}

const exported = (key: KeyObject): string => key.export({ format: 'der', type: 'pkcs8' }).toString('base64');

export function ensureBoxKey(dir = agentsDir()): BoxKey {
  const held = readBoxKey(dir);
  if (held !== null) return held;
  if (existsSync(pathOf(dir))) log.warn('box-key.json: replacing a key Metro cannot read, this box must be enrolled again');
  const signing = generateKeyPairSync('ed25519').privateKey;
  const sealing = generateKeyPairSync('x25519').privateKey;
  const stored: StoredKey = { version: 1, signing: exported(signing), sealing: exported(sealing), createdAt: new Date().toISOString() };
  writeSecure(pathOf(dir), `${JSON.stringify(stored, null, 2)}\n`);
  const made = boxKeyOf(stored, signing, sealing);
  log.info({ keyId: made.keyId }, 'box-key: made this box its key pair');
  return made;
}

export function saveEnrollment(key: BoxKey, enrollment: Enrollment, dir = agentsDir()): void {
  const stored = readStored(dir);
  if (stored === null || readBoxKey(dir)?.keyId !== key.keyId) throw new Error('box-key.json changed while this box was enrolling');
  writeSecure(pathOf(dir), `${JSON.stringify({ ...stored, enrollment }, null, 2)}\n`);
}

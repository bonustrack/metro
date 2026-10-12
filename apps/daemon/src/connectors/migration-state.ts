import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { parseId } from '@metro-labs/core/ids';
import { ensureSecureDir } from '@metro-labs/core/secure-fs';
import { ApiError } from '@metro-labs/http/api-error';
import { connectorPolicyOf, type ConnectorPolicy } from '@metro-labs/http/connector-delivery';
import { publicOAuthResource } from '@metro-labs/http/connector-public-url';
import { agentsDir } from '../agents/files.js';
import { captureMigrationOperations } from './migration-operations.js';

export type MigrationPhase = 'recovering' | 'freezing' | 'preparing' | 'prepared' | 'cutover' | 'active' | 'rollback' | 'rolled_back';
export type MigrationAuth = 'none' | 'header' | 'oauth';

export interface MigrationRecord {
  id: string;
  owner: string;
  agentId: string;
  keyId: string;
  sourceId: string;
  name: string;
  destinationId: string | null;
  phase: MigrationPhase;
  auth: MigrationAuth;
  oauthResource?: string;
  move?: boolean;
  grantImported?: boolean;
  captured?: boolean;
  recoveryReceipt?: string;
  sourceStamp: string;
  policy: ConnectorPolicy;
  reason: string | null;
}

const phases: readonly MigrationPhase[] = ['recovering', 'freezing', 'preparing', 'prepared', 'cutover', 'active', 'rollback', 'rolled_back'];
const auths: readonly MigrationAuth[] = ['none', 'header', 'oauth'];
const fields = ['id', 'owner', 'agentId', 'keyId', 'sourceId', 'name', 'destinationId', 'phase', 'auth', 'oauthResource', 'sourceStamp', 'policy', 'reason', 'move', 'grantImported', 'captured', 'recoveryReceipt'];
const unavailable = (): ApiError => new ApiError('Protected connector migration records cannot be read. Restore their file or permissions before using connectors.', 503);
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const pathOf = (dir: string): string => join(dir, 'connector-migrations.json');
const markerOf = (dir: string): string => join(dir, 'connector-migrations.initialized');

function requiredId(value: unknown): string {
  const id = parseId(value);
  if (id === null) throw unavailable();
  return id;
}

function field(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw unavailable();
  return value;
}

function movementOf(value: Record<string, unknown>): Pick<MigrationRecord, 'move' | 'grantImported' | 'captured' | 'recoveryReceipt'> {
  const result: Pick<MigrationRecord, 'move' | 'grantImported' | 'captured' | 'recoveryReceipt'> = {};
  for (const key of ['move', 'grantImported', 'captured'] as const) {
    const flag = value[key];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') throw unavailable();
    result[key] = flag;
  }
  if (value.recoveryReceipt !== undefined) result.recoveryReceipt = field(value.recoveryReceipt, /^[a-f0-9]{64}$/);
  return result;
}

function recordOf(value: unknown): MigrationRecord {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) throw unavailable();
  const phase = phases.find((item) => item === value.phase);
  const auth = auths.find((item) => item === value.auth);
  if (phase === undefined || auth === undefined || (value.oauthResource !== undefined && auth !== 'oauth')) throw unavailable();
  return {
    ...movementOf(value),
    ...(value.oauthResource === undefined ? {} : { oauthResource: publicOAuthResource(value.oauthResource) }),
    id: requiredId(value.id), sourceId: requiredId(value.sourceId), agentId: requiredId(value.agentId),
    owner: field(value.owner, /^org_[A-Za-z0-9]{1,128}$/), keyId: field(value.keyId, DIGEST), sourceStamp: field(value.sourceStamp, DIGEST),
    name: field(value.name, /^.{1,200}$/), destinationId: value.destinationId === null ? null : requiredId(value.destinationId),
    phase, auth, policy: connectorPolicyOf(value.policy), reason: value.reason === null ? null : field(value.reason, /^[a-z_]{1,64}$/),
  };
}

function recordsOf(text: string): MigrationRecord[] {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records) || value.records.length > 500) throw unavailable();
  const records = value.records.map(recordOf);
  if (new Set(records.map((record) => record.sourceId)).size !== records.length) throw unavailable();
  return records;
}

export function migrationRecords(dir = agentsDir()): MigrationRecord[] {
  try {
    const marked = existsSync(markerOf(dir));
    if (marked && readFileSync(markerOf(dir), 'utf8') !== '1\n') throw unavailable();
    if (!existsSync(pathOf(dir))) {
      if (marked) throw unavailable();
      return [];
    }
    if (!marked) throw unavailable();
    return recordsOf(readFileSync(pathOf(dir), 'utf8'));
  } catch {
    throw unavailable();
  }
}

export function migrationRecord(id: string, dir = agentsDir()): MigrationRecord | null {
  return migrationRecords(dir).find((record) => record.sourceId === id) ?? null;
}

function flush(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function markInitialized(dir: string): void {
  const path = markerOf(dir);
  if (existsSync(path)) return;
  writeFileSync(path, '1\n', { flag: 'wx', mode: 0o600 });
  flush(path);
  flush(dir);
}

export function saveMigration(record: MigrationRecord, dir = agentsDir()): void {
  const valid = recordOf(record);
  const previous = migrationRecords(dir);
  const rows = previous.filter((row) => row.sourceId !== valid.sourceId);
  if (rows.length >= 500) throw new ApiError('There are too many connector migrations on this agent.', 409);
  rows.push(valid);
  ensureSecureDir(dir);
  markInitialized(dir);
  captureMigrationOperations(valid.sourceId, dir, !previous.some((row) => row.sourceId === valid.sourceId));
  const path = pathOf(dir);
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify({ version: 1, records: rows })}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, path);
    flush(dir);
  } finally { rmSync(temporary, { force: true }); }
}

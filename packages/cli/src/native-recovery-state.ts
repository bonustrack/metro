import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord, processAlive } from './background.js';

export const NATIVE_TASK_MAX = 256;
export const NATIVE_FILE_MAX = 16;
export const NATIVE_CURSOR_MAX = 256;
export const NATIVE_NOTICE_MAX = 512;
export const NATIVE_STATE_BYTES = 512 * 1024;
export const nativeToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
export const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export type NativeTaskStatus = 'started' | 'completed' | 'failed' | 'stopped' | 'restarted';
export interface NativeTask {
  id: string;
  source: string | null;
  tool: string;
  kind: 'Agent' | 'SendMessage';
  agent: string | null;
  at: number;
  updatedAt: number;
  state: NativeTaskStatus;
  receipt: string;
}
export interface NativeNotice {
  id: string;
  task: string | null;
  reason: 'interrupted' | 'failed' | 'restarted' | 'incomplete';
  attempts: number;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
}
export interface NativeCursor { agent: string | null; offset: number }
export interface NativeRecoveryState {
  version: 1;
  owner: string;
  tasks: NativeTask[];
  notices: NativeNotice[];
  files: NativeCursor[];
}

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullable = (value: unknown, valid: (v: unknown) => boolean): boolean => value === null || valid(value);
const keys = (value: Record<string, unknown>, fields: string[]): boolean => Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
const statuses = new Set<unknown>(['started', 'completed', 'failed', 'stopped', 'restarted']);
const reasons = new Set<unknown>(['interrupted', 'failed', 'restarted', 'incomplete']);

function taskFields(value: Record<string, unknown>): boolean {
  return nullable(value.source, nativeToken) && nativeToken(value.tool) && (value.kind === 'Agent' || value.kind === 'SendMessage')
    && nullable(value.agent, nativeToken) && statuses.has(value.state) && nativeToken(value.receipt);
}

function task(value: unknown): value is NativeTask {
  return isRecord(value) && keys(value, ['id', 'source', 'tool', 'kind', 'agent', 'at', 'updatedAt', 'state', 'receipt']) && nativeId(value.id)
    && integer(value.at) && integer(value.updatedAt) && value.updatedAt >= value.at && taskFields(value);
}

function noticeTimes(value: Record<string, unknown>): boolean {
  if (!nullable(value.deliveredAt, integer) || !nullable(value.acknowledgedAt, integer)) return false;
  if (value.attempts === 0) return value.deliveredAt === null && value.acknowledgedAt === null;
  if (typeof value.deliveredAt !== 'number') return false;
  return value.acknowledgedAt === null || (typeof value.acknowledgedAt === 'number' && value.acknowledgedAt >= value.deliveredAt);
}

function notice(value: unknown): value is NativeNotice {
  return isRecord(value) && keys(value, ['id', 'task', 'reason', 'attempts', 'deliveredAt', 'acknowledgedAt']) && nativeId(value.id)
    && nullable(value.task, nativeId) && reasons.has(value.reason) && integer(value.attempts) && value.attempts <= 3 && noticeTimes(value);
}

function cursor(value: unknown): value is NativeCursor {
  return isRecord(value) && keys(value, ['agent', 'offset']) && nullable(value.agent, nativeToken) && integer(value.offset);
}

function rows<T>(value: unknown, max: number, valid: (v: unknown) => v is T, key: (v: T) => unknown): value is T[] {
  return Array.isArray(value) && value.length <= max && value.every(valid) && new Set(value.map(key)).size === value.length;
}

function validState(value: unknown, owner: string): value is NativeRecoveryState {
  if (!isRecord(value) || !keys(value, ['version', 'owner', 'tasks', 'notices', 'files']) || value.version !== 1 || value.owner !== owner) return false;
  const { tasks, notices, files } = value;
  return rows(tasks, NATIVE_TASK_MAX, task, (v) => v.id) && rows(notices, NATIVE_NOTICE_MAX, notice, (v) => v.id)
    && rows(files, NATIVE_CURSOR_MAX, cursor, (v) => v.agent)
    && notices.every((row) => row.task === null || tasks.some((entry) => entry.id === row.task));
}

function readStateBytes(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > NATIVE_STATE_BYTES) throw new Error('state exceeds its size bound');
    const buffer = Buffer.alloc(NATIVE_STATE_BYTES + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== stat.size || fstatSync(fd).size !== stat.size) throw new Error('state changed while reading');
    return buffer.subarray(0, count).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readNativeState(path: string, owner: string): NativeRecoveryState {
  try {
    const raw: unknown = JSON.parse(readStateBytes(path));
    if (!validState(raw, owner)) throw new Error('state does not match its schema');
    return raw;
  } catch (err) {
    if (isRecord(err) && err.code === 'ENOENT') return { version: 1, owner, tasks: [], notices: [], files: [] };
    throw new Error('Native recovery state cannot be read safely. Restore it before resuming; it has not been overwritten.', { cause: err });
  }
}

function retireLock(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error('Native recovery lock is not a directory');
  const dir = opendirSync(path);
  let name: string | undefined;
  try {
    name = dir.readSync()?.name;
    if (dir.readSync() !== null) throw new Error('Native recovery lock has unexpected entries');
  } finally { dir.closeSync(); }
  const pid = /^(\d{1,10})-[a-f0-9-]{36}$/.exec(name ?? '')?.[1];
  if (pid === undefined || Number(pid) < 1 || processAlive(Number(pid))) throw new Error('Native recovery preparation is locked. Restore an unreadable lock before resuming.');
  unlinkSync(join(path, name ?? ''));
  rmdirSync(path);
}

export function withNativeStateLock<T>(path: string, work: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); } catch (err) {
    if (!isRecord(err) || err.code !== 'EEXIST') throw err;
    retireLock(lock);
    mkdirSync(lock, { mode: 0o700 });
  }
  const owner = join(lock, `${String(process.pid)}-${randomUUID()}`);
  writeFileSync(owner, '', { flag: 'wx', mode: 0o600 });
  try { return work(); } finally { unlinkSync(owner); rmdirSync(lock); }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function saveNativeState(path: string, state: NativeRecoveryState): void {
  const text = JSON.stringify(state);
  if (!validState(state, state.owner) || Buffer.byteLength(text) > NATIVE_STATE_BYTES) throw new Error('Native recovery state exceeds its bounds; it has not been overwritten.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(tmp, { force: true });
  }
}

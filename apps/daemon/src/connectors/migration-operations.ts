import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { parseId } from '@metro-labs/core/ids';
import { ensureSecureDir, writeSecure } from '@metro-labs/core/secure-fs';
import { ApiError } from '@metro-labs/http/api-error';
import { agentsDir } from '../agents/files.js';

interface RequestOperation {
  id: string;
  source: string;
  dir: string;
  lease: string;
  durable: boolean;
  abandoned: boolean;
  refresh: boolean;
}

export interface MigrationOperation {
  dispatch: (send: () => Promise<Response>, options?: { protectedSource?: boolean; effectful?: boolean; refresh?: boolean }) => Promise<Response>;
  close: () => void;
  persistedRefresh: () => void;
}

const leases = new Map<string, Set<string>>();
const requests = new Map<string, RequestOperation>();
const held = new Map<string, RequestOperation>();
const keyOf = (source: string, dir: string): string => JSON.stringify([resolve(dir), source]);
const unavailable = (): ApiError => new ApiError('Protected connector request records cannot be read. Restore their files before using this connector.', 503);
const uncertain = (): ApiError => new ApiError('A previous connector request has an unknown outcome. Inspect the vendor and acknowledge it before continuing. Do not retry the tool.', 409);
const CONTROL = new Set(['initialize', 'ping', 'tools/list', 'notifications/initialized', 'notifications/cancelled']);

export function migrationRequestEffectful(method: string | undefined, body: unknown): boolean {
  const verb = (method ?? 'GET').toUpperCase();
  if (['GET', 'HEAD', 'DELETE'].includes(verb)) return false;
  if (verb !== 'POST') return true;
  const text = typeof body === 'string' ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : null;
  if (text === null) return true;
  try {
    const value: unknown = JSON.parse(text);
    const batch: unknown[] = Array.isArray(value) ? value : [value];
    return batch.length === 0 || batch.some((item) => !isRecord(item) || item.jsonrpc !== '2.0' || typeof item.method !== 'string' || !CONTROL.has(item.method));
  } catch { return true; }
}

function paths(source: string, dir: string): { data: string; marker: string } {
  if (parseId(source) === null) throw unavailable();
  const data = join(dir, `connector-migration-operations-${source}.json`);
  return { data, marker: `${data}.initialized` };
}

function flush(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function pendingOf(text: string): string[] {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > 10_000) throw unavailable();
  const ids: unknown[] = value.pending;
  if (!ids.every((id): id is string => typeof id === 'string' && /^r?[a-f0-9]{32}$/.test(id))) throw unavailable();
  if (new Set(ids).size !== ids.length) throw unavailable();
  return ids;
}

function readPending(source: string, dir: string, initialize = false): string[] {
  const { data, marker } = paths(source, dir);
  try {
    if (initialize && !existsSync(data) && !existsSync(marker)) return [];
    if (readFileSync(marker, 'utf8') !== '1\n') throw unavailable();
    return pendingOf(readFileSync(data, 'utf8'));
  } catch { throw unavailable(); }
}

function writePending(source: string, dir: string, pending: string[]): void {
  const { data, marker } = paths(source, dir);
  ensureSecureDir(dir);
  if (!existsSync(marker)) {
    writeFileSync(marker, '1\n', { flag: 'wx', mode: 0o600 });
    flush(marker);
    flush(dir);
  }
  writeSecure(data, `${JSON.stringify({ version: 1, pending })}\n`);
  flush(data);
  flush(dir);
}

export function captureMigrationOperations(source: string, dir: string, initialize: boolean): void {
  const pending = new Set(readPending(source, dir, initialize));
  const active = [...held.values()].filter((request) => keyOf(request.source, request.dir) === keyOf(source, dir));
  for (const request of active) pending.add(request.id);
  writePending(source, dir, [...pending]);
  for (const request of active) request.durable = true;
}

export function migrationUncertaintyReceipt(source: string, dir = agentsDir()): string | null {
  const unknown = readPending(source, dir).filter((id) => !requests.has(id)).sort();
  return unknown.length === 0 ? null : createHash('sha256').update(JSON.stringify([1, source, unknown])).digest('hex');
}

export function assertMigrationOutcomeKnown(source: string, dir = agentsDir()): void {
  if (migrationUncertaintyReceipt(source, dir) !== null) throw uncertain();
}

export function migrationOperationsIdle(source: string, dir: string, protectedSource: boolean): boolean {
  if (leases.has(keyOf(source, dir))) return false;
  return !protectedSource || readPending(source, dir).length === 0;
}

export function resolveMigrationUncertainty(source: string, expectedReceipt: string, dir = agentsDir()): boolean {
  if (leases.has(keyOf(source, dir))) return false;
  const receipt = migrationUncertaintyReceipt(source, dir);
  if (receipt === null || receipt !== expectedReceipt) return false;
  writePending(source, dir, []);
  return true;
}

function finish(request: RequestOperation, completed: boolean, persisted = false): void {
  if (request.refresh && completed && !persisted) return;
  if (request.abandoned) return;
  requests.delete(request.id);
  if (completed) held.delete(request.id);
  if (completed && request.durable) writePending(request.source, request.dir, readPending(request.source, request.dir).filter((id) => id !== request.id));
  request.abandoned = true;
}

function observed(response: Response, request: RequestOperation): Response {
  if (response.status === 401 || response.status === 403) {
    finish(request, true);
    return response;
  }
  if (response.body === null) {
    finish(request, response.ok);
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish(request, response.ok);
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        finish(request, false);
        controller.error(error);
      }
    },
    async cancel(reason: unknown) {
      finish(request, false);
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function dispatch(source: string, dir: string, lease: string, protectedSource: boolean, effectful: boolean, refresh: boolean, send: () => Promise<Response>): Promise<Response> {
  if (protectedSource) assertMigrationOutcomeKnown(source, dir);
  if (!effectful) return send();
  const request: RequestOperation = { id: `${refresh ? 'r' : ''}${randomBytes(16).toString('hex')}`, source, dir, lease, durable: false, abandoned: false, refresh };
  if (protectedSource) {
    const pending = readPending(source, dir);
    if (pending.length >= 10_000) throw unavailable();
    writePending(source, dir, [...pending, request.id]);
    request.durable = true;
  }
  requests.set(request.id, request);
  held.set(request.id, request);
  try { return observed(await send(), request); }
  catch (error) { finish(request, false); throw error; }
}

export function beginMigrationOperation(source: string, dir: string, protectedSource: boolean): MigrationOperation {
  if (protectedSource) assertMigrationOutcomeKnown(source, dir);
  const key = keyOf(source, dir);
  const lease = randomBytes(16).toString('hex');
  const active = leases.get(key) ?? new Set<string>();
  active.add(lease);
  leases.set(key, active);
  let closed = false;
  return {
    dispatch: (send, options = {}) => {
      if (closed) return Promise.reject(uncertain());
      return dispatch(source, dir, lease, options.protectedSource ?? protectedSource, options.effectful ?? true, options.refresh ?? false, send);
    },
    persistedRefresh: () => {
      for (const request of held.values()) if (request.lease === lease && request.refresh) finish(request, true, true);
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const request of held.values()) if (request.lease === lease) {
        finish(request, false);
        held.delete(request.id);
      }
      active.delete(lease);
      if (active.size === 0) leases.delete(key);
    },
  };
}

export function migrationRefreshUncertain(source: string, dir = agentsDir()): boolean {
  return readPending(source, dir).some((id) => id.startsWith('r') && !requests.has(id));
}

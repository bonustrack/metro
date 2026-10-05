import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bufferedSince, BUS_BUFFER_MAX, currentBusSeq, type BufferedEvent, type RunEvent, type RunEventsPage } from '@metro-labs/core/events';
import { ID_RE } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { sessionRoute } from '@metro-labs/http/api-http';
import { accountEnabled, allowlistForAccount, knownAccounts, knownAgentIds } from '../agents/map.js';
import { runEvent } from './run-event.js';

const EPOCH = randomUUID();
const DEFAULT_LIMIT = 100;
const PAGE_BYTES_MAX = 1_000_000;
const CURSOR_RE = /^([a-f0-9-]{36}):([a-f0-9]{64}):(0|[1-9]\d{0,15})$/;

interface Cursor { epoch: string; policy: string; seq: number }
interface Query { agentId: string; limit: number; cursor: Cursor | null }

function cursorOf(raw: string | null): Cursor | null {
  if (raw === null) return null;
  const match = CURSOR_RE.exec(raw);
  if (!match || !Number.isSafeInteger(Number(match[3]))) throw new ApiError('invalid run events cursor', 400);
  return { epoch: match[1] ?? '', policy: match[2] ?? '', seq: Number(match[3]) };
}

function limitOf(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!/^[1-9]\d{0,2}$/.test(raw) || limit > BUS_BUFFER_MAX) throw new ApiError('limit must be between 1 and 500', 400);
  return limit;
}

function queryOf(url: string): Query {
  const params = new URL(url, 'http://localhost').searchParams;
  for (const key of params.keys()) {
    if (!['agent', 'limit', 'cursor'].includes(key) || params.getAll(key).length !== 1) throw new ApiError('invalid run events query', 400);
  }
  const agentId = params.get('agent') ?? '';
  if (!ID_RE.test(agentId)) throw new ApiError('agent must be an agent id', 400);
  return { agentId, limit: limitOf(params.get('limit')), cursor: cursorOf(params.get('cursor')) };
}

function policyOf(agentId: string, owner: string): string {
  const accounts = knownAccounts().filter((account) => account.agentId === agentId).map(({ station, id }) => [
    station, id, accountEnabled(station, id), allowlistForAccount(station, id) ?? [],
  ]);
  return createHash('sha256').update(JSON.stringify([owner, agentId, accounts])).digest('hex');
}

function bounded(events: RunEvent[], limit: number): RunEvent[] {
  const rows: RunEvent[] = [];
  let bytes = 0;
  for (const event of events.slice(0, limit)) {
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (bytes > PAGE_BYTES_MAX) break;
    rows.push(event);
  }
  return rows;
}

function resetNeeded(cursor: Cursor | null, policy: string, oldest: number, newest: number): boolean {
  return cursor === null || cursor.epoch !== EPOCH || cursor.policy !== policy || cursor.seq < oldest - 1 || cursor.seq > newest;
}

function page(query: Query, owner: string): RunEventsPage {
  const { agentId, limit, cursor } = query;
  if (!knownAgentIds().includes(agentId)) throw new ApiError('no such agent', 404);
  const policy = policyOf(agentId, owner);
  const buffered = bufferedSince(0);
  const newest = currentBusSeq();
  const oldest = buffered[0]?.busSeq ?? newest + 1;
  const reset = resetNeeded(cursor, policy, oldest, newest);
  const visible = buffered.filter((entry) => reset || entry.busSeq > (cursor?.seq ?? newest)).flatMap((entry) => {
    const event = runEvent(entry, agentId);
    return event === null ? [] : [event];
  });
  const pending = reset ? visible.slice(-limit) : visible;
  const events = bounded(pending, limit);
  const hasMore = pending.length > events.length;
  return {
    events, cursor: `${EPOCH}:${policy}:${pageSeq(events, hasMore, newest)}`, hasMore, reset,
    retention: retention(buffered, agentId),
  };
}

const pageSeq = (events: RunEvent[], hasMore: boolean, newest: number): number => hasMore ? events.at(-1)?.seq ?? newest : newest;
function retention(buffered: BufferedEvent[], agentId: string): RunEventsPage['retention'] {
  let oldestAt: string | null = null;
  for (const entry of buffered) {
    const event = runEvent(entry, agentId);
    if (event === null) continue;
    oldestAt = event.ts;
    break;
  }
  return { capacity: BUS_BUFFER_MAX, oldestAt, oldestSeq: buffered[0]?.busSeq ?? null };
}

export function handleRunEventsRequest(req: IncomingMessage, res: ServerResponse): boolean {
  return sessionRoute(req, res, {
    methods: { '/api/run/events': ['GET'] }, admin: false, label: 'run-events',
  }, (session) => Promise.resolve(page(queryOf(req.url ?? ''), session.subject)));
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { RUN_STATES, type RunState } from '../db/schema.js';
import type { AgentRunInput, AgentRunRow } from '../db/agent-runs.js';
import { runLabel } from '../runs/label.js';
import { ApiError } from './api-error.js';
import {
  apiFailure,
  bodyField,
  cors,
  readJsonBody,
  sendJson,
} from './api-http.js';
import { identityScope, ownerFromScope } from './api-scope.js';
import { errMsg, log } from './log.js';

const PREFIX = '/api/agent-runs';
const BODY_MAX = 256 * 1024;
const MAX_RUNS = 200;
const MAX_ROWS = 1000;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

export interface AgentRunsDeps {
  recordRuns: (agentId: number, runs: AgentRunInput[]) => Promise<number>;
  listRuns: (
    allowed: Set<number>,
    sinceMs: number,
    limit: number,
  ) => Promise<AgentRunRow[]>;
}

let backend: AgentRunsDeps | null = null;

export function setAgentRunsBackend(deps: AgentRunsDeps | null): void {
  backend = deps;
}

function isRunState(raw: unknown): raw is RunState {
  return typeof raw === 'string' && (RUN_STATES as readonly string[]).includes(raw);
}

function text(raw: unknown, field: string, re: RegExp): string {
  if (typeof raw !== 'string' || !re.test(raw))
    throw new ApiError(`${field} is not valid`, 400);
  return raw;
}

function optionalType(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  return text(raw, 'type', TYPE_RE);
}

function count(raw: unknown, field: string): number {
  if (raw === undefined || raw === null) return 0;
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    raw > Number.MAX_SAFE_INTEGER
  )
    throw new ApiError(`${field} must be a non-negative number`, 400);
  return Math.round(raw);
}

function when(raw: unknown, field: string): Date {
  const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(ms)) throw new ApiError(`${field} must be a timestamp`, 400);
  return new Date(ms);
}

function endedAt(raw: unknown, state: RunState, startedAt: Date): Date | null {
  if (state === 'running' || raw === undefined || raw === null) return null;
  const at = when(raw, 'ended_at');
  if (at.getTime() < startedAt.getTime())
    throw new ApiError('ended_at is before started_at', 400);
  return at;
}

function parseRun(raw: unknown): AgentRunInput {
  const state = bodyField(raw, 'state');
  if (!isRunState(state))
    throw new ApiError(`state must be one of ${RUN_STATES.join(', ')}`, 400);
  const startedAt = when(bodyField(raw, 'started_at'), 'started_at');
  return {
    runId: text(bodyField(raw, 'id'), 'id', RUN_ID_RE),
    agentType: optionalType(bodyField(raw, 'type')),
    label: runLabel(bodyField(raw, 'label')),
    state,
    startedAt,
    endedAt: endedAt(bodyField(raw, 'ended_at'), state, startedAt),
    turns: count(bodyField(raw, 'turns'), 'turns'),
    inputTokens: count(bodyField(raw, 'input_tokens'), 'input_tokens'),
    outputTokens: count(bodyField(raw, 'output_tokens'), 'output_tokens'),
    cacheReadTokens: count(
      bodyField(raw, 'cache_read_tokens'),
      'cache_read_tokens',
    ),
    cacheWriteTokens: count(
      bodyField(raw, 'cache_write_tokens'),
      'cache_write_tokens',
    ),
  };
}

export function parseRuns(body: unknown): AgentRunInput[] {
  const raw = bodyField(body, 'runs');
  if (!Array.isArray(raw)) throw new ApiError('runs must be an array', 400);
  if (raw.length > MAX_RUNS)
    throw new ApiError(`send at most ${MAX_RUNS} runs per request`, 400);
  return raw.map(parseRun);
}

export function parseDays(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)
    throw new ApiError(`days must be a whole number from 1 to ${MAX_DAYS}`, 400);
  return days;
}

const iso = (at: Date | null): string | null =>
  at === null ? null : at.toISOString();

function payload(row: AgentRunRow): Record<string, unknown> {
  return {
    agent_id: row.agentId,
    id: row.runId,
    type: row.agentType,
    label: row.label,
    state: row.state,
    started_at: row.startedAt.toISOString(),
    ended_at: iso(row.endedAt),
    turns: row.turns,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
  };
}

async function handleStore(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentRunsDeps,
  allowed: Set<number>,
): Promise<void> {
  const agentId = ownerFromScope(req, allowed);
  const runs = parseRuns(await readJsonBody(req, BODY_MAX));
  const stored = await deps.recordRuns(agentId, runs);
  log.info({ agent: agentId, runs: stored }, 'agent-runs: stored');
  sendJson(req, res, 200, { stored });
}

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentRunsDeps,
  allowed: Set<number>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const days = parseDays(url.searchParams.get('days'));
  const rows = await deps.listRuns(allowed, days * DAY_MS, MAX_ROWS);
  sendJson(req, res, 200, { days, runs: rows.map(payload) });
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentRunsDeps,
): Promise<void> {
  try {
    const allowed = identityScope(req);
    if (allowed.size === 0) throw new ApiError('unauthorized', 401);
    if (req.method === 'GET') await handleList(req, res, deps, allowed);
    else await handleStore(req, res, deps, allowed);
  } catch (err) {
    apiFailure(req, res, err, 'agent-runs');
  }
}

type Target = 'collection' | 'unknown' | null;

export function target(path: string): Target {
  if (path === PREFIX || path === `${PREFIX}/`) return 'collection';
  return path.startsWith(`${PREFIX}/`) ? 'unknown' : null;
}

export function handleAgentRunsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const deps = backend;
  if (deps === null) return false;
  const tgt = target((req.url ?? '').split('?')[0] ?? '');
  if (tgt === null) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req)).end();
    return true;
  }
  if (tgt === 'unknown') {
    sendJson(req, res, 404, { error: 'no such agent-runs route' });
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method not allowed' });
    return true;
  }
  dispatch(req, res, deps).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'agent-runs: unhandled error');
    if (!res.headersSent)
      sendJson(req, res, 500, { error: 'agent runs api failed' });
  });
  return true;
}

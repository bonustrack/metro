import { parseId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { CALLS_PAGE, CALLS_PAGE_MAX, type CallCursor, type CallFilter, type CallView, type McpCallStore } from '@metro-labs/connectors/db/mcp-calls';

const WHOLE = /^\d{1,15}$/;
const CURSOR = /^(\d{1,15})(?::([A-Za-z0-9_-]{11}))?$/;
const CONNECTOR = /^[A-Za-z0-9_-]{1,128}$/;

interface ActivityCall {
  id: string;
  agent: string;
  agentName?: string;
  connector: string | null;
  connectorKey: string;
  connectorName?: string;
  connectorUrl?: string;
  tool: string;
  outcome: string;
  ms: number;
  at: number;
}

function whole(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw === '') return undefined;
  if (!WHOLE.test(raw)) throw new ApiError(`${name} must be a whole number`, 400);
  return Number(raw);
}

function cursorOf(query: URLSearchParams): CallCursor | undefined {
  const raw = query.get('before');
  if (raw === null || raw === '') return undefined;
  const found = CURSOR.exec(raw);
  if (found === null) throw new ApiError('before must be a time in ms, or a time and a call id as <ms>:<id>', 400);
  return found[2] === undefined ? { at: Number(found[1]) } : { at: Number(found[1]), id: found[2] };
}

export function agentOf(query: URLSearchParams): string | undefined {
  const raw = query.get('agent');
  if (raw === null || raw === '') return undefined;
  const agent = parseId(raw);
  if (agent === null) throw new ApiError('agent must be an agent id', 400);
  return agent;
}

export function connectorOf(query: URLSearchParams): string | undefined {
  const raw = query.get('connector');
  if (raw === null || raw === '') return undefined;
  if (!CONNECTOR.test(raw)) throw new ApiError('connector must be a connector id, or the key of calls that named no connector of the agent', 400);
  return raw;
}

function activityFilter(query: URLSearchParams): CallFilter {
  const limit = Math.min(Math.max(1, whole(query, 'limit') ?? CALLS_PAGE), CALLS_PAGE_MAX);
  const since = whole(query, 'since');
  const before = cursorOf(query);
  const agent = agentOf(query);
  const connector = connectorOf(query);
  return {
    limit,
    ...(since === undefined ? {} : { since }),
    ...(before === undefined ? {} : { before }),
    ...(agent === undefined ? {} : { agent }),
    ...(connector === undefined ? {} : { connector }),
  };
}

const named = (value: string | null): string | undefined => (value === null || value === '' ? undefined : value);

function activityCall(row: CallView): ActivityCall {
  const agentName = named(row.agentName);
  const connectorName = named(row.connectorName);
  const connectorUrl = named(row.connectorUrl);
  return {
    id: row.id,
    agent: row.agent,
    ...(agentName === undefined ? {} : { agentName }),
    connector: row.connector,
    connectorKey: row.connectorKey,
    ...(connectorName === undefined ? {} : { connectorName }),
    ...(connectorUrl === undefined ? {} : { connectorUrl }),
    tool: row.tool,
    outcome: row.outcome,
    ms: row.ms,
    at: row.at,
  };
}

export async function connectorActivity(store: McpCallStore, owner: string, query: URLSearchParams): Promise<{ calls: ActivityCall[] }> {
  const rows = await store.recent(owner, activityFilter(query));
  return { calls: rows.map(activityCall) };
}

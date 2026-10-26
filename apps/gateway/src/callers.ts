import type { IncomingMessage } from 'node:http';
import { MCP_TOKEN_RE } from '@metro-labs/http/mcp-server-protocol';
import { tokenHashOf } from '@metro-labs/connectors/db/agent-tokens';
import { accessKeyLookup, boxByTokenHash, Touches } from '@metro-labs/connectors/db/bearers';
import type { Database } from '@metro-labs/connectors/db/database';

export interface Caller {
  agent: string;
  owner: string;
  origin: 'box' | 'key';
  token: string | null;
}

export type CallerOf = (token: string) => Promise<Caller | null>;

const BEARER = 'Bearer ';
const CREDENTIAL_HEADERS = ['x-api-key', 'authorization', 'x-metro-key'];

function headerOf(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
}

export function keyOf(req: IncomingMessage): string | null {
  const api = headerOf(req, 'x-api-key');
  const auth = headerOf(req, 'authorization');
  const token = api !== '' ? api : auth.startsWith(BEARER) ? auth.slice(BEARER.length).trim() : '';
  return MCP_TOKEN_RE.test(token) ? token : null;
}

export function dropCredentials(req: IncomingMessage): void {
  for (const name of CREDENTIAL_HEADERS) Reflect.deleteProperty(req.headers, name);
}

export function callerLookup(db: () => Database, now: () => number = Date.now): CallerOf {
  const touches = new Touches(db, now, 'gateway');
  const accessKeyOf = accessKeyLookup(db);
  return async (token) => {
    const hash = tokenHashOf(token);
    const box = await boxByTokenHash(db(), hash);
    if (box !== null) return { agent: box.agent, owner: box.owner, origin: 'box', token: null };
    const key = await accessKeyOf(hash);
    if (key === null || !key.scopes.includes('gateway')) return null;
    touches.note(key.tokenId);
    return { agent: key.agent, owner: key.owner, origin: 'key', token: key.tokenId };
  };
}

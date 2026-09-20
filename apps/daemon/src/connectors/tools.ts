import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { whyUnreachable } from './reach.js';
import { refused } from './url.js';
import { authHeaders, type ConnectorAuth } from './verify.js';

export interface RemoteTool {
  name: string;
  description: string;
  readOnly: boolean;
}

const TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const ACCEPT = 'application/json, text/event-stream';

function dataOf(text: string, contentType: string): string {
  if (!contentType.includes('text/event-stream')) return text;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) if (line.startsWith('data:')) return line.slice(5).trim();
  return '';
}

async function post(url: URL, auth: ConnectorAuth, session: Map<string, string>, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: ACCEPT, ...authHeaders(auth), ...Object.fromEntries(session) },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw refused(`Metro could not reach ${url.hostname}: ${whyUnreachable(err)}`);
  }
}

function resultOf(text: string, contentType: string): Record<string, unknown> | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(dataOf(text, contentType));
  } catch {
    return null;
  }
  return isRecord(parsed) && isRecord(parsed.result) ? parsed.result : null;
}

async function rpc(url: URL, auth: ConnectorAuth, session: Map<string, string>, body: unknown): Promise<Record<string, unknown> | null> {
  const res = await post(url, auth, session, body);
  const id = res.headers.get('mcp-session-id');
  if (id !== null && id !== '') session.set('mcp-session-id', id);
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) throw refused(`${url.hostname} rejected the credential; connect it again`);
  if (!res.ok) throw refused(`${url.hostname} answered ${String(res.status)}`);
  return resultOf(text, res.headers.get('content-type') ?? '');
}

function toTool(raw: unknown): RemoteTool | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;
  const annotations = isRecord(raw.annotations) ? raw.annotations : {};
  const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : raw.name;
  return { name: title, description: typeof raw.description === 'string' ? raw.description : '', readOnly: annotations.readOnlyHint === true };
}

async function endSession(url: URL, auth: ConnectorAuth, session: Map<string, string>): Promise<void> {
  if (!session.has('mcp-session-id')) return;
  try {
    const res = await fetch(url, { method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...authHeaders(auth), ...Object.fromEntries(session) } });
    await res.body?.cancel();
  } catch (err) {
    log.debug({ host: url.hostname, err: errMsg(err) }, 'connector-tools: the remote declined to end the session');
  }
}

const toolsOf = (result: Record<string, unknown>): RemoteTool[] =>
  Array.isArray(result.tools) ? result.tools.flatMap((raw: unknown) => toTool(raw) ?? []) : [];

function nextCursor(result: Record<string, unknown>, current: string): string | null {
  const next = result.nextCursor;
  return typeof next !== 'string' || next === '' || next === current ? null : next;
}

async function walkTools(url: URL, auth: ConnectorAuth, session: Map<string, string>): Promise<RemoteTool[]> {
  const tools: RemoteTool[] = [];
  let cursor: string | null = '';
  for (let page = 0; page < MAX_PAGES && cursor !== null; page += 1) {
    const result = await rpc(url, auth, session, { jsonrpc: '2.0', id: 2 + page, method: 'tools/list', params: cursor === '' ? {} : { cursor } });
    if (result === null) break;
    tools.push(...toolsOf(result));
    cursor = nextCursor(result, cursor);
  }
  return tools;
}

export async function listRemoteTools(url: URL, auth: ConnectorAuth): Promise<RemoteTool[]> {
  const session = new Map<string, string>();
  const init = await rpc(url, auth, session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'metro', version: '0.1.0' } },
  });
  if (init === null || typeof init.protocolVersion !== 'string') throw refused(`${url.hostname} answered, but it does not speak MCP.`);
  session.set('mcp-protocol-version', init.protocolVersion);
  await rpc(url, auth, session, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await walkTools(url, auth, session);
  await endSession(url, auth, session);
  return tools;
}

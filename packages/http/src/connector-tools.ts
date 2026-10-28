import type { ConnectorIcon } from '@metro-labs/core/brands';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { authHeaders, INITIALIZE, mcpPost, resultOf, type ConnectorAuth } from './connector-mcp.js';
import { ConnectorUnauthorized, refused } from './connector-url.js';

export interface RemoteTool {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  inputSchema?: Record<string, unknown>;
}

export interface RemoteServer {
  tools: RemoteTool[];
  icons: ConnectorIcon[];
}

const TIMEOUT_MS = 15_000;
const ICONS_MAX = 4;
const ICON_URL_MAX = 2048;
const MIME_RE = /^image\/[a-z0-9.+-]{1,64}$/i;
const SIZE_RE = /^(any|\d{1,4}x\d{1,4})$/;
const MAX_PAGES = 100;
const MAX_TOOLS = 2000;

async function rpc(url: URL, auth: ConnectorAuth, session: Map<string, string>, body: unknown, fetchImpl?: FetchLike): Promise<Record<string, unknown> | null> {
  const res = await mcpPost(url, auth, body, { timeoutMs: TIMEOUT_MS, headers: Object.fromEntries(session), fetch: fetchImpl });
  const id = res.headers.get('mcp-session-id');
  if (id !== null && id !== '') session.set('mcp-session-id', id);
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) throw new ConnectorUnauthorized(`${url.hostname} rejected the credential; connect it again`, 400);
  if (!res.ok) throw refused(`${url.hostname} answered ${String(res.status)}`);
  return resultOf(text, res.headers.get('content-type') ?? '');
}

function hintsOf(annotations: Record<string, unknown>): Pick<RemoteTool, 'destructive' | 'openWorld'> {
  return { ...(annotations.destructiveHint === true ? { destructive: true } : {}), ...(annotations.openWorldHint === true ? { openWorld: true } : {}) };
}

export function toolTitleOf(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_\-.]+/).filter((word) => word !== '');
  if (words.length === 0) return name;
  const text = words.map((word, at) => (at > 0 && word !== word.toUpperCase() ? word.toLowerCase() : word)).join(' ');
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

const filled = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

function toTool(raw: unknown): RemoteTool | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;
  const annotations = isRecord(raw.annotations) ? raw.annotations : {};
  const title = filled(raw.title) ?? filled(annotations.title) ?? toolTitleOf(raw.name);
  return { name: raw.name, title, description: typeof raw.description === 'string' ? raw.description : '', readOnly: annotations.readOnlyHint === true, ...hintsOf(annotations), ...(isRecord(raw.inputSchema) ? { inputSchema: raw.inputSchema } : {}) };
}

async function endSession(url: URL, auth: ConnectorAuth, session: Map<string, string>, fetchImpl?: FetchLike): Promise<void> {
  if (!session.has('mcp-session-id')) return;
  try {
    const send = fetchImpl ?? fetch;
    const res = await send(url.toString(), { method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...authHeaders(auth), ...Object.fromEntries(session) } });
    if (res.ok) await res.body?.pipeTo(new WritableStream<Uint8Array>());
    else await res.body?.cancel();
  } catch (err) {
    log.debug(fetchImpl === undefined ? { host: url.hostname, err: errMsg(err) } : {}, 'connector-tools: the remote declined to end the session');
  }
}

function addTools(result: Record<string, unknown> | null, tools: Map<string, RemoteTool>): unknown {
  if (result === null || !Array.isArray(result.tools)) throw refused('The provider did not return a complete tool list.');
  for (const raw of result.tools) {
    const tool = toTool(raw);
    if (tool === null || tools.has(tool.name)) throw refused('The provider returned an invalid tool list.');
    tools.set(tool.name, tool);
    if (tools.size > MAX_TOOLS) throw refused('The provider returned too many tools.');
  }
  return result.nextCursor;
}

async function walkTools(url: URL, auth: ConnectorAuth, session: Map<string, string>, fetchImpl?: FetchLike): Promise<RemoteTool[]> {
  const tools = new Map<string, RemoteTool>();
  const cursors = new Set<string>();
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await rpc(url, auth, session, { jsonrpc: '2.0', id: 2 + page, method: 'tools/list', params: cursor === '' ? {} : { cursor } }, fetchImpl);
    const next = addTools(result, tools);
    if (next === undefined || next === null || next === '') return [...tools.values()];
    if (typeof next !== 'string' || cursors.has(next)) throw refused('The provider did not return a complete tool list.');
    cursors.add(next);
    cursor = next;
  }
  throw refused('The provider did not return a complete tool list.');
}

function iconSrc(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > ICON_URL_MAX) return null;
  try {
    const src = new URL(raw);
    return src.protocol === 'https:' && src.username === '' && src.password === '' ? src.toString() : null;
  } catch {
    return null;
  }
}

function iconOf(raw: unknown): ConnectorIcon | null {
  const src = isRecord(raw) ? iconSrc(raw.src) : null;
  if (!isRecord(raw) || src === null) return null;
  const sizes = Array.isArray(raw.sizes) ? raw.sizes.filter((size): size is string => typeof size === 'string' && SIZE_RE.test(size)).slice(0, ICONS_MAX) : [];
  return {
    src,
    ...(typeof raw.mimeType === 'string' && MIME_RE.test(raw.mimeType) ? { mimeType: raw.mimeType } : {}),
    ...(sizes.length > 0 ? { sizes } : {}),
    ...(raw.theme === 'light' || raw.theme === 'dark' ? { theme: raw.theme } : {}),
  };
}

function serverIconsOf(init: Record<string, unknown>): ConnectorIcon[] {
  const info = isRecord(init.serverInfo) ? init.serverInfo : {};
  if (!Array.isArray(info.icons)) return [];
  return info.icons.map(iconOf).filter((icon): icon is ConnectorIcon => icon !== null).slice(0, ICONS_MAX);
}

export const listRemoteTools = async (url: URL, auth: ConnectorAuth, fetchImpl?: FetchLike): Promise<RemoteTool[]> => (await listRemoteServer(url, auth, fetchImpl)).tools;

export async function listRemoteServer(url: URL, auth: ConnectorAuth, fetchImpl?: FetchLike): Promise<RemoteServer> {
  const session = new Map<string, string>();
  try {
    const init = await rpc(url, auth, session, INITIALIZE, fetchImpl);
    if (init === null || typeof init.protocolVersion !== 'string') throw refused(`${url.hostname} answered, but it does not speak MCP.`);
    session.set('mcp-protocol-version', init.protocolVersion);
    await rpc(url, auth, session, { jsonrpc: '2.0', method: 'notifications/initialized' }, fetchImpl);
    return { tools: await walkTools(url, auth, session, fetchImpl), icons: serverIconsOf(init) };
  } finally {
    await endSession(url, auth, session, fetchImpl);
  }
}

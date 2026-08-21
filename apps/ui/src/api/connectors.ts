import { daemonBase } from '../auth/session';
import { call } from './client';
import { isRecord } from './accounts';

export type ConnectorAuth = 'header' | 'oauth' | 'none';

export const TOOL_KINDS = [
  'read',
  'write',
  'destructive',
  'unspecified',
] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

export interface ConnectorTool {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  idempotent: boolean;
  openWorld: boolean;
}

export interface ConnectorVerified {
  at: string;
  server: string;
  version: string;
  protocol: string;
  icon: string;
  tools: number;
  catalog: ConnectorTool[];
}

export interface Connector {
  id: number;
  name: string;
  url: string;
  transport: string;
  auth: ConnectorAuth;
  header: string | null;
  secret: string | null;
  json: string;
  verified: ConnectorVerified | null;
}

export interface ConnectorList {
  connectors: Connector[];
  json: string;
}

export interface NewConnector {
  name: string;
  url: string;
  header: string;
  value: string;
}

export interface VerifyResult {
  id: number;
  name: string;
  ok: boolean;
  verified: ConnectorVerified | null;
  reason: string | null;
}

const connectorsUrl = (): string => `${daemonBase()}/api/connectors`;

function returnTo(): string {
  try {
    return window.location.origin + window.location.pathname;
  } catch {
    return '';
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const nullable = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

function toKind(value: unknown): ToolKind {
  return TOOL_KINDS.find((k) => k === value) ?? 'unspecified';
}

function toTool(value: unknown): ConnectorTool | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return {
    name: value.name,
    title: str(value.title),
    description: str(value.description),
    kind: toKind(value.kind),
    idempotent: value.idempotent === true,
    openWorld: value.openWorld !== false,
  };
}

function toCatalog(value: unknown): ConnectorTool[] {
  if (!Array.isArray(value)) return [];
  const out: ConnectorTool[] = [];
  for (const entry of value) {
    const tool = toTool(entry);
    if (tool !== null) out.push(tool);
  }
  return out;
}

function toVerified(value: unknown): ConnectorVerified | null {
  if (!isRecord(value)) return null;
  return {
    at: str(value.at),
    server: str(value.server),
    version: str(value.version),
    protocol: str(value.protocol),
    icon: str(value.icon),
    tools: typeof value.tools === 'number' ? value.tools : 0,
    catalog: toCatalog(value.catalog),
  };
}

function toConnector(value: unknown): Connector {
  if (!isRecord(value) || typeof value.name !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return {
    id: typeof value.id === 'number' ? value.id : 0,
    name: value.name,
    url: str(value.url),
    transport: str(value.transport),
    auth:
      value.auth === 'header'
        ? 'header'
        : value.auth === 'oauth'
          ? 'oauth'
          : 'none',
    header: nullable(value.header),
    secret: nullable(value.secret),
    json: str(value.json),
    verified: toVerified(value.verified),
  };
}

export function connectorHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function serverLabel(verified: ConnectorVerified): string {
  const parts = [verified.server, verified.version].filter((p) => p !== '');
  return parts.length === 0 ? '-' : parts.join(' ');
}

function payload(input: NewConnector): Record<string, string> {
  const out: Record<string, string> = { name: input.name, url: input.url };
  if (input.header !== '') out.header = input.header;
  if (input.value !== '') out.value = input.value;
  return out;
}

export async function fetchConnectors(token: string): Promise<ConnectorList> {
  const body = await call(token, { method: 'GET', base: connectorsUrl() });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  const rows = Array.isArray(body.connectors) ? body.connectors : [];
  return { connectors: rows.map(toConnector), json: str(body.json) };
}

export type AddResult =
  | { kind: 'added'; connector: Connector }
  | { kind: 'oauth'; authorizeUrl: string };

export async function createConnector(
  token: string,
  input: NewConnector,
): Promise<AddResult> {
  const body = await call(token, {
    method: 'POST',
    base: connectorsUrl(),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload(input), returnTo: returnTo() }),
  });
  if (isRecord(body) && body.status === 'oauth' && typeof body.authorizeUrl === 'string')
    return { kind: 'oauth', authorizeUrl: body.authorizeUrl };
  return { kind: 'added', connector: toConnector(body) };
}

export function takeConnectorError(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const error = params.get('connector_error');
  if (error === null) return null;
  params.delete('connector_error');
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    window.location.pathname + (query === '' ? '' : `?${query}`) + window.location.hash,
  );
  return error;
}

export async function fetchConnector(
  token: string,
  id: number,
): Promise<Connector> {
  const body = await call(token, {
    method: 'GET',
    base: connectorsUrl(),
    path: `/${String(id)}`,
  });
  return toConnector(body);
}

export async function verifyConnector(
  token: string,
  id: number,
): Promise<VerifyResult> {
  const body = await call(token, {
    method: 'POST',
    base: connectorsUrl(),
    path: `/${id}/verify`,
  });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return {
    id: typeof body.id === 'number' ? body.id : id,
    name: str(body.name),
    ok: body.ok === true,
    verified: toVerified(body.verified),
    reason: nullable(body.reason),
  };
}

export async function deleteConnector(token: string, id: number): Promise<void> {
  await call(token, {
    method: 'DELETE',
    base: connectorsUrl(),
    path: `/${id}`,
  });
}

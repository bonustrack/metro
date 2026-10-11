import { isRecord } from '@metro-labs/core/is-record';
import { stringOf } from '@metro-labs/http/api-http';
import type { OAuthTokens } from '@metro-labs/http/connector-mcp';
import type { OAuthServer } from '@metro-labs/http/connector-discovery';
import type { OAuthClient } from '@metro-labs/http/connector-oauth';
import type { AssignmentRow, ConnectorRow } from '../db/connectors.js';
import { openSecret, sealSecret } from './secrets.js';

export type ConnectorSecret =
  | { kind: 'none'; targetUrl: string }
  | { kind: 'header'; targetUrl: string; name: string; value: string }
  | { kind: 'oauth'; targetUrl: string; client: OAuthClient; server: OAuthServer; tokens?: OAuthTokens };

export interface ConnectorDetail {
  header?: string;
  server?: string;
  verifiedAt?: string;
  signedInAt?: string;
  issuer?: string;
  clientId?: string;
}

export interface ConnectorView {
  id: string;
  name: string;
  url: string;
  auth: string;
  header: string | null;
  signIn: 'connected' | 'disconnected' | null;
  server: string | null;
  verifiedAt: string | null;
  clientId: string | null;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
  agents: { id: string; readOnly: boolean; assignedAt: string }[];
}

const READ_ONLY = '{"write":"deny"}';
const DETAIL_KEYS = ['header', 'server', 'verifiedAt', 'signedInAt', 'issuer', 'clientId'] as const;

export const readOnlyPolicy = (readOnly: boolean): string | null => (readOnly ? READ_ONLY : null);

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isReadOnly(policy: string | null): boolean {
  const value = parsed(policy);
  return isRecord(value) && value.write === 'deny';
}

export function detailOf(text: string | null): ConnectorDetail {
  const value = parsed(text);
  if (!isRecord(value)) return {};
  const out: ConnectorDetail = {};
  for (const key of DETAIL_KEYS) {
    const field = value[key];
    if (typeof field === 'string' && field !== '') out[key] = field;
  }
  return out;
}

export const detailText = (detail: ConnectorDetail): string | null => (Object.keys(detail).length === 0 ? null : JSON.stringify(detail));

export const sealConnectorSecret = (key: Buffer, row: Pick<ConnectorRow, 'owner' | 'id'>, secret: ConnectorSecret): string => sealSecret(key, row.owner, row.id, secret);

function clientOf(raw: unknown): OAuthClient | null {
  if (!isRecord(raw) || typeof raw.clientId !== 'string' || raw.clientId === '') return null;
  return { clientId: raw.clientId, ...(typeof raw.clientSecret === 'string' ? { clientSecret: raw.clientSecret } : {}) };
}

function serverOf(raw: unknown): OAuthServer | null {
  if (!isRecord(raw)) return null;
  const authorizationEndpoint = stringOf(raw.authorizationEndpoint);
  const tokenEndpoint = stringOf(raw.tokenEndpoint);
  if (authorizationEndpoint === '' || tokenEndpoint === '') return null;
  const registration = stringOf(raw.registrationEndpoint);
  return {
    issuer: stringOf(raw.issuer),
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: registration === '' ? null : registration,
    supportsS256: raw.supportsS256 === true,
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
  };
}

function tokensOf(raw: unknown): OAuthTokens | null {
  if (!isRecord(raw) || typeof raw.accessToken !== 'string' || raw.accessToken === '') return null;
  return {
    accessToken: raw.accessToken,
    ...(typeof raw.refreshToken === 'string' ? { refreshToken: raw.refreshToken } : {}),
    ...(typeof raw.expiresAt === 'number' ? { expiresAt: raw.expiresAt } : {}),
  };
}

function oauthSecretOf(value: Record<string, unknown>, targetUrl: string): ConnectorSecret | null {
  const client = clientOf(value.client);
  const server = serverOf(value.server);
  if (client === null || server === null) return null;
  const tokens = tokensOf(value.tokens);
  return { kind: 'oauth', targetUrl, client, server, ...(tokens === null ? {} : { tokens }) };
}

export function openConnectorSecret(key: Buffer, row: Pick<ConnectorRow, 'owner' | 'id' | 'secret'>): ConnectorSecret | null {
  if (row.secret === null) return null;
  const value = openSecret(key, row.owner, row.id, row.secret);
  if (!isRecord(value) || typeof value.targetUrl !== 'string') return null;
  const targetUrl = value.targetUrl;
  if (value.kind === 'none') return { kind: 'none', targetUrl };
  if (value.kind === 'header' && typeof value.name === 'string' && typeof value.value === 'string') return { kind: 'header', targetUrl, name: value.name, value: value.value };
  return value.kind === 'oauth' ? oauthSecretOf(value, targetUrl) : null;
}

function signInOf(row: ConnectorRow, detail: ConnectorDetail): ConnectorView['signIn'] {
  if (row.auth !== 'oauth') return null;
  return detail.signedInAt === undefined ? 'disconnected' : 'connected';
}

export function connectorView(row: ConnectorRow, assignments: AssignmentRow[]): ConnectorView {
  const detail = detailOf(row.detail);
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    auth: row.auth,
    header: detail.header ?? null,
    signIn: signInOf(row, detail),
    server: detail.server ?? null,
    verifiedAt: detail.verifiedAt ?? null,
    clientId: detail.clientId ?? null,
    readOnly: isReadOnly(row.policy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    agents: assignments
      .filter((a) => a.connector === row.id)
      .map((a) => ({ id: a.agent, readOnly: isReadOnly(a.policy), assignedAt: a.createdAt })),
  };
}

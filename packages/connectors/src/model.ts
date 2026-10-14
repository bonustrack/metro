import { isRecord } from '@metro-labs/core/is-record';
import { stringOf } from '@metro-labs/http/api-http';
import type { OAuthTokens } from '@metro-labs/http/connector-mcp';
import type { OAuthServer } from '@metro-labs/http/connector-discovery';
import type { OAuthClient } from '@metro-labs/http/connector-oauth';
import { grantResource } from '@metro-labs/http/connector-grant';
import { publicOAuthResource } from '@metro-labs/http/connector-public-url';
import type { ConnectorRow } from './db/connectors.js';
import { openSecret, sealSecret } from './secrets.js';

interface OAuthGrant extends OAuthTokens { resource?: string }

export interface ImportedGrant {
  state: 'owned' | 'refreshing' | 'uncertain' | 'signin';
  tokenEndpointAuthMethod: 'none' | 'client_secret_post';
  scope?: string;
  attempt?: string;
}

export type ConnectorSecret =
  | { kind: 'none'; targetUrl: string }
  | { kind: 'header'; targetUrl: string; name: string; value: string }
  | { kind: 'oauth'; targetUrl: string; client: OAuthClient; server: OAuthServer; oauthResource?: string; tokens?: OAuthGrant; imported?: ImportedGrant };

export interface ConnectorDetail {
  header?: string;
  server?: string;
  verifiedAt?: string;
  signedInAt?: string;
  issuer?: string;
  clientId?: string;
}

const DETAIL_KEYS = ['header', 'server', 'verifiedAt', 'signedInAt', 'issuer', 'clientId'] as const;

export function parsedJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function detailOf(text: string | null): ConnectorDetail {
  const value = parsedJson(text);
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

function serverOf(raw: unknown, imported = false): OAuthServer | null {
  if (!isRecord(raw)) return null;
  const authorizationEndpoint = stringOf(raw.authorizationEndpoint);
  const tokenEndpoint = stringOf(raw.tokenEndpoint);
  if ((!imported && authorizationEndpoint === '') || tokenEndpoint === '') return null;
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

function validStoredExpiry(raw: Record<string, unknown>): boolean {
  return !Object.hasOwn(raw, 'expiresAt') || (typeof raw.expiresAt === 'number' && Number.isSafeInteger(raw.expiresAt) && raw.expiresAt >= 0);
}

function validStoredRefresh(raw: Record<string, unknown>): boolean {
  return !Object.hasOwn(raw, 'refreshToken') || (typeof raw.refreshToken === 'string' && /^[\x21-\x7e]{1,16384}$/.test(raw.refreshToken));
}

function validStoredResource(raw: Record<string, unknown>, target?: string): boolean {
  if (!Object.hasOwn(raw, 'resource')) return true;
  try { if (target === undefined) publicOAuthResource(raw.resource); else grantResource(target, raw.resource); return true; } catch { return false; }
}

function tokensOf(raw: unknown, target?: string): OAuthGrant | null {
  if (!isRecord(raw) || typeof raw.accessToken !== 'string' || !/^[\x21-\x7e]{1,16377}$/.test(raw.accessToken)) return null;
  if (!validStoredExpiry(raw) || !validStoredRefresh(raw) || !validStoredResource(raw, target)) return null;
  return {
    accessToken: raw.accessToken,
    ...(typeof raw.resource === 'string' ? { resource: raw.resource } : {}),
    ...(typeof raw.refreshToken === 'string' ? { refreshToken: raw.refreshToken } : {}),
    ...(typeof raw.expiresAt === 'number' ? { expiresAt: raw.expiresAt } : {}),
  };
}

function storedOAuthResource(value: Record<string, unknown>): string | undefined | null {
  if (!Object.hasOwn(value, 'oauthResource')) return undefined;
  try { return publicOAuthResource(value.oauthResource); } catch { return null; }
}

function oauthSecretOf(value: Record<string, unknown>, targetUrl: string): ConnectorSecret | null {
  const client = clientOf(value.client);
  const imported = importedOf(value.imported);
  if (Object.hasOwn(value, 'imported') && imported === undefined) return null;
  const server = serverOf(value.server, imported !== undefined);
  if (client === null || server === null) return null;
  const tokens = tokensOf(value.tokens, imported === undefined ? undefined : targetUrl);
  const oauthResource = storedOAuthResource(value);
  if (oauthResource === null) return null;
  return { kind: 'oauth', targetUrl, client, server, ...(imported === undefined ? {} : { imported }), ...(oauthResource === undefined ? {} : { oauthResource }), ...(tokens === null ? {} : { tokens }) };
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

function importedOf(raw: unknown): ImportedGrant | undefined {
  if (!isRecord(raw)) return undefined;
  const state = (['owned', 'refreshing', 'uncertain', 'signin'] as const).find((value) => value === raw.state);
  if (state === undefined) return undefined;
  if (raw.tokenEndpointAuthMethod !== 'none' && raw.tokenEndpointAuthMethod !== 'client_secret_post') return undefined;
  const metadata = importedMetadata(raw);
  if (metadata === null) return undefined;
  return { state, tokenEndpointAuthMethod: raw.tokenEndpointAuthMethod, ...metadata };
}

function importedMetadata(raw: Record<string, unknown>): Pick<ImportedGrant, 'scope' | 'attempt'> | null {
  if (raw.scope !== undefined && typeof raw.scope !== 'string') return null;
  if (raw.attempt !== undefined && typeof raw.attempt !== 'string') return null;
  return { ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}), ...(typeof raw.attempt === 'string' ? { attempt: raw.attempt } : {}) };
}

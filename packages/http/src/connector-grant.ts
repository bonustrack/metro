import { deliveryRecord } from './connector-delivery-validation.js';
import type { OAuthAuth } from './connector-mcp.js';
import { boundOAuthResource, parsePublicConnectorUrl } from './connector-public-url.js';

export interface PortableGrant extends OAuthAuth {
  resource: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_post';
}

const invalid = (): never => { throw new Error('This OAuth grant cannot be transferred. Its client authentication or provider binding is unsupported. Sign in separately.'); };

function text(raw: unknown, max = 16384): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > max || /[^\x21-\x7e]/.test(raw)) return invalid();
  return raw;
}

function endpoint(raw: unknown): string {
  const value = text(raw, 2048);
  parsePublicConnectorUrl(value);
  return value;
}

export function grantResource(target: string, raw: unknown): string {
  const transport = parsePublicConnectorUrl(target);
  const resource = parsePublicConnectorUrl(raw);
  if (resource.toString() === transport.toString() && typeof raw === 'string') return raw;
  return boundOAuthResource(target, raw);
}

function binding(value: Record<string, unknown>): Pick<PortableGrant, 'clientId' | 'clientSecret' | 'tokenEndpointAuthMethod'> {
  const clientSecret = value.clientSecret === undefined ? undefined : text(value.clientSecret);
  const method = value.tokenEndpointAuthMethod ?? (clientSecret === undefined ? 'none' : 'client_secret_post');
  if (method !== 'none' && method !== 'client_secret_post') return invalid();
  if ((method === 'client_secret_post') !== (clientSecret !== undefined)) return invalid();
  return { clientId: text(value.clientId), tokenEndpointAuthMethod: method, ...(clientSecret === undefined ? {} : { clientSecret }) };
}

function expiry(raw: unknown): Pick<PortableGrant, 'expiresAt'> {
  if (raw === undefined) return {};
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return invalid();
  return { expiresAt: raw };
}

function scopeOf(raw: unknown): Pick<PortableGrant, 'scope'> {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.length > 16384 || /[^\x20-\x7e]/.test(raw)) return invalid();
  return { scope: raw };
}

export function portableGrant(raw: unknown, target: string): PortableGrant {
  const value = deliveryRecord(raw, ['kind', 'accessToken', 'refreshToken', 'expiresAt', 'clientId', 'clientSecret', 'issuer', 'tokenEndpoint', 'scope', 'resource', 'tokenEndpointAuthMethod']);
  if (value.kind !== 'oauth') return invalid();
  return {
    kind: 'oauth', accessToken: text(value.accessToken, 16377), issuer: endpoint(value.issuer), tokenEndpoint: endpoint(value.tokenEndpoint),
    resource: grantResource(target, value.resource ?? parsePublicConnectorUrl(target).toString()),
    ...binding(value), ...expiry(value.expiresAt), ...scopeOf(value.scope),
    ...(value.refreshToken === undefined ? {} : { refreshToken: text(value.refreshToken) }),
  };
}

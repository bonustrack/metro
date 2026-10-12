import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { authServerMetadataUrls, resourceMetadataUrls, type OAuthServer } from './connector-discovery.js';
import { boundOAuthResource, optionalOAuthResource, parsePublicConnectorUrl, publicOAuthResource } from './connector-public-url.js';
import { refused, ConnectorVerifyError } from './connector-url.js';

const METADATA_MAX = 1024 * 1024;
const metadataError = (): Error => refused('The provider returned invalid or unavailable public OAuth metadata. Check its public OAuth resource and try again.');
export class OAuthResourceRequired extends ConnectorVerifyError {
  constructor() { super('Enter the provider’s public OAuth resource before continuing. It is shown in the sign-in page; never enter a private endpoint or credentials.', 400); }
}

async function metadataBody(res: Response): Promise<Record<string, unknown>> {
  if (res.body === null) throw metadataError();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > METADATA_MAX) throw metadataError();
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(body)) throw metadataError();
    return body;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function metadata(url: URL, send: FetchLike): Promise<Record<string, unknown> | null> {
  try {
    const res = await send(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw metadataError();
    }
    return await metadataBody(res);
  } catch {
    throw metadataError();
  }
}

function selectedResource(transport: URL, offered: string | undefined, body: Record<string, unknown> | null): string {
  const advertised = body !== null && Object.hasOwn(body, 'resource') ? publicOAuthResource(body.resource) : undefined;
  if (advertised !== undefined && offered !== undefined && advertised !== offered) throw metadataError();
  const resource = advertised ?? offered;
  if (resource === undefined) throw new OAuthResourceRequired();
  return boundOAuthResource(transport.toString(), resource);
}

function issuerOf(body: Record<string, unknown> | null, transport: URL): string {
  if (body === null || !Object.hasOwn(body, 'authorization_servers')) return transport.origin;
  const servers = body.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0 || servers.length > 20) throw metadataError();
  const values = servers.map((value: unknown) => publicOAuthResource(value));
  return values[0] ?? '';
}

function scopesOf(body: Record<string, unknown> | null): string[] {
  if (body === null || !Object.hasOwn(body, 'scopes_supported')) return [];
  const scopes = body.scopes_supported;
  if (!Array.isArray(scopes) || scopes.length > 100 || scopes.some((scope: unknown) => typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope))) throw metadataError();
  return [...new Set(scopes as string[])];
}

function serverOf(body: Record<string, unknown>, issuer: string, scopes: string[]): OAuthServer {
  if (typeof body.issuer !== 'string' || publicOAuthResource(body.issuer) !== issuer) throw metadataError();
  const endpoint = (raw: unknown): string => parsePublicConnectorUrl(raw).toString();
  return {
    issuer,
    authorizationEndpoint: endpoint(body.authorization_endpoint),
    tokenEndpoint: endpoint(body.token_endpoint),
    registrationEndpoint: body.registration_endpoint === undefined ? null : endpoint(body.registration_endpoint),
    supportsS256: Array.isArray(body.code_challenge_methods_supported) && body.code_challenge_methods_supported.includes('S256'),
    scopes,
  };
}

async function protectedMetadata(base: URL, send: FetchLike): Promise<Record<string, unknown> | null> {
  for (const candidate of resourceMetadataUrls(base)) {
    const body = await metadata(candidate, send);
    if (body !== null) return body;
  }
  return null;
}

export async function discoverPublicOAuth(target: string, offered: unknown, send: FetchLike = fetch): Promise<{ server: OAuthServer; resource: string }> {
  const transport = parsePublicConnectorUrl(target);
  const explicit = optionalOAuthResource(offered);
  if (explicit !== undefined) boundOAuthResource(target, explicit);
  const body = await protectedMetadata(new URL(explicit ?? transport.origin), send);
  const resource = selectedResource(transport, explicit, body);
  const issuer = issuerOf(body, transport);
  const scopes = scopesOf(body);
  for (const candidate of authServerMetadataUrls(new URL(issuer))) {
    const authorization = await metadata(candidate, send);
    if (authorization !== null) return { server: serverOf(authorization, issuer, scopes), resource };
  }
  throw metadataError();
}

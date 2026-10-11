import { isRecord } from '@metro-labs/core/is-record';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { stringOf } from './api-http.js';
import { parseConnectorUrl, refused } from './connector-url.js';

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface OAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  supportsS256: boolean;
  scopes: string[];
}

interface ResourceMetadata {
  issuer: URL;
  scopes: string[];
}

async function getJson(url: URL, fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const body: unknown = await res.json().catch(() => null);
  return isRecord(body) ? body : null;
}

function wellKnown(base: URL, suffix: string): URL {
  const url = new URL(base.toString());
  url.pathname = `/.well-known/${suffix}`;
  url.search = '';
  url.hash = '';
  return url;
}

export function resourceMetadataUrls(resource: URL): URL[] {
  const path = resource.pathname.replace(/\/$/, '');
  const urls = [wellKnown(resource, 'oauth-protected-resource')];
  if (path !== '')
    urls.unshift(
      new URL(`/.well-known/oauth-protected-resource${path}`, resource.origin),
    );
  return urls;
}

export async function advertisesOAuth(resource: URL, fetchImpl: FetchLike = fetch): Promise<boolean> {
  for (const candidate of resourceMetadataUrls(resource)) {
    const body = await getJson(candidate, fetchImpl);
    const servers: unknown = body?.authorization_servers;
    const first: unknown = Array.isArray(servers) ? servers[0] : undefined;
    if (typeof first === 'string' && first !== '') return true;
  }
  return false;
}

function scopesOf(body: Record<string, unknown> | null): string[] {
  const raw: unknown = body?.scopes_supported;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const scope = stringOf(entry).trim();
    if (scope !== '' && !/\s/.test(scope) && !out.includes(scope)) out.push(scope);
  }
  return out;
}

async function resourceMetadata(resource: URL, fetchImpl: FetchLike): Promise<ResourceMetadata> {
  for (const candidate of resourceMetadataUrls(resource)) {
    const body = await getJson(candidate, fetchImpl);
    const servers: unknown = body?.authorization_servers;
    const first: unknown = Array.isArray(servers) ? servers[0] : undefined;
    if (typeof first === 'string' && first !== '')
      return { issuer: parseConnectorUrl(first), scopes: scopesOf(body) };
  }
  return { issuer: parseConnectorUrl(resource.origin), scopes: [] };
}

const webAddress = (text: string): boolean => {
  try {
    parseConnectorUrl(text);
    return true;
  } catch {
    return false;
  }
};

function endpointOf(raw: unknown, issuer: URL): string {
  const text = stringOf(raw);
  if (text !== '' && !webAddress(text)) throw refused(`${issuer.hostname} advertises a sign-in address Metro will not open.`);
  return text;
}

function toServer(
  body: Record<string, unknown>,
  issuer: URL,
  scopes: string[],
): OAuthServer {
  const authorizationEndpoint = endpointOf(body.authorization_endpoint, issuer);
  const tokenEndpoint = endpointOf(body.token_endpoint, issuer);
  if (authorizationEndpoint === '' || tokenEndpoint === '')
    throw refused(
      `${issuer.hostname} advertises OAuth but not where to sign in.`,
    );
  const methods = body.code_challenge_methods_supported;
  const offered = stringOf(body.registration_endpoint);
  const registration = webAddress(offered) ? offered : '';
  return {
    issuer: stringOf(body.issuer) === '' ? issuer.origin : stringOf(body.issuer),
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: registration === '' ? null : registration,
    supportsS256: Array.isArray(methods) ? methods.includes('S256') : false,
    scopes,
  };
}

export function authServerMetadataUrls(issuer: URL): URL[] {
  const path = issuer.pathname.replace(/\/$/, '');
  const suffixes = ['oauth-authorization-server', 'openid-configuration'];
  const urls = suffixes.map((suffix) => wellKnown(issuer, suffix));
  if (path === '') return urls;
  const aware = suffixes.map(
    (suffix) => new URL(`/.well-known/${suffix}${path}`, issuer.origin),
  );
  return [...aware, new URL(`${path}/.well-known/openid-configuration`, issuer.origin), ...urls];
}

export async function discoverOAuth(resource: URL, fetchImpl: FetchLike = fetch): Promise<OAuthServer> {
  const { issuer, scopes } = await resourceMetadata(resource, fetchImpl);
  for (const candidate of authServerMetadataUrls(issuer)) {
    const body = await getJson(candidate, fetchImpl);
    if (body !== null) return toServer(body, issuer, scopes);
  }
  throw refused(
    `${resource.hostname} needs authorization, but publishes no OAuth metadata Metro can use.`,
  );
}

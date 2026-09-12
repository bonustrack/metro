import { ConnectorVerifyError, parseConnectorUrl } from './verify.js';
import { isRecord } from '@metro-labs/core/is-record';

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

function refused(message: string): ConnectorVerifyError {
  return new ConnectorVerifyError(message, 400);
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';

async function getJson(url: URL): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(url, {
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

export async function advertisesOAuth(resource: URL): Promise<boolean> {
  for (const candidate of resourceMetadataUrls(resource)) {
    const body = await getJson(candidate);
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
    const scope = str(entry).trim();
    if (scope !== '' && !/\s/.test(scope) && !out.includes(scope)) out.push(scope);
  }
  return out;
}

async function resourceMetadata(resource: URL): Promise<ResourceMetadata> {
  for (const candidate of resourceMetadataUrls(resource)) {
    const body = await getJson(candidate);
    const servers: unknown = body?.authorization_servers;
    const first: unknown = Array.isArray(servers) ? servers[0] : undefined;
    if (typeof first === 'string' && first !== '')
      return { issuer: parseConnectorUrl(first), scopes: scopesOf(body) };
  }
  return { issuer: parseConnectorUrl(resource.origin), scopes: [] };
}

function toServer(
  body: Record<string, unknown>,
  issuer: URL,
  scopes: string[],
): OAuthServer {
  const authorizationEndpoint = str(body.authorization_endpoint);
  const tokenEndpoint = str(body.token_endpoint);
  if (authorizationEndpoint === '' || tokenEndpoint === '')
    throw refused(
      `${issuer.hostname} advertises OAuth but not where to sign in.`,
    );
  const methods = body.code_challenge_methods_supported;
  const registration = str(body.registration_endpoint);
  return {
    issuer: str(body.issuer) === '' ? issuer.origin : str(body.issuer),
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

export async function discoverOAuth(resource: URL): Promise<OAuthServer> {
  const { issuer, scopes } = await resourceMetadata(resource);
  for (const candidate of authServerMetadataUrls(issuer)) {
    const body = await getJson(candidate);
    if (body !== null) return toServer(body, issuer, scopes);
  }
  throw refused(
    `${resource.hostname} needs authorization, but publishes no OAuth metadata Metro can use.`,
  );
}

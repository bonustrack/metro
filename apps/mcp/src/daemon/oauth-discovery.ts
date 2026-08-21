import { ConnectorVerifyError, parseConnectorUrl } from './connector-verify.js';

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface OAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  supportsS256: boolean;
}

function refused(message: string): ConnectorVerifyError {
  return new ConnectorVerifyError(message, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

async function authServerFor(resource: URL): Promise<URL> {
  for (const candidate of resourceMetadataUrls(resource)) {
    const body = await getJson(candidate);
    const servers: unknown = body?.authorization_servers;
    const first: unknown = Array.isArray(servers) ? servers[0] : undefined;
    if (typeof first === 'string' && first !== '')
      return parseConnectorUrl(first);
  }
  return parseConnectorUrl(resource.origin);
}

function toServer(body: Record<string, unknown>, issuer: URL): OAuthServer {
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
  const issuer = await authServerFor(resource);
  for (const candidate of authServerMetadataUrls(issuer)) {
    const body = await getJson(candidate);
    if (body !== null) return toServer(body, issuer);
  }
  throw refused(
    `${resource.hostname} needs authorization, but publishes no OAuth metadata Metro can use.`,
  );
}

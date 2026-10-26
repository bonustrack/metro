export interface OAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  supportsS256: boolean;
  scopes: string[];
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

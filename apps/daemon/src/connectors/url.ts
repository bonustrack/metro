import { ApiError } from '@metro-labs/http/api-error';

export class ConnectorVerifyError extends ApiError {}

export class ConnectorUnauthorized extends ConnectorVerifyError {}

export function refused(message: string): ConnectorVerifyError {
  return new ConnectorVerifyError(message, 400);
}

function refuseShape(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw refused('a connector url must start with https:// or http://');
  if (url.username !== '' || url.password !== '')
    throw refused('a connector url must not carry a user:password');
  if (url.hash !== '')
    throw refused('a connector url must not carry a #fragment');
}

export function parseConnectorUrl(raw: unknown): URL {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') throw refused('a connector url is required');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw refused('that is not a valid url');
  }
  refuseShape(url);
  return url;
}

export function connectorUrlText(url: URL): string {
  const text = url.toString();
  if (url.pathname !== '/' || url.search !== '') return text;
  return text.endsWith('/') ? text.slice(0, -1) : text;
}

import { ApiError } from './api-error.js';

export class ConnectorVerifyError extends ApiError {}

export class ConnectorUnauthorized extends ConnectorVerifyError {}

export class ConnectorNotMcp extends ConnectorVerifyError {}

export const POLICY_MESSAGE =
  'Metro connects from its own server, so it cannot reach a URL on your machine. localhost and private addresses are not usable as connectors.';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|internal|flycast)$/;

export function refused(message: string): ConnectorVerifyError {
  return new ConnectorVerifyError(message, 400);
}

function hostAllowed(host: string): boolean {
  if (host === '' || host.startsWith('[')) return false;
  if (IPV4.test(host) || !host.includes('.')) return false;
  return !PRIVATE_SUFFIX.test(host);
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
  if (url.protocol !== 'https:')
    throw refused('a connector url must start with https://');
  if (url.username !== '' || url.password !== '')
    throw refused('a connector url must not carry a user:password');
  if (url.hash !== '')
    throw refused('a connector url must not carry a #fragment');
  if (!hostAllowed(url.hostname.toLowerCase())) throw refused(POLICY_MESSAGE);
  return url;
}

export function connectorUrlText(url: URL): string {
  const text = url.toString();
  if (url.pathname !== '/' || url.search !== '') return text;
  return text.endsWith('/') ? text.slice(0, -1) : text;
}

export function safeIconSrc(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '';
  try {
    return new URL(raw).protocol === 'https:' ? raw.slice(0, 500) : '';
  } catch {
    return '';
  }
}

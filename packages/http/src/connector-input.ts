import { ApiError } from './api-error.js';
import { stringOf } from './api-http.js';
import type { ConnectorAuth } from './connector-mcp.js';
import type { OAuthClient } from './connector-oauth.js';

const CONNECTOR_NAME_MAX = 64;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,4096}$/;
const CLIENT_ID_RE = /^[\x21-\x7e]{1,256}$/;
const CLIENT_SECRET_RE = /^[\x21-\x7e]{1,1024}$/;
const DEFAULT_HEADER = 'Authorization';

class ConnectorError extends ApiError {}

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function connectorName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') throw new ConnectorError('a connector needs a name', 400);
  if (name.length > CONNECTOR_NAME_MAX)
    throw new ConnectorError(
      `a connector name must be ${String(CONNECTOR_NAME_MAX)} characters or fewer`,
      400,
    );
  if (hasControlChar(name))
    throw new ConnectorError(
      'a connector name must not contain control characters',
      400,
    );
  return name;
}

export function connectorAuth(
  rawHeader: unknown,
  rawValue: unknown,
): ConnectorAuth {
  const header = stringOf(rawHeader).trim();
  const value = stringOf(rawValue).trim();
  if (header === '' && value === '') return { kind: 'none' };
  if (value === '')
    throw new ConnectorError(
      'that header has no value. Give both a header name and its value, or neither.',
      400,
    );
  const name = header === '' ? DEFAULT_HEADER : header;
  if (!HEADER_NAME_RE.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))
    throw new ConnectorError('that is not a valid HTTP header name', 400);
  if (!HEADER_VALUE_RE.test(value))
    throw new ConnectorError('that header value is not sendable', 400);
  return { kind: 'header', name, value };
}

export function connectorClient(
  rawId: unknown,
  rawSecret: unknown,
): OAuthClient | null {
  const clientId = stringOf(rawId).trim();
  const clientSecret = stringOf(rawSecret).trim();
  if (clientId === '' && clientSecret === '') return null;
  if (clientId === '')
    throw new ConnectorError('a client secret needs the client ID it belongs to', 400);
  if (!CLIENT_ID_RE.test(clientId))
    throw new ConnectorError('that is not a client ID Metro can send', 400);
  if (clientSecret !== '' && !CLIENT_SECRET_RE.test(clientSecret))
    throw new ConnectorError('that client secret is not sendable', 400);
  return { clientId, ...(clientSecret === '' ? {} : { clientSecret }) };
}

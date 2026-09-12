import type { ConnectorAuth, VerifiedRecord } from './verify.js';
import type { OAuthClient } from './oauth-client.js';
import { readConfig, signInState, type ConnectorSignIn } from './config.js';
import type { ConnectorTransport } from '@metro-labs/core/station-names';

export interface Connector {
  id: string;
  name: string;
  url: string;
  transport: ConnectorTransport;
  auth: ConnectorAuth['kind'];
  header: string | null;
  secret: string | null;
  bearer: string | null;
  expiresAt: number | null;
  signIn: ConnectorSignIn;
  verified: VerifiedRecord;
  client: OAuthClient | null;
}

export interface PendingConnectorInput {
  name: unknown;
  url: unknown;
  clientId: unknown;
  clientSecret: unknown;
}

export interface ConnectorInput extends PendingConnectorInput {
  header: unknown;
  value: unknown;
}

export type ConnectorCheck =
  | { id: string; name: string; ok: true; verified: VerifiedRecord }
  | { id: string; name: string; ok: false; reason: string };

export interface DeletedConnector {
  id: string;
  name: string;
}

export interface ConnectorLike {
  id: string;
  name: string;
  url: string;
  transport: ConnectorTransport;
  config: unknown;
}

export function connectorFromRow(row: ConnectorLike): Connector {
  const config = readConfig(row.config);
  const auth = config.auth;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    auth: auth.kind,
    header: auth.kind === 'header' ? auth.name : null,
    secret: auth.kind === 'header' ? auth.value : null,
    bearer: auth.kind === 'oauth' ? auth.accessToken : null,
    expiresAt: auth.kind === 'oauth' ? (auth.expiresAt ?? null) : null,
    signIn: signInState(config),
    verified: config.verified,
    client: config.client,
  };
}

export const UNVERIFIED = {
  at: '',
  server: '',
  version: '',
  protocol: '',
  icon: '',
  tools: 0,
  catalog: [],
};

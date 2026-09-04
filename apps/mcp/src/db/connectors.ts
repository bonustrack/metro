import type { ConnectorAuth, VerifiedRecord } from '../daemon/connector-verify.js';
import { readConfig, signInState, type ConnectorSignIn } from './connector-config.js';
import type { ConnectorTransport } from './stations.js';

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
}

export interface ConnectorInput {
  name: unknown;
  url: unknown;
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
  };
}

export interface ConnectorSummary {
  id: string;
  name: string;
  url: string;
  transport: string;
  signIn: ConnectorSignIn;
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

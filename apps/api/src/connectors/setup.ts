import { log } from '@metro-labs/core/log';
import { access } from '../aws/access.js';
import type { AwsCredentials } from '../aws/ec2.js';
import { ROLE_ARN_RE } from '../aws/sts.js';
import { kmsWrapper, localWrapper, type KeyWrapper } from './key-wrappers.js';
import { kmsRegion, type KmsFetch } from './kms.js';

const LOCAL_KEY_RE = /^[0-9a-fA-F]{64}$/;

export interface ConnectorsSetup {
  enabled: boolean;
  wrapper: KeyWrapper | null;
  note: string;
}

export interface SetupDeps {
  role: (roleArn: string) => AwsCredentials;
  fetch: KmsFetch;
}

const LIVE: SetupDeps = { role: (roleArn) => access.metroRole(roleArn), fetch: (url, init) => fetch(url, init) };

const read = (env: NodeJS.ProcessEnv, name: string): string => (env[name] ?? '').trim();

function kmsSetup(env: NodeJS.ProcessEnv, deps: SetupDeps): ConnectorsSetup {
  const arn = read(env, 'METRO_CONNECTORS_KMS_KEY');
  const region = kmsRegion(arn);
  const role = read(env, 'METRO_AWS_ROLE_ARN');
  if (region === null) return { enabled: true, wrapper: null, note: 'METRO_CONNECTORS_KMS_KEY is not a KMS key ARN, so no connector secret can be kept' };
  if (!ROLE_ARN_RE.test(role)) return { enabled: true, wrapper: null, note: 'METRO_AWS_ROLE_ARN is unset, so Metro cannot reach its KMS key' };
  return { enabled: true, wrapper: kmsWrapper({ arn, region, credentials: deps.role(role), fetch: deps.fetch }), note: `connector secrets are wrapped by KMS key ${arn}` };
}

function localSetup(env: NodeJS.ProcessEnv): ConnectorsSetup {
  const key = read(env, 'METRO_CONNECTORS_LOCAL_KEY');
  if (key === '') return { enabled: true, wrapper: null, note: 'no METRO_CONNECTORS_KMS_KEY, so no connector secret can be kept' };
  if (read(env, 'FLY_APP_NAME') !== '') return { enabled: true, wrapper: null, note: 'METRO_CONNECTORS_LOCAL_KEY is for development and tests and is ignored on Fly; set METRO_CONNECTORS_KMS_KEY' };
  if (!LOCAL_KEY_RE.test(key)) return { enabled: true, wrapper: null, note: 'METRO_CONNECTORS_LOCAL_KEY must be 64 hex characters' };
  return { enabled: true, wrapper: localWrapper(Buffer.from(key, 'hex')), note: 'connector secrets are wrapped by the local development key, never use it in production' };
}

export function readConnectorsSetup(env: NodeJS.ProcessEnv = process.env, deps: SetupDeps = LIVE): ConnectorsSetup {
  if (read(env, 'METRO_CONNECTORS_ENABLED') !== 'true') return { enabled: false, wrapper: null, note: 'organization connectors are off (METRO_CONNECTORS_ENABLED is not true)' };
  return read(env, 'METRO_CONNECTORS_KMS_KEY') === '' ? localSetup(env) : kmsSetup(env, deps);
}

export function announceConnectorsSetup(setup: ConnectorsSetup): void {
  const fields = { enabled: setup.enabled, keys: setup.wrapper?.id ?? null };
  if (setup.enabled && setup.wrapper === null) log.warn(fields, `connectors: ${setup.note}`);
  else log.info(fields, `connectors: ${setup.note}`);
}

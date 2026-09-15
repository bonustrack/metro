import { log } from '@metro-labs/core/log';
import { normalizeAddress } from '@metro-labs/core/address';
import { AUTH_KEY_RE } from './aws/user-data.js';
import type { AwsCredentials } from './aws/ec2.js';

export interface LaunchConfig {
  credentials: AwsCredentials;
  region: string;
  tailnet: string;
  authKey: string;
  owners: readonly string[];
  perOwner: number;
}

const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const TAILNET_RE = /^(?:[a-z0-9-]+\.)*ts\.net$/;
const DEFAULT_PER_OWNER = 10;
const MAX_PER_OWNER = 100;

const read = (env: NodeJS.ProcessEnv, name: string): string => (env[name] ?? '').trim();

export function launchOwners(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const address = normalizeAddress(piece.trim());
    if (address !== null && !out.includes(address)) out.push(address);
  }
  return out;
}

function perOwner(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_PER_OWNER;
  return Math.min(value, MAX_PER_OWNER);
}

export type ConfigResult =
  | { ok: true; config: LaunchConfig }
  | { ok: false; missing: string[] };

export function readLaunchConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const credentials = {
    accessKeyId: read(env, 'METRO_AWS_ACCESS_KEY_ID'),
    secretAccessKey: read(env, 'METRO_AWS_SECRET_ACCESS_KEY'),
  };
  const region = read(env, 'METRO_AWS_REGION');
  const tailnet = read(env, 'METRO_LAUNCH_TAILNET').toLowerCase();
  const authKey = read(env, 'METRO_TAILSCALE_AUTH_KEY');
  const owners = launchOwners(read(env, 'METRO_LAUNCH_OWNERS'));
  const missing = [
    ...(credentials.accessKeyId === '' ? ['METRO_AWS_ACCESS_KEY_ID'] : []),
    ...(credentials.secretAccessKey === '' ? ['METRO_AWS_SECRET_ACCESS_KEY'] : []),
    ...(REGION_RE.test(region) ? [] : ['METRO_AWS_REGION']),
    ...(TAILNET_RE.test(tailnet) ? [] : ['METRO_LAUNCH_TAILNET']),
    ...(AUTH_KEY_RE.test(authKey) ? [] : ['METRO_TAILSCALE_AUTH_KEY']),
    ...(owners.length === 0 ? ['METRO_LAUNCH_OWNERS'] : []),
  ];
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: { credentials, region, tailnet, authKey, owners, perOwner: perOwner(read(env, 'METRO_LAUNCH_MAX')) },
  };
}

export const mayLaunch = (config: LaunchConfig, subject: string): boolean =>
  config.owners.includes(normalizeAddress(subject) ?? '');

export function announceLaunchConfig(result: ConfigResult): void {
  if (result.ok) {
    log.info(
      { region: result.config.region, tailnet: result.config.tailnet, owners: result.config.owners.length, perOwner: result.config.perOwner },
      'launch: metro can issue servers',
    );
    return;
  }
  log.info({ missing: result.missing }, 'launch: metro issues no servers, these are unset or malformed');
}
